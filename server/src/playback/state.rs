//! Scans MML playback settings active at a source offset.

use mmlx::mdx::{
    MmlCommand,
    frontend::{CommandSource, parse},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MmlPlaybackState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tempo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub octave: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gate: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opm_lfo: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStateScan {
    pub state: MmlPlaybackState,
    pub has_tempo: bool,
    pub has_length: bool,
    pub has_octave: bool,
    pub has_volume: bool,
    pub has_gate: bool,
    pub has_pan: bool,
    pub has_opm_lfo: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStateRequest {
    pub source: String,
    pub offset: usize,
    #[serde(default)]
    pub initial_state: MmlPlaybackState,
}

fn collect_commands<'a>(
    commands: &'a [MmlCommand],
    sources: &'a [CommandSource],
    positioned: &mut Vec<(usize, &'a MmlCommand, mmlx::source::Span)>,
) -> bool {
    if commands.len() != sources.len() {
        return false;
    }
    for (command, source) in commands.iter().zip(sources) {
        positioned.push((source.position.start(), command, source.position));
        if let MmlCommand::Repeat { body, .. } = command
            && !collect_commands(body, &source.body, positioned)
        {
            return false;
        }
    }
    true
}

pub fn scan(
    source: &str,
    offset: usize,
    initial_state: MmlPlaybackState,
) -> Option<PlaybackStateScan> {
    if offset > source.len() || !source.is_char_boundary(offset) {
        return None;
    }
    let parsed = match parse(source) {
        Ok(parsed) => parsed,
        Err(_) if offset < source.len() => parse(&source[..offset]).ok()?,
        Err(_) => return None,
    };
    let mut positioned = Vec::new();
    for (index, track) in parsed.ast().tracks.iter().enumerate() {
        if !collect_commands(
            &track.commands,
            parsed.syntax().commands(index)?,
            &mut positioned,
        ) {
            return None;
        }
    }
    positioned.sort_by_key(|(start, _, _)| *start);

    let mut scan = PlaybackStateScan {
        state: initial_state,
        ..PlaybackStateScan::default()
    };
    for (_, command, span) in positioned {
        if span.end() > offset {
            continue;
        }
        let text = span.text(source)?;
        match command {
            MmlCommand::Tempo(_) | MmlCommand::OpmTempo(_) => {
                scan.state.tempo = Some(text.to_owned());
                scan.has_tempo = true;
            }
            MmlCommand::DefaultLength(_) | MmlCommand::DefaultLengthReset => {
                scan.state.length = Some(text.to_owned());
                scan.has_length = true;
            }
            MmlCommand::Octave(value) => {
                scan.state.octave = Some(*value);
                scan.has_octave = true;
            }
            MmlCommand::OctaveDown | MmlCommand::OctaveUp => {
                let octave = scan.state.octave.unwrap_or(4);
                scan.state.octave = Some(match command {
                    MmlCommand::OctaveDown => octave.saturating_sub(1),
                    MmlCommand::OctaveUp => octave.saturating_add(1),
                    _ => unreachable!(),
                });
                scan.has_octave = true;
            }
            MmlCommand::Volume(_) | MmlCommand::FineVolume(_) => {
                scan.state.volume = Some(vec![text.to_owned()]);
                scan.has_volume = true;
            }
            MmlCommand::VolumeDown | MmlCommand::VolumeUp => {
                scan.state
                    .volume
                    .get_or_insert_with(Vec::new)
                    .push(text.to_owned());
                scan.has_volume = true;
            }
            MmlCommand::Gate(_) | MmlCommand::FineGate(_) => {
                scan.state.gate = Some(text.to_owned());
                scan.has_gate = true;
            }
            MmlCommand::Pan(_) => {
                scan.state.pan = Some(text.to_owned());
                scan.has_pan = true;
            }
            MmlCommand::OpmLfo { .. } => {
                let enabled = scan.state.opm_lfo.as_ref().and_then(|commands| {
                    commands
                        .iter()
                        .find(|command| matches!(command.as_str(), "MHON" | "MHOF"))
                });
                scan.state.opm_lfo = Some(
                    std::iter::once(text.to_owned())
                        .chain(enabled.cloned())
                        .collect(),
                );
                scan.has_opm_lfo = true;
            }
            MmlCommand::OpmLfoOn | MmlCommand::OpmLfoOff => {
                let configuration = scan.state.opm_lfo.as_ref().and_then(|commands| {
                    commands
                        .iter()
                        .find(|command| !matches!(command.as_str(), "MHON" | "MHOF"))
                });
                scan.state.opm_lfo = Some(
                    configuration
                        .cloned()
                        .into_iter()
                        .chain(std::iter::once(text.to_owned()))
                        .collect(),
                );
                scan.has_opm_lfo = true;
            }
            _ => {}
        }
    }
    Some(scan)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_typed_commands_and_ignores_pitch_lfo_parameters() {
        let source = "A @t199@3v15MD1MP2,6,2q8\nA r4o6c4.<a+4&a+8 r4>d4.c4&c8 r4c4.<a+4. a8a4g4&g4@0v11f16g16 a2";
        let scan = scan(source, source.len(), MmlPlaybackState::default()).unwrap();
        assert_eq!(
            scan.state,
            MmlPlaybackState {
                tempo: Some("@t199".into()),
                octave: Some(5),
                volume: Some(vec!["v11".into()]),
                gate: Some("q8".into()),
                ..MmlPlaybackState::default()
            }
        );
        assert!(!scan.has_pan);
    }

    #[test]
    fn scans_state_before_utf8_byte_offsets_and_nested_repeats() {
        let source = "#title \"🎵 t200\"\nA t120 l8 o5 [v10 (c4 q8]2 p1";
        let before_repeat_end = source.find(" p1").unwrap();
        let scan = scan(source, before_repeat_end, MmlPlaybackState::default()).unwrap();
        assert_eq!(scan.state.tempo.as_deref(), Some("t120"));
        assert_eq!(scan.state.length.as_deref(), Some("l8"));
        assert_eq!(scan.state.octave, Some(5));
        assert_eq!(scan.state.volume, Some(vec!["v10".into(), "(".into()]));
        assert_eq!(scan.state.gate.as_deref(), Some("q8"));
        assert_eq!(scan.state.pan, None);
        assert!(!scan.has_pan);
    }

    #[test]
    fn tracks_hardware_lfo_configuration_and_enable_state() {
        let source = "A MH0,200,64,0,5,0,1 MHON MH1,128,32,0,4,0,1 MHOF";
        let scan = scan(source, source.len(), MmlPlaybackState::default()).unwrap();
        assert_eq!(
            scan.state.opm_lfo,
            Some(vec!["MH1,128,32,0,4,0,1".into(), "MHOF".into()])
        );
        assert!(scan.has_opm_lfo);
    }
}
