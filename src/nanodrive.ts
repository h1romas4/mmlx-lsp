import { randomBytes } from 'node:crypto';

export interface NanoDrivePort {
    readonly isOpen: boolean;
    read(buffer: Buffer, offset: number, length: number): Promise<{ buffer: Buffer; bytesRead: number }>;
    write(buffer: Buffer): Promise<void>;
    drain(): Promise<void>;
    close(): Promise<void>;
}

export type NanoDriveCommand = 'ping' | 'getInfo' | 'reset' | 'setClock';
export interface NanoDriveReply { status: number; model?: string; firmware?: string; }
export type NanoDriveCodec = (params: { operation: 'encode'; command: NanoDriveCommand; requestId: number; payload: number[] }
    | { operation: 'decode'; body: number[]; request: number[] }) => Promise<{ bytes: number[] } | NanoDriveReply | null>;
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

    constructor(private readonly codec: NanoDriveCodec, private readonly onState: (state: NanoDriveState) => void,
        private readonly openPort: (path: string) => Promise<NanoDrivePort> = openNanoDrivePort,
        private readonly responseTimeout = 1000) {}

    get state(): NanoDriveState { return { ...this.snapshot }; }

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

    disconnect(error = ''): Promise<void> {
        if (this.closing) { return this.closing; }
        const wasConnected = this.snapshot.connected;
        this.generation++;
        this.pending?.reject(new Error('NanoDrive8 connection canceled.'));
        this.snapshot.connected = false; this.snapshot.connecting = false;
        this.snapshot.closing = !!this.port || !!this.opening;
        this.snapshot.phase = this.snapshot.closing ? 'Disconnecting' : '';
        this.emit();
        const opening = this.opening;
        const closing = (async () => {
            if (wasConnected && this.port?.isOpen) {
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

    private async encode(command: NanoDriveCommand, payload: number[]): Promise<number[]> {
        const result = await this.codec({ operation: 'encode', command, requestId: this.requestId++ & 0xffff, payload });
        if (!result || !('bytes' in result)) { throw new Error('NDSIF codec is unavailable.'); }
        return result.bytes;
    }

    private write(bytes: number[], generation: number): Promise<void> {
        const port = this.port;
        this.writes = this.writes.catch(() => {}).then(async () => {
            if (!port || port !== this.port || generation !== this.generation) { throw new Error('NanoDrive8 connection canceled.'); }
            await port.write(Buffer.from(bytes));
            await port.drain();
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
            const pending = { request: bytes, resolve: (reply: NanoDriveReply) => finish(reply), reject: (error: Error) => finish(undefined, error) };
            const timer = setTimeout(() => pending.reject(new ResponseTimeout(`NanoDrive8 ${command} timed out.`)), this.responseTimeout);
            this.pending = pending;
            void this.write(bytes, generation).catch(error => pending.reject(error));
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