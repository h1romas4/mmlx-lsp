export function createPlaybackControls(root, onModeChange = () => {}) {
	const status = root.querySelector('[role="status"]');
	const mode = root.querySelector('#playback-mode');
	mode.addEventListener('change', () => onModeChange(mode.value));
	return {
		setMode(value) { mode.value = value === 'nanodrive8' ? 'nanodrive8' : 'emulation'; },
		render(state) {
			status.textContent = state?.available ? (state.playing ? 'Playing' : 'Stopped')
				: 'Playback is not ready yet. The music is still dreaming.';
		}
	};
}