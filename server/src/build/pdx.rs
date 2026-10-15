use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
};

use serde::Deserialize;
use soundlog::mdx::{
    pcm::encode_adpcm,
    pdx::{PdxBuilder, PdxDocument},
};

const MAX_WORKSPACE_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_WORKSPACE_WAV_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    version: u32,
    #[serde(default)]
    lz_compressed: bool,
    samples: Vec<Sample>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Sample {
    bank: usize,
    voice_no: usize,
    wav: String,
}

#[allow(dead_code)]
pub fn build_pdx(manifest_path: &Path) -> Result<Vec<u8>, String> {
    build_pdx_inner(manifest_path, None)
}

#[allow(dead_code)]
pub fn build_pdx_within(manifest_path: &Path, workspace_root: &Path) -> Result<Vec<u8>, String> {
    build_pdx_inner(manifest_path, Some(workspace_root))
}

fn build_pdx_inner(manifest_path: &Path, workspace_root: Option<&Path>) -> Result<Vec<u8>, String> {
    if workspace_root.is_some()
        && fs::metadata(manifest_path)
            .map_err(|error| format!("could not inspect PDX manifest: {error}"))?
            .len()
            > MAX_WORKSPACE_MANIFEST_BYTES
    {
        return Err(format!(
            "PDX manifest exceeds the {MAX_WORKSPACE_MANIFEST_BYTES}-byte limit"
        ));
    }
    let manifest_bytes =
        fs::read(manifest_path).map_err(|error| format!("could not read PDX manifest: {error}"))?;
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("invalid PDX manifest: {error}"))?;
    if manifest.version != 1 {
        return Err(format!(
            "unsupported PDX manifest version: {}",
            manifest.version
        ));
    }
    if manifest.samples.is_empty() {
        return Err("PDX manifest must contain at least one sample".into());
    }

    let directory = manifest_path.parent().unwrap_or_else(|| Path::new("."));
    let mut used_slots = HashSet::new();
    let mut total_wav_bytes = 0_u64;
    let mut builder = PdxBuilder::new();
    builder.set_lz_compressed(manifest.lz_compressed);

    for sample in manifest.samples {
        if sample.bank >= 32 {
            return Err(format!(
                "PDX bank must be between 0 and 31 (found {})",
                sample.bank
            ));
        }
        if sample.voice_no >= 96 {
            return Err(format!(
                "PDX voiceNo must be between 0 and 95 (found {})",
                sample.voice_no
            ));
        }
        if !used_slots.insert((sample.bank, sample.voice_no)) {
            return Err(format!(
                "duplicate PDX sample slot: bank {}, voiceNo {}",
                sample.bank, sample.voice_no
            ));
        }
        if sample.wav.is_empty() || sample.wav.contains('\\') {
            return Err("WAV paths must be non-empty and use forward slashes".into());
        }
        let wav_path = PathBuf::from(&sample.wav);
        if wav_path.is_absolute() {
            return Err("WAV paths must be relative to the PDX manifest".into());
        }
        if !wav_path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("wav"))
        {
            return Err(format!("expected a WAV file: {}", sample.wav));
        }
        let wav_path = directory.join(wav_path);
        let wav_path = if let Some(workspace_root) = workspace_root {
            workspace_file(workspace_root, &wav_path, &sample.wav)?
        } else {
            wav_path
        };
        if workspace_root.is_some() {
            total_wav_bytes = total_wav_bytes
                .checked_add(
                    fs::metadata(&wav_path)
                        .map_err(|error| format!("could not inspect WAV {}: {error}", sample.wav))?
                        .len(),
                )
                .filter(|size| *size <= MAX_WORKSPACE_WAV_BYTES)
                .ok_or_else(|| {
                    format!(
                        "PDX WAV inputs exceed the {MAX_WORKSPACE_WAV_BYTES}-byte combined limit"
                    )
                })?;
        }
        let pcm = read_wav_samples(&wav_path)?;
        builder
            .set_sample(sample.bank, sample.voice_no, encode_adpcm(&pcm))
            .map_err(|error| format!("could not add {}: {error}", sample.wav))?;
    }

    let bytes = builder.finalize().to_bytes();
    PdxDocument::parse(&bytes).map_err(|error| format!("built PDX is invalid: {error}"))?;
    Ok(bytes)
}

fn workspace_file(root: &Path, path: &Path, name: &str) -> Result<PathBuf, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| format!("WAV paths must remain inside the workspace: {name}"))?;
    let mut resolved = root.to_path_buf();
    for component in relative.components() {
        match component {
            Component::Normal(part) => {
                resolved.push(part);
                let metadata = fs::symlink_metadata(&resolved)
                    .map_err(|error| format!("could not resolve WAV {name}: {error}"))?;
                if metadata.file_type().is_symlink() {
                    return Err(format!(
                        "WAV paths must not traverse symbolic links: {name}"
                    ));
                }
            }
            Component::CurDir => {}
            Component::ParentDir if resolved != root => {
                resolved.pop();
            }
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "WAV paths must remain inside the workspace: {name}"
                ));
            }
        }
    }
    Ok(resolved)
}

fn read_wav_samples(path: &Path) -> Result<Vec<i16>, String> {
    let mut reader = hound::WavReader::open(path)
        .map_err(|error| format!("could not read WAV {}: {error}", path.display()))?;
    let spec = reader.spec();
    if spec.channels != 1 {
        return Err(format!(
            "{}: only mono WAV files are supported (found {} channels)",
            path.display(),
            spec.channels
        ));
    }

    match spec.sample_format {
        hound::SampleFormat::Int => match spec.bits_per_sample {
            8 => reader
                .samples::<i8>()
                .map(|sample| sample.map(|value| i16::from(value) << 4))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("could not read WAV {}: {error}", path.display())),
            16 => reader
                .samples::<i16>()
                .map(|sample| sample.map(|value| value >> 4))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("could not read WAV {}: {error}", path.display())),
            24 | 32 => reader
                .samples::<i32>()
                .map(|sample| {
                    sample.map(|value| {
                        let shift = u32::from(spec.bits_per_sample - 12);
                        (value >> shift).clamp(-2048, 2047) as i16
                    })
                })
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("could not read WAV {}: {error}", path.display())),
            bits => Err(format!(
                "{}: unsupported integer WAV bit depth {bits}",
                path.display()
            )),
        },
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .map(|sample| {
                sample.map(|value| (value * 2047.0).round().clamp(-2048.0, 2047.0) as i16)
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("could not read WAV {}: {error}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::atomic::{AtomicUsize, Ordering},
    };

    use super::*;

    fn test_directory() -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let directory = std::env::temp_dir().join(format!(
            "mmlx-pdx-build-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn write_wav(path: &Path, channels: u16, samples: &[i16]) {
        let mut writer = hound::WavWriter::create(
            path,
            hound::WavSpec {
                channels,
                sample_rate: 15_625,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for sample in samples {
            writer.write_sample(*sample).unwrap();
        }
        writer.finalize().unwrap();
    }

    #[test]
    fn builds_mono_wav_samples_into_slots_and_applies_lz_setting() {
        let directory = test_directory();
        let wav = directory.join("tone.wav");
        let manifest_path = directory.join("bank.pdx.json");
        let samples = [-32768, -16000, 0, 16000, 32767];
        write_wav(&wav, 1, &samples);
        fs::write(
            &manifest_path,
            r#"{"version":1,"lzCompressed":true,"samples":[{"bank":2,"voiceNo":4,"wav":"tone.wav"}]}"#,
        )
        .unwrap();

        let bytes = build_pdx(&manifest_path).unwrap();
        let document = PdxDocument::parse(&bytes).unwrap();
        let pcm = samples.iter().map(|sample| sample >> 4).collect::<Vec<_>>();
        assert_eq!(
            document.sample_bytes(2, 4),
            Some(encode_adpcm(&pcm).as_slice())
        );
        assert!(document.is_compressed());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_duplicate_slots_and_stereo_wav_files() {
        let directory = test_directory();
        let wav = directory.join("tone.wav");
        let manifest_path = directory.join("bank.pdx.json");
        write_wav(&wav, 1, &[1, 2]);
        fs::write(
            &manifest_path,
            r#"{"version":1,"samples":[{"bank":0,"voiceNo":0,"wav":"tone.wav"},{"bank":0,"voiceNo":0,"wav":"tone.wav"}]}"#,
        )
        .unwrap();
        assert!(
            build_pdx(&manifest_path)
                .unwrap_err()
                .contains("duplicate PDX sample slot")
        );

        write_wav(&wav, 2, &[1, 2]);
        fs::write(
            &manifest_path,
            r#"{"version":1,"samples":[{"bank":0,"voiceNo":0,"wav":"tone.wav"}]}"#,
        )
        .unwrap();
        assert!(
            build_pdx(&manifest_path)
                .unwrap_err()
                .contains("only mono WAV")
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_workspace_manifest_samples_outside_the_workspace() {
        let directory = test_directory();
        let workspace = directory.join("workspace");
        fs::create_dir(&workspace).unwrap();
        write_wav(&directory.join("tone.wav"), 1, &[1, 2]);
        let manifest_path = workspace.join("bank.pdx.json");
        fs::write(
            &manifest_path,
            r#"{"version":1,"samples":[{"bank":0,"voiceNo":0,"wav":"../tone.wav"}]}"#,
        )
        .unwrap();

        assert!(
            build_pdx_within(&manifest_path, &workspace)
                .unwrap_err()
                .contains("remain inside the workspace")
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
