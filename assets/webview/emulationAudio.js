export function createEmulationAudio(onRequest, onFailure, onEnded = () => {}, onPosition = () => {}) {
	let context;
	let node;
	let gain;
	let analysis;
	let volume = 1;
	let paused = false;
	let generation = 0;
	let worker;
	let workerUrl;
	let workerTimer;
	function disconnect() {
		generation++;
		worker?.terminate(); worker = undefined;
		clearTimeout(workerTimer);
		if (workerUrl) { URL.revokeObjectURL(workerUrl); workerUrl = undefined; }
		const previous = context;
		context = undefined;
		analysis?.scope.disconnect(); analysis?.spectrum.disconnect(); analysis = undefined;
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
			if (audio.state === 'suspended' && !navigator.userActivation.hasBeenActive) {
				disconnect();
				throw new Error('Audio output requires a click in the mmlx panel.');
			}
			await audio.resume();
			await audio.audioWorklet.addModule(new URL('./emulationWorklet.js', import.meta.url));
			if (current !== generation) { throw new Error('Audio connection canceled.'); }
			if (audio.state !== 'running') { throw new Error('Audio output is suspended.'); }
			const worklet = new AudioWorkletNode(audio, 'mmlx-emulation', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
			node = worklet;
			worklet.port.onmessage = event => {
				if (node === worklet && event.data?.type === 'request') { onRequest(event.data.blocks); }
				else if (node === worklet && event.data?.type === 'ended') { onEnded(); }
				else if (node === worklet && event.data?.type === 'position') { onPosition(event.data.position); }
			};
			worklet.onprocessorerror = () => { if (node === worklet) { onFailure('Audio processor failed.'); } };
			audio.onstatechange = () => { if (context === audio && audio.state !== 'running' && !(paused && audio.state === 'suspended')) { onFailure('Audio output was suspended.'); } };
			gain = audio.createGain(); gain.gain.value = volume;
			worklet.connect(gain); gain.connect(audio.destination);
			return audio.sampleRate;
		},
		start() { node?.port.postMessage({ type: 'start' }); },
		async connectWorker(options, onEvent) {
			if (!node) { throw new Error('Audio output is not connected.'); }
			const current = generation;
			const response = await fetch(new URL('./emulationBrowserWorker.js', import.meta.url));
			if (!response.ok) { throw new Error(`Could not load emulator worker (${response.status}).`); }
			const source = await response.blob();
			const wasmResponse = await fetch(options.wasm);
			if (!wasmResponse.ok) { throw new Error(`Could not load emulator (${wasmResponse.status}).`); }
			const wasmBytes = await wasmResponse.arrayBuffer();
			if (current !== generation || !node) { return; }
			workerUrl = URL.createObjectURL(source);
			const engine = new Worker(workerUrl);
			worker = engine;
			workerTimer = setTimeout(() => { if (worker === engine) { onFailure('Emulator startup timed out.'); } }, 15000);
			const channel = new MessageChannel();
			node.port.postMessage({ type: 'engine', port: channel.port1 }, [channel.port1]);
			engine.onmessage = event => {
				if (worker === engine) {
					if (event.data.type === 'ready' || event.data.type === 'error') { clearTimeout(workerTimer); }
					onEvent(event.data);
				}
			};
			engine.onerror = event => { if (worker === engine) { onFailure(event.message || 'Emulator worker failed.'); } };
			engine.postMessage({ ...options, type: 'init', wasmBytes, port: channel.port2 }, [channel.port2, wasmBytes]);
		},
		workerAsset(bytes, error) { worker?.postMessage({ type: 'asset', bytes, error }); },
		setMuted(muted) { worker?.postMessage({ type: 'mute', muted }); },
		clear() { node?.port.postMessage({ type: 'clear' }); },
		finish() { node?.port.postMessage({ type: 'finish' }); },
		async pause() { paused = true; await context?.suspend(); },
		async resume() { paused = false; await context?.resume(); },
		setVolume(value) { volume = Math.max(0, Math.min(1, value)); if (gain) { gain.gain.setTargetAtTime(volume, context.currentTime, 0.015); } },
		readAnalysis() {
			if (!context || !node || context.state !== 'running') { return null; }
			if (!analysis) {
				const scope = context.createAnalyser(); scope.fftSize = 32768;
				const spectrum = context.createAnalyser(); spectrum.fftSize = 8192;
				spectrum.minDecibels = -100; spectrum.maxDecibels = 0; spectrum.smoothingTimeConstant = .65;
				node.connect(scope); node.connect(spectrum);
				analysis = { scope, spectrum, samples: new Float32Array(scope.fftSize), decibels: new Float32Array(spectrum.frequencyBinCount), sampleRate: context.sampleRate };
			}
			analysis.scope.getFloatTimeDomainData(analysis.samples);
			analysis.spectrum.getFloatFrequencyData(analysis.decibels);
			return analysis;
		},
		pcm(pcm) { if (node && pcm instanceof ArrayBuffer) { node.port.postMessage({ type: 'pcm', pcm }, [pcm]); } },
		disconnect
	};
}