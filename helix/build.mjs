import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const build = join(project, 'native', 'helix', 'build');
const configHome = join(build, 'config');
const runtime = join(configHome, 'helix', 'runtime');
const configFile = join(configHome, 'helix', 'languages.toml');
const queryDirectory = join(runtime, 'queries', 'mmlx-mdx');
mkdirSync(dirname(configFile), { recursive: true });
mkdirSync(queryDirectory, { recursive: true });
mkdirSync(join(runtime, 'grammars'), { recursive: true });
writeFileSync(configFile, `use-grammars = { only = ["mmlx-mdx"] }

[language-server.mmlx]
command = ${JSON.stringify(join(project, 'server', 'target', 'release', 'mmlx-lsp-server'))}
config = { dialect = "mdx", language = "ja" }

[[language]]
name = "mmlx-mdx"
scope = "source.mmlx.mdx"
file-types = ["mml"]
comment-token = ";"
language-servers = ["mmlx"]
grammar = "mmlx-mdx"

[[grammar]]
name = "mmlx-mdx"
source = { path = ${JSON.stringify(join(project, 'native', 'tree-sitter', 'mdx'))} }
`);
copyFileSync(join(project, 'native', 'tree-sitter', 'mdx', 'queries', 'highlights.scm'), join(queryDirectory, 'highlights.scm'));
execFileSync('hx', ['--grammar', 'build'], {
  cwd: project,
  stdio: 'inherit',
  env: { ...process.env, XDG_CONFIG_HOME: configHome, HELIX_RUNTIME: runtime },
});
console.log(`Language configuration: ${configFile}`);
console.log(`Runtime: ${runtime}`);