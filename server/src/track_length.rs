use mmlx::mdx::{MmlCommand, MmlLength};
use serde::{Deserialize, Serialize};

const MAX_SAFE_TICKS: u64 = 9_007_199_254_740_991;

#[derive(Debug, Serialize)]
pub struct TrackLength {
    channel: char,
    ticks: u64,
    looping: bool,
}

#[derive(Debug, Serialize)]
pub struct TrackLengthRange {
    ticks: u64,
    looping: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackLengthRangeParams {
    pub text_document: lsp_types::TextDocumentIdentifier,
    pub range: lsp_types::Range,
}

pub fn at_position(source: &str, position: lsp_types::Position) -> Option<TrackLength> {
    let offset = crate::completion::byte_offset(source, position)?;
    let parsed = mmlx::mdx::frontend::parse(source).ok()?;
    let channel = channel_at_position(source, offset)?;
    let (track_index, track) = parsed
        .ast()
        .tracks
        .iter()
        .enumerate()
        .find(|(_, track)| track.channel == channel)?;
    let sources = parsed.syntax().commands(track_index)?;
    let mut default_length = MmlLength::Denominator(4);
    let tick = commands_tick_at(&track.commands, sources, offset, &mut default_length)?;
    if tick > MAX_SAFE_TICKS {
        return None;
    }
    Some(TrackLength {
        channel,
        ticks: tick,
        looping: contains_loop(&track.commands),
    })
}

pub fn in_range(source: &str, range: lsp_types::Range) -> Option<TrackLengthRange> {
    let start = crate::completion::byte_offset(source, range.start)?;
    let end = crate::completion::byte_offset(source, range.end)?;
    if end < start {
        return None;
    }
    let parsed = mmlx::mdx::frontend::parse(source).ok()?;
    let mut ticks = 0;
    let mut looping = false;
    for (index, track) in parsed.ast().tracks.iter().enumerate() {
        let sources = parsed.syntax().commands(index)?;
        let mut start_default = MmlLength::Denominator(4);
        let start_ticks = commands_tick_at(&track.commands, sources, start, &mut start_default)?;
        let mut end_default = MmlLength::Denominator(4);
        let end_ticks = commands_tick_at(&track.commands, sources, end, &mut end_default)?;
        let track_ticks = end_ticks.checked_sub(start_ticks)?;
        if track_ticks > MAX_SAFE_TICKS {
            return None;
        }
        if track_ticks > 0 {
            ticks = ticks.max(track_ticks);
            looping |= contains_loop(&track.commands);
        }
    }
    Some(TrackLengthRange { ticks, looping })
}

fn channel_at_position(source: &str, offset: usize) -> Option<char> {
    let line_start = source[..offset].rfind('\n').map_or(0, |index| index + 1);
    let line_end = source[offset..]
        .find('\n')
        .map_or(source.len(), |index| offset + index);
    let line = &source[line_start..line_end];
    let prefix = line.trim_start_matches([' ', '\t']);
    let start = line.len() - prefix.len();
    let header_len = prefix
        .bytes()
        .take_while(|byte| matches!(byte, b'A'..=b'H' | b'P'..=b'W'))
        .count();
    if header_len == 0 {
        return None;
    }
    let cursor_in_line = offset.saturating_sub(line_start + start);
    let channel_index = if cursor_in_line < header_len {
        cursor_in_line
    } else {
        0
    };
    prefix
        .as_bytes()
        .get(channel_index)
        .copied()
        .map(char::from)
}

fn commands_tick_at(
    commands: &[MmlCommand],
    sources: &[mmlx::mdx::frontend::CommandSource],
    cursor: usize,
    default_length: &mut MmlLength,
) -> Option<u64> {
    let mut elapsed = 0_u64;
    for (index, command) in commands.iter().enumerate() {
        let source = sources.get(index)?;
        let start = source.position.start();
        if cursor < start {
            return Some(elapsed);
        }
        let end = source.full_span().end();
        if let MmlCommand::Repeat { body, count } = command {
            if cursor < end {
                let mut inner_default = default_length.clone();
                let inner_tick = commands_tick_at(body, &source.body, cursor, &mut inner_default)?;
                let mut final_default = default_length.clone();
                let body_ticks =
                    commands_tick_at(body, &source.body, usize::MAX, &mut final_default)?;
                *default_length = final_default;
                let body_end = source
                    .body
                    .last()
                    .map(|body_source| body_source.full_span().end())
                    .unwrap_or(source.position.end());
                let ticks = if cursor >= body_end {
                    body_ticks.checked_mul(u64::from(*count))?
                } else {
                    inner_tick
                };
                return elapsed.checked_add(ticks);
            }
            let body_ticks = commands_tick_at(body, &source.body, usize::MAX, default_length)?;
            elapsed = elapsed.checked_add(body_ticks.checked_mul(u64::from(*count))?)?;
            continue;
        }
        if cursor < end {
            return Some(elapsed);
        }
        if matches!(command, MmlCommand::Ignore) {
            return Some(elapsed);
        }
        elapsed = elapsed.checked_add(command_ticks(command, default_length)?)?;
    }
    Some(elapsed)
}

fn command_ticks(command: &MmlCommand, default_length: &mut MmlLength) -> Option<u64> {
    match command {
        MmlCommand::Note { length, .. } => length_ticks(
            &length
                .map(MmlLength::Denominator)
                .unwrap_or_else(|| default_length.clone()),
        ),
        MmlCommand::ExtendedNote { length, .. } => length_ticks(length),
        MmlCommand::NumericNote { length, .. } => {
            length_ticks(length.as_ref().unwrap_or(default_length))
        }
        MmlCommand::Rest { length } => length_ticks(
            &length
                .map(MmlLength::Denominator)
                .unwrap_or_else(|| default_length.clone()),
        ),
        MmlCommand::ExtendedRest(length) => length_ticks(length),
        MmlCommand::DefaultLength(length) => {
            *default_length = length.clone();
            Some(0)
        }
        _ => Some(0),
    }
}

fn contains_loop(commands: &[MmlCommand]) -> bool {
    commands.iter().any(|command| match command {
        MmlCommand::LoopStart | MmlCommand::LoopEscape => true,
        MmlCommand::Repeat { body, .. } => contains_loop(body),
        _ => false,
    })
}

fn length_ticks(length: &MmlLength) -> Option<u64> {
    let ticks = match length {
        MmlLength::Denominator(value) => (*value != 0).then(|| u64::from(192 / *value)),
        MmlLength::Ticks(value) => Some(u64::from(*value)),
        MmlLength::Sum(values) => values.iter().try_fold(0_u64, |total, value| {
            total.checked_add(length_ticks(value)?)
        }),
        MmlLength::Adjusted { base, adjustments } => {
            adjustments
                .iter()
                .try_fold(length_ticks(base)?, |total, (add, value)| {
                    if *add {
                        total.checked_add(length_ticks(value)?)
                    } else {
                        total.checked_sub(length_ticks(value)?)
                    }
                })
        }
    }?;
    (ticks > 0).then_some(ticks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lsp_types::Position;

    fn at(source: &str, line: u32, character: u32) -> Option<TrackLength> {
        at_position(source, Position::new(line, character))
    }

    #[test]
    fn starts_at_zero_ticks_at_the_channel_header() {
        let source = "A l8 c d [e r]2 f4\n";
        let length = at(source, 0, 0).unwrap();
        assert_eq!(length.channel, 'A');
        assert_eq!(length.ticks, 0);
        assert!(!length.looping);
    }

    #[test]
    fn reports_elapsed_ticks_at_the_cursor_across_channel_lines() {
        let source = "A c4\nB d2\nA e4\n";
        assert_eq!(at(source, 0, 3).unwrap().ticks, 0);
        assert_eq!(at(source, 2, 3).unwrap().ticks, 48);
        assert_eq!(at(source, 2, 4).unwrap().ticks, 96);
    }

    #[test]
    fn cursor_after_repeated_section_counts_all_repetitions() {
        let source = "A c4 [d8 e8]3 f4\n";
        assert_eq!(at(source, 0, 2).unwrap().ticks, 0);
        assert_eq!(at(source, 0, 12).unwrap().ticks, 192);
    }

    #[test]
    fn cursor_inside_repeat_reports_first_pass_position() {
        let source = "A c4 [d8 e8]3 f4\n";
        assert_eq!(at(source, 0, 7).unwrap().ticks, 48);
        assert_eq!(at(source, 0, 9).unwrap().ticks, 72);
    }

    #[test]
    fn reports_looping_tracks_and_rejects_non_track_positions() {
        let source = "A c4 L d4 /\n";
        assert!(at(source, 0, 3).unwrap().looping);
        assert!(at(source, 0, 0).is_some());
        assert!(at(source, 1, 0).is_none());
    }

    #[test]
    fn measures_selected_tick_duration_and_uses_the_longest_parallel_track() {
        let source = "A l8 c d e4 f\nB c1\n";
        let selected = in_range(
            source,
            lsp_types::Range::new(Position::new(0, 5), Position::new(0, 11)),
        )
        .unwrap();
        assert_eq!(selected.ticks, 96);

        let parallel = in_range(
            source,
            lsp_types::Range::new(Position::new(0, 0), Position::new(1, 4)),
        )
        .unwrap();
        assert_eq!(parallel.ticks, 192);
    }

    #[test]
    fn selection_reports_loop_state_and_rejects_invalid_ranges() {
        let source = "A c4 L d4 /\n";
        let selected = in_range(
            source,
            lsp_types::Range::new(Position::new(0, 2), Position::new(0, 5)),
        )
        .unwrap();
        assert_eq!(selected.ticks, 48);
        assert!(selected.looping);
        assert!(
            in_range(
                source,
                lsp_types::Range::new(Position::new(0, 5), Position::new(0, 2))
            )
            .is_none()
        );
    }
}
