export function createOutputConnection(root, onRequest = () => {}) {
	const mode = root.querySelector('select');
	const button = root.querySelector('.output-connection');
	const available = !button.disabled;
	let connected = false;
	let connecting = false;
	let nanoDriveAvailable = false;
	function render() {
		button.disabled = !available || connecting || (mode.value === 'nanodrive8' && !nanoDriveAvailable && !connected);
		mode.disabled = connected || connecting;
		button.title = connected ? 'Disconnect' : 'Connect';
		button.setAttribute('aria-label', button.title);
		button.setAttribute('aria-pressed', String(connected));
	}
	mode.addEventListener('change', render);
	button.addEventListener('click', event => {
		event.preventDefault();
		event.stopPropagation();
		if (button.disabled) { return; }
		onRequest({ mode: mode.value, connected: !connected });
	});
	render();
	return {
		setNanoDriveAvailable(value) {
			nanoDriveAvailable = value === true;
			render();
		},
		setConnected(value) {
			connected = value === true;
			render();
		},
		setState(state) {
			connecting = state.connecting === true;
			this.setConnected(state.connected);
			if (state.error) { button.title = state.error; }
		}
	};
}