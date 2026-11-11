use crate::completion::byte_offset;
use crate::i18n::Language;
use lsp_types::{
    CodeLens, Command, CompletionItem, CompletionItemKind, CompletionTextEdit, Documentation,
    InsertTextFormat, Location, MarkupContent, MarkupKind, Position, Range, TextEdit, Uri,
};
use mmlx::frontend::SourceFile;
use serde_json::json;

struct MacroDefinition {
    name: u8,
    name_start: usize,
    body_start: usize,
    body_end: usize,
}

type MacroReference = (u8, usize, usize);

pub fn completion_items(source: &str, position: Position) -> Option<Vec<CompletionItem>> {
    let offset = byte_offset(source, position)?;
    let (token_start, token_end, prefix) = macro_token_range(source, offset)?;
    let definitions = scan(source)
        .0
        .into_iter()
        .filter(|definition| definition.name_start < token_start)
        .filter(|definition| (definition.name as char).to_string().starts_with(&prefix))
        .collect::<Vec<_>>();
    let Some(file) = SourceFile::new(source) else {
        return Some(Vec::new());
    };
    let index = file.line_index();
    let Some((start_line, start_column)) = index.utf16_position(token_start) else {
        return Some(Vec::new());
    };
    let Some((end_line, end_column)) = index.utf16_position(token_end) else {
        return Some(Vec::new());
    };
    let range = Range::new(
        Position::new(start_line as u32, start_column as u32),
        Position::new(end_line as u32, end_column as u32),
    );

    Some(
        definitions
            .into_iter()
            .map(|definition| {
                let label = format!("${}", definition.name as char);
                let body = &source[definition.body_start..definition.body_end];
                CompletionItem {
                    label: label.clone(),
                    kind: Some(CompletionItemKind::REFERENCE),
                    detail: Some("MML macro".into()),
                    documentation: Some(Documentation::MarkupContent(MarkupContent {
                        kind: MarkupKind::Markdown,
                        value: format!("Expands to:\n```mmlx\n{}\n```", body.trim()),
                    })),
                    filter_text: Some(label.clone()),
                    insert_text_format: Some(InsertTextFormat::PLAIN_TEXT),
                    text_edit: Some(CompletionTextEdit::Edit(TextEdit {
                        range,
                        new_text: label,
                    })),
                    ..CompletionItem::default()
                }
            })
            .collect(),
    )
}

pub fn definition_completion_item(
    source: &str,
    offset: usize,
    snippets: bool,
    language: Language,
) -> Option<CompletionItem> {
    let line_start = source[..offset].rfind('\n').map_or(0, |index| index + 1);
    let line_end = source[offset..]
        .find('\n')
        .map_or(source.len(), |index| offset + index);
    let line = source.get(line_start..line_end)?.trim_end_matches('\r');
    let leading = line.len() - line.trim_start_matches([' ', '\t']).len();
    let dollar = line_start + leading;
    if source.as_bytes().get(dollar) != Some(&b'$') || offset <= dollar || offset > dollar + 2 {
        return None;
    }

    let bytes = source.as_bytes();
    let mut name_end = dollar + 1;
    while bytes.get(name_end).is_some_and(u8::is_ascii_uppercase) {
        name_end += 1;
    }
    if name_end > dollar + 2
        || offset > name_end
        || !source[dollar + 1..offset]
            .bytes()
            .all(|byte| byte.is_ascii_uppercase())
    {
        return None;
    }
    let mut assignment = name_end;
    while bytes
        .get(assignment)
        .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
    {
        assignment += 1;
    }
    if bytes.get(assignment) == Some(&b'=') {
        return None;
    }

    let used_names: Vec<_> = scan(source)
        .0
        .into_iter()
        .map(|definition| definition.name)
        .collect();
    let typed_name = if name_end == dollar + 2 {
        Some(bytes[dollar + 1])
    } else {
        None
    };
    let name = typed_name
        .filter(|name| !used_names.contains(name))
        .or_else(|| (b'A'..=b'Z').find(|name| !used_names.contains(name)))?;
    let name = char::from(name);
    let label = crate::i18n::translate(language, "mdx.macro_definition.label");
    let syntax = crate::i18n::translate(language, "mdx.macro_definition.syntax");
    let description = crate::i18n::translate(language, "mdx.macro_definition.description");
    let plain = format!("${name}={{o4 c4}}");
    let start = position_at(source, dollar)?;
    let end = position_at(source, name_end)?;
    Some(CompletionItem {
        label,
        kind: Some(CompletionItemKind::SNIPPET),
        detail: Some(syntax),
        documentation: Some(Documentation::MarkupContent(MarkupContent {
            kind: MarkupKind::Markdown,
            value: format!("{description}\n\n```mmlx\n{plain}\n```"),
        })),
        filter_text: Some(source[dollar..offset].to_owned()),
        insert_text_mode: Some(lsp_types::InsertTextMode::AS_IS),
        insert_text_format: Some(if snippets {
            InsertTextFormat::SNIPPET
        } else {
            InsertTextFormat::PLAIN_TEXT
        }),
        text_edit: Some(CompletionTextEdit::Edit(TextEdit {
            range: Range::new(start, end),
            new_text: if snippets {
                format!("\\$${{1:{name}}}=") + "${2:o4 c4}}$0"
            } else {
                plain
            },
        })),
        ..CompletionItem::default()
    })
}

pub fn code_lenses(source: &str, uri: Uri, language: Language) -> Vec<CodeLens> {
    if mmlx::mdx::frontend::parse(source).is_err() {
        return Vec::new();
    }
    let (definitions, references) = scan(source);

    definitions
        .into_iter()
        .filter_map(|definition| {
            let macro_references = references
                .iter()
                .filter(|(name, _, _)| *name == definition.name)
                .map(|(_, start, end)| {
                    Some(Location::new(
                        uri.clone(),
                        span_range(source, *start, *end)?,
                    ))
                })
                .collect::<Option<Vec<_>>>()?;
            let position = position_at(source, definition.name_start)?;
            let count = macro_references.len();
            let title = if count == 1 {
                rust_i18n::t!("mdx.macro_reference.one", locale = language.locale()).to_string()
            } else {
                rust_i18n::t!(
                    "mdx.macro_reference.many",
                    locale = language.locale(),
                    count = count
                )
                .to_string()
            };
            Some(CodeLens {
                range: span_range(source, definition.name_start, definition.name_start + 2)?,
                command: Some(Command {
                    title,
                    command: "mmlx.showMacroReferences".into(),
                    arguments: Some(vec![json!(uri), json!(position), json!(macro_references)]),
                }),
                data: None,
            })
        })
        .collect()
}

fn scan(source: &str) -> (Vec<MacroDefinition>, Vec<MacroReference>) {
    let mut definitions = Vec::new();
    let mut references = Vec::new();
    let mut in_block_comment = false;
    let mut line_start = 0;

    for line_with_ending in source.split_inclusive('\n') {
        let line = line_with_ending.trim_end_matches(&['\r', '\n'][..]);
        let track_body = (!in_block_comment)
            .then(|| track_body_start(line))
            .flatten();
        if track_body.is_none()
            && !in_block_comment
            && let Some(definition) = parse_definition(line, line_start)
        {
            definitions.push(definition);
            scan_line(line, line_start, &mut in_block_comment, None);
        } else {
            let start = track_body.unwrap_or(0);
            scan_line(
                &line[start..],
                line_start + start,
                &mut in_block_comment,
                track_body.map(|_| &mut references),
            );
        }
        line_start += line_with_ending.len();
    }

    (definitions, references)
}

fn parse_definition(line: &str, line_start: usize) -> Option<MacroDefinition> {
    let bytes = line.as_bytes();
    let mut cursor = line.len() - line.trim_start_matches([' ', '\t']).len();
    if bytes.get(cursor) != Some(&b'$') {
        return None;
    }
    let name_start = cursor;
    let name = *bytes.get(cursor + 1)?;
    if !name.is_ascii_uppercase() {
        return None;
    }
    cursor += 2;
    skip_horizontal_space(bytes, &mut cursor);
    if bytes.get(cursor) != Some(&b'=') {
        return None;
    }
    cursor += 1;
    skip_horizontal_space(bytes, &mut cursor);
    if bytes.get(cursor) != Some(&b'{') {
        return None;
    }
    cursor += 1;
    let body_start = cursor;
    let mut in_block_comment = false;
    while cursor < bytes.len() {
        if in_block_comment {
            if bytes.get(cursor..cursor + 2) == Some(b"*/") {
                in_block_comment = false;
                cursor += 2;
            } else {
                cursor += 1;
            }
        } else if bytes.get(cursor..cursor + 2) == Some(b"/*") {
            in_block_comment = true;
            cursor += 2;
        } else if bytes[cursor] == b'}' {
            return Some(MacroDefinition {
                name,
                name_start: line_start + name_start,
                body_start: line_start + body_start,
                body_end: line_start + cursor,
            });
        } else {
            cursor += 1;
        }
    }
    None
}

fn skip_horizontal_space(bytes: &[u8], cursor: &mut usize) {
    while bytes
        .get(*cursor)
        .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
    {
        *cursor += 1;
    }
}

fn track_body_start(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut cursor = 0;
    while bytes
        .get(cursor)
        .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
    {
        cursor += 1;
    }
    let channel_start = cursor;
    while bytes
        .get(cursor)
        .is_some_and(|byte| matches!(byte, b'A'..=b'H' | b'P'..=b'W'))
    {
        cursor += 1;
    }
    (cursor > channel_start).then_some(cursor)
}

fn scan_line(
    line: &str,
    line_start: usize,
    in_block_comment: &mut bool,
    mut references: Option<&mut Vec<MacroReference>>,
) {
    let bytes = line.as_bytes();
    let mut cursor = 0;
    let mut in_string = false;
    while cursor < bytes.len() {
        if *in_block_comment {
            if bytes.get(cursor..cursor + 2) == Some(b"*/") {
                *in_block_comment = false;
                cursor += 2;
            } else {
                cursor += 1;
            }
        } else if in_string {
            if bytes[cursor] == b'"' {
                in_string = false;
            }
            cursor += 1;
        } else if bytes.get(cursor..cursor + 2) == Some(b"/*") {
            *in_block_comment = true;
            cursor += 2;
        } else if bytes[cursor] == b';' {
            break;
        } else if bytes[cursor] == b'"' {
            in_string = true;
            cursor += 1;
        } else if bytes[cursor] == b'$' && bytes.get(cursor + 1).is_some_and(u8::is_ascii_uppercase)
        {
            if let Some(references) = references.as_mut() {
                (**references).push((
                    bytes[cursor + 1],
                    line_start + cursor,
                    line_start + cursor + 2,
                ));
            }
            cursor += 2;
        } else {
            cursor += 1;
        }
    }
}

fn macro_token_range(source: &str, offset: usize) -> Option<(usize, usize, String)> {
    let line_start = source[..offset].rfind('\n').map_or(0, |index| index + 1);
    let line_end = source[offset..]
        .find('\n')
        .map_or(source.len(), |index| offset + index);
    let line = &source[line_start..line_end];
    let body_start = track_body_start(line)? + line_start;
    if offset < body_start {
        return None;
    }

    let bytes = source.as_bytes();
    let mut token_end = offset;
    while bytes.get(token_end).is_some_and(u8::is_ascii_uppercase) {
        token_end += 1;
    }
    let mut token_start = offset;
    while token_start > body_start
        && bytes
            .get(token_start - 1)
            .is_some_and(u8::is_ascii_uppercase)
    {
        token_start -= 1;
    }
    let dollar = if token_start > body_start && bytes.get(token_start - 1) == Some(&b'$') {
        token_start - 1
    } else if offset > body_start && bytes.get(offset - 1) == Some(&b'$') {
        offset - 1
    } else {
        return None;
    };
    if !is_code_at(source, dollar) {
        return None;
    }
    Some((dollar, token_end, source[dollar + 1..offset].to_owned()))
}

fn is_code_at(source: &str, offset: usize) -> bool {
    let bytes = source.as_bytes();
    let mut cursor = 0;
    let mut in_block_comment = false;
    let mut in_string = false;
    while cursor < offset {
        if in_block_comment {
            if bytes.get(cursor..cursor + 2) == Some(b"*/") {
                in_block_comment = false;
                cursor += 2;
            } else {
                cursor += 1;
            }
        } else if in_string {
            if bytes[cursor] == b'"' {
                in_string = false;
            }
            cursor += 1;
        } else if bytes.get(cursor..cursor + 2) == Some(b"/*") {
            in_block_comment = true;
            cursor += 2;
        } else if bytes[cursor] == b';' {
            let Some(newline) = source[cursor..offset].find('\n') else {
                return false;
            };
            cursor += newline + 1;
        } else if bytes[cursor] == b'"' {
            in_string = true;
            cursor += 1;
        } else {
            cursor += 1;
        }
    }
    !in_block_comment && !in_string
}

fn span_range(source: &str, start: usize, end: usize) -> Option<Range> {
    Some(Range::new(
        position_at(source, start)?,
        position_at(source, end)?,
    ))
}

fn position_at(source: &str, offset: usize) -> Option<Position> {
    let file = SourceFile::new(source)?;
    let (line, character) = file.line_index().utf16_position(offset)?;
    Some(Position::new(line as u32, character as u32))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uri() -> Uri {
        "file:///test.mml".parse().unwrap()
    }

    #[test]
    fn completion_offers_only_previously_defined_macros_in_track_code() {
        let source = "$A={o4 c4}\nB $A $\n$B={o5 d4}\n";
        let position = Position::new(1, 6);
        let items = completion_items(source, position).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].label, "$A");
        let after_name = completion_items(source, Position::new(1, 4)).unwrap();
        assert_eq!(after_name[0].label, "$A");
        assert!(completion_items(source, Position::new(0, 3)).is_none());
    }

    #[test]
    fn definition_completion_offers_a_unique_macro_template_outside_tracks() {
        let source = "$A={o4 c4}\n$";
        let item =
            definition_completion_item(source, source.len(), true, Language::English).unwrap();
        assert_eq!(item.label, "Macro definition");
        assert_eq!(item.detail.as_deref(), Some("$<A-Z> = { ... }"));
        let Some(CompletionTextEdit::Edit(edit)) = item.text_edit else {
            panic!("expected macro definition edit");
        };
        assert_eq!(edit.new_text, "\\$${1:B}=${2:o4 c4}}$0");
        assert_eq!(
            definition_completion_item("A $", 3, true, Language::English),
            None
        );
    }

    #[test]
    fn code_lenses_count_macro_calls_but_ignore_comments_and_strings() {
        let source = "#title \"$B\"\n; $C\n/* $D */\n$A={o4 c4}\nA $A $A /* $A */\nB $A\n";
        let lenses = code_lenses(source, uri(), Language::English);
        assert_eq!(lenses.len(), 1);
        let command = lenses[0].command.as_ref().unwrap();
        assert_eq!(command.command, "mmlx.showMacroReferences");
        assert_eq!(command.title, "3 references");
        let references = command.arguments.as_ref().unwrap()[2].as_array().unwrap();
        assert_eq!(references.len(), 3);
    }
}
