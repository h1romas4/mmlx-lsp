#![doc = include_str!("../README.md")]
#![no_std]

pub mod command;
pub mod decoder;
pub mod error;
pub mod frame;
pub mod response;
pub mod types;

pub use command::{AudioEvent, Command, Request, RequestEvent};
pub use decoder::{Decoder, PARTIAL_FRAME_TIMEOUT_MS};
pub use error::Error;
pub use frame::{EncodedFrame, Frame, MAX_ENCODED_SIZE, MAX_PAYLOAD_SIZE, PROTOCOL_VERSION};
pub use response::{AudioStatus, DeviceInfo, Reply, Response, Status};
pub use types::{
    BytePosition, Chip, Divider, OkiClock, Pan, RegisterWrite, RegisterWrites, StatusFlags,
    ZeroPair,
};
