import type { NanoDriveConnection, NanoDriveState, NanoDriveOutputState, NanoDrivePlaybackState } from './nanodrive';
import type { FmKeyEvent } from './emulationProtocol';

export type NanoDriveController = Pick<NanoDriveConnection, keyof NanoDriveConnection>;
export type NanoDriveProcessCommand = Exclude<keyof NanoDriveController, 'state' | 'outputState' | 'playbackState'> | 'dispose';
export type HostMessage = { type: 'call'; id: number; method: NanoDriveProcessCommand; args: unknown[] }
    | { type: 'pdx'; id: number; bytes?: Uint8Array; error?: string };
export type ClientMessage = { type: 'reply'; id: number; error?: string }
    | { type: 'state'; state: NanoDriveState } | { type: 'output'; state: NanoDriveOutputState }
    | { type: 'playback'; state: NanoDrivePlaybackState } | { type: 'diagnostic'; message: string }
    | { type: 'voiceTest'; playing: boolean; error?: boolean } | { type: 'keys'; keys: FmKeyEvent[] }
    | { type: 'loadPdx'; id: number; name: string };
