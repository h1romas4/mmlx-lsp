use crate::i18n::Language;
use lsp_types::{
    CompletionItem, CompletionOptions, Diagnostic, InitializeParams, Position,
    PositionEncodingKind, SemanticTokens, SemanticTokensFullOptions, SemanticTokensOptions,
    ServerCapabilities, SignatureHelp, SignatureHelpOptions, TextDocumentSyncCapability,
    TextDocumentSyncKind,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Dialect {
    #[default]
    Mdx,
}

#[derive(Debug, PartialEq, Eq)]
pub struct UnsupportedDialect {
    pub value: serde_json::Value,
}

impl UnsupportedDialect {
    pub fn message(&self, language: Language) -> String {
        rust_i18n::t!(
            "server.unsupported_dialect",
            locale = language.locale(),
            dialect = self.value.to_string(),
            supported = Dialect::Mdx.id(),
        )
        .to_string()
    }
}

impl Dialect {
    pub fn id(self) -> &'static str {
        match self {
            Self::Mdx => "mdx",
        }
    }

    pub fn from_initialize(params: &InitializeParams) -> Result<Self, UnsupportedDialect> {
        match params
            .initialization_options
            .as_ref()
            .and_then(|options| options.get("dialect"))
        {
            None => Ok(Self::default()),
            Some(serde_json::Value::String(value)) if value == "mdx" => Ok(Self::Mdx),
            Some(value) => Err(UnsupportedDialect {
                value: value.clone(),
            }),
        }
    }

    pub fn capabilities(self) -> ServerCapabilities {
        match self {
            Self::Mdx => ServerCapabilities {
                position_encoding: Some(PositionEncodingKind::UTF16),
                text_document_sync: Some(TextDocumentSyncCapability::Kind(
                    TextDocumentSyncKind::FULL,
                )),
                completion_provider: Some(CompletionOptions {
                    resolve_provider: Some(false),
                    trigger_characters: Some(vec!["@".into(), "M".into()]),
                    ..CompletionOptions::default()
                }),
                signature_help_provider: Some(SignatureHelpOptions {
                    trigger_characters: Some(crate::completion::signature_triggers()),
                    retrigger_characters: Some(vec![",".into(), " ".into()]),
                    ..SignatureHelpOptions::default()
                }),
                semantic_tokens_provider: Some(
                    SemanticTokensOptions {
                        legend: crate::semantic::legend(),
                        full: Some(SemanticTokensFullOptions::Bool(true)),
                        ..SemanticTokensOptions::default()
                    }
                    .into(),
                ),
                ..ServerCapabilities::default()
            },
        }
    }

    pub fn diagnostics(self, source: &str) -> Vec<Diagnostic> {
        match self {
            Self::Mdx => crate::mdx_diagnostics(source),
        }
    }

    pub fn completions(
        self,
        source: &str,
        position: Position,
        snippets: bool,
        language: Language,
    ) -> Vec<CompletionItem> {
        match self {
            Self::Mdx => crate::completion::items(source, position, snippets, language),
        }
    }

    pub fn signature_help(
        self,
        source: &str,
        position: Position,
        language: Language,
    ) -> Option<SignatureHelp> {
        match self {
            Self::Mdx => crate::completion::signature_help(source, position, language),
        }
    }

    pub fn semantic_tokens(self, source: &str) -> SemanticTokens {
        match self {
            Self::Mdx => crate::semantic::tokens(source),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn omitted_dialect_preserves_mdx() {
        for options in [
            serde_json::Value::Null,
            json!({}),
            json!({ "language": "en" }),
        ] {
            let params: InitializeParams = serde_json::from_value(json!({
                "capabilities": {}, "initializationOptions": options,
            }))
            .unwrap();
            assert_eq!(Dialect::from_initialize(&params), Ok(Dialect::Mdx));
        }
        assert_eq!(Dialect::Mdx.id(), "mdx");
    }

    #[test]
    fn explicit_mdx_is_supported() {
        let params: InitializeParams = serde_json::from_value(json!({
            "capabilities": {}, "initializationOptions": { "dialect": "mdx" },
        }))
        .unwrap();
        assert_eq!(Dialect::from_initialize(&params), Ok(Dialect::Mdx));
    }

    #[test]
    fn unsupported_dialects_and_invalid_types_are_rejected() {
        for value in [
            json!("future"),
            json!("auto"),
            json!(""),
            json!("MDX"),
            json!(null),
            json!(7),
            json!(true),
            json!(["mdx"]),
            json!({}),
        ] {
            let params: InitializeParams = serde_json::from_value(json!({
                "capabilities": {}, "initializationOptions": { "dialect": value },
            }))
            .unwrap();
            assert_eq!(
                Dialect::from_initialize(&params),
                Err(UnsupportedDialect { value })
            );
        }
    }
}
