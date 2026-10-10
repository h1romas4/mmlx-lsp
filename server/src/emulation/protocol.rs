use super::{Emulation, playback::Playback, polyphony::Note, voice::Voice};
use serde::Deserialize;
use soundlog::mdx::convert::AdpcmMode;
use std::io::{self, BufRead, Read, Write};

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Command {
    Init {
        #[serde(rename = "sampleRate")]
        sample_rate: u32,
    },
    Voice {
        voice: Option<Voice>,
    },
    Reset {
        voice: Option<Voice>,
    },
    NoteOn {
        source: u8,
        channel: u8,
        note: u8,
        velocity: u8,
    },
    NoteOff {
        source: u8,
        channel: u8,
        note: u8,
    },
    AllOff {
        source: Option<u8>,
        channel: Option<u8>,
    },
    PitchBend {
        source: u8,
        channel: u8,
        value: u16,
    },
    PlaybackInfo {
        source: String,
    },
    Pdx {
        offset: usize,
        bytes: Vec<u8>,
    },
    Playback {
        source: String,
        #[serde(default)]
        looped: bool,
        cursor: Option<usize>,
        #[serde(rename = "adpcmMode")]
        adpcm_mode: Option<String>,
    },
    VoiceTest {
        mml: String,
        voice: Voice,
    },
    VoiceTestStop,
    Render,
}

pub fn frame(output: &mut impl Write, kind: u8, data: &[u8]) -> io::Result<()> {
    output.write_all(&[kind])?;
    output.write_all(&(data.len() as u32).to_le_bytes())?;
    output.write_all(data)?;
    output.flush()
}

pub fn run(input: impl BufRead, mut output: impl Write) -> Result<(), String> {
    let mut engine = None;
    let mut playback = None;
    let mut pdx = Vec::new();
    let mut output_rate = 0;
    let mut reader = input;
    loop {
        let mut line = Vec::new();
        let length = reader
            .by_ref()
            .take(2 * 1024 * 1024 + 1)
            .read_until(b'\n', &mut line)
            .map_err(|error| error.to_string())?;
        if length == 0 {
            return Ok(());
        }
        if length > 2 * 1024 * 1024 || line.last() != Some(&b'\n') {
            return Err("Invalid command length".into());
        }
        let command: Command = serde_json::from_slice(&line).map_err(|error| error.to_string())?;
        if let Command::Init { sample_rate } = command {
            if engine.is_some() {
                return Err("Already initialized".into());
            }
            engine = Some(Emulation::new(sample_rate)?);
            output_rate = sample_rate;
            frame(&mut output, 1, &sample_rate.to_le_bytes()).map_err(|error| error.to_string())?;
            continue;
        }
        let engine = engine.as_mut().ok_or("Emulator not initialized")?;
        match command {
            Command::Voice { voice } => engine.set_voice(voice)?,
            Command::Reset { voice } => {
                playback = None;
                engine.reset(voice)?;
                voice_test_state(&mut output, false, false)?;
                frame(&mut output, 4, &[]).map_err(|error| error.to_string())?;
            }
            Command::NoteOn {
                source,
                channel,
                note,
                velocity,
            } => engine.note_on(
                Note {
                    source,
                    channel,
                    note,
                },
                velocity,
            ),
            Command::NoteOff {
                source,
                channel,
                note,
            } => engine.note_off(Note {
                source,
                channel,
                note,
            }),
            Command::AllOff { source, channel } => engine.all_off(source, channel),
            Command::PitchBend {
                source,
                channel,
                value,
            } => engine.pitch_bend(source, channel, value),
            Command::PlaybackInfo { source } => {
                let (audio, name) = Playback::info(&source)?;
                let info =
                    serde_json::to_vec(&serde_json::json!({ "audio": audio, "pdxName": name }))
                        .map_err(|error| error.to_string())?;
                frame(&mut output, 5, &info).map_err(|error| error.to_string())?;
            }
            Command::Pdx { offset, bytes } => {
                if offset == 0 {
                    pdx.clear();
                }
                if offset != pdx.len()
                    || bytes.len() > 8192
                    || pdx.len() + bytes.len() > 16 * 1024 * 1024
                {
                    return Err("Invalid PDX upload".into());
                }
                pdx.extend(bytes);
            }
            Command::Playback {
                source,
                looped,
                cursor,
                adpcm_mode,
            } => {
                let mode = match adpcm_mode.as_deref().unwrap_or("resample") {
                    "through" => AdpcmMode::Through,
                    "resample" => AdpcmMode::Resample,
                    "lpf" => AdpcmMode::Lpf,
                    _ => return Err("Invalid ADPCM mode".into()),
                };
                let asset = if pdx.is_empty() {
                    None
                } else {
                    Some(std::mem::take(&mut pdx))
                };
                playback = Some(Playback::with_assets(
                    &source,
                    output_rate,
                    looped,
                    cursor,
                    asset,
                    mode,
                )?);
                playback_state(&mut output, playback.as_ref().unwrap())?;
            }
            Command::VoiceTest { mml, voice } => {
                let failed = engine.start_voice_test(&mml, voice).is_err();
                if failed {
                    engine.stop_voice_test();
                }
                voice_test_state(&mut output, engine.voice_test_active(), failed)?;
            }
            Command::VoiceTestStop => {
                engine.stop_voice_test();
                voice_test_state(&mut output, false, false)?;
            }
            Command::Render => {
                let testing = engine.voice_test_active();
                let pcm = if let Some(playback) = playback.as_mut() {
                    playback.render()?
                } else {
                    engine.render()?
                };
                frame(&mut output, 2, &pcm).map_err(|error| error.to_string())?;
                if let Some(playback) = playback.as_mut() {
                    playback_state(&mut output, playback)?;
                    for keys in playback.take_keys().chunks(512) {
                        let data = serde_json::to_vec(keys).map_err(|error| error.to_string())?;
                        frame(&mut output, 6, &data).map_err(|error| error.to_string())?;
                    }
                }
                if testing {
                    voice_test_state(
                        &mut output,
                        engine.voice_test_active(),
                        engine.voice_test_failed(),
                    )?;
                }
            }
            Command::Init { .. } => unreachable!(),
        }
    }
}

fn voice_test_state(output: &mut impl Write, active: bool, failed: bool) -> Result<(), String> {
    let mut state = 0_f64.to_le_bytes().to_vec();
    state.push(if failed { 2 } else { u8::from(!active) });
    frame(output, 3, &state).map_err(|error| error.to_string())
}

fn playback_state(output: &mut impl Write, playback: &Playback) -> Result<(), String> {
    let mut state = playback.position().to_le_bytes().to_vec();
    state.push(u8::from(playback.finished()));
    frame(output, 3, &state).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_playback_does_not_emit_audio_before_the_start_position() {
        let source = include_str!("../../../assets/webview/example.mml");
        let cursor = source.find("cdef").unwrap() + 2;
        let command = serde_json::json!({ "type": "playback", "source": source, "cursor": cursor });
        let mut output = Vec::new();
        run(
            io::Cursor::new(format!(
                "{{\"type\":\"init\",\"sampleRate\":48000}}\n{command}\n"
            )),
            &mut output,
        )
        .unwrap();
        assert_eq!(output.len(), 23);
        assert_eq!(output[9], 3);
        let position = f64::from_le_bytes(output[14..22].try_into().unwrap());
        assert!((0.49..0.51).contains(&position));
        let invalid =
            serde_json::json!({ "type": "playback", "source": source, "cursor": source.len() + 1 });
        assert!(
            run(
                io::Cursor::new(format!(
                    "{{\"type\":\"init\",\"sampleRate\":48000}}\n{invalid}\n"
                )),
                Vec::new()
            )
            .is_err()
        );
    }

    #[test]
    fn framing_and_invalid_commands() {
        let mut output = Vec::new();
        run(
            io::Cursor::new(b"{\"type\":\"init\",\"sampleRate\":48000}\n{\"type\":\"render\"}\n"),
            &mut output,
        )
        .unwrap();
        assert_eq!(&output[..5], &[1, 4, 0, 0, 0]);
        assert_eq!(&output[9..14], &[2, 0, 16, 0, 0]);
        assert_eq!(output.len(), 14 + 4096);
        assert!(run(io::Cursor::new(b"{\"type\":\"render\"}\n"), Vec::new()).is_err());
        assert!(run(io::Cursor::new(vec![b'x'; 16385]), Vec::new()).is_err());
    }

    #[test]
    fn pdx_upload_metadata_and_playback_emit_pcm() {
        let mut builder = soundlog::mdx::pdx::PdxBuilder::new();
        builder.set_sample(0, 9, vec![0x7f; 4096]).unwrap();
        let source = "#pcmfile \"drums\"\nP F2 o1 c4";
        let commands = [
            serde_json::json!({ "type": "init", "sampleRate": 48000 }),
            serde_json::json!({ "type": "playbackInfo", "source": source }),
            serde_json::json!({ "type": "pdx", "offset": 0, "bytes": builder.finalize().to_bytes() }),
            serde_json::json!({ "type": "playback", "source": source, "adpcmMode": "through" }),
            serde_json::json!({ "type": "render" }),
        ];
        let input = commands
            .iter()
            .map(|command| format!("{command}\n"))
            .collect::<String>();
        let mut output = Vec::new();
        run(io::Cursor::new(input), &mut output).unwrap();
        assert_eq!(output[9], 5);
        let length = u32::from_le_bytes(output[10..14].try_into().unwrap()) as usize;
        let info: serde_json::Value = serde_json::from_slice(&output[14..14 + length]).unwrap();
        assert_eq!(
            info,
            serde_json::json!({ "audio": true, "pdxName": "drums" })
        );
        let start = 14 + length + 14 + 5;
        assert!(
            output[start..start + 4096]
                .chunks_exact(4)
                .any(|sample| f32::from_le_bytes(sample.try_into().unwrap()).abs() > 0.001)
        );
        for command in [
            serde_json::json!({ "type": "pdx", "offset": 1, "bytes": [0] }),
            serde_json::json!({ "type": "pdx", "offset": 0, "bytes": vec![0; 8193] }),
            serde_json::json!({ "type": "playback", "source": source, "adpcmMode": "invalid" }),
        ] {
            assert!(
                run(
                    io::Cursor::new(format!(
                        "{{\"type\":\"init\",\"sampleRate\":48000}}\n{command}\n"
                    )),
                    Vec::new()
                )
                .is_err()
            );
        }
    }
}
