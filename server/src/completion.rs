use crate::i18n::{self, Language};
use lsp_types::{
    CompletionItem, CompletionItemKind, CompletionTextEdit, Documentation, InsertTextFormat,
    MarkupContent, MarkupKind, ParameterInformation, ParameterLabel, Position, Range,
    SignatureHelp, SignatureInformation, TextEdit,
};
use mmlx::frontend::SourceFile;

struct Command {
    label: &'static str,
    snippet: &'static str,
    plain: &'static str,
    parameter_count: usize,
}

macro_rules! command {
    ($label:expr, $snippet:expr, $plain:expr, $parameter_count:expr) => {
        Command {
            label: $label,
            snippet: $snippet,
            plain: $plain,
            parameter_count: $parameter_count,
        }
    };
}

const COMMANDS: &[Command] = &[
    command!("t", "t${1:120}", "t120", 1),
    command!("@t", "@t${1:200}", "@t200", 1),
    command!("@", "@${1:0}", "@0", 1),
    command!("q", "q${1:8}", "q8", 1),
    command!("@q", "@q${1:1}", "@q1", 1),
    command!("v", "v${1:12}", "v12", 1),
    command!("@v", "@v${1:100}", "@v100", 1),
    command!("p", "p${1:3}", "p3", 1),
    command!("o", "o${1:4}", "o4", 1),
    command!("<", "<", "<", 0),
    command!(">", ">", ">", 0),
    command!("l", "l${1:4}", "l4", 1),
    command!("(", "(", "(", 0),
    command!(")", ")", ")", 0),
    command!("D", "D${1:0}", "D0", 1),
    command!("y", "y${1:15},${2:128}", "y15,128", 2),
    command!("k", "k${1:0}", "k0", 1),
    command!("w", "w${1:16}", "w16", 1),
    command!("F", "F${1:4}", "F4", 1),
    command!("S", "S${1:B}", "SB", 1),
    command!("W", "W", "W", 0),
    command!("MP", "MP${1:0},${2:16},${3:1}", "MP0,16,1", 3),
    command!("MPON", "MPON", "MPON", 0),
    command!("MPOF", "MPOF", "MPOF", 0),
    command!("MA", "MA${1:0},${2:16},${3:1}", "MA0,16,1", 3),
    command!("MAON", "MAON", "MAON", 0),
    command!("MAOF", "MAOF", "MAOF", 0),
    command!("MD", "MD${1:0}", "MD0", 1),
    command!(
        "MH",
        "MH${1:0},${2:128},${3:16},${4:0},${5:3},${6:0},${7:1}",
        "MH0,128,16,0,3,0,1",
        7
    ),
    command!("MHON", "MHON", "MHON", 0),
    command!("MHOF", "MHOF", "MHOF", 0),
    command!("L", "L", "L", 0),
    command!("[", "[${1:c4}]${2:2}", "[c4]2", 0),
    command!("]", "]${1:2}", "]2", 1),
    command!("/", "/", "/", 0),
    command!("_", "_", "_", 0),
    command!("&", "&", "&", 0),
    command!("!", "!", "!", 0),
];

const VOICE_DEFINITION_BODY: &str = r#" = {
    /* AR  D1R D2R RR D1L TL  KS MUL DT1 DT2 AME */
       28, 4,  0,  5, 1,  37, 2, 1,  7,  0,  0,
       22, 9,  1,  2, 1,  47, 2, 12, 0,  0,  0,
       29, 4,  3,  6, 1,  37, 1, 3,  3,  0,  0,
       15, 7,  0,  5, 10,  0, 2, 1,  0,  0,  1,
    /* CON FL OP */
       2,  7, 15
}"#;

pub fn items(
    source: &str,
    position: Position,
    snippets: bool,
    language: Language,
) -> Vec<CompletionItem> {
    let Some(offset) = byte_offset(source, position) else {
        return vec![];
    };
    let before = &source[..offset];
    if !in_code(before) {
        return vec![];
    }
    let line = before.rsplit('\n').next().unwrap_or("").trim_start();
    let header = line
        .bytes()
        .take_while(|byte| matches!(byte, b'A'..=b'H' | b'P'..=b'W'))
        .count();
    if header == 0 {
        return voice_definition_item(source, offset, position, snippets, language)
            .into_iter()
            .collect();
    }
    if !before.chars().last().is_some_and(char::is_whitespace)
        && let Some((command, _, arguments_start)) = signature_context(before)
        && (skip_trivia(before, arguments_start) < offset || !has_longer_command(command.label))
    {
        return vec![];
    }
    let body_start = offset - line.len() + header;
    let mut prefix_len = 0;
    for command in COMMANDS {
        for length in 1..=command.label.len() {
            if length <= offset - body_start && before.ends_with(&command.label[..length]) {
                prefix_len = prefix_len.max(length);
            }
        }
    }
    if prefix_len == 0
        && before
            .chars()
            .last()
            .is_some_and(|character| character.is_ascii_alphabetic() || character == '@')
    {
        return vec![];
    }
    let start = offset - prefix_len;
    let prefix = &source[start..offset];
    let end = if prefix_len == 0 {
        offset
    } else {
        COMMANDS
            .iter()
            .filter(|command| source[start..].starts_with(command.label))
            .map(|command| start + command.label.len())
            .filter(|end| *end >= offset)
            .max()
            .unwrap_or(offset)
    };
    let Some(file) = SourceFile::new(source) else {
        return vec![];
    };
    let index = file.line_index();
    let (start_line, start_column) = index.utf16_position(start).unwrap();
    let (end_line, end_column) = index.utf16_position(end).unwrap();
    let range = Range::new(
        Position::new(start_line as u32, start_column as u32),
        Position::new(end_line as u32, end_column as u32),
    );
    COMMANDS
        .iter()
        .filter(|command| command.label.starts_with(prefix))
        .map(|command| CompletionItem {
            label: completion_label(command, language),
            kind: Some(completion_kind(command)),
            detail: Some(command_text(command, language).0.into()),
            documentation: Some(command_documentation(command, language)),
            command: (command.parameter_count > 0).then(|| lsp_types::Command {
                title: i18n::translate(language, "ui.argument_hints"),
                command: "editor.action.triggerParameterHints".into(),
                arguments: None,
            }),
            filter_text: Some(command.label.into()),
            insert_text_format: Some(if snippets {
                InsertTextFormat::SNIPPET
            } else {
                InsertTextFormat::PLAIN_TEXT
            }),
            text_edit: Some(CompletionTextEdit::Edit(TextEdit {
                range,
                new_text: {
                    let next = source[end..].trim_start().chars().next();
                    let existing_argument = prefix_len > 0
                        && command.snippet.contains("${")
                        && next.is_some_and(|character| {
                            character.is_ascii_digit()
                                || character == '-'
                                || command.label == "S"
                                    && matches!(character, 'A'..='H' | 'P'..='W')
                        });
                    if existing_argument {
                        command.label
                    } else if snippets {
                        command.snippet
                    } else {
                        command.plain
                    }
                    .into()
                },
            })),
            ..CompletionItem::default()
        })
        .collect()
}

fn voice_definition_item(
    source: &str,
    offset: usize,
    position: Position,
    snippets: bool,
    language: Language,
) -> Option<CompletionItem> {
    let prefix = source[..offset].rsplit('\n').next()?.trim_start();
    let entered_number = prefix.strip_prefix('@')?;
    if !entered_number.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let trailing_digits = source[offset..]
        .bytes()
        .take_while(u8::is_ascii_digit)
        .count();
    let end = offset + trailing_digits;
    if source[end..].trim_start().starts_with('=') {
        return None;
    }
    let number = &source[offset - entered_number.len()..end];
    let number = if number.is_empty() { "1" } else { number };
    number.parse::<u8>().ok()?;
    let label = i18n::translate(language, "mdx.voice_definition.label");
    let syntax = i18n::translate(language, "mdx.voice_definition.syntax");
    let description = i18n::translate(language, "mdx.voice_definition.description");
    let plain = format!("@{number}{VOICE_DEFINITION_BODY}");
    Some(CompletionItem {
        label: label.into(),
        kind: Some(CompletionItemKind::SNIPPET),
        detail: Some(syntax.into()),
        documentation: Some(Documentation::MarkupContent(MarkupContent {
            kind: MarkupKind::Markdown,
            value: format!("{description}\n\n```mmlx\n{plain}\n```"),
        })),
        filter_text: Some(format!("@{number}")),
        insert_text_mode: Some(lsp_types::InsertTextMode::AS_IS),
        insert_text_format: Some(if snippets {
            InsertTextFormat::SNIPPET
        } else {
            InsertTextFormat::PLAIN_TEXT
        }),
        text_edit: Some(CompletionTextEdit::Edit(TextEdit {
            range: Range::new(
                Position::new(position.line, position.character - prefix.len() as u32),
                Position::new(position.line, position.character + trailing_digits as u32),
            ),
            new_text: if snippets {
                format!("@${{1:{number}}}{VOICE_DEFINITION_BODY}$0")
            } else {
                plain
            },
        })),
        ..CompletionItem::default()
    })
}

fn completion_kind(command: &Command) -> CompletionItemKind {
    if command
        .label
        .chars()
        .any(|character| character.is_ascii_alphabetic())
        || command.label == "@"
    {
        CompletionItemKind::FUNCTION
    } else {
        CompletionItemKind::OPERATOR
    }
}

fn command_text(command: &Command, language: Language) -> (String, String, Vec<String>) {
    i18n::command_text(
        language,
        crate::dialect::Dialect::Mdx,
        command.label,
        command.parameter_count,
    )
}

fn completion_label(command: &Command, language: Language) -> String {
    if completion_kind(command) == CompletionItemKind::FUNCTION {
        format!(
            "{}({})",
            command.label,
            command_text(command, language).2.join(", ")
        )
    } else {
        command.label.into()
    }
}

fn command_documentation(command: &Command, language: Language) -> Documentation {
    let (syntax, description, _) = command_text(command, language);
    let example = i18n::translate(language, "ui.example");
    Documentation::MarkupContent(MarkupContent {
        kind: MarkupKind::Markdown,
        value: format!(
            "`{syntax}`\n\n{description}\n\n{example}: `{}`",
            command.plain
        ),
    })
}

fn has_longer_command(label: &str) -> bool {
    COMMANDS
        .iter()
        .any(|command| command.label != label && command.label.starts_with(label))
}

pub fn signature_triggers() -> Vec<String> {
    let mut triggers: Vec<String> = COMMANDS
        .iter()
        .filter(|command| command.parameter_count > 0)
        .filter_map(|command| command.label.chars().last())
        .chain(", -+$%.0123456789".chars())
        .map(|character| character.to_string())
        .collect();
    triggers.sort();
    triggers.dedup();
    triggers
}

fn signature_context(before: &str) -> Option<(&'static Command, u32, usize)> {
    if !in_code(before) {
        return None;
    }
    let line = before.rsplit('\n').next()?.trim_start();
    let header = line
        .bytes()
        .take_while(|byte| matches!(byte, b'A'..=b'H' | b'P'..=b'W'))
        .count();
    if header == 0 {
        return None;
    }
    let body = &line[header..];
    let mut cursor = 0;
    while cursor < body.len() {
        cursor = skip_trivia(body, cursor);
        let tail = &body[cursor..];
        let Some(command) = COMMANDS
            .iter()
            .filter(|command| tail.starts_with(command.label))
            .max_by_key(|command| command.label.len())
        else {
            cursor += tail.chars().next()?.len_utf8();
            continue;
        };
        cursor += command.label.len();
        let count = command.parameter_count;
        if count == 0 {
            continue;
        }
        let arguments_start = before.len() - body.len() + cursor;
        let (consumed, active_parameter) = argument_position(&body[cursor..], command.label, count);
        cursor += consumed;
        if cursor != body.len() {
            continue;
        }
        return Some((command, active_parameter?, arguments_start));
    }
    None
}

pub fn signature_help(
    source: &str,
    position: Position,
    language: Language,
) -> Option<SignatureHelp> {
    let offset = byte_offset(source, position)?;
    let (command, active_parameter, arguments_start) = signature_context(&source[..offset])?;
    if skip_trivia(&source[..offset], arguments_start) == offset
        && has_longer_command(command.label)
    {
        return None;
    }
    let mut label = format!("{}(", command.label);
    let mut parameters = Vec::new();
    for name in command_text(command, language).2 {
        if !parameters.is_empty() {
            label.push_str(", ");
        }
        let start = label.encode_utf16().count() as u32;
        label.push_str(&name);
        let end = label.encode_utf16().count() as u32;
        parameters.push(ParameterInformation {
            label: ParameterLabel::LabelOffsets([start, end]),
            documentation: None,
        });
    }
    label.push(')');
    Some(SignatureHelp {
        signatures: vec![SignatureInformation {
            label,
            documentation: Some(command_documentation(command, language)),
            parameters: Some(parameters),
            active_parameter: Some(active_parameter),
        }],
        active_signature: Some(0),
        active_parameter: Some(active_parameter),
    })
}

fn skip_trivia(source: &str, mut cursor: usize) -> usize {
    loop {
        cursor += source[cursor..].len() - source[cursor..].trim_start().len();
        if let Some(comment) = source[cursor..].strip_prefix("/*")
            && let Some(end) = comment.find("*/")
        {
            cursor += 2 + end + 2;
        } else {
            return cursor;
        }
    }
}

fn argument_position(source: &str, command: &str, count: usize) -> (usize, Option<u32>) {
    let mut cursor = 0;
    let mut parameter = 0;
    loop {
        cursor = skip_trivia(source, cursor);
        let complete_value;
        if command == "S"
            && source
                .as_bytes()
                .get(cursor)
                .is_some_and(|byte| matches!(byte, b'A'..=b'H' | b'P'..=b'W'))
        {
            cursor += 1;
            complete_value = true;
        } else if command == "l" {
            let value_start = cursor;
            while source.as_bytes().get(cursor).is_some_and(|byte| {
                byte.is_ascii_digit() || matches!(byte, b'%' | b'.' | b'^' | b'~')
            }) {
                cursor += 1;
            }
            let value = &source[value_start..cursor];
            complete_value = value.bytes().any(|byte| byte.is_ascii_digit())
                && value
                    .as_bytes()
                    .last()
                    .is_some_and(|byte| byte.is_ascii_digit() || *byte == b'.');
        } else {
            if source
                .as_bytes()
                .get(cursor)
                .is_some_and(|byte| matches!(byte, b'-' | b'+'))
            {
                cursor += 1;
            }
            let hex = source.as_bytes().get(cursor) == Some(&b'$');
            if hex {
                cursor += 1;
            }
            let digits_start = cursor;
            while source.as_bytes().get(cursor).is_some_and(|byte| {
                if hex {
                    byte.is_ascii_hexdigit()
                } else {
                    byte.is_ascii_digit()
                }
            }) {
                cursor += 1;
            }
            complete_value = cursor > digits_start;
        }
        cursor = skip_trivia(source, cursor);
        if cursor == source.len() {
            if complete_value
                && parameter + 1 == count
                && source.chars().last().is_some_and(char::is_whitespace)
            {
                return (cursor, None);
            }
            return (cursor, Some(parameter as u32));
        }
        if source.as_bytes()[cursor] != b',' {
            return (cursor, None);
        }
        cursor += 1;
        parameter += 1;
        if parameter >= count {
            return (cursor, None);
        }
    }
}

fn byte_offset(source: &str, position: Position) -> Option<usize> {
    let mut line_start = 0;
    for _ in 0..position.line {
        line_start += source.get(line_start..)?.find('\n')? + 1;
    }
    let line = source
        .get(line_start..)?
        .split('\n')
        .next()?
        .trim_end_matches('\r');
    let mut units = 0;
    for (offset, character) in line.char_indices() {
        if units == position.character {
            return Some(line_start + offset);
        }
        units += character.len_utf16() as u32;
    }
    (units == position.character).then_some(line_start + line.len())
}

fn in_code(source: &str) -> bool {
    let mut characters = source.chars().peekable();
    let mut block = false;
    let mut line_comment = false;
    let mut string = false;
    let mut voice_depth = 0usize;
    while let Some(character) = characters.next() {
        if block {
            if character == '*' && characters.peek() == Some(&'/') {
                characters.next();
                block = false;
            }
        } else if line_comment {
            if character == '\n' {
                line_comment = false;
            }
        } else if string {
            if character == '"' {
                string = false;
            }
        } else {
            match character {
                '/' if characters.peek() == Some(&'*') => {
                    characters.next();
                    block = true;
                }
                ';' | '!' => line_comment = true,
                '"' => string = true,
                '{' => voice_depth += 1,
                '}' => voice_depth = voice_depth.saturating_sub(1),
                _ => {}
            }
        }
    }
    !block && !line_comment && !string && voice_depth == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn items(source: &str, position: Position, snippets: bool) -> Vec<CompletionItem> {
        super::items(source, position, snippets, Language::Japanese)
    }

    fn signature_help(source: &str, position: Position) -> Option<SignatureHelp> {
        super::signature_help(source, position, Language::Japanese)
    }

    fn command_documentation(command: &Command) -> Documentation {
        super::command_documentation(command, Language::Japanese)
    }

    #[test]
    fn voice_definition_completion_preserves_values_and_voice_numbers() {
        let lines: Vec<_> = VOICE_DEFINITION_BODY.lines().collect();
        assert_eq!(lines[1].find("AR"), Some(7));
        for line in &lines[2..6] {
            assert_eq!(line.len() - line.trim_start().len(), 7);
        }
        assert_eq!(lines[6].find("CON"), Some(7));
        assert_eq!(lines[7].len() - lines[7].trim_start().len(), 7);
        for (source, position, number, start, end) in [
            ("@", Position::new(0, 1), "1", 0, 1),
            ("@12", Position::new(0, 3), "12", 0, 3),
            ("@12", Position::new(0, 1), "12", 0, 3),
            ("  @7", Position::new(0, 4), "7", 2, 4),
            ("; \u{1f3b5}\r\n@", Position::new(1, 1), "1", 0, 1),
        ] {
            for snippets in [false, true] {
                let result = items(source, position, snippets);
                assert_eq!(result.len(), 1, "{source}");
                let item = &result[0];
                assert_eq!(item.kind, Some(CompletionItemKind::SNIPPET));
                assert_eq!(
                    item.insert_text_mode,
                    Some(lsp_types::InsertTextMode::AS_IS)
                );
                assert!(item.command.is_none());
                let Some(CompletionTextEdit::Edit(edit)) = &item.text_edit else {
                    panic!("expected voice definition edit");
                };
                assert_eq!(
                    edit.range,
                    Range::new(
                        Position::new(position.line, start),
                        Position::new(position.line, end)
                    )
                );
                let plain = format!("@{number}{VOICE_DEFINITION_BODY}");
                if snippets {
                    assert_eq!(
                        edit.new_text,
                        format!("@${{1:{number}}}{VOICE_DEFINITION_BODY}$0")
                    );
                } else {
                    assert_eq!(edit.new_text, plain);
                }
                let parsed = mmlx::mdx::parse(&format!("{plain}\nA @{number} c4")).unwrap();
                assert_eq!(parsed.voices.len(), 1);
                assert!(mmlx::mdx::compile(&parsed).is_ok());
            }
        }
        let japanese = items("@", Position::new(0, 1), true);
        let english = super::items("@", Position::new(0, 1), true, Language::English);
        assert_eq!(english[0].label, "@ Voice definition");
        assert_eq!(english[0].text_edit, japanese[0].text_edit);
    }

    #[test]
    fn voice_definition_completion_does_not_replace_existing_definitions() {
        for (source, position) in [
            ("@1 = {", Position::new(0, 2)),
            ("@1\n = {", Position::new(0, 2)),
            ("@1 = {\n@", Position::new(1, 1)),
            ("; @", Position::new(0, 3)),
            ("/* @", Position::new(0, 4)),
            ("#title \"@", Position::new(0, 9)),
            ("@t", Position::new(0, 2)),
            ("@256", Position::new(0, 4)),
        ] {
            assert!(items(source, position, true).is_empty(), "{source}");
        }
        assert!(
            items("A @", Position::new(0, 3), true)
                .iter()
                .all(|item| item.kind != Some(CompletionItemKind::SNIPPET))
        );
    }

    #[test]
    fn japanese_messages_space_words_and_numbers_but_not_punctuation() {
        let voice = COMMANDS
            .iter()
            .find(|command| command.label == "@")
            .unwrap();
        assert_eq!(
            command_text(voice, Language::Japanese).1,
            "FM トラックでは音色番号、PCM トラックでは PDX バンク番号を選択します。FM 音色のレジスター設定は次の発音時に適用されます。"
        );
        let japanese_letter = |character| matches!(character, '\u{3041}'..='\u{3096}' | '\u{30a1}'..='\u{30fa}' | '\u{4e00}'..='\u{9fff}');
        for command in COMMANDS {
            let (syntax, description, parameters) = command_text(command, Language::Japanese);
            for message in [description, syntax].into_iter().chain(parameters) {
                let characters: Vec<_> = message.chars().collect();
                for pair in characters.windows(2) {
                    assert!(
                        !(pair[0].is_ascii_alphanumeric() && japanese_letter(pair[1])
                            || japanese_letter(pair[0]) && pair[1].is_ascii_alphanumeric()),
                        "{}: {message}",
                        command.label
                    );
                }
                for punctuation in ['、', '。', '・'] {
                    assert!(!message.contains(&format!(" {punctuation}")));
                    assert!(!message.contains(&format!("{punctuation} ")));
                }
            }
        }
    }

    #[test]
    fn formulas_use_code_style_in_both_languages() {
        let formulas: &[(&str, &[&str])] = &[
            ("q", &["N / 8", "floor((note_ticks - 1) * N / 8) + 1"]),
            ("@q", &["256 - N", "max(1, note_ticks - N)"]),
            ("@v", &["255 - N", "127 - N"]),
            ("l", &["192 / 4 = 48"]),
        ];
        for (label, expressions) in formulas {
            let command = COMMANDS
                .iter()
                .find(|command| command.label == *label)
                .unwrap();
            for language in [Language::Japanese, Language::English] {
                let description = command_text(command, language).1;
                for expression in *expressions {
                    assert!(
                        description.contains(&format!("`{expression}`")),
                        "{label}: {description}"
                    );
                }
            }
        }
    }

    #[test]
    fn catalogs_cover_every_command_and_parameter() {
        for command in COMMANDS {
            for language in [Language::Japanese, Language::English] {
                let mut keys = vec![
                    format!("mdx.commands.{}.syntax", command.label),
                    format!("mdx.commands.{}.description", command.label),
                ];
                keys.extend(
                    (0..command.parameter_count)
                        .map(|index| format!("mdx.commands.{}.parameters.p{index}", command.label)),
                );
                for key in keys {
                    assert_ne!(
                        i18n::translate(language, &key),
                        key,
                        "{}",
                        language.locale()
                    );
                }
            }
        }
    }

    #[test]
    fn english_catalog_is_complete_and_does_not_change_insertion() {
        let japanese = items("A ", Position::new(0, 2), true);
        let english = super::items("A ", Position::new(0, 2), true, Language::English);
        assert_eq!(english.len(), COMMANDS.len());
        for ((command, japanese), english) in COMMANDS.iter().zip(&japanese).zip(&english) {
            let text = command_text(command, Language::English);
            assert_eq!(text.2.len(), command.parameter_count, "{}", command.label);
            assert!(english.label.is_ascii());
            assert!(english.detail.as_ref().unwrap().is_ascii());
            assert!(
                matches!(&english.documentation, Some(Documentation::MarkupContent(content)) if content.value.is_ascii() && content.value.contains("Example:"))
            );
            assert_eq!(japanese.text_edit, english.text_edit);
            assert_eq!(japanese.filter_text, english.filter_text);
            assert_eq!(japanese.kind, english.kind);
        }
    }

    #[test]
    fn english_signature_recomputes_parameter_offsets() {
        let help = super::signature_help("A MP0,", Position::new(0, 6), Language::English).unwrap();
        assert_eq!(help.signatures[0].label, "MP(waveform, period, depth)");
        assert_eq!(help.active_parameter, Some(1));
        assert_eq!(
            help.signatures[0].parameters.as_ref().unwrap()[1].label,
            ParameterLabel::LabelOffsets([13, 19])
        );
        assert!(
            matches!(&help.signatures[0].documentation, Some(Documentation::MarkupContent(content)) if content.value.contains("software pitch LFO"))
        );
    }

    fn hint(source: &str) -> Option<SignatureHelp> {
        let line = source.bytes().filter(|byte| *byte == b'\n').count() as u32;
        let column = source.rsplit('\n').next().unwrap().encode_utf16().count() as u32;
        signature_help(source, Position::new(line, column))
    }

    #[test]
    fn trailing_whitespace_confirms_the_last_argument() {
        for source in [
            "A [c4]2 ",
            "A t120 ",
            "A @q123 ",
            "A MP0,16,1 ",
            "A MH0,128,16,0,3,0,1\t",
            "A SB ",
            "A y$1B,$80 ",
            "A l4. ",
        ] {
            assert!(hint(source).is_none(), "{source}");
            assert!(
                !items(source, Position::new(0, source.len() as u32), true).is_empty(),
                "{source}"
            );
        }
        for source in [
            "A t ",
            "A D- ",
            "A y$ ",
            "A MP0, ",
            "A MP0,16, ",
            "A MP0,16,- ",
            "A t120",
            "A [c4]2",
        ] {
            assert!(hint(source).is_some(), "{source}");
        }
    }

    #[test]
    fn signatures_follow_incomplete_arguments_and_command_boundaries() {
        for (source, label, parameter) in [
            ("A t", "t(BPM)", 0),
            ("A MP0,", "MP(波形, 周期, 深さ)", 1),
            (
                "A MH0,128,",
                "MH(波形, LFRQ, PMD, AMD, PMS, AMS, キー同期)",
                2,
            ),
            ("A c4MP0,16,-", "MP(波形, 周期, 深さ)", 2),
            ("A y$1B,$D", "y(レジスター, 値)", 1),
            ("A SS", "S(チャンネル)", 0),
            ("A t120 o", "o(オクターブ)", 0),
        ] {
            let help = hint(source).unwrap();
            assert_eq!(help.signatures[0].label, label, "{source}");
            assert_eq!(help.active_parameter, Some(parameter), "{source}");
        }
        for source in [
            "A t120 c4",
            "A t120 L",
            "A MPON",
            "A MHOF",
            "A MP0,16,1,",
            "A MP0,; comment",
            "#title \"t",
            "@0={\nA t",
            "A !t",
            "A /* t",
        ] {
            assert!(hint(source).is_none(), "{source}");
        }
    }

    #[test]
    fn signature_ranges_use_utf16_and_comments_do_not_become_commands() {
        let help = hint("A /* \u{1f3b5} t */ MP0, /* MH */ 16,").unwrap();
        assert_eq!(help.active_parameter, Some(2));
        let parameters = help.signatures[0].parameters.as_ref().unwrap();
        assert_eq!(parameters[1].label, ParameterLabel::LabelOffsets([7, 9]));
        assert!(
            matches!(&help.signatures[0].documentation, Some(Documentation::MarkupContent(content)) if content.value.contains("- **周期**:"))
        );
        assert!(signature_help("A t", Position::new(1, 0)).is_none());
        assert_eq!(
            hint("A c4\r\nB @q").unwrap().signatures[0].label,
            "@q(ゲート値)"
        );
    }

    #[test]
    fn multi_parameter_descriptions_document_arguments_in_order() {
        for command in COMMANDS
            .iter()
            .filter(|command| command.parameter_count > 1)
        {
            for language in [Language::Japanese, Language::English] {
                let (_, description, names) = command_text(command, language);
                let argument_lines: Vec<_> = description
                    .lines()
                    .filter(|line| line.starts_with("- **"))
                    .collect();
                assert_eq!(argument_lines.len(), names.len(), "{}", command.label);
                for (name, line) in names.iter().zip(argument_lines) {
                    let prefix = format!("- **{name}**: ");
                    assert!(
                        line.strip_prefix(&prefix)
                            .is_some_and(|text| !text.trim().is_empty()),
                        "{}: {line}",
                        command.label
                    );
                }
                let documentation = super::command_documentation(command, language);
                assert!(
                    matches!(&documentation, Documentation::MarkupContent(content)
                        if content.kind == MarkupKind::Markdown && content.value.contains(&description))
                );
                let item = super::items("A ", Position::new(0, 2), true, language)
                    .into_iter()
                    .find(|item| item.filter_text.as_deref() == Some(command.label))
                    .unwrap();
                assert_eq!(item.documentation, Some(documentation.clone()));
                let source = format!("A {}", command.plain);
                let help =
                    super::signature_help(&source, Position::new(0, source.len() as u32), language)
                        .unwrap();
                assert_eq!(help.signatures[0].documentation, Some(documentation));
            }
        }
    }

    #[test]
    fn argument_signatures_match_catalog_snippets_and_trigger_hints() {
        for command in COMMANDS {
            let names = command_text(command, Language::Japanese).2;
            if names.is_empty() {
                continue;
            }
            assert_eq!(
                names.len(),
                command.snippet.matches("${").count(),
                "{}",
                command.label
            );
            let source = format!("A {}", command.plain);
            let help = hint(&source).unwrap();
            assert_eq!(
                help.signatures[0].parameters.as_ref().unwrap().len(),
                names.len()
            );
            assert_eq!(
                help.signatures[0].documentation,
                Some(command_documentation(command))
            );
            let source = "A ";
            let completions = items(&source, Position::new(0, source.len() as u32), true);
            let item = completions
                .iter()
                .find(|item| item.filter_text.as_deref() == Some(command.label))
                .unwrap();
            assert_eq!(
                item.command.as_ref().unwrap().command,
                "editor.action.triggerParameterHints"
            );
        }
        assert!(signature_triggers().contains(&",".into()));
        assert!(signature_triggers().contains(&"t".into()));
    }

    #[test]
    fn argument_input_keeps_hints_without_offering_commands() {
        for source in [
            "A t",
            "A @q",
            "A @q123t",
            "A c4t",
            "A @q123",
            "A t120",
            "A MP0,",
            "A MP0,16,-",
            "A y$1B,$D",
            "A SS",
            "A SD",
            "A l%48.",
            "A /* \u{1f3b5} */ @q123",
        ] {
            let column = source.encode_utf16().count() as u32;
            assert!(
                items(source, Position::new(0, column), true).is_empty(),
                "{source}"
            );
            assert!(
                signature_help(source, Position::new(0, column)).is_some(),
                "{source}"
            );
        }
        for source in ["A @", "A @q123 ", "A MP0,16,1MA", "A c4MP"] {
            let column = source.encode_utf16().count() as u32;
            assert!(
                !items(source, Position::new(0, column), true).is_empty(),
                "{source}"
            );
        }
        assert!(items("A @q123", Position::new(0, 5), true).is_empty());
        assert!(!items("A @q123", Position::new(0, 3), true).is_empty());
    }

    #[test]
    fn ambiguous_names_show_candidates_instead_of_argument_hints() {
        for source in ["A @", "A MP", "A MA", "A MH"] {
            let column = source.len() as u32;
            assert!(
                !items(source, Position::new(0, column), true).is_empty(),
                "{source}"
            );
            assert!(
                signature_help(source, Position::new(0, column)).is_none(),
                "{source}"
            );
        }
    }

    #[test]
    fn incomplete_command_does_not_require_a_valid_ast() {
        let result = items("A @", Position::new(0, 3), true);
        assert!(result.iter().any(|item| item.label == "@q(ゲート値)"));
        let item = result
            .iter()
            .find(|item| item.filter_text.as_deref() == Some("@q"))
            .unwrap();
        let Some(CompletionTextEdit::Edit(edit)) = &item.text_edit else {
            panic!("expected text edit");
        };
        assert_eq!(
            edit.range,
            Range::new(Position::new(0, 2), Position::new(0, 3))
        );
        assert_eq!(edit.new_text, "@q${1:1}");
        let result = items("A ", Position::new(0, 2), false);
        let item = result
            .iter()
            .find(|item| item.filter_text.as_deref() == Some("t"))
            .unwrap();
        assert_eq!(item.label, "t(BPM)");
        assert_eq!(item.insert_text_format, Some(InsertTextFormat::PLAIN_TEXT));
    }

    #[test]
    fn suppresses_non_track_contexts_and_comments() {
        for source in [
            "",
            "A",
            "#title \"t",
            "; A t",
            "A /* t",
            "@0={\nA t",
            "A ! t",
        ] {
            let line = source.bytes().filter(|byte| *byte == b'\n').count() as u32;
            let column = source.rsplit('\n').next().unwrap().encode_utf16().count() as u32;
            assert!(
                items(source, Position::new(line, column), true).is_empty(),
                "{source}"
            );
        }
    }

    #[test]
    fn utf16_positions_and_invalid_offsets_are_handled() {
        let source = "A /* \u{1f3b5} */ @q";
        let result = items(source, Position::new(0, 12), true);
        let Some(CompletionTextEdit::Edit(edit)) = &result[0].text_edit else {
            panic!("expected text edit");
        };
        assert_eq!(edit.range.start, Position::new(0, 11));
        assert!(items(source, Position::new(0, 6), true).is_empty());
        assert!(items(source, Position::new(1, 0), true).is_empty());
    }

    #[test]
    fn default_examples_parse_and_compile() {
        for command in COMMANDS {
            let source = match command.label {
                "]" => format!("A [c4 {}", command.plain),
                "/" => "A [c4/d4]2".into(),
                "F" => format!("P {} c4", command.plain),
                _ => format!("A {} c4", command.plain),
            };
            let parsed = mmlx::mdx::parse(&source).unwrap();
            assert!(mmlx::mdx::compile(&parsed).is_ok(), "{source}");
        }
    }

    #[test]
    fn replaces_a_complete_command_when_cursor_is_in_its_middle() {
        let result = items("A MPON c4", Position::new(0, 4), true);
        let item = result.iter().find(|item| item.label == "MPOF()").unwrap();
        let Some(CompletionTextEdit::Edit(edit)) = &item.text_edit else {
            panic!("expected text edit");
        };
        assert_eq!(
            edit.range,
            Range::new(Position::new(0, 2), Position::new(0, 6))
        );
        assert_eq!(edit.new_text, "MPOF");
        assert_eq!(items("A c4MP", Position::new(0, 6), true).len(), 3);
    }

    #[test]
    fn preserves_arguments_already_present_after_the_cursor() {
        for (source, prefix, label) in [
            ("A MP0,16,1 c4", "MP", "MP"),
            ("A MH0,128,16,0,3,0,1", "MH", "MH"),
            ("A @q8", "@", "@q"),
        ] {
            let column = 2 + prefix.len() as u32;
            let result = items(source, Position::new(0, column), true);
            let item = result
                .iter()
                .find(|item| item.filter_text.as_deref() == Some(label))
                .unwrap();
            let Some(CompletionTextEdit::Edit(edit)) = &item.text_edit else {
                panic!("expected text edit");
            };
            assert_eq!(edit.new_text, label);
            assert_eq!(edit.range.end.character, 2 + label.len() as u32);
        }
    }

    #[test]
    fn function_and_operator_labels_do_not_change_mml_insertion() {
        for (source, label, filter, kind, inserted) in [
            (
                "A ",
                "t(BPM)",
                "t",
                CompletionItemKind::FUNCTION,
                "t${1:120}",
            ),
            (
                "A MP",
                "MP(波形, 周期, 深さ)",
                "MP",
                CompletionItemKind::FUNCTION,
                "MP${1:0},${2:16},${3:1}",
            ),
            (
                "A MPON",
                "MPON()",
                "MPON",
                CompletionItemKind::FUNCTION,
                "MPON",
            ),
            (
                "A [",
                "[",
                "[",
                CompletionItemKind::OPERATOR,
                "[${1:c4}]${2:2}",
            ),
        ] {
            let result = items(source, Position::new(0, source.len() as u32), true);
            let item = result.iter().find(|item| item.label == label).unwrap();
            assert_eq!(item.kind, Some(kind));
            assert_eq!(item.filter_text.as_deref(), Some(filter));
            let Some(CompletionTextEdit::Edit(edit)) = &item.text_edit else {
                panic!("expected text edit");
            };
            assert_eq!(edit.new_text, inserted);
        }
    }
}
