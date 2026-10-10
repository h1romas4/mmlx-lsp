import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { NanoDriveConnection, NanoDriveState, NanoDriveOutputState, NanoDrivePlaybackState } from './nanodrive';
import type { NanoDriveController, NanoDriveProcessCommand, ClientMessage, HostMessage } from './nanodriveProcessProtocol';

type Callbacks = ConstructorParameters<typeof NanoDriveConnection>;

export class NanoDriveProcess implements NanoDriveController {
    private child?: ChildProcess;
    private nextId = 0;
    private snapshot: NanoDriveState = { port: '', connected: false, connecting: false, closing: false, phase: '', model: '', firmware: '', error: '' };
    private output: NanoDriveOutputState = { connected: false, connecting: false, error: '' };
    private playback: NanoDrivePlaybackState = { busy: false, playing: false, loading: false, position: 0, finished: false, error: '' };
    private readonly pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; loadPdx?: (name: string) => Promise<Uint8Array> }>();
    private volume = 1;
    private muted = 0;
    private disposing?: Promise<void>;

    constructor(private readonly extensionPath: string, private readonly onState: Callbacks[1],
        private readonly onOutput: NonNullable<Callbacks[4]> = () => {}, private readonly onPlayback: NonNullable<Callbacks[5]> = () => {},
        private readonly onDiagnostic: NonNullable<Callbacks[6]> = () => {}, private readonly onVoiceTest: NonNullable<Callbacks[7]> = () => {},
        private readonly onKeys: NonNullable<Callbacks[8]> = () => {},
        private readonly hostPath = join(extensionPath, 'dist', 'nanodriveProcessHost.js')) {}

    get state(): NanoDriveState { return { ...this.snapshot }; }
    get outputState(): NanoDriveOutputState { return { ...this.output }; }
    get playbackState(): NanoDrivePlaybackState { return { ...this.playback }; }

    private start(): void {
        if (this.child) { return; }
        const executable = join(this.extensionPath, 'dist', 'native', `mmlx-nanodrive${process.platform === 'win32' ? '.exe' : ''}`);
        const child = fork(this.hostPath, [executable], { execPath: process.execPath, execArgv: [], windowsHide: true,
            serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
        this.child = child;
        let stderr = '';
        child.stdout?.resume();
        child.stderr?.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4096); });
        child.on('message', (message: ClientMessage) => { if (this.child === child) { this.receive(child, message); } });
        child.on('error', error => this.fail(child, error.message));
        child.once('exit', (code, signal) => this.fail(child, this.disposing ? '' : stderr.trim() || `NanoDrive8 playback process exited (${signal ?? code}).`));
        void this.call('setVolume', [this.volume]).catch(() => {});
        void this.call('setMuted', [this.muted]).catch(() => {});
    }

    private send(child: ChildProcess, message: HostMessage): void {
        if (!child.connected) { this.fail(child, 'NanoDrive8 playback process disconnected.'); return; }
        child.send(message, error => { if (error) { this.fail(child, error.message); } });
    }

    private call(method: NanoDriveProcessCommand, args: unknown[] = [], loadPdx?: (name: string) => Promise<Uint8Array>): Promise<void> {
        const child = this.child;
        if (!child) { return Promise.resolve(); }
        const id = this.nextId++;
        return new Promise<void>((resolve, reject) => {
            this.pending.set(id, { resolve, reject, loadPdx });
            this.send(child, { type: 'call', id, method, args });
        });
    }

    private receive(child: ChildProcess, message: ClientMessage): void {
        switch (message.type) {
            case 'state': this.snapshot = message.state; this.onState(this.state); break;
            case 'output': this.output = message.state; this.onOutput(this.outputState); break;
            case 'playback': this.playback = message.state; this.onPlayback(this.playbackState); break;
            case 'diagnostic': this.onDiagnostic(message.message); break;
            case 'voiceTest': this.onVoiceTest(message.playing, message.error); break;
            case 'keys': this.onKeys(message.keys); break;
            case 'reply': {
                const pending = this.pending.get(message.id);
                if (!pending) { break; }
                this.pending.delete(message.id);
                if (message.error !== undefined) { pending.reject(new Error(message.error)); } else { pending.resolve(); }
                break;
            }
            case 'loadPdx': {
                const pending = this.pending.get(message.id);
                if (!pending?.loadPdx) { this.send(child, { type: 'pdx', id: message.id, error: 'PDX loader unavailable.' }); break; }
                void Promise.resolve().then(() => pending.loadPdx!(message.name)).then(bytes => {
                    if (this.child === child) { this.send(child, { type: 'pdx', id: message.id, bytes }); }
                }, error => {
                    if (this.child === child) { this.send(child, { type: 'pdx', id: message.id, error: error instanceof Error ? error.message : String(error) }); }
                });
                break;
            }
        }
    }

    private fail(child: ChildProcess, error: string): void {
        if (this.child !== child) { return; }
        this.child = undefined;
        child.kill();
        for (const pending of this.pending.values()) { pending.reject(new Error(error || 'NanoDrive8 playback process stopped.')); }
        this.pending.clear();
        this.snapshot = { ...this.snapshot, port: '', connected: false, connecting: false, closing: false, phase: '', error };
        this.output = { connected: false, connecting: false, error };
        this.playback = { ...this.playback, busy: false, playing: false, loading: false, error };
        this.onState(this.state); this.onOutput(this.outputState); this.onPlayback(this.playbackState); this.onVoiceTest(false);
        if (error) { this.onDiagnostic(error); }
    }

    async connect(path: string): Promise<void> {
        await this.disposing;
        if (this.snapshot.connected || this.snapshot.connecting || this.snapshot.closing) { return; }
        this.snapshot = { ...this.snapshot, port: path, connecting: true, error: '' };
        this.onState(this.state);
        this.start();
        await this.call('connect', [path]).catch(() => {});
    }
    disconnect(error = '', reset = true): Promise<void> { return this.call('disconnect', [error, reset]).catch(() => {}); }
    setVolume(volume: number): Promise<void> {
        if (!Number.isFinite(volume) || volume < 0 || volume > 1) { return Promise.resolve(); }
        this.volume = volume; return this.call('setVolume', [volume]);
    }
    setMuted(muted: number): Promise<void> {
        if (!Number.isInteger(muted) || muted < 0 || muted > 511) { return Promise.resolve(); }
        this.muted = muted; return this.call('setMuted', [muted]);
    }
    startPlayback(...[source, looped, loadPdx, options = {}]: Parameters<NanoDriveConnection['startPlayback']>): Promise<void> {
        return this.call('startPlayback', [source, looped, options], loadPdx);
    }
    stopPlayback(error = '', finished = false): Promise<void> { return this.call('stopPlayback', [error, finished]); }
    startVoiceTest(mml: string, voice: unknown): Promise<void> { return this.call('startVoiceTest', [mml, voice]); }
    stopVoiceTest(failed = false): Promise<void> { return this.call('stopVoiceTest', [failed]); }
    resetOutput(voice: unknown): Promise<void> { return this.call('resetOutput', [voice]); }
    connectOutput(voice: unknown, reset = false): Promise<void> { return this.call('connectOutput', [voice, reset]); }
    disconnectOutput(): Promise<void> { return this.call('disconnectOutput'); }
    setVoice(voice: unknown): void { void this.call('setVoice', [voice]).catch(() => {}); }
    note(command: Parameters<NanoDriveConnection['note']>[0]): void { void this.call('note', [command]).catch(() => {}); }

    dispose(): Promise<void> {
        if (this.disposing) { return this.disposing; }
        const child = this.child;
        if (!child) { return Promise.resolve(); }
        const disposing = new Promise<void>(resolve => {
            const timer = setTimeout(() => { this.fail(child, 'NanoDrive8 playback process shutdown timed out.'); resolve(); }, 5000);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
            this.send(child, { type: 'call', id: this.nextId++, method: 'dispose', args: [] });
        }).finally(() => { if (this.disposing === disposing) { this.disposing = undefined; } });
        this.disposing = disposing;
        return disposing;
    }
}
