use crate::{
    AudioEvent, BytePosition, Command, Error, MAX_AUDIO_DATA_BYTES, MAX_YM2151_EVENT_WRITES,
    MAX_YM2151_WRITES, RegisterWrite,
};

/// Allocation-free frame sequencing into a caller-owned, infallible byte sink.
/// This encodes requests only; it does not send them or track device acceptance.
pub struct CommandEncoder<F> {
    emit: F,
    request_id: u16,
    count: usize,
}

impl<F: FnMut(&[u8])> CommandEncoder<F> {
    pub const fn new(request_id: u16, emit: F) -> Self {
        Self {
            emit,
            request_id,
            count: 0,
        }
    }

    pub const fn count(&self) -> usize {
        self.count
    }

    pub const fn next_request_id(&self) -> u16 {
        self.request_id
    }

    /// Invalid commands leave the sink, count and request ID unchanged.
    pub fn push(&mut self, command: Command<'_>) -> Result<(), Error> {
        let count = self.count.checked_add(1).ok_or(Error::InvalidArgument)?;
        let frame = command.encode(self.request_id)?;
        (self.emit)(frame.as_bytes());
        self.request_id = self.request_id.wrapping_add(1);
        self.count = count;
        Ok(())
    }

    /// Splits immediate writes at the protocol limit. Empty input emits nothing.
    pub fn ym2151_burst(&mut self, writes: &[RegisterWrite]) -> Result<(), Error> {
        for chunk in writes.chunks(MAX_YM2151_WRITES) {
            self.push(Command::WriteYm2151Burst(chunk))?;
        }
        Ok(())
    }

    /// Splits positioned writes without changing their order or byte position.
    pub fn ym2151_event(
        &mut self,
        position: BytePosition,
        writes: &[RegisterWrite],
    ) -> Result<(), Error> {
        for chunk in writes.chunks(MAX_YM2151_EVENT_WRITES) {
            self.push(Command::AudioEvent {
                position,
                event: AudioEvent::Ym2151(chunk),
            })?;
        }
        Ok(())
    }

    /// Splits DATA into contiguous positions. Overflow is rejected before emission.
    /// Empty input emits nothing. The returned position is not a device acknowledgement.
    pub fn audio_data(
        &mut self,
        position: BytePosition,
        adpcm: &[u8],
    ) -> Result<BytePosition, Error> {
        let end = position.checked_advance(adpcm.len())?;
        let mut position = position;
        for chunk in adpcm.chunks(MAX_AUDIO_DATA_BYTES) {
            self.push(Command::AudioData {
                position,
                adpcm: chunk,
            })?;
            position = position.checked_advance(chunk.len())?;
        }
        Ok(end)
    }
}
