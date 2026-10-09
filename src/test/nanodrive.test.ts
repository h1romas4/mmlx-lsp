import * as assert from 'assert';
import { isSupportedNanoDriveFirmware, NanoDriveConnection, type NanoDriveCodec, type NanoDriveInput, type NanoDrivePort } from '../nanodrive';

export class Port implements NanoDrivePort {
    isOpen = true;
    commands: { command: string; requestId: number; payload: number[]; input?: NanoDriveInput; session?: number }[] = [];
    firmware = '1.0b8'; model = 'NanoDrive 8'; ignore = ''; rejected = '';
    drained: string[] = [];
    writes: { command: string; time: number }[] = [];
    audioFault = false;
    ignoreRunningStatus = false;
    private accepted = 0;
    private audioStarted = 0;
    private audioEnd = false;
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
        this.writes.push({ command:request.command, time:performance.now() });
        if (request.command === 'reset') { this.accepted = 0; this.audioStarted = 0; this.audioEnd = false; }
        if (request.command === 'audioStart') { this.audioStarted = performance.now(); return; }
        if (request.command === 'audioData') { this.accepted = request.position; this.audioEnd = request.ended; return; }
        if (request.command === 'audition' || request.command === 'fmBurst' || request.command === 'setClock' || request.command === 'setPlaybackClock' || request.command === this.ignore) { return; }
        if (request.command === 'audioStatus' && this.audioStarted && this.ignoreRunningStatus) { return; }
        const played = this.audioStarted ? Math.min(this.accepted, Math.floor((performance.now() - this.audioStarted) * 7.8125)) : 0;
        const response = request.command === 'audioStatus'
            ? { command: request.command, requestId: request.requestId, status: 0, accepted: this.accepted, played, pending: this.accepted - played,
                running: this.audioStarted !== 0, ended: this.audioEnd && played === this.accepted, fault: this.audioStarted !== 0 && this.audioFault,
                underflows: 0, overflows: 0, rejected: 0 }
            : { ...request, status: request.command === this.rejected ? 1 : 0, model: this.model, firmware: this.firmware };
        const body = Buffer.from(JSON.stringify(response));
        this.chunks.push(Buffer.from('boot log'), Buffer.concat([Buffer.from([0]), body.subarray(0, 5)]), Buffer.concat([body.subarray(5), Buffer.from([0])]));
        this.deliver();
    }
    async drain(): Promise<void> { this.drained.push(this.commands.at(-1)!.command); }
    async close(): Promise<void> { this.isOpen = false; this.reader?.reject(new Error('Port closed')); this.reader = undefined; }
}

export const codec: NanoDriveCodec = async params => {
    if (params.operation === 'encode') { return { bytes: [0, ...Buffer.from(JSON.stringify(params)), 0] }; }
    if (params.operation === 'audition') {
        return { bytes: [0, ...Buffer.from(JSON.stringify({ ...params, command: 'audition', input: params.command })), 0], count: 1 };
    }
    if (params.operation !== 'decode') { throw new Error(`Unsupported mock operation: ${params.operation}`); }
    let reply;
    try { reply = JSON.parse(Buffer.from(params.body).toString()); }
    catch { return null; }
    const request = JSON.parse(Buffer.from(params.request.slice(1, -1)).toString());
    return reply.command === request.command && reply.requestId === request.requestId ? reply : null;
};

suite('NanoDrive8 connection', () => {
    const fmCodec = (): NanoDriveCodec => {
        let index = 0;
        return async params => {
            if (params.operation === 'upload' || params.operation === 'playbackStop') { return null; }
            if (params.operation === 'playbackInfo') { return { audio:false, pdxName:null }; }
            if (params.operation === 'playbackInit') { index=0; return { audio:false }; }
            if (params.operation === 'playbackNext') {
                const step=index++;
                const position=step<2 ? 0 : (step-1)*4410;
                return { bytes:Uint8Array.from([0,...Buffer.from(JSON.stringify({ command:'fmBurst',requestId:params.requestId,payload:[8,step===1?120:0] })),0]),
                    fm:true,count:1,position,synchronize:step===0,ended:step===2 };
            }
            return codec(params);
        };
    };
    test('FM-only sends no AUDIO commands, synchronizes before key-on and preserves note duration', async () => {
        const port=new Port(); const connection=new NanoDriveConnection(fmCodec(),()=>{},async()=>port,100);
        try {
            await connection.connect('test');
            await connection.startPlayback('#pcmfile "unused"\nA c4',false,async()=>{ throw new Error('FM-only must not load PDX'); });
            assert.strictEqual(connection.playbackState.error,''); assert.ok(connection.playbackState.finished);
            assert.ok(port.commands.every(request=>!request.command.startsWith('audio')));
            assert.deepStrictEqual(port.commands.slice(5).map(request=>request.command),['reset','setPlaybackClock','fmBurst','ping','fmBurst','fmBurst','reset']);
            const bursts=port.writes.filter(write=>write.command==='fmBurst');
            assert.ok(bursts[2]!.time-bursts[1]!.time>=90,'Note-off must not be sent ahead of its scheduled time');
            assert.ok(!port.drained.includes('fmBurst')); assert.ok(port.isOpen && connection.state.connected);
            assert.strictEqual(connection.playbackState.position,0.1);
        } finally { await connection.disconnect(); }
    });
    test('FM-only Stop cancels a future burst and releases keyboard lock', async () => {
        const port=new Port(); const connection=new NanoDriveConnection(fmCodec(),()=>{},async()=>port,100);
        try {
            await connection.connect('test');
            const playing=connection.startPlayback('A c4',false,async()=>new Uint8Array(0));
            for(let count=0;count<100 && port.commands.filter(request=>request.command==='fmBurst').length<2;count++) { await new Promise(resolve=>setTimeout(resolve,2)); }
            assert.strictEqual(port.commands.filter(request=>request.command==='fmBurst').length,2);
            await connection.connectOutput(null); assert.ok(!connection.outputState.connected);
            await connection.stopPlayback(); await playing;
            assert.strictEqual(port.commands.filter(request=>request.command==='fmBurst').length,2);
            assert.strictEqual(port.commands.at(-1)!.command,'reset'); assert.ok(!connection.playbackState.busy && port.isOpen);
            await connection.connectOutput(null); assert.ok(connection.outputState.connected);
        } finally { await connection.disconnect(); }
    });
    const playbackCodec = (): NanoDriveCodec => {
        let position = 0; let looped = false;
        return async params => {
            if (params.operation === 'upload' || params.operation === 'playbackStop') { return null; }
            if (params.operation === 'playbackInfo') { return { pdxName: undefined }; }
            if (params.operation === 'playbackInit') { position = 0; looped = params.looped; return { audio: true }; }
            if (params.operation === 'playbackNext') {
                position += 160; const ended = !looped && position >= 800;
                const bytes = Uint8Array.from([0, ...Buffer.from(JSON.stringify({ command: 'audioData', requestId: params.requestId, position, ended })), 0]);
                return { bytes, position, count: 1, ended };
            }
            return codec(params);
        };
    };
    const waitForStart = async (port: Port) => {
        for (let count = 0; count < 100 && !port.commands.some(command => command.command === 'audioStart'); count++) { await new Promise(resolve => setTimeout(resolve, 2)); }
        assert.ok(port.commands.some(command => command.command === 'audioStart'));
    };
    test('playback disconnects keyboard, preloads before START, streams without drain and confirms END before RESET', async () => {
        const port = new Port();
        const connection = new NanoDriveConnection(playbackCodec(), () => {}, async () => port, 100);
        try {
            await connection.connect('test'); await connection.connectOutput(null);
            await connection.startPlayback('A c4', false, async () => { throw new Error('Unexpected PDX'); });
            assert.ok(connection.playbackState.finished); assert.ok(!connection.playbackState.busy); assert.strictEqual(connection.playbackState.error, '');
            assert.ok(!connection.outputState.connected); assert.ok(connection.state.connected && port.isOpen);
            const commands = port.commands.map(request => request.command);
            const start = commands.indexOf('audioStart');
            assert.deepStrictEqual(commands.slice(start - 5, start), ['audioData', 'audioData', 'audioData', 'audioData', 'ping']);
            assert.ok(commands.indexOf('setPlaybackClock') < start); assert.strictEqual(commands.at(-1), 'reset');
            assert.ok(!port.drained.includes('audioData') && !port.drained.includes('audioStatus'));
        } finally { await connection.disconnect(); }
    });
    test('playback locks keyboard and Stop cancels future chunks without closing Settings connection', async () => {
        const port = new Port(); const connection = new NanoDriveConnection(playbackCodec(), () => {}, async () => port, 100);
        try {
            await connection.connect('test');
            const playing = connection.startPlayback('A L c4', true, async () => new Uint8Array(0));
            await waitForStart(port); const before = port.commands.length;
            await connection.connectOutput(null); assert.strictEqual(port.commands.length, before);
            await connection.stopPlayback(); await playing;
            assert.strictEqual(port.commands.at(-1)!.command, 'reset'); assert.ok(!connection.playbackState.busy && port.isOpen);
            await connection.connectOutput(null); assert.ok(connection.outputState.connected);
        } finally { await connection.disconnect(); }
    });
    test('playback fault resets both chips and releases output lock', async () => {
        const port = new Port(); port.audioFault = true;
        const connection = new NanoDriveConnection(playbackCodec(), () => {}, async () => port, 100);
        try {
            await connection.connect('test'); await connection.startPlayback('A c4', true, async () => new Uint8Array(0));
            assert.match(connection.playbackState.error, /fault/); assert.ok(!connection.playbackState.busy);
            assert.strictEqual(port.commands.at(-1)!.command, 'reset'); assert.ok(port.isOpen);
        } finally { await connection.disconnect(); }
    });
    test('playback supplies DATA during a pending STATUS but aborts when START is not confirmed', async () => {
        const port = new Port(); port.ignoreRunningStatus = true;
        const connection = new NanoDriveConnection(playbackCodec(), () => {}, async () => port, 500);
        try {
            await connection.connect('test'); await connection.startPlayback('A c4', true, async () => new Uint8Array(0));
            assert.match(connection.playbackState.error, /timed out/);
            const start = port.commands.findIndex(command => command.command === 'audioStart');
            assert.ok(port.commands.slice(start + 1).some(command => command.command === 'audioData'));
            assert.strictEqual(port.commands.at(-1)!.command, 'reset'); assert.ok(!connection.playbackState.busy);
        } finally { await connection.disconnect(); }
    });
    test('keyboard requires Settings, initializes before notes and stops without closing serial', async () => {
        const port = new Port();
        const connection = new NanoDriveConnection(codec, () => {}, async () => port, 100);
        await connection.connectOutput(null);
        assert.ok(!connection.outputState.connected); assert.match(connection.outputState.error, /Settings/);
        assert.strictEqual(port.commands.length, 0);
        await connection.connect('test'); await connection.connectOutput(null);
        assert.ok(connection.outputState.connected);
        assert.deepStrictEqual(port.commands.slice(5).map(request => request.command), ['audition', 'ping']);
        assert.strictEqual(port.commands[5].input?.type, 'init');
        const note = { type: 'noteOn' as const, source: 0, channel: 0, note: 69, velocity: 100 };
        connection.note(note); connection.note({ ...note, type: 'noteOff' });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepStrictEqual(port.commands.slice(7).map(request => request.input?.type), ['noteOn', 'noteOff']);
        await connection.disconnectOutput();
        assert.deepStrictEqual(port.commands.slice(-2).map(request => request.command), ['audition', 'ping']);
        assert.strictEqual(port.commands.at(-2)?.input?.type, 'stop');
        assert.ok(connection.state.connected && port.isOpen && !connection.outputState.connected);
        const length = port.commands.length;
        connection.note(note); await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(port.commands.length, length);
        await connection.connectOutput(null);
        assert.notStrictEqual(port.commands.at(-2)?.session, port.commands[5].session);
        await connection.disconnect(); assert.ok(!connection.outputState.connected && !port.isOpen);
    });

    test('canceling delayed keyboard initialization cannot enable or send stale notes', async () => {
        const port = new Port(); let resolve!: () => void; let started!: () => void;
        const delayed = new Promise<void>(res => { resolve = res; });
        const entered = new Promise<void>(res => { started = res; });
        const connection = new NanoDriveConnection(async params => {
            if (params.operation === 'audition' && params.command.type === 'init') { started(); await delayed; }
            return codec(params);
        }, () => {}, async () => port, 100);
        await connection.connect('test');
        const output = connection.connectOutput(null); await entered;
        await connection.disconnect(); resolve(); await output;
        assert.ok(!connection.outputState.connected && !port.isOpen);
        assert.ok(!port.commands.some(request => request.command === 'audition'));
    });

    test('immediate keyboard cancellation leaves Settings connected without initialization', async () => {
        const port = new Port();
        const connection = new NanoDriveConnection(codec, () => {}, async () => port, 100);
        await connection.connect('test');
        const output = connection.connectOutput(null);
        await connection.disconnectOutput(); await output;
        assert.ok(connection.state.connected && port.isOpen && !connection.outputState.connected);
        assert.ok(!port.commands.some(request => request.command === 'audition'));
        await connection.disconnect();
    });

    test('keyboard write failure releases the port and clears output state', async () => {
        const port = new Port();
        const connection = new NanoDriveConnection(codec, () => {}, async () => port, 100);
        await connection.connect('test'); await connection.connectOutput(null);
        const write = port.write.bind(port);
        let closed!: () => void; const closing = new Promise<void>(resolve => { closed = resolve; });
        const close = port.close.bind(port); port.close = async () => { await close(); closed(); };
        port.write = async buffer => {
            const command = JSON.parse(buffer.subarray(1, buffer.length - 1).toString());
            if (command.command === 'audition') { throw new Error('Write failed'); }
            await write(buffer);
        };
        connection.note({ type: 'noteOn', source: 0, channel: 0, note: 69, velocity: 100 }); await closing;
        await connection.disconnect();
        assert.ok(!connection.state.connected && !connection.outputState.connected && !port.isOpen);
        assert.match(connection.state.error, /Write failed/);
    });

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