export type BuildResponse = { ok: true; byteLength: number } | {
	ok: false;
	message: string;
	pdxName?: string;
	range?: [[number, number], [number, number]] | null;
};

const maxHeaderLength = 64 * 1024;
const maxByteLength = 1024 * 1024 * 1024;

export class BuildResponseDecoder {
	private header: Uint8Array[] = [];
	private headerLength = 0;
	private response?: BuildResponse;

	push(data: Uint8Array): void {
		if (!this.response) {
			const newline = data.indexOf(10);
			const length = newline < 0 ? data.length : newline;
			this.headerLength += length;
			if (this.headerLength > maxHeaderLength) {
				throw new Error('Compiler response header is too large.');
			}
			if (length > 0) { this.header.push(new Uint8Array(data.subarray(0, length))); }
			if (newline < 0) { return; }
			const header = new Uint8Array(this.headerLength);
			let offset = 0;
			for (const chunk of this.header) {
				header.set(chunk, offset);
				offset += chunk.length;
			}
			this.response = this.parseHeader(header);
			this.header = [];
			data = data.subarray(newline + 1);
		}
		if (data.length !== 0) { throw new Error('Unexpected compiler response payload.'); }
	}

	finish(code: number): BuildResponse {
		if (!this.response || (this.response.ok && code !== 0)) {
			throw new Error(`Invalid compiler response (exit code ${code}).`);
		}
		return this.response;
	}

	private parseHeader(bytes: Uint8Array): BuildResponse {
		const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
		if (header && header.ok === false && typeof header.message === 'string') {
			return header as BuildResponse;
		}
		if (!header || header.ok !== true || !Number.isSafeInteger(header.byteLength)
			|| header.byteLength < 0 || header.byteLength > maxByteLength) {
			throw new Error('Invalid compiler response header.');
		}
		return { ok: true, byteLength: header.byteLength };
	}
}