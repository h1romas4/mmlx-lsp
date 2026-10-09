mod completion;
mod dialect;
mod i18n;
mod nanodrive;
mod semantic;
mod voice;

rust_i18n::i18n!("locales", fallback = "ja");

use std::collections::{BTreeSet, HashMap};
use std::error::Error;

use dialect::Dialect;
use lsp_server::{Connection, ErrorCode, Message, Notification, Request, Response};
use lsp_types::{
    CompletionParams, Diagnostic, DiagnosticSeverity, DidChangeTextDocumentParams,
    DidCloseTextDocumentParams, DidOpenTextDocumentParams, InitializeParams, NumberOrString,
    Position, PublishDiagnosticsParams, Range, SemanticTokensParams, SignatureHelpParams,
    TextDocumentPositionParams, Uri,
};
use mmlx::diagnostic::Severity;
use mmlx::frontend::SourceFile;
use mmlx::mdx::frontend::{CompiledMdx, MdxLocation};
use soundlog::mdx::command::MdxCommand;
use soundlog::mdx::convert::{
    MdxPlaybackCheckError, MdxPlaybackCheckLimits, MdxToVgmOptions, check_playback,
};
use soundlog::mdx::document::MdxDocument;
use soundlog::mdx::package::MdxPackage;
use soundlog::mdx::pdx::{PdxBuilder, PdxDocument};

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

    let mut documents = HashMap::new();
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
    documents: &HashMap<Uri, String>,
    snippets: bool,
    language: i18n::Language,
    dialect: Dialect,
) -> Response {
    if request.method == "mmlx/nanodrive" {
        return match nanodrive::handle(request.params) {
            Ok(result) => Response::new_ok(request.id, result),
            Err(error) => Response::new_err(request.id, ErrorCode::InvalidParams as i32, error),
        };
    }
    if request.method == "mmlx/voiceAtPosition" {
        return match serde_json::from_value::<TextDocumentPositionParams>(request.params) {
            Ok(params) => {
                let source = documents
                    .get(&params.text_document.uri)
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
    if request.method == "textDocument/signatureHelp" {
        return match serde_json::from_value::<SignatureHelpParams>(request.params) {
            Ok(params) => {
                let source = documents
                    .get(&params.text_document_position_params.text_document.uri)
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
                    .get(&params.text_document_position.text_document.uri)
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
                    .get(&params.text_document.uri)
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
    Response::new_err(
        request.id,
        ErrorCode::MethodNotFound as i32,
        format!("Unsupported request: {}", request.method),
    )
}

fn handle_notification(
    connection: &Connection,
    documents: &mut HashMap<Uri, String>,
    notification: Notification,
    dialect: Dialect,
) -> Result<(), Box<dyn Error>> {
    let publication = match notification.method.as_str() {
        "textDocument/didOpen" => {
            let params: DidOpenTextDocumentParams = serde_json::from_value(notification.params)?;
            let document = params.text_document;
            let errors = dialect.diagnostics(&document.text);
            documents.insert(document.uri.clone(), document.text);
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
                documents.insert(params.text_document.uri.clone(), change.text);
                PublishDiagnosticsParams::new(
                    params.text_document.uri,
                    errors,
                    Some(params.text_document.version),
                )
            })
        }
        "textDocument/didClose" => {
            let params: DidCloseTextDocumentParams = serde_json::from_value(notification.params)?;
            documents.remove(&params.text_document.uri);
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

fn mdx_diagnostics(source: &str) -> Vec<Diagnostic> {
    let result = mmlx::mdx::frontend::parse(source)
        .and_then(|parsed| mmlx::mdx::frontend::compile(&parsed))
        .and_then(|compiled| check_compiled_playback(compiled, MdxPlaybackCheckLimits::default()));
    match result {
        Ok(()) => vec![],
        Err(error) => vec![to_lsp_diagnostic(source, error)],
    }
}

fn check_compiled_playback(
    compiled: CompiledMdx<'_>,
    limits: MdxPlaybackCheckLimits,
) -> Result<(), mmlx::diagnostic::Diagnostic> {
    let pdx = dummy_pdx(compiled.document()).map_err(|error| {
        mmlx::diagnostic::Diagnostic::error(
            "mmlx.mdx.playback-setup",
            format!("failed to prepare dummy PDX: {error}"),
            None,
        )
    })?;
    let (mdx, source_map) = compiled.into_parts();
    check_playback(
        &MdxPackage { mdx, pdx },
        MdxToVgmOptions {
            loop_count: Some(1),
            ..Default::default()
        },
        limits,
    )
    .map_err(|error| {
        let (code, track, command_index) = match &error {
            MdxPlaybackCheckError::Conversion {
                track,
                command_index,
                ..
            } => ("mmlx.mdx.playback", *track, *command_index),
            MdxPlaybackCheckError::LimitExceeded {
                track,
                command_index,
                ..
            } => ("mmlx.mdx.playback-check-incomplete", *track, *command_index),
        };
        let span = track
            .zip(command_index)
            .and_then(|(track, index)| source_map.get(&MdxLocation::TrackCommand { track, index }));
        mmlx::diagnostic::Diagnostic::error(code, error.to_string(), span)
    })
}

fn dummy_pdx(mdx: &MdxDocument) -> Result<Option<PdxDocument>, soundlog::ParseError> {
    let mut banks = BTreeSet::from([0]);
    let mut notes = BTreeSet::new();
    for command in mdx.tracks.iter().skip(8).flatten() {
        match command {
            MdxCommand::VoiceOrPcmBank(command) => {
                banks.insert(usize::from(command.value));
            }
            MdxCommand::Note(command) => {
                if let Some(note) = command.note.checked_sub(0x80) {
                    notes.insert(usize::from(note));
                }
            }
            _ => {}
        }
    }
    if notes.is_empty() && mdx.header.pdx_name.is_none() {
        return Ok(None);
    }
    let mut builder = PdxBuilder::new();
    for bank in banks {
        for &note in &notes {
            builder.set_sample(bank, note, vec![0; 4])?;
        }
    }
    Ok(Some(builder.finalize()))
}

fn to_lsp_diagnostic(source: &str, error: mmlx::diagnostic::Diagnostic) -> Diagnostic {
    let range = error.span.and_then(|span| {
        let index = SourceFile::new(source)?.line_index();
        let (start_line, start_column) = index.utf16_position(span.start())?;
        let (end_line, end_column) = index.utf16_position(span.end())?;
        Some(Range::new(
            Position::new(start_line as u32, start_column as u32),
            Position::new(end_line as u32, end_column as u32),
        ))
    });
    Diagnostic {
        range: range.unwrap_or_default(),
        severity: Some(match error.severity {
            Severity::Error => DiagnosticSeverity::ERROR,
            Severity::Warning => DiagnosticSeverity::WARNING,
        }),
        code: Some(NumberOrString::String(error.code.into())),
        source: Some("mmlx".into()),
        message: error.message,
        ..Diagnostic::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diagnostics(source: &str) -> Vec<Diagnostic> {
        Dialect::Mdx.diagnostics(source)
    }

    fn handle_notification(
        connection: &Connection,
        documents: &mut HashMap<Uri, String>,
        notification: Notification,
    ) -> Result<(), Box<dyn Error>> {
        super::handle_notification(connection, documents, notification, Dialect::Mdx)
    }

    fn handle_request(
        request: Request,
        documents: &HashMap<Uri, String>,
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
        let documents = HashMap::from([(uri.clone(), "A MP0,".to_string())]);
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
    fn valid_mml_has_no_diagnostics() {
        let source = format!("@0 = {{ {} }}\nA c4 d4 e4", vec!["0"; 47].join(","));
        assert!(diagnostics(&source).is_empty());
        assert!(diagnostics("A c4 d4 e4").is_empty());
        assert!(diagnostics("A r4").is_empty());
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
            let error = check_compiled_playback(compiled, limits).unwrap_err();
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
            documents.insert(uri.clone(), source.to_string());
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
            assert_eq!(
                documents.contains_key(&uri.parse::<Uri>().unwrap()),
                version.is_some()
            );
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
