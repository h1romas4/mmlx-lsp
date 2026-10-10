export function createKeyboardControls(root, onModeChange = () => {}, onNote = () => {}, onVoiceTest = () => {}) {
	const body = root.querySelector('.p-keyboard__body');
	const wrapper = root.querySelector('.p-keyboard__wrapper');
	const mode = root.querySelector('#keyboard-mode');
	const midiStatus = root.querySelector('#keyboard-midi-status');
	const bend = root.querySelector('#keyboard-pitch-bend');
	const testInput = root.querySelector('#voice-test-mml');
	const testPlay = root.querySelector('#voice-test-play');
	let outputConnected = false;
	let resetting = false;
	let testPlaying = false;
	let testError = false;
	let voiceTestChangedChip = false;
	let voiceAvailable = false;
	function updateTestControls() {
		if (!testInput) { return; }
		root.classList.toggle('is-voice-test-pending-reset', voiceTestChangedChip);
		testInput.disabled = testPlaying || resetting;
		testPlay.disabled = resetting || !testPlaying && (!outputConnected || !voiceAvailable || !testInput.value.trim());
		testPlay.classList.toggle('is-busy', resetting && outputConnected && voiceAvailable && !!testInput.value.trim());
		testPlay.classList.toggle('transport-play', !testPlaying);
		testPlay.classList.toggle('transport-stop', testPlaying);
		testPlay.classList.toggle('is-error', testError);
		testPlay.title = testError ? 'MML error' : testPlaying ? 'Stop voice test' : 'Play voice test';
		testPlay.setAttribute('aria-label', testPlaying ? 'Stop voice test' : 'Play voice test');
		testPlay.setAttribute('aria-pressed', String(testPlaying));
		testInput.setAttribute('aria-invalid', String(testError));
	}
	testInput?.addEventListener('input', () => { testError = false; updateTestControls(); });
	testInput?.addEventListener('keydown', event => {
		if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.repeat || testInput.disabled || testPlaying) { return; }
		event.preventDefault(); event.stopPropagation();
		testPlay.click();
	});
	testPlay?.addEventListener('click', () => { if (!testPlay.disabled) { testError = false; updateTestControls(); onVoiceTest(testPlaying ? 'stop' : 'play', testInput.value); } });
	let bendValue = 8192;
	let bending = false;

	function setBend(value, notify = true) {
		value = Math.max(0, Math.min(16383, Math.round(value)));
		bend.value = String(value);
		const semitones = (value - 8192) / (value >= 8192 ? 8191 : 8192) * 2;
		bend.setAttribute('aria-valuetext', `${semitones.toFixed(2)} semitones`);
		if (notify) { bending = true; }
		if (value === bendValue) { return; }
		bendValue = value;
		if (notify) { onNote({ event: 'pitchBend', value }); }
	}

	function resetBend() {
		if (!bending) { return; }
		setBend(8192);
		bending = false;
	}
	const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
	const pointers = new Map();
	const heldKeys = new Set();
	let midiNotes = new Set();
	let renderedWhiteCount = 0;
	let connected = false;
	const sounding = new Set();

	function updateKey(key) {
		const local = heldKeys.has(key) || [...pointers.values()].includes(key);
		if (sounding.has(key) !== local) {
			if (local) { sounding.add(key); } else { sounding.delete(key); }
			onNote({ event: local ? 'noteOn' : 'noteOff', note: Number(key.dataset.midiNote), velocity: local ? 100 : 0 });
		}
		const active = midiNotes.has(Number(key.dataset.midiNote)) || heldKeys.has(key) || [...pointers.values()].includes(key);
		key.classList.toggle('is-active', active);
		key.setAttribute('aria-pressed', String(active));
		key.setAttribute('aria-disabled', String(!connected));
	}

	function releasePointer(event) {
		const key = pointers.get(event.pointerId);
		if (!key) { return; }
		pointers.delete(event.pointerId);
		updateKey(key);
	}

	function releaseAll() {
		resetBend();
		const keys = new Set([...pointers.values(), ...heldKeys]);
		pointers.clear();
		heldKeys.clear();
		for (const key of keys) { updateKey(key); }
	}

	function render() {
		const width = wrapper.getBoundingClientRect().width;
		if (!width || !root.open) { releaseAll(); return; }
		const targetWhiteCount = Math.max(22, Math.floor(body.getBoundingClientRect().width / 33.2));
		const startNote = targetWhiteCount === 22 ? 48 : 36;
		const notes = [];
		let whiteCount = 0;
		for (let note = startNote; note <= 127 && whiteCount < targetWhiteCount; note++) {
			const black = [1, 3, 6, 8, 10].includes(note % 12);
			notes.push({ note, black, name: `${names[note % 12]}${Math.floor(note / 12) - 1}` });
			if (!black) { whiteCount++; }
		}
		wrapper.style.setProperty('--keyboard-white-count', String(whiteCount));
		wrapper.style.setProperty('--keyboard-label-size', `${Math.min(13, width / whiteCount * .7)}px`);
		if (whiteCount === renderedWhiteCount) { return; }
		renderedWhiteCount = whiteCount;
		releaseAll();
		const keys = notes.map(({ note, black, name }, index) => {
			const key = document.createElement('li');
			key.className = `p-keyboard__${black ? 'black' : 'white'}`;
			key.dataset.midiNote = String(note);
			key.setAttribute('role', 'button');
			key.setAttribute('aria-label', name);
			key.setAttribute('aria-pressed', 'false');
			key.title = name;
			key.tabIndex = connected && index === 0 ? 0 : -1;
			key.textContent = note % 12 === 0 ? name : '';
			key.addEventListener('pointerdown', event => {
				if (!connected || event.button !== 0) { return; }
				event.preventDefault();
				key.setPointerCapture(event.pointerId);
				pointers.set(event.pointerId, key);
				updateKey(key);
			});
			for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
				key.addEventListener(type, releasePointer);
			}
			key.addEventListener('keydown', event => {
				if (!connected) { return; }
				if ([' ', 'Enter'].includes(event.key)) {
					event.preventDefault();
					heldKeys.add(key);
					updateKey(key);
				} else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
					event.preventDefault();
					const next = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1
						: Math.max(0, Math.min(keys.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)));
					key.tabIndex = -1;
					keys[next].tabIndex = 0;
					keys[next].focus();
				}
			});
			key.addEventListener('keyup', event => {
				if (![' ', 'Enter'].includes(event.key)) { return; }
				event.preventDefault();
				heldKeys.delete(key);
				updateKey(key);
			});
			key.addEventListener('blur', () => { heldKeys.delete(key); updateKey(key); });
			return key;
		});
		for (const key of keys) { updateKey(key); }
		wrapper.replaceChildren(...keys);
	}

	new ResizeObserver(render).observe(body);
	bend.addEventListener('pointerdown', event => {
		if (connected && event.button === 0) { bend.setPointerCapture(event.pointerId); }
	});
	bend.addEventListener('input', () => { if (connected) { setBend(Number(bend.value)); } });
	for (const type of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) { bend.addEventListener(type, resetBend); }
	bend.addEventListener('keydown', event => {
		if (!connected || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) { return; }
		event.preventDefault();
		if (event.key === 'Home' || event.key === 'End') { setBend(8192); bending = false; return; }
		const direction = ['ArrowUp', 'ArrowRight', 'PageUp'].includes(event.key) ? 1 : -1;
		setBend(bendValue + direction * (event.key.startsWith('Page') ? 4096 : 512));
	});
	bend.addEventListener('keyup', event => {
		if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(event.key)) { event.preventDefault(); resetBend(); }
	});
	root.addEventListener('toggle', () => { if (root.open) { render(); } else { releaseAll(); } });
	mode.addEventListener('change', () => { releaseAll(); onModeChange(mode.value); });
	window.addEventListener('blur', releaseAll);
	document.addEventListener('visibilitychange', () => { if (document.hidden) { releaseAll(); } });
	return {
		releaseAll,
		setConnected(value) {
			outputConnected = value === true;
			connected = outputConnected && !testPlaying && !resetting;
			updateTestControls();
			bend.disabled = !connected;
			if (!connected) { releaseAll(); setBend(8192, false); }
			root.classList.toggle('is-disconnected', !outputConnected);
			root.classList.toggle('is-busy', outputConnected && (testPlaying || resetting));
			body.setAttribute('aria-disabled', String(!connected));
			for (const [index, key] of [...wrapper.children].entries()) {
				key.tabIndex = connected && index === 0 ? 0 : -1;
				updateKey(key);
			}
		},
		setVoiceAvailable(value) { voiceAvailable = value === true; updateTestControls(); },
		setResetting(value) { resetting = value === true; this.setConnected(outputConnected); },
		setVoiceTest(playing, error = false) {
			if (error) { voiceTestChangedChip = false; }
			else if (playing) { voiceTestChangedChip = true; }
			testPlaying = playing === true; testError = error === true; this.setConnected(outputConnected);
		},
		setOutputReset(connected) {
			if (connected) { voiceTestChangedChip = false; updateTestControls(); }
		},
		get testMml() { return testInput?.value ?? ''; },
		setTestMml(value) {
			if (!testInput) { return; }
			const saved = typeof value === 'string' ? value : '';
			const trimmed = saved.trim();
			testInput.value = !trimmed || trimmed === 't120 o4 l8 cdefgab>c4' || trimmed === 'MH0,200,64,0,5,0,1'
				? testInput.defaultValue : saved.slice(0, 8192);
			updateTestControls();
		},
		setMidiState(state) {
			midiStatus.hidden = state.connected !== true;
			midiStatus.title = state.connected ? `MIDI-IN: ${state.connection}` : '';
			midiStatus.setAttribute('aria-label', state.connected ? `MIDI-IN connected: ${state.connection}` : 'MIDI-IN disconnected');
		},
		setMode(value) { mode.value = value === 'nanodrive8' ? 'nanodrive8' : 'emulation'; },
		setPitchBend(value) {
			if (Number.isInteger(value) && value >= 0 && value <= 16383) { setBend(value, false); }
		},
		setMidiNotes(notes) {
			midiNotes = new Set(Array.isArray(notes) ? notes.filter(note => Number.isInteger(note) && note >= 0 && note <= 127) : []);
			for (const key of wrapper.children) { updateKey(key); }
		}
	};
}