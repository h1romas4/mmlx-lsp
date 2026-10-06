import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import {
	commands, ConfigurationTarget, ExtensionContext, Position, Range, TextDocument, TextEditor, Uri, WebviewView, WebviewViewProvider,
	window, workspace, WorkspaceEdit
} from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

interface VoiceDefinition {
	number: number;
	algorithm: number;
	feedback: number;
	operatorMask: number;
	operators: Record<string, number>[];
	position: { line: number; character: number };
	parameterRanges: { start: { line: number; character: number }; end: { line: number; character: number } }[];
}

interface SerialPortInfo {
	path: string;
	manufacturer?: string;
	serialNumber?: string;
	vendorId?: string;
	productId?: string;
}

async function listSerialPorts(): Promise<SerialPortInfo[]> {
	const { autoDetect } = await import('@serialport/bindings-cpp');
	return autoDetect().list();
}

const buildSettingsDefaults = {
	format: 'both', onSave: false, outputDirectory: 'build', pdx: '',
	adpcmMode: 'through', loopCount: 0, maxTicks: 100000
};

const buildSettingsValidators: Record<keyof typeof buildSettingsDefaults, (value: unknown) => boolean> = {
	format: value => typeof value === 'string' && ['both', 'mdx', 'vgm'].includes(value),
	onSave: value => typeof value === 'boolean',
	outputDirectory: value => typeof value === 'string' && value.trim().length > 0,
	pdx: value => typeof value === 'string',
	adpcmMode: value => typeof value === 'string' && ['through', 'resample', 'lpf'].includes(value),
	loopCount: value => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4294967295,
	maxTicks: value => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 4294967295
};

export function registerVoiceView(context: ExtensionContext, getClient: () => LanguageClient | undefined): void {
	const provider = new VoiceViewProvider(context, getClient);
	context.subscriptions.push(provider,
		window.registerWebviewViewProvider('mmlx.voice', provider),
		commands.registerCommand('mmlx.showVoicePanel', () => commands.executeCommand('mmlx.voice.focus')));
}

export class VoiceViewProvider implements WebviewViewProvider {
	private view: WebviewView | undefined;
	private editor = window.activeTextEditor;
	private sequence = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private editToken = 0;
	private editing = false;
	private savingSettings = false;
	private serialPorts: SerialPortInfo[] = [];
	private serialLoading = false;
	private serialError = '';
	private editTarget: { document: TextDocument; version: number; token: number; voice: VoiceDefinition } | undefined;
	private snapshot: { voice: VoiceDefinition | null; source: string; retained: boolean; error: boolean } = {
		voice: null, source: '', retained: false, error: false
	};

	constructor(private readonly context: ExtensionContext, private readonly getClient: () => LanguageClient | undefined,
		private readonly getSerialPorts: () => Promise<SerialPortInfo[]> = listSerialPorts) {
		context.subscriptions.push(
			window.onDidChangeTextEditorSelection(event => this.follow(event.textEditor)),
			window.onDidChangeActiveTextEditor(editor => { this.follow(editor); this.sendBuildSettings(); this.sendSerialSettings(); }),
			workspace.onDidChangeWorkspaceFolders(() => { this.sendBuildSettings(); this.sendSerialSettings(); }),
			workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('mmlx.build')) { this.sendBuildSettings(); }
				if (event.affectsConfiguration('mmlx.serial')) { this.sendSerialSettings(); }
			}),
			workspace.onDidChangeTextDocument(event => {
				if (event.document.uri.toString() === this.editor?.document.uri.toString()) { this.schedule(); }
			}),
			workspace.onDidCloseTextDocument(document => {
				if (document.uri.toString() === this.editor?.document.uri.toString()) {
					this.editor = undefined;
					this.sequence++;
					this.editTarget = undefined;
					this.snapshot = { voice: null, source: '', retained: false, error: false };
					this.send();
				}
			})
		);
	}

	async resolveWebviewView(view: WebviewView): Promise<void> {
		this.view = view;
		const media = Uri.joinPath(this.context.extensionUri, 'media');
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		this.context.subscriptions.push(
			view.webview.onDidReceiveMessage(message => {
				if (message?.type === 'ready') { this.send(); this.schedule(); this.sendBuildSettings(); void this.refreshSerialPorts(); }
				else if (message?.type === 'editVoice') { void this.edit(message); }
				else if (message?.type === 'updateBuildSetting') { void this.updateBuildSetting(message); }
				else if (message?.type === 'getBuildSettings') { this.sendBuildSettings(); }
				else if (message?.type === 'getSerialPorts') { void this.refreshSerialPorts(); }
				else if (message?.type === 'updateSerialConnection') { void this.updateSerialConnection(message); }
			}),
			view.onDidChangeVisibility(() => { if (view.visible) { this.schedule(); } }),
			view.onDidDispose(() => { if (this.view === view) { this.view = undefined; this.sequence++; } })
		);
		const template = new TextDecoder().decode(await workspace.fs.readFile(Uri.joinPath(media, 'voice.html')));
		const nonce = randomBytes(16).toString('hex');
		view.webview.html = template
			.replaceAll('{{cspSource}}', view.webview.cspSource)
			.replaceAll('{{nonce}}', nonce)
			.replaceAll('{{styleUri}}', view.webview.asWebviewUri(Uri.joinPath(media, 'voice.css')).toString())
			.replaceAll('{{scriptUri}}', view.webview.asWebviewUri(Uri.joinPath(media, 'voice.js')).toString());
		this.follow(window.activeTextEditor);
		this.sendBuildSettings();
		this.sendSerialSettings();
	}

	private buildSettingsFolder() {
		const resource = window.activeTextEditor?.document.uri ?? this.editor?.document.uri;
		return (resource ? workspace.getWorkspaceFolder(resource) : undefined) ?? workspace.workspaceFolders?.[0];
	}

	private sendBuildSettings(error = ''): void {
		const folder = this.buildSettingsFolder();
		const configuration = workspace.getConfiguration('mmlx', folder?.uri);
		const values = Object.fromEntries(Object.entries(buildSettingsDefaults)
			.map(([key, fallback]) => [key, configuration.get(`build.${key}`, fallback)]));
		void this.view?.webview.postMessage({ type: 'buildSettings', values, folder: folder?.uri.toString() ?? '',
			source: folder ? `${folder.name}/.vscode/settings.json` : '',
			editable: !!folder && !this.savingSettings, saving: this.savingSettings,
			error: error || (folder ? '' : 'Open a workspace folder to edit build settings.') });
	}

	private async updateBuildSetting(message: { folder?: unknown; key?: unknown; value?: unknown }): Promise<void> {
		const folder = this.buildSettingsFolder();
		const { key, value } = message;
		if (!folder || message.folder !== folder.uri.toString() || this.savingSettings) {
			this.sendBuildSettings(); return;
		}
		if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(buildSettingsValidators, key)
			|| !buildSettingsValidators[key as keyof typeof buildSettingsDefaults](value)) {
			this.sendBuildSettings('Invalid build setting.'); return;
		}
		this.savingSettings = true;
		this.sendBuildSettings();
		this.sendSerialSettings();
		let error = '';
		try {
			await workspace.getConfiguration('mmlx', folder.uri).update(`build.${key}`, value, ConfigurationTarget.WorkspaceFolder);
		} catch (failure) {
			error = failure instanceof Error ? failure.message : 'Could not save build settings.';
		} finally {
			this.savingSettings = false;
			this.sendBuildSettings(error);
			this.sendSerialSettings();
		}
	}

	private sendSerialSettings(error = ''): void {
		const folder = this.buildSettingsFolder();
		const connection = workspace.getConfiguration('mmlx', folder?.uri).get<string>('serial.connection', '');
		void this.view?.webview.postMessage({ type: 'serialSettings', connection, ports: this.serialPorts,
			folder: folder?.uri.toString() ?? '', editable: !!folder && !this.savingSettings && !this.serialLoading,
			saving: this.savingSettings, loading: this.serialLoading,
			error: error || this.serialError || (folder ? '' : 'Open a workspace folder to edit connection settings.') });
	}

	private async refreshSerialPorts(): Promise<void> {
		if (this.serialLoading) { this.sendSerialSettings(); return; }
		this.serialLoading = true;
		this.serialError = '';
		this.sendSerialSettings();
		try {
			const ports = await this.getSerialPorts();
			this.serialPorts = [...new Map(ports.filter(port => port.path.trim()).map(port => [port.path, port])).values()]
				.sort((first, second) => first.path.localeCompare(second.path, undefined, { numeric: true }));
		} catch (failure) {
			this.serialPorts = [];
			this.serialError = failure instanceof Error ? failure.message : 'Could not list serial ports.';
		} finally {
			this.serialLoading = false;
			this.sendSerialSettings();
		}
	}

	private async updateSerialConnection(message: { folder?: unknown; value?: unknown }): Promise<void> {
		const folder = this.buildSettingsFolder();
		if (!folder || message.folder !== folder.uri.toString() || this.savingSettings || this.serialLoading) {
			this.sendSerialSettings(); return;
		}
		if (typeof message.value !== 'string' || (message.value !== '' && !this.serialPorts.some(port => port.path === message.value))) {
			this.sendSerialSettings('Invalid serial port.'); return;
		}
		this.savingSettings = true;
		this.sendBuildSettings();
		this.sendSerialSettings();
		let error = '';
		try {
			await workspace.getConfiguration('mmlx', folder.uri).update('serial.connection', message.value, ConfigurationTarget.WorkspaceFolder);
		} catch (failure) {
			error = failure instanceof Error ? failure.message : 'Could not save connection settings.';
		} finally {
			this.savingSettings = false;
			this.sendBuildSettings();
			this.sendSerialSettings(error);
		}
	}

	private follow(editor: TextEditor | undefined): void {
		if (editor?.document.languageId !== 'mmlx') { return; }
		this.editor = editor;
		this.schedule();
	}

	private schedule(): void {
		clearTimeout(this.timer);
		this.editTarget = undefined;
		this.send();
		const sequence = ++this.sequence;
		this.timer = setTimeout(() => { void this.update(sequence); }, 80);
	}

	private async update(sequence: number, position?: Position): Promise<void> {
		const editor = this.editor;
		const client = this.getClient();
		if (this.editing || !this.view?.visible || !editor || editor.document.languageId !== 'mmlx' || !client?.isRunning()) { return; }
		const document = editor.document;
		const version = document.version;
		try {
			const voice = await client.sendRequest<VoiceDefinition | null>('mmlx/voiceAtPosition',
				client.code2ProtocolConverter.asTextDocumentPositionParams(document, position ?? editor.selection.active));
			if (sequence !== this.sequence || document.version !== version || document.isClosed) { return; }
			this.snapshot = voice
				? { voice, source: basename(document.uri.path), retained: false, error: false }
				: { ...this.snapshot, retained: this.snapshot.voice !== null, error: false };
			this.editTarget = voice?.parameterRanges?.length === 47
				? { document, version, token: ++this.editToken, voice } : undefined;
			this.send();
		} catch {
			if (sequence === this.sequence) {
				this.editTarget = undefined;
				this.snapshot = { ...this.snapshot, retained: this.snapshot.voice !== null, error: true };
				this.send();
			}
		}
	}

	private async edit(message: { token?: unknown; index?: unknown; value?: unknown; changes?: unknown }): Promise<void> {
		const target = this.editTarget;
		const limits = [31, 31, 31, 15, 15, 127, 3, 15, 7, 3, 1];
		if (!target || this.editing || this.snapshot.retained || this.snapshot.error || !this.view?.visible
			|| message.token !== target.token || target.document.isClosed || target.document.version !== target.version) { this.send(); return; }
		const changes = message.changes === undefined ? [{ index: message.index, value: message.value }] : message.changes;
		if (!Array.isArray(changes) || changes.length === 0 || changes.length > 47) { this.send(); return; }
		const indexes = new Set<number>();
		const replacements: { range: Range; value: number }[] = [];
		for (const entry of changes) {
			if (!entry || typeof entry !== 'object') { this.send(); return; }
			const { index, value } = entry;
			if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= 47 || indexes.has(index)
				|| typeof value !== 'number' || !Number.isInteger(value) || value < 0
				|| value > (index < 44 ? limits[index % 11] : index === 46 ? 15 : 7)) { this.send(); return; }
			indexes.add(index);
			const parameter = target.voice.parameterRanges[index];
			const range = new Range(parameter.start.line, parameter.start.character, parameter.end.line, parameter.end.character);
			const previous = target.document.getText(range);
			if (!/^\d+$/.test(previous)) { this.schedule(); return; }
			if (Number(previous) !== value) { replacements.push({ range, value }); }
		}
		if (replacements.length === 0) { this.send(); return; }
		clearTimeout(this.timer);
		this.sequence++;
		this.editing = true;
		this.editTarget = undefined;
		this.send();
		try {
			const change = new WorkspaceEdit();
			const values = new Map(changes.map(({ index, value }) => [index, String(value)]));
			const alignOperators = [...indexes].some(index => index < 44);
			const parameters = target.voice.parameterRanges.map((parameter, index) => {
				const range = new Range(parameter.start.line, parameter.start.character, parameter.end.line, parameter.end.character);
				const prefix = target.document.lineAt(range.start.line).text.slice(0, range.start.character);
				const padding = prefix.match(/ *$/)?.[0].length ?? 0;
				return { index, range: new Range(range.start.translate(0, -padding), range.end),
					text: ' '.repeat(padding) + target.document.getText(range),
					value: values.get(index) ?? target.document.getText(range) };
			});
			const widths = limits.map((limit, field) => Math.max(String(limit).length,
				...parameters.slice(0, 44).filter(parameter => parameter.index % 11 === field).map(parameter => parameter.text.length)));
			for (const parameter of parameters) {
				if (parameter.index < 44 ? !alignOperators : !indexes.has(parameter.index)) { continue; }
				const width = parameter.index < 44 ? widths[parameter.index % 11]
					: Math.max(parameter.text.length, String(parameter.index === 46 ? 15 : 7).length);
				const text = parameter.value.padStart(width);
				if (text !== parameter.text) { change.replace(target.document.uri, parameter.range, text); }
			}
			if (!await workspace.applyEdit(change)) { throw new Error('Voice edit was not applied'); }
		} catch {
			this.snapshot = { ...this.snapshot, error: true };
			this.send();
		} finally {
			this.editing = false;
			clearTimeout(this.timer);
			if (this.editor?.document === target.document && !target.document.isClosed) {
				await this.update(++this.sequence, new Position(target.voice.position.line, target.voice.position.character));
			} else { this.schedule(); }
		}
	}

	private send(): void {
		const target = this.editTarget;
		const editable = !!target && !this.editing && !this.snapshot.retained && !this.snapshot.error
			&& !target.document.isClosed && target.document.version === target.version;
		void this.view?.webview.postMessage({ type: 'voice', ...this.snapshot, editing: this.editing,
			editable, editToken: editable ? target.token : null });
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.sequence++;
		this.editTarget = undefined;
	}
}