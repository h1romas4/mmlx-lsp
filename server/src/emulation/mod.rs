mod audio;
pub mod playback;
pub mod protocol;
mod ym2151;

use crate::audition::{Audition, CLOCK};
pub use crate::audition::{polyphony, voice};
use audio::Audio;
use polyphony::Note;
use voice::Voice;
use ym2151::Ym2151;

pub struct Emulation {
    chip: Ym2151,
    audio: Audio,
    audition: Audition,
}

impl Emulation {
    pub fn new(sample_rate: u32) -> Result<Self, String> {
        let chip = Ym2151::new(CLOCK);
        Ok(Self {
            audio: Audio::new(chip.sample_rate(), sample_rate)?,
            chip,
            audition: Audition::default(),
        })
    }

    pub fn set_voice(&mut self, voice: Option<Voice>) -> Result<(), String> {
        let writes = self.audition.set_voice(voice)?;
        self.write(writes);
        Ok(())
    }

    pub fn note_on(&mut self, note: Note, velocity: u8) {
        let writes = self.audition.note_on(note, velocity);
        self.write(writes);
    }

    pub fn note_off(&mut self, note: Note) {
        let writes = self.audition.note_off(note);
        self.write(writes);
    }

    pub fn all_off(&mut self, source: Option<u8>, midi_channel: Option<u8>) {
        let writes = self.audition.all_off(source, midi_channel);
        self.write(writes);
    }

    fn write(&mut self, writes: Vec<(u8, u8)>) {
        for (address, value) in writes {
            self.chip.write(address, value);
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
    fn keyboard_notes_match_midi_pitch() {
        for note in [48, 60, 62, 69, 72, 84] {
            let mut engine = Emulation::new(48000).unwrap();
            let mut voice = tone();
            voice.operator_mask = 8;
            engine.set_voice(Some(voice)).unwrap();
            engine.note_on(
                Note {
                    source: 0,
                    channel: 0,
                    note,
                },
                127,
            );
            for _ in 0..10 {
                engine.render().unwrap();
            }
            let mut samples = Vec::new();
            for _ in 0..30 {
                samples.extend(
                    engine
                        .render()
                        .unwrap()
                        .chunks_exact(8)
                        .map(|frame| f32::from_le_bytes(frame[..4].try_into().unwrap())),
                );
            }
            let crossings: Vec<f64> = samples
                .windows(2)
                .enumerate()
                .filter(|(_, pair)| pair[0] <= 0.0 && pair[1] > 0.0)
                .map(|(index, pair)| {
                    index as f64 - f64::from(pair[0]) / f64::from(pair[1] - pair[0])
                })
                .collect();
            assert!(crossings.len() > 2, "MIDI note {note} must produce a tone");
            let actual =
                48000.0 * (crossings.len() - 1) as f64 / (crossings.last().unwrap() - crossings[0]);
            let expected = 440.0 * 2_f64.powf((f64::from(note) - 69.0) / 12.0);
            assert!(
                (actual / expected - 1.0).abs() < 0.005,
                "MIDI note {note}: expected {expected:.3} Hz, got {actual:.3} Hz"
            );
        }
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
