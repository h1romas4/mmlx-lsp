use mmlx_lsp_server::audition::{Audition, CLOCK, polyphony::Note, voice::Voice};
use ndsif::{Chip, Command, Divider, Frame, OkiClock, RegisterWrite, Reply, Response, Status};
use serde::Deserialize;
use serde_json::{Value, json};

#[path = "nanodrive/playback.rs"]
mod playback;

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase")]
enum Operation {
    Encode {
        command: Control,
        #[serde(rename = "requestId")]
        request_id: u16,
        #[serde(default)]
        payload: Vec<u8>,
    },
    Decode {
        body: Vec<u8>,
        request: Vec<u8>,
    },
    Audition {
        session: u32,
        #[serde(rename = "requestId")]
        request_id: u16,
        command: Input,
    },
    Upload {
        asset: Asset,
        offset: usize,
        bytes: Vec<u8>,
    },
    PlaybackInfo,
    PlaybackInit {
        looped: bool,
    },
    PlaybackNext {
        #[serde(rename = "requestId")]
        request_id: u16,
    },
    PlaybackStop,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Asset {
    Source,
    Pdx,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Control {
    Ping,
    GetInfo,
    Reset,
    SetClock,
    SetPlaybackClock,
    AudioStart,
    AudioStatus,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Input {
    Init {
        voice: Option<Voice>,
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
    Stop,
}

#[derive(Default)]
pub struct Bridge {
    session: Option<(u32, Audition)>,
    source: Vec<u8>,
    pdx: Vec<u8>,
    playback: Option<playback::Playback>,
}

pub enum Output {
    Json(Value),
    Bytes(Vec<u8>, Option<usize>),
    Audio(playback::Chunk),
}

#[cfg(test)]
impl Output {
    pub fn value(self) -> Value {
        match self {
            Self::Json(value) => value,
            Self::Bytes(bytes, Some(count)) => json!({"bytes":bytes,"count":count}),
            Self::Bytes(bytes, None) => json!({"bytes":bytes}),
            Self::Audio(chunk) => {
                json!({"bytes":chunk.bytes,"count":chunk.count,"position":chunk.position,"ended":chunk.ended})
            }
        }
    }
}

impl Bridge {
    pub fn handle(&mut self, params: Value) -> Result<Output, String> {
        let operation: Operation =
            serde_json::from_value(params).map_err(|error| error.to_string())?;
        match operation {
            Operation::Encode {
                command,
                request_id,
                payload,
            } => {
                let command = match command {
                    Control::Ping => Command::Ping(&payload),
                    Control::GetInfo => Command::GetInfo,
                    Control::Reset => Command::Reset,
                    Control::SetClock => Command::SetChipClock {
                        chip: Chip::Ym2151,
                        hz: CLOCK,
                    },
                    Control::SetPlaybackClock => Command::SetChipClock {
                        chip: Chip::Ym2151,
                        hz: 4_000_000,
                    },
                    Control::AudioStart => Command::AudioStart {
                        clock: OkiClock::Mhz8,
                        divider: Divider::Div512,
                    },
                    Control::AudioStatus => Command::AudioStatus,
                };
                let encoded = command
                    .encode(request_id)
                    .map_err(|error| error.to_string())?;
                Ok(Output::Bytes(encoded.as_bytes().to_vec(), None))
            }
            Operation::Decode { body, request } => {
                if request.len() < 3 || request.first() != Some(&0) || request.last() != Some(&0) {
                    return Err("Invalid request frame".into());
                }
                let request = Frame::decode(&request[1..request.len() - 1])
                    .map_err(|error| error.to_string())?;
                let Ok(frame) = Frame::decode(&body) else {
                    return Ok(Output::Json(Value::Null));
                };
                let Ok(response) = Response::decode(&frame) else {
                    return Ok(Output::Json(Value::Null));
                };
                if response.matches_request(&request).is_err() {
                    return Ok(Output::Json(Value::Null));
                }
                let mut result =
                    json!({ "status": if response.status == Status::Complete { 0 } else { 1 } });
                if let Reply::Info(info) = response.reply {
                    result["model"] = json!(info.model);
                    result["firmware"] = json!(info.firmware);
                }
                if let Reply::AudioStatus(status) = response.reply {
                    result["accepted"] = json!(status.accepted);
                    result["played"] = json!(status.played);
                    result["pending"] = json!(status.pending);
                    result["running"] = json!(status.flags.running());
                    result["ended"] = json!(status.flags.ended());
                    result["fault"] = json!(status.flags.fault());
                    result["underflows"] = json!(status.underflows);
                    result["overflows"] = json!(status.overflows);
                    result["rejected"] = json!(status.rejected);
                }
                Ok(Output::Json(result))
            }
            Operation::Upload {
                asset,
                offset,
                bytes,
            } => {
                let target = match asset {
                    Asset::Source => &mut self.source,
                    Asset::Pdx => &mut self.pdx,
                };
                if offset == 0 {
                    target.clear();
                }
                if offset != target.len()
                    || bytes.len() > 8192
                    || offset.saturating_add(bytes.len()) > 16 * 1024 * 1024
                {
                    return Err("Invalid NanoDrive8 asset chunk".into());
                }
                target.extend_from_slice(&bytes);
                Ok(Output::Json(Value::Null))
            }
            Operation::PlaybackInfo => {
                let source =
                    std::str::from_utf8(&self.source).map_err(|error| error.to_string())?;
                let parsed = mmlx::mdx::parse(source).map_err(|error| error.to_string())?;
                let mdx = mmlx::mdx::compile(&parsed).map_err(|error| error.to_string())?;
                let package = soundlog::mdx::package::MdxPackage::parse_owned(
                    mdx.to_bytes().map_err(|error| error.to_string())?,
                    None,
                )
                .map_err(|error| error.to_string())?;
                Ok(Output::Json(json!({ "pdxName":package.pdx_name() })))
            }
            Operation::PlaybackInit { looped } => {
                let source =
                    std::str::from_utf8(&self.source).map_err(|error| error.to_string())?;
                self.playback = Some(playback::Playback::new(
                    source,
                    if self.pdx.is_empty() {
                        None
                    } else {
                        Some(std::mem::take(&mut self.pdx))
                    },
                    looped,
                )?);
                Ok(Output::Json(Value::Null))
            }
            Operation::PlaybackNext { request_id } => {
                let playback = self
                    .playback
                    .as_mut()
                    .ok_or("NanoDrive8 playback is not initialized")?;
                Ok(Output::Audio(playback.next(request_id)?))
            }
            Operation::PlaybackStop => {
                self.playback = None;
                self.source.clear();
                self.pdx.clear();
                Ok(Output::Json(Value::Null))
            }
            Operation::Audition {
                session,
                request_id,
                command,
            } => {
                let mut frames = Vec::new();
                let writes = if let Input::Init { voice } = command {
                    let mut audition = Audition::default();
                    let mut writes = (0..8).map(|channel| (0x08, channel)).collect::<Vec<_>>();
                    writes.extend([
                        (0x01, 0),
                        (0x0f, 0),
                        (0x14, 0x30),
                        (0x18, 0),
                        (0x19, 0),
                        (0x19, 0x80),
                        (0x1b, 0),
                    ]);
                    writes.extend(audition.set_voice(voice)?);
                    self.session = Some((session, audition));
                    frames.push(
                        Command::SetChipClock {
                            chip: Chip::Ym2151,
                            hz: CLOCK,
                        }
                        .encode(request_id)
                        .map_err(|error| error.to_string())?
                        .as_bytes()
                        .to_vec(),
                    );
                    writes
                } else {
                    let (id, audition) = self
                        .session
                        .as_mut()
                        .ok_or("NanoDrive8 keyboard is not initialized")?;
                    if *id != session {
                        return Err("Stale NanoDrive8 keyboard session".into());
                    }
                    match command {
                        Input::Voice { voice } => audition.set_voice(voice)?,
                        Input::NoteOn {
                            source,
                            channel,
                            note,
                            velocity,
                        } => audition.note_on(
                            Note {
                                source,
                                channel,
                                note,
                            },
                            velocity,
                        ),
                        Input::NoteOff {
                            source,
                            channel,
                            note,
                        } => audition.note_off(Note {
                            source,
                            channel,
                            note,
                        }),
                        Input::AllOff { source, channel } => audition.all_off(source, channel),
                        Input::Stop => {
                            self.session = None;
                            (0..8)
                                .map(|channel| (0x08, channel))
                                .chain((0x60..=0x7f).map(|address| (address, 127)))
                                .collect()
                        }
                        Input::Init { .. } => unreachable!(),
                    }
                };
                let writes: Vec<_> = writes
                    .into_iter()
                    .map(|(address, value)| RegisterWrite { address, value })
                    .collect();
                for chunk in writes.chunks(128) {
                    frames.push(
                        Command::WriteYm2151Burst(chunk)
                            .encode(request_id.wrapping_add(frames.len() as u16))
                            .map_err(|error| error.to_string())?
                            .as_bytes()
                            .to_vec(),
                    );
                }
                Ok(Output::Bytes(frames.concat(), Some(frames.len())))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ndsif::DeviceInfo;

    #[test]
    fn playback_controls_set_mdx_clock_and_fixed_oki_cadence() {
        for (name, expected) in [
            (
                "setPlaybackClock",
                Command::SetChipClock {
                    chip: Chip::Ym2151,
                    hz: 4_000_000,
                },
            ),
            (
                "audioStart",
                Command::AudioStart {
                    clock: OkiClock::Mhz8,
                    divider: Divider::Div512,
                },
            ),
            ("audioStatus", Command::AudioStatus),
        ] {
            let result = Bridge::default()
                .handle(json!({"operation":"encode","command":name,"requestId":7}))
                .unwrap()
                .value();
            let bytes: Vec<u8> = serde_json::from_value(result["bytes"].clone()).unwrap();
            assert_eq!(
                ndsif::Frame::decode(&bytes[1..bytes.len() - 1]).unwrap(),
                expected.to_frame(7).unwrap()
            );
        }
    }

    fn handle(params: Value) -> Result<Value, String> {
        Bridge::default().handle(params).map(Output::value)
    }

    fn voice() -> Value {
        json!({ "algorithm": 7, "feedback": 0, "operatorMask": 15, "operators": vec![json!({ "ar":31, "d1r":0, "d2r":0, "rr":15, "d1l":0, "tl":32, "ks":0, "mul":1, "dt1":0, "dt2":0, "ame":0 }); 4] })
    }

    fn audition(bridge: &mut Bridge, command: Value) -> Vec<Frame> {
        let result = bridge
            .handle(
                json!({"operation":"audition", "session":7, "requestId":65535, "command":command}),
            )
            .unwrap()
            .value();
        let bytes: Vec<u8> = serde_json::from_value(result["bytes"].clone()).unwrap();
        let frames: Vec<_> = bytes
            .split(|byte| *byte == 0)
            .filter(|body| !body.is_empty())
            .map(|body| Frame::decode(body).unwrap())
            .collect();
        assert_eq!(frames.len(), result["count"].as_u64().unwrap() as usize);
        frames
    }

    #[test]
    fn keyboard_initializes_clock_and_bounded_bursts_and_sends_midi_pitch() {
        let mut bridge = Bridge::default();
        let frames = audition(&mut bridge, json!({"type":"init", "voice":voice()}));
        assert_eq!(frames.len(), 3);
        assert_eq!(
            frames[0],
            Command::SetChipClock {
                chip: Chip::Ym2151,
                hz: CLOCK
            }
            .to_frame(65535)
            .unwrap()
        );
        assert_eq!(frames[1].request_id(), 0);
        assert_eq!(frames[2].request_id(), 1);
        let writes: Vec<_> = frames[1..]
            .iter()
            .flat_map(|frame| {
                frame
                    .payload()
                    .chunks_exact(2)
                    .map(|pair| (pair[0], pair[1]))
            })
            .collect();
        assert_eq!(
            &writes[..8],
            &(0..8).map(|channel| (0x08, channel)).collect::<Vec<_>>()
        );
        assert!(writes.contains(&(0x1b, 0)));
        for channel in 0..8 {
            assert!(writes.contains(&(0x20 + channel, 0xc7)));
        }
        for frame in &frames[1..] {
            assert_eq!(frame.opcode(), 0x56);
            assert!(frame.payload().len() <= 256);
        }
        let frames = audition(
            &mut bridge,
            json!({"type":"noteOn", "source":0, "channel":0, "note":69, "velocity":127}),
        );
        let writes: Vec<_> = frames[0]
            .payload()
            .chunks_exact(2)
            .map(|pair| (pair[0], pair[1]))
            .collect();
        assert_eq!(writes[0], (0x08, 0));
        assert_eq!(
            &writes[writes.len() - 3..],
            &[(0x28, 0x4a), (0x30, 0), (0x08, 0x78)]
        );
        assert_eq!(
            audition(
                &mut bridge,
                json!({"type":"noteOff", "source":0, "channel":0, "note":69})
            )[0]
            .payload(),
            &[0x08, 0]
        );
        assert!(
            audition(
                &mut bridge,
                json!({"type":"noteOn", "source":0, "channel":0, "note":12, "velocity":127})
            )
            .is_empty()
        );
        assert!(bridge.handle(json!({"operation":"audition", "session":8, "requestId":1, "command":{"type":"allOff"}})).is_err());
    }

    #[test]
    fn keyboard_source_releases_and_stop_are_isolated() {
        let mut bridge = Bridge::default();
        audition(&mut bridge, json!({"type":"init", "voice":voice()}));
        audition(
            &mut bridge,
            json!({"type":"noteOn", "source":0, "channel":0, "note":60, "velocity":127}),
        );
        audition(
            &mut bridge,
            json!({"type":"noteOn", "source":1, "channel":2, "note":60, "velocity":80}),
        );
        assert_eq!(
            audition(&mut bridge, json!({"type":"allOff", "source":0}))[0].payload(),
            &[0x08, 0]
        );
        assert_eq!(
            audition(
                &mut bridge,
                json!({"type":"noteOff", "source":1, "channel":2, "note":60})
            )[0]
            .payload(),
            &[0x08, 1]
        );
        let frames = audition(&mut bridge, json!({"type":"stop"}));
        assert_eq!(
            &frames[0].payload()[..16],
            &(0..8)
                .flat_map(|channel| [0x08, channel])
                .collect::<Vec<_>>()
        );
        assert_eq!(
            &frames[0].payload()[16..],
            &(0x60..=0x7f)
                .flat_map(|address| [address, 127])
                .collect::<Vec<_>>()
        );
        assert!(bridge.session.is_none());
    }

    #[test]
    fn handshake_commands_use_ndsif_wire_format() {
        for (name, command) in [
            ("ping", Command::Ping(b"ND8")),
            ("getInfo", Command::GetInfo),
            ("reset", Command::Reset),
            (
                "setClock",
                Command::SetChipClock {
                    chip: Chip::Ym2151,
                    hz: 3_579_545,
                },
            ),
        ] {
            let result = handle(json!({ "operation": "encode", "command": name, "requestId": 42, "payload": b"ND8" })).unwrap();
            let bytes: Vec<u8> = serde_json::from_value(result["bytes"].clone()).unwrap();
            assert_eq!(bytes, command.encode(42).unwrap().as_bytes());
        }
    }

    #[test]
    fn info_rejections_and_stale_or_corrupt_replies_are_distinguished() {
        let request = Command::GetInfo.to_frame(42).unwrap();
        let info = Response::for_request(
            &request,
            Reply::Info(DeviceInfo {
                model: "NanoDrive 8",
                firmware: "1.0b8",
            }),
        )
        .unwrap();
        for (reply, expected) in [
            (
                info,
                json!({"status": 0, "model": "NanoDrive 8", "firmware": "1.0b8"}),
            ),
            (
                Response::for_request(&request, Reply::Rejected).unwrap(),
                json!({"status": 1}),
            ),
        ] {
            let encoded = reply.encode().unwrap();
            let bytes = encoded.as_bytes();
            assert_eq!(handle(json!({"operation": "decode", "body": &bytes[1..bytes.len()-1], "request": request.encode().as_bytes()})).unwrap(), expected);
        }
        for frame in [
            Frame::new(0x82, 41, b"\0\x0bNanoDrive 8\x051.0b8").unwrap(),
            Frame::new(0x81, 42, b"\0ND8").unwrap(),
        ] {
            let encoded = frame.encode();
            let bytes = encoded.as_bytes();
            assert_eq!(handle(json!({"operation":"decode", "body": &bytes[1..bytes.len()-1], "request": request.encode().as_bytes()})).unwrap(), Value::Null);
        }
        assert_eq!(handle(json!({"operation":"decode", "body": [3, 1], "request": request.encode().as_bytes()})).unwrap(), Value::Null);
        assert!(
            handle(json!({"operation":"encode", "command":"ping", "requestId":65536})).is_err()
        );
    }
}
