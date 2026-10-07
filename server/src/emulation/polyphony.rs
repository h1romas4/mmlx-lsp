#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Note {
    pub source: u8,
    pub channel: u8,
    pub note: u8,
}

#[derive(Clone, Copy, Default)]
pub struct Slot {
    pub note: Option<Note>,
    pub age: u64,
    pub attenuation: u8,
}

#[derive(Default)]
pub struct Polyphony {
    pub slots: [Slot; 8],
    age: u64,
}

impl Polyphony {
    pub fn allocate(&mut self, note: Note, velocity: u8) -> usize {
        let index = self
            .slots
            .iter()
            .position(|slot| slot.note == Some(note))
            .or_else(|| {
                self.slots
                    .iter()
                    .enumerate()
                    .filter(|(_, slot)| slot.note.is_none())
                    .min_by_key(|(_, slot)| slot.age)
                    .map(|(index, _)| index)
            })
            .unwrap_or_else(|| {
                self.slots
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, slot)| slot.age)
                    .unwrap()
                    .0
            });
        self.age += 1;
        self.slots[index] = Slot {
            note: Some(note),
            age: self.age,
            attenuation: (-40.0 * (velocity as f32 / 127.0).log10())
                .round()
                .clamp(0.0, 127.0) as u8,
        };
        index
    }

    pub fn release(&mut self, note: Note) -> Option<usize> {
        let index = self.slots.iter().position(|slot| slot.note == Some(note))?;
        self.slots[index].note = None;
        Some(index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eight_notes_retrigger_stealing_and_stale_off() {
        let mut allocator = Polyphony::default();
        for index in 0..8 {
            assert_eq!(
                allocator.allocate(
                    Note {
                        source: 0,
                        channel: 0,
                        note: 60 + index
                    },
                    127
                ),
                index as usize
            );
        }
        let extra = Note {
            source: 1,
            channel: 2,
            note: 60,
        };
        assert_eq!(allocator.allocate(extra, 100), 0);
        assert_eq!(
            allocator.release(Note {
                source: 0,
                channel: 0,
                note: 60
            }),
            None
        );
        assert_eq!(allocator.allocate(extra, 80), 0);
        assert_eq!(allocator.release(extra), Some(0));
        assert_eq!(
            allocator.allocate(
                Note {
                    source: 0,
                    channel: 0,
                    note: 75
                },
                127
            ),
            0
        );
    }
}
