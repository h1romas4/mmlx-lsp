export function createSettingsControls(root, onChange = () => {}) {
	const controls = [...root.querySelectorAll('[data-build-setting]')];
	const fieldset = root.querySelector('#build-settings-fields');
	const source = root.querySelector('#build-settings-source');
	const status = root.querySelector('#build-settings-status');
	const connectionFields = root.querySelector('#connection-settings-fields');
	const connection = root.querySelector('#serial-connection');
	const refresh = root.querySelector('#refresh-serial-ports');
	const serialStatus = root.querySelector('#serial-settings-status');
	let snapshot;
	let serialSnapshot;

	function renderSerial(message) {
		serialSnapshot = message;
		connectionFields.disabled = !message.folder || message.saving || message.loading;
		connection.disabled = !message.editable;
		refresh.disabled = !message.folder || message.saving || message.loading;
		serialStatus.textContent = message.error || (message.loading ? 'Loading serial ports' : message.saving ? 'Saving'
			: message.ports.length === 0 ? 'No serial ports found' : '');
		const options = [new Option('Not selected', '')];
		for (const port of message.ports) {
			options.push(new Option(port.manufacturer ? `${port.path} (${port.manufacturer})` : port.path, port.path));
		}
		if (message.connection && !message.ports.some(port => port.path === message.connection)) {
			options.push(new Option(`${message.connection} (not detected)`, message.connection));
		}
		connection.replaceChildren(...options);
		connection.value = message.connection;
	}

	function render(message) {
		if (message?.type === 'serialSettings') { renderSerial(message); return; }
		if (message?.type !== 'buildSettings') { return; }
		snapshot = message;
		fieldset.disabled = !message.editable;
		source.textContent = message.source ?? '';
		status.textContent = message.error || (message.saving ? 'Saving' : '');
		for (const control of controls) {
			const value = message.values?.[control.dataset.buildSetting];
			if (control.type === 'checkbox') { control.checked = value === true; }
			else { control.value = value === undefined ? '' : String(value); }
		}
	}


	refresh.addEventListener('click', () => {
		if (!serialSnapshot?.folder || serialSnapshot.loading || serialSnapshot.saving) { return; }
		renderSerial({ ...serialSnapshot, editable: false, loading: true, error: '' });
		onChange({ type: 'getSerialPorts' });
	});
	connection.addEventListener('change', () => {
		if (!serialSnapshot?.editable || !serialSnapshot.folder || connection.value === serialSnapshot.connection) { return; }
		const value = connection.value;
		const folder = serialSnapshot.folder;
		renderSerial({ ...serialSnapshot, connection: value, editable: false, saving: true });
		onChange({ type: 'updateSerialConnection', folder, value });
	});
	for (const control of controls) {
		control.addEventListener('change', () => {
			if (!snapshot?.editable || !snapshot.folder) { return; }
			if (!control.checkValidity()) { control.reportValidity(); render(snapshot); return; }
			const key = control.dataset.buildSetting;
			const value = control.type === 'checkbox' ? control.checked
				: control.type === 'number' ? control.valueAsNumber : control.value;
			if (snapshot.values[key] === value) { return; }
			const folder = snapshot.folder;
			render({ ...snapshot, values: { ...snapshot.values, [key]: value }, editable: false, saving: true });
			onChange({ type: 'updateBuildSetting', folder, key, value });
		});
		control.addEventListener('keydown', event => {
			if (event.key === 'Enter' && control.tagName === 'INPUT' && control.type !== 'checkbox') {
				event.preventDefault();
				control.dispatchEvent(new Event('change'));
			}
		});
	}

	return { render };
}