use lsp_types::{Position, Range};
use serde_json::{Value, json};

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
    let limits = [31, 31, 31, 15, 15, 127, 3, 15, 7, 3, 1];
    if parameters[..44]
        .iter()
        .zip(limits.iter().cycle())
        .any(|(value, limit)| value > limit)
        || parameters[44] > 7
        || parameters[45] > 7
        || parameters[46] > 15
    {
        return None;
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
        "operators": operators,
        "position": position_at(source, voice.span.start()),
        "range": Range::new(
            position_at(source, voice.span.start()),
            position_at(source, voice.span.start() + voice.span.text(source)?.trim_end().len()),
        ),
        "parameterRanges": parameter_ranges,
    }))
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
        }
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
        let invalid = source.replace("31,12", "32,12");
        assert!(at_position(&invalid, position(&invalid, invalid.find("@7").unwrap())).is_none());
    }
}
