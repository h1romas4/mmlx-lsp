const CHANNELS = ['FM A', 'FM B', 'FM C', 'FM D', 'FM E', 'FM F', 'FM G', 'FM H', 'ADPCM'];
const COLORS = ['#39a9c7', '#e38369', '#80b85b', '#c4a646', '#9d84d4', '#d46b9b', '#57b7a5', '#d28a43', '#80b85b'];
const ROW_HEIGHT = 22;
const LABEL_WIDTH = 66;
const TOP_HEIGHT = 20;
const MAX_WIDTH = 24_000;

export function createPlaybackTimeline(root, onNavigate = () => {}) {
	const canvas = root.querySelector('canvas');
	const context = canvas.getContext('2d');
	const scroll = root.querySelector('.playback-timeline-scroll');
	const labels = root.querySelector('.playback-timeline-labels');
	const numerator = root.querySelector('#timeline-numerator');
	const denominator = root.querySelector('#timeline-denominator');
	const offset = root.querySelector('#timeline-offset');
	let events = [];
	let position = 0;
	let following = false;
	let documentKey = '';
	let eventDocument = '';
	let eventVersion = -1;
	let cursor;
	let tempoSegments = [{ position: 0, beat: 0, tempo: 200 }];
	const settingsByDocument = new Map();
	const resizeObserver = new ResizeObserver(schedule);
	let frame;

	canvas.style.cursor = 'pointer';
	labels.style.width = `${LABEL_WIDTH}px`;
	labels.replaceChildren(...CHANNELS.map((name, channel) => {
		const label = labels.ownerDocument.createElement('span');
		label.textContent = name;
		label.dataset.channel = String(channel);
		label.title = `Navigate to ${name} at the playhead`;
		label.style.cursor = 'pointer';
		return label;
	}));

	function updateTempoMap() {
		tempoSegments = [{ position: 0, beat: 0, tempo: 200 }];
		const tempoEvents = events.filter(event => event.kind === 'tempo' && Number.isInteger(event.tempo))
			.sort((first, second) => first.position - second.position);
		for (const event of tempoEvents) {
			const previous = tempoSegments[tempoSegments.length - 1];
			const beat = previous.beat + (event.position - previous.position) * 1_000_000
				/ (48 * 256 * (256 - previous.tempo));
			if (event.position === previous.position) {
				tempoSegments[tempoSegments.length - 1] = { position: event.position, beat, tempo: event.tempo };
			} else {
				tempoSegments.push({ position: event.position, beat, tempo: event.tempo });
			}
		}
	}

	function beatAtTime(time) {
		let segment = tempoSegments[0];
		for (const candidate of tempoSegments) {
			if (candidate.position > time) { break; }
			segment = candidate;
		}
		return segment.beat + (time - segment.position) * 1_000_000
			/ (48 * 256 * (256 - segment.tempo));
	}

	function timeAtBeat(beat) {
		let segment = tempoSegments[0];
		for (let index = 1; index < tempoSegments.length; index++) {
			if (tempoSegments[index].beat > beat) { break; }
			segment = tempoSegments[index];
		}
		return segment.position + (beat - segment.beat) * 48 * 256 * (256 - segment.tempo) / 1_000_000;
	}

	function snapToBeat(time) {
		const beatUnit = 4 / Number(denominator.value);
		const beatOffset = Number(offset.value) * beatUnit;
		const beat = beatAtTime(time);
		const snapped = timeAtBeat(beatOffset + Math.round((beat - beatOffset) / beatUnit) * beatUnit);
		return Math.max(0, Math.min(geometry().duration, snapped));
	}

	function followCursor() {
		if (!cursor || cursor.document !== eventDocument || cursor.version !== eventVersion) { return; }
		let nearest;
		let nearestDistance = Infinity;
		for (const event of events) {
			if ((event.kind !== 'note' && event.kind !== 'rest') || !Number.isInteger(event.start) || !Number.isInteger(event.end)) { continue; }
			const distance = cursor.sourceOffset < event.start ? event.start - cursor.sourceOffset
				: cursor.sourceOffset > event.end ? cursor.sourceOffset - event.end : 0;
			if (distance < nearestDistance) { nearest = event; nearestDistance = distance; }
		}
		if (nearest) {
			const nextPosition = snapToBeat(nearest.position);
			if (nextPosition === position) { return; }
			position = nextPosition;
			following = true;
			schedule();
		}
	}

	function navigateToChannel(channel, time) {
		const channelEvents = events.filter(event => event.channel === channel
			&& ['note', 'rest', 'clear'].includes(event.kind))
			.sort((first, second) => first.position - second.position);
		let target;
		for (let index = 0; index < channelEvents.length; index++) {
			const event = channelEvents[index];
			const nextPosition = channelEvents[index + 1]?.position ?? Infinity;
			if ((event.kind === 'note' || event.kind === 'rest')
				&& event.position <= time && time <= nextPosition
				&& Number.isInteger(event.start) && Number.isInteger(event.end)) {
				target = event;
				break;
			}
		}
		if (!target) {
			let nearestDistance = Infinity;
			const sourceEvents = channel === undefined
				? events.filter(event => event.kind === 'note' || event.kind === 'rest')
				: channelEvents;
			for (const event of sourceEvents) {
				if ((event.kind !== 'note' && event.kind !== 'rest')
					|| !Number.isInteger(event.start) || !Number.isInteger(event.end)) { continue; }
				const distance = Math.abs(event.position - time);
				if (distance < nearestDistance) { target = event; nearestDistance = distance; }
			}
		}
		position = snapToBeat(target?.position ?? time);
		following = true;
		schedule();
		if (!target) { return; }
		if (eventDocument && eventVersion >= 0) {
			onNavigate({ sourceOffset: target.start, document: eventDocument, version: eventVersion });
		}
	}

	canvas.addEventListener('click', event => {
		const bounds = canvas.getBoundingClientRect();
		const row = Math.floor((event.clientY - bounds.top - TOP_HEIGHT) / ROW_HEIGHT);
		if (row < -1 || row >= CHANNELS.length) { return; }
		const { duration, scale } = geometry();
		const time = Math.max(0, Math.min(duration, (event.clientX - bounds.left) / scale));
		navigateToChannel(row < 0 ? undefined : row, time);
	});

	labels.addEventListener('click', event => {
		const label = event.target instanceof Element ? event.target.closest('span[data-channel]') : null;
		if (label) { navigateToChannel(Number(label.dataset.channel), position); }
	});

	function geometry() {
		const duration = events.reduce((end, event) => Math.max(end, event.position), 0);
		const availableWidth = Math.max(1, scroll.clientWidth);
		const scale = duration > 0 ? Math.min(80, (MAX_WIDTH - LABEL_WIDTH) / duration) : 80;
		return { duration, scale, width: Math.max(availableWidth, duration * scale) };
	}

	function followPosition() {
		if (!following || !scroll.clientWidth) { return; }
		const { scale } = geometry();
		const x = position * scale;
		const width = scroll.clientWidth;
		const left = scroll.scrollLeft;
		const margin = Math.min(16, width * 0.04);
		if (x > left + width - margin || x < left + margin) {
			const beatUnit = 4 / Number(denominator.value);
			const barLength = Number(numerator.value) * beatUnit;
			const beatOffset = Number(offset.value) * beatUnit;
			const beat = beatAtTime(position);
			let bar = Math.floor((beat - beatOffset) / barLength);
			let target = timeAtBeat(beatOffset + bar * barLength) * scale;
			const maximumScroll = Math.max(0, scroll.scrollWidth - width);
			while (target > maximumScroll && bar > -1_000_000) {
				bar--;
				target = timeAtBeat(beatOffset + bar * barLength) * scale;
			}
			scroll.scrollLeft = Math.max(0, Math.min(maximumScroll, target));
		}
	}

	function redraw() {
		frame = undefined;
		const { duration, scale, width } = geometry();
		const height = TOP_HEIGHT + CHANNELS.length * ROW_HEIGHT + 1;
		const ratio = window.devicePixelRatio || 1;
		canvas.width = Math.ceil(width * ratio);
		canvas.height = Math.ceil(height * ratio);
		canvas.style.width = `${width}px`;
		canvas.style.height = `${height}px`;
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		context.clearRect(0, 0, width, height);

		const style = getComputedStyle(root);
		const foreground = style.getPropertyValue('--vscode-descriptionForeground').trim() || '#a0a0a0';
		const border = style.getPropertyValue('--vscode-panel-border').trim() || '#38443e';
		const editorFont = style.getPropertyValue('--vscode-editor-font-family').trim() || 'monospace';
		context.font = `10px ${editorFont}`;
		context.textBaseline = 'middle';
		CHANNELS.forEach((name, channel) => {
			const y = TOP_HEIGHT + channel * ROW_HEIGHT;
			context.strokeStyle = border;
			context.globalAlpha = 0.55;
			context.beginPath();
			context.moveTo(0, y + ROW_HEIGHT);
			context.lineTo(width, y + ROW_HEIGHT);
			context.stroke();
			context.globalAlpha = 1;
		});

		const beatUnit = 4 / Number(denominator.value);
		const beatOffset = Number(offset.value) * beatUnit;
		const finalBeat = beatAtTime(duration);
		const firstGrid = Math.ceil((0 - beatOffset) / beatUnit);
		const lastGrid = Math.min(20_000, Math.floor((finalBeat - beatOffset) / beatUnit));
		context.font = `9px ${editorFont}`;
		for (let index = firstGrid; index <= lastGrid; index++) {
			const beat = beatOffset + index * beatUnit;
			const time = timeAtBeat(beat);
			const x = time * scale;
			const isBar = index % Number(numerator.value) === 0;
			context.strokeStyle = foreground;
			context.globalAlpha = isBar ? 0.55 : 0.2;
			context.lineWidth = isBar ? 1 : 0.5;
			context.beginPath();
			context.moveTo(x, 0);
			context.lineTo(x, height);
			context.stroke();
			if (isBar && index >= 0) {
				context.globalAlpha = 0.8;
				context.fillStyle = foreground;
				context.fillText(String(Math.floor(index / Number(numerator.value)) + 1), x + 3, 9);
			}
		}
		context.globalAlpha = 1;

		const byChannel = Array.from({ length: CHANNELS.length }, () => []);
		for (const event of events) {
			if (event.channel < CHANNELS.length && (event.kind === 'note' || event.kind === 'rest' || event.kind === 'clear')) {
				byChannel[event.channel].push(event);
			}
		}
		for (const [channel, track] of byChannel.entries()) {
			let nextPosition = duration;
			for (let index = track.length - 1; index >= 0; index--) {
				const event = track[index];
				if (event.kind === 'note') {
					const x = event.position * scale;
					const right = Math.max(event.position, nextPosition) * scale;
					context.fillStyle = COLORS[channel];
					context.globalAlpha = 0.88;
					context.fillRect(x, TOP_HEIGHT + channel * ROW_HEIGHT + 4, Math.max(2, right - x), ROW_HEIGHT - 8);
				}
				if (event.kind === 'note' || event.kind === 'rest' || event.kind === 'clear') {
					nextPosition = event.position;
				}
			}
		}
		context.globalAlpha = 1;

		if (Number.isFinite(position) && position >= 0) {
			const x = position * scale;
			context.strokeStyle = '#ff5b67';
			context.lineWidth = 1.5;
			context.beginPath();
			context.moveTo(x, 0);
			context.lineTo(x, height);
			context.stroke();
		}
		canvas.setAttribute('aria-label', `MML timeline, ${CHANNELS.length} channels, ${duration.toFixed(2)} seconds`);
		followPosition();
	}

	function schedule() {
		if (frame === undefined) { frame = requestAnimationFrame(redraw); }
	}

	for (const control of [numerator, denominator, offset]) {
		control.addEventListener('input', schedule);
		control.addEventListener('change', schedule);
	}
	resizeObserver.observe(scroll);

	return {
		setEvents(value, document, version) {
			events = Array.isArray(value) ? value : [];
			eventDocument = typeof document === 'string' ? document : '';
			eventVersion = Number.isInteger(version) ? version : -1;
			updateTempoMap(); followCursor(); schedule();
		},
		setPosition(value, follow = false) {
			if (Number.isFinite(value)) {
				if (value !== position) { position = value; schedule(); }
				following = follow === true;
			}
		},
		resetPosition() {
			position = 0;
			following = false;
			cursor = undefined;
			scroll.scrollLeft = 0;
			schedule();
		},
		setCursor(sourceOffset, document, version) {
			if (!Number.isInteger(sourceOffset) || sourceOffset < 0 || typeof document !== 'string' || !Number.isInteger(version)) {
				cursor = undefined; following = false; return;
			}
			cursor = { sourceOffset, document, version };
			following = false;
			followCursor();
		},
		setDocument(key, initialOffset = 0) {
			const nextKey = typeof key === 'string' ? key : '';
			if (nextKey === documentKey) { return; }
			if (documentKey) {
				settingsByDocument.set(documentKey, { numerator: Number(numerator.value), denominator: Number(denominator.value), offset: Number(offset.value) });
			}
			documentKey = nextKey;
			events = [];
			eventDocument = '';
			eventVersion = -1;
			cursor = undefined;
			updateTempoMap();
			position = 0;
			following = false;
			scroll.scrollLeft = 0;
			const settings = settingsByDocument.get(documentKey);
			this.setOptions(settings?.numerator ?? 4, settings?.denominator ?? 4, settings?.offset ?? initialOffset);
		},
		setOptions(beats, unit, beatOffset) {
			const parsedBeats = Number(beats);
			const parsedUnit = Number(unit);
			const parsedOffset = Number(beatOffset);
			if (Number.isInteger(parsedBeats) && parsedBeats >= 1 && parsedBeats <= 12) { numerator.value = String(parsedBeats); }
			if ([2, 4, 8, 16].includes(parsedUnit)) { denominator.value = String(parsedUnit); }
			if (Number.isFinite(parsedOffset)) { offset.value = String(Math.max(-32, Math.min(32, parsedOffset))); }
			schedule();
		},
		get numerator() { return Number(numerator.value); },
		get denominator() { return Number(denominator.value); },
		get offset() { return Number(offset.value); },
		get position() { return position; },
		dispose() { resizeObserver.disconnect(); if (frame !== undefined) { cancelAnimationFrame(frame); } }
	};
}
