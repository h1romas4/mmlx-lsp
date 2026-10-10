export const algorithmConnections = [
		{ edges: [[0, 1], [1, 2], [2, 3]], carriers: [3], positions: [[24, 52], [64, 52], [104, 52], [144, 52]] },
		{ edges: [[0, 2], [1, 2], [2, 3]], carriers: [3], positions: [[24, 28], [24, 76], [84, 52], [144, 52]] },
		{ edges: [[0, 3], [1, 2], [2, 3]], carriers: [3], positions: [[24, 28], [24, 76], [84, 76], [144, 52]], bendX: 114 },
		{ edges: [[0, 1], [1, 3], [2, 3]], carriers: [3], positions: [[24, 28], [84, 28], [84, 76], [144, 52]] },
		{ edges: [[0, 1], [2, 3]], carriers: [1, 3], positions: [[24, 28], [104, 28], [24, 76], [104, 76]] },
		{ edges: [[0, 1], [0, 2], [0, 3]], carriers: [1, 2, 3], positions: [[24, 52], [104, 20], [104, 52], [104, 84]] },
		{ edges: [[0, 1]], carriers: [1, 2, 3], positions: [[24, 28], [104, 28], [104, 59], [104, 90]] },
		{ edges: [], carriers: [0, 1, 2, 3], positions: [[36, 22], [36, 45], [36, 68], [36, 91]] }
];

export function connectionPath(start, end, endRadius = 12, bendX) {
	const startX = start[0] + 12;
	const endX = end[0] - endRadius;
	const middleX = bendX ?? (startX + endX) / 2;
	return start[1] === end[1]
		? `M ${startX} ${start[1]} H ${endX}`
		: `M ${startX} ${start[1]} H ${middleX} V ${end[1]} H ${endX}`;
}

export function envelopeHandlePositions(operator) {
	const attack = 0.05 + Math.pow(1 - operator.ar / 31, 2) * 0.2;
	const decay = attack + 0.06 + Math.pow(1 - operator.d1r / 31, 2) * 0.25;
	const held = operator.tl * 0.75 + (operator.d1r === 0 ? 0 : operator.d1l === 15 ? 93 : operator.d1l * 3);
	const end = operator.d1r === 0 ? held : held - 40 * Math.log10(1 - operator.d2r / 31);
	const levelY = attenuation => operator.ar === 0 ? 116 : 16 + Math.min(100, attenuation / 96 * 100);
	return {
		attack: [12 + attack * 296, levelY(operator.tl * 0.75)],
		decay: [12 + decay * 296, levelY(held)],
		keyoff: [234, levelY(end)],
		release: [12 + (0.8 + Math.pow(1 - operator.rr / 15, 2) * 0.2) * 296, 116]
	};
}

export function envelopeAttackPoints(operator) {
	const [endX, endY] = envelopeHandlePositions(operator).attack;
	if (operator.ar === 0) { return [[12, 116], [endX, 116]]; }
	if (operator.ar === 31) { return [[12, 116], [12, endY], [endX, endY]]; }
	let attenuation = 0x3ff;
	const levels = [attenuation];
	while (attenuation > 0) {
		attenuation -= Math.ceil((attenuation + 1) / 16);
		levels.push(attenuation);
	}
	const points = levels.map((level, index) => [
		12 + (endX - 12) * index / (levels.length - 1),
		16 + Math.min(100, (operator.tl * 0.75 + level / 0x3ff * 96) / 96 * 100)
	]);
	points[points.length - 1] = [endX, endY];
	return points;
}

export function dragEnvelope(operator, kind, deltaX, deltaY) {
	const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
	if (kind === 'attack') {
		const time = Math.pow(1 - operator.ar / 31, 2) + deltaX / (296 * 0.2);
		return { ...operator, ar: Math.round(31 * (1 - Math.sqrt(clamp(time, 0, 1)))),
			tl: clamp(Math.round(operator.tl + deltaY * 96 / (100 * 0.75)), 0, 127) };
	}
	if (kind === 'decay') {
		const time = Math.pow(1 - operator.d1r / 31, 2) + deltaX / (296 * 0.25);
		const d1r = Math.round(31 * (1 - Math.sqrt(clamp(time, 0, 1))));
		const attenuation = (operator.d1l === 15 ? 93 : operator.d1l * 3) + deltaY * 96 / 100;
		const levels = Array.from({ length: 16 }, (_, level) => level === 15 ? 93 : level * 3);
		const d1l = levels.reduce((best, level, index) =>
			Math.abs(level - attenuation) < Math.abs(levels[best] - attenuation) ? index : best, operator.d1l);
		return { ...operator, d1r, d1l: d1r === 0 ? operator.d1l : d1l };
	}
	if (kind === 'keyoff') {
		if (operator.d1r === 0 || deltaY === 0) { return { ...operator }; }
		const positionY = envelopeHandlePositions(operator).keyoff[1] + deltaY;
		const held = operator.tl * 0.75 + (operator.d1l === 15 ? 93 : operator.d1l * 3);
		const attenuation = (positionY - 16) * 96 / 100 - held;
		return { ...operator, d2r: positionY >= 116 ? 31
			: Math.round(31 * (1 - Math.pow(10, -Math.max(0, attenuation) / 40))) };
	}
	const time = Math.pow(1 - operator.rr / 15, 2) + deltaX / (296 * 0.2);
	return { ...operator, rr: Math.round(15 * (1 - Math.sqrt(clamp(time, 0, 1)))) };
}

export function createVoiceControls(root, onEdit = () => {}) {
	const namespace = 'http://www.w3.org/2000/svg';
	const fields = ['ar', 'd1r', 'd2r', 'rr', 'd1l', 'tl', 'ks', 'mul', 'dt1', 'dt2', 'ame'];
	const displayFields = ['mul', 'tl', 'dt1', 'dt2', 'ar', 'd1r', 'd1l', 'd2r', 'rr', 'ks', 'ame'];
	const limits = [31, 31, 31, 15, 15, 127, 3, 15, 7, 3, 1];
	const handleFields = { attack: ['ar', 'tl'], decay: ['d1r', 'd1l'], keyoff: [null, 'd2r'], release: ['rr', null] };
	const operators = root.querySelector('#operators');
	const algorithms = root.querySelector('#algorithms');
	const elements = [];
	const diagrams = [];
	const inputs = [];
	const voicePanel = root;
	let snapshot;
	let drag;
	let pendingVoice;
	const algorithm = root.querySelector('#algorithm');
	for (let index = 0; index < 8; index++) {
		const option = document.createElement('option');
		option.value = index;
		option.textContent = index;
		algorithm.append(option);
	}

	function bindInput(input, index, readValue = () => input.type === 'checkbox' ? Number(input.checked)
		: input.tagName === 'SELECT' ? Number(input.value) : input.valueAsNumber) {
		input.dataset.parameter = index;
		input.disabled = true;
		inputs.push(input);
		input.addEventListener('change', () => {
			if (drag || !snapshot?.editable || !Number.isInteger(snapshot.editToken)) {
				if (snapshot && !drag) { render(snapshot); }
				return;
			}
			const value = readValue();
			if (!Number.isInteger(value) || !input.checkValidity()) { input.reportValidity(); render(snapshot); return; }
			const previous = index < 44 ? snapshot.voice.operators[Math.floor(index / 11)][fields[index % 11]]
				: snapshot.voice[index === 44 ? 'algorithm' : index === 45 ? 'feedback' : 'operatorMask'];
			if (value === previous) { return; }
			const token = snapshot.editToken;
			previewEdit([{ index, value }]);
			onEdit({ type: 'editVoice', token, index, value });
		});
		input.addEventListener('keydown', event => {
			if (event.key === 'Enter' && input.type === 'number') {
				event.preventDefault();
				input.dispatchEvent(new Event('change'));
			}
		});
	}

	bindInput(algorithm, 44);
	bindInput(root.querySelector('#feedback'), 45);
	const maskInputs = [...root.querySelectorAll('#operator-mask input')];
	maskInputs.forEach((input, index) => bindInput(input, 46, () => input.checked
		? snapshot.voice.operatorMask | (1 << index) : snapshot.voice.operatorMask & ~(1 << index)));

	function svgElement(tag, attributes) {
		const element = document.createElementNS(namespace, tag);
		for (const [name, value] of Object.entries(attributes)) { element.setAttribute(name, String(value)); }
		return element;
	}

	function syncOperatorToggle(toggle) {
		const checked = toggle.input.checked;
		const disabled = toggle.input.disabled || toggle.input.getAttribute('aria-disabled') === 'true';
		toggle.control.classList.toggle('is-disabled', toggle.input.disabled);
		toggle.control.classList.toggle('is-active', checked);
		toggle.control.setAttribute('aria-checked', String(checked));
		toggle.control.setAttribute('aria-disabled', String(disabled));
		toggle.control.setAttribute('tabindex', '-1');
	}

	function createOperatorToggle(kind, label, input, x, width) {
		const control = svgElement('g', {
			class: `operator-toggle operator-${kind}-toggle`,
			role: 'switch',
			'aria-label': input.getAttribute('aria-label'),
			'data-parameter': input.dataset.parameter
		});
		if (input.title) { control.setAttribute('aria-description', input.title); }
		const background = svgElement('rect', { x, y: 1, width, height: 14, rx: 2 });
		const text = svgElement('text', { x: x + width / 2, y: 11, 'text-anchor': 'middle' });
		text.textContent = label;
		control.append(background, text);
		const toggle = { control, input };
		const activate = () => {
			if (control.getAttribute('aria-disabled') === 'true') { return; }
			input.checked = !input.checked;
			input.dispatchEvent(new Event('change'));
		};
		control.addEventListener('click', activate);
		control.addEventListener('keydown', event => {
			if (event.key !== ' ' && event.key !== 'Enter') { return; }
			event.preventDefault();
			activate();
		});
		syncOperatorToggle(toggle);
		return toggle;
	}

	function lockControls(disabled) {
		for (const input of inputs) {
			input.disabled = disabled && !voicePanel.classList.contains('voice-editing');
			input.setAttribute('aria-disabled', String(disabled));
		}
		for (const element of elements) {
			for (const toggle of element.toggles) { syncOperatorToggle(toggle); }
		}
		for (const { figure } of diagrams) {
			figure.setAttribute('aria-disabled', String(disabled));
			figure.tabIndex = disabled ? -1 : 0;
		}
		for (const [index, { handles }] of elements.entries()) {
			const operator = snapshot?.voice?.operators[index];
			for (const [kind, handle] of Object.entries(handles)) {
				const inactive = kind === 'keyoff' && (!operator || operator.ar === 0 || operator.d1r === 0
					|| operator.tl * 0.75 + (operator.d1l === 15 ? 93 : operator.d1l * 3) >= 96);
				handle.classList.toggle('edit-locked', disabled && !inactive);
				handle.setAttribute('aria-disabled', String(disabled || inactive));
				handle.setAttribute('tabindex', '-1');
			}
		}
	}

	function releaseDrag() {
		const state = drag;
		drag = undefined;
		if (state) {
			state.handle.classList.remove('dragging');
			if (state.handle.hasPointerCapture(state.pointerId)) { state.handle.releasePointerCapture(state.pointerId); }
		}
		return state;
	}

	function cancelDrag() {
		if (drag) { releaseDrag(); render(snapshot); }
	}

	function commitOperator(index, operator, kind) {
		const original = snapshot.voice.operators[index];
		const changes = handleFields[kind].filter(Boolean)
			.filter(field => operator[field] !== original[field])
			.map(field => ({ index: index * 11 + fields.indexOf(field), value: operator[field] }));
		if (!changes.length) { render(snapshot); return; }
		const token = snapshot.editToken;
		previewEdit(changes);
		onEdit({ type: 'editVoice', token, changes });
	}

	function previewEdit(changes) {
		const voice = { ...snapshot.voice, operators: snapshot.voice.operators.map(operator => ({ ...operator })) };
		for (const { index, value } of changes) {
			if (index < 44) { voice.operators[Math.floor(index / 11)][fields[index % 11]] = value; }
			else { voice[index === 44 ? 'algorithm' : index === 45 ? 'feedback' : 'operatorMask'] = value; }
		}
		pendingVoice = { source: snapshot.source, voice };
		render({ ...snapshot, voice, editable: false, editing: true });
	}

	for (const type of ['pointerdown', 'click', 'keydown', 'beforeinput']) {
		voicePanel.addEventListener(type, event => {
			if (!voicePanel.classList.contains('voice-editing') || (type === 'keydown' && event.key === 'Tab')) { return; }
			if (!event.target.closest('[data-parameter], .algorithm-diagram, .envelope-handle')) { return; }
			event.preventDefault();
			event.stopImmediatePropagation();
		}, true);
	}

	root.addEventListener('keydown', event => { if (event.key === 'Escape') { cancelDrag(); } });
	window.addEventListener('blur', cancelDrag);
	document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelDrag(); } });

	algorithmConnections.forEach((connection, index) => {
		const figure = document.createElement('figure');
		figure.className = 'algorithm-diagram';
		figure.dataset.algorithm = index;
		figure.setAttribute('role', 'button');
		figure.setAttribute('aria-label', `CON ${index}`);
		figure.setAttribute('aria-disabled', 'true');
		figure.tabIndex = -1;
		figure.addEventListener('click', () => {
			if (algorithm.disabled) { return; }
			algorithm.value = index;
			algorithm.dispatchEvent(new Event('change'));
		});
		figure.addEventListener('keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				figure.click();
			}
		});
		const caption = document.createElement('figcaption');
		caption.textContent = `CON ${index}`;
		const current = document.createElement('span');
		current.className = 'algorithm-current';
		current.textContent = 'Current';
		current.hidden = true;
		caption.append(current);
		const graph = svgElement('svg', { viewBox: '0 0 200 112', role: 'img', 'aria-label': `Algorithm ${index}` });
		const description = svgElement('title', {});
		description.textContent = connection.edges.map(([start, end]) => `OP ${start + 1} to OP ${end + 1}`)
			.concat([`Carriers: ${connection.carriers.map(operator => `OP ${operator + 1}`).join(', ')}`, 'Feedback: OP 1']).join('; ');
		graph.append(description);
		const definitions = svgElement('defs', {});
		const marker = svgElement('marker', { id: `algorithm-arrow-${index}`, markerWidth: 5, markerHeight: 5, refX: 4, refY: 2.5, orient: 'auto' });
		marker.append(svgElement('path', { d: 'M 0 0 L 5 2.5 L 0 5 Z', class: 'algorithm-arrow' }));
		definitions.append(marker);
		graph.append(definitions);
		for (const [start, end] of connection.edges) {
			graph.append(svgElement('path', {
				d: connectionPath(connection.positions[start], connection.positions[end], 12, connection.bendX),
				class: 'algorithm-edge', 'data-from': start + 1, 'data-to': end + 1,
				'marker-end': `url(#algorithm-arrow-${index})`
			}));
		}
		for (const operator of connection.carriers) {
			graph.append(svgElement('path', {
				d: connectionPath(connection.positions[operator], [180, 52], 6),
				class: 'algorithm-output', 'data-from': operator + 1,
				'marker-end': `url(#algorithm-arrow-${index})`
			}));
		}
		graph.append(svgElement('circle', { cx: 180, cy: 52, r: 4, class: 'algorithm-sum' }));
		const outputLabel = svgElement('text', { x: 180, y: 74, 'text-anchor': 'middle' });
		outputLabel.textContent = 'OUT';
		graph.append(outputLabel);
		const [feedbackX, feedbackY] = connection.positions[0];
		const feedback = svgElement('path', {
			d: `M ${feedbackX + 12} ${feedbackY} H ${feedbackX + 18} V ${feedbackY - 18} H ${feedbackX - 18} V ${feedbackY} H ${feedbackX - 12}`,
			class: 'algorithm-feedback', 'marker-end': `url(#algorithm-arrow-${index})`
		});
		graph.append(feedback);
		const nodes = connection.positions.map(([x, y], operator) => {
			const node = svgElement('g', {
				class: `algorithm-node op-${operator + 1}${connection.carriers.includes(operator) ? ' carrier' : ''}`,
				'data-operator': operator + 1
			});
			node.append(svgElement('circle', { cx: x, cy: y, r: 10 }));
			const label = svgElement('text', { x, y: y + 4, 'text-anchor': 'middle' });
			label.textContent = operator + 1;
			node.append(label);
			graph.append(node);
			return node;
		});
		figure.append(caption, graph);
		algorithms.querySelector('.algorithm-grid').append(figure);
		diagrams.push({ figure, current, feedback, nodes });
	});

	for (let index = 0; index < 4; index++) {
		const section = document.createElement('section');
		section.className = 'operator';
		const heading = document.createElement('h2');
		const identity = document.createElement('span');
		identity.className = 'operator-identity';
		const badge = svgElement('svg', { class: 'operator-badge', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
		badge.append(svgElement('circle', { cx: 12, cy: 12, r: 10 }));
		const number = svgElement('text', { x: 12, y: 16, 'text-anchor': 'middle' });
		number.textContent = index + 1;
		badge.append(number);
		const role = document.createElement('span');
		role.className = 'operator-role';
		identity.append('OP ', badge, role);
		const graph = svgElement('svg', { viewBox: '0 0 320 145', role: 'group', 'aria-label': `OP ${index + 1} normalized envelope` });
		const toggleBar = svgElement('svg', { class: 'operator-toggle-bar', viewBox: '0 0 86 22', role: 'group', 'aria-label': `OP ${index + 1} toggles` });
		const opToggle = createOperatorToggle('op', 'OP', maskInputs[index], 50, 32);
		graph.append(svgElement('path', { d: 'M 12 16 V 116 H 308 M 12 66 H 308', class: 'axis', fill: 'none' }));
		graph.append(svgElement('path', { d: 'M 234 12 V 116', class: 'key-off' }));
		const curve = svgElement('path', { class: 'envelope', d: '' });
		graph.append(curve);
		for (const [text, x, y, anchor] of [['0 dB', 12, 10, 'start'], ['Key off', 234, 10, 'middle'], ['-96 dB', 12, 137, 'start'], ['Relative time', 308, 137, 'end']]) {
			const label = svgElement('text', { x, y, 'text-anchor': anchor });
			label.textContent = text;
			graph.append(label);
		}
		const handles = {};
		for (const kind of Object.keys(handleFields)) {
			const name = handleFields[kind].filter(Boolean).map(field => field.toUpperCase()).join(' / ');
			const handle = svgElement('g', { class: `envelope-handle ${kind}`, role: 'button',
				'aria-label': `OP ${index + 1} ${name}`, 'aria-disabled': 'true', tabindex: -1 });
			const title = svgElement('title', {});
			title.textContent = name;
			handle.append(title, svgElement('circle', { r: kind === 'keyoff' || kind === 'release' ? 7 : 16, class: 'handle-hit' }),
				svgElement('circle', { r: 5, class: 'handle-dot' }));
			graph.append(handle);
			handles[kind] = handle;
			const point = event => {
				const matrix = graph.getScreenCTM();
				return matrix ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()) : null;
			};
			const move = event => {
				if (drag?.handle !== handle || drag.pointerId !== event.pointerId) { return; }
				const current = point(event);
				if (!current) { cancelDrag(); return; }
				drag.preview = dragEnvelope(drag.operator, kind, current.x - drag.start.x, current.y - drag.start.y);
				drawOperator(drag.preview, index);
			};
			handle.addEventListener('pointerdown', event => {
				if (event.button !== 0 || drag || handle.getAttribute('aria-disabled') === 'true' || !Number.isInteger(snapshot?.editToken)) { return; }
				const start = point(event);
				if (!start) { return; }
				event.preventDefault();
				handle.focus();
				const operator = snapshot.voice.operators[index];
				drag = { handle, pointerId: event.pointerId, start, operator, preview: operator };
				handle.setPointerCapture(event.pointerId);
				handle.classList.add('dragging');
				lockControls(true);
			});
			handle.addEventListener('pointermove', move);
			handle.addEventListener('pointerup', event => {
				if (drag?.handle !== handle || drag.pointerId !== event.pointerId) { return; }
				move(event);
				const state = releaseDrag();
				if (state) { commitOperator(index, state.preview, kind); }
			});
			handle.addEventListener('pointercancel', () => { if (drag?.handle === handle) { cancelDrag(); } });
			handle.addEventListener('lostpointercapture', () => { if (drag?.handle === handle) { cancelDrag(); } });
			handle.addEventListener('keydown', event => {
				if (drag || handle.getAttribute('aria-disabled') === 'true' || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { return; }
				const field = handleFields[kind][['ArrowUp', 'ArrowDown'].includes(event.key) ? 1 : 0];
				if (!field || (field === 'd1l' && snapshot.voice.operators[index].d1r === 0)) { return; }
				event.preventDefault();
				const operator = { ...snapshot.voice.operators[index] };
				const increment = ['ArrowLeft', 'ArrowDown'].includes(event.key) ? 1 : -1;
				operator[field] = Math.max(0, Math.min(limits[fields.indexOf(field)], operator[field] + increment));
				commitOperator(index, operator, kind);
			});
		}
		const list = document.createElement('dl');
		const values = {};
		for (const field of displayFields) {
			const fieldIndex = fields.indexOf(field);
			const pair = document.createElement('div');
			if (field === 'rr') { pair.className = 'single-parameter'; }
			if (field === 'ame') { pair.hidden = true; }
			const term = document.createElement('dt');
			term.textContent = field.toUpperCase();
			const value = document.createElement('dd');
			const input = document.createElement(field === 'mul' || field === 'ks' || field === 'dt2' ? 'select' : 'input');
			if (field === 'mul' || field === 'ks' || field === 'dt2') {
				for (let optionValue = 0; optionValue <= limits[fieldIndex]; optionValue++) {
					const option = document.createElement('option');
					option.value = optionValue;
					option.textContent = `${optionValue}: ${field === 'mul' ? `x${optionValue === 0 ? 0.5 : optionValue}`
						: field === 'dt2' ? `${[0, 600, 781, 950][optionValue]}c` : ['Min', 'Low', 'Med', 'High'][optionValue]}`;
					if (field === 'ks') { option.title = ['Minimal', 'Low', 'Medium', 'High'][optionValue]; }
					if (field === 'dt2') { option.title = `${[0, 600, 781, 950][optionValue]} cents of coarse detune`; }
					input.append(option);
				}
				input.title = field === 'mul' ? 'Frequency multiplier; 0 means half the base frequency'
					: field === 'dt2' ? 'Coarse detune in cents (c); 100 cents = 1 semitone. 0: None, 1: +600, 2: +781, 3: +950 cents'
						: 'Key scaling: higher notes speed up the envelope. 0: Minimal, 1: Low, 2: Medium, 3: High';
			} else {
				input.type = field === 'ame' ? 'checkbox' : 'number';
				if (field === 'ame') {
					input.setAttribute('role', 'switch');
					input.title = 'LFO amplitude modulation for this operator; also depends on LFO and AMS settings';
				} else {
					input.min = 0;
					input.max = limits[fieldIndex];
					input.step = 1;
					input.required = true;
				}
			}
			input.setAttribute('aria-label', `OP ${index + 1} ${field.toUpperCase()}`);
			bindInput(input, index * 11 + fieldIndex);
			if (field === 'ame') {
				const label = document.createElement('label');
				label.className = 'parameter-toggle';
				label.title = input.title;
				label.append(input, document.createElement('span'));
				value.append(label);
			} else { value.append(input); }
			values[field] = input;
			pair.append(term, value);
			list.append(pair);
		}
		if (index === 0) {
			const feedback = root.querySelector('#feedback');
			const feedbackLabel = feedback.closest('label');
			const feedbackPair = document.createElement('div');
			const term = document.createElement('dt');
			term.textContent = 'FL';
			const value = document.createElement('dd');
			value.append(feedback);
			feedbackPair.append(term, value);
			values.ks.parentElement.parentElement.after(feedbackPair);
			feedbackLabel.remove();
		}
		const ameToggle = createOperatorToggle('ame', 'AME', values.ame, 0, 46);
		toggleBar.append(ameToggle.control, opToggle.control);
		heading.append(identity, toggleBar);
		section.append(heading, graph, list);
		operators.append(section);
		elements.push({ section, heading, badge, role, curve, values, handles, toggles: [opToggle, ameToggle] });
	}

	function envelope(operator) {
		const x = time => 12 + time * 296;
		const y = level => level <= 0 ? 116 : 16 + Math.min(100, -20 * Math.log10(level) / 96 * 100);
		const peak = Math.pow(10, -operator.tl * 0.75 / 20);
		const attack = 0.05 + Math.pow(1 - operator.ar / 31, 2) * 0.2;
		const decay = attack + 0.06 + Math.pow(1 - operator.d1r / 31, 2) * 0.25;
		const sustain = peak * Math.pow(10, -(operator.d1l === 15 ? 93 : operator.d1l * 3) / 20);
		const held = operator.d1r === 0 ? peak : sustain;
		const end = operator.d1r === 0 ? peak : held * Math.pow(1 - operator.d2r / 31, 2);
		const release = 0.75 + 0.05 + Math.pow(1 - operator.rr / 15, 2) * 0.2;
		if (operator.ar === 0) { return 'M 12 116 H 308'; }
		const attackPath = envelopeAttackPoints(operator).map(([positionX, positionY], index) =>
			`${index === 0 ? 'M' : 'L'} ${positionX} ${positionY}`).join(' ');
		return `${attackPath} `
			+ `L ${x(decay)} ${y(held)} L 234 ${y(end)} L ${x(release)} 116 H 308`;
	}

	function drawOperator(operator, index) {
		const element = elements[index];
		for (const field of fields) {
			const input = element.values[field];
			if (input.type === 'checkbox') {
				input.checked = operator[field] !== 0;
				input.nextElementSibling.textContent = input.checked ? 'On' : 'Off';
			} else { input.value = operator[field]; }
		}
		element.curve.setAttribute('d', envelope(operator));
		const positions = envelopeHandlePositions(operator);
		for (const [kind, handle] of Object.entries(element.handles)) {
			const [positionX, positionY] = positions[kind];
			handle.setAttribute('transform', `translate(${positionX} ${positionY})`);
			handle.setAttribute('aria-description', handleFields[kind].filter(Boolean)
				.map(field => `${field.toUpperCase()} ${operator[field]}`).join(', '));
		}
	}

	function render(message) {
		if (message?.type !== 'voice') { return; }
		releaseDrag();
		if (pendingVoice && message.editing && !message.error && !message.retained
			&& message.source === pendingVoice.source && message.voice?.number === pendingVoice.voice.number) {
			message = { ...message, voice: pendingVoice.voice };
		} else { pendingVoice = undefined; }
		snapshot = message;
		const voice = message.voice;
		const editing = !!voice && !!message.editing && !message.error && !message.retained;
		voicePanel.classList.toggle('voice-editing', editing);
		voicePanel.setAttribute('aria-busy', String(editing));
		lockControls(!voice || !message.editable || !!message.retained || !!message.error);
		root.querySelector('#status').textContent = message.error ? 'Unavailable'
			: voice ? (message.retained ? 'Retained' : '') : 'No voice selected';
		const voiceName = root.querySelector('#voice-name');
		voiceName.textContent = voice ? `@${voice.number}` : 'Move the cursor to a voice definition.';
		voiceName.classList.toggle('empty', !voice);
		root.querySelector('#source').textContent = voice ? message.source : '';
		root.querySelector('#summary').hidden = !voice;
		algorithms.hidden = !voice;
		operators.hidden = !voice;
		if (!voice) { return; }
		algorithm.value = voice.algorithm;
		root.querySelector('#feedback').value = voice.feedback;
		maskInputs.forEach((input, index) => { input.checked = (voice.operatorMask & (1 << index)) !== 0; });
		diagrams.forEach((diagram, index) => {
			const selected = index === voice.algorithm;
			diagram.figure.classList.toggle('selected', selected);
			diagram.figure.setAttribute('aria-pressed', String(selected));
			if (selected) { diagram.figure.setAttribute('aria-current', 'true'); }
			else { diagram.figure.removeAttribute('aria-current'); }
			diagram.current.hidden = !selected;
			diagram.feedback.classList.toggle('inactive', voice.feedback === 0);
			diagram.nodes.forEach((node, operator) => node.classList.toggle('inactive', (voice.operatorMask & (1 << operator)) === 0));
		});
		voice.operators.forEach((operator, index) => {
			const element = elements[index];
			const enabled = (voice.operatorMask & (1 << index)) !== 0;
			const carrier = algorithmConnections[voice.algorithm].carriers.includes(index);
			element.section.classList.toggle('disabled', !enabled);
			element.badge.classList.toggle('carrier', carrier);
			element.role.textContent = carrier ? 'Carrier' : 'Modulator';
			element.heading.setAttribute('aria-label', `OP ${index + 1} ${element.role.textContent}${enabled ? '' : ', Off'}`);
			element.badge.classList.toggle('inactive', !enabled);
			drawOperator(operator, index);
			for (const toggle of element.toggles) { syncOperatorToggle(toggle); }
		});
	}

	return { render };
}