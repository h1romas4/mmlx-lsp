use super::ym2151::Ym2151;
use rubato::{FastFixedOut, PolynomialDegree, Resampler};

pub const BLOCK_FRAMES: usize = 512;

pub struct Audio {
    resampler: FastFixedOut<f32>,
}

impl Audio {
    pub fn new(native_rate: u32, output_rate: u32) -> Result<Self, String> {
        if !(8000..=192000).contains(&output_rate) {
            return Err("Invalid sample rate".into());
        }
        let resampler = FastFixedOut::new(
            output_rate as f64 / native_rate as f64,
            1.0,
            PolynomialDegree::Cubic,
            BLOCK_FRAMES,
            2,
        )
        .map_err(|error| error.to_string())?;
        Ok(Self { resampler })
    }

    pub fn render(&mut self, chip: &mut Ym2151) -> Result<Vec<u8>, String> {
        let input = chip.generate(self.resampler.input_frames_next());
        let pcm = self
            .resampler
            .process(&input, None)
            .map_err(|error| error.to_string())?;
        let mut bytes = Vec::with_capacity(BLOCK_FRAMES * 8);
        for index in 0..BLOCK_FRAMES {
            for channel in &pcm {
                bytes.extend_from_slice(&(channel[index] * 0.18).clamp(-1.0, 1.0).to_le_bytes());
            }
        }
        Ok(bytes)
    }
}
