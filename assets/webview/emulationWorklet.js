class EmulationProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.pcm = new Float32Array(4096 * 2);
		this.read = 0;
		this.write = 0;
		this.frames = 0;
		this.pending = 0;
		this.started = false;
		this.playing = false;
		this.finishing = false;
		this.ended = false;
		this.port.onmessage = event => {
			if (event.data?.type === 'start') { this.started = true; this.request(); }
			else if (event.data?.type === 'clear') { this.read = 0; this.write = 0; this.frames = 0; this.playing = false; this.request(); }
			else if (event.data?.type === 'finish') { this.finishing = true; }
			else if (event.data?.type === 'pcm' && event.data.pcm instanceof ArrayBuffer && event.data.pcm.byteLength === 4096 && this.pending > 0) {
				const block = new Float32Array(event.data.pcm);
				this.pending--;
				if (this.frames + 512 > 4096) { return; }
				for (let frame = 0; frame < 512; frame++) {
					this.pcm[this.write * 2] = block[frame * 2];
					this.pcm[this.write * 2 + 1] = block[frame * 2 + 1];
					this.write = (this.write + 1) % 4096;
				}
				this.frames += 512;
				this.request();
			}
		};
	}
	request() {
		if (!this.started || this.finishing) { return; }
		const blocks = Math.min(4 - this.pending, Math.max(0, Math.ceil((2048 - this.frames) / 512) - this.pending));
		if (blocks > 0) { this.pending += blocks; this.port.postMessage({ type: 'request', blocks }); }
	}
	process(_inputs, outputs) {
		const output = outputs[0];
		if (!this.playing && (this.frames >= 1024 || (this.finishing && this.frames > 0))) { this.playing = true; }
		if (this.playing) {
			const count = Math.min(output[0].length, this.frames);
			for (let frame = 0; frame < count; frame++) {
				output[0][frame] = this.pcm[this.read * 2];
				output[1][frame] = this.pcm[this.read * 2 + 1];
				this.read = (this.read + 1) % 4096;
			}
			this.frames -= count;
			if (count < output[0].length) { this.playing = false; }
		}
		if (this.finishing && this.frames === 0 && !this.ended) {
			this.ended = true; this.started = false; this.port.postMessage({ type: 'ended' });
		}
		this.request();
		return true;
	}
}
registerProcessor('mmlx-emulation', EmulationProcessor);