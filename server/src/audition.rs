#[path = "emulation/polyphony.rs"]
pub mod polyphony;
#[path = "emulation/voice.rs"]
pub mod voice;

use polyphony::{Note, Polyphony};
use voice::Voice;

pub const CLOCK: u32 = 3_579_545;

#[derive(Default)]
pub struct Audition {
    voices: Polyphony,
    voice: Option<Voice>,
}

impl Audition {
    pub fn set_voice(&mut self, voice: Option<Voice>) -> Result<Vec<(u8, u8)>, String> {
        if voice.as_ref().is_some_and(|voice| !voice.validate()) {
            return Err("Invalid voice".into());
        }
        if self.voice == voice {
            return Ok(Vec::new());
        }
        let mut writes = self.all_off(None, None);
        if let Some(voice) = &voice {
            for channel in 0..8 {
                writes.extend(voice.registers(channel, 0));
            }
        }
        self.voice = voice;
        Ok(writes)
    }

    pub fn note_on(&mut self, note: Note, velocity: u8) -> Vec<(u8, u8)> {
        if velocity == 0 {
            return self.note_off(note);
        }
        if !(13..=108).contains(&note.note) || note.channel > 15 || velocity > 127 {
            return Vec::new();
        }
        let Some(voice) = &self.voice else {
            return Vec::new();
        };
        let channel = self.voices.allocate(note, velocity);
        let attenuation = self.voices.slots[channel].attenuation;
        let channel = channel as u8;
        let mut writes = vec![(0x08, channel)];
        writes.extend(voice.registers(channel, attenuation));
        let mask = if voice.operator_mask == 0 {
            [8, 8, 8, 8, 10, 14, 14, 15][voice.algorithm as usize]
        } else {
            voice.operator_mask
        };
        let pitch = note.note - 13;
        let keys = [0_u8, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14];
        writes.extend([
            (
                0x28 + channel,
                (pitch / 12) << 4 | keys[(pitch % 12) as usize],
            ),
            (0x30 + channel, 0),
            (0x08, (mask << 3) | channel),
        ]);
        writes
    }

    pub fn note_off(&mut self, note: Note) -> Vec<(u8, u8)> {
        self.voices
            .release(note)
            .map_or_else(Vec::new, |channel| vec![(0x08, channel as u8)])
    }

    pub fn all_off(&mut self, source: Option<u8>, midi_channel: Option<u8>) -> Vec<(u8, u8)> {
        let mut writes = Vec::new();
        for (channel, slot) in self.voices.slots.iter_mut().enumerate() {
            if slot.note.is_some_and(|note| {
                source.is_none_or(|source| source == note.source)
                    && midi_channel.is_none_or(|channel| channel == note.channel)
            }) {
                writes.push((0x08, channel as u8));
                slot.note = None;
            }
        }
        writes
    }
}
