use mmlx::frontend::SourceFile;
use mmlx::mdx::frontend::{self, MdxLocation};
use serde::Deserialize;
use serde_json::{Value, json};
use soundlog::mdx::convert::{
    AdpcmMode, MdxPlaybackCheckError, MdxToVgmOptions, to_vgm_document_with_diagnostics,
};
use soundlog::mdx::package::MdxPackage;
use soundlog::meta::Gd3;

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
        .ok_or_else(|| super::failure(format!("{name} must be a positive 32-bit integer")))
}

fn options(request: &Value) -> Result<MdxToVgmOptions, Value> {
    let adpcm_mode = match request["adpcmMode"].as_str().unwrap_or("through") {
        "through" => AdpcmMode::Through,
        "resample" => AdpcmMode::Resample,
        "lpf" => AdpcmMode::Lpf,
        _ => return Err(super::failure("Unknown ADPCM mode")),
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
        Some(Vec::<u8>::deserialize(&request["pdx"]).map_err(super::failure)?)
    };
    let package = MdxPackage::parse_owned(bytes, pdx).map_err(super::failure)?;
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

pub fn vgm(
    package: &MdxPackage,
    options: &MdxToVgmOptions,
) -> Result<Vec<u8>, MdxPlaybackCheckError> {
    let mut document = to_vgm_document_with_diagnostics(package, options)?;
    if !package.mdx.header.title.is_empty() {
        document.gd3 = Some(Gd3 {
            track_name_origin: Some(package.mdx.header.title.clone()),
            ..Gd3::default()
        });
    }
    Ok((&document).into())
}

pub fn build(request: &Value) -> Result<Vec<u8>, Value> {
    let format = request["format"].as_str().unwrap_or("mdx");
    if !matches!(format, "mdx" | "vgm") {
        return Err(super::failure("Unknown output format"));
    }
    match request["inputKind"].as_str().unwrap_or("mml") {
        "mml" => {
            let source = request["source"]
                .as_str()
                .ok_or_else(|| super::failure("Missing MML source"))?;
            let parsed = frontend::parse(source).map_err(|error| diagnostic(source, error))?;
            let compiled = frontend::compile(&parsed).map_err(|error| diagnostic(source, error))?;
            let bytes = compiled.document().to_bytes().map_err(super::failure)?;
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
            let bytes = Vec::<u8>::deserialize(&request["bytes"]).map_err(super::failure)?;
            let package = package(bytes, request)?;
            vgm(&package, &options(request)?).map_err(super::failure)
        }
        "mdx" => Err(super::failure("MDX input requires VGM output")),
        _ => Err(super::failure("Unknown input kind")),
    }
}
