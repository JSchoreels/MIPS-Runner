'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parentPort } = require('worker_threads');
const { performance } = require('perf_hooks');

const DATA_BASE = 0x10000000;
const STACK_TOP = 0x80000000;
const MAX_POINTER_HOPS = 8;
const { REGISTER_NAMES } = require('./registers');
const { collectSourceRegisters } = require('./source-symbols');
const state = {
    ready: false, source: undefined, sourceName: '', sourceId: undefined, lastLocation: undefined,
    stale: false, loaded: false, finished: false, running: false, timer: undefined,
    skipBreakpoint: false, ignoreBreakpoints: false, assembling: false, assemblyError: false,
    inputText: '', input: [], inputPosition: 0, stackBaseOffset: undefined, stackSafe: true,
    dataAddress: 0x10010000, stackAddress: 0, followStack: true, selectedRegister: undefined, selectedAddress: undefined, selectedSymbol: undefined,
    registerSelectionRevision: 0, breakpointRevision: 0, executionRevision: 0, executionReason: undefined,
    instructions: [], instructionByAddress: new Map(), sourceRegisters: [], accessedRegisterMask: 0, breakpoints: new Set(), previous: undefined, current: undefined,
    status: 'Loading the SPIM runtime…', output: '', log: ''
};

let context;
const hex = value => '0x' + (value >>> 0).toString(16).padStart(8, '0');
const aligned = value => (value & 0xfffffffc) >>> 0;
const isDataAddress = (address, data) => address >= DATA_BASE && address < DATA_BASE + data.length;
const isStackAddress = (address, stack) => state.stackSafe && address >= STACK_TOP - stack.length * 4 && address < STACK_TOP;

function appendLine(field, value) {
    state[field] += String(value) + '\n';
    if (state[field].length > 100000) state[field] = state[field].slice(-100000);
}

function snapshotForView(snapshot) {
    if (!snapshot) return undefined;
    return {
        registers: snapshot.registers, registerChanges: snapshot.registerChanges, pc: snapshot.pc,
        data: { length: snapshot.data.length }, stack: { length: snapshot.stack.length },
        dataRows: snapshot.dataRows, stackRows: snapshot.stackRows, pointerTrace: snapshot.pointerTrace
    };
}

function publish() {
    if (state.sourceId !== undefined) {
        const line = state.loaded && !state.stale && !state.finished && state.current
            ? state.instructions.find(item => item.address === state.current.pc)?.sourceLine ?? null : null;
        const location = `${line}:${state.running}`;
        if (location !== state.lastLocation) {
            state.lastLocation = location;
            parentPort.postMessage({ type: 'executionLocation', sourceId: state.sourceId, line, running: state.running });
        }
    }
    parentPort.postMessage({ type: 'update', state: {
        ready: state.ready, sourceId: state.sourceId, sourceName: state.sourceName, sourceAvailable: state.source !== undefined,
        stale: state.stale, loaded: state.loaded, finished: state.finished, running: state.running,
        stackSafe: state.stackSafe, dataAddress: state.dataAddress, stackAddress: state.stackAddress,
        selectedRegister: state.selectedRegister, selectedAddress: state.selectedAddress, selectedSymbol: state.selectedSymbol,
        registerSelectionRevision: state.registerSelectionRevision, breakpointRevision: state.breakpointRevision,
        executionRevision: state.executionRevision,
        executionReason: state.executionReason, instructions: state.instructions, sourceRegisters: state.sourceRegisters,
        accessedRegisters: REGISTER_NAMES.flatMap((_, index) => (state.accessedRegisterMask >>> index) & 1 ? [index] : []),
        breakpoints: Array.from(state.breakpoints), previous: snapshotForView(state.previous),
        current: snapshotForView(state.current), status: state.status, output: state.output,
        log: state.log, inputText: state.inputText
    } });
}

function noteExecution(reason) {
    state.executionRevision++;
    state.executionReason = reason;
}

function stopRunning() {
    state.running = false;
    state.ignoreBreakpoints = false;
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = undefined;
}

function memorySegment(address, data, stack) {
    if (isDataAddress(address, data)) return 'data';
    if (isStackAddress(address, stack)) return 'stack';
    return undefined;
}

function readWord(address, segment, data, stack) {
    return segment === 'data'
        ? data[(address - DATA_BASE) / 4] >>> 0
        : stack[stack.length - (STACK_TOP - address) / 4] >>> 0;
}

function tracePointer(address, data, stack) {
    const entries = [];
    const seen = new Set();
    while (entries.length < MAX_POINTER_HOPS) {
        const segment = memorySegment(address, data, stack);
        if (!segment) return { entries, reason: entries.length ? 'value' : 'unavailable' };
        if (seen.has(address)) return { entries, reason: 'cycle', cycleAddress: address };
        seen.add(address);
        const wordAddress = aligned(address);
        const entry = { address, wordAddress, segment };
        entries.push(entry);
        if (wordAddress !== address) return { entries, reason: 'unaligned' };
        entry.value = readWord(address, segment, data, stack);
        address = entry.value;
    }
    if (seen.has(address)) return { entries, reason: 'cycle', cycleAddress: address };
    return { entries, reason: memorySegment(address, data, stack) ? 'limit' : 'value' };
}

function changeForInstruction(address) {
    if (!address) return undefined;
    const instruction = state.instructionByAddress.get(address >>> 0);
    return { address: address >>> 0, sourceLine: instruction?.sourceLine, sourceText: instruction?.displayText };
}

function capture(preserveAddresses = false) {
    const module = context.Module;
    const registers = Array.from(module.getGeneralRegVals(), value => value >>> 0);
    const registerChanges = Array.from(module.getRegisterLastChanges(), changeForInstruction);
    const data = module.getUserData();
    const stack = module.getStack();
    const pc = module.getSpecialRegVals()[0] >>> 0;
    if (state.stackBaseOffset === undefined) state.stackBaseOffset = stack.byteOffset;
    if (stack.byteOffset !== state.stackBaseOffset) state.stackSafe = false;
    const selected = state.selectedRegister === undefined ? state.selectedAddress : registers[state.selectedRegister];
    const pointerTrace = selected === undefined ? undefined : tracePointer(selected, data, stack);
    if (!preserveAddresses) {
        if (state.followStack && isStackAddress(registers[29], stack)) state.stackAddress = aligned(registers[29]);
        for (const segment of ['data', 'stack']) {
            const addresses = pointerTrace?.entries.filter(entry => entry.segment === segment).map(entry => entry.wordAddress) || [];
            if (!addresses.length || (segment === 'stack' && state.followStack && pointerTrace.entries[0].segment !== 'stack')) continue;
            const first = addresses[0], min = Math.min(...addresses), max = Math.max(...addresses);
            const start = max - min <= 28 ? min : first;
            if (segment === 'data') state.dataAddress = start;
            else state.stackAddress = start;
        }
    }
    const dataRows = [];
    const stackRows = [];
    for (let i = 0; i < 8; i++) {
        const dataAddress = state.dataAddress + i * 4;
        const stackAddress = state.stackAddress + i * 4;
        const dataValid = isDataAddress(dataAddress, data);
        const stackValid = isStackAddress(stackAddress, stack);
        dataRows.push({ address: dataAddress, value: dataValid ? readWord(dataAddress, 'data', data, stack) : undefined,
            lastChange: dataValid ? changeForInstruction(module.getMemoryLastChange(dataAddress)) : undefined });
        stackRows.push({ address: stackAddress, value: stackValid ? readWord(stackAddress, 'stack', data, stack) : undefined,
            lastChange: stackValid ? changeForInstruction(module.getMemoryLastChange(stackAddress)) : undefined });
    }
    return { registers, registerChanges, pc, data, stack, dataRows, stackRows, pointerTrace };
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
        } else if (previousAddress === undefined || address !== previousAddress + 4) sourceLine = undefined;
        instructions.push({ address, encoding: Number.parseInt(match[2], 16) >>> 0,
            sourceLine, sourceText: marker?.[2],
            displayText: sourceLine === undefined ? undefined : sourceLines[sourceLine].trim() });
        previousAddress = address;
    }
    return instructions;
}

// SPIM enters its bundled startup routine before jumping to the user's main.
function prepareEntryPoint() {
    const module = context.Module;
    const pc = module.getSpecialRegVals()[0] >>> 0;
    const expected = ['lw $a0 0($sp)', 'addiu $a1 $sp 4', 'addiu $a2 $a1 4',
        'sll $v0 $a0 2', 'addu $a2 $a2 $v0', 'jal main'];
    const startup = expected.map((_, index) => state.instructions.find(item => item.address === pc + index * 4));
    if (startup.some((item, index) => !item || item.sourceLine !== undefined ||
        item.sourceText?.split('#')[0].trim().replace(/\s+/g, ' ') !== expected[index])) return;
    const target = (((startup[5].address + 4) & 0xf0000000) | ((startup[5].encoding & 0x03ffffff) << 2)) >>> 0;
    if (!state.instructions.some(item => item.address === target && item.sourceLine !== undefined)) return;
    for (const item of startup) {
        if ((module.getSpecialRegVals()[0] >>> 0) !== item.address || module.step(1, true) !== 1) break;
    }
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
    state.selectedAddress = undefined;
    state.selectedSymbol = undefined;
    state.breakpoints.clear();
    state.accessedRegisterMask = 0;
    state.current = undefined;
    state.previous = undefined;
    state.input = Array.from(new TextEncoder().encode(state.inputText));
    state.inputPosition = 0;
    state.output = '';
    state.log = '';
    try {
        context.FS.writeFile('input.s', state.source);
        context.Module.init();
        state.assembling = false;
        state.loaded = !state.assemblyError;
        state.instructions = readInstructions(context.Module.getUserText(), state.source);
        state.instructionByAddress = new Map(state.instructions.map(instruction => [instruction.address, instruction]));
        if (state.loaded) prepareEntryPoint();
        // Startup initializes registers but is not part of the user's execution.
        context.Module.clearChangeHistory();
        state.current = capture();
        state.status = state.assemblyError ? 'Assembly error — see SPIM log.' : `Ready · PC ${hex(state.current.pc)}`;
    } catch (error) {
        state.assembling = false;
        state.loaded = false;
        appendLine('log', error.stack || error);
        state.status = 'Unable to assemble — see SPIM log.';
    }
    noteExecution(state.loaded ? 'entry' : 'error');
    publish();
}

function executeStep(ignoreBreakpoint) {
    try {
        const result = context.Module.step(1, ignoreBreakpoint);
        if (result !== -1) {
            const accesses = context.Module.getRegisterAccesses();
            state.accessedRegisterMask = (state.accessedRegisterMask | accesses[0] | accesses[1]) >>> 0;
        }
        if (result === -1) {
            state.skipBreakpoint = true;
            stopRunning();
            state.status = 'Paused at breakpoint.';
        } else if (result === 0) {
            state.finished = true;
            state.skipBreakpoint = false;
            stopRunning();
            state.status = 'Execution finished.';
        } else state.skipBreakpoint = false;
        return result;
    } catch (error) {
        stopRunning();
        state.loaded = false;
        appendLine('log', error.stack || error);
        state.status = 'Execution stopped — see SPIM log.';
        return 0;
    }
}

function refresh() {
    state.previous = state.current;
    state.current = capture();
}

function step() {
    if (!state.loaded || state.stale || state.finished || state.running) return;
    const result = executeStep(true);
    if (state.loaded) {
        refresh();
        if (result === 1) state.status = `Paused · PC ${hex(state.current.pc)}`;
    }
    noteExecution(state.finished ? 'exit' : state.loaded ? 'step' : 'error');
    publish();
}

function runChunk() {
    if (!state.running) return;
    for (let i = 0; i < 100 && state.running; i++) executeStep(state.ignoreBreakpoints || state.skipBreakpoint);
    if (state.loaded) refresh();
    if (state.running) {
        state.status = `Running · PC ${hex(state.current.pc)}`;
        state.timer = setTimeout(runChunk, 0);
    } else noteExecution(state.finished ? 'exit' : state.loaded ? 'breakpoint' : 'error');
    publish();
}

function toggleRun(ignoreBreakpoints = false) {
    if (state.running) {
        stopRunning();
        state.status = `Paused · PC ${hex(state.current.pc)}`;
        noteExecution('pause');
        publish();
        return;
    }
    if (!state.loaded || state.stale || state.finished) return;
    state.ignoreBreakpoints = ignoreBreakpoints;
    state.running = true;
    state.timer = setTimeout(runChunk, 0);
    noteExecution('continue');
    publish();
}

function changeAddress(text, kind) {
    if (!state.current) return;
    text = text.trim();
    if (!/^(?:0x)?[0-9a-f]{1,8}$/i.test(text)) state.status = 'Enter a hexadecimal 32-bit address.';
    else {
        const address = Number.parseInt(text.replace(/^0x/i, ''), 16) >>> 0;
        const valid = kind === 'data' ? isDataAddress(address, state.current.data) : isStackAddress(address, state.current.stack);
        if (!valid) state.status = `Address ${hex(address)} is outside the available ${kind} range.`;
        else {
            state.selectedRegister = undefined;
            state.selectedAddress = undefined;
            state.selectedSymbol = undefined;
            if (kind === 'data') state.dataAddress = aligned(address);
            else { state.stackAddress = aligned(address); state.followStack = false; }
            state.current = capture();
            state.previous = undefined;
            state.status = `Viewing ${hex(address)}.`;
        }
    }
    publish();
}

function onMessage(message) {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'source') {
        state.source = message.text;
        state.sourceRegisters = collectSourceRegisters(message.text);
        state.sourceName = message.name;
        state.sourceId = message.sourceId;
        state.lastLocation = undefined;
        if (state.ready) assemble();
        else { state.status = 'Loading the SPIM runtime…'; publish(); }
    } else if (message.type === 'sourceChanged' && state.source !== undefined) {
        stopRunning();
        state.stale = true;
        state.status = 'Source changed — Run, Step or Reset to apply edits.';
        noteExecution('sourceChanged');
        publish();
    } else if (message.type === 'input') {
        state.inputText = message.text;
        publish();
    } else if (message.type === 'step') step();
    else if (message.type === 'run') toggleRun();
    else if (message.type === 'resume' && !state.running) toggleRun(message.ignoreBreakpoints === true);
    else if (message.type === 'pause' && state.running) toggleRun();
    else if (message.type === 'reset') assemble();
    else if (message.type === 'address' && (message.kind === 'data' || message.kind === 'stack')) changeAddress(message.text, message.kind);
    else if (message.type === 'followStack' && state.current) {
        state.selectedRegister = 29;
        state.selectedAddress = undefined;
        state.selectedSymbol = undefined;
        state.followStack = true;
        state.current = capture();
        state.previous = undefined;
        state.status = `Following $sp · ${hex(state.current.registers[29])}`;
        publish();
    } else if (message.type === 'selectRegister' && state.current) {
        if (!Number.isInteger(message.index) || message.index < 0 || message.index >= state.current.registers.length) return;
        if (message.sourceId !== undefined) {
            if (!state.loaded || state.stale || message.sourceId !== state.sourceId) return;
            state.registerSelectionRevision++;
        }
        state.selectedRegister = message.index;
        state.selectedAddress = undefined;
        state.selectedSymbol = undefined;
        const selected = state.current.registers[message.index];
        if (isStackAddress(selected, state.current.stack)) state.followStack = message.index === 29;
        state.current = capture();
        state.previous = undefined;
        state.status = `Following $${REGISTER_NAMES[state.selectedRegister]} · ${hex(state.current.registers[state.selectedRegister])}`;
        publish();
    } else if (message.type === 'selectMemory' && state.current) {
        const address = message.address;
        if (!Number.isInteger(address) || !memorySegment(address, state.current.data, state.current.stack)) return;
        state.selectedRegister = undefined;
        state.selectedAddress = address;
        state.selectedSymbol = undefined;
        if (isStackAddress(address, state.current.stack)) state.followStack = false;
        state.current = capture();
        state.previous = undefined;
        state.status = `Following ${hex(address)}.`;
        publish();
    } else if (message.type === 'selectSymbol' && state.current && state.loaded && !state.stale && message.sourceId === state.sourceId) {
        const address = message.address;
        if (typeof message.name !== 'string' || !Number.isInteger(address) || !isDataAddress(address, state.current.data)) return;
        state.selectedRegister = undefined;
        state.selectedAddress = address;
        state.selectedSymbol = message.name;
        state.current = capture();
        state.previous = undefined;
        state.status = `Following ${message.name} · ${hex(address)}`;
        publish();
    } else if (message.type === 'inspectAddress' && state.current) {
        const address = message.address;
        if (!Number.isInteger(address)) return;
        const segment = memorySegment(address, state.current.data, state.current.stack);
        if (!segment) return;
        if (segment === 'data') state.dataAddress = aligned(address);
        else { state.stackAddress = aligned(address); state.followStack = false; }
        state.current = capture(true);
        state.previous = undefined;
        state.status = `Viewing ${hex(address)}.`;
        publish();
    } else if (message.type === 'setBreakpoints' && state.loaded && !state.stale && message.sourceId === state.sourceId) {
        if (!Array.isArray(message.addresses)) return;
        const valid = new Set(state.instructions.map(item => item.address));
        const next = new Set(message.addresses.filter(address => Number.isInteger(address) && valid.has(address)));
        for (const address of state.breakpoints) if (!next.has(address)) context.Module.deleteBreakpoint(address);
        for (const address of next) if (!state.breakpoints.has(address)) context.Module.addBreakpoint(address);
        state.breakpoints = next;
        state.breakpointRevision = message.revision;
        publish();
    }
}

parentPort.on('message', onMessage);

try {
    const runtime = path.join(__dirname, '..', 'vendor', 'spim');
    const data = fs.readFileSync(path.join(runtime, 'wasm.data'));
    context = {
        ArrayBuffer, DataView, Float32Array, Float64Array, Int8Array, Int16Array, Int32Array,
        Uint8Array, Uint16Array, Uint32Array, WebAssembly, TextDecoder, TextEncoder, performance, setTimeout, clearTimeout,
        location: { pathname: '/simulator' }, document: { currentScript: null },
        Module: {
            wasmBinary: fs.readFileSync(path.join(runtime, 'wasm.wasm')),
            getPreloadedPackage: () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
            stdin: () => state.inputPosition < state.input.length ? state.input[state.inputPosition++] : null,
            print: text => appendLine('output', text),
            printErr: text => {
                const message = String(text);
                appendLine('log', message.startsWith('Based on <a ') ? message.replace(/<[^>]+>/g, '') : message);
                if (state.assembling && /\(parser\)\s+(?!warning:)/i.test(message)) state.assemblyError = true;
            },
            onRuntimeInitialized() {
                state.ready = true;
                if (state.source !== undefined && !state.stale) assemble();
                else {
                    state.status = state.stale ? 'Source changed — Run, Step or Reset to apply edits.' : 'Open a MIPS file to get started.';
                    publish();
                }
            },
            onAbort(reason) {
                stopRunning();
                state.loaded = false;
                state.status = 'SPIM could not start — see the log.';
                appendLine('log', reason);
                publish();
            }
        }
    };
    vm.runInNewContext(fs.readFileSync(path.join(runtime, 'wasm.js'), 'utf8'), context, { filename: 'spim-wasm.js' });
} catch (error) {
    parentPort.postMessage({ type: 'error', message: String(error.stack || error) });
}
