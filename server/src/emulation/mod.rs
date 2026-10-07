mod audio;
pub mod playback;
pub mod polyphony;
pub mod protocol;
pub mod voice;
mod ym2151;

use audio::Audio;
use polyphony::{Note, Polyphony};
use voice::Voice;
use ym2151::Ym2151;

pub struct Emulation {
    chip: Ym2151,
    audio: Audio,
    voices: Polyphony,
    voice: Option<Voice>,
}

impl Emulation {
    pub fn new(sample_rate: u32) -> Result<Self, String> {
        let chip = Ym2151::default();
        Ok(Self {
            audio: Audio::new(chip.sample_rate(), sample_rate)?,
            chip,
            voices: Polyphony::default(),
            voice: None,
        })
    }

    pub fn set_voice(&mut self, voice: Option<Voice>) -> Result<(), String> {
        if voice.as_ref().is_some_and(|voice| !voice.validate()) {
            return Err("Invalid voice".into());
        }
        if self.voice == voice {
            return Ok(());
        }
        self.all_off(None, None);
        if let Some(voice) = &voice {
            for channel in 0..8 {
                self.chip.voice(voice, channel, 0);
            }
        }
        self.voice = voice;
        Ok(())
    }

    pub fn note_on(&mut self, note: Note, velocity: u8) {
        if velocity == 0 {
            self.note_off(note);
            return;
        }
        if !(13..=108).contains(&note.note) || note.channel > 15 || velocity > 127 {
            return;
        }
        let Some(voice) = &self.voice else {
            return;
        };
        let channel = self.voices.allocate(note, velocity);
        self.chip.key_off(channel as u8);
        self.chip
            .voice(voice, channel as u8, self.voices.slots[channel].attenuation);
        let mask = if voice.operator_mask == 0 {
            [8, 8, 8, 8, 10, 14, 14, 15][voice.algorithm as usize]
        } else {
            voice.operator_mask
        };
        self.chip.key_on(channel as u8, note, mask);
    }

    pub fn note_off(&mut self, note: Note) {
        if let Some(channel) = self.voices.release(note) {
            self.chip.key_off(channel as u8);
        }
    }

    pub fn all_off(&mut self, source: Option<u8>, midi_channel: Option<u8>) {
        for (channel, slot) in self.voices.slots.iter_mut().enumerate() {
            if slot.note.is_some_and(|note| {
                source.is_none_or(|source| source == note.source)
                    && midi_channel.is_none_or(|channel| channel == note.channel)
            }) {
                self.chip.key_off(channel as u8);
                slot.note = None;
            }
        }
    }

    pub fn render(&mut self) -> Result<Vec<u8>, String> {
        self.audio.render(&mut self.chip)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use voice::Operator;

    fn tone() -> Voice {
        Voice {
            algorithm: 7,
            feedback: 0,
            operator_mask: 15,
            operators: std::array::from_fn(|_| Operator {
                ar: 31,
                d1r: 0,
                d2r: 0,
                rr: 15,
                d1l: 0,
                tl: 32,
                ks: 0,
                mul: 1,
                dt1: 0,
                dt2: 0,
                ame: 0,
            }),
        }
    }

    fn energy(bytes: &[u8]) -> f32 {
        bytes
            .chunks_exact(4)
            .map(|sample| f32::from_le_bytes(sample.try_into().unwrap()).abs())
            .sum()
    }

    #[test]
    fn pcm_preserves_resampled_volume_with_output_clamping() {
        use rubato::{FastFixedOut, PolynomialDegree, Resampler};

        let mut engine = Emulation::new(48000).unwrap();
        let mut reference = Emulation::new(48000).unwrap();
        for synth in [&mut engine, &mut reference] {
            synth.set_voice(Some(tone())).unwrap();
            synth.note_on(
                Note {
                    source: 0,
                    channel: 0,
                    note: 60,
                },
                127,
            );
        }
        let mut resampler = FastFixedOut::new(
            48000.0 / reference.chip.sample_rate() as f64,
            1.0,
            PolynomialDegree::Cubic,
            audio::BLOCK_FRAMES,
            2,
        )
        .unwrap();
        let input = reference.chip.generate(resampler.input_frames_next());
        let expected = resampler.process(&input, None).unwrap();
        let bytes = engine.render().unwrap();
        assert!(energy(&bytes) > 1.0);
        for (index, sample) in bytes.chunks_exact(4).enumerate() {
            let actual = f32::from_le_bytes(sample.try_into().unwrap());
            assert_eq!(actual, expected[index % 2][index / 2].clamp(-1.0, 1.0));
            assert!((-1.0..=1.0).contains(&actual));
        }
    }

    #[test]
    fn stereo_pcm_voice_upload_and_release() {
        let mut engine = Emulation::new(48000).unwrap();
        assert_eq!(energy(&engine.render().unwrap()), 0.0);
        let voice = tone();
        engine.set_voice(Some(voice)).unwrap();
        for index in 0..8 {
            engine.note_on(
                Note {
                    source: 0,
                    channel: 0,
                    note: 60 + index,
                },
                127,
            );
        }
        for _ in 0..5 {
            engine.render().unwrap();
        }
        let pcm = engine.render().unwrap();
        assert_eq!(pcm.len(), 512 * 2 * 4);
        assert!(energy(&pcm) > 1.0);
        engine.all_off(None, None);
        for _ in 0..60 {
            engine.render().unwrap();
        }
        assert!(energy(&engine.render().unwrap()) < 0.001);
    }

    #[test]
    fn register_layout_matches_ym2151() {
        let mut voice = tone();
        voice.operators[1].mul = 5;
        voice.operators[2].mul = 7;
        for channel in 0..8 {
            let registers = voice.registers(channel, 10);
            assert!(registers.contains(&(0x20 + channel, 0xc7)));
            assert!(registers.contains(&(0x50 + channel, 5)));
            assert!(registers.contains(&(0x48 + channel, 7)));
            for slot in [0, 8, 16, 24] {
                assert!(registers.contains(&(0x60 + slot + channel, 42)));
            }
        }
        assert!(Emulation::new(0).is_err());
        let mut invalid = tone();
        invalid.operators[0].tl = 128;
        assert!(
            Emulation::new(44100)
                .unwrap()
                .set_voice(Some(invalid))
                .is_err()
        );
    }

    #[test]
    fn zero_operator_mask_uses_the_mdx_algorithm_default() {
        let mut engine = Emulation::new(48000).unwrap();
        let mut voice = tone();
        voice.operator_mask = 0;
        engine.set_voice(Some(voice)).unwrap();
        engine.note_on(
            Note {
                source: 0,
                channel: 0,
                note: 60,
            },
            127,
        );
        for _ in 0..5 {
            engine.render().unwrap();
        }
        assert!(energy(&engine.render().unwrap()) > 1.0);
    }
}
