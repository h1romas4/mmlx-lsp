use ndsif::{
    AudioEvent, BytePosition, Chip, Command, Divider, Error, Frame, OkiClock, Pan, RegisterWrite,
    Reply, Response, Status, StatusFlags, ZeroPair,
};

#[test]
fn output_volume_validates_attenuation_and_round_trips_requests_and_replies() {
    use ndsif::Request;
    for attenuation in 0..=96 {
        let command = Command::SetOutputVolume { attenuation };
        let request = command.to_frame(42).unwrap();
        assert_eq!(request.opcode(), 0x03);
        assert_eq!(request.payload(), &[attenuation]);
        assert!(command.expects_response());
        assert_eq!(
            Request::decode(&request).unwrap(),
            Request::SetOutputVolume { attenuation }
        );
        let encoded = command.encode(42).unwrap();
        assert_eq!(
            Frame::decode(&encoded.as_bytes()[1..encoded.as_bytes().len() - 1]).unwrap(),
            request
        );
        for reply in [Reply::Complete, Reply::Rejected] {
            let response = Response::for_request(&request, reply).unwrap();
            let frame = response.to_frame().unwrap();
            assert_eq!(frame.opcode(), 0x83);
            assert_eq!(
                frame.payload(),
                &[if reply == Reply::Complete { 0 } else { 1 }]
            );
            let decoded = Response::decode(&frame).unwrap();
            assert_eq!(decoded.reply, reply);
            decoded.matches_request(&request).unwrap();
        }
    }
    for attenuation in 97..=255 {
        assert_eq!(
            Command::SetOutputVolume { attenuation }.to_frame(42),
            Err(Error::InvalidArgument)
        );
        assert_eq!(
            Request::decode(&Frame::new(0x03, 42, &[attenuation]).unwrap()),
            Err(Error::InvalidArgument)
        );
    }
    for payload in [&[][..], &[0, 0][..]] {
        assert_eq!(
            Request::decode(&Frame::new(0x03, 42, payload).unwrap()),
            Err(Error::InvalidArgument)
        );
    }
    for payload in [&[][..], &[0, 0][..], &[1, 0][..]] {
        assert_eq!(
            Response::decode(&Frame::new(0x83, 42, payload).unwrap()),
            Err(Error::InvalidLength)
        );
    }
}

#[test]
fn batch_encoder_splits_frames_and_preserves_ids_positions_and_order() {
    use ndsif::{CommandEncoder, MAX_AUDIO_DATA_BYTES, MAX_YM2151_EVENT_WRITES, MAX_YM2151_WRITES};
    let writes: [_; MAX_YM2151_WRITES * 2 + 1] =
        std::array::from_fn(|index| RegisterWrite::new(index as u8, index.wrapping_mul(3) as u8));
    let adpcm: [_; MAX_AUDIO_DATA_BYTES * 2 + 1] =
        std::array::from_fn(|index| index.wrapping_mul(5) as u8);
    let mut bytes = Vec::new();
    {
        let mut encoder =
            CommandEncoder::new(u16::MAX, |frame: &[u8]| bytes.extend_from_slice(frame));
        encoder.ym2151_burst(&writes).unwrap();
        encoder.ym2151_event(BytePosition::new(9), &writes).unwrap();
        assert_eq!(
            encoder
                .audio_data(BytePosition::new(9), &adpcm)
                .unwrap()
                .get(),
            514
        );
        encoder.push(Command::Ping(b"barrier")).unwrap();
        assert_eq!(encoder.count(), 10);
        assert_eq!(encoder.next_request_id(), 9);
    }
    let frames: Vec<_> = bytes
        .split(|byte| *byte == 0)
        .filter(|body| !body.is_empty())
        .map(|body| Frame::decode(body).unwrap())
        .collect();
    for (index, frame) in frames.iter().enumerate() {
        assert_eq!(frame.request_id(), u16::MAX.wrapping_add(index as u16));
    }
    for (index, frame) in frames[..3].iter().enumerate() {
        assert_eq!(
            *frame,
            Command::WriteYm2151Burst(writes.chunks(MAX_YM2151_WRITES).nth(index).unwrap())
                .to_frame(frame.request_id())
                .unwrap()
        );
    }
    for (index, frame) in frames[3..6].iter().enumerate() {
        assert_eq!(
            *frame,
            Command::AudioEvent {
                position: BytePosition::new(9),
                event: AudioEvent::Ym2151(
                    writes.chunks(MAX_YM2151_EVENT_WRITES).nth(index).unwrap()
                )
            }
            .to_frame(frame.request_id())
            .unwrap()
        );
    }
    for (index, frame) in frames[6..9].iter().enumerate() {
        assert_eq!(
            *frame,
            Command::AudioData {
                position: BytePosition::new(9 + (index * MAX_AUDIO_DATA_BYTES) as u32),
                adpcm: adpcm.chunks(MAX_AUDIO_DATA_BYTES).nth(index).unwrap()
            }
            .to_frame(frame.request_id())
            .unwrap()
        );
    }
    assert_eq!(frames[9], Command::Ping(b"barrier").to_frame(8).unwrap());
}

#[test]
fn batch_encoder_empty_and_invalid_inputs_do_not_emit_or_consume_ids() {
    use ndsif::CommandEncoder;
    let mut emitted = 0;
    let mut encoder = CommandEncoder::new(42, |_: &[u8]| emitted += 1);
    encoder.ym2151_burst(&[]).unwrap();
    encoder.ym2151_event(BytePosition::new(0), &[]).unwrap();
    assert_eq!(
        encoder
            .audio_data(BytePosition::new(u32::MAX), &[])
            .unwrap()
            .get(),
        u32::MAX
    );
    assert_eq!(
        encoder.audio_data(BytePosition::new(u32::MAX - 252), &[0; 253]),
        Err(Error::InvalidArgument)
    );
    assert_eq!(
        encoder.push(Command::Ping(&[0; 33])),
        Err(Error::InvalidArgument)
    );
    assert_eq!(encoder.count(), 0);
    assert_eq!(encoder.next_request_id(), 42);
    assert_eq!(emitted, 0);
}

#[test]
fn audio_timing_keeps_fractional_samples_and_checks_overflow() {
    use ndsif::AudioTiming;
    for clock in [OkiClock::Mhz4, OkiClock::Mhz8] {
        for divider in [Divider::Div512, Divider::Div768, Divider::Div1024] {
            let timing = AudioTiming::new(clock, divider);
            let mut converter = timing.sample_converter(44_100).unwrap();
            let split: u64 = (0..44_100).map(|_| converter.advance(1).unwrap()).sum();
            assert_eq!(split, timing.samples_from_ticks(44_100, 44_100).unwrap());
            assert_eq!(split, clock as u64 / divider as u64);
            assert_eq!(
                timing.bytes_from_ticks(44_100, 44_100).unwrap(),
                clock as u64 / (divider as u64 * 2)
            );
            assert_eq!(
                timing.ticks_from_bytes(clock as u64, 1000).unwrap(),
                divider as u64 * 2000
            );
            assert_eq!(
                timing.sample_converter(0).unwrap_err(),
                Error::InvalidArgument
            );
            assert_eq!(timing.bytes_from_ticks(1, 0), Err(Error::InvalidArgument));
            assert_eq!(timing.ticks_from_bytes(1, 0), Err(Error::InvalidArgument));
        }
    }
    let timing = AudioTiming::new(OkiClock::Mhz8, Divider::Div512);
    assert_eq!(timing.bytes_from_ticks(1024, 1_000_000).unwrap(), 8);
    assert_eq!(timing.ticks_from_bytes(8, 1_000_000).unwrap(), 1024);
    assert_eq!(
        timing.ticks_from_bytes(u64::MAX, u32::MAX),
        Err(Error::InvalidArgument)
    );
    let mut converter = timing.sample_converter(1000).unwrap();
    converter.advance(1).unwrap();
    let before = converter.clone();
    assert_eq!(converter.advance(u64::MAX), Err(Error::InvalidArgument));
    assert_eq!(converter, before);
}

#[test]
fn every_command_encodes_expected_payload_and_reply_policy() {
    let writes = [
        RegisterWrite::new(0x20, 0xc7),
        RegisterWrite::new(0x08, 0x78),
    ];
    let position = BytePosition::new(0x04030201);
    let cases: &[(Command<'_>, u8, &[u8], bool)] = &[
        (Command::Reset, 0, &[], true),
        (Command::Ping(b"ND8"), 1, b"ND8", true),
        (Command::GetInfo, 2, &[], true),
        (
            Command::WriteYm2151(&writes),
            0x54,
            &[0x20, 0xc7, 8, 0x78],
            true,
        ),
        (
            Command::WriteYm2151Burst(&writes),
            0x56,
            &[0x20, 0xc7, 8, 0x78],
            false,
        ),
        (
            Command::SetChipClock {
                chip: Chip::Ym2151,
                hz: 4_000_000,
            },
            0x57,
            &[5, 0, 9, 0x3d, 0],
            false,
        ),
        (
            Command::SetChipClock {
                chip: Chip::OkiM6258,
                hz: 8_000_000,
            },
            0x57,
            &[14, 0, 0x12, 0x7a, 0],
            false,
        ),
        (
            Command::AudioData {
                position,
                adpcm: &[0x80, 8],
            },
            0x58,
            &[1, 2, 3, 4, 0x80, 8],
            false,
        ),
        (
            Command::AudioEvent {
                position,
                event: AudioEvent::Ym2151(&writes),
            },
            0x59,
            &[1, 2, 3, 4, 0, 0x20, 0xc7, 8, 0x78],
            false,
        ),
        (
            Command::AudioEvent {
                position,
                event: AudioEvent::OkiSettings {
                    clock: OkiClock::Mhz4,
                    divider: Divider::Div768,
                },
            },
            0x59,
            &[1, 2, 3, 4, 1, 0, 9, 0x3d, 0, 0, 3],
            false,
        ),
        (
            Command::AudioEvent {
                position,
                event: AudioEvent::Pan(Pan::Left),
            },
            0x59,
            &[1, 2, 3, 4, 2, 1],
            false,
        ),
        (
            Command::AudioEvent {
                position,
                event: AudioEvent::End(ZeroPair::Byte08),
            },
            0x59,
            &[1, 2, 3, 4, 3, 8],
            false,
        ),
        (
            Command::AudioStart {
                clock: OkiClock::Mhz8,
                divider: Divider::Div512,
            },
            0x5a,
            &[0, 0x12, 0x7a, 0, 0, 2],
            false,
        ),
        (Command::AudioStatus, 0x5b, &[], true),
    ];
    for &(command, opcode, payload, expects_response) in cases {
        let frame = command.to_frame(0x1234).unwrap();
        assert_eq!(frame.opcode(), opcode);
        assert_eq!(frame.request_id(), 0x1234);
        assert_eq!(frame.payload(), payload);
        assert_eq!(command.expects_response(), expects_response);
        let encoded = command.encode(0x1234).unwrap();
        let wire = encoded.as_bytes();
        assert_eq!(Frame::decode(&wire[1..wire.len() - 1]).unwrap(), frame);
        assert!(ndsif::Request::decode(&frame).is_ok());
    }
}

#[test]
fn chip_clock_matches_published_complete_frame() {
    let encoded = Command::SetChipClock {
        chip: Chip::Ym2151,
        hz: 4_000_000,
    }
    .encode(6)
    .unwrap();
    assert_eq!(
        encoded.as_bytes(),
        &[
            0, 6, 0x4e, 0x44, 1, 0x57, 6, 2, 5, 2, 5, 3, 9, 0x3d, 3, 0x66, 0xe9, 0
        ]
    );
}

#[test]
fn command_limits_and_positions_are_checked() {
    let writes = [RegisterWrite::new(0xff, 0xff); 129];
    assert_eq!(
        Command::WriteYm2151(&writes[..128])
            .to_frame(0)
            .unwrap()
            .payload()
            .len(),
        256
    );
    assert_eq!(
        Command::AudioEvent {
            position: BytePosition::default(),
            event: AudioEvent::Ym2151(&writes[..125])
        }
        .to_frame(0)
        .unwrap()
        .payload()
        .len(),
        255
    );
    assert_eq!(
        Command::AudioData {
            position: BytePosition::new(u32::MAX - 252),
            adpcm: &[1; 252]
        }
        .to_frame(0)
        .unwrap()
        .payload()
        .len(),
        256
    );
    for command in [
        Command::Ping(&[0; 33]),
        Command::WriteYm2151(&[]),
        Command::WriteYm2151(&writes),
        Command::AudioEvent {
            position: BytePosition::default(),
            event: AudioEvent::Ym2151(&writes[..126]),
        },
        Command::AudioEvent {
            position: BytePosition::default(),
            event: AudioEvent::Ym2151(&[]),
        },
        Command::AudioData {
            position: BytePosition::default(),
            adpcm: &[],
        },
        Command::AudioData {
            position: BytePosition::default(),
            adpcm: &[0; 253],
        },
        Command::AudioData {
            position: BytePosition::new(u32::MAX),
            adpcm: &[0],
        },
        Command::SetChipClock {
            chip: Chip::Ym2151,
            hz: 0,
        },
        Command::SetChipClock {
            chip: Chip::OkiM6258,
            hz: 3_579_545,
        },
    ] {
        assert_eq!(command.to_frame(0), Err(Error::InvalidArgument));
    }
    assert!(
        Command::SetChipClock {
            chip: Chip::Ym2151,
            hz: 3_579_545
        }
        .to_frame(0)
        .is_ok()
    );
    assert!(OkiClock::try_from(0).is_err());
    assert!(Divider::try_from(511).is_err());
    assert!(Pan::try_from(4).is_err());
    assert!(ZeroPair::try_from(0x88).is_err());
}

#[test]
fn response_matching_checks_echo_opcode_and_request_id() {
    let request = Command::Ping(b"nonce").to_frame(1).unwrap();
    let valid = Frame::new(0x81, 1, b"\0nonce").unwrap();
    let response = Response::decode(&valid).unwrap();
    assert_eq!(response.status, Status::Complete);
    assert_eq!(response.reply, Reply::Ping(b"nonce"));
    assert_eq!(response.matches_request(&request), Ok(()));
    for frame in [
        Frame::new(0x81, 2, b"\0nonce").unwrap(),
        Frame::new(0x81, 1, b"\0other").unwrap(),
        Frame::new(0x80, 1, &[0]).unwrap(),
    ] {
        assert_eq!(
            Response::decode(&frame).unwrap().matches_request(&request),
            Err(Error::ResponseMismatch)
        );
    }
    assert!(Response::decode(&request).is_err());
}

#[test]
fn parses_info_rejections_unknown_opcodes_and_strict_lengths() {
    let frame = Frame::new(0x82, 0, b"\0\x0bNanoDrive 8\x051.0b8").unwrap();
    let response = Response::decode(&frame).unwrap();
    assert!(
        matches!(response.reply, Reply::Info(info) if info.model == "NanoDrive 8" && info.firmware == "1.0b8")
    );
    for opcode in [0x80, 0xd4] {
        let frame = Frame::new(opcode, 0, &[0]).unwrap();
        assert_eq!(Response::decode(&frame).unwrap().reply, Reply::Complete);
    }
    let frame = Frame::new(0xdb, 0, &[1]).unwrap();
    assert_eq!(Response::decode(&frame).unwrap().reply, Reply::Rejected);
    let frame = Frame::new(0xfe, 0, &[0, 2, 3]).unwrap();
    assert_eq!(
        Response::decode(&frame).unwrap().reply,
        Reply::Unknown(&[2, 3])
    );
    for (opcode, payload) in [
        (0x80, &[][..]),
        (0x80, &[0, 1]),
        (0x80, &[2]),
        (0x82, &[0, 2, b'N']),
        (0x82, &[0, 0, 0, 1]),
        (0xdb, &[0]),
        (0xdb, &[1, 1]),
    ] {
        let frame = Frame::new(opcode, 0, payload).unwrap();
        assert!(Response::decode(&frame).is_err());
    }
    let frame = Frame::new(0x82, 0, &[0, 1, 0xff, 0]).unwrap();
    assert_eq!(Response::decode(&frame), Err(Error::InvalidUtf8));
}

#[test]
fn parses_all_diagnostics_and_preserves_unknown_flag_bits() {
    let values: [u32; 10] = [100, 80, 20, 0, 0, 0, 40, 0x80000001, 3, 2];
    let mut payload = vec![0];
    for value in values {
        payload.extend_from_slice(&value.to_le_bytes());
    }
    let frame = Frame::new(0xdb, 1, &payload).unwrap();
    let Reply::AudioStatus(status) = Response::decode(&frame).unwrap().reply else {
        panic!("wrong reply");
    };
    assert_eq!(
        (status.accepted, status.played, status.pending),
        (100, 80, 20)
    );
    assert_eq!(
        (
            status.underflows,
            status.overflows,
            status.rejected,
            status.max_pending
        ),
        (0, 0, 0, 40)
    );
    assert_eq!((status.late_events, status.max_event_lag), (3, 2));
    assert_eq!(status.flags.bits(), 0x80000001);
    assert!(status.flags.running());
    assert!(!status.flags.fault());
    assert!(!status.flags.ended());
    assert!(StatusFlags::from_bits_retain(5).fault());
    assert!(StatusFlags::from_bits_retain(3).ended());
    payload.push(0);
    assert!(Response::decode(&Frame::new(0xdb, 1, &payload).unwrap()).is_err());
}

#[test]
fn received_requests_borrow_pairs_and_preserve_unknown_opcodes() {
    use ndsif::{Request, RequestEvent};
    let writes = [RegisterWrite::new(0x20, 0xc7), RegisterWrite::new(8, 0x78)];
    for command in [
        Command::WriteYm2151(&writes),
        Command::AudioEvent {
            position: BytePosition::new(23),
            event: AudioEvent::Ym2151(&writes),
        },
    ] {
        let frame = command.to_frame(4).unwrap();
        let pairs = match Request::decode(&frame).unwrap() {
            Request::WriteYm2151(pairs) => pairs,
            Request::AudioEvent {
                position,
                event: RequestEvent::Ym2151(pairs),
            } => {
                assert_eq!(position.get(), 23);
                pairs
            }
            _ => panic!("wrong request"),
        };
        assert_eq!(pairs.len(), 2);
        assert!(!pairs.is_empty());
        assert_eq!(pairs.iter().collect::<Vec<_>>(), writes);
        assert_eq!(pairs.as_bytes(), &[0x20, 0xc7, 8, 0x78]);
    }
    let frame = Frame::new(0x55, 2, &[0x12, 0x34]).unwrap();
    assert_eq!(
        Request::decode(&frame),
        Ok(Request::Unknown {
            opcode: 0x55,
            payload: &[0x12, 0x34]
        })
    );
    for (opcode, payload) in [
        (0x00, &[1][..]),
        (0x02, &[1]),
        (0x54, &[1]),
        (0x56, &[]),
        (0x57, &[0, 0, 0, 0, 1]),
        (0x57, &[5, 0, 0, 0, 0]),
        (0x58, &[0, 0, 0, 0]),
        (0x58, &[255, 255, 255, 255, 1]),
        (0x59, &[0, 0, 0, 0, 0, 1]),
        (0x59, &[0, 0, 0, 0, 2, 4]),
        (0x59, &[0, 0, 0, 0, 3, 0x88]),
        (0x59, &[0, 0, 0, 0, 4, 1]),
        (0x5a, &[0, 0x12, 0x7a, 0, 1, 2]),
        (0x5b, &[0]),
        (0x80, &[0]),
    ] {
        let frame = Frame::new(opcode, 0, payload).unwrap();
        assert!(Request::decode(&frame).is_err());
    }
    let request = Frame::new(0x56, 0, &[1, 2]).unwrap();
    let reply = Frame::new(0xd6, 0, &[0]).unwrap();
    assert_eq!(
        Response::decode(&reply).unwrap().matches_request(&request),
        Err(Error::ResponseMismatch)
    );
}

#[test]
fn every_typed_reply_encodes_expected_payload_and_round_trips() {
    use ndsif::{AudioStatus, DeviceInfo};
    let diagnostics = AudioStatus {
        accepted: 1,
        played: 2,
        pending: 3,
        underflows: 4,
        overflows: 5,
        rejected: 6,
        max_pending: 7,
        flags: StatusFlags::from_bits_retain(0x80000005),
        late_events: 9,
        max_event_lag: 10,
    };
    let mut diagnostic_payload = vec![0];
    for value in [1_u32, 2, 3, 4, 5, 6, 7, 0x80000005, 9, 10] {
        diagnostic_payload.extend_from_slice(&value.to_le_bytes());
    }
    let cases: &[(u8, Reply<'_>, &[u8])] = &[
        (0x80, Reply::Complete, &[0]),
        (0xd4, Reply::Complete, &[0]),
        (0x81, Reply::Ping(b"ND8"), b"\0ND8"),
        (
            0x82,
            Reply::Info(DeviceInfo {
                model: "NanoDrive 8",
                firmware: "1.0b8",
            }),
            b"\0\x0bNanoDrive 8\x051.0b8",
        ),
        (
            0x82,
            Reply::Info(DeviceInfo {
                model: "\u{97f3}\u{6e90}",
                firmware: "\u{03b2}",
            }),
            &[0, 6, 0xe9, 0x9f, 0xb3, 0xe6, 0xba, 0x90, 2, 0xce, 0xb2],
        ),
        (0xdb, Reply::AudioStatus(diagnostics), &diagnostic_payload),
        (0xfe, Reply::Unknown(&[0, 2, 0xff]), &[0, 0, 2, 0xff]),
    ];
    for &(opcode, reply, payload) in cases {
        let response = Response {
            opcode,
            request_id: u16::MAX,
            status: Status::Complete,
            reply,
        };
        let frame = response.to_frame().unwrap();
        assert_eq!(frame.opcode(), opcode);
        assert_eq!(frame.request_id(), u16::MAX);
        assert_eq!(frame.payload(), payload);
        assert_eq!(Response::decode(&frame).unwrap(), response);
        let encoded = response.encode().unwrap();
        let wire = encoded.as_bytes();
        assert_eq!(Frame::decode(&wire[1..wire.len() - 1]).unwrap(), frame);
    }
    for opcode in [0x80, 0x81, 0x82, 0xd4, 0xdb, 0xfe] {
        let response = Response {
            opcode,
            request_id: 42,
            status: Status::Rejected,
            reply: Reply::Rejected,
        };
        let frame = response.to_frame().unwrap();
        assert_eq!(frame.payload(), &[1]);
        assert_eq!(Response::decode(&frame).unwrap(), response);
    }
}

#[test]
fn device_reply_inherits_request_metadata_and_matches_published_ping() {
    let request = Command::Ping(b"ND8").to_frame(1).unwrap();
    let response = Response::for_request(&request, Reply::Ping(b"ND8")).unwrap();
    let encoded = response.encode().unwrap();
    assert_eq!(
        encoded.as_bytes(),
        &[
            0, 6, 0x4e, 0x44, 1, 0x81, 1, 2, 4, 1, 6, 0x4e, 0x44, 0x38, 0xe4, 0x56, 0
        ]
    );
    let mut output = [0xaa; ndsif::MAX_ENCODED_SIZE];
    let length = response.encode_into(&mut output).unwrap();
    assert_eq!(&output[..length], encoded.as_bytes());
    assert!(output[length..].iter().all(|&byte| byte == 0xaa));
    let mut short = vec![0xaa; length - 1];
    assert_eq!(
        response.encode_into(&mut short),
        Err(Error::BufferTooSmall { required: length })
    );
    assert!(short.iter().all(|&byte| byte == 0xaa));
    assert!(Response::for_request(&request, Reply::Ping(b"wrong")).is_err());
    assert_eq!(
        Response::for_request(&request, Reply::Rejected)
            .unwrap()
            .status,
        Status::Rejected
    );
    for opcode in 0x56..=0x5a {
        let request = Frame::new(opcode, 3, &[]).unwrap();
        assert!(Response::for_request(&request, Reply::Rejected).is_err());
    }
    assert!(Response::for_request(&response.to_frame().unwrap(), Reply::Rejected).is_err());
    let unknown = Frame::new(0x7e, 0x1234, &[1, 2]).unwrap();
    let rejection = Response::for_request(&unknown, Reply::Rejected)
        .unwrap()
        .to_frame()
        .unwrap();
    assert_eq!(rejection, Frame::new(0xfe, 0x1234, &[1]).unwrap());
}

#[test]
fn response_encoding_rejects_inconsistent_fields_and_payload_limits() {
    use ndsif::DeviceInfo;
    for echo in [&[][..], &[0xff; 32]] {
        let request = Command::Ping(echo).to_frame(0).unwrap();
        let response = Response::for_request(&request, Reply::Ping(echo)).unwrap();
        let frame = response.to_frame().unwrap();
        assert_eq!(Response::decode(&frame).unwrap(), response);
    }
    for response in [
        Response {
            opcode: 0x80,
            request_id: 0,
            status: Status::Complete,
            reply: Reply::Rejected,
        },
        Response {
            opcode: 0x81,
            request_id: 0,
            status: Status::Rejected,
            reply: Reply::Ping(&[]),
        },
        Response {
            opcode: 0x80,
            request_id: 0,
            status: Status::Complete,
            reply: Reply::Ping(&[]),
        },
        Response {
            opcode: 0x81,
            request_id: 0,
            status: Status::Complete,
            reply: Reply::Complete,
        },
        Response {
            opcode: 1,
            request_id: 0,
            status: Status::Complete,
            reply: Reply::Ping(&[]),
        },
        Response {
            opcode: 0x81,
            request_id: 0,
            status: Status::Complete,
            reply: Reply::Ping(&[0; 33]),
        },
        Response {
            opcode: 0xfe,
            request_id: 0,
            status: Status::Complete,
            reply: Reply::Unknown(&[0; 256]),
        },
    ] {
        assert!(response.to_frame().is_err());
    }
    let firmware = "f".repeat(64);
    let model = "m".repeat(256);
    for info in [
        DeviceInfo {
            model: "ND8",
            firmware: &firmware,
        },
        DeviceInfo {
            model: &model,
            firmware: "",
        },
    ] {
        let response = Response {
            opcode: 0x82,
            request_id: 0,
            status: Status::Complete,
            reply: Reply::Info(info),
        };
        assert!(response.to_frame().is_err());
    }
    let model = "m".repeat(190);
    let firmware = "f".repeat(63);
    let response = Response {
        opcode: 0x82,
        request_id: 0,
        status: Status::Complete,
        reply: Reply::Info(DeviceInfo {
            model: &model,
            firmware: &firmware,
        }),
    };
    let frame = response.to_frame().unwrap();
    assert_eq!(frame.payload().len(), 256);
    assert_eq!(Response::decode(&frame).unwrap(), response);
    let model = "m".repeat(191);
    let response = Response {
        reply: Reply::Info(DeviceInfo {
            model: &model,
            firmware: &firmware,
        }),
        ..response
    };
    assert_eq!(
        response.to_frame(),
        Err(Error::PayloadTooLong { length: 257 })
    );
    let response = Response {
        opcode: 0xfe,
        request_id: 0,
        status: Status::Complete,
        reply: Reply::Unknown(&[0xff; 255]),
    };
    let frame = response.to_frame().unwrap();
    assert_eq!(frame.payload().len(), 256);
    assert_eq!(Response::decode(&frame).unwrap(), response);
}

#[test]
fn all_audio_clock_divider_pan_and_end_values_decode_without_transformation() {
    use ndsif::{Request, RequestEvent};
    let position = BytePosition::new(0x01020304);
    for (clock, clock_bytes) in [
        (OkiClock::Mhz4, [0, 9, 0x3d, 0]),
        (OkiClock::Mhz8, [0, 0x12, 0x7a, 0]),
    ] {
        for (divider, divider_bytes) in [
            (Divider::Div512, [0, 2]),
            (Divider::Div768, [0, 3]),
            (Divider::Div1024, [0, 4]),
        ] {
            let mut settings = clock_bytes.to_vec();
            settings.extend_from_slice(&divider_bytes);
            let start = Command::AudioStart { clock, divider }.to_frame(1).unwrap();
            assert_eq!(start.payload(), settings);
            assert_eq!(
                Request::decode(&start).unwrap(),
                Request::AudioStart { clock, divider }
            );
            let event = Command::AudioEvent {
                position,
                event: AudioEvent::OkiSettings { clock, divider },
            }
            .to_frame(2)
            .unwrap();
            let mut expected = vec![4, 3, 2, 1, 1];
            expected.extend_from_slice(&settings);
            assert_eq!(event.payload(), expected);
            assert_eq!(
                Request::decode(&event).unwrap(),
                Request::AudioEvent {
                    position,
                    event: RequestEvent::OkiSettings { clock, divider }
                }
            );
        }
    }
    for (pan, value) in [
        (Pan::Both, 0),
        (Pan::Left, 1),
        (Pan::Right, 2),
        (Pan::Off, 3),
    ] {
        let event = Command::AudioEvent {
            position,
            event: AudioEvent::Pan(pan),
        }
        .to_frame(3)
        .unwrap();
        assert_eq!(event.payload(), &[4, 3, 2, 1, 2, value]);
        assert_eq!(
            Request::decode(&event).unwrap(),
            Request::AudioEvent {
                position,
                event: RequestEvent::Pan(pan)
            }
        );
    }
    for (pair, value) in [(ZeroPair::Byte80, 0x80), (ZeroPair::Byte08, 0x08)] {
        let event = Command::AudioEvent {
            position,
            event: AudioEvent::End(pair),
        }
        .to_frame(4)
        .unwrap();
        assert_eq!(event.payload(), &[4, 3, 2, 1, 3, value]);
        assert_eq!(
            Request::decode(&event).unwrap(),
            Request::AudioEvent {
                position,
                event: RequestEvent::End(pair)
            }
        );
    }
}

#[test]
fn delphi_audio_reports_preserve_reset_running_ended_and_fault_diagnostics() {
    use ndsif::AudioStatus;
    let reasons = [
        (0x008, StatusFlags::USB_BUS_RESET),
        (0x010, StatusFlags::RECEIVE_OVERFLOW),
        (0x020, StatusFlags::RECEIVE_DISCARDED),
        (0x040, StatusFlags::PCM_UNDERFLOW),
        (0x080, StatusFlags::PCM_OVERFLOW),
        (0x100, StatusFlags::EVENT_OVERFLOW),
        (0x200, StatusFlags::ARGUMENT_REJECTED),
    ];
    let request = Command::AudioStatus.to_frame(0x1234).unwrap();
    for flags in [
        0, 1, 3, 5, 0x00d, 0x015, 0x025, 0x045, 0x085, 0x105, 0x205, 0x3fd, 0x80000005,
    ] {
        let played = if flags & 2 != 0 { 0x10000 } else { 0xff00 };
        let values = if flags == 0 {
            [0; 10]
        } else {
            [
                0x10000,
                played,
                0x10000 - played,
                u32::from(flags & 0x040 != 0),
                u32::from(flags & 0x180 != 0),
                u32::from(flags & 0x200 != 0),
                512,
                flags,
                6,
                7,
            ]
        };
        let report = AudioStatus {
            accepted: values[0],
            played: values[1],
            pending: values[2],
            underflows: values[3],
            overflows: values[4],
            rejected: values[5],
            max_pending: values[6],
            flags: StatusFlags::from_bits_retain(values[7]),
            late_events: values[8],
            max_event_lag: values[9],
        };
        let response = Response::for_request(&request, Reply::AudioStatus(report)).unwrap();
        let encoded = response.encode().unwrap();
        let wire = encoded.as_bytes();
        let frame = Frame::decode(&wire[1..wire.len() - 1]).unwrap();
        let mut expected = vec![0];
        for value in values {
            expected.extend_from_slice(&value.to_le_bytes());
        }
        assert_eq!(frame.payload(), expected);
        let response = Response::decode(&frame).unwrap();
        assert_eq!(response.matches_request(&request), Ok(()));
        let Reply::AudioStatus(decoded) = response.reply else {
            panic!("wrong reply");
        };
        assert_eq!(decoded, report);
        assert_eq!(decoded.flags.running(), flags & 1 != 0);
        assert_eq!(decoded.flags.ended(), flags & 2 != 0);
        assert_eq!(decoded.flags.fault(), flags & 4 != 0);
        for (mask, reason) in reasons {
            assert_eq!(reason.bits(), mask);
            assert_eq!(decoded.flags.contains(reason), flags & mask != 0);
        }
    }
}
