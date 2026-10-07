import type { Input } from '@julusian/midi';

export interface MidiInputPort extends Pick<Input, 'getPortCount' | 'getPortName' | 'openPort' | 'ignoreTypes' | 'destroy'> {
	on(event: 'noteon' | 'noteoff' | 'cc', listener: (note: number, value: number, info: { channel: number }) => void): unknown;
}

export interface MidiInputState {
	port: string;
	connected: boolean;
	connecting: boolean;
	error: string;
}

export type MidiNoteEvent = { type: 'noteOn'; channel: number; note: number; velocity: number }
	| { type: 'noteOff'; channel: number; note: number }
	| { type: 'allOff'; channel?: number };

export async function createMidiInput(): Promise<MidiInputPort> {
	const { Input } = await import('@julusian/midi');
	return new Input();
}

export class MidiInputConnection {
	private input?: MidiInputPort;
	private generation = 0;
	private held = new Set<number>();
	private snapshot: MidiInputState = { port: '', connected: false, connecting: false, error: '' };

	constructor(private readonly onState: (state: MidiInputState) => void,
		private readonly createInput: () => Promise<MidiInputPort> = createMidiInput,
		private readonly onNotes: (notes: number[]) => void = () => {},
		private readonly onNoteEvent: (event: MidiNoteEvent) => void = () => {}) {}

	get state(): MidiInputState { return { ...this.snapshot }; }
	get notes(): number[] { return [...new Set([...this.held].map(note => note % 128))].sort((first, second) => first - second); }

	async connect(port: string): Promise<void> {
		this.disconnect();
		const generation = this.generation;
		this.snapshot = { port, connected: false, connecting: true, error: '' };
		this.onState(this.state);
		let input: MidiInputPort | undefined;
		try {
			input = await this.createInput();
			if (generation !== this.generation) { input.destroy(); return; }
			const index = Array.from({ length: input.getPortCount() }, (_, index) => input!.getPortName(index)).indexOf(port);
			if (!port || index < 0) { throw new Error('MIDI input port is no longer available.'); }
			const source = input;
			input.ignoreTypes(true, true, true);
			input.on('noteon', (note, velocity, info) => {
				if (this.input === source && Number.isInteger(velocity) && velocity >= 0 && velocity <= 127) {
						this.setNote(note, info.channel, velocity > 0, velocity);
				}
			});
			input.on('noteoff', (note, _velocity, info) => {
				if (this.input === source) { this.setNote(note, info.channel, false); }
			});
			input.on('cc', (parameter, _value, info) => {
				if (this.input !== source || !Number.isInteger(info.channel) || info.channel < 0 || info.channel > 15) { return; }
				if (parameter === 120 || (parameter >= 123 && parameter <= 127)) {
						this.onNoteEvent({ type: 'allOff', channel: info.channel });
					for (const note of this.held) { if (Math.floor(note / 128) === info.channel) { this.held.delete(note); } }
					this.onNotes(this.notes);
				}
			});
			this.input = input;
			input.openPort(index);
			this.snapshot = { port, connected: true, connecting: false, error: '' };
			this.onState(this.state);
		} catch (failure) {
			if (this.input === input) { this.input = undefined; }
			try { input?.destroy(); } catch { }
			if (generation !== this.generation) { return; }
			this.held.clear();
			this.onNotes([]);
			this.snapshot = { port: '', connected: false, connecting: false,
				error: failure instanceof Error ? failure.message : 'Could not connect MIDI input.' };
			this.onState(this.state);
		}
	}

	disconnect(error = ''): void {
		this.generation++;
		const input = this.input;
		this.input = undefined;
		this.held.clear();
		this.onNoteEvent({ type: 'allOff' });
		try { input?.destroy(); } catch (failure) {
			error = failure instanceof Error ? failure.message : 'Could not close MIDI input.';
		}
		this.snapshot = { port: '', connected: false, connecting: false, error };
		this.onNotes([]);
		this.onState(this.state);
	}

	private setNote(note: number, channel: number, active: boolean, velocity = 0): void {
		if (!Number.isInteger(note) || note < 0 || note > 127 || !Number.isInteger(channel) || channel < 0 || channel > 15) { return; }
		this.onNoteEvent(active ? { type: 'noteOn', channel, note, velocity } : { type: 'noteOff', channel, note });
		const key = channel * 128 + note;
		if (this.held.has(key) === active) { return; }
		if (active) { this.held.add(key); } else { this.held.delete(key); }
		this.onNotes(this.notes);
	}
}