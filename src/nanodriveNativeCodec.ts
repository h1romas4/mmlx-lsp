import { constants, setPriority } from 'node:os';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EmulationFrameDecoder, decodeFmKeyEvents } from './emulationProtocol';
import type { NanoDriveCodec } from './nanodrive';

type Result = Awaited<ReturnType<NanoDriveCodec>>;

// The native build uses the same framed protocol as mmlx-nanodrive.wasm.
export class NanoDriveNativeCodec {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly pending = new Map<number, { resolve: (value: Result) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    private id = 0;
    private stopped = false;
    private stderr = '';

    constructor(executable: string, private readonly onFailure: (error: string) => void = () => {}) {
        this.child = spawn(executable, [], { windowsHide: true, stdio: 'pipe' });
        if (process.platform === 'win32' && this.child.pid !== undefined) {
            try { setPriority(this.child.pid, constants.priority.PRIORITY_HIGH); } catch (error) { console.error(`NanoDrive8 engine priority: ${String(error)}`); }
        }
        const decoder = new EmulationFrameDecoder((kind, bytes) => {
            if (kind === 1) { this.reply(JSON.parse(Buffer.from(bytes).toString('utf8'))); return; }
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const count = view.getUint16(4, true);
            let offset = kind >= 3 ? 11 : 6;
            let keys;
            if (kind >= 5) {
                const length = view.getUint32(11, true);
                if (!length || length > 65536 || 15 + length > bytes.length) { throw new Error('Invalid NanoDrive8 key metadata.'); }
                keys = decodeFmKeyEvents(JSON.parse(Buffer.from(bytes.subarray(15, 15 + length)).toString('utf8')));
                offset = 15 + length;
            }
            this.reply({ id: view.getUint32(0, true), result: { bytes: bytes.subarray(offset), ...(count === 65535 ? {} : { count }),
                ...(keys ? { keys } : {}),
                ...(kind >= 3 ? { position: view.getUint32(6, true), ended: (view.getUint8(10) & 1) !== 0 } : {}),
                ...(kind === 4 || kind === 6 ? { fm: true, synchronize: (view.getUint8(10) & 2) !== 0 } : {}) } });
        }, (kind, length) => (kind === 1 && length > 0 && length <= 65536) || (kind === 2 && length >= 6 && length <= 65536)
            || ((kind === 3 || kind === 4) && length >= 11 && length <= 65536) || ((kind === 5 || kind === 6) && length >= 15 && length <= 131088));
        this.child.stdout.on('data', bytes => {
            if (this.stopped) { return; }
            try { decoder.push(bytes); } catch (error) { this.fail(error); }
        });
        this.child.stderr.on('data', bytes => { this.stderr = (this.stderr + bytes.toString()).slice(-4096); });
        this.child.stdin.on('error', error => this.fail(error));
        this.child.on('error', error => this.fail(error));
        this.child.on('close', code => this.fail(new Error(this.stderr.trim() || `NanoDrive8 native engine exited (${code}).`)));
    }

    request: NanoDriveCodec = params => {
        if (this.stopped) { return Promise.reject(new Error('NanoDrive8 native engine stopped.')); }
        if (this.pending.size >= 256) { return Promise.reject(new Error('NanoDrive8 native engine queue overflow.')); }
        const id = this.id++ >>> 0;
        const command = `${JSON.stringify({ id, params })}\n`;
        if (Buffer.byteLength(command) > 65536) { return Promise.reject(new Error('NanoDrive8 command is too large.')); }
        return new Promise<Result>((resolve, reject) => {
            const timer = setTimeout(() => this.fail(new Error('NanoDrive8 native engine timed out.')), 15000);
            this.pending.set(id, { resolve, reject, timer });
            this.child.stdin.write(command, error => { if (error) { this.fail(error); } });
        });
    };

    private reply(value: { id?: unknown; result?: Result; error?: unknown }): void {
        if (!value || !Number.isInteger(value.id) || !this.pending.has(value.id as number)
            || (typeof value.error !== 'string' && !Object.hasOwn(value, 'result'))) { throw new Error('Invalid NanoDrive8 native reply.'); }
        const pending = this.pending.get(value.id as number)!;
        this.pending.delete(value.id as number); clearTimeout(pending.timer);
        if (typeof value.error === 'string') { pending.reject(new Error(value.error)); }
        else { pending.resolve(value.result!); }
    }

    private fail(error: unknown): void {
        if (this.stopped) { return; }
        const failure = error instanceof Error ? error : new Error(String(error));
        this.stop(failure);
        this.onFailure(failure.message);
    }

    private stop(error: Error): void {
        this.stopped = true;
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
        this.pending.clear();
        this.child.stdin.destroy();
        this.child.kill();
    }

    async dispose(): Promise<void> {
        if (this.child.pid === undefined || this.child.exitCode !== null || this.child.signalCode !== null) { return; }
        const exited = new Promise<void>(resolve => this.child.once('close', () => resolve()));
        this.stop(new Error('NanoDrive8 native engine stopped.'));
        await exited;
    }
}
