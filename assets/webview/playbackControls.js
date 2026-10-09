export function createPlaybackControls(root, onModeChange = () => {}, onAction = () => {}, onVolume = () => {}) {
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
	function setText(element, value) {
		if (element.textContent !== value) { element.textContent = value; }
	}
	function render(state) {
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
		const available = state?.available && (!hardware || nanoDriveAvailable);
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
		volume.disabled = !available || hardware;
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
		setNanoDriveAvailable(value) { nanoDriveAvailable = value === true; render(snapshot); },
		setMode(value) { mode.value = value === 'nanodrive8' ? 'nanodrive8' : 'emulation'; render(snapshot); },
		setOptions(repeat, level) { looped = repeat === true; volume.value = String(Math.max(0, Math.min(100, Number(level) || 0))); render(snapshot); },
		get looped() { return looped; },
		get volume() { return Number(volume.value) / 100; },
		render
	};
}