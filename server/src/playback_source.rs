use mmlx::mdx::frontend::{self, MdxLocation};
use serde::Serialize;
use soundlog::chip::Ym2151Spec;
use soundlog::mdx::{
    command::{MdxCommand, MdxOpmRegisterWrite},
    convert::MdxToVgmOptions,
    package::MdxPackage,
};
use soundlog::vgm::{VgmCallbackStream, command::VgmCommand, stream::StreamResult};
use std::{cell::RefCell, rc::Rc};

#[derive(Clone, Debug, Serialize)]
pub struct SourceEvent {
    pub position: f64,
    pub channel: usize,
    pub start: Option<usize>,
    pub end: Option<usize>,
}

pub struct SourceTrace {
    stream: VgmCallbackStream<'static>,
    events: Rc<RefCell<Vec<SourceEvent>>>,
    sample: u64,
    finished: bool,
}

impl SourceTrace {
    pub fn new(source: &str, looped: bool) -> Result<Self, String> {
        let parsed = frontend::parse(source).map_err(|error| error.to_string())?;
        let compiled = frontend::compile(&parsed).map_err(|error| error.to_string())?;
        let mut mdx = compiled.document().clone();
        let old_map = mdx.sourcemap().map_err(|error| error.to_string())?;
        let mut locations = Vec::new();
        for (track, commands) in mdx.tracks.iter_mut().enumerate() {
            let original = std::mem::take(commands);
            let mut starts = Vec::new();
            let mut command_indices = Vec::new();
            let mut offset = 0;
            for (index, command) in original.iter().enumerate() {
                starts.push(offset);
                let span = compiled
                    .source_map()
                    .get(&MdxLocation::TrackCommand { track, index });
                let timed = matches!(command, MdxCommand::Note(_) | MdxCommand::Rest(_));
                let clear = matches!(
                    command,
                    MdxCommand::EndOfTrack(_) | MdxCommand::EndOfTrackLoop(_)
                );
                if (timed && span.is_some()) || clear {
                    let id = u16::try_from(locations.len() + 1)
                        .map_err(|_| "Too many playback source locations")?;
                    locations.push(SourceEvent {
                        position: 0.0,
                        channel: track,
                        start: if clear {
                            None
                        } else {
                            span.map(|span| span.start())
                        },
                        end: if clear {
                            None
                        } else {
                            span.map(|span| span.end())
                        },
                    });
                    for (register, value) in [(2, id as u8), (3, (id >> 8) as u8)] {
                        commands.push(MdxCommand::OpmRegisterWrite(MdxOpmRegisterWrite {
                            register,
                            value,
                        }));
                        offset += 3;
                    }
                }
                command_indices.push(commands.len());
                let mut command = command.clone();
                if let MdxCommand::OpmRegisterWrite(write) = &mut command
                    && matches!(write.register, 2 | 3)
                {
                    write.register = 0;
                }
                offset += command.to_mdx_bytes().ok_or("Invalid MDX command")?.len();
                commands.push(command);
            }
            starts.push(offset);
            for (index, original) in original.iter().enumerate() {
                let jump = match original {
                    MdxCommand::LoopEnd(jump)
                    | MdxCommand::LoopEscape(jump)
                    | MdxCommand::Jump(jump) => Some(jump),
                    MdxCommand::EndOfTrackLoop(jump) if jump.offset != 0 => Some(jump),
                    _ => None,
                };
                if let Some(jump) = jump {
                    let (old_start, length) = old_map[track][index];
                    let adjustment = if matches!(original, MdxCommand::LoopEscape(_)) {
                        2
                    } else {
                        0
                    };
                    let target = (old_start + length)
                        .checked_add_signed(isize::from(jump.offset) + adjustment)
                        .ok_or("Invalid playback loop target")?;
                    let target_index = old_map[track]
                        .iter()
                        .position(|(start, _)| *start == target)
                        .ok_or("Invalid playback loop boundary")?;
                    let command_index = command_indices[index];
                    let command_end = starts[index + 1];
                    let value = i16::try_from(
                        starts[target_index] as isize - command_end as isize - adjustment,
                    )
                    .map_err(|_| "Playback source loop is too large")?;
                    match &mut commands[command_index] {
                        MdxCommand::LoopEnd(jump)
                        | MdxCommand::LoopEscape(jump)
                        | MdxCommand::EndOfTrackLoop(jump)
                        | MdxCommand::Jump(jump) => jump.offset = value,
                        _ => unreachable!(),
                    }
                }
            }
        }
        let options = MdxToVgmOptions {
            loop_count: if looped { None } else { Some(1) },
            ..Default::default()
        };
        let mut stream =
            VgmCallbackStream::from_generator((MdxPackage { mdx, pdx: None }, options).into());
        let events = Rc::new(RefCell::new(Vec::new()));
        let observed = Rc::clone(&events);
        let mut low = None;
        stream.on_write(move |_, spec: Ym2151Spec, sample, _| {
            if spec.register == 2 {
                low = Some(spec.value);
            } else if spec.register == 3 {
                if let Some(low) = low.take() {
                    let id = u16::from(low) | (u16::from(spec.value) << 8);
                    if let Some(location) = id
                        .checked_sub(1)
                        .and_then(|id| locations.get(usize::from(id)))
                    {
                        let mut event = location.clone();
                        event.position = sample as f64 / 44100.0;
                        observed.borrow_mut().push(event);
                    }
                }
            } else {
                low = None;
            }
        });
        Ok(Self {
            stream,
            events,
            sample: 0,
            finished: false,
        })
    }

    pub fn position(&self) -> f64 {
        self.sample as f64 / 44100.0
    }

    pub fn next(&mut self, until: f64) -> Result<(Vec<SourceEvent>, bool), String> {
        if !until.is_finite() || until < 0.0 {
            return Err("Invalid playback source position".into());
        }
        let mut commands = 0;
        while !self.finished
            && self.sample as f64 / 44100.0 <= until
            && self.events.borrow().len() < 256
            && commands < 8192
        {
            commands += 1;
            match self
                .stream
                .next()
                .transpose()
                .map_err(|error| error.to_string())?
            {
                Some(StreamResult::Command(VgmCommand::WaitSamples(wait))) => {
                    self.sample += u64::from(wait.0)
                }
                None => self.finished = true,
                _ => {}
            }
        }
        Ok((
            std::mem::take(&mut *self.events.borrow_mut()),
            self.finished,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_repeats_and_escapes_keep_original_note_times() {
        for source in [
            "A t120 o4 [c8 [d16 e16]2]2 f4",
            "A t120 o4 [[c8 / d8]2 e8]2 f4",
            "A t120 o4 W c4\nP o1 [r8 SA]2",
        ] {
            let parsed = mmlx::mdx::parse(source).unwrap();
            let mdx = mmlx::mdx::compile(&parsed).unwrap();
            let mut original = VgmCallbackStream::from_generator(
                (
                    MdxPackage { mdx, pdx: None },
                    MdxToVgmOptions {
                        loop_count: Some(1),
                        ..Default::default()
                    },
                )
                    .into(),
            );
            let times = Rc::new(RefCell::new(Vec::new()));
            let observed = Rc::clone(&times);
            original.on_write(move |_, spec: Ym2151Spec, sample, _| {
                if spec.register == 8 && spec.value & 0x78 != 0 && spec.value & 7 == 0 {
                    observed.borrow_mut().push(sample as f64 / 44100.0);
                }
            });
            for result in original {
                result.unwrap();
            }
            let mut trace = SourceTrace::new(source, false).unwrap();
            let mut traced = Vec::new();
            for _ in 0..100 {
                let (events, done) = trace.next(10.0).unwrap();
                traced.extend(
                    events
                        .iter()
                        .filter(|event| {
                            event.channel == 0
                                && event.start.is_some_and(|start| {
                                    matches!(source.as_bytes()[start], b'a'..=b'g')
                                })
                        })
                        .map(|event| event.position),
                );
                if done {
                    break;
                }
            }
            assert_eq!(traced, *times.borrow(), "{source}");
        }
    }

    #[test]
    fn repeats_rests_pcm_and_unicode_keep_original_source_locations() {
        let source = "; 日本語\nA t120 o4 [c8 r8]2 d4\nP o1 r4 c4";
        let mut trace = SourceTrace::new(source, false).unwrap();
        let mut events = Vec::new();
        for _ in 0..100 {
            let (batch, done) = trace.next(10.0).unwrap();
            events.extend(batch);
            if done {
                break;
            }
        }
        let notes = events
            .iter()
            .filter(|event| event.channel == 0 && event.start.is_some())
            .collect::<Vec<_>>();
        assert_eq!(
            notes
                .iter()
                .map(|event| &source[event.start.unwrap()..event.end.unwrap()])
                .collect::<Vec<_>>(),
            ["c8", "r8", "c8", "r8", "d4"]
        );
        assert!(notes[2].position > notes[0].position);
        assert!(
            events
                .iter()
                .any(|event| event.channel == 8 && event.start.is_some())
        );
        assert!(
            events
                .iter()
                .any(|event| event.channel == 0 && event.start.is_none())
        );
    }
}
