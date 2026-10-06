import * as path from 'node:path';
import {
	commands, CustomExecution, Diagnostic, DiagnosticCollection, DiagnosticSeverity,
	EventEmitter, ExtensionContext, FileType, languages, Pseudoterminal, Range, Task,
	TaskDefinition, TaskGroup, TaskPanelKind, TaskRevealKind, tasks, TaskScope, Uri,
	window, workspace, WorkspaceFolder, TextDocument, TaskExecution, TerminalLink,
	TerminalLinkProvider
} from 'vscode';
import { Wasm, WasmProcess } from '@vscode/wasm-wasi/v1';

interface BuildDefinition extends TaskDefinition {
	type: 'mmlx';
	input: string;
	format?: 'both' | 'mdx' | 'vgm';
	output?: string;
	pdx?: string;
	adpcmMode?: 'through' | 'resample' | 'lpf';
	loopCount?: number;
	maxTicks?: number;
}

interface SaveBuildState {
	document: TextDocument;
	version: number;
	timer?: ReturnType<typeof setTimeout>;
	execution?: TaskExecution;
	starting: boolean;
	pending: boolean;
}

interface BuildErrorLink extends TerminalLink {
	uri: Uri;
	range: Range;
}

const buildErrors = new Map<string, BuildErrorLink>();

type BuildResponse = { ok: true; bytes: number[] } | {
	ok: false;
	message: string;
	pdxName?: string;
	range?: [[number, number], [number, number]] | null;
};

class BuildFailure extends Error {
	constructor(readonly response: Extract<BuildResponse, { ok: false }>) {
		super(response.message);
	}
}

function resolveUri(value: string, folder?: WorkspaceFolder, base?: Uri): Uri {
	if (value.includes('${')) {
		throw new Error(`Unresolved task variable: ${value}`);
	}
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
		return Uri.parse(value);
	}
	const directory = folder?.uri ?? base;
	if (!path.isAbsolute(value) && !directory) {
		throw new Error('Relative task paths require a workspace folder.');
	}
	const absolute = path.resolve(directory?.fsPath ?? '', value);
	const uri = Uri.file(absolute);
	return directory ? directory.with({ path: uri.path }) : uri;
}

async function findPdx(input: Uri, name: string): Promise<Uri> {
	const reference = Uri.joinPath(input, '..', name.replace(/\\/g, '/'));
	const directory = Uri.joinPath(reference, '..');
	const filename = path.posix.basename(reference.path);
	const candidates = filename.toLowerCase().endsWith('.pdx')
		? [filename] : [`${filename}.pdx`, filename];
	const entries = await workspace.fs.readDirectory(directory);
	for (const candidate of candidates) {
		const entry = entries.find(([file, type]) =>
			file.toLowerCase() === candidate.toLowerCase() && (type & FileType.File) !== 0);
		if (entry) {
			return Uri.joinPath(directory, entry[0]);
		}
	}
	throw new Error(`PDX file not found: ${name}`);
}

export class BuildTerminal implements Pseudoterminal {
	private readonly writeEmitter = new EventEmitter<string>();
	private readonly closeEmitter = new EventEmitter<number>();
	readonly onDidWrite = this.writeEmitter.event;
	readonly onDidClose = this.closeEmitter.event;
	private process?: WasmProcess;
	private canceled = false;
	private finished = false;
	private started = performance.now();
	private errorLink?: { location: string; uri: Uri; range: Range };

	constructor(
		private readonly extensionUri: Uri,
		private readonly wasm: Wasm,
		private readonly definition: BuildDefinition,
		private readonly folder: WorkspaceFolder | undefined,
		private readonly diagnostics: DiagnosticCollection,
		private readonly onFinish: () => void
	) {}

	open(): void {
		this.started = performance.now();
		void this.build();
	}

	errorLinks(line: string): BuildErrorLink[] {
		const error = this.errorLink;
		if (!error || !line.startsWith(`${error.location}: error:`)) { return []; }
		return [{ startIndex: 0, length: error.location.length, uri: error.uri,
			range: error.range, tooltip: 'Open build error' }];
	}

	close(): void {
		if (this.finished) {
			return;
		}
		this.canceled = true;
		void this.process?.terminate().catch(() => undefined);
		this.status('Canceled', `Build stopped after ${this.elapsed()}s`, '33');
		this.finish(130);
	}

	private write(message: string): void {
		this.writeEmitter.fire(`${message.replace(/\r?\n/g, '\r\n')}\r\n`);
	}

	private status(label: string, message: string, color = '32'): void {
		this.write(`\x1b[1;${color}m${label.padStart(12)}\x1b[0m ${message}`);
	}

	private elapsed(): string {
		return ((performance.now() - this.started) / 1000).toFixed(2);
	}

	private displayPath(uri: Uri): string {
		return workspace.asRelativePath(uri, false);
	}

	private finish(code: number): void {
		if (!this.finished) {
			this.finished = true;
			this.closeEmitter.fire(code);
			this.onFinish();
		}
	}

	private checkCanceled(): void {
		if (this.canceled) {
			throw new Error('Build canceled.');
		}
	}

	private async execute(module: WebAssembly.Module, request: object): Promise<BuildResponse> {
		this.checkCanceled();
		const process = await this.wasm.createProcess('mmlx-build', module,
			{ initial: 160, maximum: 16384, shared: true }, {
				stdio: { in: { kind: 'pipeIn' }, out: { kind: 'pipeOut' }, err: { kind: 'pipeOut' } }
			});
		this.process = process;
		let output = '';
		const decoder = new TextDecoder();
		const stderrDecoder = new TextDecoder();
		const subscriptions = [
			process.stdout!.onData(data => { output += decoder.decode(data, { stream: true }); }),
			process.stderr!.onData(data => {
				this.writeEmitter.fire(stderrDecoder.decode(data, { stream: true }).replace(/\r?\n/g, '\r\n'));
			})
		];
		try {
			this.checkCanceled();
			const [code] = await Promise.all([
				process.run(),
				process.stdin!.write(`${JSON.stringify(request)}\n`)
			]);
			this.checkCanceled();
			output += decoder.decode();
			const response = JSON.parse(output) as BuildResponse;
			if (response.ok === false && typeof response.message === 'string') {
				return response;
			}
			if (code !== 0 || response.ok !== true || !Array.isArray(response.bytes)
				|| !response.bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
				throw new Error(`Invalid compiler response (exit code ${code}).`);
			}
			return response;
		} catch (error) {
			await process.terminate().catch(() => undefined);
			throw error;
		} finally {
			for (const subscription of subscriptions) {
				subscription.dispose();
			}
			this.process = undefined;
		}
	}

	private async build(): Promise<void> {
		let input: Uri | undefined;
		try {
			if (!workspace.isTrusted) {
				throw new Error('Build tasks require a trusted workspace.');
			}
			const definition = this.definition;
			input = resolveUri(definition.input, this.folder);
			this.diagnostics.delete(input);
			const configuration = workspace.getConfiguration('mmlx', input);
			const format = definition.format ?? configuration.get<'both' | 'mdx' | 'vgm'>('build.format', 'both');
			const pdxPath = definition.pdx ?? configuration.get<string>('build.pdx', '');
			const configuredLoopCount = configuration.get<number>('build.loopCount', 0);
			const loopCount = definition.loopCount ?? (configuredLoopCount === 0 ? undefined : configuredLoopCount);
			if (format !== 'both' && format !== 'mdx' && format !== 'vgm') {
				throw new Error('Output format must be both, mdx, or vgm.');
			}
			const extension = path.posix.extname(input.path).toLowerCase();
			if (extension !== '.mml' && extension !== '.mdx') {
				throw new Error('Input must be an MML or MDX file.');
			}
			if (extension === '.mdx' && format === 'mdx') {
				throw new Error('MDX output requires MML input.');
			}
			const formats: ('mdx' | 'vgm')[] = format === 'both'
				? extension === '.mml' ? ['mdx', 'vgm'] : ['vgm'] : [format];
			const outputDirectory = configuration.get<string>('build.outputDirectory', 'build');
			const explicit = definition.output ? resolveUri(definition.output, this.folder) : undefined;
			const outputExtension = explicit ? path.posix.extname(explicit.path) : '';
			const basePath = explicit && ['.mdx', '.vgm'].includes(outputExtension.toLowerCase())
				? explicit.path.slice(0, -outputExtension.length) : explicit?.path;
			const outputs = formats.map(format => ({ format, uri: explicit
				? formats.length === 1 ? explicit : explicit.with({ path: `${basePath}.${format}` })
				: Uri.joinPath(resolveUri(outputDirectory, this.folder, Uri.joinPath(input!, '..')),
					`${path.posix.basename(input!.path).slice(0, -extension.length)}.${format}`) }));
			for (const output of outputs) {
				const sameFile = process.platform === 'win32'
					? output.uri.toString().toLowerCase() === input.toString().toLowerCase()
					: output.uri.toString() === input.toString();
				if (sameFile) {
					throw new Error('Output must not overwrite the input file.');
				}
			}
			this.status(extension === '.mml' ? 'Compiling' : 'Converting',
				`${this.displayPath(input)} [${formats.map(format => format.toUpperCase()).join(' + ')}]`);
			const request = {
				inputKind: extension === '.mml' ? 'mml' : 'mdx',
				format: formats[0],
				source: extension === '.mml' ? (await workspace.openTextDocument(input)).getText() : undefined,
				bytes: extension === '.mdx' ? Array.from(await workspace.fs.readFile(input)) : undefined,
				pdx: pdxPath ? Array.from(await workspace.fs.readFile(resolveUri(pdxPath, this.folder))) : undefined,
				adpcmMode: definition.adpcmMode ?? configuration.get<'through' | 'resample' | 'lpf'>('build.adpcmMode', 'through'),
				loopCount,
				maxTicks: definition.maxTicks ?? configuration.get<number>('build.maxTicks', 100000)
			};
			const wasmUri = Uri.joinPath(this.extensionUri,
				'server', 'target', 'wasm32-wasip1-threads', 'release', 'mmlx-build.wasm');
			const bytes = await workspace.fs.readFile(wasmUri);
			const module = await WebAssembly.compile(new Uint8Array(bytes).buffer);
			const results: { uri: Uri; bytes: number[] }[] = [];
			for (const output of outputs) {
				this.status(output.format === 'mdx' ? 'Emitting' : 'Converting',
					output.format === 'mdx' ? 'MDX'
						: `VGM [${loopCount === undefined ? 'native loop' : `${loopCount} playthrough(s)`}]`, '36');
				request.format = output.format;
				let response = await this.execute(module, request);
				if (!response.ok && response.pdxName && !pdxPath) {
					const pdx = await findPdx(input, response.pdxName);
					request.pdx = Array.from(await workspace.fs.readFile(pdx));
					this.status('Loading', `${this.displayPath(pdx)} [PDX]`, '36');
					response = await this.execute(module, request);
				}
				if (!response.ok) {
					throw new BuildFailure(response);
				}
				results.push({ uri: output.uri, bytes: response.bytes });
			}
			for (const result of results) {
				this.checkCanceled();
				await workspace.fs.createDirectory(Uri.joinPath(result.uri, '..'));
				this.checkCanceled();
				await workspace.fs.writeFile(result.uri, Uint8Array.from(result.bytes));
				const size = result.bytes.length < 1024 ? `${result.bytes.length} B`
					: result.bytes.length < 1024 * 1024 ? `${(result.bytes.length / 1024).toFixed(1)} KiB`
						: `${(result.bytes.length / (1024 * 1024)).toFixed(1)} MiB`;
				this.status('Writing', `${this.displayPath(result.uri)} (${size})`);
			}
			try {
				await commands.executeCommand('workbench.files.action.refreshFilesExplorer');
			} catch {
				this.status('Warning', 'Files saved, but Explorer could not be refreshed.', '33');
			}
			this.checkCanceled();
			this.status('Finished', `${results.length} output file(s) in ${this.elapsed()}s`);
			this.finish(0);
		} catch (error) {
			if (this.canceled) {
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			const range = error instanceof BuildFailure ? error.response.range : undefined;
			const selection = range
				? new Range(range[0][0], range[0][1], range[1][0], range[1][1]) : new Range(0, 0, 0, 0);
			if (input) {
				const location = `${input.fsPath}${range ? `:${selection.start.line + 1}:${selection.start.character + 1}` : ''}`;
				this.errorLink = { location, uri: input, range: selection };
				buildErrors.set(location, this.errorLinks(`${location}: error:`)[0]);
				if (buildErrors.size > 256) {
					const oldest = buildErrors.keys().next().value;
					if (oldest !== undefined) { buildErrors.delete(oldest); }
				}
				this.write(`${location}: \x1b[1;31merror\x1b[0m: ${message}`);
				const diagnostic = new Diagnostic(selection, message, DiagnosticSeverity.Error);
				diagnostic.source = 'mmlx build';
				this.diagnostics.set(input, [diagnostic]);
			} else {
				this.status('error', message, '31');
			}
			this.status('Failed', `Build failed after ${this.elapsed()}s`, '31');
			this.finish(1);
		}
	}
}

export const buildErrorLinkProvider: TerminalLinkProvider<BuildErrorLink> = {
	provideTerminalLinks: context => {
		for (const [location, link] of buildErrors) {
			if (context.line.startsWith(`${location}: error:`)) { return [link]; }
		}
		return [];
	},
	handleTerminalLink: async link => {
		await window.showTextDocument(link.uri, { selection: link.range, preview: true });
	}
};

export function registerBuildTasks(context: ExtensionContext, wasm: Wasm): void {
	const diagnostics = languages.createDiagnosticCollection('mmlx build');
	const running = new Set<BuildTerminal>();
	const saved = new Map<string, SaveBuildState>();
	let disposed = false;
	function scheduleSave(document: TextDocument): void {
		if (disposed || !workspace.isTrusted || document.isUntitled
			|| path.posix.extname(document.uri.path).toLowerCase() !== '.mml'
			|| !workspace.getConfiguration('mmlx', document).get<boolean>('build.onSave', false)) {
			return;
		}
		const key = document.uri.toString();
		const existing = saved.get(key);
		if (existing?.starting || existing?.execution) {
			if (existing.version !== document.version) { existing.pending = true; }
			return;
		}
		if (existing?.timer) { clearTimeout(existing.timer); }
		const state: SaveBuildState = { document, version: document.version, starting: false, pending: false };
		saved.set(key, state);
		state.timer = setTimeout(() => {
			state.timer = undefined;
			if (disposed || document.isClosed || !workspace.getConfiguration('mmlx', document).get<boolean>('build.onSave', false)) {
				saved.delete(key);
				return;
			}
			state.starting = true;
			state.version = document.version;
			const task = createTask({ type: 'mmlx', input: key }, workspace.getWorkspaceFolder(document.uri));
			task.presentationOptions = { ...task.presentationOptions, reveal: TaskRevealKind.Silent, focus: false };
			void tasks.executeTask(task).then(execution => {
				state.execution = execution;
				state.starting = false;
				if (disposed) { execution.terminate(); }
			}, error => {
				saved.delete(key);
				void window.showErrorMessage(`mmlx build on save failed: ${String(error)}`);
			});
		}, 200);
	}
	function createTask(definition: BuildDefinition, folder?: WorkspaceFolder): Task {
		const task = new Task(definition, folder ?? TaskScope.Global,
			definition.format ? `Build ${String(definition.format).toUpperCase()}` : 'Build', 'mmlx', new CustomExecution(async resolvedDefinition => {
				const terminal = new BuildTerminal(context.extensionUri, wasm, resolvedDefinition as BuildDefinition,
					folder, diagnostics, () => running.delete(terminal));
				running.add(terminal);
				return terminal;
			}));
		task.group = TaskGroup.Build;
		task.detail = definition.format === 'mdx' ? 'MML to MDX'
			: definition.format === 'vgm' ? 'MML or MDX to VGM' : 'Build using mmlx.build.format (default: MDX and VGM)';
		task.presentationOptions = { reveal: TaskRevealKind.Always, panel: TaskPanelKind.Dedicated, clear: true };
		return task;
	}
	context.subscriptions.push(diagnostics, window.registerTerminalLinkProvider(buildErrorLinkProvider), tasks.registerTaskProvider('mmlx', {
		provideTasks: () => (workspace.workspaceFolders ?? []).flatMap(folder => [
			createTask({ type: 'mmlx', input: '${file}' }, folder),
			...(['mdx', 'vgm'] as const).map(format => createTask({ type: 'mmlx', input: '${file}', format }, folder))
		]),
		resolveTask: task => {
			if (task.definition.type !== 'mmlx') {
				return undefined;
			}
			const resolved = createTask(task.definition as BuildDefinition,
				typeof task.scope === 'object' ? task.scope : undefined);
			resolved.name = task.name;
			resolved.group = task.group ?? TaskGroup.Build;
			resolved.presentationOptions = task.presentationOptions;
			resolved.problemMatchers = task.problemMatchers;
			return resolved;
		}
	}), workspace.onDidSaveTextDocument(scheduleSave), tasks.onDidStartTask(event => {
		if (event.execution.task.definition.type !== 'mmlx') { return; }
		const value = event.execution.task.definition.input;
		if (typeof value !== 'string') { return; }
		const folder = typeof event.execution.task.scope === 'object' ? event.execution.task.scope : undefined;
		const input = value === '${file}' ? window.activeTextEditor?.document.uri
			: value?.includes('${') ? undefined : resolveUri(value, folder);
		if (!input) { return; }
		const key = input.toString();
		const state = saved.get(key);
		if (state) {
			if (state.timer) { clearTimeout(state.timer); }
			state.timer = undefined;
			state.version = state.document.version;
			state.execution = event.execution;
			state.starting = false;
		} else {
			const document = workspace.textDocuments.find(document => document.uri.toString() === key);
			if (document) {
				saved.set(key, { document, version: document.version, execution: event.execution,
					starting: false, pending: false });
			}
		}
	}), tasks.onDidEndTask(event => {
		for (const [key, state] of saved) {
			if (state.execution !== event.execution) { continue; }
			saved.delete(key);
			if (state.pending) { scheduleSave(state.document); }
		}
	}), { dispose: () => {
		disposed = true;
		buildErrors.clear();
		for (const state of saved.values()) {
			if (state.timer) { clearTimeout(state.timer); }
			state.execution?.terminate();
		}
		saved.clear();
		for (const terminal of running) { terminal.close(); }
	} });
	for (const [command, format] of [['mmlx.build', undefined], ['mmlx.buildMdx', 'mdx'], ['mmlx.buildVgm', 'vgm']] as const) {
		context.subscriptions.push(commands.registerCommand(command, async () => {
			const document = window.activeTextEditor?.document;
			if (!document || document.isUntitled) {
				await window.showErrorMessage('Open a saved MML or MDX file to build.');
				return;
			}
			await tasks.executeTask(createTask({ type: 'mmlx', input: document.uri.toString(), format },
				workspace.getWorkspaceFolder(document.uri)));
		}));
	}
}