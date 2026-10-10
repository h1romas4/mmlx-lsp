import * as assert from 'assert';
import { EmulationFrameDecoder, decodeFmKeyEvents } from '../emulationProtocol';

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
	test('decodes split playback progress frames', () => {
		const frame = new Uint8Array(14);
		frame[0] = 3;
		const view = new DataView(frame.buffer);
		view.setUint32(1, 9, true); view.setFloat64(5, 1.25, true); frame[13] = 1;
		for (let split = 0; split <= frame.length; split++) {
			let received = false;
			const decoder = new EmulationFrameDecoder((kind, bytes) => {
				assert.strictEqual(kind, 3);
				assert.strictEqual(new DataView(bytes.buffer).getFloat64(0, true), 1.25);
				assert.strictEqual(bytes[8], 1); received = true;
			});
			decoder.push(frame.subarray(0, split)); decoder.push(frame.subarray(split)); decoder.finish();
			assert.ok(received);
		}
	});
	test('rejects unbounded, unexpected and truncated frames', () => {
		for (let split = 0; split <= 5; split++) {
			const received: number[] = [];
			const reset = Uint8Array.from([4, 0, 0, 0, 0]);
			const decoder = new EmulationFrameDecoder((kind, bytes) => { received.push(kind); assert.strictEqual(bytes.length, 0); });
			decoder.push(reset.subarray(0, split)); decoder.push(reset.subarray(split)); decoder.push(reset); decoder.finish();
			assert.deepStrictEqual(received, [4, 4]);
		}
		for (const bytes of [[3, 4, 0, 0, 0], [2, 255, 255, 255, 255], [1, 0, 0, 0, 0], [4, 1, 0, 0, 0], [5, 0, 0, 0, 0], [5, 1, 0, 1, 0], [6, 0, 0, 0, 0], [6, 1, 0, 1, 0], [7, 1, 0, 0, 0]]) {
			assert.throws(() => new EmulationFrameDecoder(() => {}).push(new Uint8Array(bytes)));
		}
		const decoder = new EmulationFrameDecoder(() => {});
		decoder.push(new Uint8Array([1, 4, 0, 0, 0, 1]));
		assert.throws(() => decoder.finish());
	});
	test('validates FM keyboard event metadata', () => {
		const keys = [{ position: 0, channel: 0, note: 60 }, { position: 0.25, channel: 7, note: null }];
		assert.deepStrictEqual(decodeFmKeyEvents(keys), keys);
		for (const value of [null, {}, [null], [{ position: -1, channel: 0, note: 60 }], [{ position: NaN, channel: 0, note: 60 }], [{ position: 0, channel: 8, note: 60 }], [{ position: 0, channel: 0, note: 109 }], [{ position: 0, channel: 0 }]]) {
			assert.throws(() => decodeFmKeyEvents(value));
		}
		const payload = Buffer.from(JSON.stringify(keys));
		const frame = Buffer.alloc(5 + payload.length); frame[0] = 6; frame.writeUInt32LE(payload.length, 1); payload.copy(frame, 5);
		for (let split = 0; split <= frame.length; split++) {
			let received = false;
			const decoder = new EmulationFrameDecoder((kind, bytes) => {
				assert.strictEqual(kind, 6); assert.deepStrictEqual(decodeFmKeyEvents(JSON.parse(new TextDecoder().decode(bytes))), keys); received = true;
			});
			decoder.push(frame.subarray(0, split)); decoder.push(frame.subarray(split)); decoder.finish(); assert.ok(received);
		}
	});
	test('decodes asset metadata at every frame split', () => {
		const info = { audio: true, pdxName: 'drums' };
		const payload = new TextEncoder().encode(JSON.stringify(info));
		const frame = new Uint8Array(5 + payload.length);
		frame[0] = 5; new DataView(frame.buffer).setUint32(1, payload.length, true); frame.set(payload, 5);
		for (let split = 0; split <= frame.length; split++) {
			let received = false;
			const decoder = new EmulationFrameDecoder((kind, bytes) => {
				assert.strictEqual(kind, 5); assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(bytes)), info); received = true;
			});
			decoder.push(frame.subarray(0, split)); decoder.push(frame.subarray(split)); decoder.finish();
			assert.ok(received);
		}
	});
});