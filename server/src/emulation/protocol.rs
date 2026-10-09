use super::{Emulation, playback::Playback, polyphony::Note, voice::Voice};
use serde::Deserialize;
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
    Playback {
        source: String,
        #[serde(default)]
        looped: bool,
        cursor: Option<usize>,
    },
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
            Command::Playback {
                source,
                looped,
                cursor,
            } => {
                playback = Some(Playback::with_cursor(&source, output_rate, looped, cursor)?);
                playback_state(&mut output, playback.as_ref().unwrap())?;
            }
            Command::Render => {
                let pcm = if let Some(playback) = playback.as_mut() {
                    playback.render()?
                } else {
                    engine.render()?
                };
                frame(&mut output, 2, &pcm).map_err(|error| error.to_string())?;
                if let Some(playback) = playback.as_ref() {
                    playback_state(&mut output, playback)?;
                }
            }
            Command::Init { .. } => unreachable!(),
        }
    }
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
}
