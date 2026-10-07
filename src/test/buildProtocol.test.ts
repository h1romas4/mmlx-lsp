import * as assert from 'assert';
import { BuildResponseDecoder } from '../buildProtocol';

function frame(byteLength: number): Buffer {
	return Buffer.from(`${JSON.stringify({ ok: true, byteLength })}\n`);
}

suite('Build response protocol', () => {
	test('receives output metadata across all two-chunk boundaries', () => {
		const output = frame(256);
		for (let boundary = 0; boundary <= output.length; boundary++) {
			const decoder = new BuildResponseDecoder();
			decoder.push(output.subarray(0, boundary));
			decoder.push(output.subarray(boundary));
			const response = decoder.finish(0);
			assert.ok(response.ok);
			assert.strictEqual(response.byteLength, 256);
			assert.strictEqual(decoder.finish(0).ok, true);
		}
	});

	test('copies reusable header chunks without allocating output buffers', () => {
		const output = frame(1024 * 1024 * 1024);
		for (const chunk of [new Uint8Array(1), Buffer.alloc(1)]) {
			const decoder = new BuildResponseDecoder();
			for (const byte of output) {
				chunk[0] = byte;
				decoder.push(chunk);
			}
			chunk[0] = 42;
			const response = decoder.finish(0);
			assert.ok(response.ok);
			assert.deepStrictEqual(response, { ok: true, byteLength: 1024 * 1024 * 1024 });
			assert.strictEqual(decoder.finish(0), response);
		}
	});

	test('accepts zero-length output metadata', () => {
		const decoder = new BuildResponseDecoder();
		decoder.push(frame(0));
		assert.deepStrictEqual(decoder.finish(0), { ok: true, byteLength: 0 });
	});

	test('preserves errors and diagnostics across byte-sized chunks', () => {
		const error = { ok: false, message: 'Invalid source: \u65e5\u672c\ud83c\udfb5', range: [[0, 2], [0, 4]], pdxName: 'drums' };
		const decoder = new BuildResponseDecoder();
		for (const byte of Buffer.from(`${JSON.stringify(error)}\n`)) {
			decoder.push(Uint8Array.of(byte));
		}
		assert.deepStrictEqual(decoder.finish(1), error);
	});

	test('rejects incomplete headers and failed success responses', () => {
		assert.throws(() => new BuildResponseDecoder().finish(0), /Invalid compiler response/);
		const header = new BuildResponseDecoder();
		header.push(Buffer.from('{"ok":true'));
		assert.throws(() => header.finish(0), /Invalid compiler response/);
		const truncated = new BuildResponseDecoder();
		truncated.push(frame(2).subarray(0, -1));
		assert.throws(() => truncated.finish(0), /Invalid compiler response/);
		const failed = new BuildResponseDecoder();
		failed.push(frame(0));
		assert.throws(() => failed.finish(1), /Invalid compiler response/);
	});

	test('rejects extra payload bytes and trailing data after errors', () => {
		const decoder = new BuildResponseDecoder();
		decoder.push(frame(1));
		assert.throws(() => decoder.push(Uint8Array.of(2)), /Unexpected/);
		assert.throws(() => new BuildResponseDecoder().push(Buffer.concat([frame(1), Uint8Array.of(0)])), /Unexpected/);
		const error = new BuildResponseDecoder();
		assert.throws(() => error.push(Buffer.from('{"ok":false,"message":"error"}\nx')), /Unexpected/);
	});

	test('rejects malformed, oversized and invalid metadata', () => {
		for (const header of [null, {}, { ok: false }, { ok: true, bytes: [] },
			...[null, '1', -1, 0.5, 1024 * 1024 * 1024 + 1].map(byteLength => ({ ok: true, byteLength }))]) {
			const decoder = new BuildResponseDecoder();
			assert.throws(() => decoder.push(Buffer.from(`${JSON.stringify(header)}\n`)), /Invalid compiler response/);
		}
		assert.throws(() => new BuildResponseDecoder().push(Buffer.from('not json\n')));
		assert.throws(() => new BuildResponseDecoder().push(Buffer.alloc(64 * 1024 + 1, 32)), /too large/);
	});
});