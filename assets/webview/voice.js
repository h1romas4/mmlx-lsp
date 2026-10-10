import { createVoiceControls } from './voiceControls.js';
import { createPlaybackControls } from './playbackControls.js';
import { createSettingsControls } from './settingsControls.js';
import { createKeyboardControls } from './keyboardControls.js';
import { createOutputConnection } from './outputConnection.js';
import { createEmulationAudio } from './emulationAudio.js';
import { createAudioMonitors } from './audioMonitors.js';

const vscode = acquireVsCodeApi();
let outputId = 0;
let resettingOutput = false;
let playbackId = 0;
let playbackOperation = 0;
let playbackState = null;
let playbackOrigin = 0;
let nanoDriveConnected = false;
const playbackAudio = createEmulationAudio(
	blocks => vscode.postMessage({ type: 'playbackRender', id: playbackId, blocks }),
	error => {
		playbackOperation++; playbackAudio.disconnect();
		vscode.postMessage({ type: 'playbackAction', action: 'stop', id: playbackId, error });
		playbackState = { ...playbackState, playing: false, paused: false, loading: false, error };
		playbackControls.render(playbackState);
	},
	() => vscode.postMessage({ type: 'playbackAction', action: 'ended', id: playbackId }),
	position => {
		const consumed = playbackOrigin + position;
		playbackControls.setPosition(consumed);
		if (playbackState?.playing && playbackMode === 'emulation') {
			vscode.postMessage({ type: 'playbackPosition', id: playbackId, mode: playbackMode, position: consumed });
		}
	});
const emulationAudio = createEmulationAudio(
	blocks => vscode.postMessage({ type: 'emulationRender', id: outputId, blocks }),
	error => {
		emulationAudio.disconnect();
		audioMonitors.setConnected(false);
		keyboardControls.setConnected(false);
		outputConnections.keyboard.setState({ connected: false, connecting: false, error });
		vscode.postMessage({ type: 'setOutputConnection', target: 'keyboard', id: outputId, mode: 'emulation', connected: false });
	});
const audioMonitors = createAudioMonitors(document.getElementById('audio-monitors'), () => emulationAudio.readAnalysis(), () => saveState());
const voiceControls = createVoiceControls(document.getElementById('voice-controls'), message => vscode.postMessage(message));
const playbackControls = createPlaybackControls(document.getElementById('playback-controls'), mode => {
	playbackMode = mode;
	saveState();
	sendPlaybackVolume();
}, action => { void playbackAction(action); }, volume => {
	playbackAudio.setVolume(volume); saveState(); sendPlaybackVolume();
}, muted => {
	saveState(); vscode.postMessage({ type: 'playbackMute', id: playbackId, mode: playbackMode, muted });
});
const settingsControls = createSettingsControls(document.getElementById('settings-controls'), message => vscode.postMessage(message));
const keyboardControls = createKeyboardControls(document.getElementById('keyboard'), mode => {
	keyboardMode = mode;
	saveState();
	}, note => { if (note.event !== 'pitchBend') { audioMonitors.setNote(note); } vscode.postMessage({ type: 'emulationNote', id: outputId, ...note }); },
	(action, mml) => {
		keyboardControls.releaseAll();
		if (action === 'play') { keyboardControls.setVoiceTest(true); }
		saveState();
		vscode.postMessage({ type: 'voiceTestAction', id: outputId, action, mml });
	});
const outputConnections = {
	keyboard: createOutputConnection(document.querySelector('.keyboard-output'), async request => {
		if (request.reset) {
			resettingOutput = true;
			keyboardControls.releaseAll(); keyboardControls.setResetting(true); keyboardControls.setVoiceTest(false);
			emulationAudio.clear(); outputConnections.keyboard.setResetting(true);
			vscode.postMessage({ type: 'resetOutput', id: outputId, mode: request.mode });
			return;
		}
		if (!request.connected) {
			keyboardControls.setConnected(false); emulationAudio.disconnect();
			audioMonitors.setConnected(false);
			vscode.postMessage({ type: 'setOutputConnection', target: 'keyboard', id: outputId, ...request });
			return;
		}
		outputId++;
		const id = outputId;
		outputConnections.keyboard.setState({ connected: false, connecting: true });
		if (request.mode !== 'emulation') {
			emulationAudio.disconnect(); audioMonitors.setConnected(false);
			vscode.postMessage({ type: 'setOutputConnection', target: 'keyboard', id, ...request });
			return;
		}
		try {
			const sampleRate = await emulationAudio.connect();
			if (id === outputId) { vscode.postMessage({ type: 'setOutputConnection', target: 'keyboard', id, ...request, sampleRate }); }
		} catch (error) {
			if (id !== outputId) { return; }
			emulationAudio.disconnect();
			audioMonitors.setConnected(false);
			outputConnections.keyboard.setState({ connected: false, connecting: false, error: String(error) });
		}
	})
};
for (const id of ['keyboard-reset', 'voice-test-play']) {
	const button = document.getElementById(id);
	button.addEventListener('click', () => {
		if (button.disabled) { return; }
		for (const animation of button.getAnimations({ subtree: true })) {
			if (animation.id.startsWith('chip-action-')) { animation.cancel(); }
		}
		const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const accent = 'var(--vscode-focusBorder, #39a9c7)';
		const ring = button.animate(reducedMotion
			? [{ boxShadow: `0 0 0 2px ${accent}` }, { boxShadow: `0 0 0 2px ${accent}` }]
			: [{ boxShadow: `0 0 0 0 ${accent}` }, { boxShadow: `0 0 0 2px ${accent}`, offset: .25 }, { boxShadow: '0 0 0 5px transparent' }],
			{ duration: 600, easing: 'ease-out' });
		ring.id = 'chip-action-ring';
		if (id === 'keyboard-reset' && !reducedMotion) {
			const turn = button.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
				{ duration: 600, easing: 'cubic-bezier(.22, 1, .36, 1)', pseudoElement: '::before' });
			turn.id = 'chip-action-turn';
		}
	}, { capture: true });
}
document.getElementById('open-starter').addEventListener('click', () => vscode.postMessage({ type: 'openStarter' }));
const tabs = ['start', 'voice', 'playback', 'settings'];
const saved = vscode.getState();
let snapshot = saved?.type === 'voice' ? { ...saved, editable: false, editToken: null, editing: false }
	: { type: 'voice', voice: null, source: '', retained: false, error: false };
let activeTab = tabs.includes(saved?.activeTab) ? saved.activeTab : 'start';
let playbackMode = saved?.playbackMode === 'nanodrive8' ? 'nanodrive8' : 'emulation';
let keyboardMode = saved?.keyboardMode === 'nanodrive8' ? 'nanodrive8' : 'emulation';
const algorithms = document.getElementById('algorithms');
algorithms.open = saved?.algorithmsOpen !== false;
algorithms.addEventListener('toggle', () => saveState());
const keyboard = document.getElementById('keyboard');
keyboard.open = saved?.keyboardOpen !== false;
keyboard.addEventListener('toggle', () => saveState());

function saveState() {
	vscode.setState({ ...snapshot, activeTab, algorithmsOpen: algorithms.open, playbackMode,
		playbackLooped: playbackControls.looped, playbackVolume: playbackControls.volume * 100, playbackMuted: playbackControls.muted, playbackSoloed: playbackControls.soloed, keyboardOpen: keyboard.open, keyboardMode, monitorGain: audioMonitors.gain, voiceTestMml: keyboardControls.testMml });
}

function sendPlaybackVolume() {
	if (playbackMode === 'nanodrive8') {
		vscode.postMessage({ type: 'playbackVolume', mode: playbackMode, volume: playbackControls.volume });
	}
}

async function playbackAction(action) {
	if (action === 'stop') {
		playbackOperation++; playbackAudio.disconnect();
		vscode.postMessage({ type: 'playbackAction', action, id: playbackId });
		playbackState = { ...playbackState, playing: false, paused: false, loading: false, position: 0, error: '' };
		playbackControls.render(playbackState); return;
	}
	const operation = ++playbackOperation;
	try {
		if (action === 'play' || action === 'playFromCursor') {
			const id = ++playbackId;
			const document = playbackState?.document;
			playbackState = { ...playbackState, playing: false, paused: false, loading: true, startAction: action, position: 0, finished: false, error: '' };
			playbackControls.render(playbackState);
			if (playbackMode === 'nanodrive8' && action === 'playFromCursor') { return; }
			const sampleRate = playbackMode === 'nanodrive8' ? undefined : await playbackAudio.connect();
			if (operation !== playbackOperation) { return; }
			vscode.postMessage({ type: 'playbackAction', action, mode: playbackMode, id, document, sampleRate, looped: playbackControls.looped, volume: playbackControls.volume, muted: playbackControls.outputMuted });
		} else {
			if (action === 'pause') { await playbackAudio.pause(); }
			else if (action === 'resume') { await playbackAudio.resume(); }
			if (operation === playbackOperation) { vscode.postMessage({ type: 'playbackAction', action, id: playbackId }); }
		}
	} catch (error) {
		if (operation !== playbackOperation) { return; }
		playbackAudio.disconnect();
		vscode.postMessage({ type: 'playbackAction', action: 'stop', id: playbackId, error: String(error) });
		playbackState = { ...playbackState, playing: false, paused: false, loading: false, error: String(error) };
		playbackControls.render(playbackState);
	}
}

function selectTab(name, focus = false) {
	activeTab = name;
	for (const tab of tabs) {
		const selected = tab === name;
		const button = document.getElementById(`${tab}-tab`);
		button.setAttribute('aria-selected', String(selected));
		button.tabIndex = selected ? 0 : -1;
		document.getElementById(`${tab}-controls`).hidden = !selected;
		if (selected && focus) { button.focus(); }
	}
	saveState();
}

for (const tab of tabs) {
	const button = document.getElementById(`${tab}-tab`);
	button.addEventListener('click', () => selectTab(tab));
	button.addEventListener('keydown', event => {
		if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { return; }
		event.preventDefault();
		const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
			: (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
		selectTab(tabs[index], true);
	});
}

window.addEventListener('message', event => {
	const message = event.data;
	if (message?.type === 'voice') {
		snapshot = message;
		voiceControls.render(message);
		keyboardControls.setVoiceAvailable(!!message.voice && !message.error);
		saveState();
	} else if (message?.type === 'voiceTest' && message.id === outputId) {
		keyboardControls.setVoiceTest(message.playing, message.error);
	} else if (message?.type === 'outputReset' && message.id === outputId) {
		resettingOutput = false;
		emulationAudio.clear(); outputConnections.keyboard.setState({ connected: message.connected, connecting: false });
		outputConnections.keyboard.setResetting(false);
		keyboardControls.setVoiceTest(false); keyboardControls.setOutputReset(message.connected);
		keyboardControls.setConnected(message.connected); keyboardControls.setResetting(false);
		if (!message.connected) { emulationAudio.disconnect(); audioMonitors.setConnected(false); }
	} else if (message?.type === 'playback') {
		const changed = message.document !== playbackState?.document;
		if (!changed && message.id !== playbackId) { return; }
		if (changed || !message.available) { playbackOperation++; playbackAudio.disconnect(); }
		if (message.mode !== 'nanodrive8' && !message.playing && !message.paused) { playbackOrigin = message.position || 0; }
		playbackState = message;
		playbackControls.render(message);
		if (message.mode === 'nanodrive8') { playbackAudio.disconnect(); }
		else if (message.playing) { playbackAudio.start(); if (message.finished) { playbackAudio.finish(); } }
		else if (!message.paused && !message.loading) { playbackAudio.disconnect(); }
	} else if (message?.type === 'playbackKeys' && message.id === playbackId && message.mode === playbackMode) {
		playbackControls.enqueueKeys(message.keys);
	} else if (message?.type === 'nanoDrivePlayback') {
		outputConnections.keyboard.setNanoDriveBusy(message.busy);
	} else if (message?.type === 'playbackPcm' && message.id === playbackId && playbackMode === 'emulation') {
		playbackAudio.pcm(message.pcm);
	} else if (message?.type === 'midiNotes') {
		keyboardControls.setMidiNotes(message.notes);
		audioMonitors.setMidiNotes(message.notes);
	} else if (message?.type === 'midiNote') {
		audioMonitors.setNote(message.event, 'midi');
	} else if (message?.type === 'pitchBend') {
		keyboardControls.setPitchBend(message.value);
	} else if (message?.type === 'outputConnection' && message.target === 'keyboard'
		&& typeof message.connected === 'boolean') {
		if (message.target === 'keyboard') {
			if (message.id !== outputId || resettingOutput) { return; }
			keyboardControls.setConnected(message.connected && !message.connecting);
			if (message.connected && message.mode !== 'nanodrive8') { emulationAudio.start(); audioMonitors.setConnected(true); }
			else if (message.connected) { emulationAudio.disconnect(); audioMonitors.setConnected(false); }
			else if (!message.connecting) { keyboardControls.releaseAll(); emulationAudio.disconnect(); audioMonitors.setConnected(false); }
		}
		outputConnections.keyboard.setState(message);
	} else if (message?.type === 'emulationPcm' && message.id === outputId) {
		emulationAudio.pcm(message.pcm);
	} else if (message?.type === 'buildSettings' || message?.type === 'serialSettings' || message?.type === 'midiSettings') {
		settingsControls.render(message);
		if (message.type === 'serialSettings') {
			const connected = message.connected === true && !message.closing;
			outputConnections.keyboard.setNanoDriveAvailable(connected);
			playbackControls.setNanoDriveAvailable(connected);
			if (connected && !nanoDriveConnected) {
				if (playbackState?.playing || playbackState?.paused || playbackState?.loading) { void playbackAction('stop'); }
				playbackMode = 'nanodrive8'; playbackControls.setMode(playbackMode); saveState();
				sendPlaybackVolume();
			}
			nanoDriveConnected = connected;
		}
		if (message.type === 'midiSettings') { keyboardControls.setMidiState(message); }
	}
});
window.addEventListener('pagehide', () => { audioMonitors.dispose(); emulationAudio.disconnect(); playbackAudio.disconnect(); });
voiceControls.render(snapshot);
keyboardControls.setVoiceAvailable(!!snapshot.voice && !snapshot.error);
keyboardControls.setTestMml(saved?.voiceTestMml);
document.getElementById('voice-test-mml').addEventListener('input', saveState);
playbackControls.setMode(playbackMode);
playbackControls.setOptions(saved?.playbackLooped, saved?.playbackVolume ?? 100);
playbackControls.setMuted(saved?.playbackMuted);
playbackControls.setSoloed(saved?.playbackSoloed);
playbackAudio.setVolume(playbackControls.volume);
playbackControls.render(null);
keyboardControls.setMode(keyboardMode);
outputConnections.keyboard.setConnected(false);
audioMonitors.setGain(saved?.monitorGain ?? 4);
selectTab(activeTab);
vscode.postMessage({ type: 'ready' });