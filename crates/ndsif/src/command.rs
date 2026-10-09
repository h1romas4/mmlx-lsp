use crate::{
    BytePosition, Chip, Divider, EncodedFrame, Error, Frame, MAX_PAYLOAD_SIZE, OkiClock, Pan,
    RegisterWrite, ZeroPair,
};

pub const MAX_YM2151_WRITES: usize = MAX_PAYLOAD_SIZE / 2;
pub const MAX_YM2151_EVENT_WRITES: usize = (MAX_PAYLOAD_SIZE - 5) / 2;
pub const MAX_AUDIO_DATA_BYTES: usize = MAX_PAYLOAD_SIZE - 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioEvent<'a> {
    Ym2151(&'a [RegisterWrite]),
    OkiSettings { clock: OkiClock, divider: Divider },
    Pan(Pan),
    End(ZeroPair),
}

/// Request encoding with local argument validation, not device/session state validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Command<'a> {
    Reset,
    Ping(&'a [u8]),
    GetInfo,
    WriteYm2151(&'a [RegisterWrite]),
    WriteYm2151Burst(&'a [RegisterWrite]),
    SetChipClock {
        chip: Chip,
        hz: u32,
    },
    AudioData {
        position: BytePosition,
        adpcm: &'a [u8],
    },
    AudioEvent {
        position: BytePosition,
        event: AudioEvent<'a>,
    },
    AudioStart {
        clock: OkiClock,
        divider: Divider,
    },
    AudioStatus,
}

impl Command<'_> {
    pub const fn opcode(&self) -> u8 {
        match self {
            Self::Reset => 0x00,
            Self::Ping(_) => 0x01,
            Self::GetInfo => 0x02,
            Self::WriteYm2151(_) => 0x54,
            Self::WriteYm2151Burst(_) => 0x56,
            Self::SetChipClock { .. } => 0x57,
            Self::AudioData { .. } => 0x58,
            Self::AudioEvent { .. } => 0x59,
            Self::AudioStart { .. } => 0x5a,
            Self::AudioStatus => 0x5b,
        }
    }

    /// Whether the protocol defines a reply; does not schedule or wait for it.
    pub const fn expects_response(&self) -> bool {
        matches!(
            self,
            Self::Reset | Self::Ping(_) | Self::GetInfo | Self::WriteYm2151(_) | Self::AudioStatus
        )
    }

    pub fn to_frame(&self, request_id: u16) -> Result<Frame, Error> {
        let mut payload = [0; MAX_PAYLOAD_SIZE];
        let length = match *self {
            Self::Reset | Self::GetInfo | Self::AudioStatus => 0,
            Self::Ping(bytes) => {
                if bytes.len() > 32 {
                    return Err(Error::InvalidArgument);
                }
                payload[..bytes.len()].copy_from_slice(bytes);
                bytes.len()
            }
            Self::WriteYm2151(writes) | Self::WriteYm2151Burst(writes) => {
                encode_writes(writes, &mut payload, MAX_YM2151_WRITES)?
            }
            Self::SetChipClock { chip, hz } => {
                if hz == 0 {
                    return Err(Error::InvalidArgument);
                }
                if chip == Chip::OkiM6258 {
                    OkiClock::try_from(hz)?;
                }
                payload[0] = chip as u8;
                payload[1..5].copy_from_slice(&hz.to_le_bytes());
                5
            }
            Self::AudioData { position, adpcm } => {
                if !(1..=MAX_AUDIO_DATA_BYTES).contains(&adpcm.len()) {
                    return Err(Error::InvalidArgument);
                }
                position.checked_advance(adpcm.len())?;
                payload[..4].copy_from_slice(&position.get().to_le_bytes());
                payload[4..4 + adpcm.len()].copy_from_slice(adpcm);
                4 + adpcm.len()
            }
            Self::AudioEvent { position, event } => {
                payload[..4].copy_from_slice(&position.get().to_le_bytes());
                match event {
                    AudioEvent::Ym2151(writes) => {
                        payload[4] = 0;
                        5 + encode_writes(writes, &mut payload[5..], MAX_YM2151_EVENT_WRITES)?
                    }
                    AudioEvent::OkiSettings { clock, divider } => {
                        payload[4] = 1;
                        payload[5..9].copy_from_slice(&(clock as u32).to_le_bytes());
                        payload[9..11].copy_from_slice(&(divider as u16).to_le_bytes());
                        11
                    }
                    AudioEvent::Pan(pan) => {
                        payload[4] = 2;
                        payload[5] = pan as u8;
                        6
                    }
                    AudioEvent::End(pair) => {
                        payload[4] = 3;
                        payload[5] = pair as u8;
                        6
                    }
                }
            }
            Self::AudioStart { clock, divider } => {
                payload[..4].copy_from_slice(&(clock as u32).to_le_bytes());
                payload[4..6].copy_from_slice(&(divider as u16).to_le_bytes());
                6
            }
        };
        Frame::new(self.opcode(), request_id, &payload[..length])
    }

    pub fn encode(&self, request_id: u16) -> Result<EncodedFrame, Error> {
        Ok(self.to_frame(request_id)?.encode())
    }

    pub fn encode_into(&self, request_id: u16, output: &mut [u8]) -> Result<usize, Error> {
        self.to_frame(request_id)?.encode_into(output)
    }
}

fn encode_writes(
    writes: &[RegisterWrite],
    output: &mut [u8],
    maximum: usize,
) -> Result<usize, Error> {
    if writes.is_empty() || writes.len() > maximum {
        return Err(Error::InvalidArgument);
    }
    for (pair, write) in output.chunks_exact_mut(2).zip(writes) {
        pair[0] = write.address;
        pair[1] = write.value;
    }
    Ok(writes.len() * 2)
}

/// Received AUDIO_EVENT, with register pairs borrowed rather than copied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestEvent<'a> {
    Ym2151(crate::types::RegisterWrites<'a>),
    OkiSettings { clock: OkiClock, divider: Divider },
    Pan(Pan),
    End(ZeroPair),
}

/// Typed view of a request. Unknown opcodes retain their entire payload.
/// Known commands validate local arguments only, not the device's playback state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Request<'a> {
    Reset,
    Ping(&'a [u8]),
    GetInfo,
    WriteYm2151(crate::types::RegisterWrites<'a>),
    WriteYm2151Burst(crate::types::RegisterWrites<'a>),
    SetChipClock {
        chip: Chip,
        hz: u32,
    },
    AudioData {
        position: BytePosition,
        adpcm: &'a [u8],
    },
    AudioEvent {
        position: BytePosition,
        event: RequestEvent<'a>,
    },
    AudioStart {
        clock: OkiClock,
        divider: Divider,
    },
    AudioStatus,
    Unknown {
        opcode: u8,
        payload: &'a [u8],
    },
}

impl<'a> Request<'a> {
    pub fn decode(frame: &'a Frame) -> Result<Self, Error> {
        if frame.is_response() {
            return Err(Error::UnexpectedOpcode(frame.opcode()));
        }
        let bytes = frame.payload();
        match frame.opcode() {
            0x00 | 0x02 | 0x5b => {
                require_length(bytes, 0)?;
                Ok(match frame.opcode() {
                    0 => Self::Reset,
                    2 => Self::GetInfo,
                    _ => Self::AudioStatus,
                })
            }
            0x01 => {
                if bytes.len() > 32 {
                    return Err(Error::InvalidArgument);
                }
                Ok(Self::Ping(bytes))
            }
            0x54 | 0x56 => {
                let writes = crate::types::RegisterWrites::decode(bytes, MAX_YM2151_WRITES)?;
                Ok(if frame.opcode() == 0x54 {
                    Self::WriteYm2151(writes)
                } else {
                    Self::WriteYm2151Burst(writes)
                })
            }
            0x57 => {
                require_length(bytes, 5)?;
                let chip = Chip::try_from(bytes[0])?;
                let hz = read_u32(&bytes[1..]);
                if hz == 0 {
                    return Err(Error::InvalidArgument);
                }
                if chip == Chip::OkiM6258 {
                    OkiClock::try_from(hz)?;
                }
                Ok(Self::SetChipClock { chip, hz })
            }
            0x58 => {
                if !(5..=MAX_PAYLOAD_SIZE).contains(&bytes.len()) {
                    return Err(Error::InvalidArgument);
                }
                let position = BytePosition::new(read_u32(bytes));
                let adpcm = &bytes[4..];
                position.checked_advance(adpcm.len())?;
                Ok(Self::AudioData { position, adpcm })
            }
            0x59 => {
                if bytes.len() < 6 {
                    return Err(Error::InvalidArgument);
                }
                let position = BytePosition::new(read_u32(bytes));
                let data = &bytes[5..];
                let event = match bytes[4] {
                    0 => RequestEvent::Ym2151(crate::types::RegisterWrites::decode(
                        data,
                        MAX_YM2151_EVENT_WRITES,
                    )?),
                    1 => {
                        let (clock, divider) = decode_oki(data)?;
                        RequestEvent::OkiSettings { clock, divider }
                    }
                    2 => {
                        require_length(data, 1)?;
                        RequestEvent::Pan(Pan::try_from(data[0])?)
                    }
                    3 => {
                        require_length(data, 1)?;
                        RequestEvent::End(ZeroPair::try_from(data[0])?)
                    }
                    _ => return Err(Error::InvalidArgument),
                };
                Ok(Self::AudioEvent { position, event })
            }
            0x5a => {
                let (clock, divider) = decode_oki(bytes)?;
                Ok(Self::AudioStart { clock, divider })
            }
            opcode => Ok(Self::Unknown {
                opcode,
                payload: bytes,
            }),
        }
    }
}

fn require_length(bytes: &[u8], length: usize) -> Result<(), Error> {
    if bytes.len() != length {
        return Err(Error::InvalidArgument);
    }
    Ok(())
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

fn decode_oki(bytes: &[u8]) -> Result<(OkiClock, Divider), Error> {
    require_length(bytes, 6)?;
    Ok((
        OkiClock::try_from(read_u32(bytes))?,
        Divider::try_from(u16::from_le_bytes([bytes[4], bytes[5]]))?,
    ))
}
