import { createVoiceControls } from './voiceControls.js';
import { createPlaybackControls } from './playbackControls.js';
import { createSettingsControls } from './settingsControls.js';
import { createKeyboardControls } from './keyboardControls.js';
import { createOutputConnection } from './outputConnection.js';

const vscode = acquireVsCodeApi();
const voiceControls = createVoiceControls(document.getElementById('voice-controls'), message => vscode.postMessage(message));
const playbackControls = createPlaybackControls(document.getElementById('playback-controls'), mode => {
	playbackMode = mode;
	saveState();
});
const settingsControls = createSettingsControls(document.getElementById('settings-controls'), message => vscode.postMessage(message));
const keyboardControls = createKeyboardControls(document.getElementById('keyboard'), mode => {
	keyboardMode = mode;
	saveState();
});
const outputConnections = {
	playback: createOutputConnection(document.querySelector('.playback-options'), request => {
		vscode.postMessage({ type: 'setOutputConnection', target: 'playback', ...request });
	}),
	keyboard: createOutputConnection(document.querySelector('.keyboard-output'), request => {
		vscode.postMessage({ type: 'setOutputConnection', target: 'keyboard', ...request });
	})
};
const tabs = ['voice', 'playback', 'settings'];
const saved = vscode.getState();
let snapshot = saved?.type === 'voice' ? { ...saved, editable: false, editToken: null, editing: false }
	: { type: 'voice', voice: null, source: '', retained: false, error: false };
let activeTab = tabs.includes(saved?.activeTab) ? saved.activeTab : 'voice';
let playbackMode = saved?.playbackMode === 'nanodrive8' ? 'nanodrive8' : 'emulation';
let keyboardMode = saved?.keyboardMode === 'nanodrive8' ? 'nanodrive8' : 'emulation';
const algorithms = document.getElementById('algorithms');
algorithms.open = saved?.algorithmsOpen !== false;
algorithms.addEventListener('toggle', () => saveState());
const keyboard = document.getElementById('keyboard');
keyboard.open = saved?.keyboardOpen !== false;
keyboard.addEventListener('toggle', () => saveState());

function saveState() {
	vscode.setState({ ...snapshot, activeTab, algorithmsOpen: algorithms.open, playbackMode, keyboardOpen: keyboard.open, keyboardMode });
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
		saveState();
	} else if (message?.type === 'playback') {
		playbackControls.render(message);
	} else if (message?.type === 'outputConnection' && ['playback', 'keyboard'].includes(message.target)
		&& typeof message.connected === 'boolean') {
		outputConnections[message.target].setConnected(message.connected);
	} else if (message?.type === 'buildSettings' || message?.type === 'serialSettings' || message?.type === 'midiSettings') {
		settingsControls.render(message);
	}
});
voiceControls.render(snapshot);
playbackControls.setMode(playbackMode);
playbackControls.render(null);
keyboardControls.setMode(keyboardMode);
selectTab(activeTab);
vscode.postMessage({ type: 'ready' });