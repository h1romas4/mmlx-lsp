import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
	EventEmitter, McpHttpServerDefinition, Uri, lm,
	type CancellationToken, type Disposable, type ExtensionContext, type McpServerDefinitionProvider, type OutputChannel
} from 'vscode';
import type { Readable, Wasm, WasmProcess, Writable } from '@vscode/wasm-wasi/v1';

const serverId = 'mmlx-lsp.mcp';
const serverLabel = 'mmlx';
const mcpWasmPath = ['server', 'target', 'wasm32-wasip1-threads', 'release', 'mmlx-mcp-server.wasm'];
const maxRequestBytes = 48 * 1024 * 1024;
const requestTimeoutMs = 30000;

interface JsonRpcMessage {
	jsonrpc: '2.0';
	id?: string | number | null;
	method?: string;
	[key: string]: unknown;
}

interface PendingResponse {
	resolve(message: JsonRpcMessage): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

class HttpRequestError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

export function isMcpServerProviderAvailable(): boolean {
	return typeof lm?.registerMcpServerDefinitionProvider === 'function'
		&& typeof McpHttpServerDefinition === 'function';
}

export interface McpServerController {
	readonly enabled: boolean;
	setEnabled(enabled: boolean): void;
}

export function registerMcpServerProvider(
	context: ExtensionContext,
	wasm: Wasm,
	output: OutputChannel
): McpServerController | undefined {
	if (!isMcpServerProviderAvailable()) { return undefined; }
	const provider = new MmlxMcpServerProvider(context, wasm, output);
	context.subscriptions.push(provider, lm.registerMcpServerDefinitionProvider(serverId, provider));
	return provider;
}

class MmlxMcpServerProvider implements McpServerDefinitionProvider<McpHttpServerDefinition>, Disposable, McpServerController {
	private readonly definitionsChanged = new EventEmitter<void>();
	private module: Promise<WebAssembly.Module> | undefined;
	private bridge: Promise<WasiMcpHttpBridge> | undefined;
	private enabledState = false;
	readonly onDidChangeMcpServerDefinitions = this.definitionsChanged.event;

	constructor(
		private readonly context: ExtensionContext,
		private readonly wasm: Wasm,
		private readonly output: OutputChannel
	) {}

	get enabled(): boolean {
		return this.enabledState;
	}

	setEnabled(enabled: boolean): void {
		if (enabled === this.enabledState) { return; }
		this.enabledState = enabled;
		this.definitionsChanged.fire();
		if (!enabled) { void this.stopBridge(); }
	}

	async provideMcpServerDefinitions(token: CancellationToken): Promise<McpHttpServerDefinition[]> {
		if (token.isCancellationRequested || !this.enabledState) { return []; }
		let bridge: WasiMcpHttpBridge;
		try {
			bridge = await this.getBridge();
		} catch (error) {
			this.output.appendLine(`MCP server startup failed: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
		if (token.isCancellationRequested || !this.enabledState) {
			await this.stopBridge();
			return [];
		}
		return [new McpHttpServerDefinition(serverLabel, bridge.uri, bridge.headers, this.context.extension.packageJSON.version)];
	}

	dispose(): void {
		this.enabledState = false;
		this.definitionsChanged.dispose();
		void this.stopBridge();
	}

	private async getBridge(): Promise<WasiMcpHttpBridge> {
		if (!this.module) {
			this.module = this.wasm.compile(Uri.joinPath(this.context.extensionUri, ...mcpWasmPath));
		}
		this.bridge ??= this.module.then(module => WasiMcpHttpBridge.start(this.wasm, module, this.output))
			.catch(error => { this.bridge = undefined; throw error; });
		const pending = this.bridge;
		const bridge = await pending;
		if (bridge.isStopped) {
			if (this.bridge === pending) { this.bridge = undefined; }
			await bridge.disposeAsync();
			throw new Error('The WASI MCP process exited before it could serve requests.');
		}
		return bridge;
	}

	private async stopBridge(): Promise<void> {
		const bridge = this.bridge;
		this.bridge = undefined;
		if (!bridge) { return; }
		try {
			await (await bridge).disposeAsync();
		} catch (error) {
			this.output.appendLine(`MCP server shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

export class WasiMcpHttpBridge implements Disposable {
	readonly headers = { Authorization: `Bearer ${randomBytes(32).toString('hex')}` };
	private address: Uri | undefined;
	private readonly httpServer: Server;
	private readonly pending = new Map<string, PendingResponse>();
	private readonly subscriptions: Disposable[] = [];
	private readonly decoder = new TextDecoder();
	private outputBuffer = '';
	private writeQueue: Promise<void> = Promise.resolve();
	private runPromise: Promise<void> | undefined;
	private stopping: Promise<void> | undefined;
	private stopped = false;
	private processEnded = false;

	get isStopped(): boolean {
		return this.stopped;
	}

	get uri(): Uri {
		if (!this.address) { throw new Error('MCP bridge is not listening.'); }
		return this.address;
	}

	private constructor(
		private readonly process: WasmProcess,
		private readonly stdin: Writable,
		stdout: Readable,
		stderr: Readable,
		private readonly output: OutputChannel
	) {
		this.httpServer = createServer((request, response) => {
			void this.handleHttpRequest(request, response).catch(error => {
				if (!response.writableEnded) {
					const status = error instanceof HttpRequestError ? error.status : 500;
					response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
					response.end(error instanceof Error ? error.message : 'MCP bridge request failed.');
				}
				this.output.appendLine(`MCP bridge request failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		});
		this.subscriptions.push(
			stdout.onData(chunk => this.readOutput(chunk)),
			stderr.onData(chunk => this.output.appendLine(new TextDecoder().decode(chunk)))
		);
		stdout.resume();
		stderr.resume();
	}

	static async start(wasm: Wasm, module: WebAssembly.Module, output: OutputChannel): Promise<WasiMcpHttpBridge> {
		const process = await wasm.createProcess('mmlx-mcp-server', module, {
			initial: 160,
			maximum: 2048,
			shared: true
		}, {
			stdio: {
				in: { kind: 'pipeIn' },
				out: { kind: 'pipeOut' },
				err: { kind: 'pipeOut' }
			}
		});
		if (!process.stdin || !process.stdout || !process.stderr) {
			await process.terminate();
			throw new Error('The WASI MCP process did not provide all required stdio streams.');
		}
		const bridge = new WasiMcpHttpBridge(process, process.stdin, process.stdout, process.stderr, output);
		try {
			await bridge.listen();
			bridge.runPromise = process.run().then(code => {
				bridge.processExited(`WASI MCP process exited with code ${code}.`);
			}, error => {
				bridge.processExited(`WASI MCP process failed: ${error instanceof Error ? error.message : String(error)}`);
			});
			return bridge;
		} catch (error) {
			await bridge.disposeAsync();
			throw error;
		}
	}

	dispose(): void {
		void this.disposeAsync().catch(error => {
			this.output.appendLine(`MCP bridge shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	async disposeAsync(): Promise<void> {
		this.stopping ??= this.stop();
		return this.stopping;
	}

	private async listen(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				this.httpServer.off('listening', onListening);
				reject(error);
			};
			const onListening = () => {
				this.httpServer.off('error', onError);
				resolve();
			};
			this.httpServer.once('error', onError);
			this.httpServer.once('listening', onListening);
			this.httpServer.listen(0, '127.0.0.1');
		});
		const address = this.httpServer.address();
		if (!address || typeof address === 'string') { throw new Error('Could not determine the MCP bridge address.'); }
		this.address = Uri.parse(`http://127.0.0.1:${address.port}/mcp`);
	}

	private async stop(): Promise<void> {
		this.stopped = true;
		this.rejectPending(new Error('MCP server is shutting down.'));
		if (this.httpServer.listening) {
			const closed = new Promise<void>((resolve, reject) => {
				this.httpServer.close(error => error ? reject(error) : resolve());
			});
			this.httpServer.closeAllConnections();
			await closed;
		}
		if (!this.processEnded) {
			await this.process.terminate();
		}
		await this.runPromise;
		for (const subscription of this.subscriptions) { subscription.dispose(); }
	}

	private processExited(message: string): void {
		this.processEnded = true;
		if (this.stopped) { return; }
		this.stopped = true;
		this.output.appendLine(message);
		this.rejectPending(new Error(message));
		if (this.httpServer.listening) {
			this.httpServer.closeAllConnections();
			this.httpServer.close(error => {
				if (error) { this.output.appendLine(`MCP bridge close failed: ${error.message}`); }
			});
		}
	}

	private rejectPending(error: Error): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			this.pending.delete(id);
			pending.reject(error);
		}
	}

	private readOutput(chunk: Uint8Array): void {
		this.outputBuffer += this.decoder.decode(chunk, { stream: true });
		let newline: number;
		while ((newline = this.outputBuffer.indexOf('\n')) >= 0) {
			const line = this.outputBuffer.slice(0, newline).trim();
			this.outputBuffer = this.outputBuffer.slice(newline + 1);
			if (line) { this.dispatchMessage(line); }
		}
	}

	private dispatchMessage(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			this.output.appendLine('WASI MCP server wrote invalid JSON to stdout.');
			return;
		}
		if (!message || typeof message !== 'object' || !Object.hasOwn(message, 'id')) { return; }
		const id = (message as JsonRpcMessage).id;
		const key = this.responseKey(id);
		if (!key) { return; }
		this.output.appendLine(`MCP response received for id ${key}.`);
		const pending = this.pending.get(key);
		if (!pending) { return; }
		clearTimeout(pending.timer);
		this.pending.delete(key);
		pending.resolve(message as JsonRpcMessage);
	}

	private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.headers.authorization !== this.headers.Authorization) {
			response.writeHead(401).end();
			return;
		}
		if (request.method !== 'POST' || new URL(request.url ?? '/', this.uri.toString()).pathname !== '/mcp') {
			response.writeHead(405, { allow: 'POST' }).end();
			return;
		}
		if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
			response.writeHead(415).end();
			return;
		}
		const message = await this.readRequest(request);
		if (this.stopped) {
			response.writeHead(503).end();
			return;
		}
		if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
			throw new HttpRequestError(400, 'Invalid JSON-RPC request.');
		}
		this.output.appendLine(`MCP request received: ${message.method}.`);
		const hasId = Object.hasOwn(message, 'id');
		if (!hasId) {
			await this.writeMessage(message);
			response.writeHead(202).end();
			return;
		}
		const id = this.responseKey(message.id);
		if (!id) { throw new HttpRequestError(400, 'Invalid JSON-RPC request id.'); }
		if (this.pending.has(id)) { throw new HttpRequestError(409, 'A request with this id is already pending.'); }
		const result = await this.sendRequest(message, id, request);
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify(result));
	}

	private async readRequest(request: IncomingMessage): Promise<JsonRpcMessage> {
		const chunks: Buffer[] = [];
		let length = 0;
		for await (const chunk of request) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			length += bytes.byteLength;
			if (length > maxRequestBytes) { throw new HttpRequestError(413, 'MCP request is too large.'); }
			chunks.push(bytes);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		} catch {
			throw new HttpRequestError(400, 'MCP request must contain valid JSON.');
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new HttpRequestError(400, 'MCP request must be a JSON-RPC object.');
		}
		return parsed as JsonRpcMessage;
	}

	private async sendRequest(message: JsonRpcMessage, id: string, request: IncomingMessage): Promise<JsonRpcMessage> {
		let pending: PendingResponse | undefined;
		const result = new Promise<JsonRpcMessage>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new HttpRequestError(504, 'MCP request timed out.'));
			}, requestTimeoutMs);
			pending = { resolve, reject, timer };
			this.pending.set(id, pending);
		});
		const abort = () => {
			if (pending && this.pending.get(id) === pending) {
				clearTimeout(pending.timer);
				this.pending.delete(id);
				pending.reject(new HttpRequestError(499, 'MCP request was cancelled.'));
			}
		};
		request.once('aborted', abort);
		try {
			await this.writeMessage(message);
			return await result;
		} catch (error) {
			abort();
			throw error;
		} finally {
			request.off('aborted', abort);
			if (pending && this.pending.get(id) === pending) {
				clearTimeout(pending.timer);
				this.pending.delete(id);
			}
		}
	}

	private writeMessage(message: JsonRpcMessage): Promise<void> {
		const operation = this.writeQueue.then(() => this.stdin.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`)));
		this.writeQueue = operation.catch(() => undefined);
		return operation;
	}

	private responseKey(id: unknown): string | undefined {
		return typeof id === 'string' || typeof id === 'number' || id === null ? JSON.stringify(id) : undefined;
	}
}
