import {
	Hover, MarkdownString, Position, Range, languages, window,
	type CancellationToken, type ExtensionContext, type OutputChannel, type TextDocument
} from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

interface TrackLength {
	channel?: string;
	ticks: number;
	looping: boolean;
}

export function registerTrackLengthHover(
	context: ExtensionContext,
	getClient: () => LanguageClient | undefined,
	output: OutputChannel
): void {
	context.subscriptions.push(languages.registerHoverProvider(
		{ language: 'mmlx' },
		{
			provideHover: async (document, position, token) => {
				const client = getClient();
				if (!client?.isRunning() || document.isClosed) { return undefined; }

				const editor = window.activeTextEditor;
				const selection = editor?.document.uri.toString() === document.uri.toString()
					? editor.selection : undefined;
				const selectedRange = selection && !selection.isEmpty
					&& (selection.contains(position) || selection.end.isEqual(position))
					? selection : undefined;
				const version = document.version;

				try {
					const result = selectedRange
						? await requestRange(client, document, selectedRange, token)
						: await requestPosition(client, document, position, token);
					if (token.isCancellationRequested || document.version !== version || document.isClosed
						|| !result || !Number.isSafeInteger(result.ticks) || result.ticks < 0
						|| typeof result.looping !== 'boolean'
						|| (!selectedRange && typeof result.channel !== 'string')) {
						return undefined;
					}

					const loop = result.looping ? ' (loop)' : '';
					const label = selectedRange
						? `Selection: ${result.ticks.toLocaleString()} ticks${loop}`
						: `${result.channel}: ${result.ticks.toLocaleString()} ticks${loop}`;
					const content = new MarkdownString(`**MML playback length**  \n${label}`);
					return new Hover(content);
				} catch (error) {
					if (!token.isCancellationRequested) {
						output.appendLine(`Could not determine MML track length: ${String(error)}`);
					}
					return undefined;
				}
			}
		}
	));
}

function requestPosition(
	client: LanguageClient,
	document: TextDocument,
	position: Position,
	token: CancellationToken
): Promise<TrackLength | null> {
	return client.sendRequest<TrackLength | null>(
		'mmlx/trackLengthAtPosition',
		client.code2ProtocolConverter.asTextDocumentPositionParams(document, position),
		token
	);
}

function requestRange(
	client: LanguageClient,
	document: TextDocument,
	range: Range,
	token: CancellationToken
): Promise<TrackLength | null> {
	const start = client.code2ProtocolConverter.asTextDocumentPositionParams(document, range.start);
	const end = client.code2ProtocolConverter.asTextDocumentPositionParams(document, range.end);
	return client.sendRequest<TrackLength | null>('mmlx/trackLengthInRange', {
		textDocument: start.textDocument,
		range: { start: start.position, end: end.position }
	}, token);
}
