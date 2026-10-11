// Use the existing clocked device simulator in a separate OS process.
global.suite = () => {};
process.argv[2] = '--nanodrive-simulator';
const { Port, codec } = require('../out/test/nanodrive.test');
const { runNanoDriveService } = require('../out/nanodriveThread');
const { NanoDriveConnection } = require('../out/nanodrive');
let position = 0;
let looped = false;
let needsPdx = false;
const port = new Port();
port.detectUnderflow = true;
const engine = async params => {
    if (params.operation === 'upload') {
        if (params.asset === 'source') { needsPdx = Buffer.from(params.bytes).toString().includes('needs-pdx'); }
        if (params.asset === 'pdx' && params.bytes.length && !Buffer.from(params.bytes).equals(Buffer.from([77, 0, 255]))) {
            throw new Error('PDX bytes changed in IPC');
        }
        return null;
    }
    if (params.operation === 'playbackStop') { return null; }
    if (params.operation === 'playbackInfo') { return { audio: true, pdxName: needsPdx ? 'drums' : null }; }
    if (params.operation === 'playbackInit') { position = 0; looped = params.looped; return { audio: true }; }
    if (params.operation === 'playbackNext') {
        position += 160;
        const ended = !looped && position >= 24000;
        return { bytes: Uint8Array.from([0, ...Buffer.from(JSON.stringify({ command: 'audioData', requestId: params.requestId, position, ended })), 0]),
            position, count: 1, ended };
    }
    return codec(params);
};
const send = message => { if (process.connected) { process.send(message); } };
const connection = new NanoDriveConnection(engine, state => send({ type: 'state', state }),
    async () => { port.isOpen = true; return port; }, undefined,
    state => send({ type: 'output', state }), state => send({ type: 'playback', state }),
    message => send({ type: 'diagnostic', message }));
runNanoDriveService(connection, send);
send({ type: 'diagnostic', message: `Simulator backend: ${process.argv[4] === '--native' ? 'native' : 'wasm'}` });
process.once('disconnect', () => { void connection.disconnect().finally(() => process.exit(0)); });
