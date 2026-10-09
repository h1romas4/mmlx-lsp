use ndsif::{Error, Frame, MAX_ENCODED_SIZE};

#[test]
fn published_ping_vectors() {
    let request = [
        0x00, 0x06, 0x4e, 0x44, 0x01, 0x01, 0x01, 0x02, 0x03, 0x06, 0x4e, 0x44, 0x38, 0x33, 0x96,
        0x00,
    ];
    let response = [
        0x00, 0x06, 0x4e, 0x44, 0x01, 0x81, 0x01, 0x02, 0x04, 0x01, 0x06, 0x4e, 0x44, 0x38, 0xe4,
        0x56, 0x00,
    ];
    for (wire, opcode, payload) in [
        (&request[..], 1, &b"ND8"[..]),
        (&response[..], 0x81, &b"\0ND8"[..]),
    ] {
        let frame = Frame::new(opcode, 1, payload).unwrap();
        assert_eq!(frame.encode().as_bytes(), wire);
        assert_eq!(Frame::decode(&wire[1..wire.len() - 1]).unwrap(), frame);
    }
}

#[test]
fn crc_check_value() {
    assert_eq!(ndsif::frame::checksum(b"123456789"), 0x29b1);
}

#[test]
fn maximum_payload_round_trips_and_output_is_bounded() {
    for payload in [
        [0; 256],
        [0xff; 256],
        core::array::from_fn(|index| index as u8),
    ] {
        let frame = Frame::new(0x56, u16::MAX, &payload).unwrap();
        let encoded = frame.encode();
        let wire = encoded.as_bytes();
        assert!(wire.len() <= MAX_ENCODED_SIZE);
        assert_eq!(wire[0], 0);
        assert_eq!(wire[wire.len() - 1], 0);
        assert!(!wire[1..wire.len() - 1].contains(&0));
        assert_eq!(Frame::decode(&wire[1..wire.len() - 1]).unwrap(), frame);
    }
    assert!(matches!(
        Frame::new(0, 0, &[0; 257]),
        Err(Error::PayloadTooLong { .. })
    ));
    assert!(matches!(
        Frame::new(0, 0, &[]).unwrap().encode_into(&mut [0; 1]),
        Err(Error::BufferTooSmall { .. })
    ));
}

fn cobs_body(raw: &[u8]) -> Vec<u8> {
    let mut encoded = vec![0; 300];
    let length = cobs::encode(raw, &mut encoded);
    encoded.truncate(length);
    encoded
}

#[test]
fn rejects_corruption_at_each_frame_validation_layer() {
    let mut raw = [0x4e, 0x44, 1, 0, 0, 0, 0, 0, 0, 0];
    let crc = ndsif::frame::checksum(&raw[..8]);
    raw[8..].copy_from_slice(&crc.to_le_bytes());
    assert!(Frame::decode(&cobs_body(&raw)).is_ok());
    let mut damaged = raw;
    damaged[0] ^= 1;
    assert_eq!(
        Frame::decode(&cobs_body(&damaged)),
        Err(Error::InvalidMagic)
    );
    let mut damaged = raw;
    damaged[2] = 2;
    assert_eq!(
        Frame::decode(&cobs_body(&damaged)),
        Err(Error::UnsupportedVersion(2))
    );
    let mut damaged = raw;
    damaged[6] = 1;
    assert_eq!(
        Frame::decode(&cobs_body(&damaged)),
        Err(Error::InvalidLength)
    );
    let mut damaged = raw;
    damaged[7] = 2;
    assert_eq!(
        Frame::decode(&cobs_body(&damaged)),
        Err(Error::InvalidLength)
    );
    let mut damaged = raw;
    damaged[8] ^= 1;
    assert!(matches!(
        Frame::decode(&cobs_body(&damaged)),
        Err(Error::CrcMismatch { .. })
    ));
    assert_eq!(
        Frame::decode(&cobs_body(&raw[..9])),
        Err(Error::InvalidLength)
    );
    for bytes in [&[][..], &[0], &[3, 1]] {
        assert_eq!(Frame::decode(bytes), Err(Error::InvalidCobs));
    }
    assert_eq!(Frame::decode(&[1; 269]), Err(Error::FrameTooLong));
    let frame = Frame::new(0x7e, 0xffff, &[0, 0xff]).unwrap();
    let encoded = frame.encode();
    let wire = encoded.as_bytes();
    assert_eq!(Frame::decode(&wire[1..wire.len() - 1]).unwrap(), frame);
}
