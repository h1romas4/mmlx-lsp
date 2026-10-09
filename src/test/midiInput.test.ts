import * as assert from 'assert';
import { EventEmitter } from 'node:events';
import { MidiInputConnection, type MidiInputPort, type MidiInputState, type MidiNoteEvent } from '../midiInput';

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
	test('screen bends update all channel caches without echo and allow MIDI to return to center', async () => {
		const input = new FakeInput();
		const events: MidiNoteEvent[] = [];
		const connection = new MidiInputConnection(() => {}, async () => input, () => {}, event => events.push(event));
		await connection.connect('Keyboard 2'); events.length = 0;
		connection.setPitchBends(10240);
		assert.ok(connection.pitchBends.every(value => value === 10240));
		assert.deepStrictEqual(events, []);
		for (const value of [-1, 16384, 0.5, NaN]) { connection.setPitchBends(value); }
		assert.ok(connection.pitchBends.every(value => value === 10240));
		input.emit('messageBuffer', 0, Buffer.from([0xe3, 0, 64]));
		assert.strictEqual(connection.pitchBends[3], 8192);
		assert.strictEqual(connection.pitchBends[4], 10240);
		assert.deepStrictEqual(events, [{ type: 'pitchBend', channel: 3, value: 8192 }]);
		connection.disconnect();
	});
	test('receives 14-bit bends, ignores malformed messages and resets controllers on disconnect', async () => {
		const input = new FakeInput();
		const events: MidiNoteEvent[] = [];
		const connection = new MidiInputConnection(() => {}, async () => input, () => {}, event => events.push(event));
		await connection.connect('Keyboard 2'); events.length = 0;
		input.emit('messageBuffer', 0, Buffer.from([0xe3, 127, 127]));
		input.emit('messageBuffer', 0, Buffer.from([0xe3, 127, 127]));
		input.emit('messageBuffer', 0, Buffer.from([0xe4, 0, 0]));
		for (const bytes of [[0xe3], [0xe3, 128, 0], [0xe3, 0, 128], [0x93, 60, 100]]) {
			input.emit('messageBuffer', 0, Buffer.from(bytes));
		}
		assert.strictEqual(connection.pitchBends[3], 16383);
		assert.strictEqual(connection.pitchBends[4], 0);
		input.emit('cc', 121, 0, { channel: 3 });
		connection.disconnect();
		assert.ok(connection.pitchBends.every(value => value === 8192));
		assert.deepStrictEqual(events, [
			{ type: 'pitchBend', channel: 3, value: 16383 }, { type: 'pitchBend', channel: 4, value: 0 },
			{ type: 'pitchBend', channel: 3, value: 8192 }, { type: 'pitchBend', channel: 4, value: 8192 }, { type: 'allOff' }
		]);
	});
	test('forwards velocity, retriggers and source channel releases independently of display changes', async () => {
		const input = new FakeInput();
		const events: MidiNoteEvent[] = [];
		const connection = new MidiInputConnection(() => {}, async () => input, () => {}, event => events.push(event));
		await connection.connect('Keyboard 2'); events.length = 0;
		input.emit('noteon', 60, 100, { channel: 3 });
		input.emit('noteon', 60, 70, { channel: 3 });
		input.emit('noteon', 60, 0, { channel: 3 });
		input.emit('cc', 123, 0, { channel: 4 });
		connection.disconnect();
		assert.deepStrictEqual(events, [
			{ type: 'noteOn', channel: 3, note: 60, velocity: 100 },
			{ type: 'noteOn', channel: 3, note: 60, velocity: 70 },
			{ type: 'noteOff', channel: 3, note: 60 },
			{ type: 'allOff', channel: 4 }, { type: 'allOff' }
		]);
	});
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