import * as assert from 'assert';
import { EventEmitter } from 'node:events';
import { MidiInputConnection, type MidiInputPort, type MidiInputState } from '../midiInput';

class FakeInput extends EventEmitter {
	opened = -1;
	destroyed = false;
	fail = false;
	ignored: boolean[] = [];
	getPortCount(): number { return 2; }
	getPortName(index: number): string { return ['Keyboard 10', 'Keyboard 2'][index]; }
	ignoreTypes(...values: boolean[]): void { this.ignored = values; }
	openPort(index: number): void { if (this.fail) { throw new Error('Port unavailable'); } this.opened = index; }
	destroy(): void { this.destroyed = true; this.removeAllListeners(); }
}

suite('MIDI input connection', () => {
	test('opens the selected name using the current native index and releases notes on disconnect', async () => {
		const input = new FakeInput();
		const states: MidiInputState[] = [];
		const updates: number[][] = [];
		const connection = new MidiInputConnection(state => states.push(state), async () => input, notes => updates.push(notes));
		await connection.connect('Keyboard 2');
		assert.strictEqual(input.opened, 1);
		assert.deepStrictEqual(input.ignored, [true, true, true]);
		assert.ok(states.some(state => state.connecting));
		assert.strictEqual(connection.state.connected, true);
		input.emit('noteon', 60, 100, { channel: 0, deltaTime: 0 });
		assert.deepStrictEqual(updates.at(-1), [60]);
		connection.disconnect();
		assert.ok(input.destroyed);
		assert.deepStrictEqual(updates.at(-1), []);
		assert.strictEqual(connection.state.connected, false);
	});

	test('handles note off, zero velocity, duplicate notes and independent MIDI channels', async () => {
		const input = new FakeInput();
		const connection = new MidiInputConnection(() => {}, async () => input);
		await connection.connect('Keyboard 2');
		input.emit('noteon', 60, 127, { channel: 0 });
		input.emit('noteon', 60, 127, { channel: 0 });
		input.emit('noteon', 60, 64, { channel: 1 });
		input.emit('noteon', 64, 64, { channel: 0 });
		input.emit('noteoff', 60, 0, { channel: 0 });
		assert.deepStrictEqual(connection.notes, [60, 64]);
		input.emit('noteon', 60, 0, { channel: 1 });
		assert.deepStrictEqual(connection.notes, [64]);
		input.emit('noteoff', 64, 0, { channel: 0 });
		assert.deepStrictEqual(connection.notes, []);
		connection.disconnect();
	});

	test('clears only the requested channel for all-notes-off and all-sound-off', async () => {
		const input = new FakeInput();
		const connection = new MidiInputConnection(() => {}, async () => input);
		await connection.connect('Keyboard 2');
		input.emit('noteon', 60, 100, { channel: 0 });
		input.emit('noteon', 64, 100, { channel: 1 });
		input.emit('cc', 123, 0, { channel: 0 });
		assert.deepStrictEqual(connection.notes, [64]);
		input.emit('cc', 120, 0, { channel: 1 });
		assert.deepStrictEqual(connection.notes, []);
		connection.disconnect();
	});

	test('ignores malformed notes and unrelated control changes', async () => {
		const input = new FakeInput();
		const connection = new MidiInputConnection(() => {}, async () => input);
		await connection.connect('Keyboard 2');
		for (const note of [-1, 128, 1.5, undefined]) { input.emit('noteon', note, 100, { channel: 0 }); }
		input.emit('noteon', 60, 128, { channel: 0 });
		input.emit('noteon', 60, 100, { channel: 16 });
		assert.deepStrictEqual(connection.notes, []);
		input.emit('noteon', 60, 100, { channel: 0 });
		input.emit('cc', 64, 0, { channel: 0 });
		assert.deepStrictEqual(connection.notes, [60]);
		connection.disconnect();
	});

	test('reports failed opens and missing ports and destroys unused inputs', async () => {
		for (const missing of [false, true]) {
			const input = new FakeInput();
			input.fail = !missing;
			const connection = new MidiInputConnection(() => {}, async () => input);
			await connection.connect(missing ? 'Missing keyboard' : 'Keyboard 2');
			assert.ok(input.destroyed);
			assert.strictEqual(connection.state.connected, false);
			assert.ok(connection.state.error);
		}
	});

	test('does not open a port after a pending connection is canceled', async () => {
		const input = new FakeInput();
		let resolve!: (input: MidiInputPort) => void;
		const connection = new MidiInputConnection(() => {}, () => new Promise(done => { resolve = done; }));
		const pending = connection.connect('Keyboard 2');
		connection.disconnect();
		resolve(input);
		await pending;
		assert.ok(input.destroyed);
		assert.strictEqual(input.opened, -1);
		assert.strictEqual(connection.state.connected, false);
	});
});