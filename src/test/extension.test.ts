import * as assert from 'assert';
import * as vscode from 'vscode';

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
	test('registers the MML language', async () => {
		assert.ok((await vscode.languages.getLanguages()).includes('mmlx'));
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
		assert.ok(legend.tokenTypes.includes('function'));
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
		assert.ok(gate.documentation.value.includes('soundlog'));
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
		assert.ok(!(suppressed?.items ?? []).some(item => item.documentation instanceof vscode.MarkdownString && item.documentation.value.includes('soundlog')));
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
		assert.ok(tempo.documentation.value.includes('全トラック共通のテンポを変更します。'));
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
			assert.ok(help.signatures[0].documentation.value.includes('soundlog'));
			const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
				'vscode.executeCompletionItemProvider', document.uri, document.positionAt(source.length));
			assert.ok(!(completions?.items ?? []).some(item => item.documentation instanceof vscode.MarkdownString && item.documentation.value.includes('soundlog')));
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
});
