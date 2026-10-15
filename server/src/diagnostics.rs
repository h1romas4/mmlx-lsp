use std::collections::BTreeSet;

use lsp_types::{Diagnostic, DiagnosticSeverity, NumberOrString, Position, Range};
use mmlx::frontend::SourceFile;
use mmlx::mdx::frontend::{CompiledMdx, MdxLocation};
use soundlog::mdx::{
    command::MdxCommand,
    convert::{MdxPlaybackCheckError, MdxPlaybackCheckLimits, MdxToVgmOptions, check_playback},
    document::MdxDocument,
    package::MdxPackage,
    pdx::{PdxBuilder, PdxDocument},
};

pub fn mdx(source: &str) -> Vec<Diagnostic> {
    let parsed = match mmlx::mdx::frontend::parse(source) {
        Ok(parsed) => parsed,
        Err(error) => return vec![to_lsp_diagnostic(source, error)],
    };
    let mut diagnostics = parsed
        .syntax()
        .voices()
        .iter()
        .flat_map(|voice| crate::voice::invalid_parameters(source, voice))
        .map(|issue| {
            let parameter = issue.operator.map_or_else(
                || issue.name.to_owned(),
                |operator| format!("OP{operator} {}", issue.name),
            );
            to_lsp_diagnostic(
                source,
                mmlx::diagnostic::Diagnostic {
                    code: "mmlx.mdx.voice-value-out-of-range",
                    severity: mmlx::diagnostic::Severity::Warning,
                    message: format!(
                        "FM voice parameter {parameter} value {} is outside the supported range 0-{}.",
                        issue.value, issue.max
                    ),
                    span: Some(issue.span),
                },
            )
        })
        .collect::<Vec<_>>();

    let compiled = match mmlx::mdx::frontend::compile(&parsed) {
        Ok(compiled) => compiled,
        Err(error) => {
            diagnostics.push(to_lsp_diagnostic(source, error));
            return diagnostics;
        }
    };
    if let Err(error) = check_compiled_playback(compiled, MdxPlaybackCheckLimits::default()) {
        diagnostics.push(to_lsp_diagnostic(source, error));
    }
    diagnostics
}

pub fn check_compiled_playback(
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
            mmlx::diagnostic::Severity::Error => DiagnosticSeverity::ERROR,
            mmlx::diagnostic::Severity::Warning => DiagnosticSeverity::WARNING,
        }),
        code: Some(NumberOrString::String(error.code.into())),
        source: Some("mmlx".into()),
        message: error.message,
        ..Diagnostic::default()
    }
}
