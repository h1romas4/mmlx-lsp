# Change Log

All notable changes to the "mmlx-lsp" extension will be documented in this file.

## [0.13.0] - 2026-10-09

- Use a 4 MHz FM Voice clock on Emulation and NanoDrive8 so MML, keyboard and MIDI audition stay in tune.
- Buffer about 205 ms ahead during NanoDrive8 PCM playback to better tolerate brief host stalls, and report supply callback gaps in failure diagnostics.
- Enable NanoDrive8 output volume during playback using the device volume API.

## [0.12.0] - 2026-10-09

- Add Chip State MML for short MML tests and hardware LFO setup on Emulation and NanoDrive8, with Enter-to-play and saved input.
- Keep applied hardware LFO, pan and operator settings across all eight keyboard voices after testing.
- Add a sound-chip reset button that keeps the output connected.
- Add subtle action animations and clear MML error feedback, reduce control flicker, and prevent unwanted sounds after tests end.

## [0.11.1] - 2026-10-09

- Record detailed NanoDrive8 playback faults before RESET and prefetch PCM on the host to absorb temporary generation delays without increasing device buffering.

## [0.11.0] - 2026-10-09

- Add a +/-2-semitone pitch-bend wheel with spring return and MIDI-IN synchronization for Emulation and NanoDrive8.
- Apply ADPCM and PDX settings to NanoDrive8 Playback and default ADPCM processing to Resample.
- Make the Playback Stop button the same size as Play and highlight it when stopping is available.

## [0.10.0] - 2026-10-09

- Add experimental NanoDrive8 support.

## [0.9.0] - 2026-10-08

- See the sound of your FM voices with a live, note-synchronized oscilloscope and frequency spectrum above the keyboard when using Emulation output.
- Adjust waveform visibility with saved x1/x4/x16 display gain; both monitors adapt to the panel width and show chords and release tails.
- Choose MUL, KS, and DT2 values with meaningful labels, and switch AME on or off with a toggle.
- Enable or disable each operator individually, see its Carrier or Modulator role, and identify disabled operators by their dimmed diagrams and envelopes.
- Refine the attack curves shown in FM Voice envelopes and improve the parameter layout.
- Keep edited values and operator states stable while source updates are pending, reducing flicker without interrupting keyboard audition.

## [0.8.1] - 2026-10-08

- Fix FM Voice keyboard and MIDI-IN audition pitch to match standard MIDI notes.
- Start wider FM Voice keyboards at C2 while keeping 37-key keyboards at C3.

## [0.8.0] - 2026-10-08

- Improve the Playback and connection settings UI with clearer status displays, compact playback controls, and reduced flicker.

## [0.7.0] - 2026-10-08

- Add initial Playback support for MML using ymfm-based YM2151 emulation.

## [0.6.1] - 2026-10-08

- Fix saving the Get Started example so VS Code prompts for a save location instead of targeting the filesystem root.

## [0.6.0] - 2026-10-07

- Open the panel with **mmlx: Show mmlx Panel**, without the experimental label.
- Keep playing via MIDI-IN while using other panels, without reconnecting; on-screen keyboard notes stop when the panel is hidden.
- See active emulation and MIDI-IN connections at a glance in the panel title and connection-count badge.

## [0.5.0] - 2026-10-07

- Audition the displayed FM voice with the on-screen keyboard or a MIDI keyboard using ymfm-based YM2151 emulation, with up to eight simultaneous notes and MIDI velocity response.
- Connect and disconnect MIDI-IN from Settings, see its connection indicator beside the FM Voice keyboard, and follow incoming notes on the keys.
- Use a collapsible keyboard that adapts to the panel width and appears inactive until an output is connected.
- Find Connection settings above Build settings, with unavailable Playback and NanoDrive8 outputs clearly disabled.
- Keep existing MDX/VGM files intact when a build fails or is canceled; replace them only after all requested conversions succeed.
- Refresh VS Code and Helix integrations and make language-server logs easier to inspect with VS Code's log output controls.

## [0.4.0] - 2026-10-06

- Add an extension icon.
- Add MIDI-IN port selection and refresh to Connection settings, with workspace-folder persistence.
- License mmlx-lsp under BSD-3-Clause.
- Reduce VGM build memory usage by serializing binary responses directly without creating intermediate JSON value arrays.
- Avoid cloning JSON byte arrays when reading MDX and PDX inputs.
- Transfer compiler output as a small JSON header followed by binary bytes, avoiding large JSON strings and numeric arrays in the extension host.
- Avoid FM Voice panel flicker and repeated voice requests when moving the cursor within the displayed voice definition.

## [0.3.0] - 2026-10-06

- Experimental `mmlx (experimental)` panel with FM Voice, Playback, and Settings tabs.
- Cursor-linked FM voice editing with YM2151 algorithm diagrams, draggable envelopes, and undoable source updates.
- Workspace build settings and NanoDrive8 serial-port selection. Audio playback and hardware communication are not yet implemented.

## [0.2.0] - 2026-10-05

- VS Code build tasks and commands for MML to MDX and MML/MDX to VGM.
- Separate bundled WASM compiler, without a Rust or CLI installation requirement.
- PDX lookup and conversion options, build diagnostics, and task cancellation.
- Configurable build output directory, defaulting to `build` in the workspace folder.
- Default build generates both MDX and VGM, with configurable output formats and individual build commands.
- Automatic Explorer refresh after builds and compiler-style progress, output sizes, and timing in the task terminal.
- Optional build-on-save for MML, with consecutive saves combined and builds serialized per file.
- Clickable build-error locations in the task terminal, selecting the mapped source range.

## [0.1.0] - 2026-10-05

- Initial release.
- MDX (MXDRV) MML support for desktop VS Code and native LSP clients.
- Syntax highlighting, error diagnostics, command and voice-definition completion, and parameter hints.
- Japanese and English command documentation.
- Helix Tree-sitter grammar and highlighting resources.