'use strict';

var Module = (() => {
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
    'program-name', 'program-status', 'load', 'assemble', 'run', 'step', 'reset',
    'registers', 'data-target', 'data-form', 'data-address', 'data-rows',
    'stack-form', 'stack-address', 'stack-rows', 'stack-warning', 'follow-stack',
    'instructions', 'stdin', 'output', 'log'
].map(id => [id, document.getElementById(id)]));

const state = {
    ready: false,
    source: undefined,
    sourceName: '',
    sourceId: undefined,
    lastLocation: undefined,
    stale: false,
    loaded: false,
    finished: false,
    running: false,
    timer: undefined,
    skipBreakpoint: false,
    assembling: false,
    assemblyError: false,
    input: [],
    inputPosition: 0,
    stackBaseOffset: undefined,
    stackSafe: true,
    dataAddress: 0x10010000,
    stackAddress: 0,
    followStack: true,
    selectedRegister: undefined,
    instructions: [],
    breakpoints: new Set(),
    previous: undefined,
    current: undefined
};

function hex(value) {
    return '0x' + (value >>> 0).toString(16).padStart(8, '0');
}

function aligned(value) {
    return (value & 0xfffffffc) >>> 0;
}

function appendLine(element, value) {
    element.textContent += String(value) + '\n';
    if (element.textContent.length > 100000) element.textContent = element.textContent.slice(-100000);
    element.scrollTop = element.scrollHeight;
}

function status(message) {
    elements['program-status'].textContent = message;
}

function updateButtons() {
    const runnable = state.ready && state.loaded && !state.stale && !state.finished;
    elements.assemble.disabled = !state.ready || state.source === undefined || state.running;
    elements.run.disabled = !runnable;
    elements.run.textContent = state.running ? 'Pause' : 'Run';
    elements.step.disabled = !runnable || state.running;
    elements.reset.disabled = !state.ready || state.source === undefined || state.stale || state.running;
}

function stopRunning() {
    state.running = false;
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = undefined;
}

function isDataAddress(address, data) {
    return address >= DATA_BASE && address < DATA_BASE + data.length;
}

function isStackAddress(address, stack) {
    return state.stackSafe && address >= STACK_TOP - stack.length * 4 && address < STACK_TOP;
}

function capture() {
    const registers = Array.from(Module.getGeneralRegVals(), value => value >>> 0);
    const data = Module.getUserData();
    const stack = Module.getStack();
    const pc = Module.getSpecialRegVals()[0] >>> 0;
    if (state.stackBaseOffset === undefined) state.stackBaseOffset = stack.byteOffset;
    if (stack.byteOffset !== state.stackBaseOffset) state.stackSafe = false;

    if (state.selectedRegister !== undefined) {
        const address = registers[state.selectedRegister];
        if (isDataAddress(address, data)) state.dataAddress = aligned(address);
        if (isStackAddress(address, stack)) {
            state.stackAddress = aligned(address);
            state.followStack = state.selectedRegister === 29;
        }
    }
    if (state.followStack && isStackAddress(registers[29], stack)) {
        state.stackAddress = aligned(registers[29]);
    }

    const dataRows = [];
    const stackRows = [];
    for (let i = 0; i < 8; i++) {
        const dataAddress = state.dataAddress + i * 4;
        const stackAddress = state.stackAddress + i * 4;
        dataRows.push({
            address: dataAddress,
            value: isDataAddress(dataAddress, data) ? data[(dataAddress - DATA_BASE) / 4] >>> 0 : undefined
        });
        stackRows.push({
            address: stackAddress,
            value: isStackAddress(stackAddress, stack) ? stack[stack.length - (STACK_TOP - stackAddress) / 4] >>> 0 : undefined
        });
    }
    return { registers, pc, data, stack, dataRows, stackRows };
}

function changedAt(previousRows, row) {
    const old = previousRows?.find(item => item.address === row.address);
    return old && old.value !== row.value;
}

function readInstructions(listing, source) {
    const sourceLines = source.split(/\r?\n/);
    const instructions = [];
    let previousAddress;
    let sourceLine;
    for (const text of listing.split('\n')) {
        const match = text.match(/^\*?\[0x([0-9a-f]{8})\]\s+0x([0-9a-f]{8})/i);
        if (!match) continue;
        const address = Number.parseInt(match[1], 16) >>> 0;
        const marker = text.match(/;\s*(\d+):\s*(.*)$/);
        if (marker) {
            const line = Number(marker[1]) - 1;
            const original = sourceLines[line]?.trim();
            const withoutLabels = original?.replace(/^(?:[A-Za-z_.$][A-Za-z0-9_.$]*\s*:\s*)+/, '');
            sourceLine = original === marker[2].trim() || withoutLabels === marker[2].trim() ? line : undefined;
        } else if (previousAddress === undefined || address !== previousAddress + 4) {
            sourceLine = undefined;
        }
        instructions.push({
            address,
            encoding: Number.parseInt(match[2], 16) >>> 0,
            text: text.replace(/^\*/, '').trim(),
            sourceLine,
            sourceText: marker?.[2]
        });
        previousAddress = address;
    }
    return instructions;
}

// SPIM enters its bundled startup routine before jumping to the user's main.
// Advance only when the exact startup sequence and its user-code target are known.
function prepareEntryPoint() {
    const pc = Module.getSpecialRegVals()[0] >>> 0;
    const expected = ['lw $a0 0($sp)', 'addiu $a1 $sp 4', 'addiu $a2 $a1 4',
        'sll $v0 $a0 2', 'addu $a2 $a2 $v0', 'jal main'];
    const startup = expected.map((_, index) => state.instructions.find(item => item.address === pc + index * 4));
    if (startup.some((item, index) => !item || item.sourceLine !== undefined ||
        item.sourceText?.split('#')[0].trim().replace(/\s+/g, ' ') !== expected[index])) return;
    const target = (((startup[5].address + 4) & 0xf0000000) | ((startup[5].encoding & 0x03ffffff) << 2)) >>> 0;
    if (!state.instructions.some(item => item.address === target && item.sourceLine !== undefined)) return;
    for (const item of startup) {
        if ((Module.getSpecialRegVals()[0] >>> 0) !== item.address || Module.step(1, true) !== 1) break;
    }
}

function publishExecutionLocation() {
    if (state.sourceId === undefined) return;
    const line = state.loaded && !state.stale && !state.finished && state.current
        ? state.instructions.find(item => item.address === state.current.pc)?.sourceLine ?? null : null;
    const location = `${line}:${state.running}`;
    if (location === state.lastLocation) return;
    state.lastLocation = location;
    vscode.postMessage({ type: 'executionLocation', sourceId: state.sourceId, line, running: state.running });
}

function renderRegisters(snapshot) {
    const fragment = document.createDocumentFragment();
    snapshot.registers.forEach((value, index) => {
        const row = document.createElement('div');
        row.className = 'register-row';
        if (state.previous && state.previous.registers[index] !== value) row.classList.add('changed');
        const name = document.createElement('span');
        name.className = 'register-name';
        name.textContent = '$' + REGISTER_NAMES[index];
        const navigable = isDataAddress(value, snapshot.data) || isStackAddress(value, snapshot.stack);
        const displayedValue = document.createElement(navigable ? 'button' : 'span');
        displayedValue.textContent = hex(value);
        if (navigable) {
            displayedValue.type = 'button';
            displayedValue.className = 'register-pointer';
            displayedValue.dataset.register = String(index);
            displayedValue.setAttribute('aria-label', `Inspect the address in $${REGISTER_NAMES[index]}: ${hex(value)}`);
            if (state.selectedRegister === index) displayedValue.classList.add('selected-pointer');
        }
        const decimal = document.createElement('span');
        decimal.className = 'decimal';
        decimal.textContent = String(value | 0);
        row.append(name, displayedValue, decimal);
        fragment.append(row);
    });
    elements.registers.replaceChildren(fragment);
}

function renderMemory(container, rows, previousRows, selectedAddress) {
    const fragment = document.createDocumentFragment();
    rows.forEach(row => {
        const line = document.createElement('div');
        line.className = 'memory-row';
        if (selectedAddress !== undefined && aligned(selectedAddress) === row.address) line.classList.add('pointed');
        if (changedAt(previousRows, row)) line.classList.add('changed');
        const address = document.createElement('span');
        address.className = 'address';
        address.textContent = row.address <= 0xffffffff ? hex(row.address) : '—';
        const value = document.createElement('span');
        value.textContent = row.value === undefined ? '—' : hex(row.value);
        const decimal = document.createElement('span');
        decimal.className = 'decimal';
        decimal.textContent = row.value === undefined ? '—' : String(row.value | 0);
        line.append(address, value, decimal);
        fragment.append(line);
    });
    container.replaceChildren(fragment);
}

function renderInstructions(snapshot) {
    const fragment = document.createDocumentFragment();
    state.instructions.forEach(instruction => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'instruction';
        button.dataset.address = String(instruction.address);
        if (instruction.address === snapshot.pc) button.classList.add('current-instruction');
        if (state.breakpoints.has(instruction.address)) button.classList.add('breakpoint');
        button.setAttribute('aria-pressed', String(state.breakpoints.has(instruction.address)));
        button.textContent = `${state.breakpoints.has(instruction.address) ? '●' : '○'} ${instruction.text}`;
        fragment.append(button);
    });
    elements.instructions.replaceChildren(fragment);
}

function render() {
    if (!state.current) {
        publishExecutionLocation();
        updateButtons();
        return;
    }
    const snapshot = state.current;
    const selected = state.selectedRegister === undefined ? undefined : snapshot.registers[state.selectedRegister];
    renderRegisters(snapshot);
    renderMemory(elements['data-rows'], snapshot.dataRows, state.previous?.dataRows,
        selected !== undefined && isDataAddress(selected, snapshot.data) ? selected : undefined);
    renderMemory(elements['stack-rows'], snapshot.stackRows, state.previous?.stackRows,
        selected !== undefined && isStackAddress(selected, snapshot.stack) ? selected : snapshot.registers[29]);
    renderInstructions(snapshot);
    elements['data-target'].textContent = selected !== undefined && isDataAddress(selected, snapshot.data)
        ? `$${REGISTER_NAMES[state.selectedRegister]} → ${hex(selected)}` : '';
    if (document.activeElement !== elements['data-address']) elements['data-address'].value = hex(state.dataAddress);
    if (document.activeElement !== elements['stack-address']) elements['stack-address'].value = hex(state.stackAddress);
    elements['stack-warning'].hidden = state.stackSafe;
    elements['stack-warning'].textContent = state.stackSafe ? '' : 'The stack expanded beyond the range exposed by this SPIM build; stack values are unavailable.';
    publishExecutionLocation();
    updateButtons();
}

function refresh() {
    state.previous = state.current;
    state.current = capture();
    render();
}

function assemble() {
    if (!state.ready || state.source === undefined) return;
    stopRunning();
    state.loaded = false;
    state.finished = false;
    state.stale = false;
    state.skipBreakpoint = false;
    state.assemblyError = false;
    state.assembling = true;
    state.stackBaseOffset = undefined;
    state.stackSafe = true;
    state.dataAddress = 0x10010000;
    state.followStack = true;
    state.selectedRegister = undefined;
    state.breakpoints.clear();
    state.current = undefined;
    state.previous = undefined;
    state.input = Array.from(new TextEncoder().encode(elements.stdin.value));
    state.inputPosition = 0;
    elements.output.textContent = '';
    elements.log.textContent = '';
    try {
        FS.writeFile('input.s', state.source);
        Module.init();
        state.assembling = false;
        state.loaded = !state.assemblyError;
        state.instructions = readInstructions(Module.getUserText(), state.source);
        if (state.loaded) prepareEntryPoint();
        state.current = capture();
        status(state.assemblyError ? 'Assembly error — see SPIM log.' : `Ready · PC ${hex(state.current.pc)}`);
        render();
    } catch (error) {
        state.assembling = false;
        state.loaded = false;
        appendLine(elements.log, error.stack || error);
        status('Unable to assemble — see SPIM log.');
        publishExecutionLocation();
        updateButtons();
    }
}

function executeStep(ignoreBreakpoint) {
    try {
        const result = Module.step(1, ignoreBreakpoint);
        if (result === -1) {
            state.skipBreakpoint = true;
            stopRunning();
            status('Paused at breakpoint.');
        } else if (result === 0) {
            state.finished = true;
            state.skipBreakpoint = false;
            stopRunning();
            status('Execution finished.');
        } else {
            state.skipBreakpoint = false;
        }
        return result;
    } catch (error) {
        stopRunning();
        state.loaded = false;
        appendLine(elements.log, error.stack || error);
        status('Execution stopped — see SPIM log.');
        publishExecutionLocation();
        return 0;
    }
}

function step() {
    if (!state.loaded || state.stale || state.finished || state.running) return;
    const result = executeStep(true);
    if (state.loaded) {
        refresh();
        if (result === 1) status(`Paused · PC ${hex(state.current.pc)}`);
    } else updateButtons();
}

function runChunk() {
    if (!state.running) return;
    for (let i = 0; i < 100 && state.running; i++) executeStep(state.skipBreakpoint);
    if (state.loaded) refresh();
    else updateButtons();
    if (state.running) {
        status(`Running · PC ${hex(state.current.pc)}`);
        state.timer = setTimeout(runChunk, 0);
    }
}

function toggleRun() {
    if (state.running) {
        stopRunning();
        status(`Paused · PC ${hex(state.current.pc)}`);
        publishExecutionLocation();
        updateButtons();
        return;
    }
    if (!state.loaded || state.stale || state.finished) return;
    state.running = true;
    updateButtons();
    state.timer = setTimeout(runChunk, 0);
}

function changeAddress(event, kind) {
    event.preventDefault();
    if (!state.current) return;
    const input = elements[`${kind}-address`];
    const text = input.value.trim();
    if (!/^(?:0x)?[0-9a-f]{1,8}$/i.test(text)) {
        status('Enter a hexadecimal 32-bit address.');
        return;
    }
    const address = Number.parseInt(text.replace(/^0x/i, ''), 16) >>> 0;
    const valid = kind === 'data' ? isDataAddress(address, state.current.data) : isStackAddress(address, state.current.stack);
    if (!valid) {
        status(`Address ${hex(address)} is outside the available ${kind} range.`);
        return;
    }
    state.selectedRegister = undefined;
    if (kind === 'data') state.dataAddress = aligned(address);
    else {
        state.stackAddress = aligned(address);
        state.followStack = false;
    }
    state.current = capture();
    state.previous = undefined;
    status(`Viewing ${hex(address)}.`);
    render();
}

elements.load.addEventListener('click', () => vscode.postMessage({ type: 'loadActiveFile' }));
elements.assemble.addEventListener('click', () => vscode.postMessage({ type: 'reloadSource' }));
elements.run.addEventListener('click', toggleRun);
elements.step.addEventListener('click', step);
elements.reset.addEventListener('click', assemble);
elements['data-form'].addEventListener('submit', event => changeAddress(event, 'data'));
elements['stack-form'].addEventListener('submit', event => changeAddress(event, 'stack'));
elements['follow-stack'].addEventListener('click', () => {
    if (!state.current) return;
    state.selectedRegister = 29;
    state.followStack = true;
    state.current = capture();
    state.previous = undefined;
    status(`Following $sp · ${hex(state.current.registers[29])}`);
    render();
});
elements.registers.addEventListener('click', event => {
    const button = event.target.closest('[data-register]');
    if (!button || !state.current) return;
    state.selectedRegister = Number(button.dataset.register);
    state.current = capture();
    state.previous = undefined;
    status(`Following $${REGISTER_NAMES[state.selectedRegister]} · ${hex(state.current.registers[state.selectedRegister])}`);
    render();
});
elements.instructions.addEventListener('click', event => {
    const button = event.target.closest('[data-address]');
    if (!button || !state.loaded) return;
    const address = Number(button.dataset.address);
    if (state.breakpoints.has(address)) {
        Module.deleteBreakpoint(address);
        state.breakpoints.delete(address);
    } else {
        Module.addBreakpoint(address);
        state.breakpoints.add(address);
    }
    render();
});

window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'source' && typeof message.text === 'string' && typeof message.name === 'string') {
        state.source = message.text;
        state.sourceName = message.name;
        state.sourceId = message.sourceId;
        state.lastLocation = undefined;
        elements['program-name'].textContent = message.name;
        if (state.ready) assemble();
        else status('Loading the SPIM runtime…');
    } else if (message.type === 'sourceChanged' && state.source !== undefined) {
        stopRunning();
        state.stale = true;
        status('Source changed — assemble again to apply edits.');
        publishExecutionLocation();
        updateButtons();
    }
});

vscode.postMessage({ type: 'ready' });

return {
    locateFile(name) {
        if (name === 'wasm.wasm') return document.querySelector('meta[name="spim-wasm"]').content;
        if (name === 'wasm.data') return document.querySelector('meta[name="spim-data"]').content;
        return name;
    },
    stdin() {
        return state.inputPosition < state.input.length ? state.input[state.inputPosition++] : null;
    },
    print(text) {
        appendLine(elements.output, text);
    },
    printErr(text) {
        const message = String(text);
        appendLine(elements.log, message.startsWith('Based on <a ') ? message.replace(/<[^>]+>/g, '') : message);
        if (state.assembling && /\(parser\)\s+(?!warning:)/i.test(message)) state.assemblyError = true;
    },
    onRuntimeInitialized() {
        state.ready = true;
        if (state.source !== undefined && !state.stale) assemble();
        else if (state.stale) {
            status('Source changed — assemble again to apply edits.');
            updateButtons();
        }
        else {
            status('Open a MIPS file, then choose Load active file.');
            updateButtons();
        }
    },
    onAbort(reason) {
        stopRunning();
        state.loaded = false;
        status('SPIM could not start — see the log.');
        appendLine(elements.log, reason);
        updateButtons();
    }
};
})();
