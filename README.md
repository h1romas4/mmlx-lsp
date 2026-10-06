# mmlx-lsp

MML (Music Macro Language) support for VS Code and Helix.
Currently supports the MDX (MXDRV) dialect and `.mml` files.

## Features

- **Syntax highlighting** for notes, commands, track labels, voice definitions, and comments.
- **Error diagnostics** for parsing, compilation, and playback checks.
- **Command completion** with argument snippets and FM voice-definition templates.
- **Parameter hints** while entering command arguments.
- **Japanese and English** command descriptions and parameter hints.
- **Built-in VS Code build tasks** for MML to MDX and MML/MDX to VGM.
- **FM voice panel prototype** with cursor-linked operator envelopes and two-way parameter editing.

<img src="https://raw.githubusercontent.com/h1romas4/mmlx-lsp/main/assets/docs/mmlx-001.png" alt="VS Code command parameter hints" width="500">

## Usage

The extension automatically associates `.mml` files with **MML(mdx)**.
If an existing setting or another extension overrides this association, select
**MML(mdx)** from the status bar or add this to your VS Code settings:

```json
{
    "files.associations": {
        "*.mml": "mmlx"
    }
}
```

Use completion to insert commands and voice definitions. Parameter hints show
the active argument as you type. To read a command's full description, select
it in the completion list and choose **Show More**.

## mmlx (experimental) Panel

Run **mmlx: Show mmlx (experimental) Panel** to open the dedicated bottom panel.
The **FM Voice**, **Playback**, and **Settings** tabs have separate display modules; Playback
currently shows a placeholder message until audio support is added. Its **Output**
selector offers **Emulation** and **NanoDrive8**; selecting an option only stores
the choice and does not play audio or connect to hardware. The selected tab and
output choice are retained when voice data updates and when the Webview is recreated.

**Settings > Build** edits the default MDX/VGM output format, output directory,
build-on-save option, PDX file, ADPCM mode, loop count, and maximum ticks.
Changes are saved to the selected workspace folder's `.vscode/settings.json`,
creating the file when needed. The folder follows the active editor, or the last
voice editor and then the first workspace folder when no editor is active.
The displayed path identifies the target folder. Existing settings-file edits
are reflected in the panel; inputs are disabled while saving or without a workspace
folder. Build settings apply to the next build without restarting the language server.

The settings-file path appears above **Build**. **Settings > Connection** offers
a **NanoDrive8** serial-port dropdown populated by the Node extension host using
SerialPort's native bindings. The refresh icon re-enumerates ports; detected
manufacturer names are included, and a saved port that disappears remains marked
as not detected. Selecting a port saves its path as `mmlx.serial.connection` in
the same workspace-folder settings file. **Not selected** clears the setting.
Selection does not open a port, transmit data, or enable playback. In remote
workspaces, the list belongs to the remote extension host, not the browser or
local desktop.

In **FM Voice**, move the cursor into an `@` voice definition to display its four operator envelopes,
parameters, algorithm (`CON`), feedback (`FL`), and operator mask (`OP`).
An algorithm table shows all eight YM2151 connections and highlights the current
`CON`. Click the disclosure triangle beside **Algorithms** to collapse or expand
the table; its state is retained across updates and Webview recreation.
Operator colors match the envelopes; filled nodes are carriers, outlined
nodes are modulators, and dashed loops indicate OP 1 feedback. Inactive operators
and disabled feedback are dimmed.
The last selected voice remains visible when the cursor leaves the definition
or the panel receives focus. `Retained` marks the previous snapshot when the
current cursor or incomplete/invalid source does not yield a voice.

Edit numeric parameters, select `CON`, or click an algorithm diagram in the panel
to update the corresponding numbers in the source. Diagrams also support Enter
and Space when focused. Numeric edits commit on Enter or when focus leaves the
input. Comments and line breaks are preserved; changes support normal Undo/Redo.
Operator values are right-aligned using shared column widths with enough room
for each parameter's maximum value. Existing wider spacing is retained; compact
definitions are aligned on the first operator edit so later digit changes do not
shift the columns. Alignment is included in the same undoable edit.
Inputs are disabled for retained snapshots, during updates, and until a fresh
definition has been obtained after source changes or Webview recreation.

Drag the attack handle horizontally for `AR` and vertically for `TL`, the decay
handle horizontally for `D1R` and vertically for `D1L`, the key-off handle vertically
for `D2R`, or the release handle horizontally for `RR`. Values and graphs preview during the drag;
releasing commits the changed values together as one undoable source edit.
Escape cancels the preview, and incoming source updates cancel an active drag.
Focused handles also support arrow keys. All parameters remain available as numeric inputs.
The key-off handle is disabled when `AR` or `D1R` is zero, or its held level is
below the graph's display range. Vertical decay editing is inactive when `D1R` is zero.

Envelope graphs use a shared level scale (-96 to 0 dB) and relative-time scale, with a
fixed key-off point. Their rate-to-time mapping is illustrative, not a YM2151
simulation: pitch, key scaling, and actual envelope timings are not modeled.
Audio preview is not yet implemented. The `ymfm-sys` integration is reserved for
a later iteration.

## Build MDX/VGM in VS Code

Open an MML file in a trusted workspace and run **mmlx: Build** from the
command palette or select it via **Tasks: Run Build Task** (`Ctrl+Shift+B`).
It creates MDX and VGM files in the workspace's `build/` folder.
No Rust or external CLI is required.

<img src="https://raw.githubusercontent.com/h1romas4/mmlx-lsp/main/assets/docs/mmlx-003.png" alt="VS Code command parameter hints" width="500">

Use **mmlx: Build MDX** or **mmlx: Build VGM** to build one format.
MDX input is converted to VGM only.

Errors appear in the Problems view and task terminal. Ctrl-click an error
location (Cmd-click on macOS, depending on your terminal settings) to jump to
the source. Stop the task to cancel.

Enable `mmlx.build.onSave` to build MML on save (off by default).
Change the output formats and directory in [Settings](#settings).

To choose a default build, add this to `.vscode/tasks.json`:

```json
{
    "version": "2.0.0",
    "tasks": [
        {
            "label": "Build",
            "type": "mmlx",
            "input": "${file}",
            "group": {
                "kind": "build",
                "isDefault": true
            },
            "problemMatcher": []
        }
    ]
}
```

Omit `format` to follow `mmlx.build.format`, or set it to `both`, `mdx`, or `vgm`
to override the setting for a task. Task paths support VS Code variables;
relative paths are resolved from the task's workspace folder.

| Optional Property | Default | Purpose |
| --- | --- | --- |
| `format` | `mmlx.build.format` (`both`) | Output formats. MDX input generates VGM only when set to `both`. |
| `output` | Configured directory with the input name and output extension | Output file path. Overrides `mmlx.build.outputDirectory`. For both formats, it is a base path; a `.mdx` or `.vgm` suffix is replaced with each output extension. |
| `pdx` | `mmlx.build.pdx`, or referenced PDX beside the input when empty | PDX file path for VGM conversion. Lookup accepts `.pdx` extensions and case-insensitive filenames. |
| `adpcmMode` | `mmlx.build.adpcmMode` (`through`) | VGM ADPCM processing: `through`, `resample`, or `lpf`. |
| `loopCount` | `mmlx.build.loopCount` (`0`: native VGM loop points) | Positive finite loop count for VGM conversion. |
| `maxTicks` | `mmlx.build.maxTicks` (`100000`) | Positive playback tick limit for VGM conversion. |

Explicit task properties override the corresponding build settings.

VGM conversion defaults to native loop-point detection, equivalent to
`soundlog mdx convert --native-loop`. Detected loops set `loop_offset` and
`loop_samples`. Setting `loopCount` instead emits finite playback without a VGM
loop point. As with the CLI, loop points for per-track MDX F1 loops are estimates.

MDX output checks parsing and compilation without loading PDX samples.
VGM conversion requires any referenced PDX and reports playback errors or
tick-limit failures before saving the output. When building both formats,
neither output is saved until both conversions succeed. Build tasks are VS Code-only;
Helix continues to use the native language server.

## Settings

Set these options in VS Code settings or your settings JSON. The panel's
**Settings > Build** controls save build options to `.vscode/settings.json`:

```json
{
    "mmlx.dialect": "mdx",
    "mmlx.language": "auto",
    "mmlx.build.format": "both",
    "mmlx.build.onSave": false,
    "mmlx.build.outputDirectory": "build",
    "mmlx.build.pdx": "",
    "mmlx.build.adpcmMode": "through",
    "mmlx.build.loopCount": 0,
    "mmlx.build.maxTicks": 100000,
    "mmlx.serial.connection": ""
}
```

- `mmlx.dialect`: `mdx` is the default and currently the only supported dialect.
- `mmlx.language`: `auto` follows the editor language, falling back to Japanese.
    Use `ja` or `en` to select a language explicitly.
- `mmlx.build.format`: `both` is the default. Use `mdx` or `vgm` for one format.
    Changes apply to the next default build; explicit task formats take precedence.
- `mmlx.build.onSave`: `false` is the default. Set to `true` to build saved MML
    files automatically. Changes apply without restarting the language server.
- `mmlx.build.outputDirectory`: `build` is the default. Use another relative
    directory, such as `out`, or an absolute path. Changes apply to the next build.
- `mmlx.build.pdx`: empty by default, enabling automatic PDX lookup beside the
    input. Set a relative workspace path or an absolute PDX path to override lookup.
- `mmlx.build.adpcmMode`: `through` is the default; `resample` and `lpf` are also supported.
- `mmlx.build.loopCount`: `0` preserves native VGM loop points; positive values
    produce finite playback without a loop point.
- `mmlx.build.maxTicks`: `100000` is the default positive playback tick limit.
- `mmlx.serial.connection`: empty by default. Use **Settings > Connection > NanoDrive8**
    to select an available serial port, such as `/dev/ttyUSB0` or `COM3`.

After changing the dialect or language, run **mmlx: Restart Language Server** from the
command palette. Diagnostic messages are not translated.

## Current Limitations

- Only the first parse, compile, or playback error is reported.
- Language-server playback validation checks one playthrough with execution limits; it does not
    load or validate PDX sample files.
- Completion covers commands and voice-definition templates, not notes,
    metadata directives, available voice numbers, or argument values.
- Hover, go-to-definition, formatting, and browser-based VS Code are not supported.
- Helix indentation queries and text objects are not included.

## Manual Installation in VS Code

For manual installation from a VSIX file, use desktop VS Code 1.100 or later
on Windows, macOS, or Linux. Node.js and Rust are not required.

1. Download the `.vsix` file from this repository's GitHub Releases.
2. In the Extensions view, open the `...` menu and select **Install from VSIX...**.
3. Open a `.mml` file.

VS Code automatically installs the required `ms-vscode.wasm-wasi-core` extension.
If it cannot be downloaded automatically, such as in an offline environment,
install that dependency separately.

## Install in Helix

1. Download and extract the native archive for your OS and architecture from
    GitHub Releases: `macos-x64`, `macos-arm64`, `windows-x64`, or `linux-x64`.
2. Install the included language server, Tree-sitter library, and highlight queries.
3. Merge the included Helix language configuration into your own configuration.
4. Restart Helix and run `hx --health mmlx-mdx` to check the installation.

<img src="https://raw.githubusercontent.com/h1romas4/mmlx-lsp/main/assets/docs/mmlx-002.png" alt="Helix syntax highlighting and error diagnostics" width="500">

Follow the [native installation guide](helix/README.md) for the commands
and configuration details. The same guide is included in each native archive.
Node.js, Rust, and a C compiler are not required.

Add or update these entries in your Helix `languages.toml`:

```toml
[language-server.mmlx]
command = "mmlx-lsp-server"
config = { dialect = "mdx", language = "ja" }

[[language]]
name = "mmlx-mdx"
scope = "source.mmlx.mdx"
file-types = ["mml"]
comment-token = ";"
language-servers = ["mmlx"]
grammar = "mmlx-mdx"
```

Ensure the server is on your `PATH`, or replace `command` with its absolute path
(`mmlx-lsp-server.exe` on Windows). Set `language = "en"` for English completion
and hints. The prebuilt parser does not need a `[[grammar]]` source entry.

Linux archives are built on Ubuntu 26.04 and require a compatible glibc-based
system. Older distributions may not run these binaries. Native binaries are
not code-signed or notarized.

## Dependencies

- [mmlx](https://crates.io/crates/mmlx)
- [soundlog](https://crates.io/crates/soundlog)
