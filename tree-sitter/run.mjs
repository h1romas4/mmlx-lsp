import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const cli = createRequire(import.meta.url).resolve('tree-sitter-cli/cli.js');
const operation = process.argv[2];
if (!['generate', 'test'].includes(operation)) {
  throw new Error('Expected generate or test');
}
const dialects = readdirSync(root, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(join(root, entry.name, 'grammar.js')))
  .map(entry => entry.name)
  .sort();
if (!dialects.length) {
  throw new Error('No Tree-sitter dialects found');
}
for (const dialect of dialects) {
  const options = { cwd: join(root, dialect), stdio: 'inherit' };
  console.log(`Tree-sitter dialect: ${dialect}`);
  execFileSync(process.execPath, [cli, 'generate', '--abi', '14'], options);
  if (operation === 'test') {
    execFileSync(process.execPath, [cli, 'test'], options);
  }
}