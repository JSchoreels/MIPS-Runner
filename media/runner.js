'use strict';

const vscode = acquireVsCodeApi();
const DATA_BASE = 0x10000000;
const STACK_TOP = 0x80000000;
const REGISTER_NAMES = [
    'zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3',
    't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
    's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7',
    't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra'
];
const elements = Object.fromEntries([
    'program-name', 'program-status', 'run', 'step', 'reset',
    'panels', 'registers', 'register-filter', 'pointer-links', 'pointer-paths', 'pointer-trace',
    'data-target', 'data-form', 'data-address', 'data-rows',
    'stack-form', 'stack-address', 'stack-rows', 'stack-warning', 'follow-stack',
    'stdin', 'output', 'log'
].map(id => [id, document.getElementById(id)]));

let state = { ready: false, sourceAvailable: false };
elements['register-filter'].value = vscode.getState()?.registerFilter || 'all';
let registerSelectionRevision = 0;
const hex = value => '0x' + (value >>> 0).toString(16).padStart(8, '0');
const aligned = value => (value & 0xfffffffc) >>> 0;
const isDataAddress = (address, data) => address >= DATA_BASE && address < DATA_BASE + data.length;
const isStackAddress = (address, stack) => state.stackSafe && address >= STACK_TOP - stack.length * 4 && address < STACK_TOP;
const action = (type, fields = {}) => vscode.postMessage({ type: 'simulatorAction', action: { type, ...fields } });

function updateButtons() {
    const runnable = state.ready && ((state.loaded && !state.stale && !state.finished) ||
        (state.sourceAvailable && state.stale && !state.running));
    elements.run.disabled = !runnable;
    elements.run.textContent = state.running ? 'Pause' : 'Run';
    elements.step.disabled = !runnable || state.running;
    elements.reset.disabled = !state.ready || !state.sourceAvailable || state.running;
}

function changedAt(previousRows, row) {
    const old = previousRows?.find(item => item.address === row.address);
    return old && old.value !== row.value;
}

function lastChangeElement(change, address) {
    const link = address !== undefined && Number.isInteger(change?.sourceLine);
    const element = document.createElement(link ? 'button' : 'span');
    element.className = 'last-change';
    if (!change) {
        element.textContent = '—';
        element.title = 'No change since assembly';
    } else if (Number.isInteger(change.sourceLine)) {
        element.textContent = `L${change.sourceLine + 1}`;
        element.title = `Last changed at line ${change.sourceLine + 1}: ${change.sourceText || hex(change.address)}`;
        if (link) {
            element.type = 'button';
            element.dataset.selectMemory = String(address);
            element.setAttribute('aria-label', `${element.title}. Show in source.`);
        }
    } else {
        element.textContent = hex(change.address);
        element.title = `Last changed by instruction at ${hex(change.address)}; source line unavailable`;
    }
    return element;
}

function renderRegisters(snapshot) {
    const focused = elements.registers.contains(document.activeElement) ? document.activeElement.dataset.register : undefined;
    const fragment = document.createDocumentFragment();
    const filter = elements['register-filter'].value;
    const visible = filter === 'source' ? new Set(state.sourceRegisters || [])
        : filter === 'executed' ? new Set(state.accessedRegisters || []) : undefined;
    snapshot.registers.forEach((value, index) => {
        if (visible && !visible.has(index)) return;
        const navigable = isDataAddress(value, snapshot.data) || isStackAddress(value, snapshot.stack);
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'register-row';
        row.dataset.registerIndex = String(index);
        row.dataset.register = String(index);
        if (state.previous && state.previous.registers[index] !== value) row.classList.add('changed');
        if (state.selectedRegister === index) row.classList.add('selected-pointer');
        row.setAttribute('aria-label', navigable
            ? `Highlight $${REGISTER_NAMES[index]} in source and follow its possible address: ${hex(value)}`
            : `Highlight $${REGISTER_NAMES[index]} in source: ${hex(value)}`);
        row.setAttribute('aria-pressed', String(state.selectedRegister === index));
        const name = document.createElement('span');
        name.className = 'register-name';
        name.textContent = '$' + REGISTER_NAMES[index];
        const combinedValue = document.createElement('span');
        combinedValue.className = 'register-value';
        const displayedValue = document.createElement('span');
        if (navigable) displayedValue.className = 'register-pointer';
        displayedValue.textContent = hex(value);
        const decimal = document.createElement('span');
        decimal.className = 'decimal';
        decimal.textContent = ` (${value | 0})`;
        combinedValue.append(displayedValue, decimal);
        const change = lastChangeElement(snapshot.registerChanges?.[index]);
        row.title = change.title;
        row.append(name, combinedValue, change);
        fragment.append(row);
    });
    if (!fragment.hasChildNodes()) {
        const empty = document.createElement('p');
        empty.className = 'register-empty';
        empty.textContent = filter === 'executed' ? 'No registers have been accessed yet.' : 'No registers are referenced in the loaded code.';
        fragment.append(empty);
    }
    elements.registers.replaceChildren(fragment);
    if (focused !== undefined) elements.registers.querySelector(`[data-register="${focused}"]`)?.focus({ preventScroll: true });
}

function revealSelectedRegister() {
    const row = elements.registers.querySelector(`[data-register-index="${state.selectedRegister}"]`);
    row?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderMemory(container, rows, previousRows, segment, snapshot) {
    const focused = container.contains(document.activeElement) ? document.activeElement.dataset.selectMemory : undefined;
    const fragment = document.createDocumentFragment();
    const path = snapshot.pointerTrace?.entries || [];
    rows.forEach(row => {
        const line = document.createElement('div');
        line.className = 'memory-row';
        line.dataset.memoryAddress = String(row.address);
        line.dataset.segment = segment;
        const pathIndex = path.findIndex(entry => entry.wordAddress === row.address && entry.segment === segment);
        if (pathIndex === 0) line.classList.add('pointed');
        else if (pathIndex > 0) line.classList.add('linked-target');
        else if (segment === 'stack' && !path.length && aligned(snapshot.registers[29]) === row.address) line.classList.add('stack-top');
        if (changedAt(previousRows, row)) line.classList.add('changed');
        const address = document.createElement(row.value === undefined ? 'span' : 'button');
        address.className = 'address';
        address.textContent = row.address <= 0xffffffff ? hex(row.address) : '—';
        if (row.value !== undefined) {
            address.type = 'button';
            address.dataset.selectMemory = String(row.address);
            address.setAttribute('aria-label', `Select memory at ${hex(row.address)} and highlight its source`);
        }
        const pointer = row.value !== undefined && (isDataAddress(row.value, snapshot.data) || isStackAddress(row.value, snapshot.stack));
        const value = document.createElement(pointer ? 'button' : 'span');
        if (pointer) {
            value.type = 'button';
            value.className = 'memory-pointer';
            value.dataset.selectMemory = String(row.address);
            value.setAttribute('aria-label', `Follow possible pointer at ${hex(row.address)} to ${hex(row.value)}`);
        }
        value.textContent = row.value === undefined ? '—' : hex(row.value);
        if (pointer) value.textContent = `↗ ${value.textContent}`;
        const combinedValue = document.createElement('span');
        combinedValue.className = 'memory-value';
        combinedValue.append(value);
        if (row.value !== undefined) {
            const decimal = document.createElement('span');
            decimal.className = 'decimal';
            decimal.textContent = ` (${row.value | 0})`;
            combinedValue.append(decimal);
        }
        line.append(address, combinedValue, lastChangeElement(row.lastChange, row.value === undefined ? undefined : row.address));
        fragment.append(line);
    });
    container.replaceChildren(fragment);
    if (focused !== undefined) container.querySelector(`[data-select-memory="${focused}"]`)?.focus({ preventScroll: true });
}

function renderPointerTrace(snapshot) {
    const trace = snapshot.pointerTrace;
    const container = elements['pointer-trace'];
    const focused = container.contains(document.activeElement) ? document.activeElement.dataset.inspectAddress : undefined;
    container.setAttribute('aria-live', state.running ? 'off' : 'polite');
    if (!trace) {
        container.textContent = 'Select a register or memory value that looks like an address.';
        return;
    }
    const fragment = document.createDocumentFragment();
    const label = document.createElement('span');
    label.className = 'trace-label';
    label.textContent = 'Following';
    fragment.append(label);
    if (state.selectedRegister !== undefined) {
        const register = document.createElement('strong');
        register.textContent = `$${REGISTER_NAMES[state.selectedRegister]}`;
        fragment.append(register);
    } else if (state.selectedSymbol !== undefined) {
        const symbol = document.createElement('strong');
        symbol.textContent = state.selectedSymbol;
        fragment.append(symbol);
    }
    for (const entry of trace.entries) {
        const arrow = document.createElement('span');
        arrow.className = 'trace-arrow';
        arrow.textContent = '→';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'trace-address';
        button.dataset.inspectAddress = String(entry.address);
        button.textContent = `${entry.segment === 'data' ? 'data' : 'stack'} ${hex(entry.address)}`;
        button.setAttribute('aria-label', `Show ${entry.segment} address ${hex(entry.address)}`);
        fragment.append(arrow, button);
    }
    const ending = document.createElement('span');
    ending.className = 'trace-ending';
    const last = trace.entries.at(-1);
    if (trace.reason === 'value' && last) ending.textContent = `→ ${hex(last.value)} (${last.value | 0})`;
    else if (trace.reason === 'cycle') ending.textContent = `↩ ${hex(trace.cycleAddress)} (cycle)`;
    else if (trace.reason === 'unaligned') ending.textContent = '(unaligned address; showing its containing word)';
    else if (trace.reason === 'limit') ending.textContent = '→ … (trace limit)';
    else if (trace.reason === 'unavailable') ending.textContent = 'is outside available data and stack memory';
    if (ending.textContent) fragment.append(ending);
    container.replaceChildren(fragment);
    if (focused !== undefined) container.querySelector(`[data-inspect-address="${focused}"]`)?.focus({ preventScroll: true });
}

function drawPointerLinks() {
    const paths = elements['pointer-paths'];
    paths.replaceChildren();
    const trace = state.current?.pointerTrace;
    if (!trace?.entries.length) return;
    const bounds = elements.panels.getBoundingClientRect();
    const registers = elements.registers.getBoundingClientRect();
    const firstRow = elements.panels.querySelector(`[data-memory-address="${trace.entries[0].wordAddress}"][data-segment="${trace.entries[0].segment}"]`);
    const register = state.selectedRegister === undefined ? undefined : elements.registers.querySelector(`[data-register="${state.selectedRegister}"]`);
    elements['pointer-links'].setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
    const addPath = (d, className, marker) => {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        path.setAttribute('class', className);
        path.setAttribute('marker-end', `url(#${marker})`);
        paths.append(path);
    };
    if (register && firstRow) {
        const from = register.getBoundingClientRect();
        const to = firstRow.getBoundingClientRect();
        if (from.top >= registers.top && from.bottom <= registers.bottom && to.left > from.right + 4) {
            const x1 = from.right - bounds.left + 1, y1 = from.top + from.height / 2 - bounds.top;
            const x2 = to.left - bounds.left - 3, y2 = to.top + to.height / 2 - bounds.top;
            const bend = (x1 + x2) / 2;
            addPath(`M ${x1} ${y1} C ${bend} ${y1}, ${bend} ${y2}, ${x2} ${y2}`, 'register-link', 'register-arrow');
        }
    }
    const entries = trace.entries.slice();
    if (trace.reason === 'cycle') {
        const cycle = trace.entries.find(entry => entry.address === trace.cycleAddress);
        if (cycle) entries.push(cycle);
    }
    for (let i = 1; i < entries.length; i++) {
        const before = elements.panels.querySelector(`[data-memory-address="${entries[i - 1].wordAddress}"][data-segment="${entries[i - 1].segment}"]`);
        const after = elements.panels.querySelector(`[data-memory-address="${entries[i].wordAddress}"][data-segment="${entries[i].segment}"]`);
        if (!before || !after || before === after) continue;
        const from = before.getBoundingClientRect(), to = after.getBoundingClientRect();
        const x1 = from.right - bounds.left + 1, y1 = from.top + from.height / 2 - bounds.top;
        const x2 = to.right - bounds.left + 1, y2 = to.top + to.height / 2 - bounds.top;
        const lane = Math.max(x1, x2) + 12 + Math.min(i - 1, 2) * 3;
        if (lane >= bounds.width - 1) continue;
        addPath(`M ${x1} ${y1} C ${lane} ${y1}, ${lane} ${y2}, ${x2} ${y2}`, 'memory-link', 'memory-arrow');
    }
}

let linkFrame;
function schedulePointerLinks() {
    cancelAnimationFrame(linkFrame);
    linkFrame = requestAnimationFrame(drawPointerLinks);
}

function updateText(element, value) {
    if (element.textContent !== value) {
        element.textContent = value;
        element.scrollTop = element.scrollHeight;
    }
}

function render() {
    elements['program-name'].textContent = state.sourceName || 'No program loaded';
    elements['program-status'].textContent = state.status;
    if (document.activeElement !== elements.stdin) elements.stdin.value = state.inputText;
    updateText(elements.output, state.output);
    updateText(elements.log, state.log);
    updateButtons();
    if (!state.current) return;
    const snapshot = state.current;
    const selected = state.selectedRegister === undefined ? undefined : snapshot.registers[state.selectedRegister];
    renderRegisters(snapshot);
    if (state.registerSelectionRevision !== registerSelectionRevision) {
        registerSelectionRevision = state.registerSelectionRevision;
        if (state.selectedRegister !== undefined) revealSelectedRegister();
    }
    renderMemory(elements['data-rows'], snapshot.dataRows, state.previous?.dataRows, 'data', snapshot);
    renderMemory(elements['stack-rows'], snapshot.stackRows, state.previous?.stackRows, 'stack', snapshot);
    renderPointerTrace(snapshot);
    elements['data-target'].textContent = state.selectedSymbol !== undefined ? `${state.selectedSymbol} → ${hex(state.selectedAddress)}`
        : selected !== undefined && isDataAddress(selected, snapshot.data) ? `$${REGISTER_NAMES[state.selectedRegister]} → ${hex(selected)}` : '';
    if (document.activeElement !== elements['data-address']) elements['data-address'].value = hex(state.dataAddress);
    if (document.activeElement !== elements['stack-address']) elements['stack-address'].value = hex(state.stackAddress);
    elements['stack-warning'].hidden = state.stackSafe;
    elements['stack-warning'].textContent = state.stackSafe ? '' : 'The stack expanded beyond the range exposed by this SPIM build; stack values are unavailable.';
    schedulePointerLinks();
}

elements.run.addEventListener('click', () => action('run'));
elements.step.addEventListener('click', () => action('step'));
elements.reset.addEventListener('click', () => action('reset'));
elements.stdin.addEventListener('input', () => action('input', { text: elements.stdin.value }));
for (const kind of ['data', 'stack']) {
    elements[`${kind}-form`].addEventListener('submit', event => {
        event.preventDefault();
        action('address', { kind, text: elements[`${kind}-address`].value });
    });
}
elements['follow-stack'].addEventListener('click', () => action('followStack'));
elements['register-filter'].addEventListener('change', () => {
    vscode.setState({ ...vscode.getState(), registerFilter: elements['register-filter'].value });
    if (state.current) {
        renderRegisters(state.current);
        if (state.selectedRegister !== undefined) revealSelectedRegister();
        schedulePointerLinks();
    }
});
elements.registers.addEventListener('click', event => {
    const button = event.target.closest('[data-register]');
    if (button) action('selectRegister', { index: Number(button.dataset.register) });
});
for (const kind of ['data', 'stack']) {
    elements[`${kind}-rows`].addEventListener('click', event => {
        const button = event.target.closest('[data-select-memory]');
        if (button) action('selectMemory', { address: Number(button.dataset.selectMemory) });
    });
}
elements['pointer-trace'].addEventListener('click', event => {
    const button = event.target.closest('[data-inspect-address]');
    if (button) action('inspectAddress', { address: Number(button.dataset.inspectAddress) });
});
elements.registers.addEventListener('scroll', schedulePointerLinks);
window.addEventListener('resize', schedulePointerLinks);
new ResizeObserver(schedulePointerLinks).observe(elements.panels);
window.addEventListener('message', event => {
    if (event.data?.type !== 'update') return;
    state = event.data.state;
    render();
});
vscode.postMessage({ type: 'ready' });
