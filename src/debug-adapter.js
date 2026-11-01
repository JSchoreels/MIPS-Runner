"use strict";

const path = require('path');
const vscode = require('vscode');
const { REGISTER_NAMES, registerIndex } = require('./registers');

const DEBUG_TYPE = 'mips-runner';
const THREAD_ID = 1;
const hex = value => '0x' + (value >>> 0).toString(16).padStart(8, '0');

class MipsDebugAdapter {
    constructor(provider) {
        this.provider = provider;
        this.events = new vscode.EventEmitter();
        this.onDidSendMessage = this.events.event;
        this.sequence = 1;
        this.sourceId = undefined;
        this.configured = false;
        this.ended = false;
        this.lastRevision = undefined;
        this.output = '';
        this.subscription = provider.onDidChangeState(state => this.onState(state));
    }

    dispose() {
        this.subscription.dispose();
        this.events.dispose();
    }

    sendResponse(request, body) {
        this.events.fire({ seq: this.sequence++, type: 'response', request_seq: request.seq,
            command: request.command, success: true, ...(body === undefined ? {} : { body }) });
    }

    sendError(request, error) {
        this.events.fire({ seq: this.sequence++, type: 'response', request_seq: request.seq,
            command: request.command, success: false, message: String(error.message || error) });
    }

    sendEvent(event, body) {
        this.events.fire({ seq: this.sequence++, type: 'event', event, ...(body === undefined ? {} : { body }) });
    }

    handleMessage(request) {
        if (request?.type !== 'request') return;
        void this.dispatch(request).catch(error => this.sendError(request, error));
    }

    async launch(args) {
        const program = args.program;
        if (typeof program !== 'string' || !program) throw new Error('Open a MIPS file before starting debugging.');
        const uri = path.isAbsolute(program) ? vscode.Uri.file(program) : vscode.Uri.parse(program);
        const document = await vscode.workspace.openTextDocument(uri);
        const panelStart = args.__mipsRunnerPanelStart;
        if (panelStart) {
            const state = this.provider.workerState;
            if (!['run', 'step', 'attach'].includes(panelStart.action) ||
                this.provider.panelDebugStart?.token !== panelStart.token || panelStart.sourceId !== this.provider.sourceId ||
                this.provider.document !== document || document.version !== this.provider.sourceVersion ||
                state?.sourceId !== panelStart.sourceId || !state.loaded || state.stale || state.finished || state.running) {
                throw new Error('The loaded program changed before debugging started.');
            }
        } else {
            await this.provider.loadDocument(document, true);
        }
        if (this.provider.document !== document) throw new Error('The loaded file changed before debugging started.');
        const sourceId = this.provider.sourceId;
        const state = await this.provider.waitForState(item => item.sourceId !== sourceId || item.stale ||
            item.loaded || (item.ready && /assembly error|unable to assemble|could not start/i.test(item.status)));
        if (state.sourceId !== sourceId || state.stale || this.provider.document !== document) {
            throw new Error('The loaded source changed before debugging started.');
        }
        if (!state.loaded) throw new Error(state.status);
        this.sourceId = sourceId;
        this.noDebug = args.noDebug === true;
        this.panelStart = panelStart;
        this.stopOnEntry = !this.noDebug && (args.stopOnEntry === true || panelStart?.action === 'attach');
        this.lastRevision = state.executionRevision;
        this.onState(state);
    }

    source() {
        const uri = this.provider.document?.uri;
        return uri ? { name: path.basename(uri.fsPath), path: uri.fsPath } : undefined;
    }

    onState(state) {
        if (this.ended || this.sourceId === undefined) return;
        if (state.sourceId !== this.sourceId) {
            this.end('Another file was loaded in MIPS Runner.');
            return;
        }
        const output = state.output || '';
        if (!output.startsWith(this.output)) this.output = '';
        if (output.length > this.output.length) this.sendEvent('output', { category: 'stdout', output: output.slice(this.output.length) });
        this.output = output;
        if (state.executionRevision === this.lastRevision) return;
        this.lastRevision = state.executionRevision;
        if (!this.configured) return;
        switch (state.executionReason) {
        case 'continue':
            this.sendEvent('continued', { threadId: THREAD_ID, allThreadsContinued: true });
            break;
        case 'entry': case 'step': case 'breakpoint': case 'pause':
            this.sendEvent('stopped', { reason: state.executionReason, threadId: THREAD_ID, allThreadsStopped: true });
            break;
        case 'exit':
            this.sendEvent('exited', { exitCode: 0 });
            this.end();
            break;
        case 'sourceChanged':
            this.end('The source changed. Start debugging again to assemble the new version.');
            break;
        case 'error':
            this.end(state.status);
            break;
        }
    }

    end(message) {
        if (this.ended) return;
        this.ended = true;
        if (message) this.sendEvent('output', { category: 'console', output: `${message}\n` });
        this.sendEvent('terminated');
    }

    breakpointResults(args) {
        const state = this.provider.workerState;
        const sameSource = args.source?.path && this.source()?.path === args.source.path;
        return (args.breakpoints || []).map(breakpoint => {
            if (!sameSource) return { verified: false, line: breakpoint.line, message: 'Only the loaded source file can be debugged.' };
            if (breakpoint.condition || breakpoint.hitCondition || breakpoint.logMessage) {
                return { verified: false, line: breakpoint.line, message: 'Conditional breakpoints and logpoints are not supported.' };
            }
            const instruction = state?.instructions.find(item => item.sourceLine === breakpoint.line - 1);
            return instruction
                ? { verified: true, line: breakpoint.line, instructionReference: hex(instruction.address) }
                : { verified: false, line: breakpoint.line, message: 'No executable instruction on this line.' };
        });
    }

    async dispatch(request) {
        const args = request.arguments || {};
        switch (request.command) {
        case 'initialize':
            this.sendResponse(request, { supportsConfigurationDoneRequest: true, supportsTerminateRequest: true });
            return;
        case 'launch':
            await this.launch(args);
            this.sendResponse(request);
            this.sendEvent('initialized');
            return;
        case 'setBreakpoints':
            await this.provider.ensureSourceBreakpoints();
            this.sendResponse(request, { breakpoints: this.breakpointResults(args) });
            return;
        case 'setExceptionBreakpoints':
            this.sendResponse(request, { breakpoints: [] });
            return;
        case 'configurationDone':
            await this.provider.ensureSourceBreakpoints();
            this.configured = true;
            this.lastRevision = this.provider.workerState.executionRevision;
            this.sendResponse(request);
            if (this.panelStart?.action === 'step') this.provider.sendAction({ type: 'step' });
            else if (this.stopOnEntry) this.sendEvent('stopped', { reason: 'entry', threadId: THREAD_ID, allThreadsStopped: true });
            else this.provider.sendAction({ type: 'resume', ignoreBreakpoints: this.noDebug });
            if (this.panelStart) this.provider.finishPanelDebugStart(this.panelStart.token, true);
            return;
        case 'threads':
            this.sendResponse(request, { threads: [{ id: THREAD_ID, name: 'MIPS' }] });
            return;
        case 'stackTrace': {
            const state = this.provider.workerState;
            const pc = state?.current?.pc;
            const instruction = state?.instructions.find(item => item.address === pc);
            const frame = { id: 1, name: `MIPS · ${hex(pc || 0)}`, line: (instruction?.sourceLine ?? 0) + 1, column: 1 };
            if (instruction?.sourceLine !== undefined) frame.source = this.source();
            this.sendResponse(request, { stackFrames: [frame], totalFrames: 1 });
            return;
        }
        case 'scopes':
            this.sendResponse(request, { scopes: [{ name: 'Registers', variablesReference: 1, expensive: false }] });
            return;
        case 'variables': {
            const state = this.provider.workerState;
            const variables = args.variablesReference === 1 && state?.current
                ? state.current.registers.map((value, index) => ({ name: `$${REGISTER_NAMES[index]}`, value: hex(value), variablesReference: 0 }))
                : [];
            if (args.variablesReference === 1 && state?.current) variables.push({ name: 'PC', value: hex(state.current.pc), variablesReference: 0 });
            this.sendResponse(request, { variables });
            return;
        }
        case 'evaluate': {
            const state = this.provider.workerState;
            if (this.ended || !state?.loaded || state.stale || state.running || state.finished ||
                state.sourceId !== this.sourceId || !state.current) {
                throw new Error('Pause the program to inspect registers.');
            }
            const expression = typeof args.expression === 'string' ? args.expression.trim() : '';
            const index = registerIndex(expression);
            let value;
            if (index !== undefined) value = state.current.registers[index];
            else if (/^\$?pc$/i.test(expression)) value = state.current.pc;
            else throw new Error('Enter a register such as $t0, $s1, $8 or PC.');
            this.sendResponse(request, { result: hex(value), variablesReference: 0 });
            return;
        }
        case 'continue':
            await this.provider.ensureSourceBreakpoints();
            this.provider.sendAction({ type: 'resume', ignoreBreakpoints: this.noDebug });
            this.sendResponse(request, { allThreadsContinued: true });
            return;
        case 'pause':
            this.provider.sendAction({ type: 'pause' });
            this.sendResponse(request);
            return;
        case 'next': case 'stepIn':
            if (this.provider.workerState?.running) throw new Error('Pause the program before stepping.');
            this.provider.sendAction({ type: 'step' });
            this.sendResponse(request);
            return;
        case 'stepOut':
            throw new Error('Step Out is not yet supported by MIPS Runner.');
        case 'disconnect': case 'terminate':
            this.provider.sendAction({ type: 'pause' });
            this.sendResponse(request);
            this.end();
            return;
        default:
            throw new Error(`Unsupported debug request: ${request.command}`);
        }
    }
}

function registerDebugger(context, provider) {
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, {
            provideDebugConfigurations() {
                const document = vscode.window.activeTextEditor?.document;
                return [{ type: DEBUG_TYPE, request: 'launch', name: 'Debug MIPS',
                    program: document?.languageId === 'mips' ? document.uri.toString() : '${file}' }];
            },
            resolveDebugConfiguration(_folder, config) {
                if (!config.type && !config.request && !config.name) {
                    config.type = DEBUG_TYPE;
                    config.request = 'launch';
                    config.name = 'Debug MIPS';
                }
                if (!config.program && vscode.window.activeTextEditor?.document.languageId === 'mips') {
                    config.program = vscode.window.activeTextEditor.document.uri.toString();
                }
                return config;
            }
        }),
        vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
            createDebugAdapterDescriptor() {
                return new vscode.DebugAdapterInlineImplementation(new MipsDebugAdapter(provider));
            }
        })
    );
}

module.exports = { registerDebugger };
