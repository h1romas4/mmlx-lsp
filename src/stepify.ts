import { commands, EndOfLine, ExtensionContext, WorkspaceEdit, window, workspace } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

export function registerStepifySelectionCommand(
	context: ExtensionContext,
	getClient: () => LanguageClient | undefined
): void {
	context.subscriptions.push(commands.registerCommand('mmlx.stepifySelection', async () => {
		const editor = window.activeTextEditor;
		if (!editor || editor.document.languageId !== 'mmlx') { return; }
		const selection = editor.selection;
		if (selection.isEmpty) {
			void window.showInformationMessage('Select MML to stepify.');
			return;
		}

		const document = editor.document;
		const version = document.version;
		const source = document.getText(selection);
		try {
			const client = getClient();
			if (!client?.isRunning()) { throw new Error('mmlx language server is not running.'); }
			const result = await client.sendRequest<string>('mmlx/stepifySelection', { source });
			if (typeof result !== 'string' || !result.trim()) { throw new Error('The selected MML produced no step sequence.'); }
			if (window.activeTextEditor !== editor || editor.document !== document || document.version !== version
				|| !editor.selection.isEqual(selection)) {
				void window.showWarningMessage('Stepify was canceled because the document or selection changed.');
				return;
			}

			const newline = document.eol === EndOfLine.CRLF ? '\r\n' : '\n';
			const edit = new WorkspaceEdit();
			edit.replace(document.uri, selection, result.replace(/\n/g, newline));
			if (!await workspace.applyEdit(edit)) { throw new Error('The selection replacement was not applied.'); }
		} catch (error) {
			void window.showErrorMessage(`Could not stepify the MML selection: ${error instanceof Error ? error.message : String(error)}`);
		}
	}));
}
