use std::io::{self, BufRead, Write};

use serde_json::{Value, json};

#[path = "../build/mdx.rs"]
mod mdx_build;
#[path = "../build/pdx.rs"]
mod pdx_build;

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

fn build(request: &Value) -> Result<Vec<u8>, Value> {
    if request["inputKind"].as_str() == Some("pdx") {
        let manifest = request["manifestPath"]
            .as_str()
            .filter(|path| !path.is_empty())
            .ok_or_else(|| failure("Missing PDX manifest path"))?;
        return pdx_build::build_pdx(std::path::Path::new(manifest)).map_err(failure);
    }
    mdx_build::build(request)
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
    use mdx_build::vgm;
    use soundlog::mdx::convert::MdxToVgmOptions;
    use soundlog::mdx::document::MdxDocument;
    use soundlog::mdx::package::MdxPackage;

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
