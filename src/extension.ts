import { commands, ExtensionContext, Location, Position, Range, Uri, window, workspace } from 'vscode';
import { LanguageClient, ServerOptions } from 'vscode-languageclient/node';
import { Wasm } from '@vscode/wasm-wasi/v1';
import { createStdioOptions, createUriConverters, startServer } from '@vscode/wasm-wasi-lsp';
import { registerBuildTasks } from './tasks';
import { registerMcpServerProvider } from './mcpServer';
import { registerTrackLengthStatus } from './trackLengthStatus';
import { registerVoiceView, type VoiceViewProvider } from './voiceView';

let client: LanguageClient | undefined;
let voiceView: VoiceViewProvider | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
	const channel = window.createOutputChannel('mmlx Language Server', { log: true });
	const playbackLog = window.createOutputChannel('mmlx');
	context.subscriptions.push(channel, playbackLog);
	channel.appendLine('Activating mmlx language support.');
	const wasm = await Wasm.load();
	channel.appendLine('WASI runtime loaded.');
	registerBuildTasks(context, wasm);
	const mcpServer = registerMcpServerProvider(context, wasm, channel);
	if (!mcpServer) {
		channel.appendLine('MCP server providers are not supported by this VS Code version.');
	}

	const serverOptions: ServerOptions = async () => {
		channel.appendLine('Starting WASM language server.');
		const uri = Uri.joinPath(context.extensionUri,
			'server', 'target', 'wasm32-wasip1-threads', 'release', 'mmlx-lsp-server.wasm');
		const bytes = await workspace.fs.readFile(uri);
		const module = await WebAssembly.compile(new Uint8Array(bytes).buffer);
		const process = await wasm.createProcess('mmlx-lsp-server', module,
			{ initial: 160, maximum: 2048, shared: true }, {
				stdio: createStdioOptions(),
				mountPoints: [{ kind: 'workspaceFolder' }]
			});
		const decoder = new TextDecoder('utf-8');
		process.stderr!.onData(data => channel.append(decoder.decode(data, { stream: true })));
		return startServer(process);
	};

	client = new LanguageClient('mmlx', 'mmlx Language Server', serverOptions, {
		documentSelector: [{ language: 'mmlx' }],
		outputChannel: channel,
		uriConverters: createUriConverters(),
		initializationOptions: () => {
			const configuration = workspace.getConfiguration('mmlx');
			return {
				dialect: configuration.get<string>('dialect', 'mdx'),
				language: configuration.get<string>('language', 'auto')
			};
		},
		middleware: {
			provideSignatureHelp: async (document, position, context, token, next) => {
				const version = document.version;
				const help = await next(document, position, context, token);
				const editor = window.activeTextEditor;
				if (help?.signatures.length && !token.isCancellationRequested
					&& document.version === version
					&& editor?.document.uri.toString() === document.uri.toString()
					&& editor.selection.active.isEqual(position)) {
					await commands.executeCommand('hideSuggestWidget');
				}
				return help;
			}
		}
	});
	await client.start();
	registerTrackLengthStatus(context, () => client, channel);
	voiceView = registerVoiceView(context, () => client, wasm, playbackLog, mcpServer);
	context.subscriptions.push(commands.registerCommand('mmlx.showVoiceReferences', async (
		documentUri: string | { scheme: string; authority?: string; path?: string; query?: string; fragment?: string },
		position: { line: number; character: number },
		references: {
			uri: string | { scheme: string; authority?: string; path?: string; query?: string; fragment?: string };
			range: {
				start: { line: number; character: number };
				end: { line: number; character: number };
			};
		}[]
	) => {
		const languageClient = client;
		if (!languageClient?.isRunning()) { throw new Error('mmlx language server is not running.'); }
		const toUri = (value: typeof documentUri): Uri => languageClient.protocol2CodeConverter.asUri(
			typeof value === 'string' ? value : Uri.from({
				scheme: value.scheme,
				authority: value.authority ?? '',
				path: value.path ?? '',
				query: value.query ?? '',
				fragment: value.fragment ?? ''
			}).toString()
		);
		const locations = references.map(reference => new Location(
			toUri(reference.uri),
			new Range(
				new Position(reference.range.start.line, reference.range.start.character),
				new Position(reference.range.end.line, reference.range.end.character)
			)
		));
		await commands.executeCommand(
			'editor.action.showReferences',
			toUri(documentUri),
			new Position(position.line, position.character),
			locations
		);
	}));
	context.subscriptions.push(commands.registerCommand('mmlx.toggleComment', async () => {
		const editor = window.activeTextEditor;
		if (!editor || editor.document.languageId !== 'mmlx') { return; }
		const hasSelection = editor.selections.some(selection => !selection.isEmpty);
		const hasMultilineSelection = editor.selections.some(selection => selection.start.line !== selection.end.line);
		const command = hasSelection && !hasMultilineSelection
			? 'editor.action.blockComment'
			: 'editor.action.commentLine';
		await commands.executeCommand(command);
	}));
	context.subscriptions.push(commands.registerCommand('mmlx.restartLanguageServer', async () => {
		await client?.stop();
		await client?.start();
	}));
	channel.appendLine('Language server initialized.');
}

export async function deactivate(): Promise<void> {
	await voiceView?.disconnectNanoDrive();
	voiceView = undefined;
	await client?.stop();
	client = undefined;
}
