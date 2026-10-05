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

## Helix Configuration

Merge or update the entries from the included `languages.toml` in your existing
Helix language configuration. The language and grammar names are `mmlx-mdx`,
while the language-server name remains `mmlx`. If upgrading from an older
distribution, update the old MDX language entry named `mmlx` to `mmlx-mdx`
rather than retaining two entries for `.mml` files. Set
`config = { dialect = "mdx", language = "en" }` for MDX with English completion/help,
or keep `"ja"` for Japanese. Only MDX is currently supported; omitting `dialect`
also selects MDX, while unsupported values fail initialization. The prebuilt
parser needs no `[[grammar]]` source entry or grammar
fetch/build command.

Restart Helix and run `hx --health mmlx-mdx` to check the LSP, parser, and highlight
queries. Indentation queries, text objects, and a formatter are not included.