use super::{polyphony::Note, voice::Voice};
use std::collections::VecDeque;
use ymfm_sys::{ChipPtr, ffi};

pub struct Ym2151 {
    chip: ChipPtr,
    pending_keys: [bool; 8],
    buffered_samples: VecDeque<[i32; 2]>,
}

impl Default for Ym2151 {
    fn default() -> Self {
        Self {
            chip: ffi::create_chip(ffi::ChipType::Ym2151, 4_000_000),
            pending_keys: [false; 8],
            buffered_samples: VecDeque::new(),
        }
    }
}

impl Ym2151 {
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

    pub fn voice(&mut self, voice: &Voice, channel: u8, attenuation: u8) {
        for (address, value) in voice.registers(channel, attenuation) {
            self.write(address, value);
        }
    }

    pub fn key_on(&mut self, channel: u8, note: Note, mask: u8) {
        let pitch = note.note - 13;
        let keys = [0_u8, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14];
        self.write(
            0x28 + channel,
            (pitch / 12) << 4 | keys[(pitch % 12) as usize],
        );
        self.write(0x30 + channel, 0);
        self.write(0x08, (mask << 3) | channel);
    }

    pub fn key_off(&mut self, channel: u8) {
        self.write(0x08, channel);
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
