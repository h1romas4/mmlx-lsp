import {
	StatusBarAlignment, window, workspace,
	type ExtensionContext, type OutputChannel, type TextEditor
} from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

interface TrackLength {
	channel?: string;
	ticks: number;
	looping: boolean;
}

export function registerTrackLengthStatus(
	context: ExtensionContext,
	getClient: () => LanguageClient | undefined,
	output: OutputChannel
): void {
	const status = window.createStatusBarItem(StatusBarAlignment.Right, 1001);
	status.name = 'mmlx track length';
	status.tooltip = 'Playback ticks at the cursor position or across the selected range.';
	let sequence = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const update = (editor: TextEditor | undefined): void => {
		sequence++;
		const requestSequence = sequence;
		if (timer) { clearTimeout(timer); }
		if (!editor || editor.document.languageId !== 'mmlx') {
			status.hide();
			return;
		}
		timer = setTimeout(() => {
			void requestLength(editor, requestSequence);
		}, 50);
	};

	const requestLength = async (editor: TextEditor, requestSequence: number): Promise<void> => {
		const client = getClient();
		if (!client?.isRunning()) { status.hide(); return; }
		const document = editor.document;
		const version = document.version;
		const selection = editor.selection;
		try {
			let result: TrackLength | null;
			if (selection.isEmpty) {
				result = await client.sendRequest<TrackLength | null>(
					'mmlx/trackLengthAtPosition',
					client.code2ProtocolConverter.asTextDocumentPositionParams(document, selection.active)
				);
			} else {
				const start = client.code2ProtocolConverter.asTextDocumentPositionParams(document, selection.start);
				const end = client.code2ProtocolConverter.asTextDocumentPositionParams(document, selection.end);
				result = await client.sendRequest<TrackLength | null>('mmlx/trackLengthInRange', {
					textDocument: start.textDocument,
					range: { start: start.position, end: end.position }
				});
			}
			if (requestSequence !== sequence || document.version !== version
				|| document.isClosed
				|| window.activeTextEditor?.document.uri.toString() !== document.uri.toString()) {
				return;
			}
			if (!result || !Number.isSafeInteger(result.ticks) || result.ticks < 0
				|| (selection.isEmpty && typeof result.channel !== 'string')) {
				status.hide();
				return;
			}
			const loop = result.looping ? ' (loop)' : '';
			status.text = selection.isEmpty
				? `$(music) ${result.channel}: ${result.ticks.toLocaleString()} ticks${loop}`
				: `$(music) Selection: ${result.ticks.toLocaleString()} ticks${loop}`;
			status.show();
		} catch (error) {
			if (requestSequence === sequence) {
				status.hide();
				output.appendLine(`Could not determine MML track length: ${String(error)}`);
			}
		}
	};

	context.subscriptions.push(
		status,
		window.onDidChangeActiveTextEditor(update),
		window.onDidChangeTextEditorSelection(event => update(event.textEditor)),
		workspace.onDidChangeTextDocument(event => {
			const editor = window.activeTextEditor;
			if (editor?.document === event.document) { update(editor); }
		}),
		{ dispose: () => { if (timer) { clearTimeout(timer); } } }
	);
	update(window.activeTextEditor);
}
