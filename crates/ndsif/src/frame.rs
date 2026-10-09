use crate::Error;

pub const PROTOCOL_VERSION: u8 = 1;
pub const MAX_PAYLOAD_SIZE: usize = 256;
pub const MAX_RAW_SIZE: usize = 266;
pub const MAX_COBS_SIZE: usize = 268;
pub const MAX_ENCODED_SIZE: usize = 270;

const CRC: crc::Crc<u16> = crc::Crc::<u16>::new(&crc::CRC_16_IBM_3740);

/// CRC-16/CCITT-FALSE over the header and payload, excluding the CRC itself.
pub fn checksum(bytes: &[u8]) -> u16 {
    CRC.checksum(bytes)
}

/// An owned, validated v1 frame. Unknown opcodes are intentionally retained.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    opcode: u8,
    request_id: u16,
    payload: [u8; MAX_PAYLOAD_SIZE],
    length: usize,
}

impl Frame {
    pub fn new(opcode: u8, request_id: u16, payload: &[u8]) -> Result<Self, Error> {
        if payload.len() > MAX_PAYLOAD_SIZE {
            return Err(Error::PayloadTooLong {
                length: payload.len(),
            });
        }
        let mut frame = Self {
            opcode,
            request_id,
            payload: [0; MAX_PAYLOAD_SIZE],
            length: payload.len(),
        };
        frame.payload[..payload.len()].copy_from_slice(payload);
        Ok(frame)
    }

    pub const fn opcode(&self) -> u8 {
        self.opcode
    }
    pub const fn request_id(&self) -> u16 {
        self.request_id
    }
    pub const fn is_response(&self) -> bool {
        self.opcode & 0x80 != 0
    }
    pub fn payload(&self) -> &[u8] {
        &self.payload[..self.length]
    }

    /// Decode the COBS body only, without either zero delimiter.
    pub fn decode(encoded: &[u8]) -> Result<Self, Error> {
        if encoded.len() > MAX_COBS_SIZE {
            return Err(Error::FrameTooLong);
        }
        if encoded.is_empty() || encoded.contains(&0) {
            return Err(Error::InvalidCobs);
        }
        let mut raw = [0; MAX_COBS_SIZE];
        raw[..encoded.len()].copy_from_slice(encoded);
        let length =
            cobs::decode_in_place(&mut raw[..encoded.len()]).map_err(|_| Error::InvalidCobs)?;
        if !(10..=MAX_RAW_SIZE).contains(&length) {
            return Err(Error::InvalidLength);
        }
        if &raw[..2] != b"ND" {
            return Err(Error::InvalidMagic);
        }
        if raw[2] != PROTOCOL_VERSION {
            return Err(Error::UnsupportedVersion(raw[2]));
        }
        let payload_length = u16::from_le_bytes([raw[6], raw[7]]) as usize;
        if payload_length > MAX_PAYLOAD_SIZE || length != payload_length + 10 {
            return Err(Error::InvalidLength);
        }
        let expected = checksum(&raw[..length - 2]);
        let received = u16::from_le_bytes([raw[length - 2], raw[length - 1]]);
        if expected != received {
            return Err(Error::CrcMismatch { expected, received });
        }
        Self::new(
            raw[3],
            u16::from_le_bytes([raw[4], raw[5]]),
            &raw[8..length - 2],
        )
    }

    /// Encode with both leading and trailing zero delimiters.
    pub fn encode(&self) -> EncodedFrame {
        let mut raw = [0; MAX_RAW_SIZE];
        raw[..2].copy_from_slice(b"ND");
        raw[2] = PROTOCOL_VERSION;
        raw[3] = self.opcode;
        raw[4..6].copy_from_slice(&self.request_id.to_le_bytes());
        raw[6..8].copy_from_slice(&(self.length as u16).to_le_bytes());
        raw[8..8 + self.length].copy_from_slice(self.payload());
        let crc = checksum(&raw[..8 + self.length]);
        raw[8 + self.length..10 + self.length].copy_from_slice(&crc.to_le_bytes());
        let mut result = EncodedFrame {
            bytes: [0; MAX_ENCODED_SIZE],
            length: 0,
        };
        result.length = cobs::encode(
            &raw[..10 + self.length],
            &mut result.bytes[1..MAX_ENCODED_SIZE - 1],
        ) + 2;
        result
    }

    pub fn encode_into(&self, output: &mut [u8]) -> Result<usize, Error> {
        let encoded = self.encode();
        if output.len() < encoded.as_bytes().len() {
            return Err(Error::BufferTooSmall {
                required: encoded.length,
            });
        }
        output[..encoded.length].copy_from_slice(encoded.as_bytes());
        Ok(encoded.length)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedFrame {
    bytes: [u8; MAX_ENCODED_SIZE],
    length: usize,
}

impl EncodedFrame {
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes[..self.length]
    }
}

impl AsRef<[u8]> for EncodedFrame {
    fn as_ref(&self) -> &[u8] {
        self.as_bytes()
    }
}
