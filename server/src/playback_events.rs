use serde::Serialize;
use soundlog::chip::event::StateEvent;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FmKeyEvent {
    pub position: f64,
    pub channel: u8,
    pub note: Option<u8>,
}

pub fn fm_key_events(sample: usize, events: Option<Vec<StateEvent>>) -> Vec<FmKeyEvent> {
    events
        .into_iter()
        .flatten()
        .filter_map(|event| {
            let (channel, note) = match event {
                StateEvent::KeyOn { channel, tone } | StateEvent::ToneChange { channel, tone } => {
                    let note = tone
                        .freq_hz
                        .filter(|frequency| frequency.is_finite() && *frequency > 0.0)
                        .map(|frequency| {
                            (69.0 + 12.0 * (f64::from(frequency) / 440.0).log2()).round()
                        })
                        .filter(|note| (21.0..=108.0).contains(note))
                        .map(|note| note as u8);
                    (channel, note)
                }
                StateEvent::KeyOff { channel } => (channel, None),
            };
            (channel < 8).then_some(FmKeyEvent {
                position: sample as f64 / 44100.0,
                channel,
                note,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use soundlog::chip::event::ToneInfo;

    #[test]
    fn tracks_key_on_pitch_change_and_key_off() {
        let tone = |frequency| ToneInfo::new(0, 0, Some(frequency));
        let events = fm_key_events(
            44100,
            Some(vec![
                StateEvent::KeyOn {
                    channel: 0,
                    tone: tone(440.0),
                },
                StateEvent::ToneChange {
                    channel: 0,
                    tone: tone(466.16376),
                },
                StateEvent::KeyOff { channel: 0 },
            ]),
        );
        assert_eq!(
            events.iter().map(|event| event.note).collect::<Vec<_>>(),
            vec![Some(69), Some(70), None]
        );
        assert!(
            events
                .iter()
                .all(|event| event.position == 1.0 && event.channel == 0)
        );
    }

    #[test]
    fn invalid_and_out_of_range_frequencies_clear_the_key() {
        for frequency in [
            None,
            Some(f32::NAN),
            Some(f32::INFINITY),
            Some(0.0),
            Some(-1.0),
            Some(1.0),
            Some(20000.0),
        ] {
            let events = fm_key_events(
                0,
                Some(vec![StateEvent::KeyOn {
                    channel: 7,
                    tone: ToneInfo::new(0, 0, frequency),
                }]),
            );
            assert_eq!(events[0].note, None);
        }
        assert!(fm_key_events(0, Some(vec![StateEvent::KeyOff { channel: 8 }])).is_empty());
        assert!(fm_key_events(0, None).is_empty());
    }
}
