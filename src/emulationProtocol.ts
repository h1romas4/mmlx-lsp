export interface FmKeyEvent { position: number; channel: number; note: number | null }

export function decodeFmKeyEvents(value: unknown): FmKeyEvent[] {
	if (!Array.isArray(value) || value.length > 4096 || value.some(event => !event || typeof event !== 'object'
		|| !Number.isFinite(event.position) || event.position < 0 || !Number.isInteger(event.channel) || event.channel < 0 || event.channel > 7
		|| (event.note !== null && (!Number.isInteger(event.note) || event.note < 21 || event.note > 108)))) {
		throw new Error('Invalid FM keyboard events.');
	}
	return value as FmKeyEvent[];
}

export class EmulationFrameDecoder {
	private header = new Uint8Array(5);
	private headerOffset = 0;
	private payload?: Uint8Array;
	private payloadOffset = 0;
	constructor(private readonly onFrame: (kind: number, bytes: Uint8Array) => void,
		private readonly valid = (kind: number, length: number) => (kind === 1 && length === 4)
			|| (kind === 2 && length === 4096) || (kind === 3 && length === 9) || (kind === 4 && length === 0)
			|| ((kind === 5 || kind === 6) && length > 0 && length <= 65536)) {}

	push(data: Uint8Array): void {
		let offset = 0;
		while (offset < data.length) {
			if (!this.payload) {
				const count = Math.min(5 - this.headerOffset, data.length - offset);
				this.header.set(data.subarray(offset, offset + count), this.headerOffset);
				offset += count; this.headerOffset += count;
				if (this.headerOffset < 5) { continue; }
				const length = new DataView(this.header.buffer).getUint32(1, true);
				if (!this.valid(this.header[0], length)) {
					throw new Error('Invalid emulator frame.');
				}
				this.payload = new Uint8Array(length);
			}
			const count = Math.min(this.payload.length - this.payloadOffset, data.length - offset);
			this.payload.set(data.subarray(offset, offset + count), this.payloadOffset);
			offset += count; this.payloadOffset += count;
			if (this.payloadOffset === this.payload.length) {
				const payload = this.payload;
				this.payload = undefined; this.payloadOffset = 0; this.headerOffset = 0;
				this.onFrame(this.header[0], payload);
			}
		}
	}

	finish(): void {
		if (this.headerOffset || this.payload) { throw new Error('Truncated emulator frame.'); }
	}
}