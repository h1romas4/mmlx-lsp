import { commands, ExtensionContext, Uri, window, workspace } from 'vscode';
import { LanguageClient, ServerOptions } from 'vscode-languageclient/node';
import { Wasm } from '@vscode/wasm-wasi/v1';
import { createStdioOptions, createUriConverters, startServer } from '@vscode/wasm-wasi-lsp';
import { registerBuildTasks } from './tasks';
import { registerVoiceView } from './voiceView';

let client: LanguageClient | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
	const channel = window.createOutputChannel('mmlx Language Server', { log: true });
	context.subscriptions.push(channel);
	channel.appendLine('Activating mmlx language support.');
	const wasm = await Wasm.load();
	channel.appendLine('WASI runtime loaded.');
	registerBuildTasks(context, wasm);

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
	registerVoiceView(context, () => client, wasm);
	context.subscriptions.push(commands.registerCommand('mmlx.restartLanguageServer', async () => {
		await client?.stop();
		await client?.start();
	}));
	channel.appendLine('Language server initialized.');
}

export async function deactivate(): Promise<void> {
	await client?.stop();
	client = undefined;
}
