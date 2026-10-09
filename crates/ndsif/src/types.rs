use crate::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegisterWrite {
    pub address: u8,
    pub value: u8,
}

impl RegisterWrite {
    pub const fn new(address: u8, value: u8) -> Self {
        Self { address, value }
    }
}

/// Validated address/value pairs borrowed directly from a request payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegisterWrites<'a>(&'a [u8]);

impl<'a> RegisterWrites<'a> {
    pub(crate) fn decode(bytes: &'a [u8], maximum: usize) -> Result<Self, Error> {
        let pairs = bytes.chunks_exact(2);
        if bytes.is_empty() || !pairs.remainder().is_empty() || pairs.len() > maximum {
            return Err(Error::InvalidArgument);
        }
        Ok(Self(bytes))
    }
    pub const fn as_bytes(self) -> &'a [u8] {
        self.0
    }
    pub const fn len(self) -> usize {
        self.0.len() / 2
    }
    pub const fn is_empty(self) -> bool {
        self.0.is_empty()
    }
    pub fn iter(self) -> impl ExactSizeIterator<Item = RegisterWrite> + 'a {
        self.0
            .chunks_exact(2)
            .map(|pair| RegisterWrite::new(pair[0], pair[1]))
    }
}

/// ADPCM byte position, not a sample, nibble or tick count. Natural wrapping is forbidden.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct BytePosition(u32);

impl BytePosition {
    pub const fn new(value: u32) -> Self {
        Self(value)
    }
    pub const fn get(self) -> u32 {
        self.0
    }
    pub fn checked_advance(self, bytes: usize) -> Result<Self, Error> {
        let bytes = u32::try_from(bytes).map_err(|_| Error::InvalidArgument)?;
        self.0
            .checked_add(bytes)
            .map(Self)
            .ok_or(Error::InvalidArgument)
    }
}

/// Chips supported by the current v1 firmware. Raw frames can carry other IDs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Chip {
    Ym2151 = 5,
    OkiM6258 = 14,
}

impl TryFrom<u8> for Chip {
    type Error = Error;
    fn try_from(value: u8) -> Result<Self, Error> {
        match value {
            5 => Ok(Self::Ym2151),
            14 => Ok(Self::OkiM6258),
            _ => Err(Error::InvalidArgument),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum OkiClock {
    Mhz4 = 4_000_000,
    Mhz8 = 8_000_000,
}

impl TryFrom<u32> for OkiClock {
    type Error = Error;
    fn try_from(value: u32) -> Result<Self, Error> {
        match value {
            4_000_000 => Ok(Self::Mhz4),
            8_000_000 => Ok(Self::Mhz8),
            _ => Err(Error::InvalidArgument),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum Divider {
    Div512 = 512,
    Div768 = 768,
    Div1024 = 1024,
}

impl TryFrom<u16> for Divider {
    type Error = Error;
    fn try_from(value: u16) -> Result<Self, Error> {
        match value {
            512 => Ok(Self::Div512),
            768 => Ok(Self::Div768),
            1024 => Ok(Self::Div1024),
            _ => Err(Error::InvalidArgument),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Pan {
    Both = 0,
    Left = 1,
    Right = 2,
    Off = 3,
}

impl TryFrom<u8> for Pan {
    type Error = Error;
    fn try_from(value: u8) -> Result<Self, Error> {
        match value {
            0 => Ok(Self::Both),
            1 => Ok(Self::Left),
            2 => Ok(Self::Right),
            3 => Ok(Self::Off),
            _ => Err(Error::InvalidArgument),
        }
    }
}

/// State-dependent END repetition. Neither value is a universal silence code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ZeroPair {
    Byte80 = 0x80,
    Byte08 = 0x08,
}

impl TryFrom<u8> for ZeroPair {
    type Error = Error;
    fn try_from(value: u8) -> Result<Self, Error> {
        match value {
            0x80 => Ok(Self::Byte80),
            0x08 => Ok(Self::Byte08),
            _ => Err(Error::InvalidArgument),
        }
    }
}

/// Preserves unknown bits for future firmware extensions. Only FAULT signifies a fault.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct StatusFlags(u32);

impl StatusFlags {
    pub const RUNNING: Self = Self(0x001);
    pub const ENDED: Self = Self(0x002);
    pub const FAULT: Self = Self(0x004);
    pub const USB_BUS_RESET: Self = Self(0x008);
    pub const RECEIVE_OVERFLOW: Self = Self(0x010);
    pub const RECEIVE_DISCARDED: Self = Self(0x020);
    pub const PCM_UNDERFLOW: Self = Self(0x040);
    pub const PCM_OVERFLOW: Self = Self(0x080);
    pub const EVENT_OVERFLOW: Self = Self(0x100);
    pub const ARGUMENT_REJECTED: Self = Self(0x200);

    pub const fn from_bits_retain(bits: u32) -> Self {
        Self(bits)
    }
    pub const fn bits(self) -> u32 {
        self.0
    }
    pub const fn contains(self, flag: Self) -> bool {
        self.0 & flag.0 == flag.0
    }
    pub const fn running(self) -> bool {
        self.contains(Self::RUNNING)
    }
    pub const fn ended(self) -> bool {
        self.contains(Self::ENDED)
    }
    pub const fn fault(self) -> bool {
        self.contains(Self::FAULT)
    }
}
