import { Worker } from 'node:worker_threads';
import type { FmKeyEvent } from './emulationProtocol';
import type { NanoDriveConnection, NanoDriveState, NanoDriveOutputState, NanoDrivePlaybackState } from './nanodrive';

type Method = 'connect' | 'disconnect' | 'connectOutput' | 'disconnectOutput' | 'resetOutput' | 'setVoice' | 'note'
	| 'setMuted' | 'setVolume' | 'startPlayback' | 'stopPlayback' | 'startVoiceTest' | 'stopVoiceTest';
export interface NanoDriveThreadRequest { id: number; method: Method; args: unknown[] }
export type NanoDriveThreadEvent = { type: 'state'; state: NanoDriveState } | { type: 'output'; state: NanoDriveOutputState }
	| { type: 'playback'; state: NanoDrivePlaybackState } | { type: 'diagnostic'; message: string }
	| { type: 'keys'; keys: FmKeyEvent[] } | { type: 'voiceTest'; playing: boolean; error?: boolean }
	| { type: 'reply'; id: number; error?: string } | { type: 'asset'; id: number; name: string };

export class NanoDriveThreadClient implements Pick<NanoDriveConnection, Method | 'state' | 'outputState' | 'playbackState'> {
	private worker?: Worker;
	private id = 0;
	private disposed = false;
	private snapshot: NanoDriveState = { port: '', connected: false, connecting: false, closing: false, phase: '', model: '', firmware: '', error: '' };
	private output: NanoDriveOutputState = { connected: false, connecting: false, error: '' };
	private playback: NanoDrivePlaybackState = { busy: false, playing: false, loading: false, position: 0, finished: false, error: '' };
	private readonly pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; loadPdx?: (name: string) => Promise<Uint8Array> }>();

	constructor(private readonly entry: string, private readonly wasmPath: string,
		private readonly onState: (state: NanoDriveState) => void,
		private readonly onOutput: (state: NanoDriveOutputState) => void,
		private readonly onPlayback: (state: NanoDrivePlaybackState) => void,
		private readonly onDiagnostic: (message: string) => void,
		private readonly onVoiceTest: (playing: boolean, error?: boolean) => void,
		private readonly onKeys: (keys: FmKeyEvent[]) => void) {}

	get state(): NanoDriveState { return { ...this.snapshot }; }
	get outputState(): NanoDriveOutputState { return { ...this.output }; }
	get playbackState(): NanoDrivePlaybackState { return { ...this.playback }; }

	private start(): Worker {
		if (this.disposed) { throw new Error('NanoDrive8 worker disposed.'); }
		if (this.worker) { return this.worker; }
		const worker = new Worker(this.entry, { workerData: { wasmPath: this.wasmPath } });
		this.worker = worker;
		worker.on('message', (event: NanoDriveThreadEvent) => {
			if (this.worker !== worker) { return; }
			switch (event.type) {
				case 'state': this.snapshot = event.state; this.onState(this.state); break;
				case 'output': this.output = event.state; this.onOutput(this.outputState); break;
				case 'playback': this.playback = event.state; this.onPlayback(this.playbackState); break;
				case 'diagnostic': this.onDiagnostic(event.message); break;
				case 'voiceTest': this.onVoiceTest(event.playing, event.error); break;
				case 'keys': this.onKeys(event.keys); break;
				case 'reply': {
					const pending = this.pending.get(event.id); this.pending.delete(event.id);
					if (event.error) { pending?.reject(new Error(event.error)); } else { pending?.resolve(); }
					break;
				}
				case 'asset': {
					const loadPdx = this.pending.get(event.id)?.loadPdx;
					void (async () => {
						try {
							if (!loadPdx) { throw new Error('NanoDrive8 playback canceled.'); }
							const bytes = await loadPdx(event.name);
							if (bytes.length > 16 * 1024 * 1024) { throw new Error('PDX is too large (maximum 16 MiB).'); }
							if (this.worker === worker && this.pending.has(event.id)) { worker.postMessage({ asset: event.id, bytes }); }
						} catch (error) {
							if (this.worker === worker) { worker.postMessage({ asset: event.id, error: String(error) }); }
						}
					})();
					break;
				}
			}
		});
		worker.on('error', error => this.fail(worker, error instanceof Error ? error : new Error(String(error))));
		worker.on('exit', code => this.fail(worker, new Error(`NanoDrive8 worker exited (${code}).`)));
		return worker;
	}

	private async call(method: Method, args: unknown[], loadPdx?: (name: string) => Promise<Uint8Array>): Promise<void> {
		const worker = this.start();
		if (this.pending.size >= 256) { throw new Error('NanoDrive8 worker queue overflow.'); }
		const id = this.id++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject, loadPdx });
			try { worker.postMessage({ id, method, args } satisfies NanoDriveThreadRequest); }
			catch (error) { this.pending.delete(id); reject(error); }
		});
	}

	private fail(worker: Worker, error: Error): void {
		if (this.worker !== worker) { return; }
		this.worker = undefined;
		for (const pending of this.pending.values()) { pending.reject(error); } this.pending.clear();
		void worker.terminate();
		this.snapshot = { ...this.snapshot, connected: false, connecting: false, closing: false, phase: '', error: error.message };
		this.output = { connected: false, connecting: false, error: error.message };
		this.playback = { ...this.playback, busy: false, playing: false, loading: false, error: error.message };
		this.onState(this.state); this.onOutput(this.outputState); this.onPlayback(this.playbackState); this.onVoiceTest(false);
		this.onDiagnostic(error.message);
	}

	connect(...args: Parameters<NanoDriveConnection['connect']>): Promise<void> { return this.call('connect', args); }
	disconnect(...args: Parameters<NanoDriveConnection['disconnect']>): Promise<void> { return this.worker ? this.call('disconnect', args) : Promise.resolve(); }
	connectOutput(...args: Parameters<NanoDriveConnection['connectOutput']>): Promise<void> { return this.call('connectOutput', args); }
	disconnectOutput(): Promise<void> { return this.worker ? this.call('disconnectOutput', []) : Promise.resolve(); }
	resetOutput(...args: Parameters<NanoDriveConnection['resetOutput']>): Promise<void> { return this.call('resetOutput', args); }
	setVoice(...args: Parameters<NanoDriveConnection['setVoice']>): void { if (this.worker) { void this.call('setVoice', args).catch(() => {}); } }
	note(...args: Parameters<NanoDriveConnection['note']>): void { if (this.worker) { void this.call('note', args).catch(() => {}); } }
	setMuted(...args: Parameters<NanoDriveConnection['setMuted']>): Promise<void> { return this.call('setMuted', args); }
	setVolume(...args: Parameters<NanoDriveConnection['setVolume']>): Promise<void> { return this.call('setVolume', args); }
	startPlayback(source: string, looped: boolean, loadPdx: (name: string) => Promise<Uint8Array>, options?: Parameters<NanoDriveConnection['startPlayback']>[3]): Promise<void> {
		return this.call('startPlayback', [source, looped, options], loadPdx);
	}
	stopPlayback(...args: Parameters<NanoDriveConnection['stopPlayback']>): Promise<void> { return this.worker ? this.call('stopPlayback', args) : Promise.resolve(); }
	startVoiceTest(...args: Parameters<NanoDriveConnection['startVoiceTest']>): Promise<void> { return this.call('startVoiceTest', args); }
	stopVoiceTest(...args: Parameters<NanoDriveConnection['stopVoiceTest']>): Promise<void> { return this.worker ? this.call('stopVoiceTest', args) : Promise.resolve(); }

	async dispose(): Promise<void> {
		try { await this.disconnect(); }
		finally {
			this.disposed = true;
			const worker = this.worker; this.worker = undefined;
			for (const pending of this.pending.values()) { pending.reject(new Error('NanoDrive8 worker disposed.')); } this.pending.clear();
			await worker?.terminate();
		}
	}
}