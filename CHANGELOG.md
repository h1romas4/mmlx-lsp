# Change Log

All notable changes to the "mmlx-lsp" extension will be documented in this file.

## [Unreleased]

- Ignore selected FM voice-number commands during FM Voice audition and inherit the previous MML tempo, default note length, and octave when the selection does not set them.
- Show VS Code error notifications when FM Voice selection or Chip State MML playback fails.
- Keep the FM Voice selection-play button in its normal color after an error.
- Toggle active MML selection playback from the keyboard with Ctrl+Alt+P (Cmd+Option+P on macOS) when FM Voice output is ready, including stopping after the selection is cleared.
- Reset the connected sound chip from an MML editor with Ctrl+Alt+R (Cmd+Option+R on macOS).
- Clear inherited MML tempo, octave, and default-length state on sound-chip reset; subsequent selection playback rebuilds that state from played commands.
- Highlight the selected MML notes and rests as FM Voice selection playback advances.

## [0.18.0] - 2026-10-12

- Build PDX sample banks from JSON manifests and WAV files in the Utilities panel.
- Add MCP workspace access and tools to build MDX, PDX, and VGM files.
- Play selected MML passages across their specified FM channels.
- Complete `#title` and `#pcmfile` MML attributes in the language server.
- Refine the PDX playback example formatting in Utilities.
- Keep playback running when editing the source while clearing playback highlights.
- Improve the Utilities panel and document its build workflows.

## [0.17.1] - 2026-10-12

- Disable the MCP Server dropdown while connected.

## [0.17.0] - 2026-10-12

- Play selected MML passages and add editor support for formatting, commenting, and selection navigation.
- Improve FM Voice editing with voice-name and reference completions, track-length status, and clearer voice testing controls.
- Warn about out-of-range FM Voice parameters without blocking compilation, and show affected values in the FM Voice panel.
- Refine playback and Settings panel controls, and update the user guide.
- Add an experimental MCP server for MML, MDX, and VGM analysis, with bounded range-based results.

## [0.16.0] - 2026-10-11

- Reduce NanoDrive8 supply delays by preparing and mute-filtering PCM ahead of playback and processing STATUS separately from audio generation. Preserve ordered MUTE/SOLO changes.
- Add buffer and engine timing diagnostics to help investigate NanoDrive8 underruns, logged during playback and on completion or Stop.
- Add an optional Windows x64 native NanoDrive8 audio engine, disabled by default, to try when buffer underruns occur. The bundled executable replaces the audio WASM worker on the next connection.
- Place **NanoDrive8 native engine** directly below the NanoDrive8 port controls, with buffer-underrun guidance. Shorten the Playback documentation.

## [0.15.2] - 2026-10-11

- Raise the dedicated NanoDrive8 process priority on Windows to reduce scheduling delays during playback. Log the applied priority or any failure without changing VS Code's priority.

## [0.15.1] - 2026-10-10

- Fix a crash when connecting to NanoDrive8 introduced in v0.15.0, while keeping playback independent of VS Code load.

## [0.15.0] - 2026-10-10

- Reduce audio dropouts and timing disruptions in Emulation and NanoDrive8 Playback when VS Code is under heavy load.
- Continue playing the original MML when switching editors, keeping playback highlights and paused sessions intact. Editing or closing the playback source stops playback.
- View a live spectrum during Emulation Playback, with the same frequency and dB scales as FM Voice but no reference frequency. Compact playback controls and the spectrum align with the channel keyboards and stack in narrow panels.
- Fix Emulation Playback getting stuck during preparation or failing to play MML that uses PDX samples.

## [0.14.0] - 2026-10-10

- Follow playback in the MML editor with theme-aware note, rest and whole-line highlights on Emulation and NanoDrive8, including repeats and loops without moving the cursor. Pause holds highlights; Stop, completion and edits clear them.
- Play OKIM6258 ADPCM alongside FM in Emulation, with PDX loading, pan and ADPCM processing settings.
- Mute or solo individual FM channels and mixed ADPCM on Emulation and NanoDrive8, with multiple solo selections and saved mute settings restored when solo ends.
- See active FM notes on 88-key Playback keyboards that follow notes in narrow panels, with inactive ADPCM dimmed and the construction badge removed.

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