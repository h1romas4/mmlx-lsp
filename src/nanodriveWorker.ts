import type { Wasm, WasmProcess } from '@vscode/wasm-wasi/v1';
import { Uri, workspace, type Disposable } from 'vscode';
import type { NanoDriveCodec } from './nanodrive';
import { EmulationFrameDecoder, decodeFmKeyEvents } from './emulationProtocol';

type Result = Awaited<ReturnType<NanoDriveCodec>>;

export class NanoDriveWorker {
	private process?: WasmProcess;
	private module?: Promise<WebAssembly.Module>;
	private starting?: Promise<void>;
	private generation = 0;
	private id = 0;
	private writes = Promise.resolve();
	private subscriptions: Disposable[] = [];
	private pending = new Map<number, { resolve: (result: Result) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

	constructor(private readonly extensionUri: Uri, private readonly wasm: Wasm,
		private readonly onFailure: (error: string) => void = () => {}) {}

	async request(params: Parameters<NanoDriveCodec>[0]): Promise<Result> {
		const generation = this.generation;
		await this.start();
		if (generation !== this.generation || !this.process) { throw new Error('NanoDrive8 engine stopped.'); }
		if (this.pending.size >= 256) { throw new Error('NanoDrive8 engine queue overflow.'); }
		const process = this.process;
		const id = this.id++ >>> 0;
		const command = `${JSON.stringify({ id, params })}\n`;
		if (Buffer.byteLength(command) > 65536) { throw new Error('NanoDrive8 command is too large.'); }
		return new Promise<Result>((resolve, reject) => {
			const timer = setTimeout(() => this.fail(new Error('NanoDrive8 engine timed out.'), generation), 15000);
			this.pending.set(id, { resolve, reject, timer });
			this.writes = this.writes.then(async () => {
				if (this.process === process) { await process.stdin!.write(command); }
			}).catch(error => this.fail(error, generation));
		});
	}

	private start(): Promise<void> {
		if (this.starting) { return this.starting; }
		if (this.process) { return Promise.resolve(); }
		const generation = this.generation;
		const starting = (async () => {
			try {
				this.module ??= Promise.resolve(workspace.fs.readFile(Uri.joinPath(this.extensionUri,
					'server', 'target', 'wasm32-wasip1-threads', 'release', 'mmlx-nanodrive.wasm')))
					.then(bytes => WebAssembly.compile(new Uint8Array(bytes).buffer));
				const module = await this.module;
				if (generation !== this.generation) { return; }
				const process = await this.wasm.createProcess('mmlx-nanodrive', module,
					{ initial: 160, maximum: 2048, shared: true }, {
						stdio: { in: { kind: 'pipeIn' }, out: { kind: 'pipeOut' }, err: { kind: 'pipeOut' } }
					});
				if (generation !== this.generation) { await process.terminate(); return; }
				this.process = process;
				let stderr = '';
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
						...(keys ? { keys } : {}),
						...(kind >= 3 ? { position: view.getUint32(6, true), ended: (view.getUint8(10) & 1) !== 0 } : {}),
						...(kind === 4 || kind === 6 ? { fm: true, synchronize: (view.getUint8(10) & 2) !== 0 } : {}) } });
				}, (kind, length) => (kind === 1 && length > 0 && length <= 65536) || (kind === 2 && length >= 6 && length <= 65536) || ((kind === 3 || kind === 4) && length >= 11 && length <= 65536) || ((kind === 5 || kind === 6) && length >= 15 && length <= 131088));
				this.subscriptions.push(process.stdout!.onData(data => {
					if (generation !== this.generation) { return; }
					try { decoder.push(data); } catch (error) { this.fail(error, generation); }
				}), process.stderr!.onData(data => { stderr = (stderr + new TextDecoder().decode(data)).slice(-4096); }));
				void process.run().then(code => this.fail(new Error(stderr.trim() || `NanoDrive8 engine exited (${code}).`), generation),
					error => this.fail(error, generation));
			} catch (error) {
				this.module = undefined;
				this.fail(error, generation);
				throw error;
			}
		})().finally(() => { if (this.starting === starting) { this.starting = undefined; } });
		this.starting = starting;
		return starting;
	}

	private reply(value: { id?: unknown; result?: Result; error?: unknown }): void {
		if (!value || !Number.isInteger(value.id) || !this.pending.has(value.id as number)
			|| (typeof value.error !== 'string' && !Object.hasOwn(value, 'result'))) { throw new Error('Invalid NanoDrive8 engine reply.'); }
		const id = value.id as number;
		const pending = this.pending.get(id)!;
		this.pending.delete(id); clearTimeout(pending.timer);
		if (typeof value.error === 'string') { pending.reject(new Error(value.error)); }
		else { pending.resolve(value.result!); }
	}

	private stop(error: Error): WasmProcess | undefined {
		this.generation++;
		const process = this.process; this.process = undefined;
		for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
		this.pending.clear(); this.writes = Promise.resolve();
		for (const subscription of this.subscriptions.splice(0)) { subscription.dispose(); }
		return process;
	}

	private fail(error: unknown, generation: number): void {
		if (generation !== this.generation) { return; }
		const failure = error instanceof Error ? error : new Error(String(error));
		const process = this.stop(failure);
		void process?.terminate().catch(() => undefined);
		this.onFailure(failure.message);
	}

	async dispose(): Promise<void> {
		const process = this.stop(new Error('NanoDrive8 engine stopped.'));
		await process?.terminate().catch(() => undefined);
		await this.starting?.catch(() => undefined);
	}
}