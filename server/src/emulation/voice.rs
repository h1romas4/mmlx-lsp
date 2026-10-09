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
        use mmlx::mdx::{MmlCommand, MmlTrack};
        fn settings(commands: &[MmlCommand], channel: u8, keep_notes: bool) -> Vec<MmlCommand> {
            commands
                .iter()
                .filter_map(|command| {
                    Some(match command {
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
                            body: settings(body, channel, keep_notes),
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
        let source = self.test_source(mml)?;
        let mut parsed = mmlx::mdx::parse(&source).map_err(|error| error.to_string())?;
        let commands = parsed.tracks[0].commands.clone();
        parsed.tracks[0].commands = settings(&commands, 0, true);
        for channel in 'B'..='H' {
            parsed.tracks.push(MmlTrack {
                channel,
                commands: settings(&commands, channel as u8 - b'A', false),
            });
        }
        mmlx::mdx::compile(&parsed).map_err(|error| error.to_string())
    }

    pub fn test_source(&self, mml: &str) -> Result<String, String> {
        if !self.validate()
            || mml.trim().is_empty()
            || mml.len() > 8192
            || mml.contains(['\r', '\n'])
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
        Ok(format!(
            "@0 = {{\n{operators}\n{},{},{}\n}}\nA @0 {mml}",
            self.algorithm, self.feedback, self.operator_mask
        ))
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
        for invalid in ["", "A c4\nB c4", "\rP c4", &"c".repeat(8193)] {
            assert!(voice.test_source(invalid).is_err());
        }
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
}
