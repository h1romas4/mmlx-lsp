import { parentPort, workerData } from 'node:worker_threads';
import { NanoDriveRuntime, runNanoDriveEngine } from './nanodriveRuntime';
import { NanoDriveConnection } from './nanodrive';
import type { NanoDriveThreadEvent, NanoDriveThreadRequest } from './nanodriveThreadClient';

export function runNanoDriveService(connection: NanoDriveConnection, send: (event: NanoDriveThreadEvent) => void): void {
	const port = parentPort!;
	const assets = new Map<number, { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }>();
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
} else if (parentPort && workerData?.wasmPath) {
	const send = (event: NanoDriveThreadEvent) => parentPort!.postMessage(event);
	const runtime = new NanoDriveRuntime(__filename, workerData.wasmPath, error => { void connection.disconnect(error.message); });
	const connection = new NanoDriveConnection(runtime.request, state => send({ type: 'state', state }), undefined, undefined,
		state => send({ type: 'output', state }), state => send({ type: 'playback', state }), message => send({ type: 'diagnostic', message }),
		(playing, error) => send({ type: 'voiceTest', playing, error }), keys => send({ type: 'keys', keys }));
	runNanoDriveService(connection, send);
}