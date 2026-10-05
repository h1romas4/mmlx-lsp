# mmlx-lsp

MML (Music Macro Language) support for VS Code and Helix.
Currently supports the MDX (MXDRV) dialect and `.mml` files.

## Features

- Syntax highlighting for notes, commands, track labels, voice definitions, and comments.
- Error diagnostics for parsing, compilation, and playback checks.
- Command completion with argument snippets and FM voice-definition templates.
- Parameter hints while entering command arguments.
- Japanese and English command descriptions and parameter hints.

<img src="https://raw.githubusercontent.com/h1romas4/mmlx-lsp/main/assets/docs/mmlx-001.png" alt="VS Code command parameter hints" width="500">

<img src="https://raw.githubusercontent.com/h1romas4/mmlx-lsp/main/assets/docs/mmlx-002.png" alt="Helix syntax highlighting and error diagnostics" width="500">

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

## Settings

Set these options in VS Code settings or your settings JSON:

```json
{
    "mmlx.dialect": "mdx",
    "mmlx.language": "auto"
}
```

- `mmlx.dialect`: `mdx` is the default and currently the only supported dialect.
- `mmlx.language`: `auto` follows the editor language, falling back to Japanese.
    Use `ja` or `en` to select a language explicitly.

After changing these settings, run **mmlx: Restart Language Server** from the
command palette. Diagnostic messages are not translated.

## Current Limitations

- Only the first parse, compile, or playback error is reported.
- Playback validation checks one playthrough with execution limits; it does not
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
