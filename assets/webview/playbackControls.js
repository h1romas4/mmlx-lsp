export function createPlaybackControls(root, onModeChange = () => {}, onAction = () => {}, onVolume = () => {}, onMute = () => {}) {
	let muted = 0;
	let soloed = 0;
	function outputMuted() { return soloed ? 511 & ~soloed : muted; }
	function updateChannels() { channels?.setMuted(muted, soloed, outputMuted()); }
	const channels = createChannelRows(root.querySelector('#playback-channels'), (channel, action) => {
		if (action === 'solo') { soloed ^= 1 << channel; }
		else { muted ^= 1 << channel; }
		updateChannels(); onMute(outputMuted());
	});
	const status = root.querySelector('[role="status"]');
	const mode = root.querySelector('#playback-mode');
	const source = root.querySelector('#playback-source');
	const play = root.querySelector('#playback-play');
	const cursor = root.querySelector('#playback-cursor');
	const stop = root.querySelector('#playback-stop');
	const loop = root.querySelector('#playback-loop');
	const volume = root.querySelector('#playback-volume');
	const time = root.querySelector('#playback-time');
	const error = root.querySelector('#playback-error');
	let snapshot;
	let nanoDriveAvailable = false;
	let looped = false;
	let loadingTimer;
	let loadingVisible = false;
	let startingAction = 'play';
	let keyEvents = [];
	let keyIndex = 0;
	let keyPosition = 0;
	function resetKeys() {
		keyEvents = []; keyIndex = 0; keyPosition = 0; channels?.clear();
	}
	function advanceKeys(position) {
		if (!Number.isFinite(position) || position < 0) { return; }
		keyPosition = position;
		while (keyIndex < keyEvents.length && keyEvents[keyIndex].position <= position) {
			const event = keyEvents[keyIndex++]; channels?.setNote(event.channel, event.note);
		}
		if (keyIndex > 512 || keyIndex === keyEvents.length) { keyEvents = keyEvents.slice(keyIndex); keyIndex = 0; }
	}
	function setText(element, value) {
		if (element.textContent !== value) { element.textContent = value; }
	}
	function render(state) {
		if ((state?.loading && !snapshot?.loading) || state?.document !== snapshot?.document
			|| (!state?.playing && !state?.paused && !state?.loading)) { resetKeys(); }
		snapshot = state;
		const loading = state?.loading === true;
		if (loading) {
			if (state.startAction) { startingAction = state.startAction; }
			if (!loadingTimer && !loadingVisible) {
				loadingTimer = setTimeout(() => {
					loadingTimer = undefined;
					loadingVisible = true;
					render(snapshot);
				}, 150);
			}
		} else {
			clearTimeout(loadingTimer);
			loadingTimer = undefined;
			loadingVisible = false;
		}
		root.setAttribute('aria-busy', String(loading));
		root.classList.toggle('is-pending', loading);
		root.classList.toggle('is-finishing', state?.playing === true && state?.finished === true);
		play.classList.toggle('is-loading', loadingVisible && startingAction === 'play');
		cursor.classList.toggle('is-loading', loadingVisible && startingAction === 'playFromCursor');
		const hardware = mode.value === 'nanodrive8';
		if (hardware && state?.playing) { advanceKeys(state.position); }
		const available = state?.available && (!hardware || nanoDriveAvailable);
		channels?.setAvailable(Boolean(available) && !loading && (!state?.busy || state?.playing || state?.paused));
		const busy = state?.playing || state?.paused || state?.loading || state?.busy;
		setText(source, state?.source || 'No MML selected');
		if (!loading || loadingVisible) {
			const message = loadingVisible ? 'Preparing' : state?.playing ? 'Playing' : state?.paused ? 'Paused' : available ? 'Stopped' : 'Unavailable';
			if (status.textContent !== message) {
				setText(status, message);
				status.setAttribute('data-state', message.toLowerCase());
			}
		}
		play.disabled = !available || loading || state?.busy || (hardware && state?.playing === true) || (state?.playing === true && state?.finished === true);
		cursor.disabled = !available || loading || hardware;
		if (!loading) {
			const title = !hardware && state?.playing ? 'Pause' : state?.paused ? 'Resume' : 'Play';
			if (play.title !== title) { play.title = title; play.setAttribute('aria-label', title); }
			play.classList.toggle('is-playing', state?.playing === true);
		}
		stop.disabled = !available || !busy;
		loop.disabled = !available || busy;
		loop.setAttribute('aria-pressed', String(looped));
		mode.disabled = !state?.available || busy;
		volume.disabled = hardware ? !nanoDriveAvailable : !available;
		volume.title = hardware ? 'NanoDrive8 output volume' : 'Playback volume';
		if (!loading) {
			const seconds = Math.max(0, Math.floor(state?.position || 0));
			setText(time, `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
		}
		setText(error, state?.error || '');
		error.hidden = !state?.error;
	}
	mode.addEventListener('change', () => { onModeChange(mode.value); render(snapshot); });
	play.addEventListener('click', () => onAction(snapshot?.playing ? 'pause' : snapshot?.paused ? 'resume' : 'play'));
	cursor.addEventListener('click', () => onAction('playFromCursor'));
	stop.addEventListener('click', () => onAction('stop'));
	loop.addEventListener('click', () => { looped = !looped; render(snapshot); onModeChange(mode.value); });
	volume.addEventListener('input', () => onVolume(Number(volume.value) / 100));
	return {
		enqueueKeys(events) {
			if ((!snapshot?.playing && !snapshot?.paused && !snapshot?.loading) || !Array.isArray(events)) { return; }
			if (keyEvents.length - keyIndex + events.length > 8192) { resetKeys(); return; }
			keyEvents.push(...events); advanceKeys(keyPosition);
		},
		setPosition(position) { if (snapshot?.playing) { advanceKeys(position); } },
		setNanoDriveAvailable(value) { nanoDriveAvailable = value === true; render(snapshot); },
		setMode(value) { mode.value = value === 'nanodrive8' ? 'nanodrive8' : 'emulation'; render(snapshot); },
		setOptions(repeat, level) { looped = repeat === true; volume.value = String(Math.max(0, Math.min(100, Number(level) || 0))); render(snapshot); },
		setMuted(value) { muted = Number.isInteger(value) && value >= 0 && value <= 511 ? value : 0; updateChannels(); },
		setSoloed(value) { soloed = Number.isInteger(value) && value >= 0 && value <= 511 ? value : 0; updateChannels(); },
		get muted() { return muted; },
		get soloed() { return soloed; },
		get outputMuted() { return outputMuted(); },
		get looped() { return looped; },
		get volume() { return Number(volume.value) / 100; },
		render
	};
}

function createChannelRows(container, onSelection) {
	const document = container?.ownerDocument;
	if (!document) { return; }
	const keyboards = [];
	const muteButtons = [];
	const soloButtons = [];
	const rows = [];
	const activeKeys = Array(8).fill(null);
	for (let channel = 0; channel < 9; channel++) {
		const name = channel < 8 ? `FM ${channel + 1}` : 'ADPCM';
		const row = document.createElement('div');
		row.className = `playback-channel${channel === 8 ? ' playback-channel-pcm' : ''}`;
		rows.push(row);
		row.setAttribute('role', 'group'); row.setAttribute('aria-label', name);
		const controls = document.createElement('div');
		controls.className = 'playback-channel-controls';
		const label = document.createElement('span');
		label.className = 'playback-channel-name'; label.textContent = name;
		controls.append(label);
		for (const action of ['mute', 'solo']) {
			const button = document.createElement('button');
			button.className = `playback-channel-toggle playback-channel-${action}`;
			button.type = 'button'; button.disabled = true;
			button.title = `${action === 'mute' ? 'Mute' : 'Solo'} ${name}`;
			button.setAttribute('aria-label', button.title); button.setAttribute('aria-pressed', 'false');
			if (action === 'mute') { muteButtons.push(button); }
			else { soloButtons.push(button); }
			button.addEventListener('click', () => onSelection(channel, action));
			controls.append(button);
		}
		const keyboard = document.createElement('div');
		keyboard.className = 'playback-channel-piano';
		keyboard.setAttribute('role', 'img');
		keyboard.setAttribute('aria-label', 'Keyboard A0 to C8 (88 keys)');
		if (channel === 8) { keyboard.setAttribute('aria-disabled', 'true'); }
		else { keyboards.push(keyboard); }
		let whiteIndex = 0;
		for (let note = 21; note <= 108; note++) {
			const isBlack = [1, 3, 6, 8, 10].includes(note % 12);
			const key = document.createElement('span');
			key.className = isBlack ? 'playback-key-black' : 'playback-key-white';
			key.dataset.note = String(note); key.setAttribute('aria-hidden', 'true');
			if (isBlack) { key.style.setProperty('--channel-key-position', String(whiteIndex)); }
			else { whiteIndex++; if (note % 12 === 0) { key.textContent = `C${note / 12 - 1}`; } }
			keyboard.append(key);
		}
		row.append(controls, keyboard); container.append(row);
	}
	function reveal() {
		for (const key of activeKeys) {
			if (!key || !key.parentElement.clientWidth) { continue; }
			const piano = key.parentElement;
			const bounds = piano.getBoundingClientRect();
			const pressed = key.getBoundingClientRect();
			if (pressed.left < bounds.left + 1 || pressed.right > bounds.right - 1) {
				piano.scrollLeft += (pressed.left + pressed.right - bounds.left - bounds.right) / 2;
			}
		}
	}
	const observer = new ResizeObserver(reveal);
	observer.observe(container);
	return {
		setAvailable(available) { for (const button of [...muteButtons, ...soloButtons]) { button.disabled = !available; } },
		setMuted(mask, solo, effective) {
			for (const [channel, button] of muteButtons.entries()) {
				const pressed = (mask & (1 << channel)) !== 0;
				button.setAttribute('aria-pressed', String(pressed));
				soloButtons[channel].setAttribute('aria-pressed', String((solo & (1 << channel)) !== 0));
				rows[channel].classList.toggle('is-muted', (effective & (1 << channel)) !== 0);
			}
		},
		setNote(channel, note) {
			const keyboard = keyboards[channel];
			if (!keyboard || (note !== null && (!Number.isInteger(note) || note < 21 || note > 108))) { return; }
			const key = note === null ? null : keyboard.querySelector(`[data-note="${note}"]`);
			if (activeKeys[channel] === key) { return; }
			activeKeys[channel]?.classList.remove('is-active');
			activeKeys[channel] = key; key?.classList.add('is-active');
			const name = note === null ? '' : `${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][note % 12]}${Math.floor(note / 12) - 1}`;
			keyboard.setAttribute('aria-label', `Keyboard A0 to C8 (88 keys)${name ? `, ${name} active` : ''}`);
			reveal();
		},
		clear() {
			for (const [channel, keyboard] of keyboards.entries()) {
				activeKeys[channel]?.classList.remove('is-active'); activeKeys[channel] = null;
				keyboard.scrollLeft = 0; keyboard.setAttribute('aria-label', 'Keyboard A0 to C8 (88 keys)');
			}
		}
	};
}