import { randomBytes } from 'node:crypto';
import {
	Uri, window, workspace, type CancellationToken, type CustomDocument, type CustomDocumentOpenContext,
	type CustomReadonlyEditorProvider, type ExtensionContext, type WebviewPanel
} from 'vscode';

export const mdxEditorViewType = 'mmlx.mdxBinaryEditor';
const bytesPerPage = 512;
const mdxHeaderTerminator = [0x0d, 0x0a, 0x1a];

class MdxBinaryDocument implements CustomDocument {
	constructor(readonly uri: Uri, readonly bytes: Uint8Array) {}
	dispose(): void {}
}

export function registerMdxEditor(context: ExtensionContext, onActive: (uri: Uri | undefined) => void): void {
	const panels = new Map<WebviewPanel, MdxBinaryDocument>();
	const updateActive = () => onActive([...panels].find(([panel]) => panel.active)?.[1].uri);
	const provider: CustomReadonlyEditorProvider<MdxBinaryDocument> = {
		openCustomDocument: async (uri: Uri, _openContext: CustomDocumentOpenContext, _token: CancellationToken) =>
			new MdxBinaryDocument(uri, await workspace.fs.readFile(uri)),
		resolveCustomEditor: (document, panel) => {
			panels.set(panel, document);
			panel.webview.options = { enableScripts: true };
			panel.webview.html = createHtml(panel.webview.cspSource, document.uri, document.bytes);
			panel.webview.onDidReceiveMessage(message => {
				if (message?.type === 'ready') {
					void panel.webview.postMessage({ type: 'fontSize', value: getEditorFontSize() });
					return;
				}
				if (message?.type !== 'readRange' || !Number.isSafeInteger(message.offset) || message.offset < 0) { return; }
				const offset = Math.min(message.offset, document.bytes.length);
				const end = Math.min(offset + bytesPerPage, document.bytes.length);
				void panel.webview.postMessage({
					type: 'page',
					offset,
					total: document.bytes.length,
					bytes: Array.from(document.bytes.subarray(offset, end))
				});
			});
			panel.onDidChangeViewState(updateActive);
			panel.onDidDispose(() => { panels.delete(panel); updateActive(); });
			updateActive();
		}
	};
	context.subscriptions.push(workspace.onDidChangeConfiguration(event => {
		if (!event.affectsConfiguration('editor.fontSize')) { return; }
		for (const panel of panels.keys()) {
			void panel.webview.postMessage({ type: 'fontSize', value: getEditorFontSize() });
		}
	}));
	context.subscriptions.push(window.registerCustomEditorProvider(mdxEditorViewType, provider, {
		webviewOptions: { retainContextWhenHidden: true }
	}));
}

function getEditorFontSize(): number {
	return workspace.getConfiguration('editor').get<number>('fontSize', 14);
}

function createHtml(cspSource: string, uri: Uri, bytes: Uint8Array): string {
	const nonce = randomBytes(16).toString('hex');
	const title = escapeHtml(uri.path.split('/').at(-1) ?? 'MDX');
	const metadata = parseMdxMetadata(bytes);
	const metadataHtml = metadata
		? `<dl class="track-metadata"><dt>Title</dt><dd>${escapeHtml(metadata.title || '—')}</dd><dt>PDX</dt><dd>${escapeHtml(metadata.pdxName || '—')}</dd></dl>`
		: '<p class="metadata-error">MDX header metadata unavailable</p>';
	const total = bytes.length;
	return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style nonce="${nonce}">
:root{--mdx-editor-font-size:${getEditorFontSize()}px}
body{padding:16px;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}
h1{font-size:1.3em;margin:0 0 8px}.meta{color:var(--vscode-descriptionForeground);margin:0 0 14px}
.track-metadata{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 12px;margin:0 0 10px}.track-metadata dt{color:var(--vscode-descriptionForeground)}.track-metadata dd{margin:0;overflow-wrap:anywhere}
.metadata-error{color:var(--vscode-errorForeground);margin:0 0 10px}
.toolbar{display:flex;align-items:center;gap:8px;margin-bottom:10px}
button,input{font:var(--mdx-editor-font-size) var(--vscode-font-family);color:inherit;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);padding:4px}
button{cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
button:disabled{opacity:.5;cursor:default}input{width:110px;font-family:var(--vscode-editor-font-family)}
table{border-collapse:collapse;font:var(--mdx-editor-font-size) var(--vscode-editor-font-family,monospace);white-space:pre}
td{padding:2px 8px 2px 0}.offset{color:var(--vscode-descriptionForeground)}.hex{color:var(--vscode-editor-foreground)}.ascii{color:var(--vscode-descriptionForeground);padding-left:12px}
</style></head>
<body><h1>${title}</h1>${metadataHtml}<p class="meta" id="meta"></p>
<div class="toolbar"><button id="previous" type="button">Previous</button><button id="next" type="button">Next</button>
<label for="offset">Offset</label><input id="offset" type="number" min="0" step="16" value="0">
<span id="page"></span></div><table aria-label="MDX bytes"><tbody id="rows"></tbody></table>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();
const total=${total};const pageSize=${bytesPerPage};
window.addEventListener('message',event=>{const data=event.data;if(data?.type==='fontSize'&&Number.isFinite(data.value)&&data.value>0)
document.documentElement.style.setProperty('--mdx-editor-font-size',data.value+'px');});
const offsetInput=document.getElementById('offset');const rows=document.getElementById('rows');
const previous=document.getElementById('previous');const next=document.getElementById('next');
document.getElementById('meta').textContent=total.toLocaleString()+' bytes · Read-only binary view';
function read(offset){offset=Math.max(0,Math.min(total,Math.floor(offset/16)*16));offsetInput.value=String(offset);
vscode.postMessage({type:'readRange',offset});}
offsetInput.max=String(total);offsetInput.addEventListener('change',()=>read(Number(offsetInput.value)||0));
previous.addEventListener('click',()=>read(Math.max(0,(Number(offsetInput.value)||0)-pageSize)));
next.addEventListener('click',()=>read((Number(offsetInput.value)||0)+pageSize));
window.addEventListener('message',event=>{const data=event.data;if(data?.type!=='page')return;
rows.replaceChildren();for(let i=0;i<data.bytes.length;i+=16){const tr=document.createElement('tr');
const address=document.createElement('td');address.className='offset';address.textContent=(data.offset+i).toString(16).padStart(8,'0');
const hex=document.createElement('td');hex.className='hex';hex.textContent=data.bytes.slice(i,i+16).map(value=>value.toString(16).padStart(2,'0')).join(' ');
const ascii=document.createElement('td');ascii.className='ascii';ascii.textContent=data.bytes.slice(i,i+16).map(value=>value>=32&&value<127?String.fromCharCode(value):'.').join('');
tr.append(address,hex,ascii);rows.append(tr);}
previous.disabled=data.offset===0;next.disabled=data.offset+data.bytes.length>=data.total;
document.getElementById('page').textContent=data.total?((data.offset+1).toLocaleString()+'–'+(data.offset+data.bytes.length).toLocaleString()+' / '+data.total.toLocaleString()):'Empty file';
});
vscode.postMessage({type:'ready'});
read(0);
</script></body></html>`;
}

export function parseMdxMetadata(bytes: Uint8Array): { title: string; pdxName: string | undefined } | undefined {
	let titleEnd = -1;
	for (let offset = 0; offset <= bytes.length - mdxHeaderTerminator.length; offset++) {
		if (mdxHeaderTerminator.every((value, index) => bytes[offset + index] === value)) {
			titleEnd = offset;
			break;
		}
	}
	if (titleEnd < 0) { return undefined; }

	const pdxStart = titleEnd + mdxHeaderTerminator.length;
	const pdxEnd = bytes.indexOf(0, pdxStart);
	if (pdxEnd < 0) { return undefined; }
	const decoder = new TextDecoder('shift_jis');
	const title = decoder.decode(bytes.subarray(0, titleEnd)).replace(/[\u0000-\u001f\u007f]/g, '').trim();
	const pdxName = decoder.decode(bytes.subarray(pdxStart, pdxEnd)).replace(/[\u0000-\u001f\u007f]/g, '').trim();
	return { title, pdxName: pdxName || undefined };
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, character => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
	})[character]!);
}
