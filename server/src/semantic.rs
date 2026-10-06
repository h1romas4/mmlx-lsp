use lsp_types::{SemanticToken, SemanticTokenType, SemanticTokens, SemanticTokensLegend};
use mmlx::frontend::SourceFile;
use mmlx::mdx::MmlCommand;
use mmlx::mdx::frontend::CommandSource;
use mmlx::source::Span;

const KEYWORD: u32 = 0;
const NOTE: u32 = 1;
const NUMBER: u32 = 2;
const STRING: u32 = 3;
const COMMENT: u32 = 4;
const OPERATOR: u32 = 5;
const REST: u32 = 6;

pub fn legend() -> SemanticTokensLegend {
    SemanticTokensLegend {
        token_types: vec![
            SemanticTokenType::KEYWORD,
            SemanticTokenType::new("mmlxNote"),
            SemanticTokenType::NUMBER,
            SemanticTokenType::STRING,
            SemanticTokenType::COMMENT,
            SemanticTokenType::OPERATOR,
            SemanticTokenType::ENUM_MEMBER,
        ],
        token_modifiers: vec![],
    }
}

pub fn tokens(source: &str) -> SemanticTokens {
    let mut ranges = Vec::new();
    if let Ok(parsed) = mmlx::mdx::frontend::parse(source) {
        let syntax = parsed.syntax();
        let mut numbers: Vec<Span> = syntax
            .arguments()
            .iter()
            .map(|argument| argument.span)
            .collect();
        for voice in syntax.voices() {
            numbers.push(voice.number);
            numbers.extend(&voice.parameters);
            ranges.push((voice.span.start(), voice.span.start() + 1, KEYWORD));
        }
        numbers.sort_by_key(|span| (span.start(), span.end()));
        numbers.dedup();
        for number in &numbers {
            ranges.push((number.start(), number.end(), NUMBER));
        }
        for (track, ast) in parsed.ast().tracks.iter().enumerate() {
            if let Some(commands) = syntax.commands(track) {
                collect_commands(&ast.commands, commands, &numbers, &mut ranges);
            }
        }
        for (span, value, prefix) in [
            (syntax.title(), parsed.ast().title.as_deref(), "#title"),
            (
                syntax.pcm_file(),
                parsed.ast().pcm_file.as_deref(),
                "#pcmfile",
            ),
        ] {
            if let (Some(span), Some(value)) = (span, value) {
                let end = span.start() + span.text(source).unwrap().trim_end().len();
                ranges.push((span.start(), span.start() + prefix.len(), KEYWORD));
                let quoted = format!("\"{value}\"");
                if let Some(start) = end.checked_sub(quoted.len())
                    && source.get(start..end) == Some(quoted.as_str())
                {
                    ranges.push((start, end, STRING));
                }
            }
        }
    }
    encode(source, ranges)
}

fn collect_commands(
    commands: &[MmlCommand],
    locations: &[CommandSource],
    numbers: &[Span],
    ranges: &mut Vec<(usize, usize, u32)>,
) {
    for (command, location) in commands.iter().zip(locations) {
        let kind = match command {
            MmlCommand::Note { .. }
            | MmlCommand::ExtendedNote { .. }
            | MmlCommand::NumericNote { .. } => NOTE,
            MmlCommand::Rest { .. } | MmlCommand::ExtendedRest(_) => REST,
            MmlCommand::Directive(value) if value.starts_with("/*") => COMMENT,
            MmlCommand::Repeat { .. }
            | MmlCommand::OctaveDown
            | MmlCommand::OctaveUp
            | MmlCommand::Portamento
            | MmlCommand::Legato
            | MmlCommand::VolumeDown
            | MmlCommand::VolumeUp
            | MmlCommand::LoopEscape => OPERATOR,
            _ => KEYWORD,
        };
        let prefix = match command {
            MmlCommand::OpmTempo(_)
            | MmlCommand::FineGate(_)
            | MmlCommand::FineVolume(_)
            | MmlCommand::PitchLfo { .. }
            | MmlCommand::VolumeLfo { .. }
            | MmlCommand::OpmLfo { .. }
            | MmlCommand::LfoDelay(_) => 2,
            MmlCommand::PitchLfoOn
            | MmlCommand::PitchLfoOff
            | MmlCommand::VolumeLfoOn
            | MmlCommand::VolumeLfoOff
            | MmlCommand::OpmLfoOn
            | MmlCommand::OpmLfoOff => 4,
            MmlCommand::Note {
                accidental: Some(_),
                ..
            }
            | MmlCommand::ExtendedNote {
                accidental: Some(_),
                ..
            } => 2,
            MmlCommand::Directive(_) => location.position.end() - location.position.start(),
            _ => 1,
        };
        let end = (location.position.start() + prefix).min(location.position.end());
        collect_span(
            Span::new(location.position.start(), end).unwrap(),
            kind,
            numbers,
            ranges,
        );
        if let MmlCommand::Repeat { body, .. } = command {
            collect_commands(body, &location.body, numbers, ranges);
            if let Some(end) = location.end_position {
                ranges.push((end.start(), end.start() + 1, OPERATOR));
            }
        }
    }
}

fn collect_span(span: Span, kind: u32, numbers: &[Span], ranges: &mut Vec<(usize, usize, u32)>) {
    let mut start = span.start();
    let index = numbers.partition_point(|number| number.end() <= start);
    for number in &numbers[index..] {
        if number.start() >= span.end() {
            break;
        }
        if start < number.start() {
            ranges.push((start, number.start(), kind));
        }
        start = number.end().min(span.end());
    }
    if start < span.end() {
        ranges.push((start, span.end(), kind));
    }
}

fn encode(source: &str, ranges: Vec<(usize, usize, u32)>) -> SemanticTokens {
    let Some(file) = SourceFile::new(source) else {
        return SemanticTokens::default();
    };
    let index = file.line_index();
    let mut absolute = Vec::new();
    for (start, end, kind) in ranges {
        let Some(text) = source.get(start..end) else {
            continue;
        };
        let mut offset = start;
        for line in text.split_inclusive('\n') {
            let trimmed = line.trim();
            let leading = line.len() - line.trim_start().len();
            if !trimmed.is_empty() {
                let (line_number, column) = index.utf16_position(offset + leading).unwrap();
                absolute.push((
                    line_number as u32,
                    column as u32,
                    trimmed.encode_utf16().count() as u32,
                    kind,
                ));
            }
            offset += line.len();
        }
    }
    absolute.sort_unstable();
    absolute.dedup();
    let mut data = Vec::new();
    let mut previous_line = 0;
    let mut previous_start = 0;
    for (line, column, length, kind) in absolute {
        data.push(SemanticToken {
            delta_line: line - previous_line,
            delta_start: if line == previous_line {
                column - previous_start
            } else {
                column
            },
            length,
            token_type: kind,
            token_modifiers_bitset: 0,
        });
        previous_line = line;
        previous_start = column;
    }
    SemanticTokens {
        result_id: None,
        data,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decoded(source: &str) -> Vec<(u32, u32, u32, u32)> {
        let mut line = 0;
        let mut column = 0;
        tokens(source)
            .data
            .iter()
            .map(|token| {
                line += token.delta_line;
                column = if token.delta_line == 0 {
                    column + token.delta_start
                } else {
                    token.delta_start
                };
                (line, column, token.length, token.token_type)
            })
            .collect()
    }

    #[test]
    fn separates_notes_rests_commands_and_numbers() {
        assert_eq!(
            legend().token_types[NOTE as usize],
            SemanticTokenType::new("mmlxNote")
        );
        assert_eq!(
            decoded("A t120 c4 r8"),
            vec![
                (0, 2, 1, KEYWORD),
                (0, 3, 3, NUMBER),
                (0, 7, 1, NOTE),
                (0, 8, 1, NUMBER),
                (0, 10, 1, REST),
                (0, 11, 1, NUMBER),
            ]
        );
    }

    #[test]
    fn repeats_and_shared_tracks_have_no_overlapping_tokens() {
        let result = decoded("AB [c4 [d8]2]3");
        assert_eq!(result.iter().filter(|token| token.3 == NOTE).count(), 2);
        assert_eq!(result.iter().filter(|token| token.3 == OPERATOR).count(), 4);
        for adjacent in result.windows(2) {
            assert!(
                adjacent[0].0 < adjacent[1].0 || adjacent[0].1 + adjacent[0].2 <= adjacent[1].1
            );
        }
    }

    #[test]
    fn utf16_columns_and_multiline_strings_are_encoded_correctly() {
        let result = decoded("#title \"\u{65e5}\u{1f3b5}\r\nx\"\r\nA c4");
        assert_eq!(
            result,
            vec![
                (0, 0, 6, KEYWORD),
                (0, 7, 4, STRING),
                (1, 0, 2, STRING),
                (2, 2, 1, NOTE),
                (2, 3, 1, NUMBER),
            ]
        );
        let result = decoded("A /* \u{65e5}\u{1f3b5} */ c4");
        assert!(result.contains(&(0, 12, 1, NOTE)));
    }

    #[test]
    fn parse_errors_clear_tokens_but_compile_errors_do_not() {
        assert!(tokens("A [").data.is_empty());
        assert!(!tokens("A o0 c").data.is_empty());
    }

    #[test]
    fn commands_do_not_color_interleaved_comments_as_keywords() {
        let result = decoded("A t /* comment */ 120 c+4^8");
        assert!(result.contains(&(0, 2, 1, KEYWORD)));
        assert!(result.contains(&(0, 22, 2, NOTE)));
        assert!(
            result
                .iter()
                .all(|token| token.3 != KEYWORD || token.2 == 1)
        );
    }

    #[test]
    fn voice_parameters_are_numbers_on_separate_lines() {
        let params = vec!["0"; 47].join(",\r\n");
        let source = format!("@1={{\r\n{params}\r\n}}\r\nA @1 c4");
        let result = decoded(&source);
        assert_eq!(result.iter().filter(|token| token.3 == NUMBER).count(), 50);
        assert!(
            result
                .iter()
                .any(|token| token.0 == 47 && token.3 == NUMBER)
        );
    }

    #[test]
    fn metadata_does_not_color_trailing_comments_as_strings() {
        let source = "#title \"x\" /* comment */\nA c4";
        let result = decoded(source);
        assert!(
            result
                .iter()
                .all(|token| token.3 != STRING || token.1 == 7 && token.2 == 3)
        );
        assert!(result.iter().any(|token| token.3 == NOTE));
    }
}
