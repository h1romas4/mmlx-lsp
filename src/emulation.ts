import type { Wasm, WasmProcess } from '@vscode/wasm-wasi/v1';
import { Uri, workspace, type Disposable } from 'vscode';
import { EmulationFrameDecoder } from './emulationProtocol';

export interface EmulationState { connected: boolean; connecting: boolean; error: string }
export interface PlaybackProgress { position: number; finished: boolean }

export class EmulationSession {
	private process?: WasmProcess;
	private module?: Promise<WebAssembly.Module>;
	private generation = 0;
	private subscriptions: Disposable[] = [];
	private writes = Promise.resolve();
	private queued = 0;
	private renders = 0;
	private connected = false;
	private cancelReady?: () => void;
	private voice = '';

	constructor(private readonly extensionUri: Uri, private readonly wasm: Wasm,
		private readonly onState: (state: EmulationState) => void,
		private readonly onPcm: (pcm: ArrayBuffer) => void,
		private readonly onPlayback: (progress: PlaybackProgress) => void = () => {}) {}

	async connect(sampleRate: number, voice: unknown = null, playback?: { source: string; looped: boolean; cursor?: number }): Promise<void> {
		this.stop();
		const generation = this.generation;
		this.onState({ connected: false, connecting: true, error: '' });
		try {
			if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) { throw new Error('Invalid audio sample rate.'); }
			if (playback && new TextEncoder().encode(JSON.stringify({ type: 'playback', ...playback })).length >= 2 * 1024 * 1024) {
				throw new Error('MML is too large for playback (maximum command size: 2 MiB).');
			}
			this.module ??= Promise.resolve(workspace.fs.readFile(Uri.joinPath(this.extensionUri,
				'server', 'target', 'wasm32-wasip1-threads', 'release', 'mmlx-emulator.wasm')))
				.then(bytes => WebAssembly.compile(new Uint8Array(bytes).buffer));
			const module = await this.module;
			if (generation !== this.generation) { return; }
			const process = await this.wasm.createProcess('mmlx-emulator', module,
				{ initial: 160, maximum: 2048, shared: true }, {
					stdio: { in: { kind: 'pipeIn' }, out: { kind: 'pipeOut' }, err: { kind: 'pipeOut' } }
				});
			if (generation !== this.generation) { await process.terminate(); return; }
			this.process = process;
			let resolveReady!: () => void;
			let rejectReady!: (error: Error) => void;
			let ready = false;
			const initialized = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
			const timer = setTimeout(() => rejectReady(new Error('Emulator startup timed out.')), 15000);
			this.cancelReady = () => { clearTimeout(timer); resolveReady(); };
			let stderr = '';
			const decoder = new EmulationFrameDecoder((kind, bytes) => {
				if (generation !== this.generation) { return; }
				if (kind === 1) {
					if (ready || new DataView(bytes.buffer).getUint32(0, true) !== sampleRate) { throw new Error('Invalid emulator initialization.'); }
					ready = true;
					if (!playback) { clearTimeout(timer); resolveReady(); }
				} else if (kind === 3) {
					const position = new DataView(bytes.buffer).getFloat64(0, true);
					if (!ready || !playback || !Number.isFinite(position) || position < 0 || bytes[8] > 1) {
						throw new Error('Invalid playback state.');
					}
					this.onPlayback({ position, finished: bytes[8] === 1 });
					clearTimeout(timer); resolveReady();
				} else {
					if (!this.connected || this.renders <= 0) { throw new Error('Unexpected emulator audio.'); }
					this.renders--; this.onPcm(bytes.buffer as ArrayBuffer);
				}
			});
			const fail = (error: unknown) => {
				if (generation !== this.generation) { return; }
				const message = error instanceof Error ? error.message : String(error);
				rejectReady(new Error(message));
				this.disconnect(message);
			};
			this.subscriptions.push(process.stdout!.onData(data => {
				try { decoder.push(data); } catch (error) { fail(error); }
			}), process.stderr!.onData(data => { stderr = (stderr + new TextDecoder().decode(data)).slice(-4096); }));
			void process.run().then(code => {
				if (generation !== this.generation) { return; }
				try { decoder.finish(); } catch (error) { fail(error); return; }
				fail(new Error(stderr.trim() || `Emulator exited (${code}).`));
			}, fail);
			this.command({ type: 'init', sampleRate });
			if (playback) { this.command({ type: 'playback', ...playback }); }
			else { this.setVoice(voice); }
			await initialized;
			if (generation !== this.generation) { return; }
			this.cancelReady = undefined;
			this.connected = true;
			this.onState({ connected: true, connecting: false, error: '' });
		} catch (error) {
			if (generation !== this.generation) { return; }
			this.module = undefined;
			this.disconnect(error instanceof Error ? error.message : String(error));
		}
	}

	setVoice(voice: unknown): void {
		const serialized = JSON.stringify(voice);
		if (serialized === this.voice || !this.process) { return; }
		this.voice = serialized;
		this.command({ type: 'voice', voice });
	}

	note(command: object): void { if (this.connected) { this.command(command); } }

	request(blocks = 1): void {
		if (!this.connected || !Number.isInteger(blocks) || blocks < 1 || blocks > 4) { return; }
		for (let index = 0; index < blocks && this.renders < 4; index++) {
			this.renders++;
			this.command({ type: 'render' });
		}
	}

	private command(command: object): void {
		const process = this.process;
		if (!process) { return; }
		if (this.queued >= 256) { this.disconnect('Emulator command queue overflow.'); return; }
		this.queued++;
		this.writes = this.writes.then(async () => {
			if (this.process !== process) { return; }
			try { await process.stdin!.write(`${JSON.stringify(command)}\n`); }
			finally { if (this.process === process) { this.queued--; } }
		}).catch(error => {
			if (this.process === process) { this.disconnect(error instanceof Error ? error.message : String(error)); }
		});
	}

	private stop(): void {
		this.generation++;
		this.cancelReady?.(); this.cancelReady = undefined;
		const process = this.process;
		this.process = undefined;
		this.connected = false; this.renders = 0; this.queued = 0; this.voice = '';
		this.writes = Promise.resolve();
		for (const subscription of this.subscriptions.splice(0)) { subscription.dispose(); }
		void process?.terminate().catch(() => undefined);
	}

	disconnect(error = ''): void {
		this.stop();
		this.onState({ connected: false, connecting: false, error });
	}

	dispose(): void { this.disconnect(); }
}