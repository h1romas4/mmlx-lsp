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
    if !has_track_source_at(&parsed, source, offset) {
        return None;
    }
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
    if !has_track_source_in_range(&parsed, source, start, end) {
        return None;
    }
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

fn has_track_source_at(
    parsed: &mmlx::mdx::frontend::ParsedMml<'_>,
    source: &str,
    offset: usize,
) -> bool {
    if parsed
        .syntax()
        .voices()
        .iter()
        .any(|voice| voice.span.start() <= offset && offset < voice.span.end())
    {
        return false;
    }
    track_code_spans(source)
        .into_iter()
        .any(|(start, end, line_end)| {
            start <= offset && (offset < end || (offset == end && end == line_end))
        })
}

fn has_track_source_in_range(
    parsed: &mmlx::mdx::frontend::ParsedMml<'_>,
    source: &str,
    start: usize,
    end: usize,
) -> bool {
    if start == end {
        return has_track_source_at(parsed, source, start);
    }
    track_code_spans(source)
        .into_iter()
        .any(|(span_start, span_end, _)| spans_intersect(start, end, span_start, span_end))
}

fn track_code_spans(source: &str) -> Vec<(usize, usize, usize)> {
    let mut spans = Vec::new();
    let mut block_comment = false;
    let mut line_start = 0;
    while line_start < source.len() {
        let line_end = source[line_start..]
            .find('\n')
            .map_or(source.len(), |index| line_start + index);
        let line = &source[line_start..line_end];
        let prefix = line.trim_start_matches([' ', '\t']);
        let prefix_start = line_start + line.len() - prefix.len();
        let header_len = prefix
            .bytes()
            .take_while(|byte| matches!(byte, b'A'..=b'H' | b'P'..=b'W'))
            .count();
        let track_line = header_len > 0;
        let mut code_start = (track_line && !block_comment).then_some(prefix_start);
        let mut cursor = prefix_start;
        let mut string = false;
        while cursor < line_end {
            let rest = &source[cursor..line_end];
            if block_comment {
                if rest.starts_with("*/") {
                    block_comment = false;
                    cursor += 2;
                    if track_line {
                        code_start = Some(cursor);
                    }
                } else {
                    cursor += rest.chars().next().unwrap().len_utf8();
                }
                continue;
            }
            if string {
                if rest.starts_with('\\') {
                    cursor += 1;
                    if cursor < line_end {
                        cursor += source[cursor..line_end].chars().next().unwrap().len_utf8();
                    }
                } else {
                    let character = rest.chars().next().unwrap();
                    cursor += character.len_utf8();
                    string = character != '"';
                }
                continue;
            }
            if rest.starts_with("/*") {
                if let Some(start) = code_start.take()
                    && start < cursor
                {
                    spans.push((start, cursor, line_end));
                }
                block_comment = true;
                cursor += 2;
            } else {
                let character = rest.chars().next().unwrap();
                if character == ';' || character == '!' {
                    if let Some(start) = code_start.take()
                        && start < cursor
                    {
                        spans.push((start, cursor, line_end));
                    }
                    break;
                }
                if character == '"' {
                    string = true;
                }
                cursor += character.len_utf8();
            }
        }
        if let Some(start) = code_start
            && start < line_end
            && cursor == line_end
        {
            spans.push((start, line_end, line_end));
        }
        if line_end == source.len() {
            break;
        }
        line_start = line_end + 1;
    }
    spans
}

fn spans_intersect(start: usize, end: usize, span_start: usize, span_end: usize) -> bool {
    start < span_end && span_start < end
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
    fn rejects_hover_positions_in_voice_definitions_and_comments() {
        let source = "@1 = { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47 }\n; A c4\nA c4 ; trailing comment\n";
        assert!(at(source, 0, 8).is_none());
        assert!(at(source, 1, 4).is_none());
        assert!(at(source, 2, 9).is_none());
        assert!(at(source, 2, 2).is_some());
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

    #[test]
    fn rejects_selection_ranges_containing_only_voice_definitions_or_comments() {
        let source = "@1 = { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47 }\n; A c4\nA c4 ; trailing comment\n";
        assert!(
            in_range(
                source,
                lsp_types::Range::new(Position::new(0, 0), Position::new(0, 16))
            )
            .is_none()
        );
        assert!(
            in_range(
                source,
                lsp_types::Range::new(Position::new(1, 0), Position::new(1, 6))
            )
            .is_none()
        );
        assert!(
            in_range(
                source,
                lsp_types::Range::new(Position::new(2, 5), Position::new(2, 23))
            )
            .is_none()
        );
    }
}
