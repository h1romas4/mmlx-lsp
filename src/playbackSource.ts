import { Range, ThemeColor, window, workspace, type Disposable, type TextDocument, type TextEditor } from 'vscode';
import type { NanoDriveWorker } from './nanodriveWorker';
import type { MmlPlaybackState, MmlPlaybackStateScan } from './mmlPlaybackState';

export interface SourceEvent { position: number; channel: number; start: number | null; end: number | null; }
export interface SourceBatch { events: SourceEvent[]; position: number; finished: boolean; }
export interface SelectionTraceSource { source: string; documentOffsets: number[]; }

export function selectionTraceSource(
	mml: string, inheritedState: MmlPlaybackState, selectionState: MmlPlaybackStateScan, documentStart: number
): SelectionTraceSource {
	const tempo = inheritedState.tempo && !selectionState.hasTempo ? inheritedState.tempo : undefined;
	const length = inheritedState.length && !selectionState.hasLength ? inheritedState.length : undefined;
	const octave = inheritedState.octave !== undefined && !selectionState.hasOctave ? `o${inheritedState.octave}` : undefined;
	const volume = inheritedState.volume?.join(' ');
	const gate = inheritedState.gate;
	const pan = inheritedState.pan;
	const opmLfo = inheritedState.opmLfo?.join(' ');
	const commands = [tempo, length, octave, volume, gate, pan, opmLfo]
		.filter((command): command is string => command !== undefined).join(' ');
	let body = '';
	const bodyOffsets = [documentStart];
	const appendBodyOriginal = (start: number, end: number) => {
		body += mml.slice(start, end);
		for (let offset = start + 1; offset <= end; offset++) { bodyOffsets.push(documentStart + offset); }
	};
	const appendBodyInserted = (value: string, offset: number) => {
		body += value;
		for (let index = 0; index < value.length; index++) { bodyOffsets.push(documentStart + offset); }
	};
	let index = 0;
	let segmentStart = 0;
	while (index < mml.length) {
		const character = mml[index];
		if (character === ';') {
			const newline = mml.indexOf('\n', index + 1);
			index = newline < 0 ? mml.length : newline + 1;
		} else if (character === '/' && mml[index + 1] === '*') {
			const close = mml.indexOf('*/', index + 2);
			index = close < 0 ? mml.length : close + 2;
		} else if (character === '"') {
			const close = mml.indexOf('"', index + 1);
			index = close < 0 ? mml.length : close + 1;
		} else if (character === '@' && /[0-9]/.test(mml[index + 1] ?? '')) {
			appendBodyOriginal(segmentStart, index);
			appendBodyInserted(' ', index);
			index++;
			while (index < mml.length && /[0-9]/.test(mml[index])) { index++; }
			segmentStart = index;
		} else { index++; }
	}
	appendBodyOriginal(segmentStart, mml.length);

	const voice = '@0 = {\n31,0,0,15,0,32,0,1,0,0,0,\n31,0,0,15,0,32,0,1,0,0,0,\n31,0,0,15,0,32,0,1,0,0,0,\n31,0,0,15,0,32,0,1,0,0,0,\n7,0,15\n}\n';
	let source = '';
	const documentOffsets = [documentStart];
	const appendOriginal = (start: number, end: number) => {
		source += body.slice(start, end);
		for (let offset = start + 1; offset <= end; offset++) { documentOffsets.push(bodyOffsets[offset]); }
	};
	const appendInserted = (value: string, offset: number) => {
		source += value;
		for (let index = 0; index < value.length; index++) { documentOffsets.push(offset); }
	};
	appendInserted(voice, documentStart);
	const lines = body.split('\n');
	const isChannel = (line: string) => /^[A-H](?:\s|$)/.test(line.trimStart());
	if (!lines.some(isChannel)) {
		appendInserted(`A @0${commands ? ` ${commands}` : ''} `, documentStart);
		appendOriginal(0, body.length);
		return { source, documentOffsets };
	}
	let start = 0;
	for (const line of lines) {
		const end = start + line.length;
		const indent = line.length - line.trimStart().length;
		if (isChannel(line)) {
			const channelEnd = start + indent + 1;
			appendOriginal(start, channelEnd);
			appendInserted(` @0${commands ? ` ${commands}` : ''}`, bodyOffsets[channelEnd]);
			appendOriginal(channelEnd, end);
		} else { appendOriginal(start, end); }
		if (end < body.length) { appendOriginal(end, end + 1); }
		start = end + 1;
	}
	return { source, documentOffsets };
}

export class PlaybackSourceTracker implements Disposable {
	private readonly decoration = window.createTextEditorDecorationType({
		backgroundColor: new ThemeColor('editor.findMatchBackground'),
		border: '1px solid', borderColor: new ThemeColor('editor.findMatchBorder')
	});
	private readonly lineDecoration = window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: new ThemeColor('editor.selectionBackground')
	});
	private readonly subscriptions: Disposable[];
	private document?: TextDocument;
	private version = 0;
	private generation = 0;
	private offsets = new Int32Array(0);
	private queue: SourceEvent[] = [];
	private active = new Map<number, Range>();
	private decorated = new Set<TextEditor>();
	private position = 0;
	private covered = -1;
	private ready = false;
	private hasPosition = false;
	private finished = false;
	private pumping?: Promise<void>;
	private stopping = Promise.resolve();

	constructor(private readonly worker: Pick<NanoDriveWorker, 'request' | 'dispose'>,
		private readonly onError: (message: string) => void = () => {}) {
		this.subscriptions = [window.onDidChangeVisibleTextEditors(() => this.render()),
			workspace.onDidChangeTextDocument(event => { if (event.document === this.document) { this.stop(); } }),
			workspace.onDidCloseTextDocument(document => { if (document === this.document) { this.stop(); } })];
	}

	get ranges(): Range[] { return [...this.active.values()]; }
	get lineRanges(): Range[] {
		const lines = new Set<number>();
		for (const range of this.active.values()) {
			const endLine = range.end.character === 0 && range.end.line > range.start.line ? range.end.line - 1 : range.end.line;
			for (let line = range.start.line; line <= endLine; line++) { lines.add(line); }
		}
		return [...lines].sort((first, second) => first - second).map(line => new Range(line, 0, line, 0));
	}

	async start(document: TextDocument, looped: boolean, source = document.getText(), documentOffsets?: readonly number[]): Promise<void> {
		this.stop();
		const generation = this.generation;
		this.document = document; this.version = document.version;
		if (documentOffsets && (documentOffsets.length !== source.length + 1
			|| documentOffsets.some(offset => !Number.isInteger(offset) || offset < 0 || offset > document.getText().length))) {
			throw new Error('Invalid playback source mapping.');
		}
		const bytes = new TextEncoder().encode(source);
		this.offsets = new Int32Array(bytes.length + 1).fill(-1);
		let byteOffset = 0; let characterOffset = 0;
		this.offsets[0] = documentOffsets?.[0] ?? 0;
		for (const character of source) {
			byteOffset += Buffer.byteLength(character); characterOffset += character.length;
			this.offsets[byteOffset] = documentOffsets?.[characterOffset] ?? characterOffset;
		}
		try {
			await this.stopping;
			for (let offset = 0; offset < Math.max(1, bytes.length); offset += 8192) {
				if (generation !== this.generation) { return; }
				await this.worker.request({ operation: 'upload', asset: 'source', offset, bytes: Array.from(bytes.subarray(offset, offset + 8192)) });
			}
			if (generation !== this.generation) { return; }
			await this.worker.request({ operation: 'sourceTraceInit', looped });
			if (generation === this.generation) {
				this.ready = true;
				if (this.hasPosition) { await this.setPosition(this.position); }
			}
		} catch (error) { this.fail(error, generation); }
	}

	setPosition(position: number): Promise<void> {
		if (!Number.isFinite(position) || position < this.position || position < 0 || !this.document) { return Promise.resolve(); }
		this.hasPosition = true; this.position = position; this.apply();
		if (!this.ready || this.finished) { return Promise.resolve(); }
		if (this.pumping) { return this.pumping; }
		const generation = this.generation;
		const pumping = (async () => {
			try {
				while (generation === this.generation && !this.finished && this.covered <= this.position + 0.1) {
					const result = await this.worker.request({ operation: 'sourceTraceNext', until: this.position + 0.1 });
					if (generation !== this.generation) { return; }
					if (!result || !('events' in result) || !Array.isArray(result.events) || result.events.length > 256
						|| !Number.isFinite(result.position) || result.position < this.covered || typeof result.finished !== 'boolean') {
						throw new Error('Invalid playback source events.');
					}
					for (const event of result.events) {
						if (!event || !Number.isFinite(event.position) || event.position < 0 || !Number.isInteger(event.channel) || event.channel < 0 || event.channel >= 16
							|| !((event.start === null && event.end === null) || (Number.isInteger(event.start) && Number.isInteger(event.end)
								&& event.start! >= 0 && event.end! > event.start! && event.end! < this.offsets.length
								&& this.offsets[event.start!] >= 0 && this.offsets[event.end!] >= 0))) { throw new Error('Invalid playback source range.'); }
					}
					this.queue.push(...result.events); this.covered = result.position; this.finished = result.finished;
					if (this.finished) {
						for (let channel = 0; channel < 16; channel++) {
							this.queue.push({ position: result.position, channel, start: null, end: null });
						}
					}
					if (this.queue.length > 8192) { throw new Error('Playback source queue overflow.'); }
					this.apply();
				}
			} catch (error) { this.fail(error, generation); }
		})().finally(() => { if (this.pumping === pumping) { this.pumping = undefined; } });
		this.pumping = pumping; return pumping;
	}

	private apply(): void {
		if (!this.document) { return; }
		if (this.document.isClosed || this.document.version !== this.version) { this.stop(); return; }
		let changed = false;
		while (this.queue.length && this.queue[0].position <= this.position) {
			const event = this.queue.shift()!; changed = true;
			if (event.start === null) { this.active.delete(event.channel); }
			else { this.active.set(event.channel, new Range(this.document.positionAt(this.offsets[event.start]), this.document.positionAt(this.offsets[event.end!]))); }
		}
		if (changed) { this.render(); }
	}

	private render(): void {
		for (const editor of new Set([...this.decorated, ...window.visibleTextEditors])) {
			if (editor.document.isClosed) { this.decorated.delete(editor); continue; }
			const ranges = editor.document === this.document ? this.ranges : [];
			if (ranges.length || this.decorated.has(editor)) {
				try {
					editor.setDecorations(this.lineDecoration, editor.document === this.document ? this.lineRanges : []);
					editor.setDecorations(this.decoration, ranges);
				} catch { this.decorated.delete(editor); continue; }
			}
			if (ranges.length) { this.decorated.add(editor); } else { this.decorated.delete(editor); }
		}
	}

	private fail(error: unknown, generation: number): void {
		if (generation !== this.generation) { return; }
		this.stop(); this.onError(error instanceof Error ? error.message : String(error));
	}

	stop(): void {
		this.generation++; this.document = undefined; this.ready = false; this.finished = false;
		this.hasPosition = false;
		this.queue = []; this.active.clear(); this.position = 0; this.covered = -1; this.pumping = undefined;
		this.render();
		this.stopping = this.stopping.then(() => this.worker.dispose()).catch(() => undefined);
	}

	dispose(): void { this.stop(); for (const subscription of this.subscriptions) { subscription.dispose(); } this.decoration.dispose(); this.lineDecoration.dispose(); }
}