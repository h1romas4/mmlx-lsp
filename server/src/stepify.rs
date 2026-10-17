use mmlx::mdx::{Accidental, MmlCommand};
use serde::Deserialize;

const MAX_SOURCE_BYTES: usize = 65_536;
const MAX_STEPS_PER_TRACK: usize = 16_384;
const MAX_OUTPUT_BYTES: usize = 65_536;
const STEPS_PER_BAR: usize = 16;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepifyRequest {
    pub source: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Step {
    Note(u8),
    Rest,
}

pub fn convert(source: &str) -> Result<String, String> {
    if source.trim().is_empty() || source.len() > MAX_SOURCE_BYTES {
        return Err("Select non-empty MML containing at most 65536 bytes.".into());
    }

    let has_channels = source.lines().any(is_channel_line);
    let parse_source = if has_channels {
        source.to_owned()
    } else {
        prefix_default_channel(source)
    };
    let parsed = mmlx::mdx::parse(&parse_source)
        .map_err(|error| format!("Could not parse the selected MML: {error}"))?;

    let mut output = Vec::new();
    let mut has_steps = false;
    for track in &parsed.tracks {
        let mut steps = Vec::new();
        let mut octave = 4;
        collect_steps(&track.commands, &mut octave, &mut steps)?;
        if steps.is_empty() {
            continue;
        }
        has_steps = true;
        let body = render_steps(&steps);
        if has_channels {
            output.push(format!("{} {body}", track.channel));
        } else {
            output.push(body);
        }
    }
    if !has_steps {
        return Err("The selection contains no notes or rests to stepify.".into());
    }

    let result = output.join("\n");
    if result.len() > MAX_OUTPUT_BYTES {
        return Err("The stepified selection would exceed 65536 bytes.".into());
    }
    Ok(result)
}

fn is_channel_line(line: &str) -> bool {
    let line = line.trim_start();
    let channel_len = line
        .chars()
        .take_while(|channel| matches!(channel, 'A'..='H' | 'P'..='W'))
        .count();
    channel_len > 0
        && line[channel_len..]
            .chars()
            .next()
            .is_none_or(char::is_whitespace)
}

fn prefix_default_channel(source: &str) -> String {
    let mut in_voice_definition = false;
    source
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            if in_voice_definition {
                if trimmed.contains('}') {
                    in_voice_definition = false;
                }
                return line.to_owned();
            }
            if trimmed.starts_with('@') && trimmed.contains('=') && trimmed.contains('{') {
                in_voice_definition = true;
                return line.to_owned();
            }
            if trimmed.is_empty() || trimmed.starts_with(';') || trimmed.starts_with('#') {
                line.to_owned()
            } else {
                format!("A {line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn collect_steps(
    commands: &[MmlCommand],
    octave: &mut u8,
    steps: &mut Vec<Step>,
) -> Result<(), String> {
    for command in commands {
        match command {
            MmlCommand::Note {
                name, accidental, ..
            }
            | MmlCommand::ExtendedNote {
                name, accidental, ..
            } => push_step(steps, Step::Note(note_number(*octave, *name, *accidental)?))?,
            MmlCommand::NumericNote { note, .. } => push_step(steps, Step::Note(*note))?,
            MmlCommand::Rest { .. } | MmlCommand::ExtendedRest(_) => push_step(steps, Step::Rest)?,
            MmlCommand::Octave(value) => *octave = *value,
            MmlCommand::OctaveDown => *octave = octave.saturating_sub(1),
            MmlCommand::OctaveUp => {
                *octave = octave
                    .checked_add(1)
                    .ok_or_else(|| "Octave is outside the supported range.".to_owned())?
            }
            MmlCommand::Repeat { body, count } => {
                for _ in 0..*count {
                    collect_steps(body, octave, steps)?;
                }
            }
            MmlCommand::Ignore => break,
            _ => {}
        }
    }
    Ok(())
}

fn push_step(steps: &mut Vec<Step>, step: Step) -> Result<(), String> {
    if steps.len() >= MAX_STEPS_PER_TRACK {
        return Err("The selected MML expands to too many 16th-note steps.".into());
    }
    steps.push(step);
    Ok(())
}

fn note_number(octave: u8, name: char, accidental: Option<Accidental>) -> Result<u8, String> {
    let base = match name {
        'c' => 0_i16,
        'd' => 2,
        'e' => 4,
        'f' => 5,
        'g' => 7,
        'a' => 9,
        'b' => 11,
        _ => return Err("The selection contains an invalid note.".into()),
    };
    let modifier = match accidental {
        Some(Accidental::Sharp) => 1,
        Some(Accidental::Flat) => -1,
        None => 0,
    };
    let number = i16::from(octave) * 12 + base + modifier - 3;
    u8::try_from(number)
        .ok()
        .filter(|number| *number <= 95)
        .ok_or_else(|| "A note in the selection is outside the supported pitch range.".into())
}

fn render_steps(steps: &[Step]) -> String {
    let mut bars = Vec::<String>::new();
    let mut position = 0;
    let mut index = 0;
    let mut output_octave = 4_u8;

    while index < steps.len() {
        let step = steps[index];
        let run_length = steps[index..]
            .iter()
            .take_while(|next| **next == step)
            .count();
        let mut remaining = run_length;
        let mut consumed = 0;
        while remaining > 0 {
            let bar_remaining = STEPS_PER_BAR - position % STEPS_PER_BAR;
            let duration = remaining.min(bar_remaining);
            let bar_index = position / STEPS_PER_BAR;
            if bars.len() <= bar_index {
                bars.push(String::new());
            }
            let bar = &mut bars[bar_index];
            match step {
                Step::Note(number) => {
                    if consumed > 0 {
                        bar.push('&');
                    }
                    let (octave, pitch) = format_pitch(number);
                    if octave != output_octave {
                        bar.push_str(&format!("o{octave}"));
                        output_octave = octave;
                    }
                    bar.push_str(pitch);
                    bar.push_str(&format_length(duration));
                }
                Step::Rest => {
                    bar.push('r');
                    bar.push_str(&format_length(duration));
                }
            }
            position += duration;
            consumed += duration;
            remaining -= duration;
        }
        index += run_length;
    }

    bars.join(" ")
}

fn format_pitch(number: u8) -> (u8, &'static str) {
    let pitch = [
        "c", "c+", "d", "d+", "e", "f", "f+", "g", "g+", "a", "a+", "b",
    ];
    let absolute = u16::from(number) + 3;
    ((absolute / 12) as u8, pitch[(absolute % 12) as usize])
}

fn format_length(mut steps: usize) -> String {
    let terms = [
        (16, "1"),
        (12, "2."),
        (8, "2"),
        (6, "4."),
        (4, "4"),
        (3, "8."),
        (2, "8"),
        (1, "16"),
    ];
    let mut output = Vec::new();
    while steps > 0 {
        let (duration, notation) = terms
            .iter()
            .find(|(duration, _)| *duration <= steps)
            .expect("positive step counts have a 16th-note representation");
        output.push(*notation);
        steps -= duration;
    }
    output.join("^")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_source_lengths_and_merges_consecutive_pitches() {
        assert_eq!(convert("A t120 o4 l8 ccccdeefff").unwrap(), "A c4d16e8f8.");
    }

    #[test]
    fn preserves_rests_as_single_steps_and_splits_at_each_bar() {
        let output = convert("A cccc r4 ddddddddddddddddd").unwrap();
        assert_eq!(output, "A c4r16d2^8. &d4.");
        assert!(mmlx::mdx::parse(&output).is_ok());
    }

    #[test]
    fn preserves_pitch_across_octave_changes_and_canonicalizes_enharmonics() {
        assert_eq!(convert("A o5 c+16d-8").unwrap(), "A o5c+8");
    }

    #[test]
    fn handles_channel_less_fragments_and_repeats() {
        assert_eq!(convert("[c]4").unwrap(), "c4");
    }

    #[test]
    fn retains_each_explicit_channel() {
        assert_eq!(convert("A o5 c4\nB o3 g4").unwrap(), "A o5c16\nB o3g16");
    }

    #[test]
    fn rejects_selections_without_note_or_rest_data() {
        assert!(convert("A t120 o4").is_err());
    }
}
