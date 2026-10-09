use std::collections::VecDeque;
use ymfm_sys::{ChipPtr, ffi};

pub struct Ym2151 {
    chip: ChipPtr,
    pending_keys: [bool; 8],
    buffered_samples: VecDeque<[i32; 2]>,
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
            buffered_samples: VecDeque::new(),
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.chip.sample_rate()
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
        }
        self.chip.pin_mut().write(0, address);
        self.chip.pin_mut().write(1, value);
    }

    pub fn generate(&mut self, frames: usize) -> Vec<Vec<f32>> {
        let mut pcm = vec![0_i32; frames * 2];
        let buffered = frames.min(self.buffered_samples.len());
        for (index, sample) in self.buffered_samples.drain(..buffered).enumerate() {
            pcm[index * 2..index * 2 + 2].copy_from_slice(&sample);
        }
        if buffered < frames {
            self.chip.pin_mut().generate(&mut pcm[buffered * 2..]);
            self.pending_keys.fill(false);
        }
        let mut stereo = vec![Vec::with_capacity(frames), Vec::with_capacity(frames)];
        for sample in pcm.chunks_exact(2) {
            stereo[0].push(sample[0] as f32 / 32768.0);
            stereo[1].push(sample[1] as f32 / 32768.0);
        }
        stereo
    }
}
