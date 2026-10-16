use std::collections::HashMap;
use std::error::Error;

use lsp_server::{Connection, ErrorCode, Message, Notification, Request, Response};
#[cfg(test)]
use lsp_types::Uri;
use lsp_types::{
    CodeLensParams, CompletionParams, DidChangeTextDocumentParams, DidCloseTextDocumentParams,
    DidOpenTextDocumentParams, DocumentFormattingParams, DocumentSymbolParams, InitializeParams,
    PublishDiagnosticsParams, SelectionRangeParams, SemanticTokensParams, SignatureHelpParams,
    TextDocumentPositionParams,
};
#[cfg(test)]
use mmlx_lsp_server::diagnostics as mdx_diagnostics;
use mmlx_lsp_server::{
    dialect::Dialect, i18n, playback::state as playback_state, track_length, voice,
};

fn main() -> Result<(), Box<dyn Error>> {
    #[cfg(target_os = "wasi")]
    let _ = std::fs::metadata("/workspace");

    let (connection, threads) = Connection::stdio();
    let (params, dialect) = initialize(&connection)?;
    let language = i18n::Language::from_initialize(&params);
    let snippets = params
        .capabilities
        .text_document
        .and_then(|capabilities| capabilities.completion)
        .and_then(|completion| completion.completion_item)
        .and_then(|item| item.snippet_support)
        .unwrap_or(false);

    let mut documents: HashMap<String, String> = HashMap::new();
    for message in &connection.receiver {
        match message {
            Message::Request(request) => {
                if connection.handle_shutdown(&request)? {
                    break;
                }
                connection.sender.send(Message::Response(handle_request(
                    request, &documents, snippets, language, dialect,
                )))?;
            }
            Message::Notification(notification) => {
                if let Err(error) =
                    handle_notification(&connection, &mut documents, notification, dialect)
                {
                    eprintln!("mmlx-lsp: {error}");
                }
            }
            Message::Response(_) => {}
        }
    }
    drop(connection);
    threads.join()?;
    Ok(())
}

fn initialize(connection: &Connection) -> Result<(InitializeParams, Dialect), Box<dyn Error>> {
    loop {
        let (id, raw_params) = connection.initialize_start()?;
        let params: InitializeParams = match serde_json::from_value(raw_params) {
            Ok(params) => params,
            Err(error) => {
                connection.sender.send(Message::Response(Response::new_err(
                    id,
                    ErrorCode::InvalidParams as i32,
                    error.to_string(),
                )))?;
                continue;
            }
        };
        let dialect = match Dialect::from_initialize(&params) {
            Ok(dialect) => dialect,
            Err(error) => {
                connection.sender.send(Message::Response(Response::new_err(
                    id,
                    ErrorCode::InvalidParams as i32,
                    error.message(i18n::Language::from_initialize(&params)),
                )))?;
                continue;
            }
        };
        connection.initialize_finish(
            id,
            serde_json::json!({ "capabilities": dialect.capabilities() }),
        )?;
        return Ok((params, dialect));
    }
}

fn handle_request(
    request: Request,
    documents: &HashMap<String, String>,
    snippets: bool,
    language: i18n::Language,
    dialect: Dialect,
) -> Response {
    if request.method == "mmlx/playbackState" {
        return match serde_json::from_value::<playback_state::PlaybackStateRequest>(request.params)
        {
            Ok(params) => Response::new_ok(
                request.id,
                playback_state::scan(&params.source, params.offset, params.initial_state),
            ),
            Err(error) => Response::new_err(
                request.id,
                ErrorCode::InvalidParams as i32,
                error.to_string(),
            ),
        };
    }
    if request.method == "mmlx/voiceAtPosition" {
        return match serde_json::from_value::<TextDocumentPositionParams>(request.params) {
            Ok(params) => {
                let source = documents
                    .get(params.text_document.uri.as_str())
                    .map(String::as_str)
                    .unwrap_or("");
                Response::new_ok(request.id, voice::at_position(source, params.position))
            }
            Err(error) => Response::new_err(
                request.id,
                ErrorCode::InvalidParams as i32,
                error.to_string(),
            ),
        };
    }
    if request.method == "mmlx/trackLengthAtPosition" {
        return match serde_json::from_value::<TextDocumentPositionParams>(request.params) {
            Ok(params) => {
                let result = documents
                    .get(params.text_document.uri.as_str())
                    .and_then(|source| track_length::at_position(source, params.position));
                Response::new_ok(request.id, result)
            }
            Err(error) => Response::new_err(
                request.id,
                ErrorCode::InvalidParams as i32,
                error.to_string(),
            ),
        };
    }
    if request.method == "mmlx/trackLengthInRange" {
        return match serde_json::from_value::<track_length::TrackLengthRangeParams>(request.params)
        {
            Ok(params) => {
                let result = documents
                    .get(params.text_document.uri.as_str())
                    .and_then(|source| track_length::in_range(source, params.range));
                Response::new_ok(request.id, result)
            }
            Err(error) => Response::new_err(
                request.id,
                ErrorCode::InvalidParams as i32,
                error.to_string(),
            ),
        };
    }
    if request.method == "textDocument/codeLens" {
        return match serde_json::from_value::<CodeLensParams>(request.params) {
            Ok(params) => {
                let lenses = documents
                    .get(params.text_document.uri.as_str())
                    .map(|source| voice::code_lenses(source, params.text_document.uri, language))
                    .unwrap_or_default();
                Response::new_ok(request.id, lenses)
            }
            Err(error) => Response::new_err(
                request.id,
                ErrorCode::InvalidParams as i32,
                error.to_string(),
            ),
        };
    }
    if request.method == "textDocument/documentSymbol" {
        return match serde_json::from_value::<DocumentSymbolParams>(request.params) {
            Ok(params) => {
                let symbols = documents
                    .get(params.text_document.uri.as_str())
                    .map(|source| voice::document_symbols(source))
                    .unwrap_or_default();
                Response::new_ok(request.id, symbols)
            }
            Err(error) => Response::new_err(
                request.id,
                ErrorCode::InvalidParams as i32,
                error.to_string(),
            ),
        };
    }
    if request.method == "textDocument/signatureHelp" {
        return match serde_json::from_value::<SignatureHelpParams>(request.params) {
            Ok(params) => {
                let source = documents
                    .get(
                        params
                            .text_document_position_params
                            .text_document
                            .uri
                            .as_str(),
                    )
                    .map(String::as_str)
                    .unwrap_or("");
                Response::new_ok(
                    request.id,
                    dialect.signature_help(
                        source,
                        params.text_document_position_params.position,
                        language,
                    ),
                )
            }
            Err(error) => Response::new_err(
                request.id,
                ErrorCode::InvalidParams as i32,
                error.to_string(),
            ),
        };
    }
    if request.method == "textDocument/completion" {
        return match serde_json::from_value::<CompletionParams>(request.params) {
            Ok(params) => {
                let source = documents
                    .get(params.text_document_position.text_document.uri.as_str())
                    .map(String::as_str)
                    .unwrap_or("");
                Response::new_ok(
                    request.id,
                    dialect.completions(
                        source,
                        params.text_document_position.position,
                        snippets,
                        language,
                    ),
                )
            }
            Err(error) => Response::new_err(
                request.id,
                ErrorCode::InvalidParams as i32,
                error.to_string(),
            ),
        };
    }
    if request.method == "textDocument/semanticTokens/full" {
        return match serde_json::from_value::<SemanticTokensParams>(request.params) {
            Ok(params) => {
                let source = documents
                    .get(params.text_document.uri.as_str())
                    .map(String::as_str)
                    .unwrap_or("");
                Response::new_ok(request.id, dialect.semantic_tokens(source))
            }
            Err(error) => Response::new_err(
                request.id,
                ErrorCode::InvalidParams as i32,
                error.to_string(),
            ),
        };
    }
    if request.method == "textDocument/selectionRange" {
        return match serde_json::from_value::<SelectionRangeParams>(request.params) {
            Ok(params) => {
                let selections = documents
                    .get(params.text_document.uri.as_str())
                    .and_then(|source| dialect.selection_ranges(source, &params.positions));
                Response::new_ok(request.id, selections)
            }
            Err(error) => Response::new_err(
                request.id,
                ErrorCode::InvalidParams as i32,
                error.to_string(),
            ),
        };
    }
    if request.method == "textDocument/formatting" {
        return match serde_json::from_value::<DocumentFormattingParams>(request.params) {
            Ok(params) => {
                let edits = documents
                    .get(params.text_document.uri.as_str())
                    .map(|source| dialect.formatting_edits(source))
                    .unwrap_or_default();
                Response::new_ok(request.id, edits)
            }
            Err(error) => Response::new_err(
                request.id,
                ErrorCode::InvalidParams as i32,
                error.to_string(),
            ),
        };
    }
    Response::new_err(
        request.id,
        ErrorCode::MethodNotFound as i32,
        format!("Unsupported request: {}", request.method),
    )
}

fn handle_notification(
    connection: &Connection,
    documents: &mut HashMap<String, String>,
    notification: Notification,
    dialect: Dialect,
) -> Result<(), Box<dyn Error>> {
    let publication = match notification.method.as_str() {
        "textDocument/didOpen" => {
            let params: DidOpenTextDocumentParams = serde_json::from_value(notification.params)?;
            let document = params.text_document;
            let errors = dialect.diagnostics(&document.text);
            documents.insert(document.uri.to_string(), document.text);
            Some(PublishDiagnosticsParams::new(
                document.uri,
                errors,
                Some(document.version),
            ))
        }
        "textDocument/didChange" => {
            let params: DidChangeTextDocumentParams = serde_json::from_value(notification.params)?;
            params.content_changes.into_iter().last().map(|change| {
                let errors = dialect.diagnostics(&change.text);
                documents.insert(params.text_document.uri.to_string(), change.text);
                PublishDiagnosticsParams::new(
                    params.text_document.uri,
                    errors,
                    Some(params.text_document.version),
                )
            })
        }
        "textDocument/didClose" => {
            let params: DidCloseTextDocumentParams = serde_json::from_value(notification.params)?;
            documents.remove(params.text_document.uri.as_str());
            Some(PublishDiagnosticsParams::new(
                params.text_document.uri,
                vec![],
                None,
            ))
        }
        _ => None,
    };
    if let Some(params) = publication {
        connection
            .sender
            .send(Message::Notification(Notification::new(
                "textDocument/publishDiagnostics".into(),
                params,
            )))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lsp_types::{Diagnostic, DiagnosticSeverity, NumberOrString, Position, Range};
    use soundlog::mdx::convert::MdxPlaybackCheckLimits;

    fn diagnostics(source: &str) -> Vec<Diagnostic> {
        Dialect::Mdx.diagnostics(source)
    }

    fn handle_notification(
        connection: &Connection,
        documents: &mut HashMap<String, String>,
        notification: Notification,
    ) -> Result<(), Box<dyn Error>> {
        super::handle_notification(connection, documents, notification, Dialect::Mdx)
    }

    fn handle_request(
        request: Request,
        documents: &HashMap<String, String>,
        snippets: bool,
    ) -> Response {
        super::handle_request(
            request,
            documents,
            snippets,
            i18n::Language::Japanese,
            Dialect::Mdx,
        )
    }

    #[test]
    fn voice_request_validates_positions_and_returns_null_for_unknown_documents() {
        let documents = HashMap::new();
        let response = handle_request(
            Request::new(
                1.into(),
                "mmlx/voiceAtPosition".into(),
                serde_json::json!({ "textDocument": { "uri": "file:///voice.mml" },
                "position": { "line": 0, "character": 0 } }),
            ),
            &documents,
            false,
        );
        assert_eq!(response.response_result.unwrap(), serde_json::Value::Null);
        let response = handle_request(
            Request::new(
                2.into(),
                "mmlx/voiceAtPosition".into(),
                serde_json::json!({}),
            ),
            &documents,
            false,
        );
        assert_eq!(
            response.response_result.unwrap_err().code,
            ErrorCode::InvalidParams as i32
        );
    }

    #[test]
    fn document_symbol_request_returns_named_voice_definitions() {
        let source = format!(
            "; Grand Piano\n@7 = {{\n{}\n5,3,15\n}}\n",
            "31,12,4,8,6,20,1,2,3,1,0,\n".repeat(4)
        );
        let documents = HashMap::from([("file:///voice.mml".to_owned(), source)]);
        let response = handle_request(
            Request::new(
                1.into(),
                "textDocument/documentSymbol".into(),
                serde_json::json!({
                    "textDocument": { "uri": "file:///voice.mml" }
                }),
            ),
            &documents,
            false,
        );
        let symbols = response.response_result.unwrap();
        assert_eq!(symbols[0]["name"], "@7 Grand Piano");
        assert_eq!(symbols[0]["kind"], 19);
    }

    #[test]
    fn playback_state_request_uses_the_mml_parser_and_returns_typed_state() {
        let source = "#title \"🎵 t200\"\nA t120 l8 o5 c4 ; t130 l4 o3\nB /* @t42 l2 o2 */ d4\nC @t48 e4\nD t180 f4";
        let offset = source.find("D t180").unwrap();
        let response = handle_request(
            Request::new(
                1.into(),
                "mmlx/playbackState".into(),
                serde_json::json!({ "source": source, "offset": offset }),
            ),
            &HashMap::new(),
            false,
        );
        assert_eq!(
            response.response_result.unwrap(),
            serde_json::json!({
                "state": { "tempo": "@t48", "length": "l8", "octave": 5 },
                "hasTempo": true,
                "hasLength": true,
                "hasOctave": true,
                "hasVolume": false,
                "hasGate": false,
                "hasPan": false,
                "hasOpmLfo": false
            })
        );

        let invalid = handle_request(
            Request::new(
                2.into(),
                "mmlx/playbackState".into(),
                serde_json::json!({ "source": "A invalid???", "offset": 12 }),
            ),
            &HashMap::new(),
            false,
        );
        assert_eq!(invalid.response_result.unwrap(), serde_json::Value::Null);
    }

    #[test]
    fn formatting_request_formats_voice_definitions_without_changing_other_mml() {
        let uri = "file:///voice.mml".parse::<Uri>().unwrap();
        let source = format!(
            "@7 = {{\n/* labels */\n{}\n5, 3, 15\n}}\nA c4\n",
            "31, 12, 4, 8, 6, 20, 1, 2, 3, 1, 0,\n".repeat(4)
        );
        let documents = HashMap::from([(uri.to_string(), source.clone())]);
        let response = handle_request(
            Request::new(
                1.into(),
                "textDocument/formatting".into(),
                serde_json::json!({
                    "textDocument": { "uri": uri },
                    "options": { "tabSize": 4, "insertSpaces": true },
                }),
            ),
            &documents,
            false,
        );
        let edits: Vec<lsp_types::TextEdit> =
            serde_json::from_value(response.response_result.unwrap()).unwrap();
        assert_eq!(edits.len(), 1);
        assert!(edits[0].new_text.starts_with("@7 = {"));
        assert!(
            edits[0]
                .new_text
                .contains("        31, 12,  4,  8,  6, 20, 1,  2,  3,  1,  0,")
        );
        assert!(edits[0].new_text.contains("    /* CON FL OP */"));
        assert!(!edits[0].new_text.contains("labels"));
        let start = 0;
        let end = source.find("A c4\n").unwrap();
        assert_eq!(&source[..start], "");
        assert_eq!(&source[end..], "A c4\n");
    }

    #[test]
    fn formatting_request_is_a_noop_for_documents_without_voice_definitions() {
        let uri = "file:///track.mml".parse::<Uri>().unwrap();
        let documents = HashMap::from([(uri.to_string(), "A c4\n".to_string())]);
        let response = handle_request(
            Request::new(
                1.into(),
                "textDocument/formatting".into(),
                serde_json::json!({
                    "textDocument": { "uri": uri },
                    "options": { "tabSize": 4, "insertSpaces": true },
                }),
            ),
            &documents,
            false,
        );
        assert_eq!(response.response_result.unwrap(), serde_json::json!([]));
    }

    #[test]
    fn initialization_selects_mdx_with_or_without_an_explicit_option() {
        for options in [
            serde_json::Value::Null,
            serde_json::json!({ "dialect": "mdx" }),
        ] {
            std::thread::scope(|scope| {
                let (server, client) = Connection::memory();
                let worker = scope.spawn(move || super::initialize(&server).unwrap().1);
                client
                    .sender
                    .send(Message::Request(Request::new(
                        1.into(),
                        "initialize".into(),
                        serde_json::json!({
                            "capabilities": {}, "initializationOptions": options,
                        }),
                    )))
                    .unwrap();
                let Message::Response(response) = client
                    .receiver
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap()
                else {
                    panic!("Expected initialize response");
                };
                let capabilities = &response.response_result.unwrap()["capabilities"];
                assert_eq!(capabilities["positionEncoding"], "utf-16");
                assert_eq!(capabilities["semanticTokensProvider"]["full"], true);
                assert_eq!(capabilities["documentFormattingProvider"], true);
                client
                    .sender
                    .send(Message::Notification(Notification::new(
                        "initialized".into(),
                        serde_json::json!({}),
                    )))
                    .unwrap();
                assert_eq!(worker.join().unwrap(), Dialect::Mdx);
            });
        }
    }

    #[test]
    fn initialization_rejects_unknown_dialects_and_allows_a_corrected_request() {
        for (language, expected) in [
            ("en", "Unsupported MML dialect"),
            ("ja", "未対応の MML 方言"),
        ] {
            std::thread::scope(|scope| {
                let (server, client) = Connection::memory();
                let worker = scope.spawn(move || super::initialize(&server).unwrap().1);
                client
                    .sender
                    .send(Message::Request(Request::new(
                        1.into(),
                        "initialize".into(),
                        serde_json::json!({
                            "capabilities": {},
                            "initializationOptions": { "dialect": "future", "language": language },
                        }),
                    )))
                    .unwrap();
                let Message::Response(response) = client
                    .receiver
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap()
                else {
                    panic!("Expected initialize error");
                };
                assert_eq!(response.id, 1.into());
                let error = response.response_result.unwrap_err();
                assert_eq!(error.code, ErrorCode::InvalidParams as i32);
                assert!(error.message.starts_with(expected), "{}", error.message);
                assert!(error.message.contains("future") && error.message.contains("mdx"));
                client
                    .sender
                    .send(Message::Request(Request::new(
                        2.into(),
                        "initialize".into(),
                        serde_json::json!({
                            "capabilities": {}, "initializationOptions": { "dialect": "mdx" },
                        }),
                    )))
                    .unwrap();
                let Message::Response(response) = client
                    .receiver
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap()
                else {
                    panic!("Expected corrected initialize response");
                };
                assert_eq!(response.id, 2.into());
                assert!(response.response_result.is_ok());
                client
                    .sender
                    .send(Message::Notification(Notification::new(
                        "initialized".into(),
                        serde_json::json!({}),
                    )))
                    .unwrap();
                assert_eq!(worker.join().unwrap(), Dialect::Mdx);
            });
        }
    }

    #[test]
    fn requests_use_the_selected_session_language() {
        let uri = "file:///english.mml".parse::<Uri>().unwrap();
        let documents = HashMap::from([(uri.to_string(), "A MP0,".to_string())]);
        for (language, label) in [
            (i18n::Language::Japanese, "MP(波形, 周期, 深さ)"),
            (i18n::Language::English, "MP(waveform, period, depth)"),
        ] {
            let response = super::handle_request(
                Request::new(
                    1.into(),
                    "textDocument/signatureHelp".into(),
                    serde_json::json!({
                        "textDocument": { "uri": uri }, "position": { "line": 0, "character": 6 }
                    }),
                ),
                &documents,
                false,
                language,
                Dialect::Mdx,
            );
            let help: lsp_types::SignatureHelp =
                serde_json::from_value(response.response_result.unwrap()).unwrap();
            assert_eq!(help.signatures[0].label, label);
        }
    }

    #[test]
    fn track_length_request_returns_cursor_ticks_and_loop_state() {
        let uri = "file:///length.mml".parse::<Uri>().unwrap();
        let documents = HashMap::from([(uri.to_string(), "A l8 c d [e r]2\n".to_string())]);
        let response = super::handle_request(
            Request::new(
                1.into(),
                "mmlx/trackLengthAtPosition".into(),
                serde_json::json!({
                    "textDocument": { "uri": uri }, "position": { "line": 0, "character": 0 }
                }),
            ),
            &documents,
            false,
            i18n::Language::English,
            Dialect::Mdx,
        );
        assert_eq!(
            response.response_result.unwrap(),
            serde_json::json!({ "channel": "A", "ticks": 0, "looping": false })
        );
    }

    #[test]
    fn track_length_range_request_returns_longest_selected_track_duration() {
        let uri = "file:///length.mml".parse::<Uri>().unwrap();
        let documents = HashMap::from([(uri.to_string(), "A c4 d4\nB c1\n".to_string())]);
        let response = super::handle_request(
            Request::new(
                1.into(),
                "mmlx/trackLengthInRange".into(),
                serde_json::json!({
                    "textDocument": { "uri": uri },
                    "range": {
                        "start": { "line": 0, "character": 0 },
                        "end": { "line": 1, "character": 4 }
                    }
                }),
            ),
            &documents,
            false,
            i18n::Language::English,
            Dialect::Mdx,
        );
        assert_eq!(
            response.response_result.unwrap(),
            serde_json::json!({ "ticks": 192, "looping": false })
        );
    }

    #[test]
    fn valid_mml_has_no_diagnostics() {
        let source = format!("@0 = {{ {} }}\nA c4 d4 e4", vec!["0"; 47].join(","));
        assert!(diagnostics(&source).is_empty());
        assert!(diagnostics("A c4 d4 e4").is_empty());
        assert!(diagnostics("A r4").is_empty());
    }

    #[test]
    fn voice_parameter_range_violations_are_warnings_without_rejecting_compile() {
        let mut parameters = [0; 47];
        parameters[0] = 32;
        parameters[5] = 128;
        parameters[44] = 8;
        parameters[45] = 9;
        parameters[46] = 16;
        let source = format!(
            "@7 = {{ {} }}",
            parameters
                .iter()
                .map(u8::to_string)
                .collect::<Vec<_>>()
                .join(",")
        );

        let parsed = mmlx::mdx::frontend::parse(&source).unwrap();
        assert!(mmlx::mdx::frontend::compile(&parsed).is_ok());

        let warnings = diagnostics(&source);
        assert_eq!(warnings.len(), 5);
        let expected = [
            ("OP1 AR", "32"),
            ("OP1 TL", "128"),
            ("CON", "8"),
            ("FL", "9"),
            ("OP", "16"),
        ];
        for (warning, (parameter, value)) in warnings.iter().zip(expected) {
            assert_eq!(warning.severity, Some(DiagnosticSeverity::WARNING));
            assert_eq!(
                warning.code,
                Some(NumberOrString::String(
                    "mmlx.mdx.voice-value-out-of-range".into()
                ))
            );
            assert!(warning.message.contains(parameter), "{}", warning.message);
            assert!(warning.message.contains(value), "{}", warning.message);
        }
        for (warning, (_, value)) in warnings.iter().zip(expected) {
            let start = warning.range.start.character as usize;
            let end = warning.range.end.character as usize;
            assert_eq!(&source[start..end], value);
        }
    }

    #[test]
    fn invalid_mml_has_a_located_error() {
        let errors = diagnostics("A [");
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].severity, Some(DiagnosticSeverity::ERROR));
        assert_eq!(errors[0].range.start, Position::new(0, 2));
        assert_eq!(errors[0].source.as_deref(), Some("mmlx"));
    }

    #[test]
    fn crlf_and_unicode_do_not_shift_following_line() {
        let errors = diagnostics("#title \"\u{65e5}\u{1f3b5}\"\r\nA [");
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].range.start, Position::new(1, 2));
    }

    #[test]
    fn undefined_voices_are_reported() {
        let source = "A @1 c4";
        assert!(mmlx::mdx::frontend::parse(source).is_ok());
        let errors = diagnostics(source);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].severity, Some(DiagnosticSeverity::ERROR));
        assert!(errors[0].message.contains("missing tone for voice 1"));
        assert_eq!(
            errors[0].range,
            Range::new(Position::new(0, 5), Position::new(0, 7))
        );
    }

    #[test]
    fn playback_errors_preserve_source_positions() {
        for (source, start) in [
            ("A @42 c4", Position::new(0, 6)),
            ("A k2 @42 c4", Position::new(0, 9)),
            ("AP r4\nA @42 c4\nP c4", Position::new(1, 6)),
            ("AB r4\nB @42 [r4 [c%600]2]3", Position::new(1, 11)),
            (
                "#title \"\u{65e5}\u{1f3b5}\"\r\nA /* \u{65e5}\u{1f3b5} */ @42 c4",
                Position::new(1, 16),
            ),
            ("A @42 c4_>d4 e4", Position::new(0, 6)),
        ] {
            let errors = diagnostics(source);
            assert_eq!(errors.len(), 1, "{source}");
            assert!(
                errors[0].message.contains("missing tone for voice 42"),
                "{source}: {}",
                errors[0].message
            );
            assert_eq!(errors[0].range.start, start, "{source}");
        }
        assert!(diagnostics("A c4").is_empty());
    }

    #[test]
    fn playback_accepts_defined_voices_and_dummy_pcm_banks() {
        let source = format!("A @42 c4\n@42 = {{ {} }}", vec!["0"; 47].join(","));
        assert!(diagnostics(&source).is_empty());
        for source in [
            "#pcmfile \"does-not-exist.pdx\"\nP c4",
            "P @2 c4\nQ @4 d4",
            "P @31 c4",
            "P L c4",
        ] {
            assert!(diagnostics(source).is_empty(), "{source}");
        }
    }

    #[test]
    fn playback_rejects_pcm_banks_outside_the_pdx_range() {
        let errors = diagnostics("P @32 c4");
        assert_eq!(errors.len(), 1);
        assert_eq!(
            errors[0].code,
            Some(NumberOrString::String("mmlx.mdx.playback-setup".into()))
        );
        assert!(errors[0].message.contains("failed to prepare dummy PDX"));
    }

    #[test]
    fn playback_reports_budget_exhaustion_instead_of_success() {
        let errors = diagnostics("A W");
        assert_eq!(errors.len(), 1);
        assert_eq!(
            errors[0].code,
            Some(NumberOrString::String(
                "mmlx.mdx.playback-check-incomplete".into()
            ))
        );
        for (limits, message) in [
            (
                MdxPlaybackCheckLimits {
                    max_ticks: 1,
                    max_commands: 1000,
                },
                "tick limit exceeded",
            ),
            (
                MdxPlaybackCheckLimits {
                    max_ticks: 1000,
                    max_commands: 1,
                },
                "MDX command limit exceeded",
            ),
        ] {
            let parsed = mmlx::mdx::frontend::parse("A [r4]2").unwrap();
            let compiled = mmlx::mdx::frontend::compile(&parsed).unwrap();
            let error = mdx_diagnostics::check_compiled_playback(compiled, limits).unwrap_err();
            assert_eq!(error.code, "mmlx.mdx.playback-check-incomplete");
            assert!(error.message.contains(message), "{error}");
            if limits.max_commands == 1 {
                assert_eq!(error.span.unwrap().text("A [r4]2"), Some("r4"));
            }
        }
    }

    #[test]
    fn compile_errors_are_reported() {
        let source = "A /* \u{65e5}\u{1f3b5} */ o0 c";
        assert!(mmlx::mdx::frontend::parse(source).is_ok());
        let errors = diagnostics(source);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].range.start, Position::new(0, 15));
        assert_eq!(errors[0].range.end, Position::new(0, 16));
        assert!(matches!(&errors[0].code,
            Some(NumberOrString::String(code)) if code.starts_with("mmlx.mdx.")));
    }

    #[test]
    fn signature_requests_follow_cached_text_and_reject_invalid_params() {
        let uri = "file:///arguments.mml".parse::<Uri>().unwrap();
        let mut documents = HashMap::new();
        for (source, parameter) in [("A MP0,", 1), ("A MP0,16,", 2)] {
            documents.insert(uri.to_string(), source.to_string());
            let response = handle_request(
                Request::new(
                    1.into(),
                    "textDocument/signatureHelp".into(),
                    serde_json::json!({
                        "textDocument": { "uri": uri },
                        "position": { "line": 0, "character": source.len() }
                    }),
                ),
                &documents,
                false,
            );
            let help: lsp_types::SignatureHelp =
                serde_json::from_value(response.response_result.unwrap()).unwrap();
            assert_eq!(help.active_parameter, Some(parameter));
        }
        documents.clear();
        let response = handle_request(
            Request::new(
                2.into(),
                "textDocument/signatureHelp".into(),
                serde_json::json!({
                    "textDocument": { "uri": uri }, "position": { "line": 0, "character": 0 }
                }),
            ),
            &documents,
            false,
        );
        assert_eq!(response.response_result.unwrap(), serde_json::Value::Null);
        let response = handle_request(
            Request::new(
                3.into(),
                "textDocument/signatureHelp".into(),
                serde_json::json!({}),
            ),
            &documents,
            false,
        );
        assert_eq!(
            response.response_result.unwrap_err().code,
            ErrorCode::InvalidParams as i32
        );
    }

    #[test]
    fn document_lifecycle_publishes_versions_and_clears_errors() {
        let (server, client) = Connection::memory();
        let uri = "file:///example.mml";
        let notifications = [
            (
                "textDocument/didOpen",
                serde_json::json!({
                    "textDocument": { "uri": uri, "languageId": "mmlx", "version": 1, "text": "A [" }
                }),
                Some(1),
                1,
            ),
            (
                "textDocument/didChange",
                serde_json::json!({
                    "textDocument": { "uri": uri, "version": 2 },
                    "contentChanges": [{ "text": "A c4" }]
                }),
                Some(2),
                0,
            ),
            (
                "textDocument/didClose",
                serde_json::json!({
                    "textDocument": { "uri": uri }
                }),
                None,
                0,
            ),
        ];
        let mut documents = HashMap::new();
        for (method, params, version, count) in notifications {
            handle_notification(
                &server,
                &mut documents,
                Notification::new(method.into(), params),
            )
            .unwrap();
            assert_eq!(documents.contains_key(uri), version.is_some());
            let Message::Notification(notification) = client.receiver.try_recv().unwrap() else {
                panic!("expected diagnostics notification");
            };
            assert_eq!(notification.method, "textDocument/publishDiagnostics");
            let published: PublishDiagnosticsParams =
                serde_json::from_value(notification.params).unwrap();
            assert_eq!(published.uri.as_str(), uri);
            assert_eq!(published.version, version);
            assert_eq!(published.diagnostics.len(), count);
            let response = handle_request(
                Request::new(
                    1.into(),
                    "textDocument/semanticTokens/full".into(),
                    serde_json::json!({ "textDocument": { "uri": uri } }),
                ),
                &documents,
                false,
            );
            let tokens: lsp_types::SemanticTokens =
                serde_json::from_value(response.response_result.unwrap()).unwrap();
            assert_eq!(tokens.data.len(), if version == Some(2) { 2 } else { 0 });
        }
    }
}
