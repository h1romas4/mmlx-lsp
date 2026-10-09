import { randomBytes } from 'node:crypto';

export interface NanoDrivePort {
    readonly isOpen: boolean;
    read(buffer: Buffer, offset: number, length: number): Promise<{ buffer: Buffer; bytesRead: number }>;
    write(buffer: Buffer): Promise<void>;
    drain(): Promise<void>;
    close(): Promise<void>;
}

export type NanoDriveCommand = 'ping' | 'getInfo' | 'reset' | 'setClock' | 'setPlaybackClock' | 'audioStart' | 'audioStatus';
export type NanoDriveInput = { type: 'init' | 'voice'; voice: unknown }
    | { type: 'noteOn'; source: number; channel: number; note: number; velocity: number }
    | { type: 'noteOff'; source: number; channel: number; note: number }
    | { type: 'pitchBend'; source: number; channel: number; value: number }
    | { type: 'allOff'; source?: number; channel?: number } | { type: 'stop' };
export interface NanoDriveOutputState { connected: boolean; connecting: boolean; error: string; }
export interface NanoDriveReply { status: number; model?: string; firmware?: string;
    accepted?: number; played?: number; pending?: number; running?: boolean; ended?: boolean; fault?: boolean;
    underflows?: number; overflows?: number; rejected?: number;
}
export interface NanoDrivePlaybackState { busy: boolean; playing: boolean; loading: boolean; position: number; finished: boolean; error: string; }
export type NanoDriveAdpcmMode = 'through' | 'resample' | 'lpf';
export type NanoDriveCodec = (params: { operation: 'encode'; command: NanoDriveCommand; requestId: number; payload: number[] }
    | { operation: 'decode'; body: number[]; request: number[] }
    | { operation: 'audition'; session: number; requestId: number; command: NanoDriveInput }
    | { operation: 'upload'; asset: 'source' | 'pdx'; offset: number; bytes: number[] }
    | { operation: 'playbackInfo' | 'playbackStop' }
    | { operation: 'playbackInit'; looped: boolean; adpcmMode?: NanoDriveAdpcmMode }
    | { operation: 'playbackNext'; requestId: number }) => Promise<{ bytes: number[] | Uint8Array; count?: number; position?: number; ended?: boolean; fm?: boolean; synchronize?: boolean } | { pdxName?: string | null; audio?: boolean } | NanoDriveReply | null>;
export interface NanoDriveState {
    port: string; connected: boolean; connecting: boolean; closing: boolean;
    phase: string; model: string; firmware: string; error: string;
}

export async function openNanoDrivePort(path: string): Promise<NanoDrivePort> {
    const { autoDetect } = await import('@serialport/bindings-cpp');
    return autoDetect().open({ path, baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false, hupcl: false });
}

export function isSupportedNanoDriveFirmware(firmware: string): boolean {
    const version = /^(\d+)\.(\d+)/.exec(firmware);
    return version?.[1] === '1' && version[2] === '0';
}

class ResponseTimeout extends Error {}
const emptyState = (): NanoDriveState => ({ port: '', connected: false, connecting: false, closing: false,
    phase: '', model: '', firmware: '', error: '' });

export class NanoDriveConnection {
    private snapshot = emptyState();
    private port?: NanoDrivePort;
    private opening?: Promise<NanoDrivePort>;
    private closing?: Promise<void>;
    private generation = 0;
    private starting = false;
    private requestId = 0;
    private writes: Promise<void> = Promise.resolve();
    private pending?: { request: number[]; resolve: (reply: NanoDriveReply) => void; reject: (error: Error) => void };
    private partialTimer?: ReturnType<typeof setTimeout>;
    private body: number[] = [];
    private discarding = true;
    private output: NanoDriveOutputState = { connected: false, connecting: false, error: '' };
    private outputGeneration = 0;
    private session = 0;
    private outputStarting = false;
    private outputClosing?: Promise<void>;
    private inputs: Promise<void> = Promise.resolve();
    private queued = 0;
    private voice = '';
    private playbackGeneration = 0;
    private playbackStopping?: Promise<void>;
    private hardwarePlayback: NanoDrivePlaybackState = { busy: false, playing: false, loading: false, position: 0, finished: false, error: '' };

    constructor(private readonly codec: NanoDriveCodec, private readonly onState: (state: NanoDriveState) => void,
        private readonly openPort: (path: string) => Promise<NanoDrivePort> = openNanoDrivePort,
        private readonly responseTimeout = 1000,
        private readonly onOutput: (state: NanoDriveOutputState) => void = () => {},
        private readonly onPlayback: (state: NanoDrivePlaybackState) => void = () => {}) {}

    get state(): NanoDriveState { return { ...this.snapshot }; }
    get outputState(): NanoDriveOutputState { return { ...this.output }; }
    get playbackState(): NanoDrivePlaybackState { return { ...this.hardwarePlayback }; }

    async startPlayback(source: string, looped: boolean, loadPdx: (name: string) => Promise<Uint8Array>,
        options: { adpcmMode?: NanoDriveAdpcmMode; pdxConfigured?: boolean } = {}): Promise<void> {
        if (this.hardwarePlayback.busy || !this.snapshot.connected) { return; }
        await this.playbackStopping;
        if (this.hardwarePlayback.busy || !this.snapshot.connected) { return; }
        const token = ++this.playbackGeneration;
        const connection = this.generation;
        this.hardwarePlayback = { busy: true, playing: false, loading: true, position: 0, finished: false, error: '' };
        this.onPlayback(this.playbackState);
        const check = () => { if (token !== this.playbackGeneration || connection !== this.generation) { throw new Error('NanoDrive8 playback canceled.'); } };
        const upload = async (asset: 'source' | 'pdx', bytes: Uint8Array) => {
            for (let offset = 0; offset < Math.max(1, bytes.length); offset += 8192) {
                check(); await this.codec({ operation: 'upload', asset, offset, bytes: Array.from(bytes.subarray(offset, offset + 8192)) }); check();
            }
        };
        let poll: Promise<void> | undefined;
        let failure: unknown;
        let observed: NanoDriveReply = { status: 0, accepted: 0, played: 0, pending: 0 };
        let observedAt = 0; let polledAt = 0; let sent = 0; let ended = false;
        let resetting = false;
        try {
            await this.disconnectOutput(); check();
            await upload('source', new TextEncoder().encode(source));
            await upload('pdx', new Uint8Array(0));
            const info = await this.codec({ operation: 'playbackInfo' }); check();
            if (info && 'pdxName' in info && (info.pdxName || (info.audio && options.pdxConfigured))) {
                const pdx = await loadPdx(info.pdxName ?? ''); check(); await upload('pdx', pdx);
            }
            const prepared = await this.codec({ operation: 'playbackInit', looped, adpcmMode: options.adpcmMode ?? 'resample' }); check();
            if (!prepared || !('audio' in prepared) || typeof prepared.audio !== 'boolean') { throw new Error('Invalid NanoDrive8 playback mode.'); }
            resetting = true;
            await this.request('reset'); resetting = false; check();
            if (!prepared.audio) {
                await this.send('setPlaybackClock'); check();
                await this.playFm(connection, token, check);
                check(); await this.stopPlayback('', true); return;
            }
            const reset = await this.request('audioStatus'); check();
            if (reset.accepted !== 0 || reset.played !== 0 || reset.pending !== 0 || reset.running !== false || reset.fault !== false) { throw new Error('Invalid NanoDrive8 reset status.'); }
            await this.send('setPlaybackClock'); check();
            const submit = async () => {
                check(); const requestId = this.requestId & 0xffff; this.requestId += 8192;
                const chunk = await this.codec({ operation: 'playbackNext', requestId }); check();
                if (!chunk || !('bytes' in chunk) || !Number.isInteger(chunk.count) || chunk.count! < 1 || chunk.count! > 8192
                    || !Number.isSafeInteger(chunk.position) || chunk.position! <= sent || chunk.position! - sent > 160 || typeof chunk.ended !== 'boolean') { throw new Error('Invalid NanoDrive8 playback chunk.'); }
                await this.write(chunk.bytes, connection, false, token); check();
                sent = chunk.position!; ended = chunk.ended;
            };
            while (sent < 625 && !ended) { await submit(); }
            await this.request('ping', [...randomBytes(8)]); check();
            await this.send('audioStart'); check();
            const startedAt = performance.now(); observedAt = startedAt; polledAt = startedAt - 100;
            this.hardwarePlayback.loading = false; this.hardwarePlayback.playing = true; this.onPlayback(this.playbackState);
            let confirmed = false; let endDeadline = Infinity;
            while (true) {
                check(); if (failure) { throw failure; }
                const now = performance.now();
                if (!poll && now - polledAt >= 80) {
                    polledAt = now;
                    poll = this.request('audioStatus').then(status => {
                        check();
                        if (!Number.isSafeInteger(status.played) || !Number.isSafeInteger(status.accepted) || !Number.isSafeInteger(status.pending)
                            || status.played! < observed.played! || status.played! > status.accepted! || status.accepted! > sent
                            || status.pending !== status.accepted! - status.played! || status.fault !== false || status.underflows !== 0 || status.overflows !== 0 || status.rejected !== 0
                            || (!status.running && !status.ended)) { throw new Error('NanoDrive8 playback status reported a fault.'); }
                        observed = status; observedAt = performance.now(); confirmed = true;
                    }).catch(error => { failure = error; }).finally(() => { poll = undefined; });
                }
                if ((!confirmed && now - startedAt > 250) || (poll && now - polledAt > 200)) { throw new Error('NanoDrive8 playback status timed out.'); }
                const played = Math.min(sent, observed.played! + (now - observedAt) * 7.8125);
                const position = Math.max(0, played / 7812.5 - 0.00512);
                if (Math.floor(position * 10) !== Math.floor(this.hardwarePlayback.position * 10)) { this.hardwarePlayback.position = position; this.onPlayback(this.playbackState); }
                if (ended) {
                    if (endDeadline === Infinity) { endDeadline = now + (sent - observed.played!) / 7.8125 + 1000; }
                    if (observed.ended && observed.played === sent && observed.accepted === sent) { break; }
                    if (now > endDeadline) { throw new Error('NanoDrive8 playback did not reach END.'); }
                } else if (sent < played + 625 && sent - observed.played! < 1800) { await submit(); continue; }
                await new Promise<void>(resolve => setTimeout(resolve, 2));
            }
            if (token === this.playbackGeneration) { await this.stopPlayback('', true); }
        } catch (error) {
            if (token === this.playbackGeneration) {
                const message = error instanceof Error ? error.message : String(error);
                if (resetting) { await this.disconnect(message, false); }
                else { await this.stopPlayback(message); }
            }
        }
    }

    private async playFm(connection: number, token: number, check: () => void): Promise<void> {
        let origin = performance.now();
        let position = 0;
        this.hardwarePlayback.loading = false; this.hardwarePlayback.playing = true; this.onPlayback(this.playbackState);
        while (true) {
            check(); const requestId = this.requestId & 0xffff; this.requestId += 8192;
            const chunk = await this.codec({ operation: 'playbackNext', requestId }); check();
            if (!chunk || !('bytes' in chunk) || chunk.fm !== true || !Number.isInteger(chunk.count) || chunk.count! < 0 || chunk.count! > 8192
                || !Number.isSafeInteger(chunk.position) || chunk.position! < position || typeof chunk.ended !== 'boolean' || typeof chunk.synchronize !== 'boolean'
                || ((chunk.count === 0) !== (chunk.bytes.length === 0))) { throw new Error('Invalid NanoDrive8 FM chunk.'); }
            const deadline = origin + chunk.position! / 44.1;
            while (performance.now() < deadline) {
                check();
                const now = performance.now();
                const elapsed = Math.max(0, (now - origin) / 1000);
                if (Math.floor(elapsed * 10) !== Math.floor(this.hardwarePlayback.position * 10)) { this.hardwarePlayback.position = elapsed; this.onPlayback(this.playbackState); }
                await new Promise<void>(resolve => setTimeout(resolve, Math.max(1, Math.min(10, deadline - now))));
            }
            check();
            if (chunk.bytes.length) { await this.write(chunk.bytes, connection, false, token); check(); }
            if (chunk.synchronize) {
                await this.request('ping', [...randomBytes(8)]); check();
                origin = performance.now() - chunk.position! / 44.1;
            }
            position = chunk.position!;
            this.hardwarePlayback.position = position / 44100;
            if (chunk.ended) { return; }
        }
    }

    stopPlayback(error = '', finished = false): Promise<void> {
        if (this.playbackStopping) { return this.playbackStopping; }
        if (!this.hardwarePlayback.busy) { return Promise.resolve(); }
        this.playbackGeneration++;
        this.pending?.reject(new Error('NanoDrive8 playback canceled.'));
        const stopping = (async () => {
            try {
                if (this.snapshot.connected && !this.snapshot.closing) { await this.request('reset'); }
                await this.codec({ operation: 'playbackStop' });
            } catch (failure) {
                error ||= failure instanceof Error ? failure.message : String(failure);
                await this.disconnect(error, false);
            }
            this.hardwarePlayback = { ...this.hardwarePlayback, busy: false, playing: false, loading: false, position: finished ? this.hardwarePlayback.position : 0, finished, error };
            this.onPlayback(this.playbackState);
        })();
        this.playbackStopping = stopping;
        return stopping.finally(() => { if (this.playbackStopping === stopping) { this.playbackStopping = undefined; } });
    }

    async connectOutput(voice: unknown): Promise<void> {
        if (this.hardwarePlayback.busy) { return; }
        if (this.outputStarting || this.output.connected) { return; }
        this.outputStarting = true;
        const connection = this.generation;
        const cancellation = this.outputGeneration;
        try {
            await this.outputClosing;
            if (connection !== this.generation || cancellation !== this.outputGeneration) { return; }
            if (!this.snapshot.connected) {
                this.output = { connected: false, connecting: false, error: 'Connect NanoDrive8 in Settings first.' };
                this.emitOutput(); return;
            }
            const generation = ++this.outputGeneration;
            this.session = (this.session + 1) >>> 0;
            this.voice = JSON.stringify(voice);
            this.output = { connected: false, connecting: true, error: '' }; this.emitOutput();
            try {
                await this.input({ type: 'init', voice });
                if (connection !== this.generation || generation !== this.outputGeneration) { return; }
                await this.request('ping', [...randomBytes(8)]);
                if (connection !== this.generation || generation !== this.outputGeneration) { return; }
                this.output = { connected: true, connecting: false, error: '' }; this.emitOutput();
            } catch (error) {
                if (connection === this.generation && generation === this.outputGeneration) {
                    await this.disconnect(error instanceof Error ? error.message : String(error));
                }
            }
        } finally { this.outputStarting = false; }
    }

    disconnectOutput(): Promise<void> {
        if (this.outputClosing) { return this.outputClosing; }
        if (!this.output.connected && !this.output.connecting) {
            if (this.outputStarting) { this.outputGeneration++; }
            return Promise.resolve();
        }
        const generation = ++this.outputGeneration;
        const connection = this.generation;
        if (this.output.connecting) { this.pending?.reject(new Error('NanoDrive8 keyboard canceled.')); }
        this.output = { connected: false, connecting: true, error: '' }; this.emitOutput();
        const closing = (async () => {
            try {
                await this.input({ type: 'stop' });
                if (connection === this.generation && generation === this.outputGeneration) {
                    await this.request('ping', [...randomBytes(8)]);
                }
                if (generation === this.outputGeneration) {
                    this.output = { connected: false, connecting: false, error: '' }; this.emitOutput();
                }
            } catch (error) {
                if (connection === this.generation && generation === this.outputGeneration) {
                    await this.disconnect(error instanceof Error ? error.message : String(error));
                }
            }
        })();
        this.outputClosing = closing;
        return closing.finally(() => { if (this.outputClosing === closing) { this.outputClosing = undefined; } });
    }

    setVoice(voice: unknown): void {
        const serialized = JSON.stringify(voice);
        if (!this.output.connected || serialized === this.voice) { return; }
        this.voice = serialized;
        void this.input({ type: 'voice', voice }).catch(() => {});
    }

    note(command: Exclude<NanoDriveInput, { type: 'init' | 'voice' } | { type: 'stop' }>): void {
        if (this.output.connected) { void this.input(command).catch(() => {}); }
    }

    private emitOutput(): void { this.onOutput(this.outputState); }

    private input(command: NanoDriveInput): Promise<void> {
        const connection = this.generation;
        const generation = this.outputGeneration;
        const session = this.session;
        if (this.queued >= 256) {
            void this.disconnect('NanoDrive8 command queue overflow.');
            return Promise.reject(new Error('NanoDrive8 command queue overflow.'));
        }
        this.queued++;
        const task = this.inputs.then(async () => {
            if (connection !== this.generation || generation !== this.outputGeneration || !this.snapshot.connected) { return; }
            const requestId = this.requestId & 0xffff;
            this.requestId += 3;
            const result = await this.codec({ operation: 'audition', session, requestId, command });
            if (connection !== this.generation || generation !== this.outputGeneration) { return; }
            if (!result || !('bytes' in result) || !Number.isInteger(result.count) || result.count! < 0 || result.count! > 3) {
                throw new Error('Invalid NanoDrive8 keyboard response.');
            }
            if (result.bytes.length) { await this.write(result.bytes, connection); }
        }).finally(() => { this.queued--; });
        this.inputs = task.catch(error => {
            if (connection === this.generation && generation === this.outputGeneration) {
                void this.disconnect(error instanceof Error ? error.message : String(error));
            }
        });
        return task;
    }

    async connect(path: string): Promise<void> {
        if (this.starting || this.snapshot.connected || this.snapshot.closing) { return; }
        this.starting = true;
        try { await this.connectInternal(path); }
        finally { this.starting = false; }
    }

    private async connectInternal(path: string): Promise<void> {
        const cleanup = this.disconnect();
        const generation = this.generation;
        await cleanup;
        if (generation !== this.generation) { return; }
        this.snapshot = { ...emptyState(), port: path, connecting: true, phase: 'Opening' };
        this.emit();
        try {
            const opening = this.openPort(path);
            this.opening = opening;
            const port = await opening;
            if (generation !== this.generation) { return; }
            this.opening = undefined;
            this.port = port;
            this.body = []; this.discarding = true;
            void this.read(port).catch(error => {
                if (this.port === port && !this.snapshot.closing) { void this.disconnect(String(error)); }
            });
            this.phase('Checking connection');
            if (generation !== this.generation) { return; }
            for (let attempt = 0; ; attempt++) {
                try { await this.request('ping', [...randomBytes(8)]); break; }
                catch (error) { if (!(error instanceof ResponseTimeout) || attempt >= 2) { throw error; } }
            }
            const info = await this.request('getInfo');
            if (generation !== this.generation) { return; }
            if (info.model !== 'NanoDrive 8') { throw new Error(`Unexpected device: ${info.model ?? 'unknown'}`); }
            if (!info.firmware || !isSupportedNanoDriveFirmware(info.firmware)) {
                throw new Error(`Unsupported NanoDrive8 firmware: ${info.firmware ?? 'unknown'} (requires 1.0)`);
            }
            this.snapshot.model = info.model; this.snapshot.firmware = info.firmware;
            this.phase('Initializing');
            if (generation !== this.generation) { return; }
            await this.request('reset');
            if (generation !== this.generation) { return; }
            await this.send('setClock');
            if (generation !== this.generation) { return; }
            await this.request('ping', [...randomBytes(8)]);
            if (generation !== this.generation) { return; }
            this.snapshot.connected = true; this.snapshot.connecting = false; this.snapshot.phase = '';
            this.emit();
        } catch (error) {
            if (generation === this.generation) { await this.disconnect(error instanceof Error ? error.message : String(error)); }
        }
    }

    disconnect(error = '', reset = true): Promise<void> {
        if (this.closing) { return this.closing; }
        const wasConnected = this.snapshot.connected;
        this.generation++;
        this.playbackGeneration++;
        if (this.hardwarePlayback.busy) {
            this.hardwarePlayback = { busy: false, playing: false, loading: false, position: 0, finished: false, error };
            this.onPlayback(this.playbackState);
            void this.codec({ operation: 'playbackStop' }).catch(() => {});
        }
        this.outputGeneration++;
        this.voice = '';
        this.output = { connected: false, connecting: false, error }; this.emitOutput();
        this.pending?.reject(new Error('NanoDrive8 connection canceled.'));
        this.snapshot.connected = false; this.snapshot.connecting = false;
        this.snapshot.closing = !!this.port || !!this.opening;
        this.snapshot.phase = this.snapshot.closing ? 'Disconnecting' : '';
        this.emit();
        const opening = this.opening;
        const closing = (async () => {
            if (reset && wasConnected && this.port?.isOpen) {
                try { await this.request('reset'); }
                catch (failure) { error ||= `RESET not confirmed: ${failure instanceof Error ? failure.message : String(failure)}`; }
            }
            if (opening) {
                try { const port = await opening; if (port !== this.port && port.isOpen) { await port.close(); } }
                catch { }
                if (this.opening === opening) { this.opening = undefined; }
            }
            const port = this.port; this.port = undefined;
            clearTimeout(this.partialTimer); this.body = []; this.discarding = true;
            try { if (port?.isOpen) { await port.close(); } }
            catch (failure) { error ||= `Could not close NanoDrive8: ${String(failure)}`; }
            this.snapshot = { ...emptyState(), error }; this.emit();
        })();
        this.closing = closing;
        return closing.finally(() => { if (this.closing === closing) { this.closing = undefined; } });
    }

    private emit(): void { this.onState(this.state); }
    private phase(phase: string): void { this.snapshot.phase = phase; this.emit(); }

    private async encode(command: NanoDriveCommand, payload: number[]): Promise<number[] | Uint8Array> {
        const result = await this.codec({ operation: 'encode', command, requestId: this.requestId++ & 0xffff, payload });
        if (!result || !('bytes' in result)) { throw new Error('NDSIF codec is unavailable.'); }
        return result.bytes;
    }

    private write(bytes: number[] | Uint8Array, generation: number, drain = true, playback?: number): Promise<void> {
        const port = this.port;
        this.writes = this.writes.catch(() => {}).then(async () => {
            if (!port || port !== this.port || generation !== this.generation) { throw new Error('NanoDrive8 connection canceled.'); }
            if (playback !== undefined && playback !== this.playbackGeneration) { throw new Error('NanoDrive8 playback canceled.'); }
            await port.write(bytes instanceof Uint8Array ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : Buffer.from(bytes));
            if (drain) { await port.drain(); }
        });
        return this.writes;
    }

    private async send(command: NanoDriveCommand): Promise<void> {
        const generation = this.generation;
        const bytes = await this.encode(command, []);
        await this.write(bytes, generation);
    }

    private async request(command: NanoDriveCommand, payload: number[] = []): Promise<NanoDriveReply> {
        const generation = this.generation;
        const bytes = await this.encode(command, payload);
        if (generation !== this.generation || !this.port) { throw new Error('NanoDrive8 connection canceled.'); }
        if (this.pending) { throw new Error('An NDSIF request is already pending.'); }
        return new Promise<NanoDriveReply>((resolve, reject) => {
            const finish = (reply?: NanoDriveReply, error?: Error) => {
                if (this.pending !== pending) { return; }
                clearTimeout(timer); this.pending = undefined;
                if (error) { reject(error); } else { resolve(reply!); }
            };
            const pending = { request: Array.from(bytes), resolve: (reply: NanoDriveReply) => finish(reply), reject: (error: Error) => finish(undefined, error) };
            const timer = setTimeout(() => pending.reject(new ResponseTimeout(`NanoDrive8 ${command} timed out.`)), this.responseTimeout);
            this.pending = pending;
            void this.write(bytes, generation, command !== 'audioStatus').catch(error => pending.reject(error));
        }).then(reply => {
            if (reply.status !== 0) { throw new Error(`NanoDrive8 rejected ${command}.`); }
            return reply;
        });
    }

    private async read(port: NanoDrivePort): Promise<void> {
        const buffer = Buffer.alloc(4096);
        while (this.port === port && port.isOpen) {
            const { bytesRead } = await port.read(buffer, 0, buffer.length);
            if (this.port !== port) { return; }
            for (const byte of buffer.subarray(0, bytesRead)) {
                if (byte === 0) {
                    const body = this.body; this.body = []; this.discarding = false;
                    clearTimeout(this.partialTimer);
                    const pending = this.pending;
                    if (body.length && pending) {
                        const reply = await this.codec({ operation: 'decode', body, request: pending.request });
                        if (reply && 'status' in reply && this.pending === pending) { pending.resolve(reply); }
                    }
                } else if (!this.discarding) {
                    if (this.body.length === 268) { this.body = []; this.discarding = true; }
                    else { this.body.push(byte); }
                }
            }
            if (this.body.length) {
                clearTimeout(this.partialTimer);
                this.partialTimer = setTimeout(() => { this.body = []; this.discarding = true; }, 500);
            }
        }
    }
}