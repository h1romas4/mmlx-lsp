export function createSettingsControls(root, onChange = () => {}) {
	const controls = [...root.querySelectorAll('[data-build-setting]')];
	const fieldset = root.querySelector('#build-settings-fields');
	const mcpConnection = root.querySelector('#mcp-connection');
	const mcpConnect = root.querySelector('#connect-mcp');
	const source = root.querySelector('#build-settings-source');
	const status = root.querySelector('#build-settings-status');
	let snapshot;
	const renderSerial = createPortControls('serial', 'serial', 'getSerialPorts', 'updateSerialConnection',
		port => ({ value: port.path, label: port.manufacturer ? `${port.path} (${port.manufacturer})` : port.path }));
	const renderMidi = createPortControls('midi', 'MIDI input', 'getMidiInputPorts', 'updateMidiInput',
		port => ({ value: port, label: port }));

	function createPortControls(prefix, label, refreshType, updateType, option) {
		const connection = root.querySelector(`#${prefix}-connection`);
		const refresh = root.querySelector(`#refresh-${prefix}-ports`);
		const connect = root.querySelector(`#connect-${prefix}`);
		const native = prefix === 'serial' ? root.querySelector('#serial-windows-native') : undefined;
		const status = root.querySelector(`#${prefix}-settings-status`);
		let current;
		function renderPorts(message) {
			current = message;
			connection.disabled = !message.editable || !!message.connected || !!message.connecting || !!message.closing;
			if (native) {
				native.checked = message.windowsNative === true;
				native.disabled = connection.disabled || !message.nativeAvailable;
			}
			refresh.disabled = !message.folder || message.saving || message.loading || !!message.connecting || !!message.closing;
			if (connect) {
				connect.disabled = !!message.connecting || !!message.closing || (!message.connected && !message.canConnect);
				const device = prefix === 'midi' ? 'MIDI input' : 'NanoDrive8';
				connect.title = `${message.closing ? 'Disconnecting' : message.connecting ? 'Connecting' : message.connected ? 'Disconnect' : 'Connect'} ${device}`;
				connect.setAttribute('aria-label', connect.title);
				connect.setAttribute('aria-pressed', String(!!message.connected));
			}
			status.textContent = message.phase || (message.saving ? 'Saving'
				: message.connected ? (prefix === 'midi' ? '' : `${message.model} / FW ${message.firmware}`)
				: message.ports.length === 0 ? `No ${label} ports found` : '');
			status.title = status.textContent;
			const ports = message.ports.map(option);
			const options = [new Option('Not selected', ''), ...ports.map(port => new Option(port.label, port.value))];
			if (message.connection && !ports.some(port => port.value === message.connection)) {
				options.push(new Option(`${message.connection} (not detected)`, message.connection));
			}
			connection.replaceChildren(...options);
			connection.value = message.connection;
		}
		refresh.addEventListener('click', () => {
			if (!current?.folder || current.loading || current.saving) { return; }
			renderPorts({ ...current, editable: false, loading: true, error: '' });
			onChange({ type: refreshType });
		});
		connect?.addEventListener('click', () => {
			if (!current?.folder || current.connecting || current.closing || (!current.connected && !current.canConnect)) { return; }
			onChange({ type: prefix === 'midi' ? 'setMidiInputConnection' : 'setSerialConnection', folder: current.folder, connected: !current.connected });
		});
		connection.addEventListener('change', () => {
			if (!current?.editable || !current.folder || connection.value === current.connection) { return; }
			const value = connection.value;
			const folder = current.folder;
			renderPorts({ ...current, connection: value, editable: false, saving: true });
			onChange({ type: updateType, folder, value });
		});
		native?.addEventListener('change', () => {
			if (native.disabled || !current?.editable || !current.folder) { return; }
			const value = native.checked; const folder = current.folder;
			renderPorts({ ...current, windowsNative: value, editable: false, saving: true });
			onChange({ type: 'updateSerialNative', folder, value });
		});
		return renderPorts;
	}

	function render(message) {
		if (message?.type === 'serialSettings') { renderSerial(message); return; }
		if (message?.type === 'midiSettings') { renderMidi(message); return; }
		if (message?.type !== 'buildSettings') { return; }
		snapshot = message;
		fieldset.disabled = !message.editable;
		const mcpEditable = message.mcpEditable ?? message.editable;
		mcpConnection.disabled = !mcpEditable || !message.mcpSupported || message.mcpEnabled === true;
		mcpConnection.value = 'mmlx';
		mcpConnect.disabled = !mcpEditable || !message.mcpSupported;
		mcpConnect.title = `${message.mcpEnabled ? 'Disconnect' : 'Connect'} mmlx MCP`;
		mcpConnect.setAttribute('aria-label', mcpConnect.title);
		mcpConnect.setAttribute('aria-pressed', String(message.mcpEnabled === true));
		source.textContent = message.source ?? '';
		status.textContent = message.error || (message.saving ? 'Saving' : '');
		for (const control of controls) {
			const value = message.values?.[control.dataset.buildSetting];
			if (control.type === 'checkbox') { control.checked = value === true; }
			else { control.value = value === undefined ? '' : String(value); }
		}
	}

	mcpConnect.addEventListener('click', () => {
		if (!(snapshot?.mcpEditable ?? snapshot?.editable) || !snapshot?.mcpSupported) { return; }
		const value = !snapshot.mcpEnabled;
		if (snapshot.mcpEnabled === value) { return; }
		render({ ...snapshot, mcpEnabled: value, editable: false, mcpEditable: false, saving: true });
		onChange({ type: 'setMcpEnabled', value });
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