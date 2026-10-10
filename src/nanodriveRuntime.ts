import { readFileSync } from 'node:fs';
import { WASI } from 'node:wasi';
import { Worker, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';
import { EmulationFrameDecoder, decodeFmKeyEvents } from './emulationProtocol';
import type { NanoDriveCodec } from './nanodrive';

export async function runNanoDriveEngine(path: string, port: MessagePort, signal: Int32Array): Promise<void> {
	const memory = new WebAssembly.Memory({ initial: 160, maximum: 2048, shared: true });
	const wasi = new WASI({ version: 'preview1', args: ['mmlx-nanodrive'], env: {}, preopens: {}, returnOnExit: true });
	let input = Buffer.alloc(0);
	const imports = { ...wasi.wasiImport,
		fd_read: (descriptor: number, vectors: number, count: number, result: number) => {
			if (descriptor !== 0) { return 8; }
			while (input.length === 0) {
				const sequence = Atomics.load(signal, 0);
				const message = receiveMessageOnPort(port);
				if (message) { input = Buffer.from(message.message as Uint8Array); }
				else { Atomics.wait(signal, 0, sequence); }
			}
			const view = new DataView(memory.buffer);
			let read = 0;
			for (let index = 0; index < count && input.length; index++) {
				const offset = view.getUint32(vectors + index * 8, true);
				const length = Math.min(view.getUint32(vectors + index * 8 + 4, true), input.length);
				new Uint8Array(memory.buffer, offset, length).set(input.subarray(0, length));
				input = input.subarray(length); read += length;
			}
			view.setUint32(result, read, true); return 0;
		},
		fd_write: (descriptor: number, vectors: number, count: number, result: number) => {
			if (descriptor !== 1 && descriptor !== 2) { return 8; }
			const view = new DataView(memory.buffer);
			let written = 0;
			for (let index = 0; index < count; index++) {
				const offset = view.getUint32(vectors + index * 8, true);
				const length = view.getUint32(vectors + index * 8 + 4, true);
				const bytes = new Uint8Array(memory.buffer, offset, length).slice();
				port.postMessage({ descriptor, bytes }, [bytes.buffer]); written += length;
			}
			view.setUint32(result, written, true); return 0;
		}
	};
	const module = await WebAssembly.compile(new Uint8Array(readFileSync(path)).buffer);
	const instance = await WebAssembly.instantiate(module, { env: { memory }, wasi_snapshot_preview1: imports });
	wasi.start(instance);
}

export class NanoDriveRuntime {
	private readonly worker: Worker;
	private readonly signal = new Int32Array(new SharedArrayBuffer(4));
	private readonly pending = new Map<number, { resolve: (result: Awaited<ReturnType<NanoDriveCodec>>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private id = 0;
	private stopped = false;
	private stderr = '';

	constructor(entry: string, wasmPath: string, private readonly onFailure: (error: Error) => void = () => {}) {
		this.worker = new Worker(entry, { workerData: { engine: true, wasmPath, signal: this.signal } });
		const decoder = new EmulationFrameDecoder((kind, bytes) => {
			if (kind === 1) { this.reply(JSON.parse(new TextDecoder().decode(bytes))); return; }
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			const count = view.getUint16(4, true);
			let offset = kind >= 3 ? 11 : 6;
			let keys;
			if (kind >= 5) {
				const length = view.getUint32(11, true);
				if (length === 0 || length > 65536 || 15 + length > bytes.length) { throw new Error('Invalid NanoDrive8 key metadata.'); }
				keys = decodeFmKeyEvents(JSON.parse(new TextDecoder().decode(bytes.subarray(15, 15 + length))));
				offset = 15 + length;
			}
			this.reply({ id: view.getUint32(0, true), result: { bytes: bytes.subarray(offset), ...(count === 65535 ? {} : { count }),
				...(keys ? { keys } : {}), ...(kind >= 3 ? { position: view.getUint32(6, true), ended: (view.getUint8(10) & 1) !== 0 } : {}),
				...(kind === 4 || kind === 6 ? { fm: true, synchronize: (view.getUint8(10) & 2) !== 0 } : {}) } });
		}, (kind, length) => (kind === 1 && length > 0 && length <= 65536) || (kind === 2 && length >= 6 && length <= 65536)
			|| ((kind === 3 || kind === 4) && length >= 11 && length <= 65536) || ((kind === 5 || kind === 6) && length >= 15 && length <= 131088));
		this.worker.on('message', ({ descriptor, bytes }: { descriptor: number; bytes: Uint8Array }) => {
			try {
				if (descriptor === 1) { decoder.push(bytes); }
				else { this.stderr = (this.stderr + new TextDecoder().decode(bytes)).slice(-4096); }
			} catch (error) { this.fail(error); }
		});
		this.worker.on('error', error => this.fail(error));
		this.worker.on('exit', code => { if (!this.stopped) { this.fail(new Error(this.stderr || `NanoDrive8 engine exited (${code}).`)); } });
	}

	readonly request: NanoDriveCodec = async params => {
		if (this.stopped) { throw new Error('NanoDrive8 engine stopped.'); }
		if (this.pending.size >= 256) { throw new Error('NanoDrive8 engine queue overflow.'); }
		const id = this.id++ >>> 0;
		const bytes = Buffer.from(`${JSON.stringify({ id, params })}\n`);
		if (bytes.length > 65536) { throw new Error('NanoDrive8 command is too large.'); }
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => this.fail(new Error('NanoDrive8 engine timed out.')), 15000);
			this.pending.set(id, { resolve, reject, timer });
			this.worker.postMessage(bytes);
			Atomics.add(this.signal, 0, 1); Atomics.notify(this.signal, 0);
		});
	};

	private reply(value: { id: number; result?: Awaited<ReturnType<NanoDriveCodec>>; error?: string }): void {
		const pending = this.pending.get(value?.id);
		if (!pending || (typeof value.error !== 'string' && !Object.hasOwn(value, 'result'))) { throw new Error('Invalid NanoDrive8 engine reply.'); }
		this.pending.delete(value.id); clearTimeout(pending.timer);
		if (typeof value.error === 'string') { pending.reject(new Error(value.error)); }
		else { pending.resolve(value.result!); }
	}

	private fail(error: unknown): void {
		if (this.stopped) { return; }
		this.stopped = true;
		const failure = error instanceof Error ? error : new Error(String(error));
		for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(failure); }
		this.pending.clear(); void this.worker.terminate();
		this.onFailure(failure);
	}

	async dispose(): Promise<void> {
		this.stopped = true;
		for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('NanoDrive8 engine stopped.')); }
		this.pending.clear(); await this.worker.terminate();
	}
}