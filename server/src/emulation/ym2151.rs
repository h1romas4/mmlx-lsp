use std::collections::VecDeque;
use ymfm_sys::{ChipPtr, ffi};

const QUIET_SAMPLE_MAX: i32 = 1;
pub struct Ym2151 {
    chip: ChipPtr,
    pending_keys: [bool; 8],
    keyed: [bool; 8],
    buffered_samples: VecDeque<[i32; 2]>,
    quiet_frames: u32,
    dormant: bool,
    keep_awake: bool,
    #[cfg(test)]
    generated_frames: usize,
}

impl Default for Ym2151 {
    fn default() -> Self {
        Self::new(4_000_000)
    }
}

impl Ym2151 {
    pub fn new(clock: u32) -> Self {
        Self {
            chip: ffi::create_chip(ffi::ChipType::Ym2151, clock),
            pending_keys: [false; 8],
            keyed: [false; 8],
            buffered_samples: VecDeque::new(),
            quiet_frames: 0,
            dormant: true,
            keep_awake: false,
            #[cfg(test)]
            generated_frames: 0,
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.chip.sample_rate()
    }

    pub fn silence(&mut self) {
        for address in 0x60..=0x7f {
            self.write(address, 127);
        }
        for channel in 0..8 {
            self.write(0x08, channel);
        }
        self.buffered_samples.clear();
        self.keyed.fill(false);
        self.quiet_frames = 0;
        self.dormant = true;
        self.keep_awake = false;
    }

    pub fn set_keep_awake(&mut self, keep_awake: bool) {
        self.keep_awake = keep_awake;
        self.quiet_frames = 0;
        if keep_awake {
            self.dormant = false;
        }
    }

    pub fn write(&mut self, address: u8, value: u8) {
        if address == 0x08 {
            let channel = usize::from(value & 7);
            if self.pending_keys[channel] {
                let mut sample = [0; 2];
                self.chip.pin_mut().generate(&mut sample);
                self.buffered_samples.push_back(sample);
                self.pending_keys.fill(false);
            }
            self.pending_keys[channel] = true;
            self.keyed[channel] = value & 0x78 != 0;
            if self.keyed[channel] {
                self.quiet_frames = 0;
                self.dormant = false;
            }
        }
        self.chip.pin_mut().write(0, address);
        self.chip.pin_mut().write(1, value);
    }

    pub fn generate(&mut self, frames: usize) -> Vec<Vec<f32>> {
        if self.dormant {
            self.pending_keys.fill(false);
            return vec![vec![0.0; frames], vec![0.0; frames]];
        }
        let mut pcm = vec![0_i32; frames * 2];
        let buffered = frames.min(self.buffered_samples.len());
        for (index, sample) in self.buffered_samples.drain(..buffered).enumerate() {
            pcm[index * 2..index * 2 + 2].copy_from_slice(&sample);
        }
        if buffered < frames {
            self.chip.pin_mut().generate(&mut pcm[buffered * 2..]);
            self.pending_keys.fill(false);
            #[cfg(test)]
            {
                self.generated_frames += frames - buffered;
            }
        }
        if !self.keep_awake
            && self.keyed.iter().all(|keyed| !keyed)
            && pcm
                .iter()
                .all(|sample| sample.unsigned_abs() <= QUIET_SAMPLE_MAX as u32)
        {
            self.quiet_frames = self.quiet_frames.saturating_add(frames as u32);
            if self.quiet_frames >= self.sample_rate() / 10 {
                self.dormant = true;
            }
        } else {
            self.quiet_frames = 0;
        }
        let mut stereo = vec![Vec::with_capacity(frames), Vec::with_capacity(frames)];
        for sample in pcm.chunks_exact(2) {
            stereo[0].push(sample[0] as f32 / 32768.0);
            stereo[1].push(sample[1] as f32 / 32768.0);
        }
        stereo
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pauses_after_sustained_silence_and_resumes_on_key_on() {
        let mut chip = Ym2151::default();
        let silence = chip.generate(512);
        assert!(silence.iter().flatten().all(|sample| *sample == 0.0));
        assert_eq!(chip.generated_frames, 0);

        chip.write(0x08, 0x78);
        assert!(!chip.dormant);
        chip.generate(512);
        assert!(chip.generated_frames > 0);

        chip.write(0x08, 0x00);
        for _ in 0..20 {
            chip.generate(512);
            if chip.dormant {
                break;
            }
        }
        assert!(chip.dormant);
        let generated = chip.generated_frames;
        assert!(
            chip.generate(512)
                .iter()
                .flatten()
                .all(|sample| *sample == 0.0)
        );
        assert_eq!(chip.generated_frames, generated);

        chip.write(0x08, 0x78);
        assert!(!chip.dormant);
        chip.generate(512);
        assert!(chip.generated_frames > generated);
    }

    #[test]
    fn stays_awake_during_playback_and_restarts_idle_timer_afterward() {
        let mut chip = Ym2151::default();
        chip.set_keep_awake(true);
        for _ in 0..20 {
            chip.generate(512);
        }
        assert!(!chip.dormant);
        assert_eq!(chip.generated_frames, 20 * 512);

        chip.set_keep_awake(false);
        assert!(!chip.keep_awake);
        assert_eq!(chip.quiet_frames, 0);
    }
}
