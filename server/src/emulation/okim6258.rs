// license:BSD-3-Clause
/*
 * Rust OKI MSM6258 ports by
 *  Hiromasa Tanaka <h1romas4@gmail.com>
 *  https://github.com/h1romas4/libymfm.wasm
 *
 * Porting from:
 *  MAME
 *  copyright-holders:Barry Rodewald
 *  https://github.com/mamedev/mame/blob/master/src/devices/sound/okim6258.cpp
 *  rev. 70743c6fb2602a5c2666c679b618706eabfca2ad
 */

const COMMAND_STOP: u8 = 1 << 0;
const COMMAND_PLAY: u8 = 1 << 1;
const COMMAND_RECORD: u8 = 1 << 2;
const STATUS_PLAYING: u8 = 1 << 1;
const STATUS_RECORDING: u8 = 1 << 2;
const INDEX_SHIFT: [i32; 8] = [-1, -1, -1, -1, 2, 4, 6, 8];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClockDivider {
    Div1024,
    Div768,
    Div512,
}

impl ClockDivider {
    fn value(self) -> u32 {
        match self {
            Self::Div1024 => 1024,
            Self::Div768 => 768,
            Self::Div512 => 512,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum OutputBits {
    Bits10 = 10,
    Bits12 = 12,
}

pub struct Okim6258 {
    clock: u32,
    divider: ClockDivider,
    output_bits: OutputBits,
    status: u8,
    data_in: u8,
    nibble_shift: u8,
    signal: i32,
    step: usize,
    diff_lookup: [[i32; 16]; 49],
}

impl Default for Okim6258 {
    fn default() -> Self {
        Self::new(8_000_000)
    }
}

impl Okim6258 {
    /// Starts with a divide-by-1024 clock and the chip's 10-bit DAC precision.
    pub fn new(clock: u32) -> Self {
        Self {
            clock,
            divider: ClockDivider::Div1024,
            output_bits: OutputBits::Bits10,
            status: 0,
            data_in: 0,
            nibble_shift: 0,
            signal: -2,
            step: 0,
            diff_lookup: difference_table(),
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.clock / self.divider.value()
    }

    pub fn set_clock(&mut self, clock: u32) {
        self.clock = clock;
    }

    pub fn set_divider(&mut self, divider: ClockDivider) {
        self.divider = divider;
    }

    pub fn set_output_bits(&mut self, output_bits: OutputBits) {
        self.output_bits = output_bits;
    }

    /// Returns 0x00 while playing and 0x80 while stopped, as the status port does.
    pub fn status(&self) -> u8 {
        if self.status & STATUS_PLAYING != 0 {
            0x00
        } else {
            0x80
        }
    }

    /// Stops decoding without clearing the data register or clock configuration.
    pub fn reset(&mut self) {
        self.signal = -2;
        self.step = 0;
        self.status = 0;
    }

    /// Replaces the data register and selects its low nibble; there is no FIFO.
    pub fn write_data(&mut self, data: u8) {
        self.data_in = data;
        self.nibble_shift = 0;
    }

    /// Writes STOP/PLAY/RECORD bits. RECORD tracks state only, as in MAME.
    pub fn write_control(&mut self, data: u8) {
        if data & COMMAND_STOP != 0 {
            self.status &= !(STATUS_PLAYING | STATUS_RECORDING);
            return;
        }
        if data & COMMAND_PLAY != 0 {
            if self.status & STATUS_PLAYING == 0 {
                self.status |= STATUS_PLAYING;
                self.signal = -2;
                self.step = 0;
                self.nibble_shift = 0;
            }
        } else {
            self.status &= !STATUS_PLAYING;
        }
        if data & COMMAND_RECORD != 0 {
            self.status |= STATUS_RECORDING;
        } else {
            self.status &= !STATUS_RECORDING;
        }
    }

    /// Renders at sample_rate(). Slice the destination to render only a region.
    /// Until the next data write, the latched byte's two nibbles repeat.
    pub fn render(&mut self, output: &mut [f32]) {
        if self.status & STATUS_PLAYING == 0 {
            output.fill(0.0);
            return;
        }
        for sample in output {
            let nibble = (self.data_in >> self.nibble_shift) & 0x0f;
            *sample = f32::from(self.clock_adpcm(nibble)) / 32768.0;
            self.nibble_shift ^= 4;
        }
    }

    fn clock_adpcm(&mut self, nibble: u8) -> i16 {
        let limit = 1_i32 << (self.output_bits as u8 - 1);
        self.signal = (self.signal + self.diff_lookup[self.step][usize::from(nibble)])
            .clamp(-limit, limit - 1);
        self.step = (self.step as i32 + INDEX_SHIFT[usize::from(nibble & 7)]).clamp(0, 48) as usize;
        (self.signal << 4) as i16
    }
}

fn difference_table() -> [[i32; 16]; 49] {
    std::array::from_fn(|step| {
        let step_value = (16.0 * (11.0_f64 / 10.0).powf(step as f64)).floor() as i32;
        std::array::from_fn(|nibble| {
            let magnitude = step_value / 8
                + if nibble & 1 != 0 { step_value / 4 } else { 0 }
                + if nibble & 2 != 0 { step_value / 2 } else { 0 }
                + if nibble & 4 != 0 { step_value } else { 0 };
            if nibble & 8 != 0 {
                -magnitude
            } else {
                magnitude
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm(samples: &[i16]) -> Vec<f32> {
        samples
            .iter()
            .map(|&sample| f32::from(sample) / 32768.0)
            .collect()
    }

    #[test]
    fn data_register_replaces_bytes_and_decodes_low_then_high_nibbles() {
        let mut chip = Okim6258::default();
        chip.write_control(COMMAND_PLAY);
        chip.write_data(0x21);
        let mut output = [0.0; 2];
        chip.render(&mut output);
        assert_eq!(output.as_slice(), pcm(&[64, 224]));
        chip.write_data(0x43);
        chip.render(&mut output);
        assert_eq!(output.as_slice(), pcm(&[448, 736]));

        let mut chip = Okim6258::default();
        chip.write_control(COMMAND_PLAY);
        chip.write_data(0x21);
        chip.write_data(0x43);
        let mut output = [0.0; 4];
        chip.render(&mut output);
        assert_eq!(output.as_slice(), pcm(&[192, 480, 720, 1024]));
    }

    #[test]
    fn play_keeps_data_written_while_stopped() {
        let mut chip = Okim6258::default();
        chip.write_data(0x77);
        chip.write_control(COMMAND_PLAY);
        let mut output = [0.0; 2];
        chip.render(&mut output);
        assert_eq!(output.as_slice(), pcm(&[448, 1456]));
    }

    #[test]
    fn render_keeps_nibble_phase_and_only_clears_the_supplied_slice() {
        let mut chip = Okim6258::default();
        chip.write_control(COMMAND_PLAY);
        chip.write_data(0x21);
        let mut output = [0.0; 1];
        chip.render(&mut output);
        assert_eq!(output.as_slice(), pcm(&[64]));
        chip.render(&mut output);
        assert_eq!(output.as_slice(), pcm(&[224]));
        chip.write_data(0x43);
        chip.render(&mut output);
        assert_eq!(output.as_slice(), pcm(&[448]));

        chip.write_control(COMMAND_STOP);
        let mut output = [1.0; 6];
        chip.render(&mut output[2..4]);
        assert_eq!(output, [1.0, 1.0, 0.0, 0.0, 1.0, 1.0]);
        assert_eq!(chip.nibble_shift, 4);
    }

    #[test]
    fn control_status_and_play_transitions_match_mame() {
        let mut chip = Okim6258::default();
        assert_eq!(chip.status(), 0x80);
        chip.write_control(COMMAND_PLAY | COMMAND_RECORD);
        assert_eq!(chip.status(), 0x00);
        assert_eq!(chip.status, STATUS_PLAYING | STATUS_RECORDING);
        chip.write_data(0x21);
        chip.render(&mut [0.0]);
        chip.write_control(COMMAND_PLAY);
        assert_eq!(chip.status, STATUS_PLAYING);
        let mut output = [0.0; 1];
        chip.render(&mut output);
        assert_eq!(output.as_slice(), pcm(&[224]));
        chip.write_control(COMMAND_STOP | COMMAND_PLAY | COMMAND_RECORD);
        assert_eq!(chip.status, 0);
        assert_eq!(chip.status(), 0x80);
        chip.write_control(COMMAND_PLAY);
        chip.render(&mut output);
        assert_eq!(output.as_slice(), pcm(&[64]));
        chip.write_control(COMMAND_RECORD);
        assert_eq!(chip.status, STATUS_RECORDING);
        assert_eq!(chip.status(), 0x80);
        chip.write_control(0);
        assert_eq!(chip.status, 0);
    }

    #[test]
    fn reset_preserves_data_phase_and_configuration() {
        let mut chip = Okim6258::new(4_000_000);
        chip.set_divider(ClockDivider::Div512);
        chip.set_output_bits(OutputBits::Bits12);
        chip.write_control(COMMAND_PLAY | COMMAND_RECORD);
        chip.write_data(0x77);
        chip.render(&mut [0.0]);
        chip.reset();
        assert_eq!(chip.status(), 0x80);
        assert_eq!(chip.status, 0);
        assert_eq!(chip.signal, -2);
        assert_eq!(chip.step, 0);
        assert_eq!(chip.data_in, 0x77);
        assert_eq!(chip.nibble_shift, 4);
        assert_eq!(chip.sample_rate(), 7812);
        assert_eq!(chip.output_bits, OutputBits::Bits12);
        chip.write_control(COMMAND_PLAY);
        assert_eq!(chip.nibble_shift, 0);
    }

    #[test]
    fn sample_rate_tracks_clock_and_divider_changes_without_resetting() {
        let mut chip = Okim6258::default();
        assert_eq!(chip.sample_rate(), 7812);
        chip.write_control(COMMAND_PLAY);
        chip.write_data(0x21);
        chip.render(&mut [0.0]);
        chip.set_divider(ClockDivider::Div768);
        assert_eq!(chip.sample_rate(), 10416);
        chip.set_divider(ClockDivider::Div512);
        assert_eq!(chip.sample_rate(), 15625);
        chip.set_clock(4_000_000);
        assert_eq!(chip.sample_rate(), 7812);
        assert_eq!(chip.signal, 4);
        assert_eq!(chip.nibble_shift, 4);
        assert_eq!(chip.status(), 0x00);
    }

    #[test]
    fn signal_and_step_are_clamped_at_both_output_precisions() {
        for (bits, limit) in [(OutputBits::Bits10, 512), (OutputBits::Bits12, 2048)] {
            let mut chip = Okim6258::default();
            chip.set_output_bits(bits);
            chip.write_control(COMMAND_PLAY);
            chip.write_data(0x77);
            let mut output = [0.0; 128];
            chip.render(&mut output);
            assert_eq!(chip.signal, limit - 1);
            assert_eq!(chip.step, 48);
            assert_eq!(output[127], (limit - 1) as f32 / 2048.0);
            chip.write_data(0xff);
            chip.render(&mut output);
            assert_eq!(chip.signal, -limit);
            assert_eq!(chip.step, 48);
            assert_eq!(output[127], -limit as f32 / 2048.0);
            chip.write_data(0x00);
            chip.render(&mut output);
            assert_eq!(chip.step, 0);
        }
    }

    #[test]
    fn difference_table_matches_all_mame_step_values() {
        let step_values = [
            16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
            118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544,
            598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552,
        ];
        let table = difference_table();
        for (step, value) in step_values.into_iter().enumerate() {
            for nibble in 0..8 {
                let expected = value / 8
                    + value / 4 * (nibble & 1) as i32
                    + value / 2 * ((nibble >> 1) & 1) as i32
                    + value * ((nibble >> 2) & 1) as i32;
                assert_eq!(table[step][nibble], expected);
                assert_eq!(table[step][nibble | 8], -expected);
            }
        }
    }
}
