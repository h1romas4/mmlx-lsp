import * as assert from 'assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Wasm } from '@vscode/wasm-wasi/v1';
import { createUriConverters } from '@vscode/wasm-wasi-lsp';
import type { LanguageClient } from 'vscode-languageclient/node';
import { BuildTerminal, buildErrorLinkProvider } from '../tasks';
import { listMidiInputPorts, VoiceViewProvider } from '../voiceView';

function observeBuilds(uri: vscode.Uri) {
	const active = new Set<vscode.TaskExecution>();
	const changed = new vscode.EventEmitter<void>();
	const exits: (number | undefined)[] = [];
	let started = 0;
	let maxActive = 0;
	const matches = (execution: vscode.TaskExecution) => execution.task.definition.type === 'mmlx'
		&& [uri.toString(), uri.fsPath].includes(execution.task.definition.input);
	const subscriptions = [
		vscode.tasks.onDidStartTask(event => {
			if (matches(event.execution)) {
				started++;
				active.add(event.execution);
				maxActive = Math.max(maxActive, active.size);
				changed.fire();
			}
		}),
		vscode.tasks.onDidEndTaskProcess(event => {
			if (matches(event.execution)) { exits.push(event.exitCode); changed.fire(); }
		}),
		vscode.tasks.onDidEndTask(event => {
			if (matches(event.execution)) { active.delete(event.execution); changed.fire(); }
		})
	];
	return {
		get started() { return started; },
		get maxActive() { return maxActive; },
		exits,
		waitFor(count: number, milliseconds = 30000): Promise<void> {
			if (exits.length >= count && active.size === 0) { return Promise.resolve(); }
			return new Promise((resolve, reject) => {
				const subscription = changed.event(() => {
					if (exits.length >= count && active.size === 0) {
						clearTimeout(timeout);
						subscription.dispose();
						resolve();
					}
				});
				const timeout = setTimeout(() => {
					subscription.dispose();
					reject(new Error(`Timed out waiting for ${count} builds`));
				}, milliseconds);
			});
		},
		dispose(): void {
			for (const subscription of subscriptions) { subscription.dispose(); }
			changed.dispose();
		}
	};
}

async function editSource(document: vscode.TextDocument, source: string): Promise<void> {
	const edit = new vscode.WorkspaceEdit();
	edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), source);
	assert.ok(await vscode.workspace.applyEdit(edit));
}

async function runBuildTerminal(
	definition: ConstructorParameters<typeof BuildTerminal>[2], cancel = false
): Promise<{ code: number; output: string; links: ReturnType<BuildTerminal['errorLinks']> }> {
	const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
	assert.ok(extension);
	await extension.activate();
	const diagnostics = vscode.languages.createDiagnosticCollection('mmlx build log test');
	const terminal = new BuildTerminal(extension.extensionUri, await Wasm.load(), definition,
		vscode.workspace.getWorkspaceFolder(vscode.Uri.file(definition.input)), diagnostics, () => undefined);
	let output = '';
	const subscription = terminal.onDidWrite(data => { output += data; });
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let closeSubscription: vscode.Disposable | undefined;
	try {
		const code = await new Promise<number>((resolve, reject) => {
			timeout = setTimeout(() => { reject(new Error('Build terminal timed out')); terminal.close(); }, 30000);
			closeSubscription = terminal.onDidClose(resolve);
			terminal.open();
			if (cancel) { terminal.close(); }
		});
		const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split('\r\n');
		return { code, output, links: lines.flatMap(line => terminal.errorLinks(line)) };
	} finally {
		clearTimeout(timeout);
		closeSubscription?.dispose();
		subscription.dispose();
		diagnostics.dispose();
		terminal.close();
	}
}

async function runBuildTask(definition: vscode.TaskDefinition, cancel = false): Promise<number | undefined> {
	const available = await vscode.tasks.fetchTasks({ type: 'mmlx' });
	const task = available.find(task => task.definition.format === (definition.format === 'both' ? undefined : definition.format));
	assert.ok(task, 'mmlx build task is not registered');
	task.definition = { ...task.definition, ...definition };
	task.name = `mmlx build test ${Date.now()}`;
	return new Promise((resolve, reject) => {
		const subscriptions: vscode.Disposable[] = [];
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error('Timed out waiting for mmlx build task'));
		}, 30000);
		function cleanup(): void {
			clearTimeout(timeout);
			for (const subscription of subscriptions) { subscription.dispose(); }
		}
		subscriptions.push(vscode.tasks.onDidEndTaskProcess(event => {
			if (event.execution.task.name === task.name) {
				cleanup();
				resolve(event.exitCode);
			}
		}));
		if (cancel) {
			subscriptions.push(vscode.tasks.onDidStartTaskProcess(event => {
				if (event.execution.task.name === task.name) {
					event.execution.terminate();
				}
			}));
		}
		void vscode.tasks.executeTask(task).then(undefined, error => { cleanup(); reject(error); });
	});
}

function waitForDiagnostics(uri: vscode.Uri, count: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const subscription = vscode.languages.onDidChangeDiagnostics(() => check());
		const timeout = setTimeout(() => {
			subscription.dispose();
			const diagnostics = vscode.languages.getDiagnostics(uri)
				.filter(diagnostic => diagnostic.source === 'mmlx');
			reject(new Error(`Timed out waiting for ${count} mmlx diagnostics for ${uri}: ${JSON.stringify(diagnostics)}`));
		}, 15000);
		function check(): void {
			const diagnostics = vscode.languages.getDiagnostics(uri)
				.filter(diagnostic => diagnostic.source === 'mmlx');
			if (diagnostics.length === count) {
				clearTimeout(timeout);
				subscription.dispose();
				resolve();
			}
		}
		check();
	});
}

suite('mmlx extension', () => {
	test('registers the MML language', async () => {
		assert.ok((await vscode.languages.getLanguages()).includes('mmlx'));
	});

	test('opens the FM voice panel without modifying the selected definition', async function () {
		this.timeout(30000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		await extension.activate();
		assert.ok((await vscode.commands.getCommands()).includes('mmlx.showVoicePanel'));
		assert.ok(extension.packageJSON.contributes.views.mmlx.some((view: { id: string; type: string }) =>
			view.id === 'mmlx.voice' && view.type === 'webview'));
		assert.strictEqual(extension.packageJSON.contributes.viewsContainers.panel[0].title, 'mmlx (experimental)');
		assert.strictEqual(extension.packageJSON.contributes.views.mmlx[0].name, 'mmlx (experimental)');
		const source = '@7 = {\n' + '31,12,4,8,6,20,1,2,3,1,0,\n'.repeat(4) + '5,3,15\n}\nA @7 c4\n';
		const document = await vscode.workspace.openTextDocument({ language: 'mmlx', content: source });
		const editor = await vscode.window.showTextDocument(document);
		const position = new vscode.Position(2, 4);
		editor.selection = new vscode.Selection(position, position);
		await waitForDiagnostics(document.uri, 0);
		const version = document.version;
		try {
			await vscode.commands.executeCommand('mmlx.showVoicePanel');
			assert.strictEqual(document.getText(), source);
			assert.strictEqual(document.version, version);
			assert.ok(editor.selection.active.isEqual(position));
		} finally {
			await vscode.commands.executeCommand('workbench.action.closePanel');
		}
	});

	test('FM voice algorithm table matches YM2151 connections and carriers', async () => {
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const module = await import(vscode.Uri.joinPath(extension.extensionUri, 'media', 'voiceControls.js').toString());
		assert.deepStrictEqual(module.algorithmConnections.map((connection: { edges: number[][] }) => connection.edges), [
			[[0, 1], [1, 2], [2, 3]], [[0, 2], [1, 2], [2, 3]],
			[[0, 3], [1, 2], [2, 3]], [[0, 1], [1, 3], [2, 3]],
			[[0, 1], [2, 3]], [[0, 1], [0, 2], [0, 3]], [[0, 1]], []
		]);
		assert.deepStrictEqual(module.algorithmConnections.map((connection: { carriers: number[] }) => connection.carriers),
			[[3], [3], [3], [3], [1, 3], [1, 2, 3], [1, 2, 3], [0, 1, 2, 3]]);
	});

	test('FM voice envelope dragging maps and clamps all envelope parameters', async () => {
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const module = await import(vscode.Uri.joinPath(extension.extensionUri, 'media', 'voiceControls.js').toString());
		const original = { ar: 16, tl: 10, rr: 8, d1r: 12, d1l: 3, d2r: 8 };
		const base = module.envelopeHandlePositions(original);
		for (let ar = 0; ar <= 31; ar++) {
			const point = module.envelopeHandlePositions({ ...original, ar }).attack;
			assert.strictEqual(module.dragEnvelope(original, 'attack', point[0] - base.attack[0], 0).ar, ar);
		}
		for (let tl = 0; tl <= 127; tl++) {
			assert.strictEqual(module.dragEnvelope(original, 'attack', 0, (tl - original.tl) * 0.75 / 96 * 100).tl, tl);
		}
		for (let rr = 0; rr <= 15; rr++) {
			const point = module.envelopeHandlePositions({ ...original, rr }).release;
			assert.strictEqual(module.dragEnvelope(original, 'release', point[0] - base.release[0], 0).rr, rr);
		}
		for (let d1r = 0; d1r <= 31; d1r++) {
			const point = module.envelopeHandlePositions({ ...original, d1r }).decay;
			assert.strictEqual(module.dragEnvelope(original, 'decay', point[0] - base.decay[0], 0).d1r, d1r);
		}
		for (let d1l = 0; d1l <= 15; d1l++) {
			const level = d1l === 15 ? 93 : d1l * 3;
			assert.strictEqual(module.dragEnvelope(original, 'decay', 0, (level - original.d1l * 3) / 96 * 100).d1l, d1l);
		}
		for (let d2r = 0; d2r <= 31; d2r++) {
			const point = module.envelopeHandlePositions({ ...original, d2r }).keyoff;
			assert.strictEqual(module.dragEnvelope(original, 'keyoff', 0, point[1] - base.keyoff[1]).d2r, d2r);
		}
		for (const kind of ['attack', 'decay', 'keyoff', 'release']) {
			assert.deepStrictEqual(module.dragEnvelope(original, kind, 0, 0), original);
		}
		assert.deepStrictEqual(module.dragEnvelope({ ...original, d1r: 0 }, 'keyoff', 0, 10), { ...original, d1r: 0 });
		assert.strictEqual(module.dragEnvelope(original, 'decay', -1000000, -1000000).d1l, 0);
		assert.strictEqual(module.dragEnvelope(original, 'decay', -1000000, 1000000).d1l, 15);
		assert.strictEqual(module.dragEnvelope(original, 'keyoff', 0, -1000000).d2r, 0);
		assert.strictEqual(module.dragEnvelope(original, 'keyoff', 0, 1000000).d2r, 31);
		assert.deepStrictEqual(module.dragEnvelope({ ...original, ar: 0 }, 'attack', 0, 0), { ...original, ar: 0 });
		assert.deepStrictEqual(module.dragEnvelope(original, 'attack', -1000000, -1000000), { ...original, ar: 31, tl: 0 });
		assert.deepStrictEqual(module.dragEnvelope(original, 'attack', 1000000, 1000000), { ...original, ar: 0, tl: 127 });
	});

	test('FM voice algorithm connections use only orthogonal paths', async () => {
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const module = await import(vscode.Uri.joinPath(extension.extensionUri, 'media', 'voiceControls.js').toString());
		assert.strictEqual(module.connectionPath([24, 52], [64, 52]), 'M 36 52 H 52');
		assert.strictEqual(module.connectionPath([24, 28], [84, 52]), 'M 36 28 H 54 V 52 H 72');
		assert.strictEqual(module.connectionPath([104, 76], [180, 52], 6), 'M 116 76 H 145 V 52 H 174');
		const con2 = module.algorithmConnections[2];
		assert.strictEqual(module.connectionPath(con2.positions[0], con2.positions[3], 12, con2.bendX),
			'M 36 28 H 114 V 52 H 132');
		assert.strictEqual(module.connectionPath(con2.positions[2], con2.positions[3], 12, con2.bendX),
			'M 96 76 H 114 V 52 H 132');
		for (const connection of module.algorithmConnections) {
			const paths = connection.edges.map(([start, end]: number[]) =>
				module.connectionPath(connection.positions[start], connection.positions[end], 12, connection.bendX));
			paths.push(...connection.carriers.map((operator: number) =>
				module.connectionPath(connection.positions[operator], [180, 52], 6)));
			for (const path of paths) {
				assert.deepStrictEqual([...path.matchAll(/[A-Za-z]/g)].map(match => match[0]),
					path.includes(' V ') ? ['M', 'H', 'V', 'H'] : ['M', 'H']);
				assert.ok(!/NaN|Infinity/.test(path));
			}
		}
	});

	test('FM voice requests convert workspace file URIs before sending', async function () {
		this.timeout(10000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const folder = vscode.workspace.workspaceFolders?.[0];
		assert.ok(folder);
		const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, 'example.mml'));
		const editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(4, 8, 4, 8);
		const context = { extensionUri: extension.extensionUri, subscriptions: [] as vscode.Disposable[] };
		const events = new vscode.EventEmitter<void>();
		const messages = new vscode.EventEmitter<unknown>();
		let deliver: (value: { voice: { number: number } }) => void = () => undefined;
		const updated = new Promise<{ voice: { number: number } }>(resolve => { deliver = resolve; });
		const client = {
			isRunning: () => true,
			code2ProtocolConverter: {
				asTextDocumentPositionParams: (document: vscode.TextDocument, position: vscode.Position) => ({
					textDocument: { uri: createUriConverters()!.code2Protocol(document.uri) },
					position: { line: position.line, character: position.character }
				})
			},
			sendRequest: async (method: string, params: { textDocument: { uri: string }; position: vscode.Position }) => {
				assert.strictEqual(method, 'mmlx/voiceAtPosition');
				assert.strictEqual(params.textDocument.uri, 'file:///workspace/example.mml');
				assert.deepStrictEqual(params.position, { line: 4, character: 8 });
				return { number: 1 };
			}
		} as unknown as LanguageClient;
		const provider = new VoiceViewProvider(context as unknown as vscode.ExtensionContext, () => client);
		const view = {
			visible: true,
			onDidChangeVisibility: events.event,
			onDidDispose: events.event,
			webview: {
				cspSource: 'https://test.invalid',
				asWebviewUri: (uri: vscode.Uri) => uri,
				onDidReceiveMessage: messages.event,
				postMessage: (message: { voice: { number: number } | null }) => {
					if (message.voice) { deliver({ voice: message.voice }); }
					return Promise.resolve(true);
				}
			}
		} as unknown as vscode.WebviewView;
		try {
			await provider.resolveWebviewView(view);
			assert.strictEqual((await updated).voice.number, 1);
		} finally {
			provider.dispose();
			for (const subscription of context.subscriptions) { subscription.dispose(); }
			events.dispose();
			messages.dispose();
		}
	});

	test('Node serial port enumeration works in the extension host', async function () {
		this.timeout(15000);
		const { autoDetect } = await import('@serialport/bindings-cpp');
		const ports = await autoDetect().list();
		assert.ok(Array.isArray(ports));
		assert.ok(ports.every(port => typeof port.path === 'string' && port.path.length > 0));
	});

	test('Node MIDI input port enumeration works in the extension host', async function () {
		this.timeout(15000);
		const ports = await listMidiInputPorts();
		assert.ok(Array.isArray(ports));
		assert.ok(ports.every(port => typeof port === 'string' && port.length > 0));
	});

	test('MIDI-IN settings list ports, save folder configuration and handle refresh failures', async function () {
		this.timeout(20000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const folder = vscode.workspace.workspaceFolders![0];
		const configuration = vscode.workspace.getConfiguration('mmlx', folder.uri);
		const setting = configuration.inspect<string>('midi.input');
		const previous = vscode.workspace.workspaceFile ? setting?.workspaceFolderValue : setting?.workspaceValue;
		const context = { extensionUri: extension.extensionUri, subscriptions: [] as vscode.Disposable[] };
		const events = new vscode.EventEmitter<void>();
		const messages = new vscode.EventEmitter<unknown>();
		type MidiMessage = { type: string; folder: string; connection: string; editable: boolean;
			loading: boolean; error: string; ports: string[] };
		const updates = new vscode.EventEmitter<MidiMessage>();
		let latest: MidiMessage | undefined;
		let ports = ['Keyboard 10', 'Keyboard 2', 'Keyboard 2', ''];
		let failure = false;
		function waitFor(predicate: (message: MidiMessage) => boolean): Promise<MidiMessage> {
			if (latest && predicate(latest)) { return Promise.resolve(latest); }
			return new Promise((resolve, reject) => {
				const subscription = updates.event(message => {
					if (predicate(message)) { clearTimeout(timeout); subscription.dispose(); resolve(message); }
				});
				const timeout = setTimeout(() => { subscription.dispose(); reject(new Error('MIDI update timed out')); }, 4000);
			});
		}
		const provider = new VoiceViewProvider(context as unknown as vscode.ExtensionContext, () => undefined, async () => [], async () => {
			if (failure) { throw new Error('MIDI enumeration failed'); }
			return ports;
		});
		const view = { visible: true, onDidChangeVisibility: events.event, onDidDispose: events.event,
			webview: { cspSource: 'https://test.invalid', asWebviewUri: (uri: vscode.Uri) => uri,
				onDidReceiveMessage: messages.event, postMessage: (message: MidiMessage) => {
					if (message.type === 'midiSettings') { latest = message; updates.fire(message); }
					return Promise.resolve(true);
				} }
		} as unknown as vscode.WebviewView;
		try {
			await provider.resolveWebviewView(view);
			messages.fire({ type: 'ready' });
			const listed = await waitFor(message => !message.loading && message.ports.length === 2);
			assert.deepStrictEqual(listed.ports, ['Keyboard 2', 'Keyboard 10']);
			messages.fire({ type: 'updateMidiInput', folder: folder.uri.toString(), value: 'Keyboard 2' });
			await waitFor(message => message.editable && message.connection === 'Keyboard 2');
			assert.strictEqual(vscode.workspace.getConfiguration('mmlx', folder.uri).get('midi.input'), 'Keyboard 2');
			const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, '.vscode', 'settings.json')));
			assert.ok(text.includes('"mmlx.midi.input"'));
			for (const value of ['Unknown keyboard', 42]) {
				messages.fire({ type: 'updateMidiInput', folder: folder.uri.toString(), value });
				assert.strictEqual(latest?.error, 'Invalid MIDI input port.');
			}
			messages.fire({ type: 'updateMidiInput', folder: 'file:///wrong-folder', value: '' });
			assert.strictEqual(vscode.workspace.getConfiguration('mmlx', folder.uri).get('midi.input'), 'Keyboard 2');
			ports = [];
			messages.fire({ type: 'getMidiInputPorts' });
			const removed = await waitFor(message => !message.loading && message.ports.length === 0);
			assert.strictEqual(removed.connection, 'Keyboard 2');
			failure = true;
			messages.fire({ type: 'getMidiInputPorts' });
			await waitFor(message => !message.loading && message.error === 'MIDI enumeration failed');
			failure = false;
			ports = ['Keyboard 2'];
			messages.fire({ type: 'getMidiInputPorts' });
			await waitFor(message => !message.loading && !message.error && message.ports.length === 1);
			messages.fire({ type: 'updateMidiInput', folder: folder.uri.toString(), value: '' });
			await waitFor(message => message.editable && message.connection === '');
			await configuration.update('midi.input', 'External keyboard', vscode.ConfigurationTarget.WorkspaceFolder);
			await waitFor(message => message.connection === 'External keyboard');
		} finally {
			provider.dispose();
			for (const subscription of context.subscriptions) { subscription.dispose(); }
			await configuration.update('midi.input', previous, vscode.ConfigurationTarget.WorkspaceFolder);
			events.dispose(); messages.dispose(); updates.dispose();
		}
	});

	test('Connection settings list serial ports, save folder configuration and handle refresh failures', async function () {
		this.timeout(20000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const folder = vscode.workspace.workspaceFolders![0];
		const configuration = vscode.workspace.getConfiguration('mmlx', folder.uri);
		const setting = configuration.inspect<string>('serial.connection');
		const previous = vscode.workspace.workspaceFile ? setting?.workspaceFolderValue : setting?.workspaceValue;
		const context = { extensionUri: extension.extensionUri, subscriptions: [] as vscode.Disposable[] };
		const events = new vscode.EventEmitter<void>();
		const messages = new vscode.EventEmitter<unknown>();
		type SerialMessage = { type: string; folder: string; connection: string; editable: boolean;
			loading: boolean; error: string; ports: { path: string; manufacturer?: string }[] };
		const updates = new vscode.EventEmitter<SerialMessage>();
		let latest: SerialMessage | undefined;
		let ports = [{ path: '/dev/ttyUSB10', manufacturer: 'NanoDrive8' }, { path: '/dev/ttyUSB2', manufacturer: 'USB' },
			{ path: '/dev/ttyUSB2', manufacturer: 'USB' }];
		let failure = false;
		function waitFor(predicate: (message: SerialMessage) => boolean): Promise<SerialMessage> {
			if (latest && predicate(latest)) { return Promise.resolve(latest); }
			return new Promise((resolve, reject) => {
				const subscription = updates.event(message => {
					if (predicate(message)) { clearTimeout(timeout); subscription.dispose(); resolve(message); }
				});
				const timeout = setTimeout(() => { subscription.dispose(); reject(new Error('Serial update timed out')); }, 4000);
			});
		}
		const provider = new VoiceViewProvider(context as unknown as vscode.ExtensionContext, () => undefined, async () => {
			if (failure) { throw new Error('Enumeration failed'); }
			return ports;
		});
		const view = { visible: true, onDidChangeVisibility: events.event, onDidDispose: events.event,
			webview: { cspSource: 'https://test.invalid', asWebviewUri: (uri: vscode.Uri) => uri,
				onDidReceiveMessage: messages.event, postMessage: (message: SerialMessage) => {
					if (message.type === 'serialSettings') { latest = message; updates.fire(message); }
					return Promise.resolve(true);
				} }
		} as unknown as vscode.WebviewView;
		try {
			await provider.resolveWebviewView(view);
			messages.fire({ type: 'ready' });
			const listed = await waitFor(message => !message.loading && message.ports.length === 2);
			assert.deepStrictEqual(listed.ports.map(port => port.path), ['/dev/ttyUSB2', '/dev/ttyUSB10']);
			assert.strictEqual(listed.ports[1].manufacturer, 'NanoDrive8');
			messages.fire({ type: 'updateSerialConnection', folder: folder.uri.toString(), value: '/dev/ttyUSB2' });
			await waitFor(message => message.editable && message.connection === '/dev/ttyUSB2');
			assert.strictEqual(vscode.workspace.getConfiguration('mmlx', folder.uri).get('serial.connection'), '/dev/ttyUSB2');
			const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, '.vscode', 'settings.json')));
			assert.ok(text.includes('"mmlx.serial.connection"'));
			for (const value of ['/dev/unknown', 42]) {
				messages.fire({ type: 'updateSerialConnection', folder: folder.uri.toString(), value });
				assert.strictEqual(latest?.error, 'Invalid serial port.');
			}
			messages.fire({ type: 'updateSerialConnection', folder: 'file:///wrong-folder', value: '' });
			assert.strictEqual(vscode.workspace.getConfiguration('mmlx', folder.uri).get('serial.connection'), '/dev/ttyUSB2');
			ports = [];
			messages.fire({ type: 'getSerialPorts' });
			const removed = await waitFor(message => !message.loading && message.ports.length === 0);
			assert.strictEqual(removed.connection, '/dev/ttyUSB2');
			failure = true;
			messages.fire({ type: 'getSerialPorts' });
			await waitFor(message => !message.loading && message.error === 'Enumeration failed');
			messages.fire({ type: 'updateSerialConnection', folder: folder.uri.toString(), value: '' });
			await waitFor(message => message.editable && message.connection === '');
			await configuration.update('serial.connection', '/dev/external', vscode.ConfigurationTarget.WorkspaceFolder);
			await waitFor(message => message.connection === '/dev/external');
		} finally {
			provider.dispose();
			for (const subscription of context.subscriptions) { subscription.dispose(); }
			await configuration.update('serial.connection', previous, vscode.ConfigurationTarget.WorkspaceFolder);
			events.dispose(); messages.dispose(); updates.dispose();
		}
	});

	test('Build settings panel saves folder configuration and rejects invalid or stale requests', async function () {
		this.timeout(20000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const folder = vscode.workspace.workspaceFolders?.[0];
		assert.ok(folder);
		const configuration = vscode.workspace.getConfiguration('mmlx', folder.uri);
		const keys = ['format', 'onSave', 'adpcmMode', 'loopCount', 'maxTicks', 'pdx', 'outputDirectory'];
		const previous = keys.map(key => {
			const setting = configuration.inspect(`build.${key}`);
			return vscode.workspace.workspaceFile ? setting?.workspaceFolderValue : setting?.workspaceValue;
		});
		const context = { extensionUri: extension.extensionUri, subscriptions: [] as vscode.Disposable[] };
		const events = new vscode.EventEmitter<void>();
		const messages = new vscode.EventEmitter<unknown>();
		type SettingsMessage = { type: string; folder: string; editable: boolean; saving: boolean;
			error: string; values: Record<string, unknown> };
		const updates = new vscode.EventEmitter<SettingsMessage>();
		let latest: SettingsMessage | undefined;
		function waitFor(predicate: (message: SettingsMessage) => boolean): Promise<SettingsMessage> {
			if (latest && predicate(latest)) { return Promise.resolve(latest); }
			return new Promise((resolve, reject) => {
				const subscription = updates.event(message => {
					if (predicate(message)) { clearTimeout(timeout); subscription.dispose(); resolve(message); }
				});
				const timeout = setTimeout(() => { subscription.dispose(); reject(new Error('Settings update timed out')); }, 4000);
			});
		}
		const provider = new VoiceViewProvider(context as unknown as vscode.ExtensionContext, () => undefined);
		const view = { visible: true, onDidChangeVisibility: events.event, onDidDispose: events.event,
			webview: { cspSource: 'https://test.invalid', asWebviewUri: (uri: vscode.Uri) => uri,
				onDidReceiveMessage: messages.event, postMessage: (message: SettingsMessage) => {
					if (message.type === 'buildSettings') { latest = message; updates.fire(message); }
					return Promise.resolve(true);
				} }
		} as unknown as vscode.WebviewView;
		try {
			await provider.resolveWebviewView(view);
			await waitFor(message => message.editable && message.folder === folder.uri.toString());
			for (const [key, value] of [['format', 'vgm'], ['onSave', false], ['adpcmMode', 'lpf'], ['loopCount', 3],
				['maxTicks', 123456], ['pdx', 'samples/test.pdx'], ['outputDirectory', 'generated']] as const) {
				messages.fire({ type: 'updateBuildSetting', folder: folder.uri.toString(), key, value });
				await waitFor(message => message.editable && !message.saving && message.values[key] === value);
				assert.strictEqual(vscode.workspace.getConfiguration('mmlx', folder.uri).get(`build.${key}`), value);
			}
			const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, '.vscode', 'settings.json')));
			assert.ok(text.includes('"mmlx.build.format"'));
			assert.ok(text.includes('"mmlx.build.maxTicks"'));
			for (const [key, value] of [['format', 'invalid'], ['loopCount', -1], ['maxTicks', 0], ['outputDirectory', '']] as const) {
				messages.fire({ type: 'updateBuildSetting', folder: folder.uri.toString(), key, value });
				assert.ok(latest?.error);
			}
			messages.fire({ type: 'updateBuildSetting', folder: 'file:///wrong-folder', key: 'format', value: 'mdx' });
			assert.strictEqual(vscode.workspace.getConfiguration('mmlx', folder.uri).get('build.format'), 'vgm');
			await configuration.update('build.format', 'mdx', vscode.ConfigurationTarget.WorkspaceFolder);
			await waitFor(message => message.values.format === 'mdx');
		} finally {
			provider.dispose();
			for (const subscription of context.subscriptions) { subscription.dispose(); }
			for (const [index, key] of keys.entries()) {
				await configuration.update(`build.${key}`, previous[index], vscode.ConfigurationTarget.WorkspaceFolder);
			}
			events.dispose(); messages.dispose(); updates.dispose();
		}
	});

	test('FM voice edits preserve source and support undo while rejecting stale and invalid changes', async function () {
		this.timeout(20000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const source = '/* 日本 🎵 */ @7 = {\n' + '31, 12,  4,  8,  6,  20, 1,  2, 3, 1, 0,\n'.repeat(4) + '5,3,15\n}\nA @7 c4\n';
		const document = await vscode.workspace.openTextDocument({ language: 'mmlx', content: source });
		const editor = await vscode.window.showTextDocument(document);
		const position = document.positionAt(source.indexOf('@7'));
		editor.selection = new vscode.Selection(position, position);
		const context = { extensionUri: extension.extensionUri, subscriptions: [] as vscode.Disposable[] };
		const events = new vscode.EventEmitter<void>();
		const messages = new vscode.EventEmitter<unknown>();
		type PanelMessage = { type: string; editable: boolean; editToken: number | null; retained: boolean;
			voice: { algorithm: number; operators: Record<string, number>[] } };
		const updates = new vscode.EventEmitter<PanelMessage>();
		let latest: PanelMessage | undefined;
		function waitFor(predicate: (message: PanelMessage) => boolean): Promise<PanelMessage> {
			if (latest && predicate(latest)) { return Promise.resolve(latest); }
			return new Promise((resolve, reject) => {
				const subscription = updates.event(message => {
					if (predicate(message)) { clearTimeout(timeout); subscription.dispose(); resolve(message); }
				});
				const timeout = setTimeout(() => { subscription.dispose(); reject(new Error('Voice update timed out')); }, 4000);
			});
		}
		let voiceRequests = 0;
		let voiceUpdates = 0;
		const client = {
			isRunning: () => true,
			code2ProtocolConverter: { asTextDocumentPositionParams: (_document: vscode.TextDocument, position: vscode.Position) => ({ position }) },
			sendRequest: async (_method: string, params: { position: vscode.Position }) => {
				voiceRequests++;
				const text = document.getText();
				const offset = document.offsetAt(new vscode.Position(params.position.line, params.position.character));
				if (offset < text.indexOf('@7') || offset > text.indexOf('}')) { return null; }
				const start = text.indexOf('{') + 1;
				const matches = [...text.slice(start, text.indexOf('}')).matchAll(/\d+/g)];
				const values = matches.map(match => Number(match[0]));
				const fields = ['ar', 'd1r', 'd2r', 'rr', 'd1l', 'tl', 'ks', 'mul', 'dt1', 'dt2', 'ame'];
				return { number: 7, algorithm: values[44], feedback: values[45], operatorMask: values[46],
					position: document.positionAt(text.indexOf('@7')),
					range: { start: document.positionAt(text.indexOf('@7')), end: document.positionAt(text.indexOf('}') + 1) },
					parameterRanges: matches.map(match => ({ start: document.positionAt(start + match.index),
						end: document.positionAt(start + match.index + match[0].length) })),
					operators: Array.from({ length: 4 }, (_, operator) =>
						Object.fromEntries(fields.map((field, index) => [field, values[operator * 11 + index]]))) };
			}
		} as unknown as LanguageClient;
		const provider = new VoiceViewProvider(context as unknown as vscode.ExtensionContext, () => client);
		const view = { visible: true, onDidChangeVisibility: events.event, onDidDispose: events.event,
			webview: { cspSource: 'https://test.invalid', asWebviewUri: (uri: vscode.Uri) => uri,
				onDidReceiveMessage: messages.event, postMessage: (message: PanelMessage) => {
					if (message.type === 'voice') { voiceUpdates++; latest = message; updates.fire(message); }
					return Promise.resolve(true);
				} }
		} as unknown as vscode.WebviewView;
		try {
			await provider.resolveWebviewView(view);
			const baseline = await waitFor(message => message.editable);
			const baselineVersion = document.version;
			const baselineRequests = voiceRequests;
			const baselineUpdates = voiceUpdates;
			for (const offset of [source.indexOf('12,'), source.indexOf('5,3,15'), source.indexOf('}')]) {
				const selected = document.positionAt(offset);
				editor.selection = new vscode.Selection(selected, selected);
				await new Promise(resolve => setTimeout(resolve, 180));
				assert.strictEqual(voiceRequests, baselineRequests, 'Same-voice movement must not request a reload');
				assert.strictEqual(voiceUpdates, baselineUpdates, 'Same-voice movement must not redraw or disable controls');
				assert.strictEqual(latest?.editToken, baseline.editToken);
				assert.ok(latest?.editable);
			}
			for (const changes of [[], null, [null], [{ index: 0, value: 20 }, { index: 5, value: 128 }],
				[{ index: 0, value: 20 }, { index: 0, value: 21 }]]) {
				messages.fire({ type: 'editVoice', token: baseline.editToken, changes });
			}
			assert.strictEqual(document.version, baselineVersion);
			messages.fire({ type: 'editVoice', token: baseline.editToken, changes: [{ index: 0, value: 5 }, { index: 5, value: 127 }] });
			await waitFor(message => message.editable && message.voice.operators[0].ar === 5 && message.voice.operators[0].tl === 127);
			const grouped = source.replace('31, 12', ' 5, 12').replace('  20', ' 127');
			assert.strictEqual(document.getText(), grouped);
			assert.deepStrictEqual(document.getText().split('\n').map(line => [...line.matchAll(/,/g)].map(match => match.index)),
				source.split('\n').map(line => [...line.matchAll(/,/g)].map(match => match.index)));
			await vscode.commands.executeCommand('undo');
			await waitFor(message => message.editable && message.voice.operators[0].ar === 31 && message.voice.operators[0].tl === 20);
			assert.strictEqual(document.getText(), source);
			await vscode.commands.executeCommand('redo');
			await waitFor(message => message.editable && message.voice.operators[0].ar === 5 && message.voice.operators[0].tl === 127);
			assert.strictEqual(document.getText(), grouped);
			await vscode.commands.executeCommand('undo');
			await waitFor(message => message.editable && message.voice.operators[0].ar === 31 && message.voice.operators[0].tl === 20);
			const initial = await waitFor(message => message.editable);
			messages.fire({ type: 'editVoice', token: initial.editToken, index: 5, value: 99 });
			messages.fire({ type: 'editVoice', token: initial.editToken, index: 44, value: 6 });
			const edited = await waitFor(message => message.editable && message.voice.operators[0].tl === 99);
			const expected = source.replace('  20', '  99');
			assert.strictEqual(document.getText(), expected);
			const version = document.version;
			for (const request of [
				{ token: initial.editToken, index: 44, value: 6 },
				{ token: edited.editToken, index: 5, value: 128 },
				{ token: edited.editToken, index: 44, value: 8 },
				{ token: edited.editToken, index: 45, value: 8 },
				{ token: edited.editToken, index: 46, value: 16 },
				{ token: edited.editToken, index: -1, value: 0 },
				{ token: edited.editToken, index: 47, value: 0 },
				{ token: edited.editToken, index: 5, value: -1 },
				{ token: edited.editToken, index: 5, value: 1.5 }
			]) { messages.fire({ type: 'editVoice', ...request }); }
			assert.strictEqual(document.version, version);
			await vscode.commands.executeCommand('undo');
			await waitFor(message => message.editable && message.voice.operators[0].tl === 20);
			assert.strictEqual(document.getText(), source);
			await vscode.commands.executeCommand('redo');
			const redone = await waitFor(message => message.editable && message.voice.operators[0].tl === 99);
			assert.strictEqual(document.getText(), expected);
			const prefix = '/* external edit */\n';
			const external = new vscode.WorkspaceEdit();
			external.insert(document.uri, new vscode.Position(0, 0), prefix);
			assert.ok(await vscode.workspace.applyEdit(external));
			messages.fire({ type: 'editVoice', token: redone.editToken, index: 44, value: 7 });
			const refreshed = await waitFor(message => message.editable && message.editToken !== redone.editToken);
			assert.strictEqual(document.getText(), prefix + expected);
			messages.fire({ type: 'editVoice', token: refreshed.editToken, index: 44, value: 6 });
			const changed = await waitFor(message => message.editable && message.voice.algorithm === 6);
			assert.strictEqual(document.getText(), prefix + expected.replace('5,3,15', '6,3,15'));
			const outside = document.positionAt(document.getText().indexOf('A @7'));
			editor.selection = new vscode.Selection(outside, outside);
			await waitFor(message => message.retained && !message.editable);
			messages.fire({ type: 'editVoice', token: changed.editToken, index: 44, value: 7 });
			assert.strictEqual(document.getText(), prefix + expected.replace('5,3,15', '6,3,15'));
			const compact = source.replace(/, +/g, ',').replaceAll('\n31,', '\n\t31,')
				.replace('@7 = {\n', '@7 = {\n/* operators */\n').replaceAll('\n', '\r\n');
			const reset = new vscode.WorkspaceEdit();
			reset.set(document.uri, [vscode.TextEdit.replace(new vscode.Range(document.positionAt(0),
				document.positionAt(document.getText().length)), compact), vscode.TextEdit.setEndOfLine(vscode.EndOfLine.CRLF)]);
			assert.ok(await vscode.workspace.applyEdit(reset));
			const selected = document.positionAt(document.getText().indexOf('@7'));
			editor.selection = new vscode.Selection(selected, selected);
			const compactVoice = await waitFor(message => message.editable && message.voice.operators[0].tl === 20);
			messages.fire({ type: 'editVoice', token: compactVoice.editToken, changes: [{ index: 0, value: 5 }, { index: 5, value: 127 }] });
			const alignedVoice = await waitFor(message => message.editable && message.voice.operators[0].tl === 127);
			const aligned = compact.replace('31,12,4,8,6,20,1,2,3,1,0,', ' 5,12, 4, 8, 6,127,1, 2,3,1,0,')
				.replaceAll('31,12,4,8,6,20,1,2,3,1,0,', '31,12, 4, 8, 6, 20,1, 2,3,1,0,');
			assert.strictEqual(document.getText(), aligned);
			messages.fire({ type: 'editVoice', token: alignedVoice.editToken, changes: [{ index: 0, value: 31 }, { index: 5, value: 0 }] });
			await waitFor(message => message.editable && message.voice.operators[0].tl === 0);
			assert.strictEqual(document.getText(), aligned.replace(' 5,12', '31,12').replace('6,127', '6,  0'));
			assert.deepStrictEqual(document.getText().split('\r\n').map(line => [...line.matchAll(/,/g)].map(match => match.index)),
				aligned.split('\r\n').map(line => [...line.matchAll(/,/g)].map(match => match.index)));
			await vscode.commands.executeCommand('undo');
			await waitFor(message => message.editable && message.voice.operators[0].tl === 127);
			assert.strictEqual(document.getText(), aligned);
			await vscode.commands.executeCommand('undo');
			await waitFor(message => message.editable && message.voice.operators[0].tl === 20);
			assert.strictEqual(document.getText(), compact);
		} finally {
			provider.dispose();
			for (const subscription of context.subscriptions) { subscription.dispose(); }
			events.dispose(); messages.dispose(); updates.dispose();
			await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
		}
	});

	test('initializes MDX diagnostics and completion with an explicit dialect', async function () {
		this.timeout(30000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const setting = extension.packageJSON.contributes.configuration.properties['mmlx.dialect'];
		assert.strictEqual(setting.default, 'mdx');
		assert.deepStrictEqual(setting.enum, ['mdx']);
		await extension.activate();
		const configuration = vscode.workspace.getConfiguration('mmlx');
		const previous = configuration.inspect<string>('dialect')?.workspaceValue;
		try {
			await configuration.update('dialect', 'mdx', vscode.ConfigurationTarget.Workspace);
			await vscode.commands.executeCommand('mmlx.restartLanguageServer');
			const document = await vscode.workspace.openTextDocument({ language: 'mmlx', content: 'A @42 c4' });
			await waitForDiagnostics(document.uri, 1);
			const diagnostic = vscode.languages.getDiagnostics(document.uri).find(item => item.source === 'mmlx');
			assert.strictEqual(diagnostic?.code, 'mmlx.mdx.playback');
			const completionDocument = await vscode.workspace.openTextDocument({ language: 'mmlx', content: 'A ' });
			const result = await vscode.commands.executeCommand<vscode.CompletionList>(
				'vscode.executeCompletionItemProvider', completionDocument.uri, new vscode.Position(0, 2));
			assert.ok(result?.items.some(item => item.filterText === '@t'));
		} finally {
			await configuration.update('dialect', previous, vscode.ConfigurationTarget.Workspace);
			await vscode.commands.executeCommand('mmlx.restartLanguageServer');
		}
	});

	test('activates the development extension and publishes diagnostics', async function () {
		this.timeout(30000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension, 'mmlx-lsp is not registered in the development host');
		await extension.activate();
		assert.ok(extension.isActive);
		const document = await vscode.workspace.openTextDocument({ language: 'mmlx', content: 'A [' });
		await waitForDiagnostics(document.uri, 1);
		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), 'A c4');
		assert.ok(await vscode.workspace.applyEdit(edit));
		await waitForDiagnostics(document.uri, 0);
	});

	test('reports mapped playback errors and clears them for PCM banks', async function () {
		this.timeout(30000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		await extension.activate();
		const document = await vscode.workspace.openTextDocument({ language: 'mmlx', content: 'A @42 c4' });
		await waitForDiagnostics(document.uri, 1);
		const diagnostic = vscode.languages.getDiagnostics(document.uri).find(item => item.source === 'mmlx');
		assert.ok(diagnostic);
		assert.ok(diagnostic.message.includes('missing tone for voice 42'));
		assert.strictEqual(diagnostic.code, 'mmlx.mdx.playback');
		assert.ok(diagnostic.range.isEqual(new vscode.Range(0, 6, 0, 8)));
		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), 'P @2 c4');
		assert.ok(await vscode.workspace.applyEdit(edit));
		await waitForDiagnostics(document.uri, 0);
	});

	test('provides AST semantic tokens and updates them after an edit', async function () {
		this.timeout(30000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		await extension.activate();
		const document = await vscode.workspace.openTextDocument({ language: 'mmlx', content: 'A t120 c4 r8' });
		const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>(
			'vscode.provideDocumentSemanticTokensLegend', document.uri);
		assert.ok(legend);
		assert.strictEqual(legend.tokenTypes[1], 'mmlxNote');
		const noteType = extension.packageJSON.contributes.semanticTokenTypes.find((type: { id: string }) => type.id === 'mmlxNote');
		assert.ok(noteType);
		assert.strictEqual(noteType.superType, undefined);
		assert.deepStrictEqual(extension.packageJSON.contributes.semanticTokenScopes[0].scopes.mmlxNote, ['meta.note.mmlx']);
		const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>(
			'vscode.provideDocumentSemanticTokens', document.uri);
		assert.ok(tokens);
		assert.strictEqual(tokens.data.length, 30);
		assert.deepStrictEqual(Array.from(tokens.data).filter((_, index) => index % 5 === 3), [0, 2, 1, 2, 6, 2]);
		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), 'A d8');
		assert.ok(await vscode.workspace.applyEdit(edit));
		const updated = await vscode.commands.executeCommand<vscode.SemanticTokens>(
			'vscode.provideDocumentSemanticTokens', document.uri);
		assert.ok(updated);
		assert.deepStrictEqual(Array.from(updated.data), [0, 2, 1, 1, 0, 0, 1, 1, 2, 0]);
	});

	test('provides documented control-command snippets and replaces the prefix', async function () {
		this.timeout(30000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		await extension.activate();
		const document = await vscode.workspace.openTextDocument({ language: 'mmlx', content: 'A @' });
		const result = await vscode.commands.executeCommand<vscode.CompletionList>(
			'vscode.executeCompletionItemProvider', document.uri, new vscode.Position(0, 3), '@');
		assert.ok(result);
		const gate = result.items.find(item => item.label === '@q(ゲート値)');
		assert.ok(gate);
		assert.strictEqual(gate.kind, vscode.CompletionItemKind.Function);
		assert.strictEqual(gate.filterText, '@q');
		assert.ok(gate.insertText instanceof vscode.SnippetString);
		assert.strictEqual(gate.insertText.value, '@q${1:1}');
		assert.ok(gate.range instanceof vscode.Range);
		assert.ok(gate.range.isEqual(new vscode.Range(0, 2, 0, 3)));
		assert.ok(gate.documentation instanceof vscode.MarkdownString);
		assert.ok(gate.documentation.value.includes('soundlog'));
		assert.strictEqual(gate.command?.command, 'editor.action.triggerParameterHints');
		const editor = await vscode.window.showTextDocument(document);
		assert.ok(await editor.insertSnippet(gate.insertText, gate.range));
		assert.strictEqual(document.getText(), 'A @q1');
		const separator = new vscode.WorkspaceEdit();
		separator.insert(document.uri, document.positionAt(document.getText().length), ' ');
		assert.ok(await vscode.workspace.applyEdit(separator));
		const all = await vscode.commands.executeCommand<vscode.CompletionList>(
			'vscode.executeCompletionItemProvider', document.uri, new vscode.Position(0, 6));
		assert.ok(all);
		const pan = all.items.find(item => item.label === 'p(パン)');
		assert.ok(pan?.documentation instanceof vscode.MarkdownString);
		assert.ok(pan.documentation.value.includes('1 は FM で右・PCM で左'));
		assert.strictEqual(all.items.find(item => item.label === '[')?.kind, vscode.CompletionItemKind.Operator);
		const lfoDocument = await vscode.workspace.openTextDocument({ language: 'mmlx', content: 'A MP' });
		const lfo = await vscode.commands.executeCommand<vscode.CompletionList>(
			'vscode.executeCompletionItemProvider', lfoDocument.uri, new vscode.Position(0, 4));
		assert.ok(lfo);
		assert.deepStrictEqual(lfo.items.map(item => item.label).sort(), ['MP(波形, 周期, 深さ)', 'MPOF()', 'MPON()']);
		assert.ok(lfo.items.every(item => item.kind === vscode.CompletionItemKind.Function));
		const pendingHint = await vscode.commands.executeCommand<vscode.SignatureHelp>(
			'vscode.executeSignatureHelpProvider', lfoDocument.uri, new vscode.Position(0, 4));
		assert.ok(!pendingHint || pendingHint.signatures.length === 0);
		const comment = await vscode.workspace.openTextDocument({ language: 'mmlx', content: 'A /* @' });
		const suppressed = await vscode.commands.executeCommand<vscode.CompletionList>(
			'vscode.executeCompletionItemProvider', comment.uri, new vscode.Position(0, 6));
		assert.ok(!(suppressed?.items ?? []).some(item => item.documentation instanceof vscode.MarkdownString && item.documentation.value.includes('soundlog')));
	});

	test('inserts the voice definition template with an editable voice number', async function () {
		this.timeout(30000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		await extension.activate();
		const document = await vscode.workspace.openTextDocument({ language: 'mmlx', content: '@' });
		await waitForDiagnostics(document.uri, 1);
		const result = await vscode.commands.executeCommand<vscode.CompletionList>(
			'vscode.executeCompletionItemProvider', document.uri, new vscode.Position(0, 1), '@');
		const voice = result?.items.find(item => item.label === '@ 音色定義');
		assert.ok(voice);
		assert.strictEqual(voice.kind, vscode.CompletionItemKind.Snippet);
		assert.strictEqual(voice.keepWhitespace, true);
		assert.ok(voice.insertText instanceof vscode.SnippetString);
		assert.ok(voice.range instanceof vscode.Range);
		assert.ok(voice.range.isEqual(new vscode.Range(0, 0, 0, 1)));
		const editor = await vscode.window.showTextDocument(document);
		assert.ok(await editor.insertSnippet(voice.insertText, voice.range, {
			undoStopBefore: true,
			undoStopAfter: true,
			keepWhitespace: voice.keepWhitespace,
		}));
		const expected = [
			'@1 = {',
			'    /* AR  D1R D2R RR D1L TL  KS MUL DT1 DT2 AME */',
			'       28, 4,  0,  5, 1,  37, 2, 1,  7,  0,  0,',
			'       22, 9,  1,  2, 1,  47, 2, 12, 0,  0,  0,',
			'       29, 4,  3,  6, 1,  37, 1, 3,  3,  0,  0,',
			'       15, 7,  0,  5, 10,  0, 2, 1,  0,  0,  1,',
			'    /* CON FL OP */',
			'       2,  7, 15',
			'}',
		];
		assert.strictEqual(voice.insertText.value, expected.join('\n').replace('@1', '@${1:1}') + '$0');
		assert.deepStrictEqual(document.getText().split('\n').map(line => line.trimStart()),
			expected.map(line => line.trimStart()));
		assert.strictEqual(document.getText(editor.selection), '1');
		await vscode.commands.executeCommand('type', { text: '7' });
		assert.ok(document.getText().startsWith('@7 = {'));
		await vscode.commands.executeCommand('jumpToNextSnippetPlaceholder');
		assert.ok(editor.selection.active.isEqual(document.positionAt(document.getText().length)));
		await waitForDiagnostics(document.uri, 0);
	});

	test('enables documentation controls and supplies the full tempo description', async function () {
		this.timeout(30000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		await extension.activate();
		const document = await vscode.workspace.openTextDocument({ language: 'mmlx', content: 'A ' });
		const configuration = vscode.workspace.getConfiguration('editor', document);
		assert.strictEqual(configuration.get<boolean>('suggest.showStatusBar'), true);
		const result = await vscode.commands.executeCommand<vscode.CompletionList>(
			'vscode.executeCompletionItemProvider', document.uri, new vscode.Position(0, 2));
		const tempo = result?.items.find(item => item.label === 't(BPM)');
		assert.ok(tempo);
		assert.strictEqual(tempo.kind, vscode.CompletionItemKind.Function);
		assert.strictEqual(tempo.filterText, 't');
		assert.strictEqual(tempo.detail, 't<19..4882 BPM>');
		assert.ok(tempo.documentation instanceof vscode.MarkdownString);
		assert.ok(tempo.documentation.value.includes('テンポを BPM で指定します。'));
		assert.ok(tempo.documentation.value.includes('全トラック共通のテンポを変更します。'));
	});

	test('provides argument hints without competing command completions while entering arguments', async function () {
		this.timeout(30000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		await extension.activate();
		const document = await vscode.workspace.openTextDocument({ language: 'mmlx', content: 'A t' });
		const editor = await vscode.window.showTextDocument(document);
		for (const [source, label, parameter] of [
			['A t', 't(BPM)', 0],
			['A @q', '@q(ゲート値)', 0],
			['A @q123', '@q(ゲート値)', 0],
			['A [c4]2', '](回数)', 0],
			['A MP0,', 'MP(波形, 周期, 深さ)', 1],
			['A MP0,16,', 'MP(波形, 周期, 深さ)', 2],
			['A MH0,128,', 'MH(波形, LFRQ, PMD, AMD, PMS, AMS, キー同期)', 2],
		] as const) {
			const edit = new vscode.WorkspaceEdit();
			edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), source);
			assert.ok(await vscode.workspace.applyEdit(edit));
			const position = document.positionAt(source.length);
			editor.selection = new vscode.Selection(position, position);
			const help = await vscode.commands.executeCommand<vscode.SignatureHelp>(
				'vscode.executeSignatureHelpProvider', document.uri, document.positionAt(source.length));
			assert.ok(help);
			assert.strictEqual(help.activeParameter, parameter);
			assert.strictEqual(help.signatures[0].label, label);
			assert.ok(help.signatures[0].documentation instanceof vscode.MarkdownString);
			assert.ok(help.signatures[0].documentation.value.includes('soundlog'));
			const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
				'vscode.executeCompletionItemProvider', document.uri, document.positionAt(source.length));
			assert.ok(!(completions?.items ?? []).some(item => item.documentation instanceof vscode.MarkdownString && item.documentation.value.includes('soundlog')));
			if (source === 'A MP0,') {
				assert.deepStrictEqual(help.signatures[0].parameters[1].label, [7, 9]);
			}
		}
		for (const source of ['A [c4]2 ', 'A t120 ', 'A @q123 ', 'A MP0,16,1 ', 'A MP0,16,1 c4', 'A MP0, /* comment', 'A MPON']) {
			const edit = new vscode.WorkspaceEdit();
			edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), source);
			assert.ok(await vscode.workspace.applyEdit(edit));
			const help = await vscode.commands.executeCommand<vscode.SignatureHelp>(
				'vscode.executeSignatureHelpProvider', document.uri, document.positionAt(source.length));
			assert.ok(!help || help.signatures.length === 0);
		}
		for (const source of ['A MP0, ', 'A MP0,16, ', 'A D- ', 'A t ']) {
			const edit = new vscode.WorkspaceEdit();
			edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), source);
			assert.ok(await vscode.workspace.applyEdit(edit));
			const help = await vscode.commands.executeCommand<vscode.SignatureHelp>(
				'vscode.executeSignatureHelpProvider', document.uri, document.positionAt(source.length));
			assert.ok(help?.signatures.length, source);
		}
	});

	test('switches completion and argument hints between English and Japanese', async function () {
		this.timeout(30000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		await extension.activate();
		const configuration = vscode.workspace.getConfiguration('mmlx');
		const previous = configuration.inspect<string>('language')?.workspaceValue;
		const document = await vscode.workspace.openTextDocument({ language: 'mmlx', content: 'A MP' });
		try {
			await configuration.update('language', 'en', vscode.ConfigurationTarget.Workspace);
			await vscode.commands.executeCommand('mmlx.restartLanguageServer');
			const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
				'vscode.executeCompletionItemProvider', document.uri, new vscode.Position(0, 4));
			const pitch = completions?.items.find(item => item.filterText === 'MP');
			assert.ok(pitch);
			assert.strictEqual(pitch.label, 'MP(waveform, period, depth)');
			assert.ok(pitch.documentation instanceof vscode.MarkdownString);
			assert.ok(pitch.documentation.value.includes('software pitch LFO'));
			assert.ok(pitch.insertText instanceof vscode.SnippetString);
			assert.strictEqual(pitch.insertText.value, 'MP${1:0},${2:16},${3:1}');
			const edit = new vscode.WorkspaceEdit();
			edit.insert(document.uri, new vscode.Position(0, 4), '0,');
			assert.ok(await vscode.workspace.applyEdit(edit));
			const help = await vscode.commands.executeCommand<vscode.SignatureHelp>(
				'vscode.executeSignatureHelpProvider', document.uri, new vscode.Position(0, 6));
			assert.ok(help);
			assert.strictEqual(help.signatures[0].label, 'MP(waveform, period, depth)');
			assert.strictEqual(help.activeParameter, 1);
			assert.deepStrictEqual(help.signatures[0].parameters[1].label, [13, 19]);
		} finally {
			await configuration.update('language', previous, vscode.ConfigurationTarget.Workspace);
			await vscode.commands.executeCommand('mmlx.restartLanguageServer');
		}
		const restored = await vscode.commands.executeCommand<vscode.SignatureHelp>(
			'vscode.executeSignatureHelpProvider', document.uri, new vscode.Position(0, 6));
		assert.ok(restored);
		assert.strictEqual(restored.signatures[0].label, 'MP(波形, 周期, 深さ)');
		assert.deepStrictEqual(restored.signatures[0].parameters[1].label, [7, 9]);
	});

	suite('build tasks', () => {
		let directory: vscode.Uri;
		let outputs: vscode.Uri[];
		setup(async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			assert.ok(folder);
			directory = vscode.Uri.joinPath(folder.uri, `build-test-${Date.now()}`);
			outputs = [];
			await vscode.workspace.fs.createDirectory(directory);
		});
		teardown(async () => {
			await vscode.workspace.fs.delete(directory, { recursive: true });
			for (const output of outputs) {
				await vscode.workspace.fs.delete(output).then(undefined, () => undefined);
			}
		});

		test('discovers default and individual build tasks and commands', async () => {
			const available = await vscode.tasks.fetchTasks({ type: 'mmlx' });
			assert.deepStrictEqual(available.map(task => task.definition.format ?? 'default').sort(), ['default', 'mdx', 'vgm']);
			assert.ok(available.every(task => task.group?.id === vscode.TaskGroup.Build.id));
			const commands = await vscode.commands.getCommands();
			assert.ok(commands.includes('mmlx.build'));
			assert.ok(commands.includes('mmlx.buildMdx'));
			assert.ok(commands.includes('mmlx.buildVgm'));
		});

		suite('build on save', () => {
			let configuration: vscode.WorkspaceConfiguration;
			let previous: (boolean | string | undefined)[];
			const properties = ['build.onSave', 'build.format', 'build.outputDirectory'];
			setup(async () => {
				configuration = vscode.workspace.getConfiguration('mmlx', directory);
				previous = properties.map(property => configuration.inspect<boolean | string>(property)?.workspaceValue);
				await configuration.update('build.outputDirectory', vscode.Uri.joinPath(directory, 'generated').fsPath,
					vscode.ConfigurationTarget.Workspace);
			});
			teardown(async () => {
				for (const [index, property] of properties.entries()) {
					await configuration.update(property, previous[index], vscode.ConfigurationTarget.Workspace);
				}
			});

			test('does not build on save by default', async function () {
				this.timeout(60000);
				assert.strictEqual(configuration.get('build.onSave'), false);
				const input = vscode.Uri.joinPath(directory, 'disabled.mml');
				await vscode.workspace.fs.writeFile(input, new TextEncoder().encode('A r4'));
				const document = await vscode.workspace.openTextDocument(input);
				const observer = observeBuilds(input);
				try {
					await editSource(document, 'A r8');
					assert.ok(await document.save());
					await assert.rejects(observer.waitFor(1, 600), /Timed out/);
					assert.strictEqual(observer.started, 0);
				} finally { observer.dispose(); }
			});

			test('combines consecutive saves and uses configured formats and output directory', async function () {
				this.timeout(60000);
				await configuration.update('build.onSave', true, vscode.ConfigurationTarget.Workspace);
				await configuration.update('build.format', 'both', vscode.ConfigurationTarget.Workspace);
				const input = vscode.Uri.joinPath(directory, 'saved.mml');
				await vscode.workspace.fs.writeFile(input, new TextEncoder().encode('A r4'));
				const document = await vscode.workspace.openTextDocument(input);
				const observer = observeBuilds(input);
				try {
					for (const title of ['First save', 'Latest save']) {
						await editSource(document, `#title "${title}"\nA r4 L r4`);
						assert.ok(await document.save());
					}
					await observer.waitFor(1);
					await assert.rejects(observer.waitFor(2, 600), /Timed out/);
					assert.deepStrictEqual(observer.exits, [0]);
					const mdx = vscode.Uri.joinPath(directory, 'generated', 'saved.mdx');
					const vgm = vscode.Uri.joinPath(directory, 'generated', 'saved.vgm');
					assert.ok(Buffer.from(await vscode.workspace.fs.readFile(mdx)).includes(Buffer.from('Latest save')));
					const previousVgm = await vscode.workspace.fs.readFile(vgm);
					await configuration.update('build.format', 'mdx', vscode.ConfigurationTarget.Workspace);
					await editSource(document, '#title "MDX only"\nA r8');
					assert.ok(await document.save());
					await observer.waitFor(2);
					assert.ok(Buffer.from(await vscode.workspace.fs.readFile(mdx)).includes(Buffer.from('MDX only')));
					assert.deepStrictEqual(await vscode.workspace.fs.readFile(vgm), previousVgm);
					assert.strictEqual(observer.maxActive, 1);
				} finally { observer.dispose(); }
			});

			test('builds the latest save after an active build finishes', async function () {
				this.timeout(60000);
				await configuration.update('build.onSave', true, vscode.ConfigurationTarget.Workspace);
				const input = vscode.Uri.joinPath(directory, 'queued.mml');
				await vscode.workspace.fs.writeFile(input, new TextEncoder().encode('A r4'));
				const document = await vscode.workspace.openTextDocument(input);
				const observer = observeBuilds(input);
				let subsequentSave: Promise<void> | undefined;
				const subscription = vscode.tasks.onDidStartTask(event => {
					if (event.execution.task.definition.input === input.toString() && !subsequentSave) {
						subsequentSave = (async () => {
							await editSource(document, '#title "Queued save"\nA r8');
							assert.ok(await document.save());
						})();
					}
				});
				try {
					await editSource(document, '#title "Initial save"\nA r4');
					assert.ok(await document.save());
					await observer.waitFor(2);
					await subsequentSave;
					assert.deepStrictEqual(observer.exits, [0, 0]);
					assert.strictEqual(observer.maxActive, 1);
					assert.ok(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(directory,
						'generated', 'queued.mdx'))).includes(Buffer.from('Queued save')));
				} finally { subscription.dispose(); observer.dispose(); }
			});

			test('does not duplicate a manual build that saves a modified document', async function () {
				this.timeout(60000);
				await configuration.update('build.onSave', true, vscode.ConfigurationTarget.Workspace);
				const input = vscode.Uri.joinPath(directory, 'manual.mml');
				await vscode.workspace.fs.writeFile(input, new TextEncoder().encode('A r4'));
				const document = await vscode.workspace.openTextDocument(input);
				await vscode.window.showTextDocument(document);
				const observer = observeBuilds(input);
				try {
					await editSource(document, 'A r8');
					assert.strictEqual(await runBuildTask({ type: 'mmlx', input: input.fsPath, format: 'mdx' }), 0);
					await observer.waitFor(1);
					await assert.rejects(observer.waitFor(2, 600), /Timed out/);
					assert.strictEqual(observer.started, 1);
				} finally { observer.dispose(); }
			});
		});

		test('refreshes Explorer and reports compiler-style build progress', async function () {
			this.timeout(60000);
			assert.ok((await vscode.commands.getCommands()).includes('workbench.files.action.refreshFilesExplorer'));
			const input = vscode.Uri.joinPath(directory, 'song.mml');
			const output = vscode.Uri.joinPath(directory, 'generated', 'song.mdx');
			await vscode.workspace.fs.writeFile(input, new TextEncoder().encode('A r4 L r4'));
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, '**/*.mdx'));
			let timeout: ReturnType<typeof setTimeout> | undefined;
			let subscription: vscode.Disposable | undefined;
			try {
				const created = new Promise<void>((resolve, reject) => {
					timeout = setTimeout(() => reject(new Error('No output file notification received')), 10000);
					subscription = watcher.onDidCreate(uri => {
						if (uri.toString() === output.toString()) { resolve(); }
					});
				});
				const result = await runBuildTerminal({ type: 'mmlx', input: input.fsPath,
					output: output.fsPath, format: 'both' });
				await created;
				assert.strictEqual(result.code, 0);
				assert.ok(result.output.includes('\x1b[1;32m'));
				assert.ok(result.output.includes('Compiling'));
				assert.ok(result.output.includes('Emitting'));
				assert.ok(result.output.includes('Converting'));
				assert.ok(result.output.includes('VGM [native loop]'));
				assert.strictEqual((result.output.match(/Writing/g) ?? []).length, 2);
				assert.match(result.output, /Finished\x1b\[0m 2 output file\(s\) in \d+\.\d{2}s/);
				assert.ok(!result.output.includes('Warning'));
				assert.ok(!result.output.replace(/\r\n/g, '').includes('\n'));
			} finally {
				clearTimeout(timeout);
				subscription?.dispose();
				watcher.dispose();
			}
		});

		test('reports compiler-style failures and cancellation without a success message', async function () {
			this.timeout(60000);
			const input = vscode.Uri.joinPath(directory, 'invalid.mml');
			const output = vscode.Uri.joinPath(directory, 'invalid.vgm');
			await vscode.workspace.fs.writeFile(input, new TextEncoder().encode('A @42 c4'));
			const failed = await runBuildTerminal({ type: 'mmlx', input: input.fsPath,
				output: output.fsPath, format: 'vgm' });
			assert.strictEqual(failed.code, 1);
			assert.ok(failed.output.includes('\x1b[1;31m'));
			assert.ok(failed.output.includes(`${input.fsPath}:1:7: \x1b[1;31merror\x1b[0m: missing tone for voice 42`));
			assert.ok(failed.output.includes('Failed'));
			assert.ok(!failed.output.includes('Finished'));
			const canceled = await runBuildTerminal({ type: 'mmlx', input: input.fsPath,
				output: output.fsPath, format: 'vgm' }, true);
			assert.strictEqual(canceled.code, 130);
			assert.ok(canceled.output.includes('\x1b[1;33m'));
			assert.ok(canceled.output.includes('Canceled'));
			assert.ok(!canceled.output.includes('Finished'));
		});

		test('opens terminal error links at the mapped source range', async function () {
			this.timeout(60000);
			const input = vscode.Uri.joinPath(directory, 'song with spaces.mml');
			const output = vscode.Uri.joinPath(directory, 'song.vgm');
			const source = 'A r4\r\nA /* \u{1f600} */ @42 c4';
			await vscode.workspace.fs.writeFile(input, new TextEncoder().encode(source));
			const document = await vscode.workspace.openTextDocument(input);
			const offset = source.indexOf('c4');
			const expected = new vscode.Range(document.positionAt(offset), document.positionAt(offset + 2));
			const result = await runBuildTerminal({ type: 'mmlx', input: input.fsPath,
				output: output.fsPath, format: 'vgm' });
			assert.strictEqual(result.code, 1);
			assert.strictEqual(result.links.length, 1);
			const link = result.links[0];
			assert.strictEqual(link.uri.toString(), input.toString());
			assert.ok(link.range.isEqual(expected));
			assert.strictEqual(link.startIndex, 0);
			assert.strictEqual(link.length, `${input.fsPath}:${expected.start.line + 1}:${expected.start.character + 1}`.length);
			await buildErrorLinkProvider.handleTerminalLink(link);
			assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), input.toString());
			assert.ok(vscode.window.activeTextEditor?.selection.isEqual(expected));
			let terminal: vscode.Terminal | undefined;
			const subscription = vscode.window.onDidOpenTerminal(opened => { terminal = opened; });
			try {
				assert.strictEqual(await runBuildTask({ type: 'mmlx', input: input.fsPath,
					output: output.fsPath, format: 'vgm' }), 1);
				assert.ok(terminal, 'No task terminal was opened');
				const line = result.output.replace(/\x1b\[[0-9;]*m/g, '').split('\r\n')
					.find(line => line.startsWith(`${input.fsPath}:`))!;
				const token = new vscode.CancellationTokenSource();
				try {
					const links = await buildErrorLinkProvider.provideTerminalLinks({ terminal, line }, token.token);
					assert.strictEqual(links?.length, 1, 'Task terminal did not expose its build-error link');
					const unrelated = await buildErrorLinkProvider.provideTerminalLinks({ terminal,
						line: 'Finished 2 output files' }, token.token);
					assert.deepStrictEqual(unrelated, []);
				} finally { token.dispose(); }
			} finally { subscription.dispose(); }
		});

		test('builds both MDX and VGM by default', async function () {
			this.timeout(60000);
			const folder = vscode.workspace.workspaceFolders![0];
			const name = path.posix.basename(directory.path);
			const input = vscode.Uri.joinPath(directory, `${name}.mml`);
			const mdx = vscode.Uri.joinPath(folder.uri, 'build', `${name}.mdx`);
			const vgm = vscode.Uri.joinPath(folder.uri, 'build', `${name}.vgm`);
			outputs.push(mdx, vgm);
			assert.strictEqual(vscode.workspace.getConfiguration('mmlx', input).get('build.format'), 'both');
			await vscode.workspace.fs.writeFile(input, new TextEncoder().encode('A r4 L r4'));
			assert.strictEqual(await runBuildTask({ type: 'mmlx', input: input.fsPath }), 0);
			assert.ok((await vscode.workspace.fs.readFile(mdx)).length > 0);
			const bytes = Buffer.from(await vscode.workspace.fs.readFile(vgm));
			assert.strictEqual(bytes.subarray(0, 4).toString(), 'Vgm ');
			assert.ok(bytes.readUInt32LE(0x1c) > 0);
		});

		test('configures default formats and allows an explicit both-formats task', async function () {
			this.timeout(60000);
			const input = vscode.Uri.joinPath(directory, 'song.mml');
			await vscode.workspace.fs.writeFile(input, new TextEncoder().encode('A r4'));
			const configuration = vscode.workspace.getConfiguration('mmlx', input);
			const previousFormat = configuration.inspect<string>('build.format')?.workspaceValue;
			const previousDirectory = configuration.inspect<string>('build.outputDirectory')?.workspaceValue;
			try {
				for (const format of ['mdx', 'vgm']) {
					const destination = vscode.Uri.joinPath(directory, format);
					await configuration.update('build.format', format, vscode.ConfigurationTarget.Workspace);
					await configuration.update('build.outputDirectory', destination.fsPath, vscode.ConfigurationTarget.Workspace);
					assert.strictEqual(await runBuildTask({ type: 'mmlx', input: input.fsPath }), 0);
					assert.ok((await vscode.workspace.fs.readFile(vscode.Uri.joinPath(destination, `song.${format}`))).length > 0);
					await assert.rejects(async () => vscode.workspace.fs.stat(vscode.Uri.joinPath(destination,
						`song.${format === 'mdx' ? 'vgm' : 'mdx'}`)));
				}
				await configuration.update('build.format', 'mdx', vscode.ConfigurationTarget.Workspace);
				const output = vscode.Uri.joinPath(directory, 'both', 'song.vgm');
				assert.strictEqual(await runBuildTask({ type: 'mmlx', input: input.fsPath,
					format: 'both', output: output.fsPath }), 0);
				const mdx = vscode.Uri.joinPath(directory, 'both', 'song.mdx');
				assert.ok((await vscode.workspace.fs.readFile(mdx)).length > 0);
				assert.ok((await vscode.workspace.fs.readFile(output)).length > 0);
				await configuration.update('build.format', 'both', vscode.ConfigurationTarget.Workspace);
				const destination = vscode.Uri.joinPath(directory, 'from-mdx');
				await configuration.update('build.outputDirectory', destination.fsPath, vscode.ConfigurationTarget.Workspace);
				assert.strictEqual(await runBuildTask({ type: 'mmlx', input: mdx.fsPath }), 0);
				assert.ok((await vscode.workspace.fs.readFile(vscode.Uri.joinPath(destination, 'song.vgm'))).length > 0);
				await assert.rejects(async () => vscode.workspace.fs.stat(vscode.Uri.joinPath(destination, 'song.mdx')));
			} finally {
				await configuration.update('build.format', previousFormat, vscode.ConfigurationTarget.Workspace);
				await configuration.update('build.outputDirectory', previousDirectory, vscode.ConfigurationTarget.Workspace);
			}
		});

		test('uses configured VGM build options and lets task options override them', async function () {
			this.timeout(60000);
			const input = vscode.Uri.joinPath(directory, 'configured.mml');
			const output = vscode.Uri.joinPath(directory, 'configured.vgm');
			const pdx = vscode.Uri.joinPath(directory, 'drums.pdx');
			await vscode.workspace.fs.writeFile(input, new TextEncoder().encode('A r4 L r4'));
			await vscode.workspace.fs.writeFile(pdx, new Uint8Array(768));
			const configuration = vscode.workspace.getConfiguration('mmlx', input);
			const values = { pdx: 'configured-missing.pdx', adpcmMode: 'lpf', loopCount: 3, maxTicks: 1 };
			const previous = Object.fromEntries(Object.keys(values).map(key =>
				[key, configuration.inspect(`build.${key}`)?.workspaceValue]));
			try {
				for (const [key, value] of Object.entries(values)) {
					await configuration.update(`build.${key}`, value, vscode.ConfigurationTarget.Workspace);
				}
				const definition = { type: 'mmlx' as const, input: input.fsPath, output: output.fsPath, format: 'vgm' as const };
				const missing = await runBuildTerminal(definition);
				assert.strictEqual(missing.code, 1);
				assert.ok(missing.output.includes('configured-missing.pdx'));
				const limited = await runBuildTerminal({ ...definition, pdx: pdx.fsPath });
				assert.strictEqual(limited.code, 1);
				assert.match(limited.output, /tick/i);
				const configured = await runBuildTerminal({ ...definition, pdx: pdx.fsPath, maxTicks: 100000 });
				assert.strictEqual(configured.code, 0);
				assert.ok(configured.output.includes('VGM [3 playthrough(s)]'));
				const configuredBytes = Buffer.from(await vscode.workspace.fs.readFile(output));
				assert.strictEqual(configuredBytes.readUInt32LE(0x1c), 0);
				const explicit = await runBuildTerminal({ ...definition, pdx: pdx.fsPath,
					maxTicks: 100000, loopCount: 1, adpcmMode: 'through' });
				assert.strictEqual(explicit.code, 0);
				assert.ok(explicit.output.includes('VGM [1 playthrough(s)]'));
				const explicitBytes = Buffer.from(await vscode.workspace.fs.readFile(output));
				assert.ok(configuredBytes.readUInt32LE(0x18) > explicitBytes.readUInt32LE(0x18));
			} finally {
				for (const [key, value] of Object.entries(previous)) {
					await configuration.update(`build.${key}`, value, vscode.ConfigurationTarget.Workspace);
				}
			}
		});

		test('preserves both existing outputs if VGM conversion fails', async function () {
			this.timeout(60000);
			const input = vscode.Uri.joinPath(directory, 'invalid.mml');
			const mdx = vscode.Uri.joinPath(directory, 'invalid.mdx');
			const vgm = vscode.Uri.joinPath(directory, 'invalid.vgm');
			await vscode.workspace.fs.writeFile(input, new TextEncoder().encode('A @42 c4'));
			await vscode.workspace.fs.writeFile(mdx, new TextEncoder().encode('existing MDX'));
			await vscode.workspace.fs.writeFile(vgm, new TextEncoder().encode('existing VGM'));
			assert.strictEqual(await runBuildTask({ type: 'mmlx', input: input.fsPath, output: mdx.fsPath }), 1);
			assert.strictEqual(new TextDecoder().decode(await vscode.workspace.fs.readFile(mdx)), 'existing MDX');
			assert.strictEqual(new TextDecoder().decode(await vscode.workspace.fs.readFile(vgm)), 'existing VGM');
		});

		test('builds MDX and converts it to VGM with the bundled WASM', async function () {
			this.timeout(60000);
			const folder = vscode.workspace.workspaceFolders![0];
			const name = path.posix.basename(directory.path);
			const input = vscode.Uri.joinPath(directory, `${name}.mml`);
			const mdx = vscode.Uri.joinPath(folder.uri, 'build', `${name}.mdx`);
			const vgm = vscode.Uri.joinPath(folder.uri, 'build', `${name}.vgm`);
			outputs.push(mdx, vgm);
			assert.strictEqual(vscode.workspace.getConfiguration('mmlx', input).get('build.outputDirectory'), 'build');
			await vscode.workspace.fs.writeFile(input, new TextEncoder().encode('#title "Build test"\nA r4 L r4'));
			assert.strictEqual(await runBuildTask({ type: 'mmlx', input: input.fsPath, format: 'mdx' }), 0);
			assert.ok((await vscode.workspace.fs.readFile(mdx)).length > 0);
			assert.strictEqual(await runBuildTask({ type: 'mmlx', input: mdx.fsPath, format: 'vgm' }), 0);
			const native = Buffer.from(await vscode.workspace.fs.readFile(vgm));
			assert.strictEqual(native.subarray(0, 4).toString(), 'Vgm ');
			assert.ok(native.readUInt32LE(0x1c) > 0);
			assert.ok(native.readUInt32LE(0x20) > 0);
			assert.strictEqual(await runBuildTask({ type: 'mmlx', input: mdx.fsPath,
				format: 'vgm', loopCount: 1 }), 0);
			const finite = Buffer.from(await vscode.workspace.fs.readFile(vgm));
			assert.strictEqual(finite.readUInt32LE(0x1c), 0);
			assert.strictEqual(finite.readUInt32LE(0x20), 0);
		});

		test('streams binary output larger than pipe chunks with the bundled WASM', async function () {
			this.timeout(60000);
			const input = vscode.Uri.joinPath(directory, 'large.mml');
			const output = vscode.Uri.joinPath(directory, 'large.vgm');
			const source = '#title "Large transfer"\nA t120 o4 ' + 'c64 r64 '.repeat(8192);
			await vscode.workspace.fs.writeFile(input, new TextEncoder().encode(source));
			const result = await runBuildTerminal({ type: 'mmlx', input: input.fsPath,
				output: output.fsPath, format: 'vgm' });
			assert.strictEqual(result.code, 0, result.output);
			const bytes = Buffer.from(await vscode.workspace.fs.readFile(output));
			assert.ok(bytes.length > 64 * 1024);
			assert.strictEqual(bytes.subarray(0, 4).toString(), 'Vgm ');
			assert.strictEqual(bytes.readUInt32LE(0x04) + 4, bytes.length);
		});

		test('configures relative and absolute output directories with task output taking precedence', async function () {
			this.timeout(60000);
			const folder = vscode.workspace.workspaceFolders![0];
			const input = vscode.Uri.joinPath(directory, 'configured.mml');
			const configuration = vscode.workspace.getConfiguration('mmlx', input);
			const previous = configuration.inspect<string>('build.outputDirectory')?.workspaceValue;
			await vscode.workspace.fs.writeFile(input, new TextEncoder().encode('A r4'));
			try {
				const relative = path.posix.relative(folder.uri.path, vscode.Uri.joinPath(directory, 'custom').path);
				await configuration.update('build.outputDirectory', relative, vscode.ConfigurationTarget.Workspace);
				assert.strictEqual(await runBuildTask({ type: 'mmlx', input: input.fsPath, format: 'mdx' }), 0);
				assert.ok((await vscode.workspace.fs.readFile(vscode.Uri.joinPath(directory, 'custom', 'configured.mdx'))).length > 0);
				await configuration.update('build.outputDirectory', vscode.Uri.joinPath(directory, 'absolute').fsPath,
					vscode.ConfigurationTarget.Workspace);
				assert.strictEqual(await runBuildTask({ type: 'mmlx', input: input.fsPath, format: 'mdx' }), 0);
				assert.ok((await vscode.workspace.fs.readFile(vscode.Uri.joinPath(directory, 'absolute', 'configured.mdx'))).length > 0);
				const explicit = vscode.Uri.joinPath(directory, 'explicit.mdx');
				assert.strictEqual(await runBuildTask({ type: 'mmlx', input: input.fsPath,
					output: explicit.fsPath, format: 'mdx' }), 0);
				assert.ok((await vscode.workspace.fs.readFile(explicit)).length > 0);
			} finally {
				await configuration.update('build.outputDirectory', previous, vscode.ConfigurationTarget.Workspace);
			}
		});

		test('resolves active-file variables and builds the edited MML file', async function () {
			this.timeout(60000);
			const input = vscode.Uri.joinPath(directory, 'buffer.mml');
			const output = vscode.Uri.joinPath(directory, 'buffer.mdx');
			await vscode.workspace.fs.writeFile(input, new TextEncoder().encode('A r4'));
			const document = await vscode.workspace.openTextDocument(input);
			await vscode.window.showTextDocument(document);
			const edit = new vscode.WorkspaceEdit();
			edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
				'#title "Editor buffer"\nA r8');
			assert.ok(await vscode.workspace.applyEdit(edit));
			try {
				assert.strictEqual(await runBuildTask({ type: 'mmlx', input: '${file}',
					output: '${fileDirname}/${fileBasenameNoExtension}.mdx', format: 'mdx' }), 0);
				assert.ok(Buffer.from(await vscode.workspace.fs.readFile(output)).includes(Buffer.from('Editor buffer')));
				assert.strictEqual(new TextDecoder().decode(await vscode.workspace.fs.readFile(input)), document.getText());
			} finally {
				await vscode.commands.executeCommand('workbench.action.files.revert');
			}
		});

		test('builds VGM directly and resolves a case-insensitive PDX name', async function () {
			this.timeout(60000);
			const input = vscode.Uri.joinPath(directory, 'song.mml');
			const output = vscode.Uri.joinPath(directory, 'output', 'song.vgm');
			await vscode.workspace.fs.writeFile(input, new TextEncoder().encode('#pcmfile "Drums"\nA r4'));
			await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(directory, 'drums.PDX'), new Uint8Array(768));
			assert.strictEqual(await runBuildTask({ type: 'mmlx', input: input.fsPath,
				output: output.fsPath, format: 'vgm', adpcmMode: 'lpf', loopCount: 1 }), 0);
			assert.strictEqual(new TextDecoder().decode((await vscode.workspace.fs.readFile(output)).slice(0, 4)), 'Vgm ');
		});

		test('reports build diagnostics without overwriting an existing output', async function () {
			this.timeout(60000);
			const input = vscode.Uri.joinPath(directory, 'invalid.mml');
			const output = vscode.Uri.joinPath(directory, 'invalid.vgm');
			await vscode.workspace.fs.writeFile(input, new TextEncoder().encode('A @42 c4'));
			await vscode.workspace.fs.writeFile(output, new TextEncoder().encode('existing output'));
			assert.strictEqual(await runBuildTask({ type: 'mmlx', input: input.fsPath,
				output: output.fsPath, format: 'vgm' }), 1);
			assert.strictEqual(new TextDecoder().decode(await vscode.workspace.fs.readFile(output)), 'existing output');
			const diagnostic = vscode.languages.getDiagnostics(input).find(item => item.source === 'mmlx build');
			assert.ok(diagnostic);
			assert.ok(diagnostic.message.includes('missing tone for voice 42'));
			assert.ok(diagnostic.range.isEqual(new vscode.Range(0, 6, 0, 8)));
		});

		test('rejects output paths that overwrite the source', async function () {
			this.timeout(60000);
			const input = vscode.Uri.joinPath(directory, 'song.mml');
			await vscode.workspace.fs.writeFile(input, new TextEncoder().encode('A r4'));
			assert.strictEqual(await runBuildTask({ type: 'mmlx', input: input.fsPath,
				output: input.fsPath, format: 'mdx' }), 1);
			assert.strictEqual(new TextDecoder().decode(await vscode.workspace.fs.readFile(input)), 'A r4');
		});

		test('cancels a build without writing output', async function () {
			this.timeout(60000);
			const input = vscode.Uri.joinPath(directory, 'long.mml');
			const output = vscode.Uri.joinPath(directory, 'long.vgm');
			await vscode.workspace.fs.writeFile(input, new TextEncoder().encode('A [[r1]255]255'));
			assert.notStrictEqual(await runBuildTask({ type: 'mmlx', input: input.fsPath,
				output: output.fsPath, format: 'vgm', maxTicks: 4294967295 }, true), 0);
			await assert.rejects(async () => vscode.workspace.fs.stat(output));
		});
	});
});
