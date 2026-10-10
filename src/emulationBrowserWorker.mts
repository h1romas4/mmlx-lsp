import { WASI, Fd } from '@bjorn3/browser_wasi_shim';

class ClosedFd extends Fd {}
const scope = globalThis as unknown as { onmessage: (event: MessageEvent) => void; postMessage: (message: unknown) => void };
let instance: WebAssembly.Instance;
let audio: MessagePort;
let finished = false;
let initialized = false;
let options: { source: string; looped: boolean; cursor?: number; adpcmMode?: string; muted: number; pdxConfigured: boolean };
let reported = -1;

function execute(command: object): void {
	const api = instance.exports as unknown as { memory: WebAssembly.Memory; emulation_input: (length: number) => number;
		emulation_execute: () => number; emulation_output: () => number };
	const bytes = new TextEncoder().encode(JSON.stringify(command));
	const offset = api.emulation_input(bytes.length);
	if (!offset) { throw new Error('Emulator command is too large.'); }
	new Uint8Array(api.memory.buffer, offset, bytes.length).set(bytes);
	const length = api.emulation_execute();
	const output = new Uint8Array(api.memory.buffer, api.emulation_output(), length);
	let position = 0;
	while (position < output.length) {
		const kind = output[position];
		const size = new DataView(output.buffer, output.byteOffset + position + 1, 4).getUint32(0, true);
		const data = output.subarray(position + 5, position + 5 + size);
		if (data.length !== size) { throw new Error('Invalid emulator frame.'); }
		if (kind === 7) { throw new Error(new TextDecoder().decode(data)); }
		if (kind === 2) {
			const pcm = data.slice().buffer;
			audio.postMessage({ type: 'pcm', pcm }, [pcm]);
		} else if (kind === 3) {
			const elapsed = new DataView(data.buffer, data.byteOffset).getFloat64(0, true);
			finished = data[8] === 1;
			if (!initialized) {
				initialized = true; scope.postMessage({ type: 'ready', position: elapsed });
			}
			if (Math.floor(elapsed * 10) !== reported || finished) {
				reported = Math.floor(elapsed * 10); scope.postMessage({ type: 'progress', position: elapsed, finished });
			}
			if (finished) { audio.postMessage({ type: 'finish' }); }
		} else if (kind === 5) {
			const info = JSON.parse(new TextDecoder().decode(data)) as { audio: boolean; pdxName: string | null };
			if (info.audio && (info.pdxName || options.pdxConfigured)) { scope.postMessage({ type: 'asset', name: info.pdxName ?? '' }); }
			else { execute({ type: 'playback', ...options }); }
		} else if (kind === 6) { scope.postMessage({ type: 'keys', keys: JSON.parse(new TextDecoder().decode(data)) }); }
		position += 5 + size;
	}
}

function fail(error: unknown): void {
	finished = true;
	scope.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
}

scope.onmessage = event => {
	void (async () => {
		try {
			const message = event.data;
			if (message.type === 'init') {
				options = message.options; audio = message.port;
				const wasi = new WASI([], [], [new ClosedFd(), new ClosedFd(), new ClosedFd()]);
				if (!(message.wasmBytes instanceof ArrayBuffer)) { throw new Error('Invalid emulator module.'); }
				const module = await WebAssembly.compile(message.wasmBytes);
				instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
				wasi.initialize(instance as WebAssembly.Instance & { exports: { memory: WebAssembly.Memory } });
				audio.onmessage = request => {
					try {
						if (request.data?.type !== 'request' || !Number.isInteger(request.data.blocks) || request.data.blocks < 1 || request.data.blocks > 4) { return; }
						for (let index = 0; index < request.data.blocks && !finished; index++) { execute({ type: 'render' }); }
					} catch (error) { fail(error); }
				};
				execute({ type: 'init', sampleRate: message.sampleRate });
				execute({ type: 'playbackInfo', source: options.source });
			} else if (message.type === 'asset') {
				if (message.error) { throw new Error(message.error); }
				if (!(message.bytes instanceof Uint8Array) || message.bytes.length > 16 * 1024 * 1024) { throw new Error('Invalid PDX data.'); }
				for (let offset = 0; offset < message.bytes.length; offset += 8192) {
					execute({ type: 'pdx', offset, bytes: Array.from(message.bytes.subarray(offset, offset + 8192)) });
				}
				execute({ type: 'playback', ...options });
			} else if (message.type === 'mute' && initialized && !finished) { execute({ type: 'playbackMute', muted: message.muted }); }
		} catch (error) { fail(error); }
	})();
};