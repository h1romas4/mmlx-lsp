use ndsif::{Chip, Command, Frame, Reply, Response, Status};
use serde::Deserialize;
use serde_json::{Value, json};

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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Control {
    Ping,
    GetInfo,
    Reset,
    SetClock,
}

pub fn handle(params: Value) -> Result<Value, String> {
    let operation: Operation = serde_json::from_value(params).map_err(|error| error.to_string())?;
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
                    hz: 3_579_545,
                },
            };
            let encoded = command
                .encode(request_id)
                .map_err(|error| error.to_string())?;
            Ok(json!({ "bytes": encoded.as_bytes() }))
        }
        Operation::Decode { body, request } => {
            if request.len() < 3 || request.first() != Some(&0) || request.last() != Some(&0) {
                return Err("Invalid request frame".into());
            }
            let request =
                Frame::decode(&request[1..request.len() - 1]).map_err(|error| error.to_string())?;
            let Ok(frame) = Frame::decode(&body) else {
                return Ok(Value::Null);
            };
            let Ok(response) = Response::decode(&frame) else {
                return Ok(Value::Null);
            };
            if response.matches_request(&request).is_err() {
                return Ok(Value::Null);
            }
            let mut result =
                json!({ "status": if response.status == Status::Complete { 0 } else { 1 } });
            if let Reply::Info(info) = response.reply {
                result["model"] = json!(info.model);
                result["firmware"] = json!(info.firmware);
            }
            Ok(result)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ndsif::DeviceInfo;

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
