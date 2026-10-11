use std::collections::HashSet;

use lsp_types::{Position, Range, SelectionRange};
use mmlx::frontend::SourceFile;

use crate::completion::byte_offset;

#[derive(Clone)]
struct ChannelLine {
    line: usize,
    channels_start: usize,
    header_end: usize,
    line_end: usize,
    channels: Vec<char>,
}

pub fn ranges(source: &str, positions: &[Position]) -> Option<Vec<SelectionRange>> {
    let file = SourceFile::new(source)?;
    let line_index = file.line_index();
    let parsed = mmlx::mdx::frontend::parse(source).ok();
    let tracks = parsed
        .as_ref()
        .map(|parsed| {
            parsed
                .ast()
                .tracks
                .iter()
                .map(|track| track.channel)
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    let lines = channel_lines(source, &tracks);

    positions
        .iter()
        .map(|position| {
            let offset = byte_offset(source, *position)?;
            let mut ranges = Vec::new();
            let voice = parsed.as_ref().and_then(|parsed| {
                parsed.syntax().voices().iter().find(|voice| {
                    let end =
                        voice.span.start() + voice.span.text(source).unwrap_or("").trim_end().len();
                    voice.span.start() <= offset && offset <= end
                })
            });
            if let Some(voice) = voice {
                let voice_start = voice.span.start();
                let voice_end = voice_start + voice.span.text(source)?.trim_end().len();
                if let Some(token) = std::iter::once(&voice.number)
                    .chain(&voice.parameters)
                    .find(|span| span.start() <= offset && offset <= span.end())
                {
                    ranges.push((token.start(), token.end()));
                }
                let (line_start, line_end) = line_range(source, offset);
                ranges.push((line_start.max(voice_start), line_end.min(voice_end)));
                ranges.push((voice_start, voice_end));
            } else {
                let line_index_in_source = lines.iter().position(|line| {
                    line.line == position.line as usize
                        && line.channels_start <= offset
                        && offset <= line.line_end
                });
                let selected_channel = line_index_in_source.and_then(|index| {
                    let line = &lines[index];
                    let channel_index = offset
                        .checked_sub(line.channels_start)
                        .filter(|channel_index| *channel_index < line.channels.len())
                        .or_else(|| (offset == line.header_end).then_some(line.channels.len() - 1))
                        .unwrap_or(0);
                    line.channels
                        .get(channel_index)
                        .copied()
                        .map(|channel| (index, channel))
                });
                let selected_header = selected_channel.and_then(|(index, channel)| {
                    let line = &lines[index];
                    (offset < line.header_end)
                        .then_some((offset, offset + 1, channel))
                        .or_else(|| {
                            (offset == line.header_end).then_some((
                                line.header_end - 1,
                                line.header_end,
                                channel,
                            ))
                        })
                });

                if let Some((start, end, _)) = selected_header {
                    ranges.push((start, end));
                }
                if let Some(index) = line_index_in_source {
                    let line = &lines[index];
                    ranges.push((line.channels_start, line.line_end));
                    if let Some((_, channel)) = selected_channel {
                        let mut first = index;
                        while first > 0
                            && lines[first - 1].channels.contains(&channel)
                            && trivia_only(
                                source,
                                lines[first - 1].line_end,
                                lines[first].channels_start,
                            )
                        {
                            first -= 1;
                        }
                        let mut last = index;
                        while last + 1 < lines.len()
                            && lines[last + 1].channels.contains(&channel)
                            && trivia_only(
                                source,
                                lines[last].line_end,
                                lines[last + 1].channels_start,
                            )
                        {
                            last += 1;
                        }
                        ranges.push((lines[first].channels_start, lines[last].line_end));
                    }
                } else {
                    ranges.push(line_range(source, offset));
                }
            }
            ranges.push((0, source.len()));
            Some(build_chain(&line_index, ranges)?)
        })
        .collect()
}

fn channel_lines(source: &str, tracks: &HashSet<char>) -> Vec<ChannelLine> {
    let bytes = source.as_bytes();
    let mut lines = Vec::new();
    let mut offset = 0;
    let mut block_comment = false;

    for (line, text) in source.split_inclusive('\n').enumerate() {
        let line_start = offset;
        offset += text.len();
        let mut line_end = offset;
        if line_end > line_start && bytes[line_end - 1] == b'\n' {
            line_end -= 1;
        }
        if line_end > line_start && bytes[line_end - 1] == b'\r' {
            line_end -= 1;
        }
        while line_end > line_start && matches!(bytes[line_end - 1], b' ' | b'\t') {
            line_end -= 1;
        }

        let mut cursor = line_start;
        while cursor < line_end {
            if block_comment {
                if let Some(end) = source[cursor..line_end].find("*/") {
                    cursor += end + 2;
                    block_comment = false;
                    continue;
                }
                break;
            }
            if matches!(bytes[cursor], b' ' | b'\t' | b'\x0c') {
                cursor += 1;
                continue;
            }
            if bytes[cursor..line_end].starts_with(b"/*") {
                cursor += 2;
                block_comment = true;
                continue;
            }
            if bytes[cursor] == b';' || bytes[cursor] == b'#' || bytes[cursor] == b'@' {
                break;
            }
            if !is_channel(bytes[cursor]) {
                break;
            }

            let channels_start = cursor;
            let mut channels = Vec::new();
            while cursor < line_end && is_channel(bytes[cursor]) {
                let channel = bytes[cursor] as char;
                if tracks.contains(&channel) {
                    channels.push(channel);
                }
                cursor += 1;
            }
            if !channels.is_empty() {
                lines.push(ChannelLine {
                    line,
                    channels_start,
                    header_end: cursor,
                    line_end,
                    channels,
                });
            }
            break;
        }
    }
    lines
}

fn trivia_only(source: &str, start: usize, end: usize) -> bool {
    let bytes = source.as_bytes();
    let mut cursor = start;
    while cursor < end {
        if bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        } else if bytes[cursor] == b';' {
            cursor += source[cursor..end].find('\n').unwrap_or(end - cursor);
        } else if bytes[cursor..end].starts_with(b"/*") {
            let Some(comment_end) = source[cursor..end].find("*/") else {
                return false;
            };
            cursor += comment_end + 2;
        } else {
            return false;
        }
    }
    true
}

fn is_channel(byte: u8) -> bool {
    byte.is_ascii_uppercase() && (matches!(byte, b'A'..=b'H') || matches!(byte, b'P'..=b'W'))
}

fn line_range(source: &str, offset: usize) -> (usize, usize) {
    let line_start = source[..offset].rfind('\n').map_or(0, |index| index + 1);
    let mut line_end = source[offset..]
        .find('\n')
        .map_or(source.len(), |index| offset + index);
    if line_end > line_start && source.as_bytes()[line_end - 1] == b'\r' {
        line_end -= 1;
    }
    while line_end > line_start && matches!(source.as_bytes()[line_end - 1], b' ' | b'\t') {
        line_end -= 1;
    }
    (line_start, line_end)
}

fn build_chain(
    line_index: &mmlx::frontend::LineIndex<'_>,
    ranges: Vec<(usize, usize)>,
) -> Option<SelectionRange> {
    let mut unique = Vec::new();
    for range in ranges {
        if unique.last() != Some(&range) {
            unique.push(range);
        }
    }

    let mut parent = None;
    for (start, end) in unique.into_iter().rev() {
        let (start_line, start_character) = line_index.utf16_position(start)?;
        let (end_line, end_character) = line_index.utf16_position(end)?;
        parent = Some(Box::new(SelectionRange {
            range: Range::new(
                Position::new(start_line as u32, start_character as u32),
                Position::new(end_line as u32, end_character as u32),
            ),
            parent,
        }));
    }
    parent.map(|range| *range)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> String {
        let voice = vec!["0"; 47].join(",");
        format!("@1 = {{ {voice} }}\nA c4\nB d4\nA e4\n")
    }

    fn chain(range: &SelectionRange) -> Vec<Range> {
        let mut result = Vec::new();
        let mut current = Some(range);
        while let Some(selection) = current {
            result.push(selection.range);
            current = selection.parent.as_deref();
        }
        result
    }

    #[test]
    fn channel_range_stops_at_an_interleaved_channel() {
        let source = source();
        let selections = ranges(&source, &[Position::new(1, 0), Position::new(3, 0)]).unwrap();
        assert_eq!(
            chain(&selections[0]),
            [
                Range::new(Position::new(1, 0), Position::new(1, 1)),
                Range::new(Position::new(1, 0), Position::new(1, 4)),
                Range::new(Position::new(0, 0), Position::new(4, 0)),
            ]
        );
        assert_eq!(
            chain(&selections[1]),
            [
                Range::new(Position::new(3, 0), Position::new(3, 1)),
                Range::new(Position::new(3, 0), Position::new(3, 4)),
                Range::new(Position::new(0, 0), Position::new(4, 0)),
            ]
        );
    }

    #[test]
    fn consecutive_lines_for_the_same_channel_are_grouped() {
        let selections = ranges("A c4\nA e4\nB d4\n", &[Position::new(0, 0)]).unwrap();
        assert_eq!(
            chain(&selections[0]),
            [
                Range::new(Position::new(0, 0), Position::new(0, 1)),
                Range::new(Position::new(0, 0), Position::new(0, 4)),
                Range::new(Position::new(0, 0), Position::new(1, 4)),
                Range::new(Position::new(0, 0), Position::new(3, 0)),
            ]
        );
    }

    #[test]
    fn multiline_voice_definition_is_a_selection_parent() {
        let values = vec!["0"; 47];
        let data = values
            .chunks(11)
            .map(|group| group.join(","))
            .collect::<Vec<_>>()
            .join(",\n");
        let source = format!("@1 = {{\n{data}\n}}\nA c4\n");
        let selections = ranges(&source, &[Position::new(1, 0)]).unwrap();
        assert_eq!(
            chain(&selections[0]),
            [
                Range::new(Position::new(1, 0), Position::new(1, 1)),
                Range::new(Position::new(1, 0), Position::new(1, 22)),
                Range::new(Position::new(0, 0), Position::new(6, 1)),
                Range::new(Position::new(0, 0), Position::new(8, 0)),
            ]
        );
    }

    #[test]
    fn channel_in_multi_channel_header_has_its_own_range() {
        let selections = ranges("AB c4\n", &[Position::new(0, 1)]).unwrap();
        assert_eq!(
            chain(&selections[0]),
            [
                Range::new(Position::new(0, 1), Position::new(0, 2)),
                Range::new(Position::new(0, 0), Position::new(0, 5)),
                Range::new(Position::new(0, 0), Position::new(1, 0)),
            ]
        );
    }

    #[test]
    fn invalid_mml_still_has_line_based_selection() {
        let selections = ranges("A [\n", &[Position::new(0, 1)]).unwrap();
        assert_eq!(
            chain(&selections[0]),
            [
                Range::new(Position::new(0, 0), Position::new(0, 3)),
                Range::new(Position::new(0, 0), Position::new(1, 0)),
            ]
        );
    }
}
