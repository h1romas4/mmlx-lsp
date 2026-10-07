# Change Log

All notable changes to the "mmlx-lsp" extension will be documented in this file.

## [0.5.0] - Unreleased

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