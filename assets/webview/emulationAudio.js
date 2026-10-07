export function createEmulationAudio(onRequest, onFailure, onEnded = () => {}) {
	let context;
	let node;
	let gain;
	let volume = 1;
	let paused = false;
	let generation = 0;
	function disconnect() {
		generation++;
		const previous = context;
		context = undefined;
		gain = undefined; paused = false;
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
				else if (node === worklet && event.data?.type === 'ended') { onEnded(); }
			};
			worklet.onprocessorerror = () => { if (node === worklet) { onFailure('Audio processor failed.'); } };
			audio.onstatechange = () => { if (context === audio && audio.state !== 'running' && !(paused && audio.state === 'suspended')) { onFailure('Audio output was suspended.'); } };
			gain = audio.createGain(); gain.gain.value = volume;
			worklet.connect(gain); gain.connect(audio.destination);
			return audio.sampleRate;
		},
		start() { node?.port.postMessage({ type: 'start' }); },
		finish() { node?.port.postMessage({ type: 'finish' }); },
		async pause() { paused = true; await context?.suspend(); },
		async resume() { paused = false; await context?.resume(); },
		setVolume(value) { volume = Math.max(0, Math.min(1, value)); if (gain) { gain.gain.setTargetAtTime(volume, context.currentTime, 0.015); } },
		pcm(pcm) { if (node && pcm instanceof ArrayBuffer) { node.port.postMessage({ type: 'pcm', pcm }, [pcm]); } },
		disconnect
	};
}