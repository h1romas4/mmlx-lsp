# ndsif

Allocation-free, `no_std` Rust codec for the NDSIF v1 protocol used by NanoDrive8.
Based on the NDSIF specification, document version 0.34 (Draft).
The wire protocol version is `01`, independently of the document version.

## Scope

- COBS framing and CRC-16/CCITT-FALSE, with fixed-size buffers.
- Incremental decoding, split/concatenated frames and delimiter resynchronization.
- All currently specified FM and ADPCM requests, typed request/response parsing,
  local argument validation, diagnostics and response correlation.
- Unknown opcodes in raw frames and unknown diagnostic bits are retained.
- Allocation-free batch encoding, protocol-limit splitting and integer audio timing.

No serial I/O, OS clocks, threads, async runtime, allocation or request queue.
VGM/MML/MIDI parsing, PCM synthesis, ADPCM encoding, resampling and playback
scheduling are outside this crate. The proposed future tick-chunk protocol is
not implemented.

## Sending and Receiving

```rust
use ndsif::{Command, Decoder, Error, Frame, Reply, Response};

let request = Command::Ping(b"ND8").to_frame(1)?;
let outgoing = request.encode();
// Pass outgoing.as_bytes() to your transport's write-all operation.
assert_eq!(outgoing.as_bytes()[0], 0);

// Simulated incoming bytes; real transports can split these anywhere.
let incoming = Frame::new(0x81, 1, b"\0ND8")?.encode();
let mut decoder = Decoder::new();
let mut matched = false;
for chunk in incoming.as_bytes().chunks(3) {
    decoder.push(chunk, |result| {
        let frame = result.unwrap();
        let response = Response::decode(&frame).unwrap();
        response.matches_request(&request).unwrap();
        assert_eq!(response.reply, Reply::Ping(b"ND8"));
        matched = true;
    });
}
assert!(matched);
# Ok::<(), Error>(())
```

`Frame::encode()` and `Command::encode()` include both zero delimiters.
`Frame::decode()` accepts only the COBS body without delimiters; use `Decoder`
for a transport byte stream. `encode_into()` is also available for caller-owned
output buffers. Frames own their payload; parsed requests and responses borrow
from the frame. No transport read/write boundary is treated as a frame boundary.

`Decoder::new()` waits for the first zero delimiter, ignoring preceding boot
logs. Empty delimiters are ignored. Overflow reports one `FrameTooLong` error
and discards through the next delimiter. Invalid frames report a parse error;
later frames in the same chunk are still delivered. Production callbacks should
handle errors rather than unwrap them as the example does.

The caller measures inactivity from the last received byte. If a partial frame
has been inactive for `PARTIAL_FRAME_TIMEOUT_MS` (500 ms), call
`expire_partial_frame()`. The remainder is discarded through the next delimiter.
Call `Decoder::reset()` when switching or reopening transports. This only resets
the parser, not the hardware; `Command::Reset` is the distinct wire command.

## Output Volume

```rust
use ndsif::{Command, Error};

let request = Command::SetOutputVolume { attenuation: 12 }.to_frame(5)?;
assert_eq!(request.opcode(), 0x03);
assert_eq!(request.payload(), &[12]);
# Ok::<(), Error>(())
```

Attenuation is `0..=96`: 0 applies no attenuation, 1..=95 attenuates in 1 dB
steps, and 96 mutes. The command affects both main output channels, not input
gain or OKI pan. Invalid values are rejected locally rather than clamped.
The `0x83` response is `Reply::Complete` or `Reply::Rejected`; older firmware
rejects unsupported requests. Completion confirms software processing, not
I2C acknowledgement or hardware readback.

The device retains the setting across RESET, but not reboot; serial-mode startup
defaults to 0. The protocol does not provide a volume readback or timed volume event.

## Registers and ADPCM

```rust
use ndsif::{AudioEvent, BytePosition, Command, Error, RegisterWrite, Request,
            RequestEvent};

let writes = [RegisterWrite::new(0x20, 0xc7), RegisterWrite::new(0x08, 0x78)];
let immediate = Command::WriteYm2151Burst(&writes).to_frame(2)?;
assert!(!Command::WriteYm2151Burst(&writes).expects_response());

let position = BytePosition::new(0);
let event = Command::AudioEvent {
    position,
    event: AudioEvent::Ym2151(&writes),
}.to_frame(3)?;

// This is already-encoded ADPCM; the crate does not produce or transform it.
let adpcm = [0x12, 0x34];
let data = Command::AudioData { position, adpcm: &adpcm }.to_frame(4)?;
let next_position = position.checked_advance(adpcm.len())?;
assert_eq!(next_position.get(), 2);
// Send event before data. Startup/reset/prebuffering are managed by the caller.

if let Request::AudioEvent { event: RequestEvent::Ym2151(pairs), .. }
    = Request::decode(&event)?
{
    assert_eq!(pairs.iter().next(), Some(writes[0]));
}
# let _ = (immediate, data);
# Ok::<(), Error>(())
```

Immediate register writes accept 1..=128 pairs; positioned FM events accept
1..=125 pairs. Each pair consumes one device event slot. DATA accepts 1..=252
ADPCM bytes. `BytePosition` counts bytes, not samples or ticks, and rejects
overflow rather than wrapping. One ADPCM byte is consumed low nibble first.

The limits are exported as `MAX_YM2151_WRITES`, `MAX_YM2151_EVENT_WRITES` and
`MAX_AUDIO_DATA_BYTES`. Single `Command` values still reject oversized input.
`CommandEncoder` splits larger slices and delivers complete encoded frames to
an infallible callback, without allocating or owning a transport:

```rust
use ndsif::{BytePosition, CommandEncoder, Error, RegisterWrite};

let writes = [RegisterWrite::new(0x20, 0xc7); 129];
let adpcm = [0x12; 253];
let mut encoded_bytes = 0;
let mut encoder = CommandEncoder::new(7, |frame: &[u8]| {
  encoded_bytes += frame.len();
});
encoder.ym2151_burst(&writes)?;
encoder.ym2151_event(BytePosition::new(0), &writes)?;
let end = encoder.audio_data(BytePosition::new(0), &adpcm)?;
assert_eq!(end.get(), 253);
assert_eq!(encoder.count(), 6);
assert_eq!(encoder.next_request_id(), 13);
assert!(encoded_bytes > adpcm.len());
# Ok::<(), Error>(())
```

The callback borrows each frame only for that invocation; copy it into a
caller-owned buffer if it must outlive the callback. `push()` adds any single
command to the same sequence. Request IDs wrap at 16 bits. Empty split inputs
emit nothing. DATA position overflow is rejected before any DATA is emitted.
Positions describe encoded requests, not device acceptance. Event/DATA/END
ordering and transport error handling remain the caller's responsibility.

`AudioTiming` converts ticks and ADPCM bytes using the exact clock/divider
ratio, including divider 768. Conversions round down, reject zero tick rates
and check overflow. Use a sample converter for consecutive durations to retain
fractional samples; instantiate a new converter when timing settings change:

```rust
use ndsif::{AudioTiming, Divider, Error, OkiClock};

let timing = AudioTiming::new(OkiClock::Mhz8, Divider::Div512);
assert_eq!(timing.ticks_from_bytes(160, 1_000_000)?, 20_480);
assert_eq!(timing.bytes_from_ticks(20_480, 1_000_000)?, 160);
let mut converter = timing.sample_converter(44_100)?;
assert_eq!(converter.advance(1)?, 0);
assert_eq!(converter.advance(44_099)?, 15_625);
# Ok::<(), Error>(())
```

Typed commands validate lengths, supported chip IDs, nonzero YM clocks, the
4/8 MHz OKI clock choices, dividers 512/768/1024, PAN and END values. YM clocks
can be normalized by firmware; the transmitted Hz value is not clock readback.
`ZeroPair` only restricts END to `80`/`08`; the caller must choose the value for
its continuous encoder state. Neither is a universal silence byte.

These checks do **not** validate device state. The caller tracks accepted byte
positions, ascending event order, event-before-DATA ordering, prebuffering,
startup, END-after-last-DATA and RESET-before-resume. No DATA/EVENT is permitted
after END until RESET. Audio clock/divider changes also require corresponding
changes to the caller's resampler and scheduling.

## Responses and Caller Responsibilities

### Device-Side Encoding

`Response::for_request()` inherits the request opcode and ID, derives status
from the reply and checks the reply shape, including successful PING echo.
It rejects requests without a defined response and incoming response frames.
The device must first decide acceptance and perform any required operation;
constructing a response does not execute a command.

```rust
use ndsif::{Command, Error, Reply, Request, Response};

let incoming = Command::Ping(b"ND8").to_frame(42)?;
if let Request::Ping(echo) = Request::decode(&incoming)? {
  let response = Response::for_request(&incoming, Reply::Ping(echo))?;
  let outgoing = response.encode()?;
  assert_eq!(outgoing.as_bytes()[0], 0);
  assert_eq!(response.request_id, 42);
}

let unknown = ndsif::Frame::new(0x7e, 43, &[])?;
let rejection = Response::for_request(&unknown, Reply::Rejected)?.to_frame()?;
assert_eq!(rejection.opcode(), 0xfe);
assert_eq!(rejection.payload(), &[1]);
# Ok::<(), Error>(())
```

`Reply::Complete`, `Reply::Info(DeviceInfo { .. })` and
`Reply::AudioStatus(AudioStatus { .. })` encode completion, GET_INFO and
diagnostic responses respectively. `Reply::Rejected` emits only status `01`,
including for unsupported AUDIO_STATUS requests.

Like commands, responses provide `to_frame()`, `encode()` and `encode_into()`.
The request ID is already part of `Response`, so these methods do not take it
again. Outgoing responses use fixed-size buffers and reject inconsistent
status/opcode/reply combinations and excessive payloads. Direct construction
of `Response` is available when forwarding decoded responses; `for_request()`
is the preferred device-side constructor.

### Host-Side Decoding

`Response::decode()` distinguishes completion, rejection, PING echo, device
info, audio diagnostics and unknown replies. Rejected `AUDIO_STATUS` may contain
only its status byte, as with older firmware. Successful diagnostics must have
all ten fields. GET_INFO validates UTF-8, string lengths, firmware's 63-byte
limit and the payload's exact end.

`matches_request()` verifies opcode and request ID, plus echo on successful
PING. Rejection is a matching response, not completion: inspect `status`/`reply`.
It does not wait, retry, or track pending requests. A completion means software
processing completed, not audio playback or hardware readback. PING is a barrier
for preceding immediate commands, not future events or ADPCM playback.

The caller must:

- Handle transport setup, partial writes, reconnects and disconnects.
- Allocate request IDs and permit at most one response-bearing request in flight.
- Track response deadlines and ignore stale or mismatched replies.
- Decide retries: IDs provide no deduplication or session isolation. RESET and
  register-write response loss leaves execution uncertain; do not auto-retry
  these while preserving playback.
- Validate device identity and capability by actual replies, not FW text alone.
- Check `StatusFlags::fault()`; unknown high bits are retained, and late events
  alone do not imply a fault.
- Arrange cleanup and recovery. A broken connection can leave FM sounding;
  this codec cannot guarantee silence. ADPCM fault does not automatically stop FM.

`Frame::new()` is the raw escape hatch for future/unsupported opcodes or malformed
command test payloads. Frame validation and typed argument validation are separate.
An unknown request can be decoded without inventing a meaning for its payload.
Current hardware queue capacities are not negotiated capabilities and are not
enforced by this codec.

## Modules

| Module | Responsibility |
| --- | --- |
| `frame` | Raw v1 frames, CRC, COBS, fixed encoded buffers |
| `decoder` | Incremental stream parsing and resynchronization |
| `command` | Outgoing commands and borrowed incoming requests |
| `response` | Outgoing responses, incoming parsing, diagnostics and correlation |
| `types` | Register pairs, byte positions, clock/PAN/END enums, flags |
| `error` | Transport-independent format/argument errors |

The implementation uses the `cobs` and `crc` crates with default features disabled.
