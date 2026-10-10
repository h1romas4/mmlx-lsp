import type { Wasm, WasmProcess } from '@vscode/wasm-wasi/v1';
import { Uri, workspace, type Disposable } from 'vscode';
import { EmulationFrameDecoder, decodeFmKeyEvents, type FmKeyEvent } from './emulationProtocol';

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
	private voiceTesting = false;
	private voiceTestError = false;
	private resetReady?: (ready: boolean) => void;
	private resetting?: Promise<boolean>;

	constructor(private readonly extensionUri: Uri, private readonly wasm: Wasm,
		private readonly onState: (state: EmulationState) => void,
		private readonly onPcm: (pcm: ArrayBuffer) => void,
		private readonly onPlayback: (progress: PlaybackProgress) => void = () => {},
		private readonly onVoiceTest: (playing: boolean, error: boolean) => void = () => {},
		private readonly onPlaybackKeys: (keys: FmKeyEvent[]) => void = () => {}) {}

	async connect(sampleRate: number, voice: unknown = null, playback?: {
		source: string; looped: boolean; cursor?: number; adpcmMode?: 'through' | 'resample' | 'lpf';
		muted?: number;
		pdxConfigured?: boolean; loadPdx?: (name: string) => Promise<Uint8Array>;
	}): Promise<void> {
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
			let assetsRequested = false;
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
				} else if (kind === 5) {
					const info = JSON.parse(new TextDecoder().decode(bytes)) as { audio?: unknown; pdxName?: unknown };
					if (!ready || !playback?.loadPdx || assetsRequested || typeof info.audio !== 'boolean'
						|| (info.pdxName !== null && typeof info.pdxName !== 'string')) { throw new Error('Invalid playback assets.'); }
					assetsRequested = true;
					void (async () => {
						if (info.audio && (info.pdxName || playback.pdxConfigured)) {
							const bytes = await playback.loadPdx!(typeof info.pdxName === 'string' ? info.pdxName : '');
							if (bytes.length > 16 * 1024 * 1024) { throw new Error('PDX is too large (maximum 16 MiB).'); }
							for (let offset = 0; offset < bytes.length; offset += 8192) {
								if (generation !== this.generation) { return; }
								await this.command({ type: 'pdx', offset, bytes: Array.from(bytes.subarray(offset, offset + 8192)) });
								if (generation !== this.generation) { return; }
							}
						}
						if (generation === this.generation) { await this.command({ type: 'playback', ...playback }); }
					})().catch(fail);
				} else if (kind === 6) {
					if (!ready || !playback) { throw new Error('Unexpected FM keyboard events.'); }
					this.onPlaybackKeys(decodeFmKeyEvents(JSON.parse(new TextDecoder().decode(bytes))));
				} else if (kind === 4) {
					if (!ready || !this.resetReady) { throw new Error('Unexpected emulator reset.'); }
					this.setVoiceTesting(false);
					this.resetReady(true); this.resetReady = undefined;
				} else if (kind === 3) {
					const position = new DataView(bytes.buffer).getFloat64(0, true);
					if (!ready || !Number.isFinite(position) || position < 0 || bytes[8] > (playback ? 1 : 2)) {
						throw new Error('Invalid playback state.');
					}
					if (playback) {
						this.onPlayback({ position, finished: bytes[8] === 1 });
						clearTimeout(timer); resolveReady();
					} else { this.setVoiceTesting(bytes[8] === 0, bytes[8] === 2); }
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
			if (playback) { this.command(playback.loadPdx ? { type: 'playbackInfo', source: playback.source } : { type: 'playback', ...playback }); }
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

	setMuted(muted: number): void {
		if (this.connected && Number.isInteger(muted) && muted >= 0 && muted <= 511) { void this.command({ type: 'playbackMute', muted }); }
	}

	setVoice(voice: unknown): void {
		const serialized = JSON.stringify(voice);
		if (serialized === this.voice || !this.process) { return; }
		this.voice = serialized;
		this.command({ type: 'voice', voice });
	}

	note(command: object): void { if (this.connected) { this.command(command); } }

	reset(voice: unknown): Promise<boolean> {
		if (!this.connected) { return Promise.resolve(false); }
		if (this.resetting) { return this.resetting; }
		this.voice = JSON.stringify(voice);
		const reset = new Promise<boolean>(resolve => { this.resetReady = resolve; });
		const timer = setTimeout(() => this.disconnect('Emulator reset timed out.'), 3000);
		this.resetting = reset.finally(() => { clearTimeout(timer); this.resetting = undefined; });
		this.command({ type: 'reset', voice });
		return this.resetting;
	}

	startVoiceTest(mml: string, voice: unknown): void {
		if (!this.connected) { return; }
		this.setVoiceTesting(true); this.command({ type: 'voiceTest', mml, voice });
	}

	stopVoiceTest(): void {
		if (this.connected && this.voiceTesting) { this.command({ type: 'voiceTestStop' }); }
		this.setVoiceTesting(false);
	}

	private setVoiceTesting(playing: boolean, error = false): void {
		if (this.voiceTesting === playing && this.voiceTestError === error) { return; }
		this.voiceTesting = playing; this.voiceTestError = error; this.onVoiceTest(playing, error);
	}

	request(blocks = 1): void {
		if (!this.connected || !Number.isInteger(blocks) || blocks < 1 || blocks > 4) { return; }
		for (let index = 0; index < blocks && this.renders < 4; index++) {
			this.renders++;
			this.command({ type: 'render' });
		}
	}

	private command(command: object): Promise<void> {
		const process = this.process;
		if (!process) { return Promise.resolve(); }
		if (this.queued >= 256) { this.disconnect('Emulator command queue overflow.'); return Promise.resolve(); }
		this.queued++;
		this.writes = this.writes.then(async () => {
			if (this.process !== process) { return; }
			try { await process.stdin!.write(`${JSON.stringify(command)}\n`); }
			finally { if (this.process === process) { this.queued--; } }
		}).catch(error => {
			if (this.process === process) { this.disconnect(error instanceof Error ? error.message : String(error)); }
		});
		return this.writes;
	}

	private stop(): void {
		this.resetReady?.(false); this.resetReady = undefined;
		this.setVoiceTesting(false);
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