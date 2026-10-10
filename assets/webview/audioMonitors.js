export function noteFrequency(note) {
	return 440 * 2 ** ((note - 69) / 12);
}

function sampleAt(samples, position) {
	const index = Math.floor(position);
	return samples[index] + (samples[index + 1] - samples[index]) * (position - index);
}

export function findScopeStart(samples, period, span, previous) {
	const last = samples.length - Math.ceil(span) - 2;
	const first = Math.max(0, last - Math.ceil(period));
	let best = first;
	let bestScore = -Infinity;
	if (previous) {
		const step = Math.max(1 / 16, period / 192);
		const scoreAt = start => {
			let product = 0; let energy = 0;
			for (let index = 0; index < previous.length; index++) {
				const value = sampleAt(samples, start + span * index / (previous.length - 1));
				product += value * previous[index]; energy += value * value;
			}
			return product / Math.sqrt(Math.max(energy, 1e-20));
		};
		for (let start = first; start <= last; start += step) {
			const score = scoreAt(start);
			if (score > bestScore) { bestScore = score; best = start; }
		}
		const lower = Math.max(first, best - step); const upper = Math.min(last, best + step);
		for (let start = lower; start <= upper; start += step / 16) {
			const score = scoreAt(start);
			if (score > bestScore) { bestScore = score; best = start; }
		}
		return best;
	}
	for (let start = first; start < last; start++) {
		if (samples[start] <= 0 && samples[start + 1] > 0) {
			const slope = samples[start + 1] - samples[start];
			if (slope > bestScore) { bestScore = slope; best = start - samples[start] / slope; }
		}
	}
	return best;
}

export function createAudioMonitors(root, readAnalysis, onGainChange = () => {}) {
	const scopeCanvas = root.querySelector('#oscilloscope');
	const spectrumCanvas = root.querySelector('[data-spectrum]');
	const referenceLabel = root.querySelector('#scope-reference');
	const stateLabel = root.querySelector('[data-spectrum-state]');
	const gainInput = root.querySelector('#scope-gain');
	const scopeContext = scopeCanvas?.getContext('2d');
	const spectrumContext = spectrumCanvas.getContext('2d');
	const held = new Map();
	const reference = new Float32Array(128);
	let note = 69;
	let gain = 4;
	let previous;
	let connected = false;
	let frame;
	let lastFrame = -Infinity;
	let disposed = false;

	function visible() { return !document.hidden && root.getClientRects().length > 0; }
	function resize(canvas, context) {
		const width = canvas.clientWidth; const height = canvas.clientHeight;
		const ratio = Math.min(window.devicePixelRatio || 1, 3);
		const pixels = Math.round(width * ratio); const lines = Math.round(height * ratio);
		if (canvas.width !== pixels || canvas.height !== lines) { canvas.width = pixels; canvas.height = lines; }
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		return { left: 44, top: 12, right: width - 12, bottom: height - 25, width: width - 56, height: height - 37 };
	}
	function grid(canvas, context, spectrum, maximum = 20000, duration = 2000 / noteFrequency(note)) {
		const plot = resize(canvas, context);
		context.fillStyle = '#111615'; context.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
		context.font = '10px monospace'; context.lineWidth = 1;
		context.strokeStyle = '#2b3833'; context.fillStyle = '#91a69b';
		context.textAlign = 'right'; context.textBaseline = 'middle';
		const rows = spectrum ? 5 : 4;
		for (let row = 0; row <= rows; row++) {
			const vertical = plot.top + plot.height * row / rows;
			context.beginPath(); context.moveTo(plot.left, vertical); context.lineTo(plot.right, vertical); context.stroke();
			if (spectrum || row % 2 === 0) { context.fillText(spectrum ? String(-20 * row) : String(Number(((1 - row / 2) / gain).toFixed(3))), plot.left - 6, vertical); }
		}
		context.textBaseline = 'top';
		if (spectrum) {
			for (const frequency of [20, 100, 1000, 10000, maximum]) {
				if (frequency > maximum) { continue; }
				const horizontal = plot.left + plot.width * Math.log(frequency / 20) / Math.log(maximum / 20);
				context.beginPath(); context.moveTo(horizontal, plot.top); context.lineTo(horizontal, plot.bottom); context.stroke();
				context.textAlign = frequency === 20 ? 'left' : frequency === maximum ? 'right' : 'center';
				const label = frequency >= 1000 ? `${frequency / 1000}k` : String(frequency);
				const width = context.measureText(label).width;
				const rightEdge = horizontal + (context.textAlign === 'center' ? width / 2 : context.textAlign === 'left' ? width : 0);
				if (frequency !== maximum && rightEdge + 6 > plot.right - context.measureText(`${maximum / 1000}k`).width) { continue; }
				context.fillText(label, horizontal, plot.bottom + 8);
			}
		} else {
			for (let column = 0; column <= 4; column++) {
				const horizontal = plot.left + plot.width * column / 4;
				context.beginPath(); context.moveTo(horizontal, plot.top); context.lineTo(horizontal, plot.bottom); context.stroke();
			}
			context.textAlign = 'left'; context.fillText('0 ms', plot.left, plot.bottom + 8);
			context.textAlign = 'right'; context.fillText(`${duration.toFixed(2)} ms`, plot.right, plot.bottom + 8);
		}
		return plot;
	}
	function paint() {
		if (!visible() || !spectrumContext) { return; }
		const data = connected ? readAnalysis() : null;
		const period = data ? data.sampleRate / noteFrequency(note) : 0;
		const span = data ? Math.min(period * 2, data.samples.length - 3) : 0;
		const duration = data ? span * 1000 / data.sampleRate : 2000 / noteFrequency(note);
		const scopePlot = scopeContext ? grid(scopeCanvas, scopeContext, false, 20000, duration) : null;
		const maximum = data ? Math.min(20000, data.sampleRate / 2) : 20000;
		const spectrumPlot = grid(spectrumCanvas, spectrumContext, true, maximum);
		if (referenceLabel) { referenceLabel.textContent = connected ? `${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][note % 12]}${Math.floor(note / 12) - 1} / ${noteFrequency(note).toFixed(1)} Hz` : '-'; }
		let peak = 0;
		if (data) {
			for (let index = scopePlot ? data.samples.length - Math.ceil(span) - 2 : 0; index < data.samples.length; index++) { peak = Math.max(peak, Math.abs(data.samples[index])); }
			const active = peak > .0001;
			if (scopePlot) {
				const start = active ? findScopeStart(data.samples, period, span, previous) : 0;
				scopeContext.save(); scopeContext.beginPath(); scopeContext.rect(scopePlot.left, scopePlot.top, scopePlot.width, scopePlot.height); scopeContext.clip();
				scopeContext.strokeStyle = active ? '#6de0b2' : '#416052'; scopeContext.lineWidth = 1.5;
				scopeContext.beginPath();
				const points = Math.max(2, Math.ceil(scopePlot.width * 2));
				for (let index = 0; index <= points; index++) {
					const value = active ? sampleAt(data.samples, start + span * index / points) : 0;
					const horizontal = scopePlot.left + scopePlot.width * index / points;
					const vertical = scopePlot.top + scopePlot.height * (1 - value * gain) / 2;
					if (index === 0) { scopeContext.moveTo(horizontal, vertical); } else { scopeContext.lineTo(horizontal, vertical); }
				}
				scopeContext.stroke(); scopeContext.restore();
				if (active) {
					for (let index = 0; index < reference.length; index++) { reference[index] = sampleAt(data.samples, start + span * index / (reference.length - 1)); }
					previous = reference;
				} else { previous = undefined; }
			}
			spectrumContext.save(); spectrumContext.beginPath(); spectrumContext.rect(spectrumPlot.left, spectrumPlot.top, spectrumPlot.width, spectrumPlot.height); spectrumContext.clip();
			const binWidth = data.sampleRate / (data.decibels.length * 2);
			spectrumContext.beginPath(); spectrumContext.moveTo(spectrumPlot.left, spectrumPlot.bottom);
			for (let column = 0; column <= Math.ceil(spectrumPlot.width); column++) {
				const lower = 20 * (maximum / 20) ** (column / spectrumPlot.width);
				const upper = 20 * (maximum / 20) ** ((column + 1) / spectrumPlot.width);
				let decibels = -100;
				const first = Math.max(1, Math.round(lower / binWidth));
				const last = Math.min(data.decibels.length - 1, Math.max(first, Math.ceil(upper / binWidth) - 1));
				for (let bin = first; bin <= last; bin++) { if (Number.isFinite(data.decibels[bin])) { decibels = Math.max(decibels, data.decibels[bin]); } }
				const vertical = spectrumPlot.top + spectrumPlot.height * Math.max(0, Math.min(1, -decibels / 100));
				spectrumContext.lineTo(spectrumPlot.left + column, vertical);
			}
			spectrumContext.strokeStyle = '#f0bc67'; spectrumContext.lineWidth = 1.5; spectrumContext.stroke();
			spectrumContext.lineTo(spectrumPlot.right, spectrumPlot.bottom); spectrumContext.closePath(); spectrumContext.fillStyle = '#f0bc6718'; spectrumContext.fill();
			const frequency = noteFrequency(note);
			if (referenceLabel && frequency >= 20 && frequency <= maximum) {
				const horizontal = spectrumPlot.left + spectrumPlot.width * Math.log(frequency / 20) / Math.log(maximum / 20);
				spectrumContext.setLineDash([3, 4]); spectrumContext.strokeStyle = '#6de0b2';
				spectrumContext.beginPath(); spectrumContext.moveTo(horizontal, spectrumPlot.top); spectrumContext.lineTo(horizontal, spectrumPlot.bottom); spectrumContext.stroke();
			}
			spectrumContext.restore();
			root.dataset.state = active ? 'active' : 'silent'; stateLabel.textContent = active ? 'dB / Hz' : 'Silent';
		} else {
			previous = undefined;
			root.dataset.state = connected ? 'waiting' : 'disconnected'; stateLabel.textContent = connected ? 'Waiting' : 'Disconnected';
		}
	}
	function tick(time) {
		frame = undefined;
		if (disposed || !connected || !visible()) { return; }
		if (time - lastFrame >= 1000 / 30) { lastFrame = time; paint(); }
		frame = requestAnimationFrame(tick);
	}
	function refresh() {
		if (frame !== undefined) { cancelAnimationFrame(frame); frame = undefined; }
		if (disposed || !visible()) { return; }
		paint(); lastFrame = performance.now();
		if (connected) { frame = requestAnimationFrame(tick); }
	}
	function updateReference() {
		const next = [...held.values()].at(-1);
		if (next !== undefined && next !== note) { note = next; previous = undefined; }
	}
	function setGain(value) { gain = [1, 4, 16].includes(Number(value)) ? Number(value) : 4; if (gainInput) { gainInput.value = String(gain); } refresh(); }
	function changeGain() { setGain(gainInput.value); onGainChange(); }
	gainInput?.addEventListener('change', changeGain);
	const resizeObserver = new ResizeObserver(refresh); resizeObserver.observe(root);
	const visibilityObserver = new MutationObserver(refresh); visibilityObserver.observe(root.closest('[role="tabpanel"]') ?? root.parentElement, { attributes: true, attributeFilter: ['hidden'] });
	document.addEventListener('visibilitychange', refresh);
	refresh();
	return {
		get gain() { return gain; },
		setGain,
		setConnected(value) { connected = value === true; if (!connected) { held.clear(); previous = undefined; } refresh(); },
		setNote(event, source = 'local') {
			const type = event.event ?? event.type;
			const channel = event.channel ?? 0;
			if (type === 'allOff') {
				for (const key of held.keys()) { if (key.startsWith(`${source}:`) && (event.channel === undefined || key.startsWith(`${source}:${channel}:`))) { held.delete(key); } }
			} else if (Number.isInteger(event.note) && event.note >= 0 && event.note <= 127) {
				const key = `${source}:${channel}:${event.note}`;
				if (type === 'noteOn' && event.velocity !== 0) { held.delete(key); held.set(key, event.note); }
				else if (type === 'noteOff' || (type === 'noteOn' && event.velocity === 0)) { held.delete(key); }
			}
			updateReference();
		},
		setMidiNotes(notes) {
			const active = new Set(Array.isArray(notes) ? notes.filter(value => Number.isInteger(value) && value >= 0 && value <= 127) : []);
			for (const [key, value] of held) { if (key.startsWith('midi:') && !active.has(value)) { held.delete(key); } }
			for (const value of active) { if (![...held].some(([key, noteValue]) => key.startsWith('midi:') && noteValue === value)) { held.set(`midi:0:${value}`, value); } }
			updateReference();
		},
		dispose() {
			disposed = true;
			if (frame !== undefined) { cancelAnimationFrame(frame); }
			resizeObserver.disconnect(); visibilityObserver.disconnect(); document.removeEventListener('visibilitychange', refresh);
			gainInput?.removeEventListener('change', changeGain);
		}
	};
}