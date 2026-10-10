const { spawnSync } = require('node:child_process');
const { copyFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
if (process.platform !== 'win32') {
    console.log('NanoDrive8 uses the existing WASM engine on this platform.');
    process.exit(0);
}
const target = process.platform === 'win32' ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc` : undefined;
const args = ['build', '--locked', '-j', '2', '--manifest-path', 'server/Cargo.toml', '--features', 'nanodrive', '--bin', 'mmlx-nanodrive', '--release'];
if (target) { args.push('--target', target); }
const result = spawnSync('cargo', args, { stdio: 'inherit', windowsHide: true });
if (result.error) { throw result.error; }
if (result.status !== 0) { process.exit(result.status ?? 1); }
const binary = `mmlx-nanodrive${process.platform === 'win32' ? '.exe' : ''}`;
mkdirSync('dist/native', { recursive: true });
copyFileSync(join('server', 'target', ...(target ? [target] : []), 'release', binary), join('dist', 'native', binary));
console.log(`Native NanoDrive8 engine: dist/native/${binary}`);
