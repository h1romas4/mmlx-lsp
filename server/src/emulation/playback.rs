use super::{
    audio::Audio,
    okim6258::{ClockDivider, Okim6258},
    ym2151::Ym2151,
};
use crate::audition::VoiceTestRegisters;
use crate::playback_events::{FmKeyEvent, fm_key_events};
use mmlx::mdx::frontend::{self, MdxLocation};
use soundlog::chip::{Okim6258Spec, Ym2151Spec, state::Ym2151State};
use soundlog::mdx::command::MdxCommand;
use soundlog::mdx::{
    convert::{AdpcmMode, MdxToVgmOptions},
    document::MdxDocument,
    package::MdxPackage,
};
use soundlog::vgm::{
    VgmCallbackStream,
    command::{Instance, VgmCommand},
    stream::StreamResult,
};
use std::{cell::RefCell, rc::Rc};

fn cursor_sample(source: &str, offset: usize, options: MdxToVgmOptions) -> Result<u64, String> {
    if !source.is_char_boundary(offset) {
        return Err("Invalid playback cursor position".into());
    }
    let parsed = frontend::parse(source).map_err(|error| error.to_string())?;
    let compiled = frontend::compile(&parsed).map_err(|error| error.to_string())?;
    let line_start = source[..offset].rfind('\n').map_or(0, |index| index + 1);
    let line_end = source[offset..]
        .find('\n')
        .map_or(source.len(), |index| offset + index);
    let source_map = compiled.source_map();
    let spans = compiled
        .document()
        .tracks
        .iter()
        .enumerate()
        .flat_map(|(track, commands)| {
            (0..commands.len())
                .filter(move |index| {
                    !matches!(
                        &commands[*index],
                        MdxCommand::LoopStart(_) | MdxCommand::LoopEnd(_)
                    )
                })
                .filter_map(move |index| {
                    source_map.get(&MdxLocation::TrackCommand { track, index })
                })
        });
    let span = spans
        .filter(|span| {
            (span.start() <= offset && offset < span.end())
                || (line_start <= span.start()
                    && span.start() <= line_end
                    && offset <= span.start())
        })
        .min_by_key(|span| {
            if span.start() <= offset && offset < span.end() {
                (0, span.end() - span.start())
            } else {
                (1, span.start() - offset)
            }
        })
        .ok_or("No playable command at the cursor position")?;
    let marker = (0..=u8::MAX).find(|value| {
        !compiled.document().tracks.iter().flatten().any(|command| {
            matches!(command, MdxCommand::OpmRegisterWrite(write) if write.register == 0 && write.value == *value)
        })
    }).ok_or("Could not allocate a playback cursor marker")?;
    let marked = format!(
        "{} y0,{marker} {}",
        &source[..span.start()],
        &source[span.start()..]
    );
    let parsed = mmlx::mdx::parse(&marked).map_err(|error| error.to_string())?;
    let mdx = mmlx::mdx::compile(&parsed).map_err(|error| error.to_string())?;
    let mut stream =
        VgmCallbackStream::from_generator((MdxPackage { mdx, pdx: None }, options).into());
    let position = Rc::new(RefCell::new(None));
    let observed = Rc::clone(&position);
    stream.on_write(move |_instance, spec: Ym2151Spec, sample, _events| {
        if spec.register == 0 && spec.value == marker {
            *observed.borrow_mut() = Some(sample);
        }
    });
    for result in stream {
        result.map_err(|error| error.to_string())?;
        if let Some(sample) = *position.borrow() {
            return Ok(sample as u64);
        }
    }
    Err("The cursor command was not reached during playback".into())
}

fn next_wait(
    stream: &mut VgmCallbackStream<'static>,
    native_rate: u32,
    pending: &mut usize,
    remainder: &mut u64,
    finished: &mut bool,
) -> Result<(), String> {
    while *pending == 0 && !*finished {
        match stream
            .next()
            .transpose()
            .map_err(|error| error.to_string())?
        {
            Some(StreamResult::Command(VgmCommand::WaitSamples(wait))) => {
                let duration = *remainder + u64::from(wait.0) * u64::from(native_rate);
                *pending = (duration / 44100) as usize;
                *remainder = duration % 44100;
            }
            None | Some(StreamResult::EndOfStream) => *finished = true,
            Some(StreamResult::NeedsMoreData) => return Err("Incomplete playback stream".into()),
            _ => {}
        }
    }
    Ok(())
}

struct Pcm {
    chip: Okim6258,
    clock: u32,
    divider: u32,
    pan: u8,
    phase: u64,
    sample: f32,
    initialized: bool,
}

impl Pcm {
    fn new() -> Self {
        let mut chip = Okim6258::default();
        chip.set_divider(ClockDivider::Div512);
        Self {
            chip,
            clock: 8_000_000,
            divider: 512,
            pan: 0,
            phase: 0,
            sample: 0.0,
            initialized: false,
        }
    }

    fn write(&mut self, spec: Okim6258Spec) {
        match spec.register {
            0 => {
                self.chip.write_control(spec.value);
                if self.chip.status() != 0 {
                    self.sample = 0.0;
                }
            }
            1 => self.chip.write_data(spec.value),
            2 => self.pan = spec.value & 3,
            8..=11 => {
                let shift = u32::from(spec.register - 8) * 8;
                self.clock = (self.clock & !(0xff << shift)) | (u32::from(spec.value) << shift);
                self.chip.set_clock(self.clock);
            }
            12 => {
                let (divider, value) = match spec.value & 3 {
                    0 => (ClockDivider::Div1024, 1024),
                    1 => (ClockDivider::Div768, 768),
                    _ => (ClockDivider::Div512, 512),
                };
                self.phase = self.phase * value / u64::from(self.divider);
                self.divider = value as u32;
                self.chip.set_divider(divider);
            }
            _ => {}
        }
    }

    fn mix(&mut self, stereo: &mut [Vec<f32>], native_rate: u32) {
        let period = u64::from(self.divider) * u64::from(native_rate);
        for index in 0..stereo[0].len() {
            while !self.initialized || self.phase >= period {
                let mut sample = [0.0];
                self.chip.render(&mut sample);
                self.sample = sample[0];
                if self.initialized {
                    self.phase -= period;
                }
                self.initialized = true;
            }
            if self.pan & 1 == 0 {
                stereo[0][index] += self.sample;
            }
            if self.pan & 2 == 0 {
                stereo[1][index] += self.sample;
            }
            self.phase += u64::from(self.clock);
        }
    }
}

pub struct Playback {
    audio: Audio,
    chip: Rc<RefCell<Ym2151>>,
    pcm: Rc<RefCell<Pcm>>,
    keys: Rc<RefCell<Vec<FmKeyEvent>>>,
    stream: VgmCallbackStream<'static>,
    native_rate: u32,
    pending: usize,
    remainder: u64,
    frames: u64,
    finished: bool,
}

impl Playback {
    pub fn new(source: &str, sample_rate: u32, looped: bool) -> Result<Self, String> {
        Self::with_cursor(source, sample_rate, looped, None)
    }

    pub fn with_cursor(
        source: &str,
        sample_rate: u32,
        looped: bool,
        cursor: Option<usize>,
    ) -> Result<Self, String> {
        Self::with_assets(
            source,
            sample_rate,
            looped,
            cursor,
            None,
            AdpcmMode::Resample,
        )
    }

    pub fn with_assets(
        source: &str,
        sample_rate: u32,
        looped: bool,
        cursor: Option<usize>,
        pdx: Option<Vec<u8>>,
        adpcm_mode: AdpcmMode,
    ) -> Result<Self, String> {
        let package = Self::package(source, pdx)?;
        if package.pdx.is_none()
            && let Some(name) = package.pdx_name()
            && package
                .mdx
                .tracks
                .iter()
                .skip(8)
                .flatten()
                .any(|command| matches!(command, MdxCommand::Note(_)))
        {
            return Err(format!("PDX file required: {name}"));
        }
        let options = MdxToVgmOptions {
            adpcm_mode,
            loop_count: if looped { None } else { Some(1) },
            ..MdxToVgmOptions::default()
        };
        let target = cursor
            .map(|offset| cursor_sample(source, offset, options))
            .transpose()?;
        Self::with_document(
            package,
            sample_rate,
            options,
            target,
            Rc::new(RefCell::new(Ym2151::default())),
            None,
        )
    }

    fn package(source: &str, pdx: Option<Vec<u8>>) -> Result<MdxPackage, String> {
        let parsed = mmlx::mdx::parse(source).map_err(|error| error.to_string())?;
        let mdx = mmlx::mdx::compile(&parsed).map_err(|error| error.to_string())?;
        let audio = mdx
            .tracks
            .iter()
            .skip(8)
            .flatten()
            .any(|command| matches!(command, MdxCommand::Note(_)));
        MdxPackage::parse_owned(
            mdx.to_bytes().map_err(|error| error.to_string())?,
            if audio { pdx } else { None },
        )
        .map_err(|error| error.to_string())
    }

    pub fn info(source: &str) -> Result<(bool, Option<String>), String> {
        let package = Self::package(source, None)?;
        let audio = package
            .mdx
            .tracks
            .iter()
            .skip(8)
            .flatten()
            .any(|command| matches!(command, MdxCommand::Note(_)));
        Ok((
            audio,
            if audio {
                package.pdx_name().map(ToOwned::to_owned)
            } else {
                None
            },
        ))
    }

    pub(super) fn voice_test(
        mdx: MdxDocument,
        sample_rate: u32,
        chip: Rc<RefCell<Ym2151>>,
        registers: Rc<RefCell<VoiceTestRegisters>>,
    ) -> Result<Self, String> {
        Self::with_document(
            MdxPackage { mdx, pdx: None },
            sample_rate,
            MdxToVgmOptions {
                loop_count: Some(1),
                ..Default::default()
            },
            None,
            chip,
            Some(registers),
        )
    }

    fn with_document(
        package: MdxPackage,
        sample_rate: u32,
        options: MdxToVgmOptions,
        target: Option<u64>,
        chip: Rc<RefCell<Ym2151>>,
        registers: Option<Rc<RefCell<VoiceTestRegisters>>>,
    ) -> Result<Self, String> {
        let mut stream = VgmCallbackStream::from_generator((package, options).into());
        stream.track_state::<Ym2151State>(Instance::Primary, options.ym2151_clock as f32);
        let keys = Rc::new(RefCell::new(Vec::new()));
        let key_events = Rc::clone(&keys);
        let native_rate = chip.borrow().sample_rate();
        let pcm = Rc::new(RefCell::new(Pcm::new()));
        let pcm_writes = Rc::clone(&pcm);
        stream.on_write(move |_instance, spec: Okim6258Spec, _sample, _events| {
            pcm_writes.borrow_mut().write(spec);
        });
        let writes = Rc::clone(&chip);
        stream.on_write(move |_instance, spec: Ym2151Spec, sample, events| {
            if let Some(registers) = &registers {
                registers
                    .borrow_mut()
                    .forward(spec.register, spec.value, |address, value| {
                        writes.borrow_mut().write(address, value)
                    });
            } else {
                writes.borrow_mut().write(spec.register, spec.value);
                key_events
                    .borrow_mut()
                    .extend(fm_key_events(sample, events));
            }
        });
        let mut playback = Self {
            audio: Audio::new(native_rate, sample_rate)?,
            chip,
            pcm,
            keys,
            stream,
            native_rate,
            pending: 0,
            remainder: 0,
            frames: 0,
            finished: false,
        };
        if let Some(sample) = target {
            playback.advance_to(sample)?;
        }
        Ok(playback)
    }

    fn advance_to(&mut self, sample: u64) -> Result<(), String> {
        let target = sample * u64::from(self.native_rate) / 44100;
        let mut notes = [None; 8];
        while self.frames < target && !self.finished {
            next_wait(
                &mut self.stream,
                self.native_rate,
                &mut self.pending,
                &mut self.remainder,
                &mut self.finished,
            )?;
            if self.finished {
                break;
            }
            let count = self.pending.min((target - self.frames).min(1024) as usize);
            let mut chunk = self.chip.borrow_mut().generate(count);
            self.pcm.borrow_mut().mix(&mut chunk, self.native_rate);
            self.pending -= count;
            self.frames += count as u64;
            for event in self.take_keys() {
                notes[usize::from(event.channel)] = event.note;
            }
        }
        if self.frames != target {
            return Err("The cursor position exceeds the playback duration".into());
        }
        let position = self.position();
        self.keys
            .borrow_mut()
            .extend(
                notes
                    .into_iter()
                    .enumerate()
                    .map(|(channel, note)| FmKeyEvent {
                        position,
                        channel: channel as u8,
                        note,
                    }),
            );
        Ok(())
    }

    pub fn take_keys(&mut self) -> Vec<FmKeyEvent> {
        std::mem::take(&mut *self.keys.borrow_mut())
    }

    pub fn position(&self) -> f64 {
        self.frames as f64 / self.native_rate as f64
    }

    pub fn finished(&self) -> bool {
        self.finished
    }

    pub fn render(&mut self) -> Result<Vec<u8>, String> {
        let Self {
            audio,
            chip,
            pcm,
            stream,
            native_rate,
            pending,
            remainder,
            frames,
            finished,
            ..
        } = self;
        audio.render_with(|count| {
            let mut stereo = vec![Vec::with_capacity(count), Vec::with_capacity(count)];
            while stereo[0].len() < count {
                next_wait(stream, *native_rate, pending, remainder, finished)?;
                if *finished {
                    for channel in &mut stereo {
                        channel.resize(count, 0.0);
                    }
                    break;
                }
                let chunk_frames = (*pending).min(count - stereo[0].len());
                let mut chunk = chip.borrow_mut().generate(chunk_frames);
                pcm.borrow_mut().mix(&mut chunk, *native_rate);
                for (channel, samples) in stereo.iter_mut().zip(chunk) {
                    channel.extend(samples);
                }
                *pending -= chunk_frames;
                *frames += chunk_frames as u64;
            }
            Ok(stereo)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub const SOURCE: &str = "@1 = {\n31,0,0,15,0,32,0,1,0,0,0,\n31,0,0,15,0,32,0,1,0,0,0,\n31,0,0,15,0,32,0,1,0,0,0,\n31,0,0,15,0,32,0,1,0,0,0,\n7,0,15\n}\nA t120 @1 o4 l8 cdef\n";

    #[test]
    fn playback_emits_timed_fm_keys() {
        let mut playback = Playback::new(SOURCE, 48000, false).unwrap();
        let mut keys = Vec::new();
        while !playback.finished() {
            playback.render().unwrap();
            keys.extend(playback.take_keys());
        }
        assert_eq!(
            keys.iter()
                .filter_map(|event| event.note)
                .collect::<Vec<_>>(),
            vec![60, 62, 64, 65]
        );
        assert!(keys.iter().any(|event| event.note.is_none()));
        assert!(keys.iter().all(|event| event.channel == 0));
        assert!(
            keys.windows(2)
                .all(|pair| pair[0].position <= pair[1].position)
        );
        assert!(playback.take_keys().is_empty());
    }

    #[test]
    fn pcm_mix_obeys_clock_divider_pan_and_stop() {
        for (pan, left, right) in [
            (0, true, true),
            (1, false, true),
            (2, true, false),
            (3, false, false),
        ] {
            let mut pcm = Pcm::new();
            for (register, value) in [(0, 2), (1, 0x21), (2, pan)] {
                pcm.write(Okim6258Spec { register, value });
            }
            let mut stereo = vec![vec![0.0; 8], vec![0.0; 8]];
            pcm.mix(&mut stereo, 62500);
            assert_eq!(stereo[0][0], if left { 64.0 / 32768.0 } else { 0.0 });
            assert_eq!(stereo[1][4], if right { 224.0 / 32768.0 } else { 0.0 });
            assert_eq!(stereo[0][3], if left { 64.0 / 32768.0 } else { 0.0 });
            assert_eq!(stereo[1][3], if right { 64.0 / 32768.0 } else { 0.0 });
            assert_eq!(stereo[0][7], if left { 224.0 / 32768.0 } else { 0.0 });
            pcm.write(Okim6258Spec {
                register: 0,
                value: 1,
            });
            let mut stopped = vec![vec![0.0; 1], vec![0.0; 1]];
            pcm.mix(&mut stopped, 62500);
            assert_eq!(stopped, vec![vec![0.0], vec![0.0]]);
        }
        let mut pcm = Pcm::new();
        pcm.write(Okim6258Spec {
            register: 12,
            value: 0,
        });
        for (register, value) in (8..=11).zip(4_000_000_u32.to_le_bytes()) {
            pcm.write(Okim6258Spec { register, value });
        }
        pcm.write(Okim6258Spec {
            register: 0,
            value: 2,
        });
        pcm.write(Okim6258Spec {
            register: 1,
            value: 0x21,
        });
        let mut stereo = vec![vec![0.0; 17], vec![0.0; 17]];
        pcm.mix(&mut stereo, 62500);
        assert!(
            stereo[0][..16]
                .iter()
                .all(|sample| *sample == 64.0 / 32768.0)
        );
        assert_eq!(stereo[0][16], 224.0 / 32768.0);
    }

    #[test]
    fn pdx_playback_produces_pcm_and_applies_mml_pan() {
        let mut builder = soundlog::mdx::pdx::PdxBuilder::new();
        builder.set_sample(0, 9, vec![0x7f; 4096]).unwrap();
        let pdx = builder.finalize().to_bytes();
        for (pan, left, right) in [
            (1, false, true),
            (2, true, false),
            (3, true, true),
            (0, false, false),
        ] {
            let source = format!("#pcmfile \"drums\"\nP p{pan} F2 o1 c4");
            assert_eq!(
                Playback::info(&source).unwrap(),
                (true, Some("drums".into()))
            );
            let mut playback = Playback::with_assets(
                &source,
                48000,
                false,
                None,
                Some(pdx.clone()),
                AdpcmMode::Through,
            )
            .unwrap();
            let mut energy = [0.0_f32; 2];
            for _ in 0..100 {
                let bytes = playback.render().unwrap();
                for frame in bytes.chunks_exact(8) {
                    energy[0] += f32::from_le_bytes(frame[..4].try_into().unwrap()).abs();
                    energy[1] += f32::from_le_bytes(frame[4..].try_into().unwrap()).abs();
                }
                if playback.finished() {
                    break;
                }
            }
            assert!(playback.finished());
            assert_eq!(energy[0] > 1.0, left, "pan={pan}: {energy:?}");
            assert_eq!(energy[1] > 1.0, right, "pan={pan}: {energy:?}");
        }
        let mut fm = Playback::new(SOURCE, 48000, false).unwrap();
        let mut mixed = Playback::with_assets(
            &format!("{SOURCE}P F2 o1 c4"),
            48000,
            false,
            None,
            Some(pdx.clone()),
            AdpcmMode::Resample,
        )
        .unwrap();
        assert_ne!(fm.render().unwrap(), mixed.render().unwrap());
        let mut looped = Playback::with_assets(
            "P t120 F2 o1 l32 L c",
            48000,
            true,
            None,
            Some(pdx),
            AdpcmMode::Resample,
        )
        .unwrap();
        for _ in 0..80 {
            looped.render().unwrap();
        }
        assert!(!looped.finished());
        assert!(looped.position() > 0.5);
    }

    #[test]
    fn pcm_cursor_and_processing_modes_preserve_playback_state() {
        let mut builder = soundlog::mdx::pdx::PdxBuilder::new();
        builder.set_sample(0, 9, vec![0x7f; 8192]).unwrap();
        builder.set_sample(0, 11, vec![0x7f; 8192]).unwrap();
        let pdx = builder.finalize().to_bytes();
        let source = "P t120 F2 o1 l8 c d";
        let cursor = source.rfind('d').unwrap();
        let options = MdxToVgmOptions {
            adpcm_mode: AdpcmMode::Through,
            loop_count: Some(1),
            ..Default::default()
        };
        let target = cursor_sample(source, cursor, options).unwrap();
        let mut reference = Playback::with_assets(
            source,
            48000,
            false,
            None,
            Some(pdx.clone()),
            AdpcmMode::Through,
        )
        .unwrap();
        reference.advance_to(target).unwrap();
        let mut playback = Playback::with_assets(
            source,
            48000,
            false,
            Some(cursor),
            Some(pdx.clone()),
            AdpcmMode::Through,
        )
        .unwrap();
        assert!((0.24..0.26).contains(&playback.position()));
        assert_eq!(playback.render().unwrap(), reference.render().unwrap());
        let mut outputs = Vec::new();
        for mode in [AdpcmMode::Through, AdpcmMode::Resample, AdpcmMode::Lpf] {
            let mut playback =
                Playback::with_assets("P F2 o1 c4", 48000, false, None, Some(pdx.clone()), mode)
                    .unwrap();
            let mut output = Vec::new();
            for _ in 0..16 {
                output.extend(playback.render().unwrap());
            }
            assert!(output.iter().any(|byte| *byte != 0));
            outputs.push(output);
        }
        assert!(outputs[0] != outputs[2], "Through and LPF must differ");
        assert!(outputs[1] != outputs[2], "Resample and LPF must differ");
    }

    #[test]
    fn cursor_marker_reports_the_command_time() {
        let source = SOURCE.replace("cdef", "cd y0,255 ef");
        let parsed = mmlx::mdx::parse(&source).unwrap();
        let mdx = mmlx::mdx::compile(&parsed).unwrap();
        let options = MdxToVgmOptions {
            loop_count: Some(1),
            ..Default::default()
        };
        let mut stream =
            VgmCallbackStream::from_generator((MdxPackage { mdx, pdx: None }, options).into());
        let position = Rc::new(RefCell::new(None));
        let observed = Rc::clone(&position);
        stream.on_write(move |_instance, spec: Ym2151Spec, sample, _events| {
            if spec.register == 0 && spec.value == 255 {
                *observed.borrow_mut() = Some(sample);
            }
        });
        for result in stream {
            result.unwrap();
        }
        let seconds = position.borrow().unwrap() as f64 / 44100.0;
        assert!((0.49..0.51).contains(&seconds), "{seconds}");
    }

    #[test]
    fn starts_at_cursor_with_the_other_tracks_already_running() {
        let source = format!("{SOURCE}B t120 @1 o4 l1 g\n");
        let cursor = source.find("cdef").unwrap() + 2;
        let target = cursor_sample(
            &source,
            cursor,
            MdxToVgmOptions {
                loop_count: Some(1),
                ..Default::default()
            },
        )
        .unwrap();
        for sample_rate in [44100, 48000] {
            let mut playback =
                Playback::with_cursor(&source, sample_rate, false, Some(cursor)).unwrap();
            let mut reference = Playback::new(&source, sample_rate, false).unwrap();
            reference.advance_to(target).unwrap();
            assert!((0.49..0.51).contains(&playback.position()));
            let pcm = playback.render().unwrap();
            assert_eq!(pcm, reference.render().unwrap());
            assert!(pcm.iter().any(|byte| *byte != 0));
        }
    }

    #[test]
    fn cursor_follows_repeats_and_rejects_non_command_positions() {
        let source = SOURCE.replace("cdef", "[cd]2 ef");
        let cursor = source.find("ef").unwrap();
        let playback = Playback::with_cursor(&source, 48000, false, Some(cursor)).unwrap();
        let parsed = mmlx::mdx::parse(&source).unwrap();
        let mdx = mmlx::mdx::compile(&parsed).unwrap();
        let options = MdxToVgmOptions {
            loop_count: Some(1),
            ..Default::default()
        };
        let mut stream =
            VgmCallbackStream::from_generator((MdxPackage { mdx, pdx: None }, options).into());
        let key_ons = Rc::new(RefCell::new(Vec::new()));
        let observed = Rc::clone(&key_ons);
        stream.on_write(move |_instance, spec: Ym2151Spec, sample, _events| {
            if spec.register == 0x08 && spec.value & 0x78 != 0 && spec.value & 7 == 0 {
                observed.borrow_mut().push(sample);
            }
        });
        for result in stream {
            result.unwrap();
        }
        assert_eq!(
            playback.frames,
            key_ons.borrow()[4] as u64 * u64::from(playback.native_rate) / 44100
        );
        let repeated =
            Playback::with_cursor(&source, 48000, true, Some(source.find("cd").unwrap() + 1))
                .unwrap();
        assert!((0.24..0.26).contains(&repeated.position()));
        let spaced = SOURCE.replace("cdef", "[c d]2 ef");
        let whitespace = spaced.find(" d").unwrap();
        let from_whitespace =
            Playback::with_cursor(&spaced, 48000, false, Some(whitespace)).unwrap();
        assert!((0.24..0.26).contains(&from_whitespace.position()));
        assert!(Playback::with_cursor(SOURCE, 48000, false, Some(0)).is_err());
        assert!(Playback::with_cursor(SOURCE, 48000, false, Some(SOURCE.len() + 1)).is_err());
        let unicode = format!("; 日本語\n{SOURCE}");
        assert!(Playback::with_cursor(&unicode, 48000, false, Some(3)).is_err());
        assert!(
            Playback::with_cursor(&unicode, 48000, false, Some(unicode.find("cdef").unwrap()))
                .is_ok()
        );
    }

    #[test]
    fn streams_mml_through_mdx_and_ym2151_callbacks() {
        for sample_rate in [44100, 48000] {
            let mut playback = Playback::new(SOURCE, sample_rate, false).unwrap();
            let mut energy = 0.0_f32;
            for _ in 0..200 {
                let pcm = playback.render().unwrap();
                assert_eq!(pcm.len(), 4096);
                for sample in pcm.chunks_exact(4) {
                    let value = f32::from_le_bytes(sample.try_into().unwrap());
                    assert!(value.is_finite() && (-1.0..=1.0).contains(&value));
                    energy += value.abs();
                }
                if playback.finished() {
                    break;
                }
            }
            assert!(playback.finished());
            assert!(energy > 1.0);
            assert!((0.9..1.1).contains(&playback.position()));
            assert_eq!(playback.render().unwrap(), vec![0; 4096]);
        }
    }

    #[test]
    fn example_keeps_operator_levels_at_each_key_on() {
        let source = include_str!("../../../assets/webview/example.mml");
        let parsed = mmlx::mdx::parse(source).unwrap();
        let mdx = mmlx::mdx::compile(&parsed).unwrap();
        let options = MdxToVgmOptions {
            loop_count: Some(1),
            ..Default::default()
        };
        let mut stream =
            VgmCallbackStream::from_generator((MdxPackage { mdx, pdx: None }, options).into());
        let key_ons = Rc::new(RefCell::new(Vec::new()));
        let observed = Rc::clone(&key_ons);
        let mut levels = [0; 4];
        stream.on_write(move |_instance, spec: Ym2151Spec, sample, _events| {
            if (0x60..0x80).contains(&spec.register) && spec.register & 7 == 0 {
                levels[usize::from((spec.register - 0x60) / 8)] = spec.value;
            }
            if spec.register == 0x08 && spec.value & 0x78 != 0 {
                observed.borrow_mut().push((sample, levels));
            }
        });
        for result in stream {
            result.unwrap();
        }
        let keys = key_ons.borrow();
        assert_eq!(keys.len(), 8);
        assert!(
            keys.iter().all(|(_, levels)| *levels == keys[0].1),
            "{keys:?}"
        );
    }

    #[test]
    fn repeated_example_notes_retrigger_the_envelope() {
        let source =
            include_str!("../../../assets/webview/example.mml").replace("cdefgab>c4", "cccccccc");
        let mut playback = Playback::new(&source, 48000, false).unwrap();
        let mut samples = Vec::new();
        for _ in 0..200 {
            let pcm = playback.render().unwrap();
            samples.extend(
                pcm.chunks_exact(4)
                    .map(|sample| f32::from_le_bytes(sample.try_into().unwrap())),
            );
        }
        let levels: Vec<f32> = (0..8)
            .map(|note| {
                let start = (note * 12000 + 1920) * 2;
                let end = (note * 12000 + 5760) * 2;
                samples[start..end]
                    .iter()
                    .map(|sample| sample.abs())
                    .sum::<f32>()
                    / (end - start) as f32
            })
            .collect();
        assert!(
            levels[7] > levels[0] * 0.5,
            "Repeated note levels: {levels:?}"
        );
    }

    #[test]
    fn follows_mml_loop_points_only_when_enabled() {
        let source = SOURCE.replace("l8 cdef", "l64 L cdef");
        let mut finite = Playback::new(&source, 48000, false).unwrap();
        let mut looped = Playback::new(&source, 48000, true).unwrap();
        for _ in 0..80 {
            finite.render().unwrap();
            looped.render().unwrap();
        }
        assert!(finite.finished());
        assert!(!looped.finished());
        assert!(looped.position() > 0.5);
    }

    #[test]
    fn leaves_pcm_silent_and_reports_invalid_mml() {
        let mut playback = Playback::new(&format!("{SOURCE}P t120 o1 c4\n"), 48000, false).unwrap();
        assert!(playback.render().is_ok());
        assert!(Playback::new("A [c4", 48000, false).is_err());
        assert!(Playback::new(SOURCE, 0, false).is_err());
        let mut missing_voice = Playback::new("A @99 c4", 48000, false).unwrap();
        assert!(missing_voice.render().is_err());
    }

    #[test]
    fn preserves_pcm_repeats_and_synchronization_with_fm() {
        let source = SOURCE.replace(
            "A t120 @1 o4 l8 cdef",
            "A t120 @1 o4 l8 W cdef\nP t120 o1 l8 [[c]2]2 SA",
        );
        let mut playback = Playback::new(&source, 48000, false).unwrap();
        let mut energy = 0.0_f32;
        for _ in 0..250 {
            let pcm = playback.render().unwrap();
            energy += pcm
                .chunks_exact(4)
                .map(|sample| f32::from_le_bytes(sample.try_into().unwrap()).abs())
                .sum::<f32>();
            if playback.finished() {
                break;
            }
        }
        assert!(playback.finished());
        assert!(energy > 1.0);
        assert!((1.9..2.1).contains(&playback.position()));
    }
}
