# mmlx-lsp Native Distribution

This archive includes the native MML language server and Helix Tree-sitter
highlighting resources for the operating system and architecture in its name.
The parser uses Tree-sitter ABI 14. Node.js, Rust, and a C compiler are not needed
to use this distribution.

## Linux and macOS

From the extracted directory:

```sh
mkdir -p "$HOME/.local/bin"
install -m755 bin/mmlx-lsp-server "$HOME/.local/bin/mmlx-lsp-server"
helix_config="${XDG_CONFIG_HOME:-$HOME/.config}/helix"
mkdir -p "$helix_config/runtime/grammars" "$helix_config/runtime/queries/mmlx-mdx"
install -m644 runtime/grammars/mmlx-mdx.so "$helix_config/runtime/grammars/mmlx-mdx.so"
install -m644 runtime/queries/mmlx-mdx/highlights.scm "$helix_config/runtime/queries/mmlx-mdx/highlights.scm"
```

Ensure `$HOME/.local/bin` is on your `PATH`, or use the absolute executable path
in your language-server configuration. Linux builds use Ubuntu 26.04 and require
a compatible glibc-based system; older distributions may not provide the required
glibc version. macOS builds use macOS 15 runners.

## Windows

Keep `bin/mmlx-lsp-server.exe` in a permanent directory and add that directory to
`PATH`, or use its absolute path in the language-server configuration. From the
extracted directory, install the Helix runtime resources using PowerShell:

```powershell
$helixConfig = if ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME 'helix' } else { Join-Path $env:APPDATA 'helix' }
New-Item -ItemType Directory -Force "$helixConfig/runtime/grammars", "$helixConfig/runtime/queries/mmlx-mdx" | Out-Null
Copy-Item runtime/grammars/mmlx-mdx.dll "$helixConfig/runtime/grammars/mmlx-mdx.dll"
Copy-Item runtime/queries/mmlx-mdx/highlights.scm "$helixConfig/runtime/queries/mmlx-mdx/highlights.scm"
```

The Windows grammar is `mmlx-mdx.dll`; the Unix grammar is `mmlx-mdx.so`.

## Required Files

The following paths are relative to the extracted archive:

| Purpose | Linux and macOS | Windows |
| --- | --- | --- |
| LSP executable | `bin/mmlx-lsp-server` | `bin/mmlx-lsp-server.exe` |
| Tree-sitter parser | `runtime/grammars/mmlx-mdx.so` | `runtime/grammars/mmlx-mdx.dll` |
| Highlight queries | `runtime/queries/mmlx-mdx/highlights.scm` | `runtime/queries/mmlx-mdx/highlights.scm` |
| Helix configuration example | `languages.toml` | `languages.toml` |

The LSP executable provides error diagnostics, completion, and parameter hints.
Install it on your `PATH`, or specify its absolute path in the configuration.

The Tree-sitter parser and highlight queries provide syntax highlighting. Copy
them into your Helix configuration directory's `runtime/` folder, preserving the
`grammars/` and `queries/mmlx-mdx/` paths, as shown above.

```text
<Helix configuration directory>/
	runtime/
		grammars/
			mmlx-mdx.so
		queries/
			mmlx-mdx/
				highlights.scm
```

On Windows, use `mmlx-mdx.dll` instead of `mmlx-mdx.so`.

Merge the entries from the included `languages.toml` into your own configuration;
do not replace unrelated language settings. The next section shows these entries.

## Helix Configuration

Add or update these entries in your Helix `languages.toml`. They match the
configuration included in this archive:

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
(`mmlx-lsp-server.exe` on Windows).

### Language Settings

- Set `language = "ja"` for Japanese completion and parameter hints.
- Set `language = "en"` for English completion and parameter hints.
- Only the `mdx` dialect is currently supported. Omitting `dialect` also selects
	MDX; unsupported values fail initialization.

The prebuilt parser needs no `[[grammar]]` source entry or grammar fetch/build
command.

### Upgrading

The language and grammar names are `mmlx-mdx`, while the language-server name
remains `mmlx`.

### Verify Installation

Restart Helix, then run:

```sh
hx --health mmlx-mdx
```

The language server, Tree-sitter parser, and highlight queries should all report
success.

Indentation queries, text objects, and a formatter are not included.