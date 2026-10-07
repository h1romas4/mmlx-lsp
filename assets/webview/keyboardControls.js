export function createKeyboardControls(root, onModeChange = () => {}, onNote = () => {}) {
	const body = root.querySelector('.p-keyboard__body');
	const wrapper = root.querySelector('.p-keyboard__wrapper');
	const mode = root.querySelector('#keyboard-mode');
	const midiStatus = root.querySelector('#keyboard-midi-status');
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
		const keys = new Set([...pointers.values(), ...heldKeys]);
		pointers.clear();
		heldKeys.clear();
		for (const key of keys) { updateKey(key); }
	}

	function render() {
		const width = body.getBoundingClientRect().width;
		if (!width || !root.open) { releaseAll(); return; }
		const targetWhiteCount = Math.max(22, Math.floor(width / 33.2));
		const notes = [];
		let whiteCount = 0;
		for (let note = 48; note <= 127 && whiteCount < targetWhiteCount; note++) {
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
	root.addEventListener('toggle', () => { if (root.open) { render(); } else { releaseAll(); } });
	mode.addEventListener('change', () => { releaseAll(); onModeChange(mode.value); });
	window.addEventListener('blur', releaseAll);
	document.addEventListener('visibilitychange', () => { if (document.hidden) { releaseAll(); } });
	return {
		releaseAll,
		setConnected(value) {
			connected = value === true;
			if (!connected) { releaseAll(); }
			root.classList.toggle('is-disconnected', !connected);
			body.setAttribute('aria-disabled', String(!connected));
			for (const [index, key] of [...wrapper.children].entries()) {
				key.tabIndex = connected && index === 0 ? 0 : -1;
				updateKey(key);
			}
		},
		setMidiState(state) {
			midiStatus.hidden = state.connected !== true;
			midiStatus.title = state.connected ? `MIDI-IN: ${state.connection}` : '';
			midiStatus.setAttribute('aria-label', state.connected ? `MIDI-IN connected: ${state.connection}` : 'MIDI-IN disconnected');
		},
		setMode(value) { mode.value = value === 'nanodrive8' ? 'nanodrive8' : 'emulation'; },
		setMidiNotes(notes) {
			midiNotes = new Set(Array.isArray(notes) ? notes.filter(note => Number.isInteger(note) && note >= 0 && note <= 127) : []);
			for (const key of wrapper.children) { updateKey(key); }
		}
	};
}