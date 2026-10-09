use ndsif::{
    AudioEvent, BytePosition, Chip, Command, Decoder, Divider, Error, Frame, OkiClock, Pan,
    RegisterWrite, Reply, Request, RequestEvent, Response, ZeroPair,
};

fn ping() -> Frame {
    Frame::new(1, 42, b"ND8").unwrap()
}

#[test]
fn accepts_every_split_and_single_byte_delivery() {
    let frame = ping();
    let encoded = frame.encode();
    for split in 0..=encoded.as_bytes().len() {
        let mut decoder = Decoder::new();
        let mut received = Vec::new();
        decoder.push(&encoded.as_bytes()[..split], |result| received.push(result));
        decoder.push(&encoded.as_bytes()[split..], |result| received.push(result));
        assert_eq!(received, [Ok(frame.clone())]);
    }
    let mut decoder = Decoder::new();
    let received: Vec<_> = encoded
        .as_bytes()
        .iter()
        .filter_map(|&byte| decoder.push_byte(byte))
        .collect();
    assert_eq!(received, [Ok(frame)]);
}

#[test]
fn ignores_boot_logs_and_empty_delimiters_and_accepts_concatenation() {
    let first = ping();
    let second = Frame::new(2, 43, &[]).unwrap();
    let mut stream = b"ESP32 boot log\r\n\0\0\0".to_vec();
    stream.extend_from_slice(first.encode().as_bytes());
    stream.extend_from_slice(second.encode().as_bytes());
    let mut decoder = Decoder::new();
    let mut received = Vec::new();
    decoder.push(&stream, |result| received.push(result));
    assert_eq!(received, [Ok(first), Ok(second)]);
}

#[test]
fn overflow_is_reported_once_and_resynchronizes_at_delimiter() {
    let mut decoder = Decoder::new();
    let mut received = Vec::new();
    decoder.push(&[0], |_| unreachable!());
    decoder.push(&[1; 400], |result| received.push(result));
    decoder.push(ping().encode().as_bytes(), |result| received.push(result));
    assert_eq!(received, [Err(Error::FrameTooLong), Ok(ping())]);
}

#[test]
fn expiry_discards_remainder_and_reset_discards_old_transport() {
    let wire = ping().encode();
    let mut decoder = Decoder::new();
    let mut received = Vec::new();
    assert!(!decoder.expire_partial_frame());
    decoder.push(&wire.as_bytes()[..5], |_| unreachable!());
    assert!(decoder.has_partial_frame());
    assert!(decoder.expire_partial_frame());
    assert!(!decoder.has_partial_frame());
    assert!(!decoder.expire_partial_frame());
    decoder.push(&wire.as_bytes()[5..], |result| received.push(result));
    assert!(received.is_empty());
    decoder.push(wire.as_bytes(), |result| received.push(result));
    assert_eq!(received, [Ok(ping())]);
    decoder.push(&wire.as_bytes()[..5], |_| unreachable!());
    decoder.reset();
    decoder.push(&wire.as_bytes()[5..], |_| unreachable!());
}

#[test]
fn malformed_frame_does_not_hide_next_valid_frame() {
    let mut decoder = Decoder::new();
    let mut received = Vec::new();
    let mut stream = vec![0, 3, 1, 0];
    stream.extend_from_slice(ping().encode().as_bytes());
    decoder.push(&stream, |result| received.push(result));
    assert!(received[0].is_err());
    assert_eq!(received[1], Ok(ping()));
}

fn decode_chunks(bytes: &[u8], chunk_size: usize) -> Vec<Frame> {
    let mut decoder = Decoder::new();
    let mut frames = Vec::new();
    for chunk in bytes.chunks(chunk_size) {
        decoder.push(chunk, |result| frames.push(result.unwrap()));
    }
    assert!(!decoder.has_partial_frame());
    frames
}

#[test]
fn delphi_style_fm_batches_keep_order_across_startup_ping_and_reset() {
    let writes: Vec<_> = (0..260)
        .map(|index| RegisterWrite::new(0x20 + (index % 32) as u8, index as u8))
        .collect();
    let key_on = [RegisterWrite::new(8, 0x78)];
    let mut commands = vec![
        Command::Ping(b"probe"),
        Command::GetInfo,
        Command::Reset,
        Command::SetChipClock {
            chip: Chip::Ym2151,
            hz: 3_579_545,
        },
    ];
    commands.extend(writes.chunks(128).map(Command::WriteYm2151Burst));
    commands.extend([
        Command::Ping(b"startup"),
        Command::WriteYm2151Burst(&key_on),
        Command::Reset,
    ]);
    let frames: Vec<_> = commands
        .iter()
        .enumerate()
        .map(|(index, command)| command.to_frame(index as u16).unwrap())
        .collect();
    let stream: Vec<_> = frames
        .iter()
        .flat_map(|frame| frame.encode().as_bytes().to_vec())
        .collect();
    for chunk_size in [1, 7, 64, 256, 512, 1024] {
        let received = decode_chunks(&stream, chunk_size);
        assert_eq!(received, frames);
        assert_eq!(
            received.iter().map(Frame::opcode).collect::<Vec<_>>(),
            [1, 2, 0, 0x57, 0x56, 0x56, 0x56, 1, 0x56, 0]
        );
        assert_eq!(received[3].payload(), &[5, 0x99, 0x9e, 0x36, 0]);
        assert_eq!(
            received[4..7]
                .iter()
                .map(|frame| frame.payload().len())
                .collect::<Vec<_>>(),
            [256, 256, 8]
        );
        let mut pairs = Vec::new();
        for frame in &received[4..7] {
            let Request::WriteYm2151Burst(batch) = Request::decode(frame).unwrap() else {
                panic!("wrong request");
            };
            pairs.extend(batch.iter());
        }
        assert_eq!(pairs, writes);
        assert_eq!(
            Request::decode(&received[7]).unwrap(),
            Request::Ping(b"startup")
        );
        assert_eq!(received[8].payload(), &[8, 0x78]);
        assert_eq!(Request::decode(&received[9]).unwrap(), Request::Reset);
    }
}

#[test]
fn delphi_style_audio_batches_preserve_tied_events_data_and_end_order() {
    let writes: Vec<_> = (0..126)
        .map(|index| RegisterWrite::new(index, 255 - index))
        .collect();
    let adpcm: Vec<_> = (0..252).collect();
    let second_adpcm = [0xff, 0, 0x80, 8];
    let commands = [
        Command::AudioStatus,
        Command::AudioEvent {
            position: BytePosition::new(0),
            event: AudioEvent::Ym2151(&writes[..125]),
        },
        Command::AudioEvent {
            position: BytePosition::new(0),
            event: AudioEvent::Ym2151(&writes[125..]),
        },
        Command::AudioEvent {
            position: BytePosition::new(0),
            event: AudioEvent::Pan(Pan::Left),
        },
        Command::AudioData {
            position: BytePosition::new(0),
            adpcm: &adpcm,
        },
        Command::Ping(b"startup"),
        Command::AudioStart {
            clock: OkiClock::Mhz8,
            divider: Divider::Div512,
        },
        Command::AudioEvent {
            position: BytePosition::new(252),
            event: AudioEvent::OkiSettings {
                clock: OkiClock::Mhz4,
                divider: Divider::Div768,
            },
        },
        Command::AudioEvent {
            position: BytePosition::new(252),
            event: AudioEvent::Pan(Pan::Off),
        },
        Command::AudioData {
            position: BytePosition::new(252),
            adpcm: &second_adpcm,
        },
        Command::AudioEvent {
            position: BytePosition::new(256),
            event: AudioEvent::End(ZeroPair::Byte80),
        },
        Command::AudioStatus,
        Command::Reset,
    ];
    let frames: Vec<_> = commands
        .iter()
        .enumerate()
        .map(|(index, command)| command.to_frame(index as u16).unwrap())
        .collect();
    let stream: Vec<_> = frames
        .iter()
        .flat_map(|frame| frame.encode().as_bytes().to_vec())
        .collect();
    for chunk_size in [1, 5, 64, 256, 512, 1024] {
        let received = decode_chunks(&stream, chunk_size);
        assert_eq!(received, frames);
        assert_eq!(
            received.iter().map(Frame::opcode).collect::<Vec<_>>(),
            [
                0x5b, 0x59, 0x59, 0x59, 0x58, 1, 0x5a, 0x59, 0x59, 0x58, 0x59, 0x5b, 0
            ]
        );
        assert_eq!(received[1].payload().len(), 255);
        assert_eq!(received[2].payload().len(), 7);
        let mut pairs = Vec::new();
        for frame in &received[1..3] {
            let Request::AudioEvent {
                position,
                event: RequestEvent::Ym2151(batch),
            } = Request::decode(frame).unwrap()
            else {
                panic!("wrong event");
            };
            assert_eq!(position.get(), 0);
            pairs.extend(batch.iter());
        }
        assert_eq!(pairs, writes);
        assert_eq!(
            Request::decode(&received[4]).unwrap(),
            Request::AudioData {
                position: BytePosition::new(0),
                adpcm: &adpcm
            }
        );
        assert_eq!(received[6].payload(), &[0, 0x12, 0x7a, 0, 0, 2]);
        assert_eq!(
            received[7].payload(),
            &[252, 0, 0, 0, 1, 0, 9, 0x3d, 0, 0, 3]
        );
        assert_eq!(received[8].payload(), &[252, 0, 0, 0, 2, 3]);
        assert_eq!(
            Request::decode(&received[9]).unwrap(),
            Request::AudioData {
                position: BytePosition::new(252),
                adpcm: &second_adpcm
            }
        );
        assert_eq!(received[10].payload(), &[0, 1, 0, 0, 3, 0x80]);
        assert_eq!(
            Request::decode(&received[10]).unwrap(),
            Request::AudioEvent {
                position: BytePosition::new(256),
                event: RequestEvent::End(ZeroPair::Byte80)
            }
        );
    }
}

#[test]
fn startup_ping_matches_only_current_id_opcode_and_echo_from_a_reply_batch() {
    let request = Command::Ping(b"startup").to_frame(0).unwrap();
    let replies = [
        Frame::new(0x81, u16::MAX, b"\0startup").unwrap(),
        Frame::new(0x80, 0, &[0]).unwrap(),
        Frame::new(0x81, 0, b"\0probe").unwrap(),
        Response::for_request(&request, Reply::Ping(b"startup"))
            .unwrap()
            .to_frame()
            .unwrap(),
    ];
    let stream: Vec<_> = replies
        .iter()
        .flat_map(|frame| frame.encode().as_bytes().to_vec())
        .collect();
    for chunk_size in [1, 3, stream.len()] {
        let received = decode_chunks(&stream, chunk_size);
        let results: Vec<_> = received
            .iter()
            .map(|frame| Response::decode(frame).unwrap().matches_request(&request))
            .collect();
        assert_eq!(
            results,
            [
                Err(Error::ResponseMismatch),
                Err(Error::ResponseMismatch),
                Err(Error::ResponseMismatch),
                Ok(())
            ]
        );
    }
}
