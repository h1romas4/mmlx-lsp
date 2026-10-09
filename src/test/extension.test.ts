import * as assert from 'assert';
import * as path from 'node:path';
import { EventEmitter as NodeEventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';
import { Wasm } from '@vscode/wasm-wasi/v1';
import { createUriConverters } from '@vscode/wasm-wasi-lsp';
import type { LanguageClient } from 'vscode-languageclient/node';
import { BuildTerminal, buildErrorLinkProvider } from '../tasks';
import { listMidiInputPorts, VoiceViewProvider } from '../voiceView';
import { MidiInputConnection } from '../midiInput';
import { EmulationSession, type EmulationState, type PlaybackProgress } from '../emulation';
import { NanoDriveWorker } from '../nanodriveWorker';
import { Port as NanoDriveTestPort, codec as nanoDriveTestCodec } from './nanodrive.test';

const playbackSource = '@1 = {\n' + '31,0,0,15,0,32,0,1,0,0,0,\n'.repeat(4) + '7,0,15\n}\nA t120 @1 o4 l8 cdef\n';

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
	definition: ConstructorParameters<typeof BuildTerminal>[2], cancel: boolean | ((output: string) => boolean) = false
): Promise<{ code: number; output: string; links: ReturnType<BuildTerminal['errorLinks']> }> {
	const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
	assert.ok(extension);
	await extension.activate();
	const diagnostics = vscode.languages.createDiagnosticCollection('mmlx build log test');
	const terminal = new BuildTerminal(extension.extensionUri, await Wasm.load(), definition,
		vscode.workspace.getWorkspaceFolder(vscode.Uri.file(definition.input)), diagnostics, () => undefined);
	let output = '';
	const subscription = terminal.onDidWrite(data => {
		output += data;
		if (typeof cancel === 'function' && cancel(data)) { terminal.close(); }
	});
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let closeSubscription: vscode.Disposable | undefined;
	try {
		const code = await new Promise<number>((resolve, reject) => {
			timeout = setTimeout(() => { reject(new Error('Build terminal timed out')); terminal.close(); }, 30000);
			closeSubscription = terminal.onDidClose(resolve);
			terminal.open();
			if (cancel === true) { terminal.close(); }
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
	test('Webview AudioWorklet plays PCM from the real WASI YM2151 backend while hidden', async function () {
		this.timeout(15000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const media = vscode.Uri.joinPath(extension.extensionUri, 'assets', 'webview');
		const panel = vscode.window.createWebviewPanel('mmlx.audioOutputTest', 'mmlx Audio Output Test', vscode.ViewColumn.Beside,
			{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
		const hiddenDocument = await vscode.workspace.openTextDocument({ language: 'plaintext', content: '' });
		type AudioResult = { pcmBlocks: number; requestedBlocks: number; maxRms: number; hiddenBlocks: number; hiddenRms: number; analysisPeak: number; spectrumPeak: number; state: string };
		let resolveResult!: (message: AudioResult) => void;
		let rejectResult!: (error: Error) => void;
		const response = new Promise<AudioResult>((resolve, reject) => {
			resolveResult = resolve; rejectResult = reject;
		});
		const tone = { algorithm: 2, feedback: 7, operatorMask: 15, operators: [
			{ ar: 28, d1r: 4, d2r: 0, rr: 5, d1l: 1, tl: 37, ks: 2, mul: 1, dt1: 7, dt2: 0, ame: 0 },
			{ ar: 22, d1r: 9, d2r: 1, rr: 2, d1l: 1, tl: 47, ks: 2, mul: 12, dt1: 0, dt2: 0, ame: 0 },
			{ ar: 29, d1r: 4, d2r: 3, rr: 6, d1l: 1, tl: 37, ks: 1, mul: 3, dt1: 3, dt2: 0, ame: 0 },
			{ ar: 15, d1r: 7, d2r: 0, rr: 5, d1l: 10, tl: 0, ks: 2, mul: 1, dt1: 0, dt2: 0, ame: 1 }
		] };
		const session = new EmulationSession(extension.extensionUri, await Wasm.load(), state => {
			if (state.error) { rejectResult(new Error(state.error)); }
			void panel.webview.postMessage({ type: 'state', ...state });
		}, pcm => { void panel.webview.postMessage({ type: 'pcm', pcm }); });
		const stages: unknown[] = [];
		async function startWithUserGesture(): Promise<void> {
			const targets = await (await fetch('http://127.0.0.1:9237/json')).json() as { webSocketDebuggerUrl?: string }[];
			for (const target of targets) {
				if (!target.webSocketDebuggerUrl) { continue; }
				const socket = new WebSocket(target.webSocketDebuggerUrl);
				const contexts: number[] = [];
				const pending = new Map<number, { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }>();
				let sequence = 0;
				socket.addEventListener('message', event => {
					const message = JSON.parse(String(event.data));
					if (message.method === 'Runtime.executionContextCreated') { contexts.push(message.params.context.id); }
					const request = pending.get(message.id);
					if (request) { pending.delete(message.id); if (message.error) { request.reject(new Error(message.error.message)); } else { request.resolve(message.result); } }
				});
				function command(method: string, params = {}): Promise<Record<string, unknown>> {
					return new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
				}
				try {
					await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', () => reject(new Error('Test renderer debug connection failed')), { once: true }); });
					await command('Runtime.enable');
					for (const contextId of contexts) {
						const probe = await command('Runtime.evaluate', { expression: 'typeof window.__mmlxConnectAudio', contextId, returnByValue: true });
						if ((probe.result as { value?: unknown })?.value === 'function') {
							const blocked = await command('Runtime.evaluate', {
								expression: 'Promise.race([window.__mmlxProbeBlockedAudio(), new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 700))])',
								contextId, userGesture: false, awaitPromise: true, returnByValue: true
							});
							assert.deepStrictEqual((blocked.result as { value?: unknown })?.value,
								{ blocked: true, error: 'Error: Audio output requires a click in the mmlx panel.' });
							for (const userGesture of [true, false]) {
								const enabled = await command('Runtime.evaluate', {
									expression: 'window.__mmlxProbeBlockedAudio()', contextId, userGesture, awaitPromise: true, returnByValue: true
								});
								assert.deepStrictEqual((enabled.result as { value?: unknown })?.value, { blocked: false });
							}
							await command('Runtime.evaluate', { expression: 'window.__mmlxConnectAudio()', contextId, userGesture: true });
							return;
						}
					}
				} finally { socket.close(); }
			}
			throw new Error('Audio test Webview renderer was not found');
		}
		const listener = panel.webview.onDidReceiveMessage(message => {
			if (message.type === 'stage') {
				stages.push(message);
				if (message.stage === 'moduleLoaded') { void startWithUserGesture().catch(rejectResult); }
				if (message.stage === 'streaming') {
					void vscode.window.showTextDocument(hiddenDocument, { viewColumn: panel.viewColumn }).then(() => {
						assert.strictEqual(panel.visible, false);
						return panel.webview.postMessage({ type: 'hidden' });
					}).then(undefined, error => rejectResult(error));
				}
			}
			if (message.type === 'ready') {
				void session.connect(message.sampleRate, tone).then(() => {
					session.note({ type: 'noteOn', source: 0, channel: 0, note: 69, velocity: 127 });
				});
			} else if (message.type === 'render') { session.request(message.blocks); }
			else if (message.type === 'result') { resolveResult(message); }
			else if (message.type === 'failure') { rejectResult(new Error(message.error)); }
		});
		const nonce = randomUUID();
		const audioUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'emulationAudio.js')).toString();
		panel.webview.html = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${panel.webview.cspSource}; worker-src ${panel.webview.cspSource} blob:; connect-src ${panel.webview.cspSource};"></head><body>
			<script type="module" nonce="${nonce}">
			import { createEmulationAudio } from '${audioUri}';
			const api = acquireVsCodeApi();
			const NativeContext = AudioContext;
			window.AudioContext = class extends NativeContext {
				constructor(options) { super(options); api.postMessage({ type: 'stage', stage: 'contextCreated', state: this.state }); }
				async resume() {
					api.postMessage({ type: 'stage', stage: 'resumeStarted', state: this.state });
					await super.resume(); api.postMessage({ type: 'stage', stage: 'resumeFinished', state: this.state });
				}
			};
			let analyser; let context; let pcmBlocks = 0; let requestedBlocks = 0; let maxRms = 0; let hiddenStart = null; let hiddenRms = 0;
			let analysisPeak = 0; let spectrumPeak = -Infinity;
			const NativeNode = AudioWorkletNode;
			window.AudioWorkletNode = class extends NativeNode {
				constructor(audio, ...options) {
					super(audio, ...options); context = audio; analyser = audio.createAnalyser(); analyser.fftSize = 2048;
					const mute = audio.createGain(); mute.gain.value = 0;
					this.connect(analyser); analyser.connect(mute).connect(audio.destination);
				}
			};
			const audio = createEmulationAudio(blocks => { requestedBlocks += blocks; api.postMessage({ type: 'render', blocks }); },
				error => api.postMessage({ type: 'failure', error }));
			window.__mmlxProbeBlockedAudio = async () => {
				try { await audio.connect(); audio.disconnect(); return { blocked: false }; }
				catch (error) { return { blocked: true, error: String(error) }; }
			};
			window.addEventListener('message', event => {
				if (event.data.type === 'pcm') {
					pcmBlocks++; audio.pcm(event.data.pcm);
					if (pcmBlocks === 8) { api.postMessage({ type: 'stage', stage: 'streaming' }); }
				}
				else if (event.data.type === 'state' && event.data.connected) { audio.start(); }
				else if (event.data.type === 'hidden') { hiddenStart = pcmBlocks; }
			});
			window.__mmlxConnectAudio = async () => { try {
				const sampleRate = await audio.connect();
				api.postMessage({ type: 'ready', sampleRate });
				const samples = new Float32Array(2048);
				const meter = setInterval(() => {
					analyser.getFloatTimeDomainData(samples);
					const analysis = audio.readAnalysis();
					if (analysis) {
						for (const value of analysis.samples) { analysisPeak = Math.max(analysisPeak, Math.abs(value)); }
						for (const value of analysis.decibels) { spectrumPeak = Math.max(spectrumPeak, value); }
					}
					const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
					maxRms = Math.max(maxRms, rms);
					if (hiddenStart !== null) { hiddenRms = Math.max(hiddenRms, rms); }
				}, 20);
				setTimeout(() => {
					clearInterval(meter);
					api.postMessage({ type: 'result', pcmBlocks, requestedBlocks, maxRms, hiddenBlocks: hiddenStart === null ? 0 : pcmBlocks - hiddenStart, hiddenRms, analysisPeak, spectrumPeak, state: context.state });
					audio.disconnect();
				}, 1000);
			} catch (error) { api.postMessage({ type: 'failure', error: String(error) }); audio.disconnect(); } };
			api.postMessage({ type: 'stage', stage: 'moduleLoaded', secure: isSecureContext, activation: navigator.userActivation.isActive });
			</script></body></html>`;
		const timer = setTimeout(() => rejectResult(new Error(`Webview audio output timed out: ${JSON.stringify(stages)}`)), 8000);
		try {
			const result = await response;
			console.log('Webview audio output:', JSON.stringify(result));
			assert.strictEqual(result.state, 'running');
			assert.ok(result.requestedBlocks > 4, JSON.stringify(result));
			assert.ok(result.pcmBlocks > 4, JSON.stringify(result));
			assert.ok(result.maxRms > 0.0001, JSON.stringify(result));
			assert.ok(result.hiddenBlocks > 4, JSON.stringify(result));
			assert.ok(result.hiddenRms > 0.0001, JSON.stringify(result));
			assert.ok(result.analysisPeak > 0.0001, JSON.stringify(result));
			assert.ok(result.spectrumPeak > -80 && result.spectrumPeak <= 0, JSON.stringify(result));
		} finally { clearTimeout(timer); listener.dispose(); session.dispose(); panel.dispose(); }
	});
	test('FM Voice audio analysis preserves output and releases buffers on reconnect', async () => {
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const { createEmulationAudio } = await import(vscode.Uri.joinPath(extension.extensionUri, 'assets', 'webview', 'emulationAudio.js').toString());
		const globals = globalThis as unknown as Record<string, unknown>;
		const original = { AudioContext: globals.AudioContext, AudioWorkletNode: globals.AudioWorkletNode };
		class MockNode {
			outputs: unknown[] = []; disconnected = false;
			connect(target: unknown): void { this.outputs.push(target); }
			disconnect(): void { this.disconnected = true; }
		}
		class MockAnalyser extends MockNode {
			fftSize = 0;
			get frequencyBinCount(): number { return this.fftSize / 2; }
			getFloatTimeDomainData(data: Float32Array): void { data.fill(.25); }
			getFloatFrequencyData(data: Float32Array): void { data.fill(-20); }
		}
		class MockContext {
			state = 'running'; sampleRate = 48000; destination = {};
			audioWorklet = { addModule: async () => {} };
			analysers: MockAnalyser[] = [];
			gain = Object.assign(new MockNode(), { gain: { value: 1 } });
			constructor() { contexts.push(this); }
			async resume(): Promise<void> { this.state = 'running'; }
			async close(): Promise<void> { this.state = 'closed'; }
			createGain(): typeof this.gain { return this.gain; }
			createAnalyser(): MockAnalyser { const node = new MockAnalyser(); this.analysers.push(node); return node; }
		}
		const contexts: MockContext[] = [];
		const worklets: MockNode[] = [];
		globals.AudioContext = MockContext;
		globals.AudioWorkletNode = class extends MockNode {
			port = { postMessage: () => {} };
			constructor() { super(); worklets.push(this); }
		};
		const audio = createEmulationAudio(() => {}, () => {});
		try {
			assert.strictEqual(audio.readAnalysis(), null);
			await audio.connect();
			assert.strictEqual(contexts[0].analysers.length, 0);
			const data = audio.readAnalysis();
			assert.strictEqual(data.sampleRate, 48000);
			assert.strictEqual(data.samples.length, 32768); assert.strictEqual(data.decibels.length, 4096);
			assert.strictEqual(data.samples[0], .25); assert.strictEqual(data.decibels[0], -20);
			assert.strictEqual(audio.readAnalysis(), data);
			assert.strictEqual(worklets[0].outputs[0], contexts[0].gain);
			assert.strictEqual(contexts[0].gain.outputs[0], contexts[0].destination);
			assert.strictEqual(worklets[0].outputs.length, 3);
			contexts[0].state = 'suspended'; assert.strictEqual(audio.readAnalysis(), null);
			contexts[0].state = 'running';
			audio.disconnect(); assert.strictEqual(audio.readAnalysis(), null);
			assert.ok(contexts[0].analysers.every(node => node.disconnected));
			await audio.connect(); assert.notStrictEqual(audio.readAnalysis(), data);
		} finally {
			audio.disconnect();
			for (const [name, value] of Object.entries(original)) { if (value === undefined) { delete globals[name]; } else { globals[name] = value; } }
		}
	});

	test('FM Voice oscilloscope aligns reference periods across sample rates and pitches', async () => {
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const { noteFrequency, findScopeStart } = await import(vscode.Uri.joinPath(extension.extensionUri, 'assets', 'webview', 'audioMonitors.js').toString());
		assert.strictEqual(noteFrequency(69), 440);
		for (const sampleRate of [44100, 48000, 96000]) {
			for (const note of [0, 36, 69, 108, 127]) {
				const period = sampleRate / noteFrequency(note); const span = period * 2;
				const wave = (phase: number) => Float32Array.from({ length: 32768 }, (_, index) => .4 * Math.sin(2 * Math.PI * index / period + phase));
				const first = wave(0); const shifted = wave(1.7);
				const sample = (samples: Float32Array, position: number) => {
					const index = Math.floor(position); return samples[index] + (samples[index + 1] - samples[index]) * (position - index);
				};
				const start = findScopeStart(first, period, span);
				const reference = Float32Array.from({ length: 128 }, (_, index) => sample(first, start + span * index / 127));
				const aligned = findScopeStart(shifted, period, span, reference);
				const error = Math.sqrt(reference.reduce((sum, value, index) => sum + (value - sample(shifted, aligned + span * index / 127)) ** 2, 0) / reference.length);
				assert.ok(aligned >= 0 && aligned + span < first.length - 1);
				assert.ok(error < .12, `MIDI ${note} at ${sampleRate} Hz: ${error}`);
			}
		}
	});

	test('FM Voice audio monitors draw signal, follow notes and stop rendering when hidden', async function () {
		this.timeout(15000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const media = vscode.Uri.joinPath(extension.extensionUri, 'assets', 'webview');
		const panel = vscode.window.createWebviewPanel('mmlx.monitorTest', 'mmlx Audio Monitor Test', vscode.ViewColumn.Beside,
			{ enableScripts: true, localResourceRoots: [media] });
		let resolveResult!: () => void; let rejectResult!: (error: Error) => void;
		const result = new Promise<void>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
		const listener = panel.webview.onDidReceiveMessage(message => {
			if (message.type === 'monitorResult') { resolveResult(); }
			else if (message.type === 'monitorFailure') { rejectResult(new Error(message.error)); }
		});
		const nonce = randomUUID();
		const template = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(media, 'voice.html')));
		const probe = `<script type="module" nonce="${nonce}">
		import { createAudioMonitors } from '${panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'audioMonitors.js'))}';
		const api = acquireVsCodeApi();
		const check = (condition, message) => { if (!condition) { throw new Error(message); } };
		const wait = () => new Promise(resolve => setTimeout(resolve, 90));
		const root = document.getElementById('audio-monitors');
		const section = document.getElementById('voice-controls'); section.hidden = false;
		document.getElementById('start-controls').hidden = true;
		const data = { sampleRate: 48000, samples: Float32Array.from({ length: 32768 }, (_, index) => .4 * Math.sin(2 * Math.PI * 440 * index / 48000)), decibels: new Float32Array(4096).fill(-100) };
		data.decibels[Math.round(440 * 8192 / 48000)] = -12;
		let reads = 0;
		const monitors = createAudioMonitors(root, () => { reads++; return data; });
		try {
			check(root.dataset.state === 'disconnected', 'Monitors must start disconnected');
			monitors.setNote({ event: 'noteOn', note: 69, velocity: 100 }); monitors.setConnected(true);
			check(root.dataset.state === 'active' && document.getElementById('scope-reference').textContent.includes('440.0 Hz'), 'Signal and note reference must appear');
			check(monitors.gain === 4, 'Oscilloscope must default to fixed x4 gain');
			const gainInput = document.getElementById('scope-gain');
			gainInput.value = '16'; gainInput.dispatchEvent(new Event('change'));
			check(monitors.gain === 16, 'Gain control must adjust the fixed amplitude scale');
			monitors.setGain(1); check(gainInput.value === '1', 'Saved gain must restore the control');
			monitors.setGain(99); check(monitors.gain === 4, 'Invalid saved gain must fall back to x4');
			for (const width of [800, 320]) {
				root.style.width = width + 'px'; await wait();
				const scope = root.querySelector('#oscilloscope'); const spectrum = root.querySelector('#spectrum');
				const context = spectrum.getContext('2d'); const originalText = context.fillText;
				const labels = [];
				context.fillText = function(text, horizontal, vertical) {
					if (vertical > spectrum.clientHeight - 20) {
						const size = this.measureText(text).width;
						const left = horizontal - (this.textAlign === 'center' ? size / 2 : this.textAlign === 'right' ? size : 0);
						labels.push({ text, left, right: left + size });
					}
					originalText.call(this, text, horizontal, vertical);
				};
				monitors.setConnected(true); context.fillText = originalText;
				check(labels.at(-1).text === '20k', 'Spectrum must retain the maximum frequency label');
				for (let index = 1; index < labels.length; index++) { check(labels[index].left - labels[index - 1].right >= 5, 'Frequency labels must not overlap'); }
				const first = scope.getBoundingClientRect(); const second = spectrum.getBoundingClientRect();
				check(width === 800 ? Math.abs(first.top - second.top) < 1 : second.top > first.bottom, 'Monitors must adapt to panel width');
				check(scope.height === Math.round(scope.clientHeight * Math.min(devicePixelRatio || 1, 3)), 'Canvas must use device pixel ratio');
				const pixels = scope.getContext('2d').getImageData(0, 0, scope.width, scope.height).data;
				let waveform = 0;
				for (let index = 0; index < pixels.length; index += 4) { if (pixels[index] < 130 && pixels[index + 1] > 150 && pixels[index + 2] > 100) { waveform++; } }
				check(waveform > 100, 'Oscilloscope must draw a visible waveform');
				const bins = spectrum.getContext('2d').getImageData(0, 0, spectrum.width, spectrum.height).data;
				let spectrumPixels = 0;
				for (let index = 0; index < bins.length; index += 4) { if (bins[index] > 180 && bins[index + 1] > 100 && bins[index + 2] < 150) { spectrumPixels++; } }
				check(spectrumPixels > 20, 'Spectrum must draw a visible peak');
			}
			const label = () => document.getElementById('scope-reference').textContent;
			monitors.setNote({ event: 'noteOn', note: 60, velocity: 100 }); monitors.setConnected(true);
			check(label().includes('261.6 Hz'), 'Most recent local note must become the reference');
			monitors.setNote({ type: 'noteOn', channel: 2, note: 72, velocity: 100 }, 'midi'); monitors.setMidiNotes([72]); monitors.setConnected(true);
			check(label().includes('523.3 Hz'), 'MIDI note events must select the reference without duplicate holds');
			monitors.setNote({ type: 'allOff', channel: 2 }, 'midi'); monitors.setMidiNotes([]); monitors.setConnected(true);
			check(label().includes('261.6 Hz'), 'Channel all-off must restore the held local reference');
			monitors.setNote({ event: 'noteOff', note: 60 }); monitors.setConnected(true);
			check(label().includes('440.0 Hz'), 'Release must restore the previous held reference');
			monitors.setNote({ event: 'noteOff', note: 69 }); monitors.setConnected(true);
			check(label().includes('440.0 Hz') && root.dataset.state === 'active', 'Release tail must retain the reference and waveform');
			const beforeHidden = reads; section.hidden = true; await wait();
			check(reads === beforeHidden, 'Hidden tab must stop analysing');
			section.hidden = false; await wait(); check(reads > beforeHidden, 'Visible tab must restart analysing');
			data.samples.fill(0); data.decibels.fill(-Infinity); monitors.setConnected(true);
			check(root.dataset.state === 'silent' && document.getElementById('spectrum-state').textContent === 'Silent', 'Silence must clear the signal state');
			monitors.setConnected(false); const beforeDisconnected = reads; await wait();
			check(reads === beforeDisconnected && root.dataset.state === 'disconnected', 'Disconnect must stop analysing');
			monitors.setConnected(true); monitors.dispose(); const beforeDisposed = reads; await wait();
			check(reads === beforeDisposed, 'Dispose must stop the animation');
			api.postMessage({ type: 'monitorResult' });
		} catch (error) { api.postMessage({ type: 'monitorFailure', error: String(error) }); }
		finally { monitors.dispose(); }
		</script>`;
		panel.webview.html = template.replaceAll('{{cspSource}}', panel.webview.cspSource).replaceAll('{{nonce}}', nonce)
			.replaceAll('{{styleUri}}', panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'voice.css')).toString())
			.replace(/<script type="module"[^>]*src="\{\{scriptUri\}\}"[^>]*><\/script>/, probe);
		const timer = setTimeout(() => rejectResult(new Error('Audio monitor Webview timed out')), 10000);
		try { await result; } finally { clearTimeout(timer); listener.dispose(); panel.dispose(); }
	});
	test('Webview audio PCM arrives as a transferable ArrayBuffer', async function () {
		this.timeout(15000);
		const panel = vscode.window.createWebviewPanel('mmlx.audioTransportTest', 'mmlx Audio Transport Test', vscode.ViewColumn.Beside,
			{ enableScripts: true, retainContextWhenHidden: true });
		let ready!: () => void;
		let received!: (message: { tag: string; isBuffer: boolean; byteLength: number; sample: number }) => void;
		const initialized = new Promise<void>(resolve => { ready = resolve; });
		const response = new Promise<{ tag: string; isBuffer: boolean; byteLength: number; sample: number }>(resolve => { received = resolve; });
		const listener = panel.webview.onDidReceiveMessage(message => {
			if (message.type === 'ready') { ready(); }
			else if (message.type === 'pcmProbe') { received(message); }
		});
		const nonce = randomUUID();
		panel.webview.html = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}';"></head><body>
			<script nonce="${nonce}">
			const api = acquireVsCodeApi();
			window.addEventListener('message', event => {
				const pcm = event.data.pcm;
				api.postMessage({ type: 'pcmProbe', tag: Object.prototype.toString.call(pcm), isBuffer: pcm instanceof ArrayBuffer,
					byteLength: pcm.byteLength, sample: new Float32Array(pcm)[0] });
			});
			api.postMessage({ type: 'ready' });
			</script></body></html>`;
		try {
			await initialized;
			const pcm = new Float32Array(1024); pcm[0] = 0.25;
			assert.ok(await panel.webview.postMessage({ pcm: pcm.buffer }));
			const message = await response;
			assert.strictEqual(message.tag, '[object ArrayBuffer]');
			assert.ok(message.isBuffer, 'PCM buffer must pass the Webview realm check');
			assert.strictEqual(message.byteLength, 4096);
			assert.strictEqual(message.sample, 0.25);
		} finally { listener.dispose(); panel.dispose(); }
	});
	test('YM2151 panel keeps output connected while hidden and releases keyboard notes', async function () {
		this.timeout(20000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const document = await vscode.workspace.openTextDocument({ language: 'mmlx', content: '@0 = {\n' + '31,0,0,15,0,32,0,1,0,0,0,\n'.repeat(4) + '7,0,15\n}\n' });
		await vscode.window.showTextDocument(document);
		const context = { extensionUri: extension.extensionUri, subscriptions: [] as vscode.Disposable[] };
		const messages = new vscode.EventEmitter<unknown>();
		const visibility = new vscode.EventEmitter<void>();
		const disposed = new vscode.EventEmitter<void>();
		type Update = { type: string; id?: number; connected?: boolean; connecting?: boolean; pcm?: ArrayBuffer; voice?: unknown };
		const updates: Update[] = [];
		const changed = new vscode.EventEmitter<Update>();
		const voice = { number: 0, algorithm: 7, feedback: 0, operatorMask: 15, position: { line: 0, character: 0 },
			parameterRanges: [], range: { start: { line: 0, character: 0 }, end: { line: 6, character: 1 } },
			operators: Array.from({ length: 4 }, () => ({ ar: 31, d1r: 0, d2r: 0, rr: 15, d1l: 0, tl: 32, ks: 0, mul: 1, dt1: 0, dt2: 0, ame: 0 })) };
		const client = { isRunning: () => true, sendRequest: async () => voice,
			code2ProtocolConverter: { asTextDocumentPositionParams: () => ({}) } } as unknown as LanguageClient;
		const provider = new VoiceViewProvider(context as unknown as vscode.ExtensionContext, () => client,
			async () => [], async () => [], undefined, await Wasm.load());
		const view = { visible: true, title: 'mmlx', badge: undefined as vscode.ViewBadge | undefined,
			onDidChangeVisibility: visibility.event, onDidDispose: disposed.event,
			webview: { cspSource: 'https://test.invalid', asWebviewUri: (uri: vscode.Uri) => uri,
				onDidReceiveMessage: messages.event, postMessage: (message: Update) => {
					updates.push(message); changed.fire(message); return Promise.resolve(true);
				} } };
		function waitFor(predicate: (message: Update) => boolean, after = 0): Promise<Update> {
			const existing = updates.slice(after).find(predicate);
			if (existing) { return Promise.resolve(existing); }
			return new Promise((resolve, reject) => {
				const subscription = changed.event(message => { if (predicate(message)) { clearTimeout(timer); subscription.dispose(); resolve(message); } });
				const timer = setTimeout(() => { subscription.dispose(); reject(new Error('Panel audio timed out')); }, 4000);
			});
		}
		try {
			await provider.resolveWebviewView(view as unknown as vscode.WebviewView);
			await waitFor(message => message.type === 'voice' && !!message.voice);
			assert.strictEqual(view.title, 'mmlx');
			assert.strictEqual(view.badge, undefined);
			messages.fire({ type: 'setOutputConnection', target: 'keyboard', mode: 'emulation', connected: true, sampleRate: 48000, id: 1 });
			await waitFor(message => message.type === 'outputConnection' && message.id === 1 && message.connected === true);
			assert.strictEqual(view.title, 'mmlx [Connected]');
			assert.deepStrictEqual(view.badge, { value: 1, tooltip: 'Connected: YM2151 (ymfm)' });
			messages.fire({ type: 'emulationNote', event: 'noteOn', note: 60, velocity: 100, id: 1 });
			messages.fire({ type: 'emulationNote', event: 'pitchBend', value: 10240, id: 1 });
			messages.fire({ type: 'emulationNote', event: 'noteOn', note: 64, velocity: 100, id: 1 });
			messages.fire({ type: 'emulationRender', blocks: 4, id: 1 });
			const pcm = (await waitFor(message => message.type === 'emulationPcm'
				&& updates.filter(update => update.type === 'emulationPcm').length === 4)).pcm;
			assert.ok(pcm instanceof ArrayBuffer); assert.strictEqual(pcm.byteLength, 4096);
			assert.ok(new Float32Array(pcm).some(value => Math.abs(value) > 0.0001));
			const start = updates.length;
			messages.fire({ type: 'setOutputConnection', target: 'playback', connected: false });
			messages.fire({ type: 'emulationRender', blocks: 1, id: 1 });
			await waitFor(message => message.type === 'emulationPcm', start);
			const hiddenStart = updates.length;
			view.visible = false; visibility.fire();
			assert.strictEqual(view.title, 'mmlx [Connected]');
			assert.deepStrictEqual(view.badge, { value: 1, tooltip: 'Connected: YM2151 (ymfm)' });
			messages.fire({ type: 'emulationRender', blocks: 4, id: 1 });
			const released = (await waitFor(message => message.type === 'emulationPcm'
				&& updates.slice(hiddenStart).filter(update => update.type === 'emulationPcm').length === 4, hiddenStart)).pcm;
			assert.ok(released instanceof ArrayBuffer);
			assert.ok(new Float32Array(released).every(value => Math.abs(value) < 0.0001), 'Hidden view must release screen-keyboard notes');
			assert.ok(!updates.slice(hiddenStart).some(message => message.type === 'outputConnection' && !message.connected && !message.connecting));
			view.visible = true; visibility.fire();
			const resumedStart = updates.length;
			messages.fire({ type: 'emulationNote', event: 'noteOn', note: 64, velocity: 100, id: 1 });
			messages.fire({ type: 'emulationRender', blocks: 1, id: 1 });
			const resumed = (await waitFor(message => message.type === 'emulationPcm', resumedStart)).pcm;
			assert.ok(resumed instanceof ArrayBuffer);
			assert.ok(new Float32Array(resumed).some(value => Math.abs(value) > 0.0001), 'Showing view must allow notes without reconnecting');
			messages.fire({ type: 'setOutputConnection', target: 'keyboard', connected: false, id: 1 });
			await waitFor(message => message.type === 'outputConnection' && message.id === 1 && !message.connected && !message.connecting, resumedStart);
			assert.strictEqual(view.title, 'mmlx');
			assert.strictEqual(view.badge, undefined);
		} finally {
			provider.dispose();
			for (const subscription of context.subscriptions) { subscription.dispose(); }
			messages.dispose(); visibility.dispose(); disposed.dispose(); changed.dispose();
		}
	});
	test('Playback controls preserve their display during startup and delay the loading indicator', async function () {
		this.timeout(5000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const { createPlaybackControls } = await import(path.join(extension.extensionUri.fsPath, 'assets', 'webview', 'playbackControls.js'));
		function createElement() {
			const attributes = new Map<string, string>();
			const classes = new Set<string>();
			return {
				value: '', textContent: '', title: '', disabled: false, hidden: false, attributes,
				classList: {
					toggle(name: string, enabled: boolean) { if (enabled) { classes.add(name); } else { classes.delete(name); } },
					contains(name: string) { return classes.has(name); }
				},
				setAttribute(name: string, value: string) { attributes.set(name, value); },
				addEventListener() { return; }
			};
		}
		const elements = new Map<string, ReturnType<typeof createElement>>();
		const root = Object.assign(createElement(), {
			querySelector(selector: string) {
				let element = elements.get(selector);
				if (!element) { element = createElement(); elements.set(selector, element); }
				return element;
			}
		});
		const controls = createPlaybackControls(root);
		controls.setMode('emulation');
		const play = root.querySelector('#playback-play');
		const cursor = root.querySelector('#playback-cursor');
		const time = root.querySelector('#playback-time');
		const status = root.querySelector('[role="status"]');
		const playing = { available: true, source: 'example.mml', playing: true, position: 42 };
		try {
			controls.render(playing);
			assert.strictEqual(status.attributes.get('data-state'), 'playing');
			controls.render({ ...playing, playing: false, paused: true });
			assert.strictEqual(status.textContent, 'Paused');
			assert.strictEqual(status.attributes.get('data-state'), 'paused');
			assert.strictEqual(play.title, 'Resume');
			assert.strictEqual(time.textContent, '0:42');
			controls.render(playing);
			controls.render({ ...playing, playing: false, loading: true, startAction: 'playFromCursor', position: 0 });
			controls.render({ ...playing, playing: false, loading: true, position: 90 });
			assert.strictEqual(root.attributes.get('aria-busy'), 'true');
			assert.strictEqual(play.title, 'Pause');
			assert.strictEqual(time.textContent, '0:42');
			assert.strictEqual(status.textContent, 'Playing');
			assert.strictEqual(cursor.classList.contains('is-loading'), false);
			await new Promise(resolve => setTimeout(resolve, 180));
			assert.strictEqual(cursor.classList.contains('is-loading'), true);
			assert.strictEqual(play.classList.contains('is-loading'), false);
			assert.strictEqual(status.textContent, 'Preparing');
			assert.strictEqual(status.attributes.get('data-state'), 'preparing');
			controls.render({ ...playing, position: 80 });
			assert.strictEqual(cursor.classList.contains('is-loading'), false);
			assert.strictEqual(root.attributes.get('aria-busy'), 'false');
			const stopped = { ...playing, playing: false, position: 0 };
			controls.render(stopped);
			controls.render({ ...stopped, loading: true, startAction: 'play' });
			assert.strictEqual(status.textContent, 'Stopped');
			controls.render({ ...playing, position: 0 });
			await new Promise(resolve => setTimeout(resolve, 180));
			assert.strictEqual(play.classList.contains('is-loading'), false);
			assert.strictEqual(status.textContent, 'Playing');
			controls.render({ ...playing, loading: true, startAction: 'playFromCursor' });
			controls.render(stopped);
			await new Promise(resolve => setTimeout(resolve, 180));
			assert.strictEqual(cursor.classList.contains('is-loading'), false);
			assert.strictEqual(status.textContent, 'Stopped');
			controls.render(playing);
			controls.render({ ...playing, finished: true });
			assert.strictEqual(root.classList.contains('is-finishing'), true);
			assert.strictEqual(play.title, 'Pause');
			assert.strictEqual(play.disabled, true);
			assert.strictEqual(cursor.disabled, false);
			assert.strictEqual(time.textContent, '0:42');
			controls.render({ ...stopped, position: 42 });
			assert.strictEqual(root.classList.contains('is-finishing'), false);
			assert.strictEqual(play.title, 'Play');
			assert.strictEqual(play.disabled, false);
			assert.strictEqual(cursor.disabled, false);
			assert.strictEqual(time.textContent, '0:42');
			assert.strictEqual(status.attributes.get('data-state'), 'stopped');
		} finally { controls.render(null); }
	});

	test('Playback WASI compiles large MML and streams FM audio with position and completion', async function () {
		this.timeout(20000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const changed = new vscode.EventEmitter<void>();
		let state: EmulationState | undefined;
		let progress: PlaybackProgress = { position: 0, finished: false };
		let blocks = 0;
		let energy = 0;
		const positions: number[] = [];
		const session = new EmulationSession(extension.extensionUri, await Wasm.load(), value => { state = value; },
			pcm => { blocks++; energy += new Float32Array(pcm).reduce((total, sample) => total + Math.abs(sample), 0); changed.fire(); },
			value => { progress = value; positions.push(value.position); changed.fire(); });
		async function render(): Promise<void> {
			const target = blocks + 4;
			const received = new Promise<void>((resolve, reject) => {
				const subscription = changed.event(() => {
					if (blocks === target) { clearTimeout(timer); subscription.dispose(); resolve(); }
				});
				const timer = setTimeout(() => { subscription.dispose(); reject(new Error(`Playback audio timed out: ${state?.error}`)); }, 4000);
			});
			session.request(4); await received;
		}
		try {
			const source = playbackSource + '; padded MML\n'.repeat(1500);
			assert.ok(source.length > 16384);
			await session.connect(48000, null, { source, looped: false });
			assert.ok(state?.connected, state?.error ?? 'Playback did not initialize');
			assert.strictEqual(blocks, 0);
			assert.strictEqual(progress.position, 0);
			for (let index = 0; index < 50 && !progress.finished; index++) { await render(); }
			assert.ok(progress.finished);
			assert.ok(energy > 1);
			assert.ok(progress.position > 0.9 && progress.position < 1.1);
			assert.ok(positions.every((position, index) => index === 0 || position >= positions[index - 1]));
			const cursorSource = '; 日本語\n' + playbackSource;
			const cursor = new TextEncoder().encode(cursorSource.slice(0, cursorSource.indexOf('cdef') + 2)).length;
			const beforeCursor = blocks;
			await session.connect(48000, null, { source: cursorSource, looped: false, cursor });
			assert.ok(state?.connected, state?.error ?? 'Cursor playback did not initialize');
			assert.ok(progress.position > 0.49 && progress.position < 0.51);
			assert.strictEqual(blocks, beforeCursor);
			await render();
			await session.connect(44100, null, { source: 'A [c4', looped: false });
			assert.strictEqual(state?.connected, false);
			assert.match(state?.error ?? '', /MML/);
			await session.connect(44100, null, { source: playbackSource, looped: false });
			assert.ok(state?.connected, state?.error);
			await render();
		} finally { session.dispose(); changed.dispose(); }
	});

	test('Playback panel follows MML, pauses, resumes, stops and cancels on editor changes', async function () {
		this.timeout(20000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const document = await vscode.workspace.openTextDocument({ language: 'mmlx', content: playbackSource });
		await vscode.window.showTextDocument(document);
		const context = { extensionUri: extension.extensionUri, subscriptions: [] as vscode.Disposable[] };
		const events = new vscode.EventEmitter<void>();
		const messages = new vscode.EventEmitter<unknown>();
		const changed = new vscode.EventEmitter<void>();
		let state: Record<string, unknown> = {};
		let blocks = 0;
		const provider = new VoiceViewProvider(context as unknown as vscode.ExtensionContext, () => undefined,
			async () => [], async () => [], async () => { throw new Error('MIDI is not used'); }, await Wasm.load());
		const view = { visible: true, onDidChangeVisibility: events.event, onDidDispose: events.event,
			webview: { cspSource: 'https://test.invalid', asWebviewUri: (uri: vscode.Uri) => uri,
				onDidReceiveMessage: messages.event, options: {}, html: '',
				postMessage: async (message: Record<string, unknown>) => {
					if (message.type === 'playback') { state = message; }
					if (message.type === 'playbackPcm') { assert.ok(message.pcm instanceof ArrayBuffer); blocks++; }
					changed.fire(); return true;
				} } } as unknown as vscode.WebviewView;
		function until(predicate: () => boolean): Promise<void> {
			if (predicate()) { return Promise.resolve(); }
			return new Promise((resolve, reject) => {
				const subscription = changed.event(() => { if (predicate()) { clearTimeout(timer); subscription.dispose(); resolve(); } });
				const timer = setTimeout(() => { subscription.dispose(); reject(new Error(`Playback panel timed out: ${JSON.stringify(state)}`)); }, 5000);
			});
		}
		try {
			await provider.resolveWebviewView(view);
			assert.strictEqual(state.available, true);
			assert.ok(view.webview.html.includes('OKI ADPCM is not supported yet'));
			messages.fire({ type: 'playbackAction', action: 'play', id: 1, document: document.uri.toString(), sampleRate: 48000 });
			await until(() => state.playing === true);
			assert.ok(view.badge?.tooltip.includes('Playback'));
			messages.fire({ type: 'playbackRender', id: 1, blocks: 4 });
			await until(() => blocks === 4);
			messages.fire({ type: 'playbackAction', action: 'pause', id: 1 });
			assert.strictEqual(state.paused, true); assert.strictEqual(state.playing, false);
			messages.fire({ type: 'playbackAction', action: 'resume', id: 1 });
			assert.strictEqual(state.playing, true); assert.strictEqual(state.paused, false);
			messages.fire({ type: 'playbackRender', id: 1, blocks: 4 });
			await until(() => blocks === 8);
			const plain = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'Not MML' });
			await vscode.window.showTextDocument(plain);
			await until(() => state.available === false);
			assert.strictEqual(state.playing, false); assert.strictEqual(state.position, 0);
			await vscode.window.showTextDocument(document);
			await until(() => state.available === true);
			messages.fire({ type: 'playbackAction', action: 'play', id: 2, document: document.uri.toString(), sampleRate: 48000 });
			await until(() => state.playing === true);
			messages.fire({ type: 'playbackAction', action: 'stop', id: 2 });
			assert.strictEqual(state.playing, false); assert.strictEqual(state.position, 0);
			const editor = await vscode.window.showTextDocument(document);
			const cursor = document.positionAt(document.getText().indexOf('cdef') + 2);
			editor.selection = new vscode.Selection(cursor, cursor);
			messages.fire({ type: 'playbackAction', action: 'playFromCursor', id: 3, document: document.uri.toString(), sampleRate: 48000 });
			await until(() => state.playing === true && state.id === 3);
			assert.ok(Number(state.position) > 0.49 && Number(state.position) < 0.51);
			assert.strictEqual(blocks, 8);
			messages.fire({ type: 'playbackRender', id: 3, blocks: 4 });
			await until(() => blocks === 12);
			messages.fire({ type: 'playbackAction', action: 'stop', id: 3 });
			editor.selection = new vscode.Selection(0, 0, 0, 0);
			messages.fire({ type: 'playbackAction', action: 'playFromCursor', id: 4, document: document.uri.toString(), sampleRate: 48000 });
			await until(() => state.loading === false && state.id === 4 && !!state.error);
			assert.match(String(state.error), /No playable command/);
			messages.fire({ type: 'playbackAction', action: 'play', id: 5, document: document.uri.toString(), sampleRate: 48000 });
			messages.fire({ type: 'playbackAction', action: 'stop', id: 5 });
			assert.strictEqual(state.loading, false); assert.strictEqual(state.playing, false);
			messages.fire({ type: 'playbackAction', action: 'stop', id: 5, error: 'Audio output was suspended.' });
			assert.strictEqual(state.error, 'Audio output was suspended.');
			assert.strictEqual(document.getText(), playbackSource);
		} finally {
			provider.dispose();
			for (const disposable of context.subscriptions) { disposable.dispose(); }
			events.dispose(); messages.dispose(); changed.dispose();
		}
	});

	test('YM2151 WASI produces polyphonic stereo PCM, releases notes and reconnects', async function () {
		this.timeout(20000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const blocks: ArrayBuffer[] = [];
		const changed = new vscode.EventEmitter<void>();
		let state: EmulationState | undefined;
		const session = new EmulationSession(extension.extensionUri, await Wasm.load(), value => { state = value; },
			pcm => { blocks.push(pcm); changed.fire(); });
		const tone = { algorithm: 7, feedback: 0, operatorMask: 15,
			operators: Array.from({ length: 4 }, () => ({ ar: 31, d1r: 0, d2r: 0, rr: 15, d1l: 0, tl: 32, ks: 0, mul: 1, dt1: 0, dt2: 0, ame: 0 })) };
		async function render(): Promise<ArrayBuffer[]> {
			const start = blocks.length;
			const received = new Promise<void>((resolve, reject) => {
				const subscription = changed.event(() => {
					if (blocks.length === start + 4) { clearTimeout(timer); subscription.dispose(); resolve(); }
				});
				const timer = setTimeout(() => { subscription.dispose(); reject(new Error(`Audio timed out: ${state?.error}`)); }, 4000);
			});
			session.request(4);
			await received;
			return blocks.slice(start);
		}
		const energy = (pcm: ArrayBuffer) => new Float32Array(pcm).reduce((total, value) => total + Math.abs(value), 0);
		try {
			await session.connect(48000, tone);
			assert.ok(state?.connected, state?.error ?? 'Emulator did not initialize');
			assert.strictEqual(blocks.length, 0, 'PCM must be demand-driven');
			for (let index = 0; index < 8; index++) { session.note({ type: 'noteOn', source: 0, channel: 0, note: 60 + index, velocity: 127 }); }
			await render();
			const active = await render();
			assert.ok(active.every(pcm => pcm.byteLength === 4096 && energy(pcm) > 1));
			session.note({ type: 'allOff', source: 0 });
			for (let index = 0; index < 16; index++) { await render(); }
			assert.ok((await render()).every(pcm => energy(pcm) < 0.001));
			session.disconnect(); assert.strictEqual(state?.connected, false);
			await session.connect(44100, tone); assert.ok(state?.connected, state?.error);
			session.note({ type: 'noteOn', source: 1, channel: 3, note: 69, velocity: 100 });
			await render(); assert.ok((await render()).some(pcm => energy(pcm) > 1));
		} finally { session.dispose(); changed.dispose(); }
	});

	test('YM2151 WASI cancels pending startup and reports unavailable or invalid audio backends', async function () {
		this.timeout(20000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		let state: EmulationState | undefined;
		const session = new EmulationSession(extension.extensionUri, await Wasm.load(), value => { state = value; }, () => {});
		try {
			const pending = session.connect(48000); session.disconnect(); await pending;
			assert.strictEqual(state?.connected, false); assert.strictEqual(state?.connecting, false);
			await session.connect(0); assert.strictEqual(state?.connected, false); assert.ok(state?.error);
			await session.connect(48000); assert.ok(state?.connected, state?.error);
			const failed = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('Invalid voice did not stop the backend')), 4000);
				const poll = setInterval(() => { if (state?.error) { clearInterval(poll); clearTimeout(timer); resolve(); } }, 10);
			});
			session.setVoice({ algorithm: 99 }); await failed;
			assert.strictEqual(state?.connected, false); assert.ok(state?.error);
		} finally { session.dispose(); }
		const missing = new EmulationSession(vscode.Uri.joinPath(extension.extensionUri, 'missing-emulator'), await Wasm.load(),
			value => { state = value; }, () => {});
		try { await missing.connect(48000); assert.strictEqual(state?.connected, false); assert.ok(state?.error); }
		finally { missing.dispose(); }
	});
	test('registers the MML language', async () => {
		assert.ok((await vscode.languages.getLanguages()).includes('mmlx'));
	});

	test('output connections enable NanoDrive8 only with a Settings connection', async () => {
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const { createOutputConnection } = await import(vscode.Uri.joinPath(extension.extensionUri, 'assets', 'webview', 'outputConnection.js').toString());
		const mode = Object.assign(new EventTarget(), { value: 'nanodrive8', disabled: false });
		const attributes = new Map<string, string>();
		const button = Object.assign(new EventTarget(), { disabled: false, title: '',
			setAttribute: (name: string, value: string) => attributes.set(name, value) });
		const requests: { mode: string; connected: boolean }[] = [];
		const controls = createOutputConnection({ querySelector: (selector: string) => selector === 'select' ? mode : button },
			(request: { mode: string; connected: boolean }) => requests.push(request));
		assert.strictEqual(button.disabled, true);
		assert.strictEqual(mode.disabled, false);
		button.dispatchEvent(new Event('click')); assert.strictEqual(requests.length, 0);
		controls.setNanoDriveAvailable(true);
		assert.strictEqual(button.disabled, false);
		button.dispatchEvent(new Event('click'));
		assert.deepStrictEqual(requests.pop(), { mode: 'nanodrive8', connected: true });
		controls.setNanoDriveAvailable(false);
		assert.strictEqual(button.disabled, true);
		mode.value = 'emulation'; mode.dispatchEvent(new Event('change'));
		assert.strictEqual(button.disabled, false);
		button.dispatchEvent(new Event('click'));
		assert.deepStrictEqual(requests, [{ mode: 'emulation', connected: true }]);
		controls.setState({ connected: false, connecting: true });
		assert.strictEqual(button.disabled, true); assert.strictEqual(mode.disabled, true);
		controls.setState({ connected: true, connecting: false });
		assert.strictEqual(button.disabled, false); assert.strictEqual(mode.disabled, true);
		assert.strictEqual(attributes.get('aria-pressed'), 'true');
		controls.setState({ connected: false, connecting: false });
		mode.value = 'nanodrive8'; controls.setConnected(false);
		assert.strictEqual(button.disabled, true); assert.strictEqual(mode.disabled, false);
		controls.setState({ connected: false, connecting: false });
		assert.strictEqual(button.disabled, true);
		controls.setNanoDriveAvailable(true); assert.strictEqual(button.disabled, false);
		controls.setState({ connected: true, connecting: false });
		controls.setNanoDriveAvailable(false); assert.strictEqual(button.disabled, false);
		button.dispatchEvent(new Event('click')); assert.deepStrictEqual(requests.pop(), { mode: 'nanodrive8', connected: false });
		controls.setState({ connected: false, connecting: false }); assert.strictEqual(button.disabled, true);
		const template = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extension.extensionUri, 'assets', 'webview', 'voice.html')));
		assert.strictEqual((template.match(/<option value="emulation">Emulation \(ymfm\)<\/option>/g) ?? []).length, 2);
		assert.match(template, /<button\b[^>]*id="playback-play"[^>]*\sdisabled[^>]*>/);
		assert.match(template, /<button\b[^>]*id="playback-stop"[^>]*\sdisabled[^>]*>/);
		const unavailableMode = Object.assign(new EventTarget(), { value: 'emulation', disabled: false });
		const unavailableButton = Object.assign(new EventTarget(), { disabled: true, title: '', setAttribute: () => {} });
		const unavailable = createOutputConnection({ querySelector: (selector: string) => selector === 'select' ? unavailableMode : unavailableButton },
			() => assert.fail('Unavailable output must not request a connection'));
		for (const value of ['emulation', 'nanodrive8', 'emulation']) {
			unavailableMode.value = value; unavailableMode.dispatchEvent(new Event('change'));
			unavailable.setConnected(false);
			unavailable.setState({ connected: false, connecting: false });
			assert.strictEqual(unavailableButton.disabled, true);
			assert.strictEqual(unavailableMode.disabled, false);
			unavailableButton.dispatchEvent(new Event('click'));
		}
	});

	test('FM Voice keyboard shows MIDI status and disables keys until output connects', async function () {
		this.timeout(15000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const media = vscode.Uri.joinPath(extension.extensionUri, 'assets', 'webview');
		const panel = vscode.window.createWebviewPanel('mmlx.keyboardStateTest', 'mmlx Keyboard State Test', vscode.ViewColumn.Beside,
			{ enableScripts: true, localResourceRoots: [media, vscode.Uri.joinPath(extension.extensionUri, 'assets', 'icon')] });
		let resolveResult!: () => void;
		let rejectResult!: (error: Error) => void;
		const result = new Promise<void>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
		const listener = panel.webview.onDidReceiveMessage(message => {
			if (message.type === 'ready') { void panel.webview.postMessage({ type: 'keyboardProbe' }); }
			else if (message.type === 'keyboardResult') { resolveResult(); }
			else if (message.type === 'keyboardFailure') { rejectResult(new Error(message.error)); }
		});
		const nonce = randomUUID();
		const template = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(media, 'voice.html')));
		const probe = `<script nonce="${nonce}">
		const nativeAcquire = acquireVsCodeApi; const messages = []; let probeApi;
		window.acquireVsCodeApi = () => {
			const api = nativeAcquire();
			probeApi = api;
			return { ...api, postMessage: message => { messages.push(message); api.postMessage(message); } };
		};
		const send = data => window.dispatchEvent(new MessageEvent('message', { data }));
		const check = (condition, text) => { if (!condition) { throw new Error(text); } };
		let startProbed = false;
		async function runProbe() {
			try {
				if (!startProbed) {
					if (!document.querySelector('#start-controls img').complete) { requestAnimationFrame(runProbe); return; }
					const startTab = document.getElementById('start-tab');
					check(document.querySelector('[role="tab"]').id === 'start-tab', 'Get Started must be the leftmost tab');
					check(startTab.getAttribute('aria-selected') === 'true' && !document.getElementById('start-controls').hidden, 'Get Started must be selected initially');
					check(document.querySelector('#start-controls h1').textContent === 'mmlx-lsp', 'Extension title must appear');
					const icon = document.querySelector('#start-controls img');
					check(icon.complete && icon.naturalWidth > 0, 'Extension icon must load');
					document.getElementById('open-starter').click();
					check(messages.filter(message => message.type === 'openStarter').length === 1, 'Example button must request a new MML document');
					startTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
					check(document.getElementById('voice-tab').getAttribute('aria-selected') === 'true' && document.getElementById('start-controls').hidden, 'ArrowRight must switch to FM Voice');
					startProbed = true;
				}
				const key = document.querySelector('#keyboard [data-midi-note="60"]');
				if (!key) { requestAnimationFrame(runProbe); return; }
				const keyboard = document.getElementById('keyboard');
				const badge = document.getElementById('keyboard-midi-status');
				check(keyboard.classList.contains('is-disconnected') && key.getAttribute('aria-disabled') === 'true', 'Keys must start disconnected');
				check(getComputedStyle(keyboard.querySelector('.p-keyboard__body')).opacity < 1, 'Disconnected keyboard must look inactive');
				check(getComputedStyle(badge).display === 'none', 'Disconnected MIDI indicator must not be visible');
				key.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
				check(!messages.some(message => message.type === 'emulationNote'), 'Disconnected keys must not send notes');
				const midi = { type: 'midiSettings', connection: 'FM-1:FM-1 MIDI 1 28:0', ports: ['FM-1:FM-1 MIDI 1 28:0'],
					folder: 'test', editable: false, connected: true, connecting: false, canConnect: true, loading: false, saving: false, error: '' };
				send(midi);
				check(!badge.hidden && badge.textContent === 'MIDI-IN' && badge.title.includes(midi.connection), 'MIDI indicator and port tooltip must appear');
				check(getComputedStyle(badge).display !== 'none', 'Connected MIDI indicator must be visible');
				check(document.getElementById('midi-settings-status').textContent === '', 'Settings must not show connected port text');
				send({ type: 'outputConnection', target: 'keyboard', id: 0, connected: true, connecting: false });
				check(!keyboard.classList.contains('is-disconnected') && key.getAttribute('aria-disabled') === 'false', 'Output must enable keys');
				check(getComputedStyle(keyboard.querySelector('.p-keyboard__body')).opacity === '1', 'Connected keyboard must restore full contrast');
				key.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
				check(messages.some(message => message.type === 'emulationNote' && message.event === 'noteOn'), 'Connected keys must send notes');
				send({ type: 'outputConnection', target: 'keyboard', id: 0, connected: false, connecting: false });
				check(keyboard.classList.contains('is-disconnected') && key.tabIndex === -1, 'Disconnect must disable keys again');
				check(messages.some(message => message.type === 'emulationNote' && message.event === 'noteOff'), 'Disconnect must release held keys');
				send({ type: 'midiNotes', notes: [64] });
				check(document.querySelector('#keyboard [data-midi-note="64"]').classList.contains('is-active'), 'MIDI feedback must remain independent of output');
				send({ ...midi, connected: false, error: 'MIDI test error' });
				check(badge.hidden && document.getElementById('midi-settings-status').textContent === 'MIDI test error', 'Disconnect must hide badge and preserve errors');
				send({ type: 'outputConnection', target: 'keyboard', id: 0, connected: true, connecting: false });
				const body = keyboard.querySelector('.p-keyboard__body');
				for (const [width, note, label] of [[800, 36, 'C2'], [320, 48, 'C3'], [800, 36, 'C2']]) {
					body.style.width = width + 'px';
					await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
					const keys = [...keyboard.querySelector('.p-keyboard__wrapper').children];
					const lowest = keys[0];
					check(lowest.dataset.midiNote === String(note) && lowest.getAttribute('aria-label') === label, 'Lowest key must be ' + label + ' at width ' + width);
					if (width === 320) { check(keys.length === 37, 'Compact keyboard must have 37 keys'); }
					check(keyboard.querySelector('[data-midi-note="64"]').classList.contains('is-active'), 'Resize must preserve MIDI note feedback');
					lowest.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
					check(messages.at(-1).type === 'emulationNote' && messages.at(-1).event === 'noteOn' && messages.at(-1).note === note, 'Lowest key must send its MIDI note');
					lowest.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter' }));
				}
				const operator = { ar: 22, d1r: 0, d2r: 1, rr: 2, d1l: 1, tl: 47, ks: 2, mul: 12, dt1: 0, dt2: 0, ame: 0 };
				const renderVoice = (operatorMask = 15, values = {}, state = {}) => send({ type: 'voice', editable: true, editToken: 42, source: 'test.mml',
					voice: { number: 1, algorithm: 2, feedback: 7, operatorMask, operators: Array.from({ length: 4 }, () => ({ ...operator, ...values })) }, ...state });
				renderVoice();
				const sections = [...document.querySelectorAll('#operators .operator')];
				for (const section of sections) {
					check([...section.querySelectorAll('dt')].map(term => term.textContent).join(',') === 'MUL,TL,DT1,DT2,AR,D1R,D1L,D2R,RR,KS,AME', 'Parameter display order must be independent of MML order');
					const releaseWidth = section.querySelector('input[aria-label$=" RR"]').getBoundingClientRect().width;
					const levelWidth = section.querySelector('input[aria-label$=" TL"]').getBoundingClientRect().width;
					check(Math.abs(releaseWidth - levelWidth) < 1, 'RR must have the same width as other numeric fields');
					const multiplier = section.querySelector('select[aria-label$=" MUL"]');
					check(multiplier.options.length === 16 && multiplier.options[0].textContent === '0: x0.5' && multiplier.options[15].textContent === '15: x15', 'MUL must show frequency multipliers including the zero special value');
					const scaling = section.querySelector('select[aria-label$=" KS"]');
					check([...scaling.options].map(option => option.textContent).join(',') === '0: Min,1: Low,2: Med,3: High', 'KS must show key scaling strength');
					check(scaling.title.includes('0: Minimal'), 'KS zero must not be described as disabled');
					const detune = section.querySelector('select[aria-label$=" DT2"]');
					check([...detune.options].map(option => option.textContent).join(',') === '0: 0c,1: 600c,2: 781c,3: 950c', 'DT2 must show coarse detune in cents');
					check(detune.title.includes('100 cents = 1 semitone'), 'DT2 must explain the cents unit');
					const modulation = section.querySelector('[aria-label$=" AME"]');
					check(modulation.type === 'checkbox' && modulation.getAttribute('role') === 'switch' && modulation.title.includes('AMS'), 'AME must be an amplitude modulation switch with its dependencies');
				}
				for (const [field, parameter, value] of [['MUL', 7, 0], ['MUL', 7, 15], ['KS', 6, 0], ['KS', 6, 3], ['DT2', 9, 0], ['DT2', 9, 1], ['DT2', 9, 2], ['DT2', 9, 3], ['AME', 10, 0], ['AME', 10, 1]]) {
					renderVoice(15, { ame: field === 'AME' ? 1 - value : 0, dt2: value === 0 ? 1 : 0 });
					const input = sections[1].querySelector('[aria-label="OP 2 ' + field + '"]');
					if (input.type === 'checkbox') { input.checked = Boolean(value); } else { input.value = String(value); }
					input.dispatchEvent(new Event('change'));
					const edit = messages.at(-1);
					check(edit.type === 'editVoice' && edit.token === 42 && edit.index === 11 + parameter && edit.value === value, 'Meaningful controls must preserve MML parameter indices and values');
					const displayedValue = () => input.type === 'checkbox' ? Number(input.checked) : Number(input.value);
					check(!input.disabled && input.getAttribute('aria-disabled') === 'true' && getComputedStyle(input).opacity === '1', 'Pending controls must lock without disabled styling');
					check(displayedValue() === value, 'Pending edit must preserve its displayed value');
					check(document.querySelector('#voice-controls').getAttribute('aria-busy') === 'true' && document.querySelector('#status').textContent === '', 'Pending edit must announce busy state without flashing status text');
					renderVoice(15, {}, { editing: true, editable: false, editToken: null });
					check(displayedValue() === value, 'Server busy snapshot must not reset the optimistic value');
					const count = messages.filter(message => message.type === 'editVoice').length;
					input.click();
					input.dispatchEvent(new Event('change'));
					check(messages.filter(message => message.type === 'editVoice').length === count && displayedValue() === value, 'Pending edits must block duplicate input');
					if (field === 'MUL' && value === 0) {
						const auditionKey = document.querySelector('#keyboard [data-midi-note="60"]');
						auditionKey.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
						check(messages.at(-1).type === 'emulationNote' && messages.at(-1).event === 'noteOn', 'Voice edits must not block audition keyboard input');
						auditionKey.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
					}
					renderVoice(15, { [field.toLowerCase()]: value });
					check(displayedValue() === value && input.getAttribute('aria-disabled') === 'false' && document.querySelector('#voice-controls').getAttribute('aria-busy') === 'false', 'Confirmed edit must unlock without reverting');
				}
				const maskInputs = [...document.querySelectorAll('#operator-mask input')];
				check(maskInputs.length === 4, 'OP must have four operator checkboxes');
				for (let mask = 0; mask <= 15; mask++) {
					for (let index = 0; index < 4; index++) {
						renderVoice(mask);
						check(maskInputs.every((input, bit) => input.checked === Boolean(mask & (1 << bit))), 'OP checkboxes must reflect every mask');
						check(sections[index].classList.contains('disabled') === !(mask & (1 << index)), 'OP state must match the operator panel');
						check(sections[index].querySelector('.operator-badge').classList.contains('inactive') === !(mask & (1 << index)), 'Disabled operator badges must match algorithm nodes');
						const opacity = (mask & (1 << index)) ? '1' : '0.3';
						check(getComputedStyle(sections[index].querySelector(':scope > svg')).opacity === opacity, 'Entire ADSR graph must dim and restore with its OP checkbox');
						check(getComputedStyle(sections[index].querySelector('.envelope')).opacity === '1', 'Envelope must not be dimmed twice');
						check([...document.querySelectorAll('#algorithms .algorithm-node[data-operator="' + (index + 1) + '"]')].every(node => getComputedStyle(node).opacity === opacity), 'Matching operator nodes must dim and restore in every algorithm');
						check([...sections[index].querySelectorAll('input, select')].every(input => !input.disabled), 'Off operators must remain editable');
						maskInputs[index].checked = !maskInputs[index].checked;
						maskInputs[index].dispatchEvent(new Event('change'));
						const edit = messages.at(-1);
						check(edit.type === 'editVoice' && edit.index === 46 && edit.value === (mask ^ (1 << index)), 'OP edits must toggle only the selected bit');
						check(maskInputs[index].checked === Boolean((mask ^ (1 << index)) & (1 << index)), 'OP checkbox must not flash back to its old state');
						check(getComputedStyle(sections[index].querySelector(':scope > svg')).opacity === ((mask & (1 << index)) ? '0.3' : '1'), 'OP visual state must update immediately while pending');
					}
				}
				renderVoice(9, { ame: 1 });
				for (let algorithm = 0; algorithm < 8; algorithm++) {
					send({ type: 'voice', editable: true, editToken: 42, source: 'test.mml', voice: { number: 1, algorithm, feedback: 7, operatorMask: 9, operators: Array.from({ length: 4 }, () => ({ ...operator, ame: 1 })) } });
					for (let index = 0; index < 4; index++) {
						const carrier = document.querySelector('[data-algorithm="' + algorithm + '"] [data-operator="' + (index + 1) + '"]').classList.contains('carrier');
						check(sections[index].querySelector('.operator-badge').classList.contains('carrier') === carrier, 'Envelope badges must match algorithm carrier roles');
						check(sections[index].querySelector('.operator-role').textContent === (carrier ? 'Carrier' : 'Modulator'), 'Envelope headings must name the operator role');
						check(sections[index].querySelector('h2').getAttribute('aria-label') === 'OP ' + (index + 1) + ' ' + (carrier ? 'Carrier' : 'Modulator') + ((9 & (1 << index)) ? '' : ', Off'), 'Accessible headings must include operator numbers, roles and disabled state');
					}
				}
				check(sections[1].querySelector('[aria-label="OP 2 AME"]').checked && sections[1].querySelector('.parameter-toggle span').textContent === 'On', 'AME must render the enabled state');
				renderVoice();
				const failedInput = sections[1].querySelector('[aria-label="OP 2 MUL"]');
				failedInput.value = '15'; failedInput.dispatchEvent(new Event('change'));
				renderVoice(15, {}, { editable: false, editing: true, error: true });
				check(failedInput.value === '12' && failedInput.disabled && document.querySelector('#voice-controls').getAttribute('aria-busy') === 'false', 'Failed edits must restore authoritative values and genuine disabled styling');
				renderVoice();
				failedInput.value = '15'; failedInput.dispatchEvent(new Event('change'));
				renderVoice(15, {}, { source: 'other.mml', editable: false, editing: true });
				check(failedInput.value === '12', 'Switching sources must discard pending preview');
				send({ type: 'voice', editable: false, editToken: 42, source: 'test.mml', voice: null });
				check([...document.querySelectorAll('#operators input, #operators select, #operator-mask input')].every(input => input.disabled), 'Missing voice must disable all meaningful controls');
				probeApi.postMessage({ type: 'keyboardResult' });
			} catch (error) { probeApi.postMessage({ type: 'keyboardFailure', error: String(error) }); }
		}
		window.addEventListener('message', event => { if (event.data.type === 'keyboardProbe') { runProbe(); } });
		</script>`;
		panel.webview.html = template.replaceAll('{{cspSource}}', panel.webview.cspSource).replaceAll('{{nonce}}', nonce)
			.replaceAll('{{iconUri}}', panel.webview.asWebviewUri(vscode.Uri.joinPath(extension.extensionUri, 'assets', 'icon', 'mmlx.png')).toString())
			.replaceAll('{{styleUri}}', panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'voice.css')).toString())
			.replaceAll('{{scriptUri}}', panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'voice.js')).toString())
			.replace('<script type="module"', `${probe}<script type="module"`);
		const timer = setTimeout(() => rejectResult(new Error('Keyboard UI probe timed out')), 8000);
		try { await result; }
		finally { clearTimeout(timer); listener.dispose(); panel.dispose(); }
	});

	test('Get Started opens an editable untitled MML example without a preset save path or modifying existing documents', async function () {
		this.timeout(15000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		await extension.activate();
		const original = await vscode.workspace.openTextDocument({ language: 'mmlx', content: 'A t120 c4\n' });
		await vscode.window.showTextDocument(original);
		const context = { extensionUri: extension.extensionUri, subscriptions: [] as vscode.Disposable[] };
		const events = new vscode.EventEmitter<void>();
		const messages = new vscode.EventEmitter<unknown>();
		const provider = new VoiceViewProvider(context as unknown as vscode.ExtensionContext, () => undefined, async () => [], async () => []);
		const view = { visible: true, onDidChangeVisibility: events.event, onDidDispose: events.event,
			webview: { cspSource: 'https://test.invalid', asWebviewUri: (uri: vscode.Uri) => uri,
				onDidReceiveMessage: messages.event, postMessage: async () => true, options: {}, html: '' } } as unknown as vscode.WebviewView;
		let subscription: vscode.Disposable | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await provider.resolveWebviewView(view);
			const openExample = () => new Promise<vscode.TextDocument>((resolve, reject) => {
				clearTimeout(timer); subscription?.dispose();
				subscription = vscode.window.onDidChangeActiveTextEditor(editor => {
					if (editor?.document.isUntitled && editor.document.languageId === 'mmlx' && editor.document !== original) { resolve(editor.document); }
				});
				timer = setTimeout(() => reject(new Error('Example MML did not open')), 8000);
				messages.fire({ type: 'openStarter' });
			});
			const document = await openExample();
			assert.strictEqual(document.uri.scheme, 'untitled');
			assert.match(document.uri.path, /^Untitled-\d+$/);
			assert.strictEqual(document.languageId, 'mmlx');
			assert.ok(document.isUntitled && document.isDirty);
			const expected = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extension.extensionUri, 'assets', 'webview', 'example.mml')));
			assert.strictEqual(document.getText(), expected);
			assert.strictEqual(original.getText(), 'A t120 c4\n');
			await waitForDiagnostics(document.uri, 0);
			await editSource(document, expected + '\n; My edits\n');
			const second = await openExample();
			assert.match(second.uri.path, /^Untitled-\d+$/);
			assert.notStrictEqual(second.uri.toString(), document.uri.toString());
			assert.strictEqual(second.getText(), expected);
			assert.strictEqual(document.getText(), expected + '\n; My edits\n');
			await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
			await vscode.window.showTextDocument(document);
			await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
		} finally {
			clearTimeout(timer); subscription?.dispose(); provider.dispose();
			for (const disposable of context.subscriptions) { disposable.dispose(); }
			events.dispose(); messages.dispose();
		}
	});

	test('opens the FM voice panel without modifying the selected definition', async function () {
		this.timeout(30000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		await extension.activate();
		assert.ok((await vscode.commands.getCommands()).includes('mmlx.showVoicePanel'));
		assert.ok(extension.packageJSON.contributes.views.mmlx.some((view: { id: string; type: string }) =>
			view.id === 'mmlx.voice' && view.type === 'webview'));
		assert.strictEqual(extension.packageJSON.contributes.viewsContainers.panel[0].title, 'mmlx');
		assert.strictEqual(extension.packageJSON.contributes.views.mmlx[0].name, 'mmlx');
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
		const module = await import(vscode.Uri.joinPath(extension.extensionUri, 'assets', 'webview', 'voiceControls.js').toString());
		assert.deepStrictEqual(module.algorithmConnections.map((connection: { edges: number[][] }) => connection.edges), [
			[[0, 1], [1, 2], [2, 3]], [[0, 2], [1, 2], [2, 3]],
			[[0, 3], [1, 2], [2, 3]], [[0, 1], [1, 3], [2, 3]],
			[[0, 1], [2, 3]], [[0, 1], [0, 2], [0, 3]], [[0, 1]], []
		]);
		assert.deepStrictEqual(module.algorithmConnections.map((connection: { carriers: number[] }) => connection.carriers),
			[[3], [3], [3], [3], [1, 3], [1, 2, 3], [1, 2, 3], [0, 1, 2, 3]]);
	});

	test('FM voice attack follows YMFM attenuation while preserving normalized handles', async () => {
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const module = await import(vscode.Uri.joinPath(extension.extensionUri, 'assets', 'webview', 'voiceControls.js').toString());
		const original = { ar: 16, tl: 0, rr: 8, d1r: 12, d1l: 3, d2r: 8 };
		const points: number[][] = module.envelopeAttackPoints(original);
		assert.deepStrictEqual(points[0], [12, 116]);
		assert.deepStrictEqual(points.at(-1), module.envelopeHandlePositions(original).attack);
		const expectedAttenuations = [1023, 959, 899, 842];
		for (const [index, attenuation] of expectedAttenuations.entries()) {
			assert.ok(Math.abs((points[index][1] - 16) / 100 * 1023 - attenuation) < 0.000001);
		}
		for (const ar of [0, 1, 16, 30, 31]) {
			for (const tl of [0, 40, 127]) {
				const operator = { ...original, ar, tl };
				const attack: number[][] = module.envelopeAttackPoints(operator);
				assert.deepStrictEqual(attack.at(-1), module.envelopeHandlePositions(operator).attack);
				assert.ok(attack.every(([positionX, positionY]) => Number.isFinite(positionX) && Number.isFinite(positionY) && positionY >= 16 && positionY <= 116));
				assert.ok(attack.every((point, index) => index === 0 || (point[0] >= attack[index - 1][0] && point[1] <= attack[index - 1][1])));
				if (ar === 0) { assert.ok(attack.every(point => point[1] === 116)); }
				if (ar === 31) { assert.deepStrictEqual(attack[1], [12, module.envelopeHandlePositions(operator).attack[1]]); }
			}
		}
	});

	test('FM voice envelope dragging maps and clamps all envelope parameters', async () => {
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const module = await import(vscode.Uri.joinPath(extension.extensionUri, 'assets', 'webview', 'voiceControls.js').toString());
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
		const module = await import(vscode.Uri.joinPath(extension.extensionUri, 'assets', 'webview', 'voiceControls.js').toString());
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

	test('native MIDI input receives note on and off from a virtual port in the extension host', async function () {
		this.timeout(15000);
		if (process.platform === 'win32') { this.skip(); }
		const { Output } = await import('@julusian/midi');
		const output = new Output();
		const updates = new vscode.EventEmitter<number[]>();
		const connection = new MidiInputConnection(() => {}, undefined, notes => updates.fire(notes));
		const name = `mmlx-test-${randomUUID()}`;
		async function send(message: number[], expected: number[]): Promise<void> {
			const received = new Promise<void>((resolve, reject) => {
				const subscription = updates.event(notes => {
					if (notes.length === expected.length && notes.every((note, index) => note === expected[index])) {
						clearTimeout(timeout); subscription.dispose(); resolve();
					}
				});
				const timeout = setTimeout(() => { subscription.dispose(); reject(new Error('Native MIDI receive timed out')); }, 3000);
			});
			output.sendMessage(message);
			await received;
		}
		try {
			try { output.openVirtualPort(name); } catch { this.skip(); }
			const port = (await listMidiInputPorts()).find(port => port.includes(name));
			assert.ok(port, 'Virtual MIDI source was not enumerated');
			await connection.connect(port);
			assert.strictEqual(connection.state.connected, true, connection.state.error);
			await send([0x90, 60, 100], [60]);
			await send([0x90, 64, 100], [60, 64]);
			await send([0x80, 60, 0], [64]);
			await send([0x90, 64, 0], []);
		} finally {
			connection.disconnect(); output.destroy(); updates.dispose();
		}
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
			loading: boolean; error: string; ports: string[]; connected: boolean; canConnect: boolean; notes?: number[] };
		const updates = new vscode.EventEmitter<MidiMessage>();
		let latest: MidiMessage | undefined;
		let ports = ['Keyboard 10', 'Keyboard 2', 'Keyboard 2', ''];
		let failure = false;
		let openFailure = false;
		let destroyed = 0;
		const inputs: NodeEventEmitter[] = [];
		let notes: number[] = [];
		const noteEvents: unknown[] = [];
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
		}, async () => {
			const input = Object.assign(new NodeEventEmitter(), {
				getPortCount: () => ports.length, getPortName: (index: number) => ports[index],
				ignoreTypes: () => {}, openPort: () => { if (openFailure) { throw new Error('MIDI open failed'); } },
				destroy: () => { destroyed++; input.removeAllListeners(); }
			});
			inputs.push(input);
			return input;
		});
		const view = { visible: true, onDidChangeVisibility: events.event, onDidDispose: events.event,
			webview: { cspSource: 'https://test.invalid', asWebviewUri: (uri: vscode.Uri) => uri,
				onDidReceiveMessage: messages.event, postMessage: (message: MidiMessage) => {
					if (message.type === 'midiSettings') { latest = message; updates.fire(message); }
					if (message.type === 'midiNotes') { notes = message.notes ?? []; }
					if (message.type === 'midiNote') { noteEvents.push((message as unknown as { event: unknown }).event); }
					return Promise.resolve(true);
				} }
		} as unknown as vscode.WebviewView;
		try {
			await provider.resolveWebviewView(view);
			messages.fire({ type: 'ready' });
			assert.strictEqual(view.title, 'mmlx');
			assert.strictEqual(view.badge, undefined);
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
			messages.fire({ type: 'setMidiInputConnection', folder: 'file:///wrong-folder', connected: true });
			assert.strictEqual(inputs.length, 0);
			openFailure = true;
			messages.fire({ type: 'setMidiInputConnection', folder: folder.uri.toString(), connected: true });
			await waitFor(message => message.error === 'MIDI open failed');
			assert.strictEqual(destroyed, 1);
			assert.strictEqual(view.badge, undefined);
			openFailure = false;
			messages.fire({ type: 'setMidiInputConnection', folder: folder.uri.toString(), connected: true });
			const connected = await waitFor(message => message.connected);
			assert.strictEqual(connected.editable, false);
			assert.strictEqual(view.title, 'mmlx [Connected]');
			assert.deepStrictEqual(view.badge, { value: 1, tooltip: 'Connected: MIDI-IN' });
			inputs.at(-1)!.emit('noteon', 60, 100, { channel: 0 });
			assert.deepStrictEqual(notes, [60]);
			assert.deepStrictEqual(noteEvents.at(-1), { type: 'noteOn', channel: 0, note: 60, velocity: 100 });
			inputs.at(-1)!.emit('noteoff', 60, 0, { channel: 0 });
			assert.deepStrictEqual(notes, []);
			assert.deepStrictEqual(noteEvents.at(-1), { type: 'noteOff', channel: 0, note: 60 });
			messages.fire({ type: 'updateMidiInput', folder: folder.uri.toString(), value: 'Keyboard 10' });
			assert.strictEqual(vscode.workspace.getConfiguration('mmlx', folder.uri).get('midi.input'), 'Keyboard 2');
			messages.fire({ type: 'setMidiInputConnection', folder: folder.uri.toString(), connected: false });
			await waitFor(message => !message.connected && message.editable);
			assert.strictEqual(destroyed, 2);
			assert.strictEqual(view.title, 'mmlx');
			assert.strictEqual(view.badge, undefined);
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
			messages.fire({ type: 'setMidiInputConnection', folder: folder.uri.toString(), connected: true });
			await waitFor(message => message.connected);
			inputs.at(-1)!.emit('noteon', 60, 100, { channel: 0 });
			ports = [];
			messages.fire({ type: 'getMidiInputPorts' });
			await waitFor(message => !message.loading && !message.connected);
			assert.deepStrictEqual(notes, []);
			assert.strictEqual(destroyed, 3);
			messages.fire({ type: 'updateMidiInput', folder: folder.uri.toString(), value: '' });
			await waitFor(message => message.editable && message.connection === '');
			await configuration.update('midi.input', 'External keyboard', vscode.ConfigurationTarget.WorkspaceFolder);
			await waitFor(message => message.connection === 'External keyboard');
			ports = ['Keyboard 2'];
			await configuration.update('midi.input', 'Keyboard 2', vscode.ConfigurationTarget.WorkspaceFolder);
			messages.fire({ type: 'getMidiInputPorts' });
			await waitFor(message => !message.loading && message.canConnect);
			messages.fire({ type: 'setMidiInputConnection', folder: folder.uri.toString(), connected: true });
			await waitFor(message => message.connected);
			inputs.at(-1)!.emit('noteon', 60, 100, { channel: 0 });
			await configuration.update('midi.input', 'External keyboard', vscode.ConfigurationTarget.WorkspaceFolder);
			await waitFor(message => message.connection === 'External keyboard' && !message.connected);
			assert.deepStrictEqual(notes, []);
			assert.strictEqual(destroyed, 4);
			await configuration.update('midi.input', 'Keyboard 2', vscode.ConfigurationTarget.WorkspaceFolder);
			await waitFor(message => message.canConnect);
			messages.fire({ type: 'setMidiInputConnection', folder: folder.uri.toString(), connected: true });
			await waitFor(message => message.connected);
			for (const property of ['title', 'badge']) {
				Object.defineProperty(view, property, { set: () => { throw new Error('Disposed view marker must not be updated'); } });
			}
			events.fire();
			assert.strictEqual(destroyed, 5);
			assert.strictEqual(inputs.at(-1)!.listenerCount('noteon'), 0);
		} finally {
			provider.dispose();
			for (const subscription of context.subscriptions) { subscription.dispose(); }
			await configuration.update('midi.input', previous, vscode.ConfigurationTarget.WorkspaceFolder);
			events.dispose(); messages.dispose(); updates.dispose();
		}
	});

	test('NanoDrive8 worker correlates split replies and cancels pending calls on shutdown or failure', async function () {
		this.timeout(15000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		let creates = 0; let closes = 0; let mode = 'reply';
		const stdout = new vscode.EventEmitter<Uint8Array>();
		const stderr = new vscode.EventEmitter<Uint8Array>();
		const requests: number[] = []; const errors: string[] = [];
		let sent!: () => void;
		const frame = (kind: number, body: Buffer) => {
			const header = Buffer.alloc(5); header[0] = kind; header.writeUInt32LE(body.length, 1);
			return Buffer.concat([header, body]);
		};
		const wasm = { createProcess: async () => {
			creates++;
			let exited!: (code: number) => void;
			const finished = new Promise<number>(resolve => { exited = resolve; });
			return { stdout: { onData: stdout.event }, stderr: { onData: stderr.event },
				stdin: { write: async (input: string) => {
					const request = JSON.parse(input);
					if (mode === 'hang') { sent(); return; }
					if (mode === 'oversized') { const header = Buffer.alloc(5); header[0] = 2; header.writeUInt32LE(65537, 1); stdout.fire(header); return; }
					requests.push(request.id);
					if (requests.length !== 2) { return; }
					const raw = Buffer.alloc(7); raw.writeUInt32LE(requests[0]!, 0); raw.writeUInt16LE(65535, 4); raw[6] = 42;
					const response = Buffer.concat([frame(1, Buffer.from(JSON.stringify({ id: requests[1], result: null }))), frame(2, raw)]);
					stdout.fire(response.subarray(0, 7)); stdout.fire(response.subarray(7));
				} }, run: () => finished, terminate: async () => { closes++; exited(0); return 0; } };
		} } as unknown as Wasm;
		const worker = new NanoDriveWorker(extension.extensionUri, wasm, error => errors.push(error));
		const params = { operation: 'encode' as const, command: 'getInfo' as const, requestId: 0, payload: [] };
		try {
			assert.deepStrictEqual(await Promise.all([worker.request(params), worker.request(params)]), [{ bytes: Uint8Array.of(42) }, null]);
			assert.strictEqual(creates, 1);
			mode = 'hang'; const entered = new Promise<void>(resolve => { sent = resolve; });
			const pending = worker.request(params); const canceled = assert.rejects(pending, /stopped/);
			await entered; await worker.dispose(); await canceled;
			assert.strictEqual(closes, 1); assert.deepStrictEqual(errors, []);
			mode = 'oversized'; await assert.rejects(worker.request(params), /Invalid.*frame/);
			assert.strictEqual(creates, 2); assert.strictEqual(closes, 2); assert.strictEqual(errors.length, 1);
		} finally { await worker.dispose(); stdout.dispose(); stderr.dispose(); }
	});

	test('NanoDrive8 dedicated WASM encodes handshake and stateful keyboard frames without LSP', async function () {
		this.timeout(20000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const wasm = await Wasm.load();
		const worker = new NanoDriveWorker(extension.extensionUri, wasm);
		try {
			const request = [0, 6, 0x4e, 0x44, 1, 1, 1, 2, 3, 6, 0x4e, 0x44, 0x38, 0x33, 0x96, 0];
			const response = [6, 0x4e, 0x44, 1, 0x81, 1, 2, 4, 1, 6, 0x4e, 0x44, 0x38, 0xe4, 0x56];
			assert.deepStrictEqual(await worker.request(
				{ operation: 'encode', command: 'ping', requestId: 1, payload: [0x4e, 0x44, 0x38] }), { bytes: Uint8Array.from(request) });
			assert.deepStrictEqual(await worker.request({ operation: 'decode', body: response, request }), { status: 0 });
			response[response.length - 1] ^= 1;
			assert.strictEqual(await worker.request({ operation: 'decode', body: response, request }), null);
			const voice = { algorithm: 7, feedback: 0, operatorMask: 15,
				operators: Array.from({ length: 4 }, () => ({ ar: 31, d1r: 0, d2r: 0, rr: 15, d1l: 0, tl: 32, ks: 0, mul: 1, dt1: 0, dt2: 0, ame: 0 })) };
			const input = async (command: Parameters<typeof nanoDriveTestCodec>[0] & { operation: 'audition' }) => {
				const result = await worker.request(command);
				assert.ok(result && 'bytes' in result); return result;
			};
			const audition = (command: Extract<Parameters<typeof nanoDriveTestCodec>[0], { operation: 'audition' }>['command'], session = 5) =>
				input({ operation: 'audition', session, requestId: 10, command });
			const initialized = await audition({ type: 'init', voice });
			assert.strictEqual(initialized.count, 3);
			assert.strictEqual(initialized.bytes.filter(byte => byte === 0).length, 6);
			const on = await audition({ type: 'noteOn', source: 0, channel: 0, note: 69, velocity: 127 });
			assert.strictEqual(on.count, 1); assert.ok(on.bytes.length > 50);
			const bent = await audition({ type: 'pitchBend', source: 0, channel: 0, value: 10240 });
			assert.strictEqual(bent.count, 1); assert.ok(bent.bytes.length < 20);
			assert.ok(Buffer.from(bent.bytes).includes(Buffer.from([0x28, 0x4a, 0x30, 128])));
			assert.deepStrictEqual(await audition({ type: 'pitchBend', source: 0, channel: 0, value: 10240 }), { bytes: new Uint8Array(0), count: 0 });
			const off = await audition({ type: 'noteOff', source: 0, channel: 0, note: 69 });
			assert.strictEqual(off.count, 1); assert.ok(off.bytes.length < 20);
			assert.deepStrictEqual(await audition({ type: 'noteOff', source: 0, channel: 0, note: 69 }), { bytes: new Uint8Array(0), count: 0 });
			await assert.rejects(audition({ type: 'allOff' }, 6), /Stale/);
			assert.strictEqual((await audition({ type: 'stop' })).count, 1);
			await assert.rejects(audition({ type: 'noteOn', source: 0, channel: 0, note: 69, velocity: 127 }), /not initialized/);
			await worker.dispose();
			assert.deepStrictEqual(await worker.request({ operation: 'encode', command: 'ping', requestId: 1, payload: [0x4e, 0x44, 0x38] }), { bytes: Uint8Array.from(request) });
			const pending = worker.request({ operation: 'encode', command: 'getInfo', requestId: 1, payload: [] });
			const canceled = assert.rejects(pending, /stopped/);
			await worker.dispose(); await canceled;
		} finally { await worker.dispose(); }
	});

	test('NanoDrive8 dedicated WASM uses timed FM-only binary bursts without unused PDX or ADPCM', async function () {
		this.timeout(20000);
		const extension=vscode.extensions.all.find(extension=>extension.packageJSON.name==='mmlx-lsp'); assert.ok(extension);
		const worker=new NanoDriveWorker(extension.extensionUri,await Wasm.load());
		try {
			const source=new TextEncoder().encode('#pcmfile "unused"\nA r4 c4\nP r2');
			await worker.request({ operation:'upload',asset:'source',offset:0,bytes:Array.from(source) });
			assert.deepStrictEqual(await worker.request({ operation:'playbackInfo' }),{ audio:false,pdxName:null });
			assert.deepStrictEqual(await worker.request({ operation:'playbackInit',looped:false }),{ audio:false });
			let position=0; let synchronized=false; let ended=false;
			for(let index=0;index<100;index++) {
				const result=await worker.request({ operation:'playbackNext',requestId:index*128 });
				assert.ok(result && 'bytes' in result && result.bytes instanceof Uint8Array && result.fm===true);
				assert.ok(result.position!>=position && result.count!>=0); position=result.position!;
				synchronized ||= result.synchronize===true;
				if(result.ended) { ended=true; break; }
			}
			assert.ok(ended && synchronized && position>20000);
			await worker.request({ operation:'playbackStop' });
		} finally { await worker.dispose(); }
	});

	test('NanoDrive8 dedicated WASM streams bounded binary playback with large MML and PDX', async function () {
		this.timeout(20000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const worker = new NanoDriveWorker(extension.extensionUri, await Wasm.load());
		try {
			const source = new TextEncoder().encode('\n'.repeat(70000) + '#pcmfile "drums"\nA r4\nP o1 c4');
			for (let offset = 0; offset < source.length; offset += 8192) {
				await worker.request({ operation: 'upload', asset: 'source', offset, bytes: Array.from(source.subarray(offset, offset + 8192)) });
			}
			assert.deepStrictEqual(await worker.request({ operation: 'playbackInfo' }), { audio: true, pdxName: 'drums' });
			await assert.rejects(worker.request({ operation: 'playbackInit', looped: false }), /PDX/);
			const pdx = Buffer.alloc(768 + 2048); pdx.writeUInt32BE(768, 9 * 8); pdx.writeUInt32BE(2048, 9 * 8 + 4); pdx.fill(0x77, 768);
			await worker.request({ operation: 'upload', asset: 'pdx', offset: 0, bytes: Array.from(pdx) });
			await worker.request({ operation: 'playbackInit', looped: false });
			let position = 0; let ended = false; let chunks = 0;
			for (; chunks < 300; chunks++) {
				const result = await worker.request({ operation: 'playbackNext', requestId: chunks * 128 & 65535 });
				assert.ok(result && 'bytes' in result && result.bytes instanceof Uint8Array);
				assert.ok(Number.isInteger(result.count) && result.count! > 0 && result.bytes.length < 65525);
				assert.ok(result.position! > position && result.position! - position <= 160);
				position = result.position!;
				if (result.ended) { ended = true; break; }
			}
			assert.ok(ended && chunks > 4 && chunks < 100);
			await assert.rejects(worker.request({ operation: 'playbackNext', requestId: 0 }), /ended/);
			await worker.request({ operation: 'playbackStop' });
			await assert.rejects(worker.request({ operation: 'playbackNext', requestId: 0 }), /not initialized/);
			for (const adpcmMode of ['through', 'resample', 'lpf'] as const) {
				for (let offset = 0; offset < source.length; offset += 8192) {
					await worker.request({ operation: 'upload', asset: 'source', offset, bytes: Array.from(source.subarray(offset, offset + 8192)) });
				}
				await worker.request({ operation: 'upload', asset: 'pdx', offset: 0, bytes: Array.from(pdx) });
				assert.deepStrictEqual(await worker.request({ operation: 'playbackInit', looped: false, adpcmMode }), { audio: true });
				const chunk = await worker.request({ operation: 'playbackNext', requestId: 0 });
				assert.ok(chunk && 'bytes' in chunk && chunk.bytes instanceof Uint8Array && chunk.position! > 0);
				await worker.request({ operation: 'playbackStop' });
			}
		} finally { await worker.dispose(); }
	});

	test('NanoDrive8 Playback applies Settings ADPCM mode and PDX overrides or discovery', async function () {
		this.timeout(20000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		assert.strictEqual(extension.packageJSON.contributes.configuration.properties['mmlx.build.adpcmMode'].default, 'resample');
		const folder = vscode.workspace.workspaceFolders![0];
		const configuration = vscode.workspace.getConfiguration('mmlx', folder.uri);
		const keys = ['serial.connection', 'build.adpcmMode', 'build.pdx'];
		const previous = keys.map(key => {
			const setting = configuration.inspect(key);
			return vscode.workspace.workspaceFile ? setting?.workspaceFolderValue : setting?.workspaceValue;
		});
		const directoryName = `nanodrive-playback-${randomUUID()}`;
		const directory = vscode.Uri.joinPath(folder.uri, directoryName);
		const override = vscode.Uri.joinPath(directory, 'override.pdx');
		const context = { extensionUri: extension.extensionUri, subscriptions: [] as vscode.Disposable[] };
		const events = new vscode.EventEmitter<void>(); const messages = new vscode.EventEmitter<unknown>();
		const updates = new vscode.EventEmitter<Record<string, unknown>>();
		const states = new Map<string, Record<string, unknown>>();
		const captured: Parameters<typeof nanoDriveTestCodec>[0][] = [];
		const port = new NanoDriveTestPort();
		let pdxName: string | null = 'drums';
		const provider = new VoiceViewProvider(context as unknown as vscode.ExtensionContext, () => undefined,
			async () => [{ path: '/dev/nanodrive-test' }], async () => [], undefined, undefined, async () => port, async params => {
				captured.push(params);
				if (params.operation === 'upload' || params.operation === 'playbackStop') { return null; }
				if (params.operation === 'playbackInfo') { return { audio: true, pdxName }; }
				if (params.operation === 'playbackInit') { throw new Error('Playback initialization captured'); }
				return nanoDriveTestCodec(params);
			});
		const view = { visible: true, onDidChangeVisibility: events.event, onDidDispose: events.event,
			webview: { cspSource: 'https://test.invalid', asWebviewUri: (uri: vscode.Uri) => uri,
				onDidReceiveMessage: messages.event, postMessage: (message: Record<string, unknown>) => {
					states.set(String(message.type), message); updates.fire(message); return Promise.resolve(true);
				} }
		} as unknown as vscode.WebviewView;
		function waitFor(type: string, predicate: (state: Record<string, unknown>) => boolean): Promise<void> {
			const latest = states.get(type);
			if (latest && predicate(latest)) { return Promise.resolve(); }
			return new Promise((resolve, reject) => {
				const subscription = updates.event(state => {
					if (state.type === type && predicate(state)) { clearTimeout(timer); subscription.dispose(); resolve(); }
				});
				const timer = setTimeout(() => { subscription.dispose(); reject(new Error(`Playback settings timed out: ${type}`)); }, 4000);
			});
		}
		try {
			await vscode.workspace.fs.createDirectory(directory);
			await vscode.workspace.fs.writeFile(override, Uint8Array.of(1, 2, 3));
			await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(directory, 'Drums.PDX'), Uint8Array.of(4, 5, 6));
			await configuration.update('serial.connection', '/dev/nanodrive-test', vscode.ConfigurationTarget.WorkspaceFolder);
			await provider.resolveWebviewView(view); messages.fire({ type: 'ready' });
			await waitFor('serialSettings', state => state.canConnect === true);
			messages.fire({ type: 'setSerialConnection', folder: folder.uri.toString(), connected: true });
			await waitFor('serialSettings', state => state.connected === true);
			let id = 0;
			for (const scenario of [
				{ mode: 'through', pdx: `${directoryName}/override.pdx`, name: 'drums', bytes: [1, 2, 3] },
				{ mode: 'lpf', pdx: override.fsPath, name: null, bytes: [1, 2, 3] },
				{ mode: 'resample', pdx: '', name: 'drums', bytes: [4, 5, 6] }
			]) {
				const input = vscode.Uri.joinPath(directory, `${scenario.mode}.mml`);
				await vscode.workspace.fs.writeFile(input, new TextEncoder().encode(`${scenario.name ? '#pcmfile "drums"\n' : ''}P F2 o1 c4`));
				await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(input));
				await waitFor('playback', state => state.document === input.toString() && state.available === true);
				await configuration.update('build.adpcmMode', scenario.mode, vscode.ConfigurationTarget.WorkspaceFolder);
				await configuration.update('build.pdx', scenario.pdx, vscode.ConfigurationTarget.WorkspaceFolder);
				pdxName = scenario.name;
				const start = captured.length;
				messages.fire({ type: 'playbackAction', action: 'play', mode: 'nanodrive8', id: ++id, document: input.toString(), looped: false });
				await waitFor('playback', state => state.id === id && state.error === 'Playback initialization captured');
				assert.deepStrictEqual(captured.slice(start).find(request => request.operation === 'playbackInit'), {
					operation: 'playbackInit', looped: false, adpcmMode: scenario.mode
				});
				assert.deepStrictEqual(captured.slice(start).filter(request => request.operation === 'upload' && request.asset === 'pdx').at(-1), {
					operation: 'upload', asset: 'pdx', offset: 0, bytes: scenario.bytes
				});
			}
		} finally {
			provider.dispose(); for (const subscription of context.subscriptions) { subscription.dispose(); }
			for (let index = 0; index < keys.length; index++) { await configuration.update(keys[index], previous[index], vscode.ConfigurationTarget.WorkspaceFolder); }
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
			await vscode.workspace.fs.delete(directory, { recursive: true });
			events.dispose(); messages.dispose(); updates.dispose();
		}
	});

	test('NanoDrive8 Settings connect, lock configuration and release ports on changes or disposal', async function () {
		this.timeout(20000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const folder = vscode.workspace.workspaceFolders![0];
		const configuration = vscode.workspace.getConfiguration('mmlx', folder.uri);
		const setting = configuration.inspect<string>('serial.connection');
		const previous = vscode.workspace.workspaceFile ? setting?.workspaceFolderValue : setting?.workspaceValue;
		const midiSetting = configuration.inspect<string>('midi.input');
		const previousMidi = vscode.workspace.workspaceFile ? midiSetting?.workspaceFolderValue : midiSetting?.workspaceValue;
		const context = { extensionUri: extension.extensionUri, subscriptions: [] as vscode.Disposable[] };
		const events = new vscode.EventEmitter<void>(); const messages = new vscode.EventEmitter<unknown>();
		const visibility = new vscode.EventEmitter<void>();
		type SerialState = { type: string; folder: string; connection: string; connected: boolean; connecting: boolean;
			closing: boolean; loading: boolean; editable: boolean; canConnect: boolean; firmware: string; error: string; id?: number; value?: number };
		const updates = new vscode.EventEmitter<SerialState>(); let latest: SerialState | undefined;
		const outputs: SerialState[] = [];
		const pitchUpdates: number[] = [];
		const expectedBends = (value: number) => [
			{ type: 'pitchBend', source: 0, channel: 0, value },
			...Array.from({ length: 16 }, (_unused, channel) => ({ type: 'pitchBend', source: 1, channel, value }))
		];
		const opened: NanoDriveTestPort[] = []; let available = [{ path: '/dev/nanodrive-test' }];
		const input = Object.assign(new NodeEventEmitter(), {
			getPortCount: () => 1, getPortName: () => 'Pitch bend test',
			ignoreTypes: () => {}, openPort: () => {}, destroy: () => { input.removeAllListeners(); }
		});
		let midiConnected = false;
		const provider = new VoiceViewProvider(context as unknown as vscode.ExtensionContext, () => undefined,
			async () => available, async () => ['Pitch bend test'], async () => input, undefined, async () => {
				const port = new NanoDriveTestPort(); opened.push(port); return port;
			}, nanoDriveTestCodec);
		const view = { visible: true, onDidChangeVisibility: visibility.event, onDidDispose: events.event,
			webview: { cspSource: 'https://test.invalid', asWebviewUri: (uri: vscode.Uri) => uri,
				onDidReceiveMessage: messages.event, postMessage: (message: SerialState) => {
					if (message.type === 'serialSettings') { latest = message; updates.fire(message); }
					if (message.type === 'outputConnection') { outputs.push(message); updates.fire(message); }
					if (message.type === 'midiSettings') { midiConnected = message.connected; }
					if (message.type === 'pitchBend') { pitchUpdates.push(message.value!); }
					return Promise.resolve(true);
				} }
		} as unknown as vscode.WebviewView;
		function waitFor(predicate: (state: SerialState) => boolean, type = 'serialSettings'): Promise<SerialState> {
			const existing = type === 'serialSettings' ? latest : outputs.at(-1);
			if (existing && predicate(existing)) { return Promise.resolve(existing); }
			return new Promise((resolve, reject) => {
				const subscription = updates.event(state => {
					if (state.type === type && predicate(state)) { clearTimeout(timer); subscription.dispose(); resolve(state); }
				});
				const timer = setTimeout(() => { subscription.dispose(); reject(new Error(`NanoDrive8 settings timed out: ${predicate}; ${JSON.stringify(latest)}; ${JSON.stringify(opened.map(port => port.commands))}`)); }, 4000);
			});
		}
		try {
			await configuration.update('serial.connection', '/dev/nanodrive-test', vscode.ConfigurationTarget.WorkspaceFolder);
			await configuration.update('midi.input', 'Pitch bend test', vscode.ConfigurationTarget.WorkspaceFolder);
			await provider.resolveWebviewView(view); messages.fire({ type: 'ready' });
			await waitFor(state => state.canConnect); assert.strictEqual(opened.length, 0);
			messages.fire({ type: 'setSerialConnection', folder: 'file:///wrong', connected: true });
			assert.strictEqual(opened.length, 0);
			messages.fire({ type: 'setSerialConnection', folder: folder.uri.toString(), connected: true });
			const connected = await waitFor(state => state.connected);
			assert.strictEqual(connected.firmware, '1.0b8'); assert.ok(!connected.editable);
			assert.match(view.title!, /Connected/); assert.match(view.badge!.tooltip, /NanoDrive8/);
			messages.fire({ type: 'setOutputConnection', target: 'keyboard', mode: 'nanodrive8', id: 1, connected: true });
			await waitFor(state => state.id === 1 && state.connected, 'outputConnection');
			assert.strictEqual(opened[0].commands.at(-2)?.input?.type, 'init');
			const count = opened[0].commands.length;
			messages.fire({ type: 'emulationNote', event: 'noteOn', note: 69, velocity: 100, id: 0 });
			messages.fire({ type: 'emulationNote', event: 'noteOn', note: 128, velocity: 100, id: 1 });
			await new Promise<void>(resolve => setImmediate(resolve)); assert.strictEqual(opened[0].commands.length, count);
			messages.fire({ type: 'emulationNote', event: 'noteOn', note: 69, velocity: 100, id: 1 });
			messages.fire({ type: 'emulationNote', event: 'noteOff', note: 69, velocity: 0, id: 1 });
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.deepStrictEqual(opened[0].commands.slice(count).map(request => request.input?.type), ['noteOn', 'noteOff']);
			const bendStart = opened[0].commands.length;
			for (const value of [9000, 10000, 10240]) { messages.fire({ type: 'emulationNote', event: 'pitchBend', value, id: 1 }); }
			messages.fire({ type: 'emulationNote', event: 'pitchBend', value: 16384, id: 1 });
			messages.fire({ type: 'emulationNote', event: 'pitchBend', value: 0, id: 0 });
			messages.fire({ type: 'emulationNote', event: 'noteOn', note: 70, velocity: 100, id: 1 });
			messages.fire({ type: 'emulationNote', event: 'noteOff', note: 70, velocity: 0, id: 1 });
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.deepStrictEqual(opened[0].commands.slice(bendStart).map(request => request.input), [
				...expectedBends(10240),
				{ type: 'noteOn', source: 0, channel: 0, note: 70, velocity: 100 },
				{ type: 'noteOff', source: 0, channel: 0, note: 70, velocity: 0 }
			]);
			const timedBendStart = opened[0].commands.length;
			messages.fire({ type: 'emulationNote', event: 'pitchBend', value: 0, id: 1 });
			await new Promise<void>(resolve => setTimeout(resolve, 30));
			assert.deepStrictEqual(opened[0].commands.slice(timedBendStart).map(request => request.input), expectedBends(0));
			messages.fire({ type: 'setMidiInputConnection', folder: folder.uri.toString(), connected: true });
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.ok(midiConnected);
			input.emit('messageBuffer', 0, Buffer.from([0xe3, 0, 80]));
			input.emit('noteon', 69, 100, { channel: 3 });
			input.emit('noteoff', 69, 0, { channel: 3 });
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.deepStrictEqual(opened[0].commands.at(-4)?.input, { type: 'pitchBend', source: 1, channel: 3, value: 10240 });
			assert.deepStrictEqual(opened[0].commands.at(-3)?.input, { type: 'pitchBend', source: 0, channel: 0, value: 10240 });
			assert.strictEqual(pitchUpdates.at(-1), 10240);
			input.emit('noteon', 69, 100, { channel: 3 });
			await new Promise<void>(resolve => setImmediate(resolve));
			const wheelMidiStart = opened[0].commands.length;
			const pitchDisplayStart = pitchUpdates.length;
			messages.fire({ type: 'emulationNote', event: 'pitchBend', value: 12000, id: 1 });
			input.emit('noteon', 72, 100, { channel: 5 });
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.deepStrictEqual(opened[0].commands.slice(wheelMidiStart).map(request => request.input), [
				...expectedBends(12000), { type: 'noteOn', source: 1, channel: 5, note: 72, velocity: 100 }
			]);
			assert.strictEqual(pitchUpdates.length, pitchDisplayStart);
			input.emit('noteoff', 69, 0, { channel: 3 });
			input.emit('noteoff', 72, 0, { channel: 5 });
			messages.fire({ type: 'emulationNote', event: 'pitchBend', value: 8192, id: 1 });
			input.emit('messageBuffer', 0, Buffer.from([0xe3, 0, 80]));
			input.emit('noteon', 69, 100, { channel: 3 });
			await new Promise<void>(resolve => setImmediate(resolve));
			const hideStart = opened[0].commands.length;
			Object.assign(view, { visible: false }); visibility.fire();
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.deepStrictEqual(opened[0].commands.slice(hideStart).map(request => request.input), [{ type: 'allOff', source: 0 }]);
			assert.strictEqual(pitchUpdates.at(-1), 10240);
			Object.assign(view, { visible: true });
			messages.fire({ type: 'setOutputConnection', target: 'keyboard', mode: 'nanodrive8', id: 1, connected: false });
			await waitFor(state => state.id === 1 && !state.connected && !state.connecting, 'outputConnection');
			assert.ok(opened[0].isOpen && latest?.connected);
			assert.strictEqual(opened[0].commands.at(-2)?.input?.type, 'stop');
			messages.fire({ type: 'updateSerialConnection', folder: folder.uri.toString(), value: '' });
			assert.strictEqual(vscode.workspace.getConfiguration('mmlx', folder.uri).get('serial.connection'), '/dev/nanodrive-test');
			messages.fire({ type: 'setSerialConnection', folder: folder.uri.toString(), connected: false });
			await waitFor(state => !state.connected && !state.closing && state.canConnect);
			assert.ok(!opened[0].isOpen); assert.strictEqual(opened[0].commands.at(-1)?.command, 'reset');
			messages.fire({ type: 'setSerialConnection', folder: folder.uri.toString(), connected: true });
			await waitFor(state => state.connected);
			const reconnectStart = opened[1].commands.length;
			messages.fire({ type: 'setOutputConnection', target: 'keyboard', mode: 'nanodrive8', id: 2, connected: true });
			await waitFor(state => state.id === 2 && state.connected, 'outputConnection');
			input.emit('noteon', 69, 100, { channel: 3 });
			input.emit('noteoff', 69, 0, { channel: 3 });
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.deepStrictEqual(opened[1].commands.slice(reconnectStart).filter(request => request.input && 'source' in request.input && request.input.source === 1).map(request => request.input), [
				{ type: 'pitchBend', source: 1, channel: 3, value: 10240 },
				{ type: 'noteOn', source: 1, channel: 3, note: 69, velocity: 100 },
				{ type: 'noteOff', source: 1, channel: 3, note: 69 }
			]);
			available = []; messages.fire({ type: 'getSerialPorts' });
			await waitFor(state => !state.loading && !state.closing && /no longer available/.test(state.error));
			assert.ok(!opened[1].isOpen);
			assert.strictEqual(outputs.at(-1)?.connected, false);
			available = [{ path: '/dev/nanodrive-test' }]; messages.fire({ type: 'getSerialPorts' });
			await waitFor(state => state.canConnect);
			messages.fire({ type: 'setSerialConnection', folder: folder.uri.toString(), connected: true });
			await waitFor(state => state.connected);
			await configuration.update('serial.connection', '/dev/changed', vscode.ConfigurationTarget.WorkspaceFolder);
			await waitFor(state => !state.closing && !state.connected && state.connection === '/dev/changed');
			assert.ok(!opened[2].isOpen);
			await configuration.update('serial.connection', '/dev/nanodrive-test', vscode.ConfigurationTarget.WorkspaceFolder);
			await waitFor(state => state.canConnect);
			messages.fire({ type: 'setSerialConnection', folder: folder.uri.toString(), connected: true });
			await waitFor(state => state.connected);
			const close = opened[3].close.bind(opened[3]);
			const closed = new Promise<void>(resolve => { opened[3].close = async () => { await close(); resolve(); }; });
			for (const property of ['title', 'badge']) {
				Object.defineProperty(view, property, { set: () => { throw new Error('Disposed view marker must not be updated'); } });
			}
			events.fire(); await closed;
			assert.ok(!opened[3].isOpen);
		} finally {
			provider.dispose(); for (const subscription of context.subscriptions) { subscription.dispose(); }
			await configuration.update('serial.connection', previous, vscode.ConfigurationTarget.WorkspaceFolder);
			await configuration.update('midi.input', previousMidi, vscode.ConfigurationTarget.WorkspaceFolder);
			events.dispose(); visibility.dispose(); messages.dispose(); updates.dispose();
		}
	});

	test('NanoDrive8 Keyboard Webview uses serial availability without browser audio', async function () {
		this.timeout(15000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const media = vscode.Uri.joinPath(extension.extensionUri, 'assets', 'webview');
		const icons = vscode.Uri.joinPath(extension.extensionUri, 'assets', 'icon');
		const panel = vscode.window.createWebviewPanel('nanodrive-keyboard-test', 'NanoDrive8 Keyboard test', vscode.ViewColumn.Active,
			{ enableScripts: true, localResourceRoots: [media, icons] });
		const nonce = randomUUID();
		let listener: vscode.Disposable | undefined;
		try {
			const result = new Promise<void>((resolve, reject) => {
				listener = panel.webview.onDidReceiveMessage(message => {
					if (message.type === 'ready') { void panel.webview.postMessage({ type: 'nanodriveProbe' }); }
					else if (message.type === 'nanodriveResult') { clearTimeout(timer); resolve(); }
					else if (message.type === 'nanodriveFailure') { clearTimeout(timer); reject(new Error(message.error)); }
				});
				const timer = setTimeout(() => reject(new Error('NanoDrive8 Keyboard Webview timed out')), 10000);
			});
			const template = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(media, 'voice.html')));
			panel.webview.html = template.replaceAll('{{cspSource}}', panel.webview.cspSource).replaceAll('{{nonce}}', nonce)
				.replaceAll('{{iconUri}}', panel.webview.asWebviewUri(vscode.Uri.joinPath(icons, 'mmlx.png')).toString())
				.replaceAll('{{styleUri}}', panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'voice.css')).toString())
				.replaceAll('{{scriptUri}}', panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'voice.js')).toString())
				.replace('</head>', `<script nonce="${nonce}">
					const nativeAcquire = acquireVsCodeApi; const messages = []; let api; let audioContexts = 0;
					window.acquireVsCodeApi = () => {
						api = nativeAcquire();
						return { ...api, postMessage: message => { messages.push(message); api.postMessage(message); } };
					};
					window.AudioContext = class { constructor() { audioContexts++; throw new Error('Unexpected browser audio'); } };
					const send = data => window.dispatchEvent(new MessageEvent('message', { data }));
					const check = (condition, message) => { if (!condition) throw new Error(message); };
					window.addEventListener('message', event => {
						if (event.data?.type !== 'nanodriveProbe') return;
						const run = () => { try {
							document.getElementById('voice-tab').click();
							const mode = document.querySelector('.keyboard-output select');
							const button = document.querySelector('.keyboard-output .output-connection');
							const key = document.querySelector('#keyboard [data-midi-note="69"]');
							if (!key) { requestAnimationFrame(run); return; }
							mode.value = 'nanodrive8'; mode.dispatchEvent(new Event('change'));
							check(button.disabled && !mode.disabled, 'Settings connection required');
							send({ type: 'playback', id: 0, available: true, document: 'file:///test.mml', source: 'test.mml', playing: false, paused: false, loading: false });
							const playbackMode = document.getElementById('playback-mode');
							const play = document.getElementById('playback-play');
							const cursor = document.getElementById('playback-cursor');
							const volume = document.getElementById('playback-volume');
							const serial = { type: 'serialSettings', folder: 'test', connection: '/dev/test', ports: [{ path: '/dev/test' }], connected: true, firmware: '1.0b8', model: 'NanoDrive 8' };
							send(serial); check(!button.disabled, 'Settings connection must enable output');
							check(playbackMode.value === 'nanodrive8' && !play.disabled && cursor.disabled && volume.disabled, 'NanoDrive Playback auto-selection and unsupported controls');
							button.click();
							const request = messages.find(message => message.type === 'setOutputConnection');
							check(request?.mode === 'nanodrive8' && request.connected && button.disabled && mode.disabled, 'Keyboard connect request and busy state');
							send({ type: 'outputConnection', target: 'keyboard', id: request.id, mode: 'nanodrive8', connected: true, connecting: false });
							check(key.getAttribute('aria-disabled') === 'false' && button.getAttribute('aria-pressed') === 'true', 'Connected keyboard');
							const wheel = document.getElementById('keyboard-pitch-bend');
							const firstKey = document.querySelector('#keyboard [data-midi-note]');
							check(!wheel.disabled && wheel.getBoundingClientRect().right <= firstKey.getBoundingClientRect().left, 'Pitch wheel must be enabled to the left of the keys');
							wheel.focus();
							check(getComputedStyle(wheel).outlineStyle === 'none', 'Wheel must not show a focus outline');
							const beforeMidiBend = messages.length;
							send({ type: 'pitchBend', value: 10240 });
							check(wheel.value === '10240' && wheel.getAttribute('aria-valuetext') !== '0.00 semitones', 'MIDI bend must update the wheel');
							wheel.dispatchEvent(new Event('blur'));
							window.dispatchEvent(new Event('blur'));
							check(wheel.value === '10240' && messages.length === beforeMidiBend, 'MIDI display must not echo or reset on blur');
							wheel.value = '0'; wheel.dispatchEvent(new Event('input'));
							check(messages.at(-1).event === 'pitchBend' && messages.at(-1).value === 0 && messages.at(-1).id === request.id, 'Wheel must send pitch bend');
							wheel.dispatchEvent(new PointerEvent('pointerup'));
							check(wheel.value === '8192' && messages.at(-1).value === 8192, 'Wheel must spring to center');
							wheel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
							check(Number(wheel.value) > 8192, 'Wheel keyboard control');
							wheel.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp' }));
							check(wheel.value === '8192', 'Wheel keyboard release must center');
							for (const release of ['pointercancel', 'blur']) {
								wheel.value = '16383'; wheel.dispatchEvent(new Event('input'));
								wheel.dispatchEvent(new Event(release));
								check(wheel.value === '8192', 'Wheel must center on ' + release);
							}
							key.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
							key.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter' }));
							check(messages.some(message => message.type === 'emulationNote' && message.event === 'noteOn' && message.note === 69 && message.id === request.id), 'Key-on routing');
							check(messages.some(message => message.type === 'emulationNote' && message.event === 'noteOff' && message.note === 69), 'Key-off routing');
							button.click(); check(messages.at(-1).type === 'setOutputConnection' && !messages.at(-1).connected, 'Keyboard disconnect');
							send({ type: 'outputConnection', target: 'keyboard', id: request.id, mode: 'nanodrive8', connected: false, connecting: false });
							check(!button.disabled && key.getAttribute('aria-disabled') === 'true', 'Settings remains connected');
							check(wheel.disabled && wheel.value === '8192', 'Disconnected wheel must be disabled and centered');
							document.getElementById('playback-tab').click();
							const stop = document.getElementById('playback-stop');
							stop.style.transition = 'none';
							play.style.transition = 'none';
							const inactiveStopBackground = getComputedStyle(stop).backgroundColor;
							const playBounds = play.getBoundingClientRect();
							const stopBounds = stop.getBoundingClientRect();
							check(stopBounds.width === playBounds.width && stopBounds.height === playBounds.height && stopBounds.width === 44, 'Stop must match the Play button size');
							check(stop.disabled, 'Stop must be disabled while stopped');
							play.click();
							const playbackRequest = messages.find(message => message.type === 'playbackAction' && message.action === 'play');
							check(playbackRequest?.mode === 'nanodrive8' && !playbackRequest.sampleRate, 'Binary hardware playback without browser PCM');
							send({ type: 'nanoDrivePlayback', busy: true }); check(button.disabled, 'Keyboard connection locked by Playback');
							send({ type: 'playback', id: playbackRequest.id, mode: 'nanodrive8', available: true, document: 'file:///test.mml', playing: true, paused: false, loading: false, busy: true });
							check(play.disabled && play.title === 'Play' && cursor.disabled && volume.disabled, 'Hardware playback cannot pause, seek or change PC volume');
							check(!stop.disabled, 'Hardware Stop is enabled');
							check(getComputedStyle(stop).backgroundColor !== inactiveStopBackground && getComputedStyle(stop).backgroundColor === getComputedStyle(play).backgroundColor, 'Enabled Stop must use the active button color');
							stop.click();
							check(messages.at(-1).type === 'playbackAction' && messages.at(-1).action === 'stop', 'Hardware Stop request');
							send({ type: 'nanoDrivePlayback', busy: false }); check(!button.disabled, 'Keyboard unlock after hardware cleanup');
							send({ type: 'playback', id: playbackRequest.id, mode: 'nanodrive8', available: true, document: 'file:///test.mml', playing: false, paused: false, loading: false, busy: false });
							check(stop.disabled && getComputedStyle(stop).backgroundColor === inactiveStopBackground, 'Stopped button must return to the inactive color');
							playbackMode.value = 'emulation'; playbackMode.dispatchEvent(new Event('change')); send(serial);
							check(playbackMode.value === 'emulation', 'Settings updates preserve manually selected Playback mode');
							send({ ...serial, connected: false }); check(button.disabled && !mode.disabled, 'Port loss disables output');
							check(audioContexts === 0, 'NanoDrive8 must not initialize AudioContext');
							api.postMessage({ type: 'nanodriveResult' });
						} catch (error) { api.postMessage({ type: 'nanodriveFailure', error: String(error) }); } };
						run();
					});
				</script></head>`);
			await result;
		} finally { listener?.dispose(); panel.dispose(); }
	});

	test('NanoDrive8 Settings Webview toggles connect and disconnect with firmware and busy states', async function () {
		this.timeout(15000);
		const extension = vscode.extensions.all.find(extension => extension.packageJSON.name === 'mmlx-lsp');
		assert.ok(extension);
		const media = vscode.Uri.joinPath(extension.extensionUri, 'assets', 'webview');
		const icons = vscode.Uri.joinPath(extension.extensionUri, 'assets', 'icon');
		const panel = vscode.window.createWebviewPanel('nanodrive-settings-test', 'NanoDrive8 Settings test', vscode.ViewColumn.Active,
			{ enableScripts: true, localResourceRoots: [media, icons] });
		const nonce = randomUUID();
		try {
			const result = new Promise<{ error?: string }>((resolve, reject) => {
				const subscription = panel.webview.onDidReceiveMessage(message => {
					clearTimeout(timer); subscription.dispose(); resolve(message);
				});
				const timer = setTimeout(() => { subscription.dispose(); reject(new Error('NanoDrive8 Webview timed out')); }, 10000);
			});
			const template = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(media, 'voice.html')));
			const module = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'settingsControls.js'));
			panel.webview.html = template.replaceAll('{{cspSource}}', panel.webview.cspSource).replaceAll('{{nonce}}', nonce)
				.replaceAll('{{iconUri}}', panel.webview.asWebviewUri(vscode.Uri.joinPath(icons, 'mmlx.png')).toString())
				.replaceAll('{{styleUri}}', panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'voice.css')).toString())
				.replaceAll('{{scriptUri}}', module.toString())
				.replace('</body>', `<script type="module" nonce="${nonce}">
					import { createSettingsControls } from '${module}';
					const api = acquireVsCodeApi();
					try {
						for (const section of document.querySelectorAll('[role="tabpanel"]')) section.hidden = section.id !== 'settings-controls';
						const messages = [];
						const controls = createSettingsControls(document.getElementById('settings-controls'), message => messages.push(message));
						const button = document.getElementById('connect-serial');
						const select = document.getElementById('serial-connection');
						const status = document.getElementById('serial-settings-status');
						const assert = (condition, message) => { if (!condition) throw new Error(message); };
						const base = { type: 'serialSettings', folder: 'test', connection: '/dev/test', ports: [{ path: '/dev/test' }], editable: true, canConnect: true };
						controls.render(base);
						assert(!button.disabled && !select.disabled, 'Available port must enable connection');
						button.click();
						assert(messages[0].type === 'setSerialConnection' && messages[0].connected === true, 'Connect click');
						controls.render({ ...base, connecting: true, phase: 'Checking connection' });
						assert(button.disabled && select.disabled && status.textContent === 'Checking connection', 'Probe state');
						controls.render({ ...base, connected: true, model: 'NanoDrive 8', firmware: '1.0b8' });
						assert(!button.disabled && select.disabled && button.getAttribute('aria-pressed') === 'true', 'Connected state');
						assert(status.textContent === 'NanoDrive 8 / FW 1.0b8' && button.title === 'Disconnect NanoDrive8', 'Device identity');
						button.click(); assert(messages[1].connected === false, 'Disconnect click');
						controls.render({ ...base, closing: true, phase: 'Disconnecting' });
						assert(button.disabled && select.disabled, 'Closing state');
						controls.render({ ...base, canConnect: false, error: 'Unsupported firmware' });
						assert(button.disabled && status.textContent === 'Unsupported firmware', 'Error state');
						for (const width of [120, 320, 640]) {
							const root = document.getElementById('settings-controls');
							root.style.width = width + 'px';
							for (const [prefix, settings, refreshType] of [
								['serial', base, 'getSerialPorts'],
								['midi', { ...base, type: 'midiSettings', connection: 'test', ports: ['test'] }, 'getMidiInputPorts'],
							]) {
								controls.render(settings);
								const message = document.getElementById(prefix + '-settings-status');
								const height = message.getBoundingClientRect().height;
								const connect = document.getElementById('connect-' + prefix);
								const select = document.getElementById(prefix + '-connection');
								const bounds = message.getBoundingClientRect();
								const buttonBounds = connect.getBoundingClientRect();
								const selectBounds = select.getBoundingClientRect();
								assert(message.parentElement === connect.parentElement && bounds.left >= buttonBounds.right, prefix + ' message must be right of its controls');
								assert(bounds.top >= buttonBounds.top && bounds.bottom <= buttonBounds.bottom, prefix + ' message must stay on the control row');
								const build = document.querySelector('[aria-labelledby="build-settings-heading"]');
								const top = build.getBoundingClientRect().top;
								document.getElementById('refresh-' + prefix + '-ports').click();
								assert(messages.at(-1).type === refreshType && message.textContent.startsWith('Loading'), prefix + ' refresh');
								assert(Math.abs(message.getBoundingClientRect().height - height) < 0.5, prefix + ' message height changed while refreshing at ' + width);
								assert(Math.abs(build.getBoundingClientRect().top - top) < 0.5, prefix + ' refresh moved Build at ' + width);
								assert(Math.abs(message.getBoundingClientRect().left - bounds.left) < 0.5 && Math.abs(select.getBoundingClientRect().width - selectBounds.width) < 0.5, prefix + ' refresh moved controls at ' + width);
								controls.render(settings);
								assert(Math.abs(build.getBoundingClientRect().top - top) < 0.5, prefix + ' completed refresh moved Build at ' + width);
								const error = 'Connection error '.repeat(20);
								controls.render({ ...settings, error });
								assert(message.textContent === error && message.title === error, prefix + ' must preserve the full error');
								assert(Math.abs(message.getBoundingClientRect().height - height) < 0.5, prefix + ' long error resized the message at ' + width);
								assert(Math.abs(build.getBoundingClientRect().top - top) < 0.5, prefix + ' long error moved Build at ' + width);
								assert(Math.abs(message.getBoundingClientRect().left - bounds.left) < 0.5 && Math.abs(select.getBoundingClientRect().width - selectBounds.width) < 0.5, prefix + ' long error moved controls at ' + width);
							}
						}
						api.postMessage({});
					} catch (error) { api.postMessage({ error: String(error) }); }
				</script></body>`);
			assert.strictEqual((await result).error, undefined);
		} finally { panel.dispose(); }
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
			assert.match(view.webview.html, /<button id="connect-serial" class="output-connection"[^>]*aria-pressed="false" disabled><\/button>/);
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
		assert.ok(gate.documentation.value.includes('キーオフ時刻を指定します。'));
		assert.ok(gate.documentation.value.includes('256 - N'));
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
		assert.ok(!(suppressed?.items ?? []).some(item => item.command?.command === 'editor.action.triggerParameterHints'));
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
		assert.ok(tempo.documentation.value.includes('全トラック共通のテンポとして適用されます。'));
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
			const description = help.signatures[0].documentation.value.split('\n\n')[1];
			assert.ok(description?.trim(), `Missing command description for ${label}`);
			const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
				'vscode.executeCompletionItemProvider', document.uri, document.positionAt(source.length));
			assert.ok(!(completions?.items ?? []).some(item => item.command?.command === 'editor.action.triggerParameterHints'));
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
			assert.ok((await vscode.workspace.fs.readDirectory(directory)).every(([name]) => !name.startsWith('.mmlx-')));
		});

		test('removes staged MDX output when canceled before VGM conversion', async function () {
			this.timeout(60000);
			const input = vscode.Uri.joinPath(directory, 'cancel.mml');
			const mdx = vscode.Uri.joinPath(directory, 'cancel.mdx');
			const vgm = vscode.Uri.joinPath(directory, 'cancel.vgm');
			await vscode.workspace.fs.writeFile(input, new TextEncoder().encode('A r4'));
			await vscode.workspace.fs.writeFile(mdx, new TextEncoder().encode('existing MDX'));
			await vscode.workspace.fs.writeFile(vgm, new TextEncoder().encode('existing VGM'));
			const result = await runBuildTerminal({ type: 'mmlx', input: input.fsPath,
				output: mdx.fsPath, format: 'both' }, data => data.includes('VGM ['));
			assert.strictEqual(result.code, 130, result.output);
			assert.ok(result.output.includes('Canceled'));
			const deadline = Date.now() + 5000;
			let entries = await vscode.workspace.fs.readDirectory(directory);
			while (entries.some(([name]) => name.startsWith('.mmlx-')) && Date.now() < deadline) {
				await new Promise(resolve => setTimeout(resolve, 10));
				entries = await vscode.workspace.fs.readDirectory(directory);
			}
			assert.ok(entries.every(([name]) => !name.startsWith('.mmlx-')));
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

		test('writes large output directly with the bundled WASM', async function () {
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
			assert.ok((await vscode.workspace.fs.readDirectory(directory)).every(([name]) => !name.startsWith('.mmlx-')));
		});

		test('writes both outputs outside the workspace using a mounted output directory', async function () {
			this.timeout(60000);
			const input = vscode.Uri.joinPath(directory, 'external.mml');
			const external = vscode.Uri.joinPath(vscode.Uri.file(tmpdir()), `mmlx-output-${randomUUID()}`);
			const destination = vscode.Uri.joinPath(external, 'output with spaces #1');
			const output = vscode.Uri.joinPath(destination, 'external.vgm');
			assert.strictEqual(vscode.workspace.getWorkspaceFolder(destination), undefined);
			await vscode.workspace.fs.writeFile(input, new TextEncoder().encode('A r4 L r4'));
			try {
				const result = await runBuildTerminal({ type: 'mmlx', input: input.fsPath,
					output: output.toString(), format: 'both' });
				assert.strictEqual(result.code, 0, result.output);
				assert.ok((await vscode.workspace.fs.readFile(vscode.Uri.joinPath(destination, 'external.mdx'))).length > 0);
				assert.strictEqual(Buffer.from(await vscode.workspace.fs.readFile(output)).subarray(0, 4).toString(), 'Vgm ');
				assert.deepStrictEqual((await vscode.workspace.fs.readDirectory(destination)).map(([name]) => name).sort(),
					['external.mdx', 'external.vgm']);
			} finally {
				await vscode.workspace.fs.delete(external, { recursive: true });
			}
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
