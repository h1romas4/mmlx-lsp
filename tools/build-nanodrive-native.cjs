const { spawnSync } = require('node:child_process');
const { copyFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
if (process.platform !== 'win32' || process.arch !== 'x64') {
    console.log('Windows native NanoDrive8 builds require Windows x64; WASM remains available.');
    process.exit(0);
}
const target = 'x86_64-pc-windows-msvc';
const args = ['build', '--locked', '-j', '2', '--manifest-path', 'server/Cargo.toml', '--features', 'nanodrive', '--bin', 'mmlx-nanodrive', '--release'];
if (target) { args.push('--target', target); }
const result = spawnSync('cargo', args, { stdio: 'inherit', windowsHide: true,
    env: { ...process.env, RUSTFLAGS: `${process.env.RUSTFLAGS ?? ''} -C target-feature=+crt-static`.trim() } });
if (result.error) { throw result.error; }
if (result.status !== 0) { process.exit(result.status ?? 1); }
const binary = `mmlx-nanodrive${process.platform === 'win32' ? '.exe' : ''}`;
mkdirSync('dist/native', { recursive: true });
copyFileSync(join('server', 'target', ...(target ? [target] : []), 'release', binary), join('dist', 'native', binary));
console.log(`Native NanoDrive8 engine: dist/native/${binary}`);
