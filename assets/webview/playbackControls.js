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
	let looped = false;
	function render(state) {
		snapshot = state;
		const available = state?.available && mode.value === 'emulation';
		const busy = state?.playing || state?.paused || state?.loading;
		source.textContent = state?.source || 'No MML selected';
		status.textContent = state?.loading ? 'Compiling' : state?.playing ? 'Playing' : state?.paused ? 'Paused' : available ? 'Stopped' : 'Unavailable';
		play.disabled = !available || state?.loading || (state?.playing && state?.finished);
		cursor.disabled = !available || state?.loading;
		play.title = state?.playing ? 'Pause' : state?.paused ? 'Resume' : 'Play';
		play.setAttribute('aria-label', play.title);
		play.classList.toggle('is-playing', state?.playing === true);
		stop.disabled = !available || !busy;
		loop.disabled = !available || busy;
		loop.setAttribute('aria-pressed', String(looped));
		mode.disabled = !state?.available || busy;
		volume.disabled = !available;
		const seconds = Math.max(0, Math.floor(state?.position || 0));
		time.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
		error.textContent = state?.error || '';
		error.hidden = !state?.error;
	}
	mode.addEventListener('change', () => { onModeChange(mode.value); render(snapshot); });
	play.addEventListener('click', () => onAction(snapshot?.playing ? 'pause' : snapshot?.paused ? 'resume' : 'play'));
	cursor.addEventListener('click', () => onAction('playFromCursor'));
	stop.addEventListener('click', () => onAction('stop'));
	loop.addEventListener('click', () => { looped = !looped; render(snapshot); onModeChange(mode.value); });
	volume.addEventListener('input', () => onVolume(Number(volume.value) / 100));
	return {
		setMode(value) { mode.value = value === 'nanodrive8' ? 'nanodrive8' : 'emulation'; render(snapshot); },
		setOptions(repeat, level) { looped = repeat === true; volume.value = String(Math.max(0, Math.min(100, Number(level) || 0))); render(snapshot); },
		get looped() { return looped; },
		get volume() { return Number(volume.value) / 100; },
		render
	};
}