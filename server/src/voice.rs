use lsp_types::{CodeLens, Command, DocumentSymbol, Location, Position, Range, SymbolKind, Uri};
use mmlx::source::Span;
use serde_json::{Value, json};

use crate::i18n::Language;

const OPERATOR_PARAMETERS: [(&str, u8); 11] = [
    ("AR", 31),
    ("D1R", 31),
    ("D2R", 31),
    ("RR", 15),
    ("D1L", 15),
    ("TL", 127),
    ("KS", 3),
    ("MUL", 15),
    ("DT1", 7),
    ("DT2", 3),
    ("AME", 1),
];

const GLOBAL_PARAMETERS: [(&str, u8); 3] = [("CON", 7), ("FL", 7), ("OP", 15)];

pub struct InvalidVoiceParameter {
    pub span: Span,
    pub operator: Option<usize>,
    pub name: &'static str,
    pub value: u8,
    pub max: u8,
}

fn position_at(source: &str, offset: usize) -> Position {
    let before = &source[..offset];
    Position::new(
        before.bytes().filter(|byte| *byte == b'\n').count() as u32,
        before
            .rsplit('\n')
            .next()
            .unwrap_or("")
            .encode_utf16()
            .count() as u32,
    )
}

pub fn invalid_parameters(
    source: &str,
    voice: &mmlx::mdx::frontend::VoiceSource,
) -> Vec<InvalidVoiceParameter> {
    let Some(parameters) = voice
        .parameters
        .iter()
        .map(|span| span.text(source)?.parse::<u8>().ok())
        .collect::<Option<Vec<_>>>()
    else {
        return Vec::new();
    };
    if parameters.len() != 47 {
        return Vec::new();
    }

    voice
        .parameters
        .iter()
        .zip(parameters)
        .enumerate()
        .filter_map(|(index, (span, value))| {
            let (operator, name, max) = if index < 44 {
                let (name, max) = OPERATOR_PARAMETERS[index % OPERATOR_PARAMETERS.len()];
                (Some(index / OPERATOR_PARAMETERS.len() + 1), name, max)
            } else {
                let (name, max) = GLOBAL_PARAMETERS[index - 44];
                (None, name, max)
            };
            (value > max).then_some(InvalidVoiceParameter {
                span: *span,
                operator,
                name,
                value,
                max,
            })
        })
        .collect()
}

pub fn at_position(source: &str, position: Position) -> Option<Value> {
    let offset = crate::completion::byte_offset(source, position)?;
    let parsed = mmlx::mdx::frontend::parse(source).ok()?;
    let voice = parsed.syntax().voices().iter().find(|voice| {
        let end = voice.span.start() + voice.span.text(source).unwrap_or("").trim_end().len();
        voice.span.start() <= offset && offset < end
    })?;
    let number = voice.number.text(source)?.parse::<u8>().ok()?;
    let parameters: Vec<u8> = voice
        .parameters
        .iter()
        .map(|span| span.text(source)?.parse::<u8>().ok())
        .collect::<Option<_>>()?;
    if parameters.len() != 47 {
        return None;
    }
    let invalid = invalid_parameters(source, voice);
    if !invalid.is_empty() {
        let invalid_parameters = invalid
            .iter()
            .map(|issue| {
                let parameter = issue.operator.map_or_else(
                    || issue.name.to_owned(),
                    |operator| format!("OP{operator} {}", issue.name),
                );
                format!("{parameter}: {} (0-{})", issue.value, issue.max)
            })
            .collect::<Vec<_>>();
        return Some(json!({
            "invalidParameters": invalid_parameters,
            "name": crate::completion::voice_name_before(source, voice.span.start()),
            "number": number,
        }));
    }
    let operators: Vec<Value> = parameters[..44]
        .chunks_exact(11)
        .map(|operator| {
            json!({
                "ar": operator[0], "d1r": operator[1], "d2r": operator[2],
                "rr": operator[3], "d1l": operator[4], "tl": operator[5],
                "ks": operator[6], "mul": operator[7], "dt1": operator[8],
                "dt2": operator[9], "ame": operator[10],
            })
        })
        .collect();
    let parameter_ranges: Vec<Range> = voice
        .parameters
        .iter()
        .map(|span| {
            Range::new(
                position_at(source, span.start()),
                position_at(source, span.start() + span.text(source).unwrap_or("").len()),
            )
        })
        .collect();
    Some(json!({
        "number": number, "algorithm": parameters[44],
        "feedback": parameters[45], "operatorMask": parameters[46],
        "name": crate::completion::voice_name_before(source, voice.span.start()),
        "operators": operators,
        "position": position_at(source, voice.span.start()),
        "range": Range::new(
            position_at(source, voice.span.start()),
            position_at(source, voice.span.start() + voice.span.text(source)?.trim_end().len()),
        ),
        "parameterRanges": parameter_ranges,
    }))
}

#[allow(deprecated)]
pub fn document_symbols(source: &str) -> Vec<DocumentSymbol> {
    let Some(parsed) = mmlx::mdx::frontend::parse(source).ok() else {
        return Vec::new();
    };
    parsed
        .syntax()
        .voices()
        .iter()
        .filter_map(|voice| {
            let number = voice.number.text(source)?.parse::<u8>().ok()?;
            let range = span_range(source, voice.span)?;
            let selection_range = span_range(source, voice.number)?;
            let name = crate::completion::voice_name_before(source, voice.span.start())
                .map_or_else(|| format!("@{number}"), |name| format!("@{number} {name}"));
            Some(DocumentSymbol {
                name,
                detail: None,
                kind: SymbolKind::OBJECT,
                tags: None,
                deprecated: None,
                range,
                selection_range,
                children: None,
            })
        })
        .collect()
}

pub fn code_lenses(source: &str, uri: Uri, language: Language) -> Vec<CodeLens> {
    let Some(parsed) = mmlx::mdx::frontend::parse(source).ok() else {
        return Vec::new();
    };
    let syntax = parsed.syntax();
    let references: Vec<_> = syntax
        .arguments()
        .iter()
        .filter_map(|argument| {
            if !is_fm_track_command(source, argument.command.start()) {
                return None;
            }
            let command = argument.command.text(source)?;
            let number = command.strip_prefix('@')?;
            if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            let number = number.parse::<u8>().ok()?;
            Some((
                number,
                Location::new(uri.clone(), span_range(source, argument.command)?),
            ))
        })
        .collect();

    syntax
        .voices()
        .iter()
        .filter_map(|voice| {
            let number = voice.number.text(source)?.parse::<u8>().ok()?;
            let definition_position = position_at(source, voice.number.start());
            let voice_references: Vec<_> = references
                .iter()
                .filter(|(reference_number, _)| *reference_number == number)
                .map(|(_, location)| location.clone())
                .collect();
            let count = voice_references.len();
            let title = if count == 1 {
                rust_i18n::t!("mdx.voice_reference.one", locale = language.locale()).to_string()
            } else {
                rust_i18n::t!(
                    "mdx.voice_reference.many",
                    locale = language.locale(),
                    count = count
                )
                .to_string()
            };
            Some(CodeLens {
                range: span_range(source, voice.span)?,
                command: Some(Command {
                    title,
                    command: "mmlx.showVoiceReferences".into(),
                    arguments: Some(vec![
                        json!(uri),
                        json!(definition_position),
                        json!(voice_references),
                    ]),
                }),
                data: None,
            })
        })
        .collect()
}

fn span_range(source: &str, span: mmlx::source::Span) -> Option<Range> {
    Some(Range::new(
        position_at(source, span.start()),
        position_at(source, span.end()),
    ))
}

fn is_fm_track_command(source: &str, offset: usize) -> bool {
    let line_start = source[..offset].rfind('\n').map_or(0, |index| index + 1);
    source[line_start..offset]
        .trim_start_matches([' ', '\t'])
        .bytes()
        .next()
        .is_some_and(|channel| matches!(channel, b'A'..=b'H'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> String {
        format!(
            "#title \"日本 🎵\"\n@7 = {{\n{}\n5,3,15\n}}\nA @7 c4\n",
            "31,12,4,8,6,20,1,2,3,1,0,\n".repeat(4)
        )
    }

    fn position(source: &str, offset: usize) -> Position {
        let before = &source[..offset];
        Position::new(
            before.bytes().filter(|byte| *byte == b'\n').count() as u32,
            before.rsplit('\n').next().unwrap().encode_utf16().count() as u32,
        )
    }

    #[test]
    fn voice_parameters_follow_parser_spans() {
        let source = source();
        for offset in [
            source.find("@7").unwrap(),
            source.find("12,4").unwrap(),
            source.find('}').unwrap(),
        ] {
            let voice = at_position(&source, position(&source, offset)).unwrap();
            assert_eq!(voice["number"], 7);
            assert_eq!(voice["algorithm"], 5);
            assert_eq!(voice["feedback"], 3);
            assert_eq!(voice["operatorMask"], 15);
            assert_eq!(voice["operators"].as_array().unwrap().len(), 4);
            assert_eq!(voice["operators"][0]["ar"], 31);
            assert_eq!(voice["operators"][0]["tl"], 20);
            assert_eq!(voice["operators"][3]["ame"], 0);
            assert!(voice["name"].is_null());
        }
    }

    #[test]
    fn voice_request_returns_only_an_adjacent_semicolon_comment_as_name() {
        let named = source().replacen("@7", "; Grand Piano\n@7", 1);
        let voice = at_position(&named, position(&named, named.find("@7").unwrap())).unwrap();
        assert_eq!(voice["name"], "Grand Piano");

        let unnamed = source().replace(
            "#title \"日本 🎵\"\n",
            "#title \"日本 🎵\"\n; Detached name\n\n",
        );
        let voice = at_position(&unnamed, position(&unnamed, unnamed.find("@7").unwrap())).unwrap();
        assert!(voice["name"].is_null());
    }

    #[test]
    fn document_symbols_include_voice_numbers_and_adjacent_names() {
        let source =
            source().replacen("@7", "; Grand Piano\n@7", 1) + &source().replace("@7", "@8");
        let symbols = document_symbols(&source);
        assert_eq!(symbols.len(), 2);
        assert_eq!(symbols[0].name, "@7 Grand Piano");
        assert_eq!(symbols[0].kind, SymbolKind::OBJECT);
        assert_eq!(symbols[1].name, "@8");
        let number_start = source.find("@7").unwrap();
        assert_eq!(
            symbols[0].selection_range.start,
            position(&source, number_start + 1)
        );
    }

    #[test]
    fn editable_ranges_select_only_numbers_in_utf16_source() {
        let source = source().replace("@7 = {", "/* 日本 🎵 */ @7 = {");
        let voice = at_position(&source, position(&source, source.find("@7").unwrap())).unwrap();
        let definition: Range = serde_json::from_value(voice["range"].clone()).unwrap();
        assert_eq!(
            definition.start,
            position(&source, source.find("@7").unwrap())
        );
        assert_eq!(
            definition.end,
            position(&source, source.find('}').unwrap() + 1)
        );
        let ranges: Vec<Range> = serde_json::from_value(voice["parameterRanges"].clone()).unwrap();
        assert_eq!(ranges.len(), 47);
        for range in &ranges {
            let start = crate::completion::byte_offset(&source, range.start).unwrap();
            let end = crate::completion::byte_offset(&source, range.end).unwrap();
            assert!(source[start..end].bytes().all(|byte| byte.is_ascii_digit()));
            assert!(end > start);
        }
        let range = ranges[44];
        let start = crate::completion::byte_offset(&source, range.start).unwrap();
        let end = crate::completion::byte_offset(&source, range.end).unwrap();
        let mut edited = source.clone();
        edited.replace_range(start..end, "7");
        assert_eq!(edited, source.replace("5,3,15", "7,3,15"));
        assert_eq!(
            at_position(&edited, position(&edited, edited.find("@7").unwrap())).unwrap()["algorithm"],
            7
        );
        assert_eq!(
            voice["position"],
            json!(position(&source, source.find("@7").unwrap()))
        );
    }

    #[test]
    fn outside_definition_and_incomplete_source_return_none() {
        let source = source();
        for offset in [
            0,
            source.find('}').unwrap() + 1,
            source.find("A @7").unwrap(),
        ] {
            assert!(
                at_position(&source, position(&source, offset)).is_none(),
                "offset {offset}"
            );
        }
        assert!(at_position("@7 = { 31,", Position::new(0, 8)).is_none());
        assert!(at_position(&source, Position::new(100, 0)).is_none());
    }

    #[test]
    fn comments_utf16_and_multiple_definitions_keep_the_selected_voice() {
        let first = source();
        let definition = &first[first.find("@7").unwrap()..first.find('}').unwrap() + 1];
        let source = format!(
            "/* 音色 🎵 */ {definition}\n{}\nA @7 c4",
            definition.replace("@7", "@8")
        );
        for (marker, number) in [("@7", 7), ("@8", 8)] {
            let voice =
                at_position(&source, position(&source, source.find(marker).unwrap())).unwrap();
            assert_eq!(voice["number"], number);
        }
        let invalid = source
            .replace("/* 音色 🎵 */ @7", "/* 音色 🎵 */\n; Grand Piano\n@7")
            .replace("31,12", "32,12");
        let response =
            at_position(&invalid, position(&invalid, invalid.find("@7").unwrap())).unwrap();
        assert_eq!(
            response["invalidParameters"],
            json!([
                "OP1 AR: 32 (0-31)",
                "OP2 AR: 32 (0-31)",
                "OP3 AR: 32 (0-31)",
                "OP4 AR: 32 (0-31)"
            ])
        );
        assert_eq!(response["number"], 7);
        assert_eq!(response["name"], "Grand Piano");
    }

    #[test]
    fn voice_code_lenses_count_only_matching_voice_selects() {
        let source = source().replace("A @7 c4", "A @7 @t193 @8 @7 c4\nP @7 c4");
        let uri: Uri = "file:///voice.mml".parse().unwrap();
        let lenses = code_lenses(&source, uri, Language::English);
        assert_eq!(lenses.len(), 1);
        let command = lenses[0].command.as_ref().unwrap();
        assert_eq!(command.title, "2 references");
        assert_eq!(command.command, "mmlx.showVoiceReferences");
        assert_eq!(
            command.arguments.as_ref().unwrap()[2]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
}
