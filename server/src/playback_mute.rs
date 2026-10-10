#[derive(Default)]
pub struct PlaybackMute {
    mask: u16,
    fm_pan: [u8; 8],
    pcm_pan: u8,
}

impl PlaybackMute {
    pub fn write_fm(&mut self, register: u8, value: u8) -> u8 {
        if (0x20..=0x27).contains(&register) {
            let channel = usize::from(register - 0x20);
            self.fm_pan[channel] = value;
            if self.mask & (1 << channel) != 0 {
                return value & 0x3f;
            }
        }
        value
    }

    pub fn write_pcm_pan(&mut self, value: u8) -> u8 {
        self.pcm_pan = value & 3;
        self.pcm_output()
    }

    pub fn pcm_output(&self) -> u8 {
        if self.pcm_muted() { 3 } else { self.pcm_pan }
    }

    pub fn pcm_muted(&self) -> bool {
        self.mask & 0x100 != 0
    }

    pub fn set_mask(&mut self, mask: u16) -> Result<Vec<(u8, u8)>, String> {
        if mask > 0x1ff {
            return Err("Invalid playback mute mask".into());
        }
        let changed = self.mask ^ mask;
        self.mask = mask;
        Ok((0..8)
            .filter(|channel| changed & (1 << channel) != 0)
            .map(|channel| {
                let value = self.fm_pan[channel];
                (
                    0x20 + channel as u8,
                    if mask & (1 << channel) != 0 {
                        value & 0x3f
                    } else {
                        value
                    },
                )
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fm_mask_preserves_tone_and_restores_latest_pan() {
        let mut mute = PlaybackMute::default();
        assert_eq!(mute.write_fm(0x20, 0xd7), 0xd7);
        assert_eq!(mute.write_fm(0x27, 0x47), 0x47);
        assert_eq!(mute.set_mask(1).unwrap(), vec![(0x20, 0x17)]);
        assert_eq!(mute.write_fm(0x20, 0x8a), 0x0a);
        assert_eq!(mute.write_fm(0x27, 0x67), 0x67);
        assert_eq!(mute.write_fm(0x60, 24), 24);
        assert_eq!(mute.write_fm(0x08, 0x78), 0x78);
        assert_eq!(mute.set_mask(0).unwrap(), vec![(0x20, 0x8a)]);
        assert!(mute.set_mask(0).unwrap().is_empty());
        assert!(mute.set_mask(0x200).is_err());
    }

    #[test]
    fn pcm_mask_remembers_pan_without_affecting_fm() {
        let mut mute = PlaybackMute::default();
        assert_eq!(mute.write_pcm_pan(1), 1);
        assert!(mute.set_mask(0x100).unwrap().is_empty());
        assert!(mute.pcm_muted());
        assert_eq!(mute.pcm_output(), 3);
        assert_eq!(mute.write_pcm_pan(2), 3);
        assert_eq!(mute.write_fm(0x20, 0xc7), 0xc7);
        assert!(mute.set_mask(0).unwrap().is_empty());
        assert_eq!(mute.pcm_output(), 2);
    }
}
