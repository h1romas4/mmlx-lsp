export interface MmlPlaybackState {
	tempo?: string;
	length?: string;
	octave?: number;
	volume?: string[];
	gate?: string;
	pan?: string;
}

export interface MmlPlaybackStateScan {
	state: MmlPlaybackState;
	hasTempo: boolean;
	hasLength: boolean;
	hasOctave: boolean;
	hasVolume: boolean;
	hasGate: boolean;
	hasPan: boolean;
}

function lengthCommandEnd(source: string, start: number, limit: number): number {
	let cursor = start + 1;
	while (cursor < limit && /\s/.test(source[cursor])) { cursor++; }
	if (cursor >= limit || !/[0-9%]/.test(source[cursor])) { return start + 1; }

	while (cursor < limit) {
		if (source[cursor] === '%') { cursor++; }
		const numberStart = cursor;
		while (cursor < limit && /[0-9]/.test(source[cursor])) { cursor++; }
		if (cursor === numberStart) { return start + 1; }
		while (cursor < limit && source[cursor] === '.') { cursor++; }

		const termEnd = cursor;
		while (cursor < limit && /\s/.test(source[cursor])) { cursor++; }
		if (cursor >= limit || (source[cursor] !== '^' && source[cursor] !== '~')) { return termEnd; }
		cursor++;
		while (cursor < limit && /\s/.test(source[cursor])) { cursor++; }
	}
	return start + 1;
}

export function scanMmlPlaybackState(source: string, offset: number, initialState: MmlPlaybackState = {}): MmlPlaybackStateScan {
	const state: MmlPlaybackState = { ...initialState };
	let hasTempo = false;
	let hasLength = false;
	let hasOctave = false;
	let hasVolume = false;
	let hasGate = false;
	let hasPan = false;
	let index = 0;
	const limit = Math.max(0, Math.min(offset, source.length));
	while (index < limit) {
		const character = source[index];
		const lower = character.toLowerCase();
		const next = source[index + 1];
		if (character === ';') {
			const newline = source.indexOf('\n', index + 1);
			index = newline < 0 || newline >= limit ? limit : newline + 1;
		} else if (character === '/' && next === '*') {
			const close = source.indexOf('*/', index + 2);
			index = close < 0 || close + 2 > limit ? limit : close + 2;
		} else if (character === '"') {
			const close = source.indexOf('"', index + 1);
			index = close < 0 || close >= limit ? limit : close + 1;
		} else if (lower === '@' && (next?.toLowerCase() === 'v' || next?.toLowerCase() === 'q')) {
			const end = index + 2;
			let numberEnd = end;
			while (numberEnd < limit && /[0-9]/.test(source[numberEnd])) { numberEnd++; }
			if (numberEnd > end) {
				const value = Number(source.slice(end, numberEnd));
				const command = source.slice(index, numberEnd);
				if (Number.isInteger(value) && (next?.toLowerCase() === 'v' ? value <= 255 : value <= 256)
					&& (numberEnd === source.length || !/[0-9]/.test(source[numberEnd]))) {
					if (next?.toLowerCase() === 'v') {
						state.volume = [command];
						hasVolume = true;
					} else {
						state.gate = command;
						hasGate = true;
					}
				}
				index = numberEnd;
			} else { index = end; }
		} else {
			const opmTempo = lower === '@' && next?.toLowerCase() === 't' ? index + 2 : -1;
			const tempoStart = opmTempo >= 0 ? opmTempo
				: lower === 't' && index > 0 && source[index - 1] === '@' ? -1
					: lower === 't' ? index + 1 : -1;
			if (tempoStart >= 0 && tempoStart < limit && /[0-9]/.test(source[tempoStart])) {
				let end = tempoStart;
				while (end < limit && /[0-9]/.test(source[end])) { end++; }
				const value = Number(source.slice(tempoStart, end));
				const valid = opmTempo >= 0 ? Number.isSafeInteger(value) && value <= 255
					: Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
				const complete = end === source.length || !/[0-9]/.test(source[end]);
				if (valid && complete) {
					state.tempo = source.slice(index, end);
					hasTempo = true;
				}
				index = end;
			} else if (lower === 'l') {
				const end = lengthCommandEnd(source, index, limit);
				state.length = source.slice(index, end);
				hasLength = true;
				index = end;
			} else if (lower === 'o' && /[0-9]/.test(next ?? '')) {
				let end = index + 1;
				while (end < limit && /[0-9]/.test(source[end])) { end++; }
				const value = Number(source.slice(index + 1, end));
				if (Number.isInteger(value) && value <= 255 && (end === source.length || !/[0-9]/.test(source[end]))) {
					state.octave = value;
					hasOctave = true;
				}
				index = end;
			} else if (character === '<' || character === '>') {
				state.octave = Math.max(0, Math.min(255, (state.octave ?? 4) + (character === '>' ? 1 : -1)));
				index++;
			} else if (lower === 'v' || lower === 'q' || lower === 'p') {
				let end = index + 1;
				while (end < limit && /[0-9]/.test(source[end])) { end++; }
				if (end > index + 1) {
					const value = Number(source.slice(index + 1, end));
					const command = source.slice(index, end);
					if (Number.isInteger(value) && value <= 255 && (end === source.length || !/[0-9]/.test(source[end]))) {
						if (lower === 'v') {
							state.volume = [command];
							hasVolume = true;
						} else if (lower === 'q') {
							state.gate = command;
							hasGate = true;
						} else {
							state.pan = command;
							hasPan = true;
						}
					}
					index = end;
				} else { index++; }
			} else if (character === '(' || character === ')') {
				state.volume = [...(state.volume ?? []), character];
				index++;
			} else { index++; }
		}
	}
	return { state, hasTempo, hasLength, hasOctave, hasVolume, hasGate, hasPan };
}

export function mmlPlaybackStateBefore(source: string, offset: number): MmlPlaybackState {
	return scanMmlPlaybackState(source, offset).state;
}

export function mmlPlaybackStateAfter(source: string, initialState: MmlPlaybackState = {}): MmlPlaybackState {
	return scanMmlPlaybackState(source, source.length, initialState).state;
}

export function tempoBefore(source: string, offset: number): string | undefined {
	return mmlPlaybackStateBefore(source, offset).tempo;
}
