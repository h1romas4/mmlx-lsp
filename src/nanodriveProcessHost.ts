import { constants, getPriority, setPriority } from 'node:os';
import { NanoDriveConnection, openNanoDrivePort, type NanoDriveCodec, type NanoDrivePort, type NanoDriveAdpcmMode } from './nanodrive';
import { NanoDriveNativeCodec } from './nanodriveNativeCodec';
import type { HostMessage, ClientMessage, NanoDriveProcessCommand } from './nanodriveProcessProtocol';

// No codec request or serial write crosses the extension-host IPC channel.
export function startNanoDriveHost(codec: NanoDriveCodec, disposeCodec: () => Promise<void>,
    openPort: (path: string) => Promise<NanoDrivePort> = openNanoDrivePort): NanoDriveConnection {
    // Raise only the dedicated process priority; leave VS Code unchanged.
    if (process.platform === 'win32') {
        try { setPriority(constants.priority.PRIORITY_HIGH); } catch (error) { console.error(`NanoDrive8 process priority: ${String(error)}`); }
    }
    let closing: Promise<void> | undefined;
    const assets = new Map<number, { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }>();
    const send = (message: ClientMessage) => {
        if (process.connected) { process.send!(message, error => { if (error) { void shutdown(); } }); }
    };
    const connection = new NanoDriveConnection(codec, state => send({ type: 'state', state }), openPort, undefined,
        state => send({ type: 'output', state }), state => send({ type: 'playback', state }),
        message => send({ type: 'diagnostic', message }), (playing, error) => send({ type: 'voiceTest', playing, error }),
        keys => send({ type: 'keys', keys }));
    const cancelAssets = () => {
        for (const asset of assets.values()) { asset.reject(new Error('NanoDrive8 playback canceled.')); }
        assets.clear();
    };
    const shutdown = (): Promise<void> => closing ??= (async () => {
        cancelAssets();
        await connection.disconnect().catch(() => undefined);
        await disposeCodec().catch(() => undefined);
        if (process.connected) { process.disconnect!(); }
    })();
    const methods = new Set<NanoDriveProcessCommand>(['connect', 'disconnect', 'setMuted', 'setVolume', 'startVoiceTest', 'stopVoiceTest',
        'startPlayback', 'stopPlayback', 'resetOutput', 'connectOutput', 'disconnectOutput', 'setVoice', 'note', 'dispose']);
    process.on('message', (message: HostMessage) => {
        if (message.type === 'pdx') {
            const asset = assets.get(message.id);
            if (!asset) { return; }
            assets.delete(message.id);
            if (message.error !== undefined) { asset.reject(new Error(message.error)); }
            else if (message.bytes instanceof Uint8Array) { asset.resolve(message.bytes); }
            else { asset.reject(new Error('Invalid NanoDrive8 PDX transfer.')); }
            return;
        }
        if (message.type !== 'call' || !Number.isSafeInteger(message.id) || !methods.has(message.method) || !Array.isArray(message.args)) { return; }
        void (async () => {
            if (message.method === 'dispose') { await shutdown(); return; }
            if (closing) { throw new Error('NanoDrive8 playback process stopped.'); }
            if (message.method === 'stopPlayback' || message.method === 'disconnect') { cancelAssets(); }
            if (message.method === 'startPlayback') {
                const [source, looped, options] = message.args as [string, boolean, { adpcmMode?: NanoDriveAdpcmMode; pdxConfigured?: boolean }];
                await connection.startPlayback(source, looped, name => new Promise<Uint8Array>((resolve, reject) => {
                    assets.set(message.id, { resolve, reject }); send({ type: 'loadPdx', id: message.id, name });
                }), options);
            } else {
                const method = connection[message.method] as (...args: unknown[]) => unknown;
                await method.apply(connection, message.args);
            }
            send({ type: 'reply', id: message.id });
        })().catch(error => send({ type: 'reply', id: message.id, error: error instanceof Error ? error.message : String(error) }));
    });
    process.once('disconnect', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });
    process.once('SIGINT', () => { void shutdown(); });
    send({ type: 'diagnostic', message: `NanoDrive8 playback process started (pid=${process.pid}, engine=native, transport=isolated, priority=${getPriority()}).` });
    return connection;
}

if (require.main === module) {
    let connection: NanoDriveConnection | undefined;
    const engine = new NanoDriveNativeCodec(process.argv[2], error => {
        console.error(error);
        void connection?.disconnect(error, false).finally(() => {
            process.exitCode = 1;
            if (process.connected) { process.disconnect!(); }
        });
    });
    connection = startNanoDriveHost(engine.request, () => engine.dispose());
}
