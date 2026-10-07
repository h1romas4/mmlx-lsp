import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sdk = process.env.WASI_SDK;
if (!sdk || !existsSync(join(sdk, 'bin', 'clang++'))) {
	throw new Error('Set WASI_SDK to a WASI SDK installation to build the emulator.');
}
const sysroot = resolve(sdk, 'share', 'wasi-sysroot');
const libraries = join(sysroot, 'lib', 'wasm32-wasip1-threads');
const result = spawnSync('cargo', ['rustc', '--locked', '-j', '1', '--manifest-path', 'server/Cargo.toml',
	'--features', 'emulation', '--bin', 'mmlx-emulator', '--release', '--target', 'wasm32-wasip1-threads', '--',
	'-L', `native=${libraries}`, '-L', `native=${join(libraries, 'noeh')}`, '-l', 'c++', '-l', 'c++abi',
	'-C', 'link-arg=--initial-memory=10485760', '-C', 'link-arg=--max-memory=134217728'], {
	cwd: root, stdio: 'inherit', env: { ...process.env,
		CARGO_TARGET_WASM32_WASIP1_THREADS_RUSTFLAGS: `${process.env.CARGO_TARGET_WASM32_WASIP1_THREADS_RUSTFLAGS ?? ''} -Lnative=${libraries} -Lnative=${join(libraries, 'noeh')}`,
		WASI_SYSROOT: sysroot,
		CC_SHELL_ESCAPED_FLAGS: '1',
		CXX_wasm32_wasip1_threads: join(sdk, 'bin', 'clang++'),
		CXXFLAGS_wasm32_wasip1_threads: `--sysroot="${sysroot}" -fno-exceptions -pthread -matomics -mbulk-memory`
	}
});
if (result.error) { throw result.error; }
process.exit(result.status ?? 1);