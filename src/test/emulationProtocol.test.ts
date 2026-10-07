import * as assert from 'assert';
import { EmulationFrameDecoder } from '../emulationProtocol';

suite('Emulation frame protocol', () => {
	test('handles every frame split, multiple frames and reused input buffers', () => {
		const frame = new Uint8Array(4101);
		frame[0] = 2; new DataView(frame.buffer).setUint32(1, 4096, true); frame[6] = 73;
		for (let split = 0; split <= frame.length; split++) {
			const results: Uint8Array[] = [];
			const decoder = new EmulationFrameDecoder((kind, bytes) => { assert.strictEqual(kind, 2); results.push(bytes); });
			decoder.push(frame.subarray(0, split)); decoder.push(frame.subarray(split)); decoder.finish();
			assert.deepStrictEqual(results[0], frame.subarray(5));
		}
		const buffer = Buffer.from(frame);
		let result!: Uint8Array;
		const decoder = new EmulationFrameDecoder((_kind, bytes) => { result = bytes; });
		decoder.push(buffer); buffer.fill(0); assert.strictEqual(result[1], 73);
	});
	test('rejects unbounded, unexpected and truncated frames', () => {
		for (const bytes of [[3, 4, 0, 0, 0], [2, 255, 255, 255, 255], [1, 0, 0, 0, 0]]) {
			assert.throws(() => new EmulationFrameDecoder(() => {}).push(new Uint8Array(bytes)));
		}
		const decoder = new EmulationFrameDecoder(() => {});
		decoder.push(new Uint8Array([1, 4, 0, 0, 0, 1]));
		assert.throws(() => decoder.finish());
	});
});