export function createOutputConnection(root, onRequest = () => {}) {
	const mode = root.querySelector('select');
	const button = root.querySelector('.output-connection');
	let connected = false;
	button.addEventListener('click', event => {
		event.preventDefault();
		event.stopPropagation();
		onRequest({ mode: mode.value, connected: !connected });
	});
	return {
		setConnected(value) {
			connected = value === true;
			mode.disabled = connected;
			button.title = connected ? 'Disconnect' : 'Connect';
			button.setAttribute('aria-label', button.title);
			button.setAttribute('aria-pressed', String(connected));
		},
		setState(state) {
			this.setConnected(state.connected);
			button.disabled = state.connecting === true;
			mode.disabled = connected || button.disabled;
			if (state.error) { button.title = state.error; }
		}
	};
}