use super::{Emulation, polyphony::Note, voice::Voice};
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
    let mut reader = input;
    loop {
        let mut line = Vec::new();
        let length = reader
            .by_ref()
            .take(16385)
            .read_until(b'\n', &mut line)
            .map_err(|error| error.to_string())?;
        if length == 0 {
            return Ok(());
        }
        if length > 16384 || line.last() != Some(&b'\n') {
            return Err("Invalid command length".into());
        }
        let command: Command = serde_json::from_slice(&line).map_err(|error| error.to_string())?;
        if let Command::Init { sample_rate } = command {
            if engine.is_some() {
                return Err("Already initialized".into());
            }
            engine = Some(Emulation::new(sample_rate)?);
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
            Command::Render => {
                frame(&mut output, 2, &engine.render()?).map_err(|error| error.to_string())?
            }
            Command::Init { .. } => unreachable!(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
