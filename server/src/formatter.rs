use lsp_types::{Position, Range, TextEdit};

pub fn edits(source: &str) -> Vec<TextEdit> {
    let Ok(parsed) = mmlx::mdx::frontend::parse(source) else {
        return Vec::new();
    };

    parsed
        .syntax()
        .voices()
        .iter()
        .filter_map(|voice| {
            let number = voice.number.text(source)?;
            let parameters: Vec<u8> = voice
                .parameters
                .iter()
                .map(|span| span.text(source)?.parse().ok())
                .collect::<Option<_>>()?;
            if parameters.len() != 47 {
                return None;
            }

            let range_text = voice.span.text(source)?;
            let line_ending = if range_text.contains("\r\n") {
                "\r\n"
            } else if range_text.contains('\n') || !source.contains("\r\n") {
                "\n"
            } else {
                "\r\n"
            };
            let has_final_line_ending = range_text.ends_with('\n');
            let mut replacement = format_voice(number, &parameters, line_ending);
            if has_final_line_ending {
                replacement.push_str(line_ending);
            }

            Some(TextEdit::new(
                span_range(source, voice.span.start(), voice.span.end()),
                replacement,
            ))
        })
        .collect()
}

fn format_voice(number: &str, parameters: &[u8], line_ending: &str) -> String {
    let mut operator_widths: [usize; 11] = [2, 1, 2, 2, 2, 2, 1, 2, 2, 2, 2];
    const GLOBAL_WIDTHS: [usize; 3] = [1, 2, 2];
    for operator in parameters[..44].chunks_exact(11) {
        for (width, value) in operator_widths.iter_mut().zip(operator) {
            *width = (*width).max(value.to_string().len());
        }
    }
    let mut lines = Vec::with_capacity(7);
    lines.push(format!("@{number} = {{"));
    lines.push("    /* AR  D1R D2R RR D1L  TL KS MUL DT1 DT2 AME */".into());
    for operator in parameters[..44].chunks_exact(11) {
        let values = format_values(operator, &operator_widths, true);
        lines.push(format!("        {values}"));
    }
    lines.push("    /* CON FL OP */".into());
    lines.push(format!(
        "        {}",
        format_values(&parameters[44..], &GLOBAL_WIDTHS, false)
    ));
    lines.push("}".into());
    lines.join(line_ending)
}

fn format_values(values: &[u8], widths: &[usize], trailing_comma: bool) -> String {
    let mut formatted = values
        .iter()
        .zip(widths)
        .map(|(value, width)| format!("{value:>width$}"))
        .collect::<Vec<_>>()
        .join(", ");
    if trailing_comma {
        formatted.push(',');
    }
    formatted
}

fn span_range(source: &str, start: usize, end: usize) -> Range {
    Range::new(position_at(source, start), position_at(source, end))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> String {
        format!(
            "@1 = {{\n    /* AR D1R D2R RR D1L TL KS MUL DT1 DT2 AME */\n{}\n    /* CON FL OP */\n2, 7, 15\n}}\nA c4\n",
            [
                "28, 4, 0, 5, 1, 37, 2, 1, 7, 0, 0,",
                "22, 9, 1, 2, 1, 47, 2, 12, 0, 0, 0,",
                "29, 4, 3, 6, 1, 37, 1, 3, 3, 0, 0,",
                "15, 7, 0, 5, 10, 0, 2, 1, 0, 0, 1,",
            ]
            .join("\n")
        )
    }

    #[test]
    fn formats_voice_definitions_and_discards_their_original_comments() {
        let source = source();
        let edits = edits(&source);
        assert_eq!(edits.len(), 1);
        assert_eq!(
            edits[0].new_text,
            concat!(
                "@1 = {\n",
                "    /* AR  D1R D2R RR D1L  TL KS MUL DT1 DT2 AME */\n",
                "        28, 4,  0,  5,  1, 37, 2,  1,  7,  0,  0,\n",
                "        22, 9,  1,  2,  1, 47, 2, 12,  0,  0,  0,\n",
                "        29, 4,  3,  6,  1, 37, 1,  3,  3,  0,  0,\n",
                "        15, 7,  0,  5, 10,  0, 2,  1,  0,  0,  1,\n",
                "    /* CON FL OP */\n",
                "        2,  7, 15\n",
                "}\n"
            )
        );
        let start = crate::completion::byte_offset(&source, edits[0].range.start).unwrap();
        let end = crate::completion::byte_offset(&source, edits[0].range.end).unwrap();
        assert_eq!(&source[..start], "");
        assert_eq!(&source[end..], "A c4\n");
    }

    #[test]
    fn preserves_crlf_and_missing_final_newlines() {
        let source = source()
            .replace('\n', "\r\n")
            .split("A c4")
            .next()
            .unwrap()
            .trim_end_matches("\r\n")
            .to_owned();
        let edit = edits(&source).pop().unwrap();
        assert!(!edit.new_text.ends_with('\n'));
        assert!(edit.new_text.contains("\r\n"));
        assert!(!edit.new_text.replace("\r\n", "").contains('\n'));
        let start = crate::completion::byte_offset(&source, edit.range.start).unwrap();
        let end = crate::completion::byte_offset(&source, edit.range.end).unwrap();
        assert!(source[..start].is_empty());
        assert_eq!(&source[end..], "");
    }

    #[test]
    fn leaves_documents_without_valid_voice_definitions_unchanged() {
        assert!(edits("A c4\n").is_empty());
        assert!(edits("@1 = { 31, 2,\nA c4").is_empty());
    }
}
