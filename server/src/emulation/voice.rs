use serde::Deserialize;

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Voice {
    pub algorithm: u8,
    pub feedback: u8,
    pub operator_mask: u8,
    pub operators: [Operator; 4],
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Operator {
    pub ar: u8,
    pub d1r: u8,
    pub d2r: u8,
    pub rr: u8,
    pub d1l: u8,
    pub tl: u8,
    pub ks: u8,
    pub mul: u8,
    pub dt1: u8,
    pub dt2: u8,
    pub ame: u8,
}

impl Voice {
    pub fn test_document(&self, mml: &str) -> Result<soundlog::mdx::document::MdxDocument, String> {
        self.test_document_with_tempo(mml, None, false)
    }

    pub fn test_document_with_tempo(
        &self,
        mml: &str,
        inherited_tempo: Option<&str>,
        ignore_voice_select: bool,
    ) -> Result<soundlog::mdx::document::MdxDocument, String> {
        self.test_document_with_state(
            mml,
            inherited_tempo,
            None,
            None,
            None,
            None,
            None,
            ignore_voice_select,
        )
    }

    pub fn test_document_with_state(
        &self,
        mml: &str,
        inherited_tempo: Option<&str>,
        inherited_length: Option<&str>,
        inherited_octave: Option<u8>,
        inherited_volume: Option<&[String]>,
        inherited_gate: Option<&str>,
        inherited_pan: Option<&str>,
        ignore_voice_select: bool,
    ) -> Result<soundlog::mdx::document::MdxDocument, String> {
        use mmlx::mdx::{MmlCommand, MmlTrack};
        fn settings(
            commands: &[MmlCommand],
            channel: u8,
            keep_notes: bool,
            ignore_voice_select: bool,
        ) -> Vec<MmlCommand> {
            let mut first_command = true;
            commands
                .iter()
                .filter_map(|command| {
                    let is_first = std::mem::replace(&mut first_command, false);
                    Some(match command {
                        MmlCommand::VoiceSelect(0) if ignore_voice_select && is_first => {
                            command.clone()
                        }
                        MmlCommand::VoiceSelect(_) if ignore_voice_select => return None,
                        MmlCommand::Note { length, .. } if !keep_notes => {
                            MmlCommand::Rest { length: *length }
                        }
                        MmlCommand::ExtendedNote { length, .. } if !keep_notes => {
                            MmlCommand::ExtendedRest(length.clone())
                        }
                        MmlCommand::NumericNote { length, .. } if !keep_notes => match length {
                            Some(length) => MmlCommand::ExtendedRest(length.clone()),
                            None => MmlCommand::Rest { length: None },
                        },
                        MmlCommand::Repeat { body, count } => MmlCommand::Repeat {
                            body: settings(body, channel, keep_notes, ignore_voice_select),
                            count: *count,
                        },
                        MmlCommand::RegisterWrite { register, value } if *register >= 0x20 => {
                            MmlCommand::RegisterWrite {
                                register: (register & !7) | channel,
                                value: *value,
                            }
                        }
                        MmlCommand::RegisterWrite { .. } if !keep_notes => return None,
                        MmlCommand::Portamento | MmlCommand::Legato if !keep_notes => return None,
                        _ => command.clone(),
                    })
                })
                .collect()
        }
        fn has_tempo(commands: &[MmlCommand]) -> bool {
            commands.iter().any(|command| match command {
                MmlCommand::Tempo(_) | MmlCommand::OpmTempo(_) => true,
                MmlCommand::Repeat { body, .. } => has_tempo(body),
                _ => false,
            })
        }
        fn has_default_length(commands: &[MmlCommand]) -> bool {
            commands.iter().any(|command| match command {
                MmlCommand::DefaultLength(_) | MmlCommand::DefaultLengthReset => true,
                MmlCommand::Repeat { body, .. } => has_default_length(body),
                _ => false,
            })
        }
        fn has_absolute_octave(commands: &[MmlCommand]) -> bool {
            commands.iter().any(|command| match command {
                MmlCommand::Octave(_) => true,
                MmlCommand::Repeat { body, .. } => has_absolute_octave(body),
                _ => false,
            })
        }
        fn parse_tempo(value: &str) -> Result<MmlCommand, String> {
            if let Some(value) = value.strip_prefix("@t") {
                let value = value
                    .parse::<u8>()
                    .map_err(|error| format!("Invalid inherited tempo: {error}"))?;
                return Ok(MmlCommand::OpmTempo(value));
            }
            if let Some(value) = value.strip_prefix('t') {
                let value = value
                    .parse::<u32>()
                    .map_err(|error| format!("Invalid inherited tempo: {error}"))?;
                if value == 0 {
                    return Err("Invalid inherited tempo: t must be greater than zero".into());
                }
                return Ok(MmlCommand::Tempo(value));
            }
            Err("Invalid inherited tempo".into())
        }
        fn parse_default_length(value: &str) -> Result<MmlCommand, String> {
            let parsed = mmlx::mdx::parse(&format!("A {value}"))
                .map_err(|error| format!("Invalid inherited default length: {error}"))?;
            match parsed
                .tracks
                .first()
                .and_then(|track| track.commands.as_slice().first())
            {
                Some(command @ (MmlCommand::DefaultLength(_) | MmlCommand::DefaultLengthReset))
                    if parsed.tracks[0].commands.len() == 1 =>
                {
                    Ok(command.clone())
                }
                _ => Err("Invalid inherited default length".into()),
            }
        }
        fn parse_volume(value: &[String]) -> Result<Vec<MmlCommand>, String> {
            value
                .iter()
                .map(|value| {
                    let parsed = mmlx::mdx::parse(&format!("A {value}"))
                        .map_err(|error| format!("Invalid inherited volume: {error}"))?;
                    match parsed
                        .tracks
                        .first()
                        .and_then(|track| track.commands.first())
                    {
                        Some(
                            command @ (MmlCommand::Volume(_)
                            | MmlCommand::FineVolume(_)
                            | MmlCommand::VolumeDown
                            | MmlCommand::VolumeUp),
                        ) if parsed.tracks[0].commands.len() == 1 => Ok(command.clone()),
                        _ => Err("Invalid inherited volume".into()),
                    }
                })
                .collect()
        }
        fn parse_single_state_command(value: &str) -> Result<MmlCommand, String> {
            let parsed = mmlx::mdx::parse(&format!("A {value}"))
                .map_err(|error| format!("Invalid inherited MML state: {error}"))?;
            match parsed
                .tracks
                .first()
                .and_then(|track| track.commands.first())
            {
                Some(command) if parsed.tracks[0].commands.len() == 1 => Ok(command.clone()),
                _ => Err("Invalid inherited MML state".into()),
            }
        }
        let source = self.test_source(mml)?;
        let mut parsed = mmlx::mdx::parse(&source).map_err(|error| error.to_string())?;
        let inherited_tempo = if inherited_tempo.is_some()
            && !parsed.tracks.iter().any(|track| has_tempo(&track.commands))
        {
            inherited_tempo.map(parse_tempo).transpose()?
        } else {
            None
        };
        let inherited_length = if inherited_length.is_some()
            && !parsed
                .tracks
                .iter()
                .any(|track| has_default_length(&track.commands))
        {
            inherited_length.map(parse_default_length).transpose()?
        } else {
            None
        };
        let inherited_octave = if inherited_octave.is_some()
            && !parsed
                .tracks
                .iter()
                .any(|track| has_absolute_octave(&track.commands))
        {
            inherited_octave.map(MmlCommand::Octave)
        } else {
            None
        };
        let inherited_volume = inherited_volume.map(parse_volume).transpose()?;
        let inherited_gate = inherited_gate
            .map(parse_single_state_command)
            .transpose()?
            .map(|command| -> Result<MmlCommand, String> {
                match command {
                    command @ (MmlCommand::Gate(_) | MmlCommand::FineGate(_)) => Ok(command),
                    _ => Err("Invalid inherited gate".into()),
                }
            })
            .transpose()?;
        let inherited_pan = inherited_pan
            .map(parse_single_state_command)
            .transpose()?
            .map(|command| -> Result<MmlCommand, String> {
                match command {
                    command @ MmlCommand::Pan(_) => Ok(command),
                    _ => Err("Invalid inherited pan".into()),
                }
            })
            .transpose()?;
        if inherited_tempo.is_some()
            || inherited_length.is_some()
            || inherited_octave.is_some()
            || inherited_volume.is_some()
            || inherited_gate.is_some()
            || inherited_pan.is_some()
        {
            for track in &mut parsed.tracks {
                if ('A'..='H').contains(&track.channel) {
                    let index = usize::from(matches!(
                        track.commands.first(),
                        Some(MmlCommand::VoiceSelect(0))
                    ));
                    let mut index = index;
                    for command in [
                        inherited_tempo.clone(),
                        inherited_length.clone(),
                        inherited_octave.clone(),
                    ]
                    .into_iter()
                    .flatten()
                    {
                        track.commands.insert(index, command);
                        index += 1;
                    }
                    if let Some(commands) = &inherited_volume {
                        for command in commands {
                            track.commands.insert(index, command.clone());
                            index += 1;
                        }
                    }
                    for command in [inherited_gate.clone(), inherited_pan.clone()]
                        .into_iter()
                        .flatten()
                    {
                        track.commands.insert(index, command);
                        index += 1;
                    }
                }
            }
        }
        let commands = parsed
            .tracks
            .iter()
            .find(|track| ('A'..='H').contains(&track.channel))
            .map(|track| track.commands.clone())
            .ok_or_else(|| "Voice test requires an FM channel (A-H)".to_string())?;
        let mut channels = [false; 8];
        for track in &mut parsed.tracks {
            if ('A'..='H').contains(&track.channel) {
                let channel = track.channel as u8 - b'A';
                track.commands = settings(&track.commands, channel, true, ignore_voice_select);
                channels[channel as usize] = true;
            }
        }
        for (channel, present) in channels.into_iter().enumerate() {
            if !present {
                parsed.tracks.push(MmlTrack {
                    channel: char::from(b'A' + channel as u8),
                    commands: settings(&commands, channel as u8, false, ignore_voice_select),
                });
            }
        }
        mmlx::mdx::compile(&parsed).map_err(|error| error.to_string())
    }

    pub fn test_source(&self, mml: &str) -> Result<String, String> {
        if !self.validate() || mml.trim().is_empty() || mml.len() > 8192 {
            return Err("Invalid voice test".into());
        }
        let channel_line = |line: &str| {
            let line = line.trim_start();
            line.chars()
                .next()
                .is_some_and(|channel| ('A'..='H').contains(&channel))
                && line[1..].chars().next().is_none_or(char::is_whitespace)
        };
        let lines = mml.lines().collect::<Vec<_>>();
        let explicit_channels = lines.iter().any(|line| channel_line(line));
        if lines.iter().any(|line| line.contains('\r'))
            || (explicit_channels
                && lines
                    .iter()
                    .any(|line| !line.trim().is_empty() && !channel_line(line)))
            || (!explicit_channels && lines.len() > 1)
        {
            return Err("Invalid voice test".into());
        }
        let operators = self
            .operators
            .iter()
            .map(|operator| {
                format!(
                    "{},{},{},{},{},{},{},{},{},{},{},",
                    operator.ar,
                    operator.d1r,
                    operator.d2r,
                    operator.rr,
                    operator.d1l,
                    operator.tl,
                    operator.ks,
                    operator.mul,
                    operator.dt1,
                    operator.dt2,
                    operator.ame
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let voice = format!(
            "@0 = {{\n{operators}\n{},{},{}\n}}\n",
            self.algorithm, self.feedback, self.operator_mask
        );
        let body = if explicit_channels {
            mml.lines()
                .map(|line| {
                    let indent = line.len() - line.trim_start().len();
                    let trimmed = &line[indent..];
                    let Some(channel) = trimmed.chars().next() else {
                        return line.to_string();
                    };
                    if channel_line(line) {
                        format!("{}{} @0{}", &line[..indent], channel, &trimmed[1..])
                    } else {
                        line.to_string()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            format!("A @0 {mml}")
        };
        Ok(format!("{voice}{body}"))
    }

    pub fn validate(&self) -> bool {
        self.algorithm <= 7
            && self.feedback <= 7
            && self.operator_mask <= 15
            && self.operators.iter().all(|operator| {
                operator.ar <= 31
                    && operator.d1r <= 31
                    && operator.d2r <= 31
                    && operator.rr <= 15
                    && operator.d1l <= 15
                    && operator.tl <= 127
                    && operator.ks <= 3
                    && operator.mul <= 15
                    && operator.dt1 <= 7
                    && operator.dt2 <= 3
                    && operator.ame <= 1
            })
    }

    pub fn registers(&self, channel: u8, attenuation: u8) -> Vec<(u8, u8)> {
        let carriers = [8_u8, 8, 8, 8, 12, 14, 14, 15][self.algorithm as usize];
        let mut registers = vec![
            (0x20 + channel, 0xc0 | (self.feedback << 3) | self.algorithm),
            (0x38 + channel, 0),
        ];
        for (index, operator) in self.operators.iter().enumerate() {
            let physical = [0_u8, 2, 1, 3][index];
            let slot = physical * 8 + channel;
            let tl = if carriers & (1 << physical) != 0 {
                operator.tl.saturating_add(attenuation).min(127)
            } else {
                operator.tl
            };
            registers.extend([
                (0x40 + slot, (operator.dt1 << 4) | operator.mul),
                (0x60 + slot, tl),
                (0x80 + slot, (operator.ks << 6) | operator.ar),
                (0xa0 + slot, (operator.ame << 7) | operator.d1r),
                (0xc0 + slot, (operator.dt2 << 6) | operator.d2r),
                (0xe0 + slot, (operator.d1l << 4) | operator.rr),
            ]);
        }
        registers
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_test_compiles_only_part_a_with_current_voice_and_lfo_writes() {
        let voice = Voice {
            algorithm: 7,
            feedback: 3,
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
                ame: 1,
            }),
        };
        let source = voice.test_source("t120 y24,128 y25,64 o4 c8").unwrap();
        let parsed = mmlx::mdx::parse(&source).unwrap();
        let document = mmlx::mdx::compile(&parsed).unwrap();
        use soundlog::mdx::command::MdxCommand;
        assert!(
            document.tracks[0]
                .iter()
                .any(|command| matches!(command, MdxCommand::Note(_)))
        );
        assert!(
            document
                .tracks
                .iter()
                .skip(1)
                .flatten()
                .all(|command| !matches!(command, MdxCommand::Note(_)))
        );
        assert!(document.tracks[0].iter().any(|command| matches!(command, MdxCommand::OpmRegisterWrite(write) if write.register == 24 && write.value == 128)));
        for invalid in ["", "\rP c4", "c4\ne4", &"c".repeat(8193)] {
            assert!(voice.test_source(invalid).is_err());
        }
        let selected = voice.test_document("A c4\nB e4\nC g4").unwrap();
        let note_tracks = selected
            .tracks
            .iter()
            .enumerate()
            .filter_map(|(channel, track)| {
                track
                    .iter()
                    .any(|command| matches!(command, MdxCommand::Note(_)))
                    .then_some(channel)
            })
            .collect::<Vec<_>>();
        assert_eq!(note_tracks, [0, 1, 2]);
        let document = voice
            .test_document("MH0,200,64,0,5,0,1 p1 [c8 / n60,16.]2 c%24")
            .unwrap();
        for track in document.tracks.iter().take(8).skip(1) {
            assert!(
                track
                    .iter()
                    .all(|command| !matches!(command, MdxCommand::Note(_)))
            );
            assert!(
                track
                    .iter()
                    .any(|command| matches!(command, MdxCommand::OpmLfo(_)))
            );
            assert!(
                track
                    .iter()
                    .any(|command| matches!(command, MdxCommand::Rest(_)))
            );
        }
    }

    #[test]
    fn selection_voice_numbers_are_ignored_and_inherited_tempo_is_used_only_as_fallback() {
        use soundlog::mdx::command::MdxCommand;
        let voice = Voice {
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
        };

        let inherited = voice
            .test_document_with_tempo("A @1 o4 c4\nB @42 o5 d4", Some("t150"), true)
            .unwrap();
        for track in inherited.tracks.iter().take(2) {
            assert!(matches!(
                track.first(),
                Some(MdxCommand::VoiceOrPcmBank(voice)) if voice.value == 0
            ));
            assert!(matches!(track.get(1), Some(MdxCommand::Tempo(_))));
            assert!(
                track
                    .iter()
                    .any(|command| matches!(command, MdxCommand::Note(_)))
            );
            assert_eq!(
                track
                    .iter()
                    .filter(|command| matches!(command, MdxCommand::VoiceOrPcmBank(_)))
                    .count(),
                1
            );
        }
        let expected_tempo = match mmlx::mdx::compile(&mmlx::mdx::parse("A t150").unwrap())
            .unwrap()
            .tracks[0]
            .first()
        {
            Some(MdxCommand::Tempo(tempo)) => tempo.value,
            _ => panic!("expected compiled tempo"),
        };
        assert!(inherited.tracks[..2].iter().all(|track| matches!(
            track.get(1),
            Some(MdxCommand::Tempo(tempo)) if tempo.value == expected_tempo
        )));

        let selected_tempo = voice
            .test_document_with_tempo("A @1 t240 o4 c4\nB @42 o5 d4", Some("t150"), true)
            .unwrap();
        let selected_value = match mmlx::mdx::compile(&mmlx::mdx::parse("A t240").unwrap())
            .unwrap()
            .tracks[0]
            .first()
        {
            Some(MdxCommand::Tempo(tempo)) => tempo.value,
            _ => panic!("expected compiled tempo"),
        };
        assert!(selected_tempo.tracks[0].iter().any(
            |command| matches!(command, MdxCommand::Tempo(tempo) if tempo.value == selected_value)
        ));
        assert!(
            !selected_tempo.tracks[1]
                .iter()
                .any(|command| matches!(command, MdxCommand::Tempo(_)))
        );
        let example = voice
            .test_document_with_tempo("A @1 t120 cdef grgr af>c<a g1", None, true)
            .unwrap();
        assert!(
            example.tracks[0]
                .iter()
                .any(|command| matches!(command, MdxCommand::Note(_)))
        );

        let chip_state = voice
            .test_document_with_tempo("A @42 o4 c4", None, false)
            .unwrap();
        assert!(chip_state.tracks[0].iter().any(
            |command| matches!(command, MdxCommand::VoiceOrPcmBank(voice) if voice.value == 42)
        ));

        let inherited_state = voice
            .test_document_with_state("A @1 c4", None, Some("l8"), Some(5), None, None, None, true)
            .unwrap();
        let expected_state = voice
            .test_document_with_tempo("A l8 o5 c4", None, true)
            .unwrap();
        assert_eq!(inherited_state, expected_state);

        let selected_state = voice
            .test_document_with_state(
                "A @1 l16 o3 c4",
                None,
                Some("l8"),
                Some(5),
                None,
                None,
                None,
                true,
            )
            .unwrap();
        let expected_selected_state = voice
            .test_document_with_tempo("A l16 o3 c4", None, true)
            .unwrap();
        assert_eq!(selected_state, expected_selected_state);

        let shifted_octave = voice
            .test_document_with_state("A @1 > c4", None, None, Some(5), None, None, None, true)
            .unwrap();
        let expected_shifted_octave = voice
            .test_document_with_tempo("A o5 > c4", None, true)
            .unwrap();
        assert_eq!(shifted_octave, expected_shifted_octave);

        let example_state = mmlx::mdx::parse("B v15t80o3l16q8 ab>cd eede8ede4 e8e8d4.dd2")
            .unwrap()
            .tracks[0]
            .commands
            .iter()
            .filter_map(|command| match command {
                mmlx::mdx::MmlCommand::Volume(value) => Some(format!("v{value}")),
                mmlx::mdx::MmlCommand::Gate(value) => Some(format!("q{value}")),
                _ => None,
            })
            .collect::<Vec<_>>();
        let selected_state = voice
            .test_document_with_state(
                "B cc<b>c& c8<b>c4c8c8 f4&f8q4g8re8rq8e4",
                Some("t80"),
                Some("l16"),
                Some(4),
                Some(&example_state[..1]),
                Some("q8"),
                None,
                true,
            )
            .unwrap();
        let expected_selected = voice
            .test_document_with_tempo(
                "B t80 l16 o4 v15 q8 cc<b>c& c8<b>c4c8c8 f4&f8q4g8re8rq8e4",
                Some("t80"),
                true,
            )
            .unwrap();
        assert_eq!(selected_state, expected_selected);
    }
}
