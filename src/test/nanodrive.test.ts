import * as assert from 'assert';
import { isSupportedNanoDriveFirmware, NanoDriveConnection, type NanoDriveCodec, type NanoDrivePort } from '../nanodrive';

export class Port implements NanoDrivePort {
    isOpen = true;
    commands: { command: string; requestId: number; payload: number[] }[] = [];
    firmware = '1.0b8'; model = 'NanoDrive 8'; ignore = ''; rejected = '';
    private chunks: Buffer[] = [];
    private reader?: { buffer: Buffer; resolve: (result: { buffer: Buffer; bytesRead: number }) => void; reject: (error: Error) => void };
    read(buffer: Buffer): Promise<{ buffer: Buffer; bytesRead: number }> {
        return new Promise((resolve, reject) => { this.reader = { buffer, resolve, reject }; this.deliver(); });
    }
    private deliver(): void {
        if (!this.reader || !this.chunks.length) { return; }
        const reader = this.reader; this.reader = undefined;
        const bytes = this.chunks.shift()!; bytes.copy(reader.buffer); reader.resolve({ buffer: reader.buffer, bytesRead: bytes.length });
    }
    async write(buffer: Buffer): Promise<void> {
        const request = JSON.parse(buffer.subarray(1, buffer.length - 1).toString());
        this.commands.push(request);
        if (request.command === 'setClock' || request.command === this.ignore) { return; }
        const response = { ...request, status: request.command === this.rejected ? 1 : 0, model: this.model, firmware: this.firmware };
        const body = Buffer.from(JSON.stringify(response));
        this.chunks.push(Buffer.from('boot log'), Buffer.concat([Buffer.from([0]), body.subarray(0, 5)]), Buffer.concat([body.subarray(5), Buffer.from([0])]));
        this.deliver();
    }
    async drain(): Promise<void> {}
    async close(): Promise<void> { this.isOpen = false; this.reader?.reject(new Error('Port closed')); this.reader = undefined; }
}

export const codec: NanoDriveCodec = async params => {
    if (params.operation === 'encode') { return { bytes: [0, ...Buffer.from(JSON.stringify(params)), 0] }; }
    let reply;
    try { reply = JSON.parse(Buffer.from(params.body).toString()); }
    catch { return null; }
    const request = JSON.parse(Buffer.from(params.request.slice(1, -1)).toString());
    return reply.command === request.command && reply.requestId === request.requestId ? reply : null;
};

suite('NanoDrive8 connection', () => {
    test('firmware checks major/minor, not beta suffix or prefix lookalikes', () => {
        for (const value of ['1.0', '1.0b8', '1.0b9', '1.0-beta', '1.0.1']) { assert.ok(isSupportedNanoDriveFirmware(value)); }
        for (const value of ['1.01', '1.1', '2.0', '11.0', 'v1.0', '']) { assert.ok(!isSupportedNanoDriveFirmware(value)); }
    });
    test('opens, probes, validates identity, resets, sets clock and synchronizes before ready', async () => {
        const port = new Port();
        const connection = new NanoDriveConnection(codec, () => {}, async () => port, 100);
        await connection.connect('test');
        assert.ok(connection.state.connected);
        assert.strictEqual(connection.state.firmware, '1.0b8');
        assert.deepStrictEqual(port.commands.map(request => request.command), ['ping', 'getInfo', 'reset', 'setClock', 'ping']);
        await connection.disconnect();
        assert.strictEqual(port.commands.at(-1)?.command, 'reset'); assert.ok(!port.isOpen);
        assert.ok(!connection.state.connected); assert.strictEqual(connection.state.error, '');
    });
    test('wrong models and firmware close without sending RESET or clock', async () => {
        for (const [model, firmware] of [['Other', '1.0b8'], ['NanoDrive 8', '1.1b1']]) {
            const port = new Port(); port.model = model; port.firmware = firmware;
            const connection = new NanoDriveConnection(codec, () => {}, async () => port, 100);
            await connection.connect('test');
            assert.ok(!connection.state.connected); assert.ok(connection.state.error);
            assert.ok(!port.isOpen); assert.deepStrictEqual(port.commands.map(request => request.command), ['ping', 'getInfo']);
        }
    });
    test('PING retries use new IDs; RESET timeout is not retried', async () => {
        for (const ignored of ['ping', 'reset']) {
            const port = new Port(); port.ignore = ignored;
            const connection = new NanoDriveConnection(codec, () => {}, async () => port, 15);
            await connection.connect('test');
            assert.ok(!port.isOpen); assert.match(connection.state.error, /timed out/);
            assert.strictEqual(port.commands.filter(request => request.command === ignored).length, ignored === 'ping' ? 3 : 1);
            assert.strictEqual(new Set(port.commands.map(request => request.requestId)).size, port.commands.length);
        }
    });
    test('rejects commands, cancels an in-flight request and closes a late open', async () => {
        const port = new Port(); port.rejected = 'reset';
        const connection = new NanoDriveConnection(codec, () => {}, async () => port, 100);
        await connection.connect('test'); assert.match(connection.state.error, /rejected reset/); assert.ok(!port.isOpen);
        const delayedPort = new Port();
        let opened!: (port: NanoDrivePort) => void;
        let started!: () => void;
        const startedPromise = new Promise<void>(resolve => { started = resolve; });
        const delayed = new NanoDriveConnection(codec, () => {}, () => { started(); return new Promise(resolve => { opened = resolve; }); }, 100);
        const connecting = delayed.connect('test'); await startedPromise;
        const closing = delayed.disconnect(); opened(delayedPort);
        await Promise.all([connecting, closing]);
        assert.ok(!delayedPort.isOpen); assert.deepStrictEqual(delayedPort.commands, []);
    });

    test('repeated connect clicks open once and canceled PING is not retried', async () => {
        const port = new Port(); port.ignore = 'ping';
        let opens = 0; let sent!: () => void;
        const sentPromise = new Promise<void>(resolve => { sent = resolve; });
        const write = port.write.bind(port);
        port.write = async buffer => { await write(buffer); sent(); };
        const connection = new NanoDriveConnection(codec, () => {}, async () => { opens++; return port; }, 100);
        const first = connection.connect('test'); const duplicate = connection.connect('test');
        await sentPromise; await connection.disconnect(); await Promise.all([first, duplicate]);
        assert.strictEqual(opens, 1); assert.ok(!port.isOpen);
        assert.deepStrictEqual(port.commands.map(request => request.command), ['ping']);
        assert.ok(!connection.state.connected && !connection.state.connecting && !connection.state.closing);
    });

    test('disconnect closes even when final RESET has no response', async () => {
        const port = new Port();
        const connection = new NanoDriveConnection(codec, () => {}, async () => port, 15);
        await connection.connect('test'); assert.ok(connection.state.connected);
        port.ignore = 'reset'; await connection.disconnect();
        assert.ok(!port.isOpen); assert.match(connection.state.error, /RESET not confirmed/);
        assert.strictEqual(port.commands.filter(request => request.command === 'reset').length, 2);
    });
});