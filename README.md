# mmlx-lsp

MML (Music Macro Language) support for VS Code and Helix.
Currently supports the MDX (MXDRV) dialect and `.mml` files.

For installation, see [VS Code](#manual-installation-in-vs-code) or
[Helix](#install-in-helix). Build commands and the mmlx panel are VS Code-only.

## Features

- **Syntax highlighting** for notes, commands, track labels, voice definitions, and comments.
- **Error diagnostics** for parsing, compilation, and playback checks.
- **Command completion** with argument snippets and FM voice-definition templates.
- **Parameter hints** while entering command arguments.
- **Japanese and English** command descriptions and parameter hints.
- **Built-in VS Code build tasks** for MML to MDX and MML/MDX to VGM.
- **FM Voice panel** with cursor-linked operator envelopes and two-way parameter editing.
- **MML playback** with editor highlighting that follows the playback position.

<img src="https://raw.githubusercontent.com/h1romas4/mmlx-lsp/main/assets/docs/mmlx-007.png" alt="FM Voice panel with YM2151 algorithms and operator envelopes" width="720">

## Usage

The following usage and settings instructions are for VS Code.
For Helix configuration, see [Install in Helix](#install-in-helix).

The extension automatically associates `.mml` files with **MML(mdx)**.
If the file opens in another language mode, click the language mode in the
status bar and select **MML(mdx)**, or add this to your VS Code settings:

```json
{
    "files.associations": {
        "*.mml": "mmlx"
    }
}
```

Use completion to insert commands and voice definitions. Parameter hints show
the active argument as you type. To read a command's full description, select
it in the completion list and choose **Show More** (`Ctrl+Space` toggles the details).

## Settings

Configure the extension in VS Code settings or `.vscode/settings.json`.
The example below shows the extension's defaults. Only add the settings you want
to override; you do not need to include every entry.

```json
{
    "mmlx.dialect": "mdx",
    "mmlx.language": "auto",
    "mmlx.build.format": "both",
    "mmlx.build.onSave": false,
    "mmlx.build.outputDirectory": "build",
    "mmlx.build.pdx": "",
    "mmlx.build.adpcmMode": "resample",
    "mmlx.build.loopCount": 0,
    "mmlx.build.maxTicks": 100000,
    "mmlx.serial.connection": "",
    "mmlx.midi.input": ""
}
```

### Build

Open an MML file in a trusted workspace and run **mmlx: Build** from the
command palette, or select it via **Tasks: Run Build Task** (`Ctrl+Shift+B`,
or `Cmd+Shift+B` on macOS). By default, it creates both MDX and VGM files in
the workspace folder's `build/` directory.
No Rust or external CLI is required.

<img src="https://raw.githubusercontent.com/h1romas4/mmlx-lsp/main/assets/docs/mmlx-003.png" alt="VS Code MDX/VGM build task" width="500">

Use **mmlx: Build MDX** or **mmlx: Build VGM** to build one format.
These commands override the configured output format. MDX input is converted to VGM only.

Errors appear in the Problems view and task terminal. Ctrl-click an error
location (Cmd-click on macOS, depending on your terminal settings) to jump to
the source. Stop the task to cancel.

Change the options below in VS Code settings or in **Settings > Build** in the
[mmlx panel](#mmlx-panel). The panel saves changes to the
workspace folder's `.vscode/settings.json`; they apply to the next build without
restarting the language server.

| Setting | Purpose |
| --- | --- |
| `mmlx.build.format` | Output formats used by **mmlx: Build**: `both`, `mdx`, or `vgm`. |
| `mmlx.build.onSave` | Automatically build MML when saved in a trusted workspace. |
| `mmlx.build.outputDirectory` | Output directory: a relative workspace path or an absolute path. |
| `mmlx.build.pdx` | PDX file path for VGM builds and NanoDrive8 Playback, relative to the workspace folder or absolute. When empty, look for the referenced PDX beside the input, accepting case-insensitive filenames. |
| `mmlx.build.adpcmMode` | ADPCM processing for VGM builds and NanoDrive8 Playback: `through`, `resample` (default), or `lpf`. |
| `mmlx.build.loopCount` | `0` preserves native VGM loop points; positive values produce finite playback without a loop point. |
| `mmlx.build.maxTicks` | Positive playback tick limit for VGM conversion. |

MDX output checks parsing and compilation without loading PDX samples.
VGM conversion requires any referenced PDX and reports playback errors or
tick-limit failures before saving the output. When building both formats,
neither output is saved until both conversions succeed. Loop points for per-track
MDX F1 loops are estimates. Build tasks are VS Code-only; Helix continues to use
the native language server.

### Other Settings

- `mmlx.dialect`: `mdx` is the default and currently the only supported dialect.
- `mmlx.language`: `auto` follows the editor language, falling back to Japanese.
    Use `ja` or `en` to select the language of completion descriptions and parameter hints.
- `mmlx.serial.connection`: empty by default. Use **Settings > Connection > NanoDrive8**
    in the [mmlx panel](#mmlx-panel) to select a serial port,
    such as `/dev/ttyUSB0` or `COM3`. The selection is saved to the workspace settings;
    it does not open the port or transmit data. In remote workspaces, the list shows
    ports on the remote extension host.
    Put NanoDrive8 in serial mode and use the connection button (firmware `1.0`, including betas).
    Experimental Keyboard output is available after connecting; Playback is not supported.
- `mmlx.midi.input`: empty by default. Select a port under **Settings > Connection > MIDI-IN**
    and use the connection button to connect or disconnect. Incoming notes highlight
    the FM Voice keyboard. The selected port is saved; connections are not restored
    automatically.

After changing the dialect or language, run **mmlx: Restart Language Server** from the
command palette. Diagnostic messages are not translated.

## mmlx Panel

Dedicated bottom panel opened with **mmlx: Show mmlx Panel**.

### Get Started

- **Get Started** opens an editable example `.mml` in a new, unsaved editor.

### FM Voice

- **FM Voice editing** for parameters, algorithms, and envelopes directly in the source by placing the cursor in an `@` definition.
- **MIDI-IN** connection and note reception, with pressed-key feedback in the FM Voice keyboard.
- **Emulation output:** Select **Emulation** under **Keyboard > Output** to play up to eight notes with the on-screen keyboard or MIDI-IN.
- **NanoDrive8 output:** Connect NanoDrive8 in **Settings**, then select **NanoDrive8** and connect under **Keyboard > Output**.
- **Chip State MML:** Test short MML phrases with the displayed voice using Enter or Play/Stop.
    Input is saved; the default is `MH0,200,64,0,5,0,1 ; PMS LFO`. Hardware LFO, pan and operator settings remain for keyboard notes; software LFOs apply only during MML playback.
- **Reset sound chip:** Use the icon left of the Keyboard Output connection button to clear chip state and restore the displayed voice without disconnecting.
    Available on Emulation and NanoDrive8 when connected and hardware Playback is idle.
- **Pitch bend:** Drag the left-hand wheel with a mouse or touch, or hold arrow keys while focused. It returns to center when released. Both outputs use a fixed +/-2-semitone range; MIDI RPN range changes are not supported.
- **MIDI bend:** Incoming bends apply per channel and update the wheel. Moving the on-screen wheel bends its notes and all MIDI channels.
- **Oscilloscope:** Shows up to two periods of the reference note. Choose x1, x4, or x16 gain (default x4).
- **Spectrum:** Shows frequency (Hz) and level (dB), with a reference-note marker.
- **Chords:** The last pressed note sets the reference; both monitors show the mixed sound, including release tails.
- **Monitors:** Emulation only, not Playback or NanoDrive8. Drawing pauses while hidden without stopping audio or MIDI. Modulation and detuning may move the waveform.

### Playback

- **Playback:** Plays the active MML, including unsaved edits. Switching files stops playback without affecting FM Voice or MIDI-IN.
- **Editor playback highlights:** Highlight the current notes and rests of FM and PCM tracks on both outputs, including repeats, loop escapes and native loops. Emulation follows consumed audio; NanoDrive8 follows its playback clock. Pause holds the highlights, while Stop, completion and document edits clear them. Highlights do not move the cursor or selection and continue for muted or soloed tracks. Position tracking runs separately from audio; if it cannot be initialized, a warning is shown without stopping playback.
- **Controls:** Emulation provides play/pause, stop, volume, and elapsed time. NanoDrive8 provides play/stop and output volume. Both outputs support optional MML loop points.
- **Channel keyboards:** Eight FM keyboards follow key-on, pitch changes and key-off from soundlog events on both Emulation and NanoDrive8. Each keyboard spans A0-C8 (88 keys) at a fixed key width; narrow panels reveal the active key without shrinking it. Emulation uses the consumed audio position, while NanoDrive8 uses its playback clock. Pause holds the keys and Stop clears them. The ADPCM keyboard remains inactive.
- **Channel mute and solo:** MUTE independently silences each of the eight FM channels or the mixed ADPCM output on Emulation and NanoDrive8. SOLO plays only the selected channels; multiple FM channels and mixed ADPCM can be soloed together. SOLO takes priority over MUTE without changing the saved mute selections, which are restored when the last SOLO is released. Both selections persist across Stop, playback restart and output changes. FM mute masks the YM2151 left/right output bits without changing the tone or envelope; ADPCM continues decoding while its output is silenced. Keyboard activity still follows muted FM channels. NanoDrive8 PCM changes take effect after already buffered audio.
- **NanoDrive8 volume:** Controls the device's main FM/PCM output, including keyboard audition. Requires firmware supporting `SET_OUTPUT_VOLUME`; older firmware may reject volume changes without stopping playback.
- **Play from cursor:** Emulation starts at the current command or the next command on the same line. Repeats start at the first occurrence; seeking may take a moment.
- **Outputs:** Emulation mixes YM2151 FM and OKIM6258 ADPCM with clock, divider and pan control. Both outputs use the configured PDX file or discover it beside the MML, and apply the ADPCM processing setting. NanoDrive8 uses FM bursts for FM-only songs and ADPCM streaming for songs with PCM notes.
- **NanoDrive8 diagnostics:** Playback failures are recorded before RESET in **Output > mmlx NanoDrive8**, including USB/PCM/event fault reasons, raw status, generation timing, supply callback gaps (`maxSupplyGapMs`), and host serial-write statistics.

### Settings

- **Settings:** Configure MDX/VGM builds, NanoDrive8 port selection and experimental connection, and MIDI-IN selection. Choices are saved to `.vscode/settings.json`.
- **Connections:** `[Connected]` and the badge show active connections. Hiding the panel stops on-screen notes, not connections. Disconnect manually; connections are not restored after a reload.

## Current Limitations

- Language-server playback validation checks one playthrough with execution limits; it does not
    load or validate PDX sample files.
- Completion covers commands and voice-definition templates, not notes,
    metadata directives, available voice numbers, or argument values.
- Hover, go-to-definition, formatting, and browser-based VS Code are not supported.

## Manual Installation in VS Code

For manual installation from a VSIX file, use desktop VS Code 1.100 or later
on Windows, macOS, or Linux. Node.js and Rust are not required.

1. Download the `.vsix` file from the [latest GitHub release](https://github.com/h1romas4/mmlx-lsp/releases/latest).
2. In the Extensions view, open the `...` menu and select **Install from VSIX...**.
3. Open a `.mml` file.

VS Code automatically installs the required `ms-vscode.wasm-wasi-core` extension.
If it cannot be downloaded automatically, such as in an offline environment,
install that dependency separately.

### Build From Source

Requires Rust, Node.js, curl, and tar. Example for Linux x86_64:

```console
git clone https://github.com/h1romas4/mmlx-lsp.git
cd mmlx-lsp

curl --fail --location --retry 3 -o wasi-sdk.tar.gz https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-33/wasi-sdk-33.0-x86_64-linux.tar.gz
echo "0ba8b5bfaeb2adf3f29bab5841d76cf5318ab8e1642ea195f88baba1abd47bce  wasi-sdk.tar.gz" | sha256sum --check
mkdir -p toolchains/wasi-sdk/build/install
tar -xzf wasi-sdk.tar.gz -C toolchains/wasi-sdk/build/install --strip-components=1

rustup target add wasm32-wasip1-threads
npm ci
npx --no-install vsce package --out mmlx-lsp.vsix
```

On Windows x64, replace the SDK download and extraction commands with:

```powershell
Invoke-WebRequest https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-33/wasi-sdk-33.0-x86_64-windows.tar.gz -OutFile wasi-sdk.tar.gz
New-Item -ItemType Directory -Force toolchains/wasi-sdk/build/install | Out-Null
tar -xzf wasi-sdk.tar.gz -C toolchains/wasi-sdk/build/install --strip-components=1
```

For other platforms, use the matching [SDK 33 release archive](https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-33).
The output is `mmlx-lsp/mmlx-lsp.vsix`. No SDK environment variable is needed.

## Install in Helix

Use the [native installation guide](native/helix/README.md) for the file installation
commands. The same guide is included in each native archive.

1. Download and extract the native archive for your OS and architecture from
    the [latest GitHub release](https://github.com/h1romas4/mmlx-lsp/releases/latest):
    `macos-x64`, `macos-arm64`, `windows-x64`, or `linux-x64`.
2. Install the included language server, Tree-sitter library, and highlight queries
    using the guide above.
3. Add the configuration below to your Helix configuration, or merge the included
    language configuration with your existing entries.
4. Restart Helix and run `hx --health mmlx-mdx` to check the installation.

<img src="https://raw.githubusercontent.com/h1romas4/mmlx-lsp/main/assets/docs/mmlx-002.png" alt="Helix syntax highlighting and error diagnostics" width="500">

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

## License

BSD-3-Clause

The audio backend includes third-party components listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
