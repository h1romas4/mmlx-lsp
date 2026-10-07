use std::io::{self, BufRead, Write};

use mmlx::frontend::SourceFile;
use mmlx::mdx::frontend::{self, MdxLocation};
use serde::Deserialize;
use serde_json::{Value, json};
use soundlog::mdx::convert::{
    AdpcmMode, MdxPlaybackCheckError, MdxToVgmOptions, to_vgm_document_with_diagnostics,
};
use soundlog::mdx::package::MdxPackage;
use soundlog::meta::Gd3;

fn failure(message: impl ToString) -> Value {
    json!({ "ok": false, "message": message.to_string() })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildSuccess {
    byte_length: usize,
    ok: bool,
}

fn write_response(mut output: impl Write, result: &Result<BuildSuccess, Value>) -> io::Result<()> {
    match result {
        Ok(success) => serde_json::to_writer(&mut output, success),
        Err(error) => serde_json::to_writer(&mut output, error),
    }
    .map_err(io::Error::other)?;
    writeln!(output)?;
    Ok(())
}

fn diagnostic(source: &str, error: mmlx::diagnostic::Diagnostic) -> Value {
    let range = error.span.and_then(|span| {
        let index = SourceFile::new(source)?.line_index();
        let start = index.utf16_position(span.start())?;
        let end = index.utf16_position(span.end())?;
        Some([[start.0, start.1], [end.0, end.1]])
    });
    json!({ "ok": false, "message": error.to_string(), "range": range })
}

fn positive_option(request: &Value, name: &str) -> Result<Option<u32>, Value> {
    if request[name].is_null() {
        return Ok(None);
    }
    request[name]
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
        .map(Some)
        .ok_or_else(|| failure(format!("{name} must be a positive 32-bit integer")))
}

fn options(request: &Value) -> Result<MdxToVgmOptions, Value> {
    let adpcm_mode = match request["adpcmMode"].as_str().unwrap_or("through") {
        "through" => AdpcmMode::Through,
        "resample" => AdpcmMode::Resample,
        "lpf" => AdpcmMode::Lpf,
        _ => return Err(failure("Unknown ADPCM mode")),
    };
    Ok(MdxToVgmOptions {
        adpcm_mode,
        loop_count: positive_option(request, "loopCount")?,
        max_ticks: Some(positive_option(request, "maxTicks")?.unwrap_or(100_000)),
        ..Default::default()
    })
}

fn package(bytes: Vec<u8>, request: &Value) -> Result<MdxPackage, Value> {
    let pdx = if request["pdx"].is_null() {
        None
    } else {
        Some(Vec::<u8>::deserialize(&request["pdx"]).map_err(failure)?)
    };
    let package = MdxPackage::parse_owned(bytes, pdx).map_err(failure)?;
    if package.pdx.is_none()
        && let Some(name) = package.pdx_name()
    {
        return Err(json!({
            "ok": false,
            "message": format!("PDX file required: {name}"),
            "pdxName": name
        }));
    }
    Ok(package)
}

fn vgm(package: &MdxPackage, options: &MdxToVgmOptions) -> Result<Vec<u8>, MdxPlaybackCheckError> {
    let mut document = to_vgm_document_with_diagnostics(package, options)?;
    if !package.mdx.header.title.is_empty() {
        document.gd3 = Some(Gd3 {
            track_name_origin: Some(package.mdx.header.title.clone()),
            ..Gd3::default()
        });
    }
    Ok((&document).into())
}

fn build(request: &Value) -> Result<Vec<u8>, Value> {
    let format = request["format"].as_str().unwrap_or("mdx");
    if !matches!(format, "mdx" | "vgm") {
        return Err(failure("Unknown output format"));
    }
    match request["inputKind"].as_str().unwrap_or("mml") {
        "mml" => {
            let source = request["source"]
                .as_str()
                .ok_or_else(|| failure("Missing MML source"))?;
            let parsed = frontend::parse(source).map_err(|error| diagnostic(source, error))?;
            let compiled = frontend::compile(&parsed).map_err(|error| diagnostic(source, error))?;
            let bytes = compiled.document().to_bytes().map_err(failure)?;
            if format == "mdx" {
                return Ok(bytes);
            }
            let package = package(bytes, request)?;
            vgm(&package, &options(request)?).map_err(|error| {
                let (track, command_index) = match &error {
                    MdxPlaybackCheckError::Conversion {
                        track,
                        command_index,
                        ..
                    }
                    | MdxPlaybackCheckError::LimitExceeded {
                        track,
                        command_index,
                        ..
                    } => (*track, *command_index),
                };
                let span = track.zip(command_index).and_then(|(track, index)| {
                    compiled
                        .source_map()
                        .get(&MdxLocation::TrackCommand { track, index })
                });
                diagnostic(
                    source,
                    mmlx::diagnostic::Diagnostic::error(
                        "mmlx.build.playback",
                        error.to_string(),
                        span,
                    ),
                )
            })
        }
        "mdx" if format == "vgm" => {
            let bytes = Vec::<u8>::deserialize(&request["bytes"]).map_err(failure)?;
            let package = package(bytes, request)?;
            vgm(&package, &options(request)?).map_err(failure)
        }
        "mdx" => Err(failure("MDX input requires VGM output")),
        _ => Err(failure("Unknown input kind")),
    }
}

fn build_output(request: &Value) -> Result<BuildSuccess, Value> {
    let path = request["outputPath"]
        .as_str()
        .filter(|path| !path.is_empty())
        .ok_or_else(|| failure("Missing output path"))?;
    let bytes = build(request)?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(failure)?;
    file.write_all(&bytes).map_err(failure)?;
    Ok(BuildSuccess {
        byte_length: bytes.len(),
        ok: true,
    })
}

fn main() {
    let mut input = String::new();
    let result = io::stdin()
        .lock()
        .read_line(&mut input)
        .map_err(failure)
        .and_then(|_| serde_json::from_str::<Value>(&input).map_err(failure))
        .and_then(|request| build_output(&request));
    let mut output = io::BufWriter::new(io::stdout().lock());
    write_response(&mut output, &result).expect("compiler response must be writable");
    output.flush().expect("compiler response must be flushed");
    if result.is_err() {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soundlog::mdx::document::MdxDocument;

    #[test]
    fn writes_only_success_metadata() {
        for byte_length in [0, 256] {
            let mut output = Vec::new();
            write_response(
                &mut output,
                &Ok(BuildSuccess {
                    ok: true,
                    byte_length,
                }),
            )
            .unwrap();
            let boundary = output.iter().position(|byte| *byte == b'\n').unwrap();
            let header: Value = serde_json::from_slice(&output[..boundary]).unwrap();
            assert_eq!(header, json!({ "ok": true, "byteLength": byte_length }));
            assert!(output[boundary + 1..].is_empty());
        }
    }

    #[test]
    fn writes_output_and_protects_existing_files() {
        let directory = std::env::temp_dir().join(format!(
            "mmlx-build-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("output.mdx");
        let request = json!({ "source": "A r4", "outputPath": path });
        let expected = build(&request).unwrap();
        let result = build_output(&request).unwrap();
        assert_eq!(result.byte_length, expected.len());
        assert_eq!(std::fs::read(&path).unwrap(), expected);
        assert!(build_output(&request).is_err());
        assert!(build_output(&json!({ "source": "A o999 c4", "outputPath": path })).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), expected);
        assert!(build_output(&json!({ "source": "A r4" })).is_err());
        assert!(build_output(&json!({ "source": "A r4", "outputPath": "" })).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn writes_error_response_with_existing_diagnostic_fields() {
        let error = json!({
            "ok": false,
            "message": "invalid source",
            "range": [[0, 2], [0, 4]],
            "pdxName": "drums",
        });
        let expected = format!("{error}\n");
        let mut output = Vec::new();
        write_response(&mut output, &Err(error)).unwrap();
        assert_eq!(output, expected.as_bytes());
    }

    #[test]
    fn compiles_mml_to_mdx() {
        let bytes = build(&json!({ "source": "A r4" })).unwrap();
        assert!(MdxDocument::parse(&bytes).is_ok());
    }

    #[test]
    fn rejects_invalid_source_and_missing_input() {
        assert!(build(&json!({ "source": "A o999 c4" })).is_err());
        assert!(build(&json!({})).is_err());
    }

    #[test]
    fn converts_mml_and_mdx_to_vgm() {
        let source = "#title \"Build test\"\nA r4";
        let mdx = build(&json!({ "source": source })).unwrap();
        let from_mml = build(&json!({ "source": source, "format": "vgm" })).unwrap();
        let from_mdx =
            build(&json!({ "inputKind": "mdx", "bytes": mdx, "format": "vgm" })).unwrap();
        assert_eq!(from_mml, from_mdx);
        assert_eq!(&from_mml[..4], b"Vgm ");
    }

    #[test]
    fn rejects_invalid_json_bytes_and_pdx() {
        for bytes in [json!([-1]), json!([256]), json!(["0"]), Value::Null] {
            let request = json!({ "inputKind": "mdx", "bytes": bytes, "format": "vgm" });
            assert!(build(&request).is_err());
            let request = json!({
                "source": "#pcmfile \"drums\"\nA r4",
                "format": "vgm",
                "pdx": bytes,
            });
            assert!(build(&request).is_err());
        }
    }

    #[test]
    fn native_loop_header_matches_cli_conversion() {
        for source in ["A r4", "A r4 L r4"] {
            let mdx = build(&json!({ "source": source })).unwrap();
            let package = MdxPackage::parse(&mdx, None).unwrap();
            let mut request = json!({ "inputKind": "mdx", "bytes": mdx, "format": "vgm" });
            let automatic = build(&request).unwrap();
            assert_eq!(
                automatic,
                vgm(&package, &MdxToVgmOptions::default()).unwrap()
            );
            let loop_offset = u32::from_le_bytes(automatic[0x1c..0x20].try_into().unwrap());
            let loop_samples = u32::from_le_bytes(automatic[0x20..0x24].try_into().unwrap());
            assert_eq!(loop_offset > 0, source.contains('L'));
            assert_eq!(loop_samples > 0, source.contains('L'));
            for count in [1, 2] {
                request["loopCount"] = json!(count);
                let finite = build(&request).unwrap();
                let cli_options = MdxToVgmOptions {
                    loop_count: Some(count),
                    ..Default::default()
                };
                assert_eq!(finite, vgm(&package, &cli_options).unwrap());
                assert_eq!(&finite[0x1c..0x24], &[0; 8]);
            }
        }
    }

    #[test]
    fn requests_pdx_and_accepts_supplied_samples() {
        let mut request = json!({ "source": "#pcmfile \"drums\"\nA r4", "format": "vgm" });
        assert_eq!(build(&request).unwrap_err()["pdxName"], "drums");
        request["pdx"] = json!(soundlog::mdx::pdx::PdxBuilder::new().finalize().to_bytes());
        assert!(build(&request).is_ok());
        request["pdx"] = json!([1, 2]);
        assert!(build(&request).is_err());
    }

    #[test]
    fn maps_playback_errors_and_bounds_conversion() {
        let error = build(&json!({ "source": "A @42 c4", "format": "vgm" })).unwrap_err();
        assert!(
            error["message"]
                .as_str()
                .unwrap()
                .contains("missing tone for voice 42")
        );
        assert_eq!(error["range"], json!([[0, 6], [0, 8]]));
        let error =
            build(&json!({ "source": "A r1", "format": "vgm", "maxTicks": 2 })).unwrap_err();
        assert!(
            error["message"]
                .as_str()
                .unwrap()
                .contains("tick limit exceeded")
        );
        for request in [
            json!({ "source": "A r4", "format": "unknown" }),
            json!({ "source": "A r4", "format": "vgm", "loopCount": 0 }),
            json!({ "source": "A r4", "format": "vgm", "adpcmMode": "unknown" }),
        ] {
            assert!(build(&request).is_err());
        }
    }
}
