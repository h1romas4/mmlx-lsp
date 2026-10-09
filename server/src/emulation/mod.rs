mod audio;
pub mod playback;
pub mod protocol;
mod ym2151;

use crate::audition::{Audition, CLOCK};
pub use crate::audition::{polyphony, voice};
use audio::Audio;
use polyphony::Note;
use std::{cell::RefCell, rc::Rc};
use voice::Voice;
use ym2151::Ym2151;

pub struct Emulation {
    chip: Rc<RefCell<Ym2151>>,
    audio: Audio,
    audition: Audition,
    voice_test: Option<playback::Playback>,
    voice_test_failed: bool,
    sample_rate: u32,
}

impl Emulation {
    pub fn new(sample_rate: u32) -> Result<Self, String> {
        let chip = Ym2151::new(CLOCK);
        Ok(Self {
            audio: Audio::new(chip.sample_rate(), sample_rate)?,
            chip: Rc::new(RefCell::new(chip)),
            audition: Audition::default(),
            voice_test: None,
            voice_test_failed: false,
            sample_rate,
        })
    }

    pub fn set_voice(&mut self, voice: Option<Voice>) -> Result<(), String> {
        let writes = self.audition.set_voice(voice)?;
        self.write(writes);
        Ok(())
    }

    pub fn reset(&mut self, voice: Option<Voice>) -> Result<(), String> {
        let mut engine = Self::new(self.sample_rate)?;
        engine.set_voice(voice)?;
        *self = engine;
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

    pub fn pitch_bend(&mut self, source: u8, channel: u8, value: u16) {
        let writes = self.audition.pitch_bend(source, channel, value);
        self.write(writes);
    }

    pub fn all_off(&mut self, source: Option<u8>, midi_channel: Option<u8>) {
        let writes = self.audition.all_off(source, midi_channel);
        self.write(writes);
    }

    fn write(&mut self, writes: Vec<(u8, u8)>) {
        for (address, value) in writes {
            self.chip.borrow_mut().write(address, value);
        }
    }

    pub fn start_voice_test(&mut self, mml: &str, voice: Voice) -> Result<(), String> {
        self.stop_voice_test();
        let mdx = voice.test_document(mml)?;
        self.all_off(None, None);
        self.voice_test = Some(playback::Playback::voice_test(
            mdx,
            self.sample_rate,
            Rc::clone(&self.chip),
            self.audition.begin_voice_test(),
        )?);
        Ok(())
    }

    pub fn voice_test_active(&self) -> bool {
        self.voice_test.is_some()
    }

    pub fn voice_test_failed(&self) -> bool {
        self.voice_test_failed
    }

    pub fn stop_voice_test(&mut self) {
        self.voice_test = None;
        self.voice_test_failed = false;
        self.write((0..8).map(|channel| (0x08, channel)).collect());
        let writes = self.audition.restore_voice();
        self.write(writes);
        self.chip.borrow_mut().silence();
        self.audio.reset();
    }

    pub fn render(&mut self) -> Result<Vec<u8>, String> {
        if let Some(test) = self.voice_test.as_mut() {
            let pcm = test.render();
            let failed = pcm.is_err();
            if pcm.is_err() || test.finished() {
                self.stop_voice_test();
                self.voice_test_failed = failed;
            }
            if let Ok(pcm) = pcm {
                return Ok(pcm);
            }
        }
        self.audio.render(&mut self.chip.borrow_mut())
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
    fn reset_replaces_the_chip_clears_lfo_and_keeps_the_keyboard_usable() {
        let mut engine = Emulation::new(48000).unwrap();
        engine.set_voice(Some(tone())).unwrap();
        engine
            .start_voice_test("MH0,200,64,0,5,0,1", tone())
            .unwrap();
        engine.render().unwrap();
        assert!(engine.audition.restore_voice().contains(&(0x38, 0x50)));
        let chip = Rc::clone(&engine.chip);
        engine.reset(Some(tone())).unwrap();
        assert!(!Rc::ptr_eq(&chip, &engine.chip));
        assert!(!engine.voice_test_active());
        assert_eq!(engine.sample_rate, 48000);
        assert!(engine.audition.restore_voice().contains(&(0x38, 0)));
        assert_eq!(energy(&engine.render().unwrap()), 0.0);
        engine.note_on(
            Note {
                source: 0,
                channel: 0,
                note: 69,
            },
            127,
        );
        for _ in 0..5 {
            engine.render().unwrap();
        }
        assert!(energy(&engine.render().unwrap()) > 1.0);
    }

    #[test]
    fn voice_test_without_notes_keeps_the_keyboard_voice_and_lfo() {
        let mut engine = Emulation::new(48000).unwrap();
        engine.set_voice(Some(tone())).unwrap();
        engine
            .start_voice_test("MH0,200,64,0,5,0,1 ; PMS LFO", tone())
            .unwrap();
        engine.render().unwrap();
        assert!(!engine.voice_test_active());
        let writes = engine.audition.restore_voice();
        for channel in 0..8 {
            assert!(writes.contains(&(0x38 + channel, 0x50)));
            assert!(writes.contains(&(0x20 + channel, 0xc7)));
        }
        engine.note_on(
            Note {
                source: 0,
                channel: 0,
                note: 69,
            },
            127,
        );
        let mut volume = 0.0;
        for _ in 0..10 {
            volume += energy(&engine.render().unwrap());
        }
        assert!(volume > 1.0);
    }

    #[test]
    fn voice_test_keeps_all_channel_settings_and_lfo_in_keyboard_audio() {
        let mut engine = Emulation::new(48000).unwrap();
        let mut voice = tone();
        voice.operator_mask = 8;
        engine.set_voice(Some(voice.clone())).unwrap();
        engine
            .start_voice_test("MH0,200,64,0,5,0,1 p1 t240 o4 c16 y65,2", voice)
            .unwrap();
        for _ in 0..100 {
            engine.render().unwrap();
            if !engine.voice_test_active() {
                break;
            }
        }
        assert!(!engine.voice_test_active());
        let restored = engine.audition.restore_voice();
        for channel in 0..8 {
            assert!(
                restored.contains(&(0x38 + channel, 0x50)),
                "LFO sensitivity for channel {channel}"
            );
            let writes = engine.audition.note_on(
                Note {
                    source: 0,
                    channel: 0,
                    note: 60 + channel,
                },
                127,
            );
            assert!(writes.contains(&(0x38 + channel, 0x50)));
            assert!(writes.contains(&(0x20 + channel, 0x47)));
            assert!(writes.contains(&(0x40 + channel, 2)));
            engine.write(writes);
        }
        engine.all_off(None, None);
        engine.note_on(
            Note {
                source: 0,
                channel: 0,
                note: 69,
            },
            127,
        );
        let mut samples = Vec::new();
        for _ in 0..80 {
            let pcm = engine.render().unwrap();
            samples.extend(
                pcm.chunks_exact(8)
                    .map(|frame| f32::from_le_bytes(frame[..4].try_into().unwrap())),
            );
        }
        let crossings: Vec<_> = samples
            .windows(2)
            .enumerate()
            .skip(4096)
            .filter_map(|(index, pair)| (pair[0] <= 0.0 && pair[1] > 0.0).then_some(index))
            .collect();
        let periods: Vec<_> = crossings.windows(2).map(|pair| pair[1] - pair[0]).collect();
        assert!(periods.len() > 100);
        assert!(
            periods.iter().max().unwrap() - periods.iter().min().unwrap() > 3,
            "Keyboard pitch must vary with the retained hardware LFO"
        );
    }

    #[test]
    fn voice_test_end_does_not_resume_old_keyboard_audio_or_a_sustained_release() {
        let mut engine = Emulation::new(48000).unwrap();
        let mut voice = tone();
        for operator in &mut voice.operators {
            operator.rr = 0;
        }
        engine.set_voice(Some(voice.clone())).unwrap();
        engine.note_on(
            Note {
                source: 0,
                channel: 0,
                note: 84,
            },
            127,
        );
        for _ in 0..10 {
            engine.render().unwrap();
        }
        engine.start_voice_test("t240 o4 c16", voice).unwrap();
        for _ in 0..100 {
            engine.render().unwrap();
            if !engine.voice_test_active() {
                break;
            }
        }
        assert!(!engine.voice_test_active());
        for block in 0..10 {
            let pcm = engine.render().unwrap();
            let peak = pcm
                .chunks_exact(4)
                .map(|sample| f32::from_le_bytes(sample.try_into().unwrap()).abs())
                .fold(0_f32, f32::max);
            assert!(
                peak < 0.0001,
                "Unexpected post-test tone in block {block}: {peak}"
            );
        }
    }

    #[test]
    fn voice_test_uses_the_connected_chip_and_returns_to_keyboard_after_end_stop_and_error() {
        let mut engine = Emulation::new(48000).unwrap();
        engine.set_voice(Some(tone())).unwrap();
        let chip = Rc::clone(&engine.chip);
        engine
            .start_voice_test("t240 o4 c16 y24,128", tone())
            .unwrap();
        assert!(Rc::ptr_eq(&chip, &engine.chip));
        let mut energy_sum = 0.0;
        for _ in 0..100 {
            energy_sum += energy(&engine.render().unwrap());
        }
        assert!(energy_sum > 1.0 && !engine.voice_test_active());
        engine.start_voice_test("o4 c1", tone()).unwrap();
        engine.render().unwrap();
        engine.stop_voice_test();
        assert!(!engine.voice_test_active());
        assert!(engine.start_voice_test("invalid???", tone()).is_err());
        assert!(!engine.voice_test_active());
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

    #[test]
    fn keyboard_and_mml_notes_match_midi_pitch() {
        for (note, phrase) in [
            (48, "o3 c1"),
            (60, "o4 c1"),
            (62, "o4 d1"),
            (69, "o4 a1"),
            (72, "o5 c1"),
            (84, "o6 c1"),
        ] {
            let mut engine = Emulation::new(48000).unwrap();
            let mut voice = tone();
            voice.operator_mask = 8;
            engine.set_voice(Some(voice.clone())).unwrap();
            engine.note_on(
                Note {
                    source: 0,
                    channel: 0,
                    note,
                },
                127,
            );
            let mut mml = Emulation::new(48000).unwrap();
            mml.start_voice_test(phrase, voice).unwrap();
            for mut engine in [engine, mml] {
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
                let actual = 48000.0 * (crossings.len() - 1) as f64
                    / (crossings.last().unwrap() - crossings[0]);
                let expected = 440.0 * 2_f64.powf((f64::from(note) - 69.0) / 12.0);
                assert!(
                    (actual / expected - 1.0).abs() < 0.005,
                    "MIDI note {note}: expected {expected:.3} Hz, got {actual:.3} Hz"
                );
            }
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
            48000.0 / reference.chip.borrow().sample_rate() as f64,
            1.0,
            PolynomialDegree::Cubic,
            audio::BLOCK_FRAMES,
            2,
        )
        .unwrap();
        let input = reference
            .chip
            .borrow_mut()
            .generate(resampler.input_frames_next());
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
    fn pitch_bend_changes_a_sustained_tones_frequency_without_retrigger() {
        let mut engine = Emulation::new(48000).unwrap();
        engine.set_voice(Some(tone())).unwrap();
        engine.note_on(
            Note {
                source: 1,
                channel: 3,
                note: 69,
            },
            127,
        );
        for (value, expected) in [
            (8192, 440.0),
            (0, 392.0),
            (10240, 452.9),
            (16383, 493.9),
            (8192, 440.0),
        ] {
            engine.pitch_bend(1, 3, value);
            for _ in 0..8 {
                engine.render().unwrap();
            }
            let mut crossings = 0;
            let mut previous = 0.0;
            for _ in 0..80 {
                for frame in engine.render().unwrap().chunks_exact(8) {
                    let sample = f32::from_le_bytes(frame[..4].try_into().unwrap());
                    if previous < 0.0 && sample >= 0.0 {
                        crossings += 1;
                    }
                    previous = sample;
                }
            }
            let frequency = crossings as f64 * 48000.0 / (80.0 * 512.0);
            assert!(
                (frequency - expected).abs() < 4.0,
                "bend {value}: {frequency} Hz, expected {expected}"
            );
        }
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
