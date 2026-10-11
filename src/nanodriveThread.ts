import { parentPort, workerData } from 'node:worker_threads';
import { NanoDriveRuntime, runNanoDriveEngine } from './nanodriveRuntime';
import { NanoDriveNativeCodec } from './nanodriveNativeCodec';
import { NanoDriveConnection } from './nanodrive';
import type { NanoDriveThreadEvent, NanoDriveThreadRequest } from './nanodriveThreadClient';

export function runNanoDriveService(connection: NanoDriveConnection, send: (event: NanoDriveThreadEvent) => void): void {
	const port = parentPort ?? process;
	const assets = new Map<number, { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }>();
	const cancelAssets = () => {
		for (const asset of assets.values()) { asset.reject(new Error('NanoDrive8 playback canceled.')); }
		assets.clear();
	};
	port.once('disconnect', cancelAssets);
	port.on('message', (message: NanoDriveThreadRequest | { asset: number; bytes?: Uint8Array; error?: string }) => {
		if ('asset' in message) {
			const pending = assets.get(message.asset);
			assets.delete(message.asset);
			if (message.error) { pending?.reject(new Error(message.error)); }
			else if (message.bytes instanceof Uint8Array) { pending?.resolve(message.bytes); }
			else { pending?.reject(new Error('Invalid NanoDrive8 PDX response.')); }
			return;
		}
		void (async () => {
			try {
				if (message.method === 'stopPlayback' || message.method === 'disconnect') { cancelAssets(); }
				if (message.method === 'startPlayback') {
					const [source, looped, options] = message.args as [string, boolean, Parameters<NanoDriveConnection['startPlayback']>[3]];
					await connection.startPlayback(source, looped, name => new Promise((resolve, reject) => {
						assets.set(message.id, { resolve, reject }); send({ type: 'asset', id: message.id, name });
					}), options);
				} else {
					const methods = ['connect', 'disconnect', 'connectOutput', 'disconnectOutput', 'resetOutput', 'setVoice', 'note',
						'setMuted', 'setVolume', 'stopPlayback', 'startVoiceTest', 'stopVoiceTest'];
					if (!methods.includes(message.method)) { throw new Error('Invalid NanoDrive8 worker operation.'); }
					const action = connection[message.method] as (...args: unknown[]) => unknown;
					await action.apply(connection, message.args);
				}
				send({ type: 'reply', id: message.id });
			} catch (error) { send({ type: 'reply', id: message.id, error: error instanceof Error ? error.message : String(error) }); }
		})();
	});
}

if (workerData?.engine && parentPort) {
	void runNanoDriveEngine(workerData.wasmPath, parentPort, workerData.signal);
} else if (process.send && process.argv[2] === '--nanodrive-service' && process.argv[3]) {
	const send = (event: NanoDriveThreadEvent) => {
		if (process.connected) { process.send!(event, error => { if (error) { process.exit(1); } }); }
	};
	const native = process.argv[4] === '--native' ? process.argv[5] : undefined;
	const runtime = native
		? new NanoDriveNativeCodec(native, error => { void connection.disconnect(error); }, message => send({ type: 'diagnostic', message }))
		: new NanoDriveRuntime(__filename, process.argv[3], error => { void connection.disconnect(error.message); });
	const transport = new NanoDriveRuntime(__filename, process.argv[3], error => { void connection.disconnect(error.message); });
	const diagnostics = () => ({ backend: native ? 'windows-native' : 'wasm', generation: runtime.diagnostics, transport: transport.diagnostics });
	send({ type: 'diagnostic', message: `NanoDrive8 backend: ${native ? 'windows-native' : 'wasm'}` });
	let playing = false;
	const logTiming = () => send({ type: 'diagnostic', message: `NanoDrive8 engine timing: ${JSON.stringify(diagnostics())}` });
	const connection = new NanoDriveConnection(params =>
		(params.operation === 'encode' || params.operation === 'decode' ? transport : runtime).request(params),
		state => send({ type: 'state', state }), undefined, undefined,
		state => send({ type: 'output', state }), state => {
			send({ type: 'playback', state });
			if (playing && !state.playing) { logTiming(); }
			playing = state.playing;
		}, message => {
			send({ type: 'diagnostic', message });
			logTiming();
		},
		(playing, error) => send({ type: 'voiceTest', playing, error }), keys => send({ type: 'keys', keys }));
	const timer = setInterval(() => {
		if (connection.playbackState.playing) { logTiming(); }
	}, 5000);
	timer.unref();
	runNanoDriveService(connection, send);
	process.once('disconnect', () => {
		clearInterval(timer);
		void connection.disconnect().finally(() => Promise.all([runtime.dispose(), transport.dispose()])).finally(() => process.exit(0));
	});
}