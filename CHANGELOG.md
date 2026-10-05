# Change Log

All notable changes to the "mmlx-lsp" extension will be documented in this file.

## [Unreleased]

- [ ] Reduce memory usage when building VGM files.

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