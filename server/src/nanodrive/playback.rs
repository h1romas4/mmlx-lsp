use ndsif::{AudioEvent, BytePosition, Command, Pan, RegisterWrite, ZeroPair};
use soundlog::chip::{Okim6258Spec, Ym2151Spec};
use soundlog::mdx::{
    convert::{AdpcmMode, MdxToVgmOptions},
    package::MdxPackage,
};
use soundlog::vgm::{VgmCallbackStream, command::VgmCommand, stream::StreamResult};
use std::{cell::RefCell, collections::VecDeque, rc::Rc};

const RATE: u64 = 15_625;
const PREROLL: u32 = 40;
const STEPS: [i32; 49] = [
    16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130,
    143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
    876, 963, 1060, 1166, 1282, 1411, 1552,
];

#[derive(Clone)]
struct Codec {
    signal: i32,
    index: usize,
}
impl Default for Codec {
    fn default() -> Self {
        Self {
            signal: -2,
            index: 0,
        }
    }
}
impl Codec {
    fn decode(&mut self, nibble: u8) -> i16 {
        let step = STEPS[self.index];
        let difference = (step >> 3)
            + if nibble & 1 != 0 { step >> 2 } else { 0 }
            + if nibble & 2 != 0 { step >> 1 } else { 0 }
            + if nibble & 4 != 0 { step } else { 0 };
        self.signal = (self.signal
            + if nibble & 8 != 0 {
                -difference
            } else {
                difference
            })
        .clamp(-2048, 2047);
        let change = [-1, -1, -1, -1, 2, 4, 6, 8][usize::from(nibble & 7)];
        self.index = self.index.saturating_add_signed(change).min(48);
        self.signal as i16
    }
    fn encode(&mut self, sample: i16) -> u8 {
        let difference = i32::from(sample).clamp(-2048, 2047) - self.signal;
        let mut residual = difference.abs();
        let mut nibble = if difference < 0 { 8 } else { 0 };
        let step = STEPS[self.index];
        for (mask, threshold) in [(4, step), (2, step >> 1), (1, step >> 2)] {
            if residual >= threshold {
                nibble |= mask;
                residual -= threshold;
            }
        }
        self.decode(nibble);
        nibble
    }
    fn pair(&mut self, samples: [i16; 2]) -> u8 {
        self.encode(samples[0]) | (self.encode(samples[1]) << 4)
    }
}

#[derive(Default)]
struct Input {
    decoder: Codec,
    samples: VecDeque<i16>,
    running: bool,
}
enum Event {
    Fm(RegisterWrite),
    Pan(Pan),
}
pub struct Chunk {
    pub bytes: Vec<u8>,
    pub count: usize,
    pub position: u32,
    pub ended: bool,
}
pub struct Playback {
    stream: VgmCallbackStream<'static>,
    input: Rc<RefCell<Input>>,
    events: Rc<RefCell<VecDeque<(u32, Event)>>>,
    encoder: Codec,
    position: u32,
    pending: usize,
    remainder: u64,
    finished: bool,
    tail: usize,
    ended: bool,
}

impl Playback {
    pub fn new(source: &str, pdx: Option<Vec<u8>>, looped: bool) -> Result<Self, String> {
        let parsed = mmlx::mdx::parse(source).map_err(|error| error.to_string())?;
        let mdx = mmlx::mdx::compile(&parsed).map_err(|error| error.to_string())?;
        let package =
            MdxPackage::parse_owned(mdx.to_bytes().map_err(|error| error.to_string())?, pdx)
                .map_err(|error| error.to_string())?;
        if package.pdx.is_none()
            && let Some(name) = package.pdx_name()
        {
            return Err(format!("PDX file required: {name}"));
        }
        let options = MdxToVgmOptions {
            adpcm_mode: AdpcmMode::Resample,
            loop_count: if looped { None } else { Some(1) },
            ..Default::default()
        };
        let mut stream = VgmCallbackStream::from_generator((package, options).into());
        let input = Rc::new(RefCell::new(Input::default()));
        let events = Rc::new(RefCell::new(VecDeque::new()));
        let writes = Rc::clone(&events);
        stream.on_write(move |_, spec: Ym2151Spec, sample, _| {
            writes.borrow_mut().push_back((
                PREROLL + (sample as u64 * RATE / 88_200) as u32,
                Event::Fm(RegisterWrite::new(spec.register, spec.value)),
            ));
        });
        let pcm = Rc::clone(&input);
        let controls = Rc::clone(&events);
        stream.on_write(move |_, spec: Okim6258Spec, sample, _| {
            let mut input = pcm.borrow_mut();
            match spec.register {
                0 => {
                    if spec.value & 1 != 0 {
                        input.running = false;
                        input.samples.clear();
                    } else if spec.value & 2 != 0 && !input.running {
                        input.decoder = Codec::default();
                        input.running = true;
                    }
                }
                1 => {
                    let low = input.decoder.decode(spec.value & 15);
                    let high = input.decoder.decode(spec.value >> 4);
                    input.samples.extend([low, high]);
                }
                2 => {
                    if let Ok(pan) = Pan::try_from(spec.value) {
                        controls.borrow_mut().push_back((
                            PREROLL + (sample as u64 * RATE / 88_200) as u32,
                            Event::Pan(pan),
                        ));
                    }
                }
                _ => {}
            }
        });
        Ok(Self {
            stream,
            input,
            events,
            encoder: Codec::default(),
            position: 0,
            pending: 0,
            remainder: 0,
            finished: false,
            tail: RATE.div_ceil(40) as usize,
            ended: false,
        })
    }

    fn sample(&mut self) -> Result<i16, String> {
        while self.pending == 0 && !self.finished {
            match self
                .stream
                .next()
                .transpose()
                .map_err(|error| error.to_string())?
            {
                Some(StreamResult::Command(VgmCommand::WaitSamples(wait))) => {
                    let samples = self.remainder + u64::from(wait.0) * RATE;
                    self.pending = (samples / 44_100) as usize;
                    self.remainder = samples % 44_100;
                }
                None | Some(StreamResult::EndOfStream) => self.finished = true,
                Some(StreamResult::NeedsMoreData) => {
                    return Err("Incomplete playback stream".into());
                }
                _ => {}
            }
            if self.events.borrow().len() > 4096 || self.input.borrow().samples.len() > 16384 {
                return Err("NanoDrive8 playback queue overflow".into());
            }
        }
        if self.finished {
            return Ok(0);
        }
        self.pending -= 1;
        let mut input = self.input.borrow_mut();
        Ok(if input.running {
            input
                .samples
                .pop_front()
                .unwrap_or(input.decoder.signal as i16)
        } else {
            0
        })
    }

    pub fn next(&mut self, request_id: u16) -> Result<Chunk, String> {
        if self.ended {
            return Err("NanoDrive8 playback has ended".into());
        }
        let start = self.position;
        let mut pcm = Vec::with_capacity(160);
        while pcm.len() < 160 {
            let samples = if self.position < PREROLL {
                [0, 0]
            } else if self.finished {
                if self.tail == 0 {
                    self.ended = true;
                    break;
                }
                self.tail -= 1;
                [0, 0]
            } else {
                [self.sample()?, self.sample()?]
            };
            pcm.push(self.encoder.pair(samples));
            self.position = self
                .position
                .checked_add(1)
                .ok_or("NanoDrive8 byte position overflow")?;
        }
        if self.finished && self.tail == 0 {
            self.ended = true;
        }
        let mut bytes = Vec::with_capacity(4096);
        let mut count = 0;
        let mut append = |command: Command<'_>| -> Result<(), String> {
            let frame = command
                .encode(request_id.wrapping_add(count as u16))
                .map_err(|error| error.to_string())?;
            bytes.extend_from_slice(frame.as_bytes());
            count += 1;
            Ok(())
        };
        let mut events = self.events.borrow_mut();
        while events
            .front()
            .is_some_and(|(position, _)| *position < self.position || self.ended)
        {
            let (position, event) = events.pop_front().unwrap();
            let position = position.max(start);
            match event {
                Event::Pan(pan) => append(Command::AudioEvent {
                    position: BytePosition::new(position),
                    event: AudioEvent::Pan(pan),
                })?,
                Event::Fm(write) => {
                    let mut writes = vec![write];
                    while writes.len() < 125
                        && events.front().is_some_and(|(next, event)| {
                            *next == position && matches!(event, Event::Fm(_))
                        })
                    {
                        if let Some((_, Event::Fm(write))) = events.pop_front() {
                            writes.push(write);
                        }
                    }
                    append(Command::AudioEvent {
                        position: BytePosition::new(position),
                        event: AudioEvent::Ym2151(&writes),
                    })?;
                }
            }
        }
        if !pcm.is_empty() {
            append(Command::AudioData {
                position: BytePosition::new(start),
                adpcm: &pcm,
            })?;
        }
        if self.ended {
            let silence = self.encoder.clone().pair([0, 0]);
            append(Command::AudioEvent {
                position: BytePosition::new(self.position),
                event: AudioEvent::End(
                    ZeroPair::try_from(silence).map_err(|error| error.to_string())?,
                ),
            })?;
        }
        if bytes.len() > 65525 {
            return Err("NanoDrive8 playback chunk overflow".into());
        }
        Ok(Chunk {
            bytes,
            count,
            position: self.position,
            ended: self.ended,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn continuous_codec_matches_library_decoder_and_converges_to_zero() {
        let mut codec = Codec::default();
        let mut encoded = Vec::new();
        for sample in (0..128)
            .map(|index| ((index % 16) * 200 - 1500) as i16)
            .chain(std::iter::repeat_n(0, 800))
        {
            encoded.push(codec.encode(sample));
        }
        let bytes: Vec<_> = encoded
            .chunks_exact(2)
            .map(|pair| pair[0] | pair[1] << 4)
            .collect();
        let decoded = soundlog::mdx::pcm::decode_adpcm(&bytes);
        assert_eq!(i32::from(*decoded.last().unwrap()), codec.signal);
        assert_eq!(codec.index, 0);
        assert!(codec.signal.abs() <= 2);
        assert!(matches!(codec.pair([0, 0]), 0x80 | 0x08));
    }
    #[test]
    fn playback_produces_bounded_monotonic_fm_data_and_end_frames() {
        let mut playback = Playback::new("A t120 o4 l4 c", None, false).unwrap();
        let mut previous = 0;
        let mut finished = false;
        let mut event_position = 0;
        let mut adpcm = Vec::new();
        for _ in 0..500 {
            let chunk = playback.next(0).unwrap();
            assert!(chunk.position - previous <= 160);
            assert!(chunk.bytes.len() < 65525);
            assert!(chunk.count > 0);
            let frames: Vec<_> = chunk
                .bytes
                .split(|byte| *byte == 0)
                .filter(|body| !body.is_empty())
                .map(|body| ndsif::Frame::decode(body).unwrap())
                .collect();
            assert_eq!(frames.len(), chunk.count);
            let mut data_seen = false;
            for frame in frames {
                let payload = frame.payload();
                let position = u32::from_le_bytes(payload[..4].try_into().unwrap());
                match frame.opcode() {
                    0x58 => {
                        assert_eq!(position, adpcm.len() as u32);
                        assert!(payload.len() <= 164);
                        adpcm.extend_from_slice(&payload[4..]);
                        data_seen = true;
                    }
                    0x59 => {
                        assert!(position >= event_position);
                        event_position = position;
                        if payload[4] == 3 {
                            assert!(data_seen && chunk.ended);
                            assert_eq!(position, chunk.position);
                            assert!(matches!(payload[5], 0x80 | 0x08));
                        } else {
                            assert!(!data_seen);
                            assert!(position >= PREROLL && position < chunk.position);
                        }
                    }
                    _ => panic!("Unexpected streaming opcode"),
                }
            }
            previous = chunk.position;
            if chunk.ended {
                finished = true;
                break;
            }
        }
        assert!(finished);
        assert!(previous > PREROLL);
        let samples = soundlog::mdx::pcm::decode_adpcm(&adpcm);
        assert!(samples[..80].iter().all(|sample| sample.abs() <= 2));
        assert!(
            samples[samples.len() - 780..]
                .iter()
                .all(|sample| sample.abs() <= 2)
        );
        assert!(playback.next(0).is_err());
    }
    #[test]
    fn pdx_pcm_is_mixed_and_reencoded_in_the_continuous_stream() {
        let source = "#pcmfile \"drums\"\nP o1 c4";
        let error = Playback::new(source, None, false).err().unwrap();
        assert!(error.contains("PDX"), "{error}");
        let mut builder = soundlog::mdx::pdx::PdxBuilder::new();
        for note in 0..96 {
            builder.set_sample(0, note, vec![0x77; 4096]).unwrap();
        }
        let mut playback =
            Playback::new(source, Some(builder.finalize().to_bytes()), false).unwrap();
        let mut adpcm = Vec::new();
        for _ in 0..100 {
            let chunk = playback.next(0).unwrap();
            for body in chunk
                .bytes
                .split(|byte| *byte == 0)
                .filter(|body| !body.is_empty())
            {
                let frame = ndsif::Frame::decode(body).unwrap();
                if frame.opcode() == 0x58 {
                    adpcm.extend_from_slice(&frame.payload()[4..]);
                }
            }
            if chunk.ended {
                break;
            }
        }
        let decoded = soundlog::mdx::pcm::decode_adpcm(&adpcm);
        assert!(decoded.iter().any(|sample| sample.abs() > 64));
        assert!(decoded[..80].iter().all(|sample| sample.abs() <= 2));
        assert!(
            decoded[decoded.len() - 400..]
                .iter()
                .all(|sample| sample.abs() <= 2)
        );
    }
}
