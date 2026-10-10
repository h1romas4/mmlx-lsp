import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import {
	commands, ConfigurationTarget, ExtensionContext, Position, Range, TextDocument, TextEditor, Uri, WebviewView, WebviewViewProvider,
	window, workspace, WorkspaceEdit, type OutputChannel
} from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import type { Wasm } from '@vscode/wasm-wasi/v1';
import { EmulationSession } from './emulation';
import { createMidiInput, MidiInputConnection, type MidiInputPort } from './midiInput';
import { NanoDriveConnection, openNanoDrivePort, type NanoDriveAdpcmMode, type NanoDriveCodec, type NanoDriveInput, type NanoDrivePort } from './nanodrive';
import { NanoDriveWorker } from './nanodriveWorker';
import { findPdx, resolveUri } from './tasks';

interface VoiceDefinition {
	number: number;
	algorithm: number;
	feedback: number;
	operatorMask: number;
	operators: Record<string, number>[];
	position: { line: number; character: number };
	range?: { start: { line: number; character: number }; end: { line: number; character: number } };
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

export async function listMidiInputPorts(): Promise<string[]> {
	const { Input } = await import('@julusian/midi');
	const input = new Input();
	try {
		return Array.from({ length: input.getPortCount() }, (_, index) => input.getPortName(index));
	} finally {
		input.destroy();
	}
}

const buildSettingsDefaults = {
	format: 'both', onSave: false, outputDirectory: 'build', pdx: '',
	adpcmMode: 'resample', loopCount: 0, maxTicks: 100000
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

export function registerVoiceView(context: ExtensionContext, getClient: () => LanguageClient | undefined, wasm?: Wasm): VoiceViewProvider {
	const provider = new VoiceViewProvider(context, getClient, undefined, undefined, undefined, wasm);
	context.subscriptions.push(provider,
		window.registerWebviewViewProvider('mmlx.voice', provider, { webviewOptions: { retainContextWhenHidden: true } }),
		commands.registerCommand('mmlx.showVoicePanel', () => commands.executeCommand('mmlx.voice.focus')));
	return provider;
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
	private readonly nanodrive: NanoDriveConnection;
	private readonly nanodriveWorker?: NanoDriveWorker;
	private readonly nanodriveAvailable: boolean;
	private nanodriveLog?: OutputChannel;
	private serialFolder = '';
	private midiPorts: string[] = [];
	private midiLoading = false;
	private midiError = '';
	private readonly midiInput: MidiInputConnection;
	private readonly emulation?: EmulationSession;
	private emulationConnected = false;
	private readonly playback?: EmulationSession;
	private playbackDocument?: TextDocument;
	private playbackConnected = false;
	private playbackMode = 'emulation';
	private playbackId = 0;
	private playbackState = { playing: false, paused: false, loading: false, position: 0, finished: false, error: '' };
	private outputId = 0;
	private keyboardOutputMode = 'emulation';
	private voiceTesting = false;
	private resettingOutput = false;
	private voiceTestVoice = '';
	private pitchBendValue = 8192;
	private bendTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingBends = new Map<string, Extract<NanoDriveInput, { type: 'pitchBend' }>>();
	private midiFolder = '';
	private editTarget: { document: TextDocument; version: number; token: number; voice: VoiceDefinition } | undefined;
	private snapshot: { voice: VoiceDefinition | null; source: string; retained: boolean; error: boolean } = {
		voice: null, source: '', retained: false, error: false
	};

	constructor(private readonly context: ExtensionContext, private readonly getClient: () => LanguageClient | undefined,
		private readonly getSerialPorts: () => Promise<SerialPortInfo[]> = listSerialPorts,
		private readonly getMidiInputPorts: () => Promise<string[]> = listMidiInputPorts,
		createInput: () => Promise<MidiInputPort> = createMidiInput, wasm?: Wasm,
		openSerial: (path: string) => Promise<NanoDrivePort> = openNanoDrivePort, codec?: NanoDriveCodec) {
		this.nanodriveWorker = wasm ? new NanoDriveWorker(context.extensionUri, wasm,
			error => { void this.nanodrive.disconnect(error); }) : undefined;
		this.nanodriveAvailable = !!codec || !!this.nanodriveWorker;
		this.nanodrive = new NanoDriveConnection(async params => {
			if (codec) { return codec(params); }
			if (!this.nanodriveWorker) { throw new Error('NanoDrive8 engine is not available.'); }
			return this.nanodriveWorker.request(params);
		}, () => { this.updateConnectionMarker(); this.sendSerialSettings(); }, openSerial, undefined, state => {
			if (this.keyboardOutputMode !== 'nanodrive8') { return; }
			if (state.connected) { this.nanodrive.setVoice(this.snapshot.voice); this.restorePitchBends(); }
			void this.view?.webview.postMessage({ type: 'outputConnection', target: 'keyboard', mode: 'nanodrive8', id: this.outputId, ...state });
		}, state => {
			void this.view?.webview.postMessage({ type: 'nanoDrivePlayback', busy: state.busy });
			if (this.playbackMode !== 'nanodrive8') { return; }
			Object.assign(this.playbackState, state, { paused: false });
			this.sendPlayback();
		}, message => {
			if (!this.nanodriveLog) {
				this.nanodriveLog = window.createOutputChannel('mmlx NanoDrive8');
				context.subscriptions.push(this.nanodriveLog);
			}
			this.nanodriveLog.appendLine(`${new Date().toISOString()} ${message}`);
		}, (playing, error) => { if (this.keyboardOutputMode === 'nanodrive8') { this.setVoiceTesting(playing, error); } });
		this.emulation = wasm ? new EmulationSession(context.extensionUri, wasm,
			state => {
				this.emulationConnected = state.connected;
				this.updateConnectionMarker();
				if (this.keyboardOutputMode === 'emulation') {
					if (state.connected) { this.restorePitchBends(); }
					void this.view?.webview.postMessage({ type: 'outputConnection', target: 'keyboard', mode: 'emulation', id: this.outputId, ...state });
				}
			},
			pcm => { void this.view?.webview.postMessage({ type: 'emulationPcm', id: this.outputId, pcm }); }, undefined,
			(playing, error) => { if (this.keyboardOutputMode === 'emulation') { this.setVoiceTesting(playing, error); } }) : undefined;
		this.playback = wasm ? new EmulationSession(context.extensionUri, wasm,
			state => {
				this.playbackConnected = state.connected;
				if (this.playbackMode !== 'emulation') { return; }
				this.playbackState.loading = state.connecting;
				this.playbackState.playing = state.connected;
				this.playbackState.paused = false;
				this.playbackState.error = state.error;
				this.updateConnectionMarker();
				this.sendPlayback();
			},
			pcm => { void this.view?.webview.postMessage({ type: 'playbackPcm', id: this.playbackId, pcm }); },
			progress => {
				if (this.playbackMode !== 'emulation') { return; }
				const changed = Math.floor(progress.position * 10) !== Math.floor(this.playbackState.position * 10)
					|| progress.finished !== this.playbackState.finished;
				Object.assign(this.playbackState, progress);
				if (changed) { this.sendPlayback(); }
			}) : undefined;
		this.midiInput = new MidiInputConnection(() => this.sendMidiSettings(), createInput,
			notes => { void this.view?.webview.postMessage({ type: 'midiNotes', notes }); },
			event => {
				this.note({ ...event, source: 1 });
				if (event.type === 'pitchBend') {
					this.pitchBendValue = event.value;
					this.note({ type: 'pitchBend', source: 0, channel: 0, value: event.value });
					void this.view?.webview.postMessage({ type: 'pitchBend', value: event.value });
				} else { void this.view?.webview.postMessage({ type: 'midiNote', event }); }
			});
		context.subscriptions.push(
			window.onDidChangeTextEditorSelection(event => this.follow(event.textEditor)),
			window.onDidChangeActiveTextEditor(editor => { this.follow(editor); this.sendBuildSettings(); this.sendConnectionSettings(); }),
			workspace.onDidChangeWorkspaceFolders(() => { this.sendBuildSettings(); this.sendConnectionSettings(); }),
			workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('mmlx.build')) { this.sendBuildSettings(); }
				if (event.affectsConfiguration('mmlx.serial') || event.affectsConfiguration('mmlx.midi')) { this.sendConnectionSettings(); }
			}),
			workspace.onDidChangeTextDocument(event => {
				if (event.document.uri.toString() === this.editor?.document.uri.toString()) { this.schedule(); }
			}),
			workspace.onDidCloseTextDocument(document => {
				if (document === this.playbackDocument) { this.playbackDocument = undefined; this.stopPlayback(); }
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
		this.updateConnectionMarker();
		const media = Uri.joinPath(this.context.extensionUri, 'assets', 'webview');
		const icons = Uri.joinPath(this.context.extensionUri, 'assets', 'icon');
		view.webview.options = { enableScripts: true, localResourceRoots: [media, icons] };
		this.context.subscriptions.push(
			view.webview.onDidReceiveMessage(message => {
				if (message?.type === 'ready') {
					this.outputId = 0;
					this.keyboardOutputMode = 'emulation';
					void this.nanodrive.disconnect();
					this.emulation?.disconnect();
					this.stopPlayback();
					this.send(); this.schedule(); this.sendBuildSettings();
					void this.view?.webview.postMessage({ type: 'midiNotes', notes: this.midiInput.notes });
					void this.view?.webview.postMessage({ type: 'pitchBend', value: this.pitchBendValue });
					void this.refreshSerialPorts(); void this.refreshMidiInputPorts();
				}
				else if (message?.type === 'openStarter') { void this.openStarter(); }
				else if (message?.type === 'editVoice') { void this.edit(message); }
				else if (message?.type === 'updateBuildSetting') { void this.updateBuildSetting(message); }
				else if (message?.type === 'getBuildSettings') { this.sendBuildSettings(); }
				else if (message?.type === 'getSerialPorts') { void this.refreshSerialPorts(); }
				else if (message?.type === 'updateSerialConnection') { void this.updateSerialConnection(message); }
				else if (message?.type === 'setSerialConnection') { void this.setSerialConnection(message); }
				else if (message?.type === 'getMidiInputPorts') { void this.refreshMidiInputPorts(); }
				else if (message?.type === 'updateMidiInput') { void this.updateMidiInput(message); }
				else if (message?.type === 'setMidiInputConnection') { void this.setMidiInputConnection(message); }
				else if (message?.type === 'setOutputConnection') { void this.setOutputConnection(message); }
				else if (message?.type === 'resetOutput') { void this.resetOutput(message); }
				else if (message?.type === 'voiceTestAction') { void this.voiceTestAction(message); }
				else if (message?.type === 'playbackAction') { void this.playbackAction(message); }
				else if (message?.type === 'playbackVolume' && message.mode === 'nanodrive8' && workspace.isTrusted
					&& typeof message.volume === 'number' && Number.isFinite(message.volume) && message.volume >= 0 && message.volume <= 1) {
					void this.nanodrive.setVolume(message.volume);
				}
				else if (message?.type === 'playbackRender' && message.id === this.playbackId
					&& (this.playbackState.playing || this.playbackState.paused) && !this.playbackState.finished) { this.playback?.request(message.blocks); }
				else if (message?.type === 'emulationRender' && message.id === this.outputId && this.keyboardOutputMode === 'emulation') { this.emulation?.request(message.blocks); }
				else if (message?.type === 'emulationNote' && message.id === this.outputId) {
					if (message.event === 'pitchBend' && Number.isInteger(message.value) && message.value >= 0 && message.value <= 16383) {
						this.pitchBendValue = message.value;
						this.midiInput.setPitchBends(message.value);
						this.note({ type: 'pitchBend', source: 0, channel: 0, value: message.value });
						this.midiInput.pitchBends.forEach((value, channel) => this.note({ type: 'pitchBend', source: 1, channel, value }));
					}
					if (['noteOn', 'noteOff'].includes(message.event) && Number.isInteger(message.note)
						&& message.note >= 0 && message.note <= 127 && Number.isInteger(message.velocity)
						&& message.velocity >= 0 && message.velocity <= 127) {
						this.note({ type: message.event, source: 0, channel: 0, note: message.note, velocity: message.velocity });
					}
				}
			}),
			view.onDidChangeVisibility(() => {
				if (view.visible) { this.schedule(); }
				else { this.note({ type: 'allOff', source: 0 }); }
			}),
			view.onDidDispose(() => {
				if (this.view === view) { this.view = undefined; void this.disconnectNanoDrive(); this.emulation?.disconnect(); this.stopPlayback(); this.sequence++; this.midiInput.disconnect(); }
			})
		);
		const template = new TextDecoder().decode(await workspace.fs.readFile(Uri.joinPath(media, 'voice.html')));
		const nonce = randomBytes(16).toString('hex');
		view.webview.html = template
			.replaceAll('{{cspSource}}', view.webview.cspSource)
			.replaceAll('{{nonce}}', nonce)
			.replaceAll('{{iconUri}}', view.webview.asWebviewUri(Uri.joinPath(icons, 'mmlx.png')).toString())
			.replaceAll('{{styleUri}}', view.webview.asWebviewUri(Uri.joinPath(media, 'voice.css')).toString())
			.replaceAll('{{scriptUri}}', view.webview.asWebviewUri(Uri.joinPath(media, 'voice.js')).toString());
		this.follow(window.activeTextEditor);
		this.sendBuildSettings();
		this.sendConnectionSettings();
	}

	private async openStarter(): Promise<void> {
		try {
			const content = new TextDecoder().decode(await workspace.fs.readFile(Uri.joinPath(this.context.extensionUri, 'assets', 'webview', 'example.mml')));
			const document = await workspace.openTextDocument({ language: 'mmlx', content });
			await window.showTextDocument(document, { preview: false });
		} catch (error) {
			void window.showErrorMessage(`Could not open example MML: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async setOutputConnection(message: { target: unknown; mode: unknown; connected: unknown; sampleRate?: unknown; id?: unknown }): Promise<void> {
		if (message.target === 'keyboard' && this.voiceTesting) {
			this.emulation?.stopVoiceTest(); await this.nanodrive.stopVoiceTest();
		}
		this.flushPitchBends();
		if (!['keyboard', 'playback'].includes(String(message.target)) || typeof message.connected !== 'boolean') { return; }
		if (message.target === 'keyboard' && Number.isInteger(message.id)) { this.outputId = message.id as number; }
		if (!message.connected) {
			if (message.target === 'keyboard') { this.emulation?.disconnect(); await this.nanodrive.disconnectOutput(); }
			else { void this.view?.webview.postMessage({ type: 'outputConnection', target: 'playback', connected: false, connecting: false }); }
			return;
		}
		if (message.target !== 'keyboard' || !workspace.isTrusted || !['emulation', 'nanodrive8'].includes(String(message.mode))
			|| (message.mode === 'emulation' && !this.emulation) || (message.mode === 'nanodrive8' && (!this.nanodriveAvailable || !this.nanodrive.state.connected || this.nanodrive.playbackState.busy))) {
			void this.view?.webview.postMessage({ type: 'outputConnection', target: message.target, id: message.id,
				connected: false, connecting: false, error: 'This output is not available.' });
			return;
		}
		this.keyboardOutputMode = message.mode as string;
		if (message.mode === 'nanodrive8') {
			this.emulation?.disconnect();
			await this.nanodrive.connectOutput(this.snapshot.voice);
		} else {
			const id = this.outputId;
			await this.nanodrive.disconnectOutput();
			if (id === this.outputId && this.keyboardOutputMode === 'emulation') {
				await this.emulation!.connect(message.sampleRate as number, this.snapshot.voice);
			}
		}
	}

	private async resetOutput(message: { id: unknown; mode: unknown }): Promise<void> {
		if (message.id !== this.outputId || message.mode !== this.keyboardOutputMode || this.resettingOutput || !workspace.isTrusted) { return; }
		const id = this.outputId;
		this.resettingOutput = true;
		clearTimeout(this.bendTimer); this.bendTimer = undefined; this.pendingBends.clear();
		try {
			if (this.keyboardOutputMode === 'nanodrive8') { await this.nanodrive.resetOutput(this.snapshot.voice); }
			else { await this.emulation?.reset(this.snapshot.voice); }
		} finally {
			this.resettingOutput = false;
			if (id === this.outputId) {
				this.setVoiceTesting(false); this.restorePitchBends();
				void this.view?.webview.postMessage({ type: 'outputReset', id, connected: this.keyboardOutputMode === 'nanodrive8' ? this.nanodrive.outputState.connected : this.emulationConnected });
			}
		}
	}

	private note(command: Exclude<NanoDriveInput, { type: 'init' | 'voice' } | { type: 'stop' }>): void {
		if (command.type === 'pitchBend') {
			this.pendingBends.set(`${command.source}:${command.channel}`, command);
			this.bendTimer ??= setTimeout(() => this.flushPitchBends(), 16);
			return;
		}
		this.flushPitchBends();
		this.sendNote(command);
	}

	private flushPitchBends(): void {
		clearTimeout(this.bendTimer); this.bendTimer = undefined;
		for (const command of this.pendingBends.values()) { this.sendNote(command); }
		this.pendingBends.clear();
	}

	private restorePitchBends(): void {
		if (this.pitchBendValue !== 8192) { this.note({ type: 'pitchBend', source: 0, channel: 0, value: this.pitchBendValue }); }
		this.midiInput.pitchBends.forEach((value, channel) => {
			if (value !== 8192) { this.note({ type: 'pitchBend', source: 1, channel, value }); }
		});
		void this.view?.webview.postMessage({ type: 'pitchBend', value: this.pitchBendValue });
	}

	private sendNote(command: Exclude<NanoDriveInput, { type: 'init' | 'voice' } | { type: 'stop' }>): void {
		if (this.voiceTesting || this.resettingOutput) { return; }
		if (this.keyboardOutputMode === 'nanodrive8') { this.nanodrive.note(command); }
		else { this.emulation?.note(command); }
	}

	private setVoiceTesting(playing: boolean, error = false): void {
		this.voiceTesting = playing;
		this.voiceTestVoice = playing ? JSON.stringify(this.snapshot.voice) : '';
		void this.view?.webview.postMessage({ type: 'voiceTest', id: this.outputId, playing, error });
	}

	private async voiceTestAction(message: { id: unknown; action: unknown; mml: unknown }): Promise<void> {
		if (message.id !== this.outputId) { return; }
		if (message.action === 'stop') {
			this.emulation?.stopVoiceTest(); await this.nanodrive.stopVoiceTest(); return;
		}
		if (message.action !== 'play' || !workspace.isTrusted || !this.snapshot.voice || this.snapshot.error
			|| typeof message.mml !== 'string' || !message.mml.trim() || message.mml.length > 8192 || /[\r\n]/.test(message.mml)) {
			this.setVoiceTesting(false, true); return;
		}
		this.voiceTestVoice = JSON.stringify(this.snapshot.voice);
		if (this.keyboardOutputMode === 'nanodrive8' && this.nanodrive.outputState.connected) {
			await this.nanodrive.startVoiceTest(message.mml, this.snapshot.voice);
		} else if (this.keyboardOutputMode === 'emulation' && this.emulationConnected) {
			this.emulation?.startVoiceTest(message.mml, this.snapshot.voice);
		} else { this.setVoiceTesting(false); }
	}

	private sendPlayback(): void {
		const document = this.playbackDocument;
		void this.view?.webview.postMessage({ type: 'playback', id: this.playbackId,
			available: !!document && !document.isClosed && workspace.isTrusted && (!!this.playback || this.nanodriveAvailable),
			mode: this.playbackMode, busy: this.nanodrive.playbackState.busy,
			document: document?.uri.toString() ?? '', source: document ? basename(document.fileName) : '',
			...this.playbackState });
	}

	private stopPlayback(reset = true, error = ''): void {
		this.playbackState.playing = false;
		this.playbackState.paused = false;
		this.playbackState.loading = false;
		this.playbackState.finished = false;
		this.playbackState.error = error;
		if (reset) { this.playbackState.position = 0; }
		this.playback?.disconnect(error);
		void this.nanodrive.stopPlayback(error);
		this.sendPlayback();
	}

	private async playbackAction(message: { action?: unknown; mode?: unknown; id?: unknown; document?: unknown; sampleRate?: unknown; looped?: unknown; volume?: unknown; error?: unknown }): Promise<void> {
		if (!Number.isSafeInteger(message.id)) { return; }
		if (message.action === 'play' || message.action === 'playFromCursor') {
			const document = this.playbackDocument;
			const hardware = message.mode === 'nanodrive8';
			if (!document || document.isClosed || message.document !== document.uri.toString() || !workspace.isTrusted
				|| (hardware ? !this.nanodriveAvailable || !this.nanodrive.state.connected : !this.playback) || this.nanodrive.playbackState.busy
				|| (hardware && message.action === 'playFromCursor')) {
				this.sendPlayback(); return;
			}
			const editor = this.editor;
			if (message.action === 'playFromCursor' && editor?.document !== document) { this.sendPlayback(); return; }
			const source = document.getText();
			const cursor = message.action === 'playFromCursor' && editor
				? new TextEncoder().encode(source.slice(0, document.offsetAt(editor.selection.active))).length : undefined;
			this.playbackId = message.id as number;
			this.playbackMode = hardware ? 'nanodrive8' : 'emulation';
			this.playbackState = { playing: false, paused: false, loading: true, position: 0, finished: false, error: '' };
			const folder = workspace.getWorkspaceFolder(document.uri);
			const configuration = workspace.getConfiguration('mmlx', folder?.uri);
			const adpcmMode = configuration.get<NanoDriveAdpcmMode>('build.adpcmMode', 'resample');
			const configured = configuration.get<string>('build.pdx', '');
			const loadPdx = async (name: string) => workspace.fs.readFile(configured ? resolveUri(configured, folder) : await findPdx(document.uri, name));
			if (hardware) {
				if (typeof message.volume === 'number' && Number.isFinite(message.volume) && message.volume >= 0 && message.volume <= 1) {
					void this.nanodrive.setVolume(message.volume);
				}
				this.playback?.disconnect();
				await this.nanodrive.startPlayback(source, message.looped === true, loadPdx, { adpcmMode, pdxConfigured: configured.length > 0 });
			} else { await this.playback!.connect(message.sampleRate as number, null, {
				source, looped: message.looped === true, cursor, adpcmMode, pdxConfigured: configured.length > 0, loadPdx
			}); }
		} else if (message.id === this.playbackId) {
			if (message.action === 'stop' || message.action === 'ended') {
				this.stopPlayback(message.action === 'stop', typeof message.error === 'string' ? message.error.slice(0, 4096) : '');
			}
			else if (this.playbackMode === 'emulation' && message.action === 'pause' && this.playbackState.playing && !this.playbackState.finished) {
				this.playbackState.playing = false; this.playbackState.paused = true; this.sendPlayback();
			} else if (this.playbackMode === 'emulation' && message.action === 'resume' && this.playbackState.paused && this.playbackConnected) {
				this.playbackState.paused = false; this.playbackState.playing = true; this.sendPlayback();
			}
		}
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
		this.sendConnectionSettings();
		let error = '';
		try {
			await workspace.getConfiguration('mmlx', folder.uri).update(`build.${key}`, value, ConfigurationTarget.WorkspaceFolder);
		} catch (failure) {
			error = failure instanceof Error ? failure.message : 'Could not save build settings.';
		} finally {
			this.savingSettings = false;
			this.sendBuildSettings(error);
			this.sendConnectionSettings();
		}
	}

	private sendConnectionSettings(): void {
		this.sendSerialSettings();
		this.sendMidiSettings();
	}

	private sendSerialSettings(error = ''): void {
		const folder = this.buildSettingsFolder();
		const connection = workspace.getConfiguration('mmlx', folder?.uri).get<string>('serial.connection', '');
		const state = this.nanodrive.state;
		if (state.port && !state.closing && (this.serialFolder !== folder?.uri.toString() || state.port !== connection)) {
			void this.nanodrive.disconnect(); return;
		}
		void this.view?.webview.postMessage({ type: 'serialSettings', connection, ports: this.serialPorts,
			folder: folder?.uri.toString() ?? '', editable: !!folder && !this.savingSettings && !this.serialLoading
				&& !state.connected && !state.connecting && !state.closing,
			connected: state.connected, connecting: state.connecting, closing: state.closing, phase: state.phase,
			model: state.model, firmware: state.firmware,
			canConnect: !!folder && workspace.isTrusted && this.nanodriveAvailable && !this.savingSettings && !this.serialLoading
				&& !state.closing && !!connection && this.serialPorts.some(port => port.path === connection),
			saving: this.savingSettings, loading: this.serialLoading,
			error: error || state.error || this.serialError || (folder ? '' : 'Open a workspace folder to edit connection settings.') });
	}

	private async setSerialConnection(message: { folder?: unknown; connected?: unknown }): Promise<void> {
		const folder = this.buildSettingsFolder();
		if (!folder || message.folder !== folder.uri.toString() || typeof message.connected !== 'boolean') {
			this.sendSerialSettings(); return;
		}
		if (!message.connected) { await this.nanodrive.disconnect(); return; }
		const state = this.nanodrive.state;
		if (!workspace.isTrusted || !this.nanodriveAvailable || this.savingSettings || this.serialLoading || state.connected || state.connecting || state.closing) {
			this.sendSerialSettings(); return;
		}
		const connection = workspace.getConfiguration('mmlx', folder.uri).get<string>('serial.connection', '');
		if (!connection || !this.serialPorts.some(port => port.path === connection)) {
			this.sendSerialSettings('Select an available NanoDrive8 port.'); return;
		}
		this.serialFolder = folder.uri.toString();
		await this.nanodrive.connect(connection);
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
			if (this.nanodrive.state.port && !this.serialPorts.some(port => port.path === this.nanodrive.state.port)) {
				await this.nanodrive.disconnect('NanoDrive8 port is no longer available.');
			}
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
		const state = this.nanodrive.state;
		if (!folder || message.folder !== folder.uri.toString() || this.savingSettings || this.serialLoading
			|| state.connected || state.connecting || state.closing) {
			this.sendSerialSettings(); return;
		}
		if (typeof message.value !== 'string' || (message.value !== '' && !this.serialPorts.some(port => port.path === message.value))) {
			this.sendSerialSettings('Invalid serial port.'); return;
		}
		this.savingSettings = true;
		this.sendBuildSettings();
		this.sendConnectionSettings();
		let error = '';
		try {
			await workspace.getConfiguration('mmlx', folder.uri).update('serial.connection', message.value, ConfigurationTarget.WorkspaceFolder);
		} catch (failure) {
			error = failure instanceof Error ? failure.message : 'Could not save connection settings.';
		} finally {
			this.savingSettings = false;
			this.sendBuildSettings();
			this.sendSerialSettings(error);
			this.sendMidiSettings();
		}
	}

	private updateConnectionMarker(): void {
		if (!this.view) { return; }
		const connections = [];
		if (this.emulationConnected) { connections.push('YM2151 (ymfm)'); }
		if (this.playbackConnected) { connections.push('Playback (ymfm)'); }
		if (this.nanodrive.state.connected) { connections.push('NanoDrive8'); }
		if (this.midiInput.state.connected) { connections.push('MIDI-IN'); }
		this.view.title = connections.length ? 'mmlx [Connected]' : 'mmlx';
		this.view.badge = connections.length ? { value: connections.length, tooltip: `Connected: ${connections.join(', ')}` } : undefined;
	}

	private sendMidiSettings(error = ''): void {
		this.updateConnectionMarker();
		const folder = this.buildSettingsFolder();
		const connection = workspace.getConfiguration('mmlx', folder?.uri).get<string>('midi.input', '');
		const state = this.midiInput.state;
		if (state.port && (this.midiFolder !== folder?.uri.toString() || state.port !== connection)) {
			this.midiInput.disconnect(); return;
		}
		void this.view?.webview.postMessage({ type: 'midiSettings', connection, ports: this.midiPorts,
			folder: folder?.uri.toString() ?? '', editable: !!folder && !this.savingSettings && !this.midiLoading
				&& !state.connected && !state.connecting,
			connected: state.connected, connecting: state.connecting,
			canConnect: !!folder && workspace.isTrusted && !this.savingSettings && !this.midiLoading
				&& !!connection && this.midiPorts.includes(connection),
			saving: this.savingSettings, loading: this.midiLoading,
			error: error || state.error || this.midiError || (folder ? '' : 'Open a workspace folder to edit connection settings.') });
	}

	private async setMidiInputConnection(message: { folder?: unknown; connected?: unknown }): Promise<void> {
		const folder = this.buildSettingsFolder();
		if (!folder || message.folder !== folder.uri.toString() || typeof message.connected !== 'boolean') {
			this.sendMidiSettings(); return;
		}
		if (!message.connected) { this.midiInput.disconnect(); return; }
		const connection = workspace.getConfiguration('mmlx', folder.uri).get<string>('midi.input', '');
		if (!workspace.isTrusted || this.savingSettings || this.midiLoading || this.midiInput.state.connecting
			|| this.midiInput.state.connected) { this.sendMidiSettings(); return; }
		if (!connection || !this.midiPorts.includes(connection)) {
			this.sendMidiSettings('Select an available MIDI input port.'); return;
		}
		this.midiFolder = folder.uri.toString();
		await this.midiInput.connect(connection);
	}

	private async refreshMidiInputPorts(): Promise<void> {
		if (this.midiLoading) { this.sendMidiSettings(); return; }
		this.midiLoading = true;
		this.midiError = '';
		this.sendMidiSettings();
		try {
			this.midiPorts = [...new Set((await this.getMidiInputPorts()).filter(port => port.trim()))]
				.sort((first, second) => first.localeCompare(second, undefined, { numeric: true }));
			if (this.midiInput.state.connected && !this.midiPorts.includes(this.midiInput.state.port)) {
				this.midiInput.disconnect('MIDI input port is no longer available.');
			}
		} catch (failure) {
			this.midiPorts = [];
			this.midiError = failure instanceof Error ? failure.message : 'Could not list MIDI input ports.';
		} finally {
			this.midiLoading = false;
			this.sendMidiSettings();
		}
	}

	private async updateMidiInput(message: { folder?: unknown; value?: unknown }): Promise<void> {
		const folder = this.buildSettingsFolder();
		if (!folder || message.folder !== folder.uri.toString() || this.savingSettings || this.midiLoading
			|| this.midiInput.state.connected || this.midiInput.state.connecting) {
			this.sendMidiSettings(); return;
		}
		if (typeof message.value !== 'string' || (message.value !== '' && !this.midiPorts.includes(message.value))) {
			this.sendMidiSettings('Invalid MIDI input port.'); return;
		}
		this.savingSettings = true;
		this.sendBuildSettings();
		this.sendConnectionSettings();
		let error = '';
		try {
			await workspace.getConfiguration('mmlx', folder.uri).update('midi.input', message.value, ConfigurationTarget.WorkspaceFolder);
		} catch (failure) {
			error = failure instanceof Error ? failure.message : 'Could not save MIDI input settings.';
		} finally {
			this.savingSettings = false;
			this.sendBuildSettings();
			this.sendSerialSettings();
			this.sendMidiSettings(error);
		}
	}

	private follow(editor: TextEditor | undefined): void {
		const document = editor?.document.languageId === 'mmlx' ? editor.document : undefined;
		if (document !== this.playbackDocument) {
			this.playbackDocument = document;
			this.stopPlayback();
		} else { this.sendPlayback(); }
		if (editor?.document.languageId !== 'mmlx') { return; }
		this.editor = editor;
		const target = this.editTarget;
		const range = target?.voice.range;
		if (target && range && !this.editing && !this.snapshot.retained && !this.snapshot.error
			&& target.document === editor.document && target.version === editor.document.version
			&& this.getClient()?.isRunning()
			&& editor.selection.active.isAfterOrEqual(new Position(range.start.line, range.start.character))
			&& editor.selection.active.isBefore(new Position(range.end.line, range.end.character))) {
			return;
		}
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
		if (this.voiceTesting && (this.snapshot.error || this.voiceTestVoice !== JSON.stringify(this.snapshot.voice))) {
			this.emulation?.stopVoiceTest(); void this.nanodrive.stopVoiceTest();
		}
		if (!this.snapshot.error) { this.emulation?.setVoice(this.snapshot.voice); this.nanodrive.setVoice(this.snapshot.voice); }
		const target = this.editTarget;
		const editable = !!target && !this.editing && !this.snapshot.retained && !this.snapshot.error
			&& !target.document.isClosed && target.document.version === target.version;
		void this.view?.webview.postMessage({ type: 'voice', ...this.snapshot, editing: this.editing,
			editable, editToken: editable ? target.token : null });
	}

	async disconnectNanoDrive(): Promise<void> {
		await this.nanodrive.disconnect();
		await this.nanodriveWorker?.dispose();
	}

	dispose(): void {
		this.view = undefined;
		void this.disconnectNanoDrive();
		this.emulation?.dispose();
		this.playback?.dispose();
		this.midiInput.disconnect();
		clearTimeout(this.timer);
		clearTimeout(this.bendTimer);
		this.pendingBends.clear();
		this.sequence++;
		this.editTarget = undefined;
	}
}