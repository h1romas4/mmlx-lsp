import * as assert from 'node:assert';
import { join, resolve } from 'node:path';
import { NanoDriveProcess } from '../nanodriveProcess';
import { NanoDriveNativeCodec } from '../nanodriveNativeCodec';

const root = resolve(__dirname, '../..');
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
    for (let count = 0; count < 400; count++) { if (check()) { return; } await delay(10); }
    assert.fail('State transition timed out');
}
function simulated(diagnostics: string[] = []): NanoDriveProcess {
    return new NanoDriveProcess(root, () => {}, undefined, undefined, message => diagnostics.push(message), undefined, undefined,
        join(root, 'tools', 'nanodrive-process-test-host.cjs'));
}

suite('NanoDrive8 dedicated process', () => {
    suiteSetup(function () { if (process.platform !== 'win32') { this.skip(); } });
    test('continues clocked PCM supply while the parent event loop is blocked for 1.5 seconds', async function () {
        this.timeout(12000);
        const diagnostics: string[] = [];
        const player = simulated(diagnostics);
        try {
            await player.connect('simulator');
            assert.ok(player.state.connected);
            const playing = player.startPlayback('P c1', false, async () => { throw new Error('No PDX expected'); });
            await until(() => player.playbackState.playing);
            // This reproduces an unresponsive extension host without stopping the child.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
            await playing;
            assert.ok(player.playbackState.finished);
            assert.strictEqual(player.playbackState.error, '');
            assert.ok(diagnostics.every(message => !message.includes('playback failed')));
            await player.disconnect(); assert.ok(!player.state.connected);
            await player.connect('simulator'); assert.ok(player.state.connected);
        } finally { await player.dispose(); }
    });

    test('transfers PDX bytes before playback and cancels a stalled asset loader on stop', async function () {
        this.timeout(10000);
        const player = simulated();
        try {
            await player.connect('simulator');
            let requested = '';
            const playing = player.startPlayback('needs-pdx', true, async name => { requested = name; return Uint8Array.of(77, 0, 255); }, { adpcmMode: 'lpf' });
            await until(() => player.playbackState.playing);
            assert.strictEqual(requested, 'drums');
            await player.setMuted(1); await player.setVolume(.5);
            await player.stopPlayback(); await playing;
            assert.strictEqual(player.playbackState.error, '');
            let loading = false;
            const canceled = player.startPlayback('needs-pdx', false, async () => { loading = true; return new Promise<Uint8Array>(() => {}); });
            await until(() => loading);
            await player.stopPlayback(); await canceled;
            assert.ok(!player.playbackState.busy);
        } finally { await player.dispose(); }
    });

    test('child loss rejects active playback and clears connection and playback state', async function () {
        this.timeout(10000);
        const player = simulated();
        try {
            await player.connect('simulator');
            const playing = player.startPlayback('P c1', true, async () => new Uint8Array(0));
            const rejected = assert.rejects(playing, /process exited/);
            await until(() => player.playbackState.playing);
            Reflect.get(player, 'child').kill();
            await rejected;
            assert.ok(!player.state.connected && !player.playbackState.busy);
        } finally { await player.dispose(); }
    });

    test('native engine generates binary ADPCM chunks, filters mute and recovers from an operation error', async function () {
        this.timeout(10000);
        const engine = new NanoDriveNativeCodec(join(root, 'dist', 'native', `mmlx-nanodrive${process.platform === 'win32' ? '.exe' : ''}`));
        try {
            await assert.rejects(engine.request({ operation: 'playbackNext', requestId: 0 }), /not initialized/);
            const source = new TextEncoder().encode('#pcmfile "drums"\nP o1 c4\n');
            const pdx = Buffer.alloc(768 + 2048); pdx.writeUInt32BE(768, 9 * 8); pdx.writeUInt32BE(2048, 9 * 8 + 4); pdx.fill(0x77, 768);
            await engine.request({ operation: 'upload', asset: 'source', offset: 0, bytes: Array.from(source) });
            assert.deepStrictEqual(await engine.request({ operation: 'playbackInfo' }), { audio: true, pdxName: 'drums' });
            await engine.request({ operation: 'upload', asset: 'pdx', offset: 0, bytes: Array.from(pdx) });
            await engine.request({ operation: 'playbackInit', looped: false, adpcmMode: 'resample' });
            let position = 0; let ended = false;
            for (let i = 0; i < 200 && !ended; i++) {
                const chunk = await engine.request({ operation: 'playbackNext', requestId: i * 128 & 65535 });
                assert.ok(chunk && 'bytes' in chunk && chunk.bytes instanceof Uint8Array);
                assert.ok(chunk.position! > position && chunk.position! - position <= 160);
                position = chunk.position!; ended = chunk.ended!;
                const filtered = await engine.request({ operation: 'playbackFilter', bytes: Array.from(chunk.bytes) });
                assert.ok(filtered && 'bytes' in filtered && filtered.bytes instanceof Uint8Array);
                if (i === 0) { await engine.request({ operation: 'playbackMute', muted: 256, position, requestId: 1 }); }
            }
            assert.ok(ended && position > 160);
            await engine.request({ operation: 'playbackStop' });
        } finally { await engine.dispose(); }
    });
    test('a missing native executable rejects requests and releases shutdown promptly', async function () {
        this.timeout(5000);
        const engine = new NanoDriveNativeCodec(join(root, 'dist', 'native', 'nonexistent-nanodrive-engine.exe'));
        try { await assert.rejects(engine.request({ operation: 'playbackInfo' }), /ENOENT|EPIPE|spawn/); }
        finally { await engine.dispose(); }
    });

});
