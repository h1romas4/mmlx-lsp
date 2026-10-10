#[path = "../nanodrive.rs"]
mod nanodrive;

use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{self, BufRead, Read, Write};

#[derive(Deserialize)]
struct Request {
    id: u32,
    params: Value,
}

fn run(input: impl BufRead, mut output: impl Write) -> Result<(), String> {
    let mut bridge = nanodrive::Bridge::default();
    let mut reader = input;
    loop {
        let mut line = Vec::new();
        let length = reader
            .by_ref()
            .take(65537)
            .read_until(b'\n', &mut line)
            .map_err(|error| error.to_string())?;
        if length == 0 {
            return Ok(());
        }
        if length > 65536 || line.last() != Some(&b'\n') {
            return Err("Invalid NanoDrive8 command length".into());
        }
        let request: Request = serde_json::from_slice(&line).map_err(|error| error.to_string())?;
        let (kind, bytes) = match bridge.handle(request.params) {
            Ok(nanodrive::Output::Audio(chunk)) => {
                let keys = if chunk.keys.is_empty() {
                    None
                } else {
                    Some(serde_json::to_vec(&chunk.keys).map_err(|error| error.to_string())?)
                };
                if keys.as_ref().is_some_and(|keys| keys.len() > 65536) {
                    return Err("NanoDrive8 key metadata overflow".into());
                }
                let metadata_length = keys.as_ref().map_or(0, |keys| 4 + keys.len());
                output
                    .write_all(&[
                        if chunk.audio { 3 } else { 4 } + if keys.is_some() { 2 } else { 0 }
                    ])
                    .and_then(|()| {
                        output.write_all(
                            &((chunk.bytes.len() + 11 + metadata_length) as u32).to_le_bytes(),
                        )
                    })
                    .and_then(|()| output.write_all(&request.id.to_le_bytes()))
                    .and_then(|()| output.write_all(&(chunk.count as u16).to_le_bytes()))
                    .and_then(|()| output.write_all(&chunk.position.to_le_bytes()))
                    .and_then(|()| {
                        output.write_all(&[
                            u8::from(chunk.ended) | (u8::from(chunk.synchronize) << 1)
                        ])
                    })
                    .and_then(|()| {
                        if let Some(keys) = &keys {
                            output.write_all(&(keys.len() as u32).to_le_bytes())?;
                            output.write_all(keys)?;
                        }
                        Ok(())
                    })
                    .and_then(|()| output.write_all(&chunk.bytes))
                    .and_then(|()| output.flush())
                    .map_err(|error| error.to_string())?;
                continue;
            }
            Ok(nanodrive::Output::Bytes(bytes, count)) => {
                output
                    .write_all(&[2])
                    .and_then(|()| output.write_all(&((bytes.len() + 6) as u32).to_le_bytes()))
                    .and_then(|()| output.write_all(&request.id.to_le_bytes()))
                    .and_then(|()| {
                        output.write_all(
                            &(count.map_or(u16::MAX, |count| count as u16)).to_le_bytes(),
                        )
                    })
                    .and_then(|()| output.write_all(&bytes))
                    .and_then(|()| output.flush())
                    .map_err(|error| error.to_string())?;
                continue;
            }
            Ok(nanodrive::Output::Json(result)) => (
                1,
                serde_json::to_vec(&json!({ "id": request.id, "result": result })),
            ),
            Err(error) => (
                1,
                serde_json::to_vec(&json!({ "id": request.id, "error": error })),
            ),
        };
        let bytes = bytes.map_err(|error| error.to_string())?;
        output
            .write_all(&[kind])
            .and_then(|()| output.write_all(&(bytes.len() as u32).to_le_bytes()))
            .and_then(|()| output.write_all(&bytes))
            .and_then(|()| output.flush())
            .map_err(|error| error.to_string())?;
    }
}

fn main() {
    if let Err(error) = run(
        io::stdin().lock(),
        io::BufWriter::with_capacity(65536, io::stdout().lock()),
    ) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_correlates_replies_and_recovers_from_rejected_operations() {
        let input = [
            json!({ "id": 1, "params": { "operation": "encode", "command": "unknown", "requestId": 0 } }),
            json!({ "id": 2, "params": { "operation": "encode", "command": "ping", "requestId": 1, "payload": [78, 68, 56] } }),
            json!({ "id": 3, "params": { "operation": "audition", "session": 7, "requestId": 2, "command": { "type": "init", "voice": null } } }),
            json!({ "id": 4, "params": { "operation": "audition", "session": 7, "requestId": 3, "command": { "type": "stop" } } }),
        ].iter().map(|value| format!("{value}\n")).collect::<String>();
        let mut output = Vec::new();
        run(io::Cursor::new(input), &mut output).unwrap();
        let mut replies = Vec::new();
        let mut offset = 0;
        while offset < output.len() {
            let kind = output[offset];
            let length =
                u32::from_le_bytes(output[offset + 1..offset + 5].try_into().unwrap()) as usize;
            let body = &output[offset + 5..offset + 5 + length];
            replies.push(if kind == 1 {
                serde_json::from_slice::<Value>(body).unwrap()
            } else {
                let id = u32::from_le_bytes(body[..4].try_into().unwrap());
                let count = u16::from_le_bytes(body[4..6].try_into().unwrap());
                let mut result = json!({"bytes":&body[6..]});
                if count != u16::MAX {
                    result["count"] = json!(count);
                }
                json!({"id":id,"result":result})
            });
            offset += 5 + length;
        }
        assert_eq!(replies.len(), 4);
        assert!(replies[0]["error"].is_string());
        assert_eq!(replies[1]["id"], 2);
        assert_eq!(
            replies[1]["result"]["bytes"],
            json!([0, 6, 78, 68, 1, 1, 1, 2, 3, 6, 78, 68, 56, 51, 150, 0])
        );
        assert_eq!(replies[2]["result"]["count"], 2);
        assert_eq!(replies[3]["result"]["count"], 1);
    }

    #[test]
    fn protocol_rejects_truncated_oversized_and_invalid_envelopes() {
        for input in [b"{}\n".to_vec(), b"{\"id\":1}".to_vec(), vec![b'x'; 65537]] {
            assert!(run(io::Cursor::new(input), Vec::new()).is_err());
        }
    }
}
