use crate::{EncodedFrame, Error, Frame, MAX_PAYLOAD_SIZE, StatusFlags};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Complete,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeviceInfo<'a> {
    pub model: &'a str,
    pub firmware: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioStatus {
    pub accepted: u32,
    pub played: u32,
    pub pending: u32,
    pub underflows: u32,
    pub overflows: u32,
    pub rejected: u32,
    pub max_pending: u32,
    pub flags: StatusFlags,
    pub late_events: u32,
    pub max_event_lag: u32,
}

impl AudioStatus {
    fn decode(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() != 40 {
            return Err(Error::InvalidLength);
        }
        let mut values = [0; 10];
        for (value, bytes) in values.iter_mut().zip(bytes.chunks_exact(4)) {
            *value = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        }
        let [
            accepted,
            played,
            pending,
            underflows,
            overflows,
            rejected,
            max_pending,
            flags,
            late_events,
            max_event_lag,
        ] = values;
        Ok(Self {
            accepted,
            played,
            pending,
            underflows,
            overflows,
            rejected,
            max_pending,
            flags: StatusFlags::from_bits_retain(flags),
            late_events,
            max_event_lag,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Reply<'a> {
    Complete,
    Rejected,
    Ping(&'a [u8]),
    Info(DeviceInfo<'a>),
    AudioStatus(AudioStatus),
    Unknown(&'a [u8]),
}

/// Typed response. Parsed data borrows the frame payload; outgoing data borrows caller data.
/// A completion is not hardware readback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Response<'a> {
    pub opcode: u8,
    pub request_id: u16,
    pub status: Status,
    pub reply: Reply<'a>,
}

impl<'a> Response<'a> {
    /// Builds a reply using the request's opcode and ID, checking the reply shape and PING echo.
    /// Response frames and requests without a defined reply are rejected.
    /// The caller still decides command acceptance and performs the device operation.
    pub fn for_request(request: &Frame, reply: Reply<'a>) -> Result<Self, Error> {
        let response = Self {
            opcode: request.opcode() | 0x80,
            request_id: request.request_id(),
            status: if matches!(reply, Reply::Rejected) {
                Status::Rejected
            } else {
                Status::Complete
            },
            reply,
        };
        response.matches_request(request)?;
        response.to_frame()?;
        Ok(response)
    }

    /// Encodes a locally valid response, rejecting inconsistent status/opcode/reply combinations.
    pub fn to_frame(&self) -> Result<Frame, Error> {
        if (self.status == Status::Rejected) != matches!(self.reply, Reply::Rejected) {
            return Err(Error::InvalidArgument);
        }
        let mut payload = [0; MAX_PAYLOAD_SIZE];
        payload[0] = match self.status {
            Status::Complete => 0,
            Status::Rejected => 1,
        };
        let length = match self.reply {
            Reply::Complete | Reply::Rejected => 1,
            Reply::Ping(bytes) | Reply::Unknown(bytes) => {
                if bytes.len() > MAX_PAYLOAD_SIZE - 1 {
                    return Err(Error::PayloadTooLong {
                        length: bytes.len().saturating_add(1),
                    });
                }
                payload[1..1 + bytes.len()].copy_from_slice(bytes);
                1 + bytes.len()
            }
            Reply::Info(info) => {
                if info.model.len() > u8::MAX as usize || info.firmware.len() > 63 {
                    return Err(Error::InvalidArgument);
                }
                let length = 3 + info.model.len() + info.firmware.len();
                if length > MAX_PAYLOAD_SIZE {
                    return Err(Error::PayloadTooLong { length });
                }
                payload[1] = info.model.len() as u8;
                let model_end = 2 + info.model.len();
                payload[2..model_end].copy_from_slice(info.model.as_bytes());
                payload[model_end] = info.firmware.len() as u8;
                payload[model_end + 1..length].copy_from_slice(info.firmware.as_bytes());
                length
            }
            Reply::AudioStatus(status) => {
                let values = [
                    status.accepted,
                    status.played,
                    status.pending,
                    status.underflows,
                    status.overflows,
                    status.rejected,
                    status.max_pending,
                    status.flags.bits(),
                    status.late_events,
                    status.max_event_lag,
                ];
                for (bytes, value) in payload[1..41].chunks_exact_mut(4).zip(values) {
                    bytes.copy_from_slice(&value.to_le_bytes());
                }
                41
            }
        };
        let frame = Frame::new(self.opcode, self.request_id, &payload[..length])?;
        if Response::decode(&frame)? != *self {
            return Err(Error::InvalidArgument);
        }
        Ok(frame)
    }

    /// Encode with both leading and trailing zero delimiters.
    pub fn encode(&self) -> Result<EncodedFrame, Error> {
        Ok(self.to_frame()?.encode())
    }

    pub fn encode_into(&self, output: &mut [u8]) -> Result<usize, Error> {
        self.to_frame()?.encode_into(output)
    }

    pub fn decode(frame: &'a Frame) -> Result<Self, Error> {
        if !frame.is_response() {
            return Err(Error::UnexpectedOpcode(frame.opcode()));
        }
        let (&status, body) = frame.payload().split_first().ok_or(Error::InvalidLength)?;
        let status = match status {
            0 => Status::Complete,
            1 => Status::Rejected,
            value => return Err(Error::InvalidStatus(value)),
        };
        let reply = if status == Status::Rejected {
            if !body.is_empty() {
                return Err(Error::InvalidLength);
            }
            Reply::Rejected
        } else {
            match frame.opcode() {
                0x80 | 0xd4 => {
                    if !body.is_empty() {
                        return Err(Error::InvalidLength);
                    }
                    Reply::Complete
                }
                0x81 => {
                    if body.len() > 32 {
                        return Err(Error::InvalidLength);
                    }
                    Reply::Ping(body)
                }
                0x82 => Reply::Info(decode_info(body)?),
                0xdb => Reply::AudioStatus(AudioStatus::decode(body)?),
                _ => Reply::Unknown(body),
            }
        };
        Ok(Self {
            opcode: frame.opcode(),
            request_id: frame.request_id(),
            status,
            reply,
        })
    }

    /// Checks opcode/ID and successful PING echo, without tracking timeouts or pending requests.
    pub fn matches_request(&self, request: &Frame) -> Result<(), Error> {
        if request.is_response()
            || (0x56..=0x5a).contains(&request.opcode())
            || self.opcode != (request.opcode() | 0x80)
            || self.request_id != request.request_id()
        {
            return Err(Error::ResponseMismatch);
        }
        if matches!(self.reply, Reply::Ping(echo) if echo != request.payload()) {
            return Err(Error::ResponseMismatch);
        }
        Ok(())
    }
}

fn decode_info(body: &[u8]) -> Result<DeviceInfo<'_>, Error> {
    let (&model_length, rest) = body.split_first().ok_or(Error::InvalidLength)?;
    let (model, rest) = rest
        .split_at_checked(model_length as usize)
        .ok_or(Error::InvalidLength)?;
    let (&firmware_length, firmware) = rest.split_first().ok_or(Error::InvalidLength)?;
    if firmware_length > 63 || firmware.len() != firmware_length as usize {
        return Err(Error::InvalidLength);
    }
    Ok(DeviceInfo {
        model: core::str::from_utf8(model).map_err(|_| Error::InvalidUtf8)?,
        firmware: core::str::from_utf8(firmware).map_err(|_| Error::InvalidUtf8)?,
    })
}
