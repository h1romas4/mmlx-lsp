#[path = "emulation/polyphony.rs"]
pub mod polyphony;
#[path = "emulation/voice.rs"]
pub mod voice;

use polyphony::{Note, Polyphony};
use std::collections::BTreeMap;
use voice::Voice;

pub const CLOCK: u32 = 3_579_545;

#[derive(Default)]
pub struct Audition {
    voices: Polyphony,
    voice: Option<Voice>,
    bends: BTreeMap<(u8, u8), i32>,
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
        writes.extend(self.pitch(note, channel));
        writes.push((0x08, (mask << 3) | channel));
        writes
    }

    fn pitch(&self, note: Note, channel: u8) -> [(u8, u8); 2] {
        let offset = self
            .bends
            .get(&(note.source, note.channel))
            .copied()
            .unwrap_or(0);
        let pitch = ((i32::from(note.note) - 13) * 64 + offset).clamp(0, 96 * 64 - 1);
        let semitone = pitch / 64;
        let keys = [0_u8, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14];
        [
            (
                0x28 + channel,
                ((semitone / 12) as u8 * 16) | keys[(semitone % 12) as usize],
            ),
            (0x30 + channel, (pitch % 64) as u8 * 4),
        ]
    }

    pub fn pitch_bend(&mut self, source: u8, midi_channel: u8, value: u16) -> Vec<(u8, u8)> {
        if midi_channel > 15 || value > 16383 {
            return Vec::new();
        }
        let delta = i32::from(value) - 8192;
        let denominator = if delta > 0 { 8191 } else { 8192 };
        let offset = (delta * 128 + delta.signum() * (denominator / 2)) / denominator;
        if self
            .bends
            .get(&(source, midi_channel))
            .copied()
            .unwrap_or(0)
            == offset
        {
            return Vec::new();
        }
        self.bends.insert((source, midi_channel), offset);
        let mut writes = Vec::new();
        for (channel, slot) in self.voices.slots.iter().enumerate() {
            if let Some(note) = slot.note
                && note.source == source
                && note.channel == midi_channel
            {
                writes.extend(self.pitch(note, channel as u8));
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bend_updates_only_matching_voices_without_key_on() {
        let mut audition = Audition::default();
        let note = Note {
            source: 1,
            channel: 2,
            note: 69,
        };
        audition.voices.allocate(note, 127);
        audition.voices.allocate(Note { note: 60, ..note }, 127);
        audition.voices.allocate(Note { source: 0, ..note }, 127);
        audition.voices.allocate(Note { channel: 3, ..note }, 127);
        assert_eq!(
            audition.pitch_bend(1, 2, 16383),
            [(0x28, 0x4d), (0x30, 0), (0x29, 0x41), (0x31, 0)]
        );
        assert!(audition.pitch_bend(1, 2, 16383).is_empty());
        assert_eq!(
            audition.pitch_bend(1, 2, 8192),
            [(0x28, 0x4a), (0x30, 0), (0x29, 0x3e), (0x31, 0)]
        );
        assert_eq!(
            audition.pitch_bend(1, 2, 0),
            [(0x28, 0x48), (0x30, 0), (0x29, 0x3c), (0x31, 0)]
        );
    }

    #[test]
    fn bend_is_retained_for_new_notes_and_fractional_pitch_is_bounded() {
        let mut audition = Audition::default();
        let note = Note {
            source: 0,
            channel: 0,
            note: 69,
        };
        assert!(audition.pitch_bend(0, 0, 10240).is_empty());
        assert_eq!(audition.pitch(note, 0), [(0x28, 0x4a), (0x30, 128)]);
        audition.pitch_bend(0, 0, 0);
        assert_eq!(
            audition.pitch(Note { note: 13, ..note }, 0),
            [(0x28, 0), (0x30, 0)]
        );
        audition.pitch_bend(0, 0, 16383);
        assert_eq!(
            audition.pitch(Note { note: 108, ..note }, 0),
            [(0x28, 0x7e), (0x30, 252)]
        );
        assert!(audition.pitch_bend(0, 16, 8192).is_empty());
        assert!(audition.pitch_bend(0, 0, 16384).is_empty());
    }
}
