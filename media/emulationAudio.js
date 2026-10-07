export function createEmulationAudio(onRequest, onFailure) {
	let context;
	let node;
	let generation = 0;
	function disconnect() {
		generation++;
		const previous = context;
		context = undefined;
		node?.disconnect(); node = undefined;
		if (previous) { previous.onstatechange = null; void previous.close().catch(() => {}); }
	}
	return {
		async connect() {
			disconnect();
			const current = generation;
			const audio = new AudioContext({ latencyHint: 'interactive' });
			context = audio;
			await audio.resume();
			await audio.audioWorklet.addModule(new URL('./emulationWorklet.js', import.meta.url));
			if (current !== generation) { throw new Error('Audio connection canceled.'); }
			if (audio.state !== 'running') { throw new Error('Audio output is suspended.'); }
			const worklet = new AudioWorkletNode(audio, 'mmlx-emulation', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
			node = worklet;
			worklet.port.onmessage = event => {
				if (node === worklet && event.data?.type === 'request') { onRequest(event.data.blocks); }
			};
			worklet.onprocessorerror = () => { if (node === worklet) { onFailure('Audio processor failed.'); } };
			audio.onstatechange = () => { if (context === audio && audio.state !== 'running') { onFailure('Audio output was suspended.'); } };
			worklet.connect(audio.destination);
			return audio.sampleRate;
		},
		start() { node?.port.postMessage({ type: 'start' }); },
		pcm(pcm) { if (node && pcm instanceof ArrayBuffer) { node.port.postMessage({ type: 'pcm', pcm }, [pcm]); } },
		disconnect
	};
}