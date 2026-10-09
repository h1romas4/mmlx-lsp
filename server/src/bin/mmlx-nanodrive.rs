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
        let reply = match bridge.handle(request.params) {
            Ok(result) => json!({ "id": request.id, "result": result }),
            Err(error) => json!({ "id": request.id, "error": error }),
        };
        serde_json::to_writer(&mut output, &reply).map_err(|error| error.to_string())?;
        output
            .write_all(b"\n")
            .and_then(|()| output.flush())
            .map_err(|error| error.to_string())?;
    }
}

fn main() {
    if let Err(error) = run(io::stdin().lock(), io::stdout().lock()) {
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
        let replies: Vec<Value> = serde_json::Deserializer::from_slice(&output)
            .into_iter()
            .map(Result::unwrap)
            .collect();
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
