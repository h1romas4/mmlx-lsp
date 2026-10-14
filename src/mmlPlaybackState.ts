import type { LanguageClient } from 'vscode-languageclient/node';

export interface MmlPlaybackState {
	tempo?: string;
	length?: string;
	octave?: number;
	volume?: string[];
	gate?: string;
	pan?: string;
	opmLfo?: string[];
}

export interface MmlPlaybackStateScan {
	state: MmlPlaybackState;
	hasTempo: boolean;
	hasLength: boolean;
	hasOctave: boolean;
	hasVolume: boolean;
	hasGate: boolean;
	hasPan: boolean;
	hasOpmLfo: boolean;
}

export async function requestMmlPlaybackState(
	client: LanguageClient,
	source: string,
	offset: number,
	initialState: MmlPlaybackState = {}
): Promise<MmlPlaybackStateScan | null> {
	if (!Number.isInteger(offset) || offset < 0 || offset > source.length) {
		throw new RangeError('Invalid MML playback-state offset.');
	}
	const byteOffset = new TextEncoder().encode(source.slice(0, offset)).length;
	const response = await client.sendRequest<MmlPlaybackStateScan | null>('mmlx/playbackState', {
		source,
		offset: byteOffset,
		initialState
	});
	if (response === null) { return null; }
	if (typeof response !== 'object' || !response.state
		|| !['hasTempo', 'hasLength', 'hasOctave', 'hasVolume', 'hasGate', 'hasPan', 'hasOpmLfo']
			.every(key => typeof response[key as keyof MmlPlaybackStateScan] === 'boolean')) {
		throw new Error('Invalid MML playback-state response.');
	}
	return response;
}
