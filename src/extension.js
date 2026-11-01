'use strict';

const crypto = require('crypto');
const path = require('path');
const { Worker } = require('worker_threads');
const vscode = require('vscode');
const { registerHover } = require('./hover');
const { registerValidation } = require('./validation');
const { registerAutoOpen } = require('./auto-open');
const { symbolAt } = require('./source-symbols');
const { registerIndex } = require('./registers');
const { registerDebugger } = require('./debug-adapter');

const VIEW_ID = 'mipsRunner.simulator';

class SimulatorView {
    constructor(extensionUri) {
        this.extensionUri = extensionUri;
        this.view = undefined;
        this.document = undefined;
        this.lastTextDocument = vscode.window.activeTextEditor?.document;
        this.ready = false;
        this.worker = undefined;
        this.workerState = undefined;
        this.symbolWorker = undefined;
        this.symbols = undefined;
        this.pendingSelection = undefined;
        this.pendingBreakpoints = undefined;
        this.breakpointRevision = 0;
        this.stateEvents = new vscode.EventEmitter();
        this.onDidChangeState = this.stateEvents.event;
        this.sourceId = 0;
        this.sourceVersion = undefined;
        this.executionLine = undefined;
        this.executionDecoration = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: new vscode.ThemeColor('editor.stackFrameHighlightBackground'),
            gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', 'current-line.svg'),
            gutterIconSize: 'contain'
        });
    }

    resolveWebviewView(view) {
        this.view = view;
        this.ready = false;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extensionUri, 'media')
            ]
        };
        view.webview.html = this.getHtml(view.webview);
        view.webview.onDidReceiveMessage(message => {
            if (this.view === view) this.onMessage(message);
        });
        view.onDidDispose(() => {
            if (this.view !== view) return;
            this.view = undefined;
            this.ready = false;
        });
    }

    onActiveEditorChanged(editor) {
        if (editor) this.lastTextDocument = editor.document;
        if (!editor || editor.document.uri.toString() !== this.document?.uri.toString()) this.pendingSelection = undefined;
    }

    onDocumentChanged(event) {
        if (event.contentChanges.length && this.document && event.document.uri.toString() === this.document.uri.toString()) {
            this.sourceVersion = undefined;
            this.executionLine = undefined;
            this.pendingSelection = undefined;
            this.pendingBreakpoints = undefined;
            this.symbols = undefined;
            this.stopSymbolWorker();
            this.updateDecorations();
            this.worker?.postMessage({ type: 'sourceChanged' });
        }
    }

    updateDecorations(reveal = false) {
        for (const editor of vscode.window.visibleTextEditors) {
            const matches = this.document && editor.document.uri.toString() === this.document.uri.toString();
            const range = matches && this.executionLine !== undefined
                ? new vscode.Range(this.executionLine, 0, this.executionLine, 0) : undefined;
            editor.setDecorations(this.executionDecoration, range ? [range] : []);
            if (range && reveal) editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
    }

    dispose() {
        this.executionDecoration.dispose();
        this.stateEvents.dispose();
        this.stopSymbolWorker();
        if (this.worker) void this.worker.terminate();
    }

    stopSymbolWorker() {
        if (!this.symbolWorker) return;
        const worker = this.symbolWorker;
        this.symbolWorker = undefined;
        void worker.terminate();
    }

    resolveSymbols(source) {
        this.stopSymbolWorker();
        this.symbols = undefined;
        this.pendingSelection = undefined;
        let worker;
        try {
            worker = new Worker(path.join(this.extensionUri.fsPath, 'src', 'symbol-worker.js'), { workerData: { source } });
        } catch (error) {
            console.warn('MIPS Runner could not start symbol lookup:', error);
            this.symbols = new Map();
            return;
        }
        this.symbolWorker = worker;
        worker.on('message', result => {
            if (this.symbolWorker !== worker) return;
            this.symbolWorker = undefined;
            void worker.terminate();
            if (result.error) console.warn('MIPS Runner could not resolve symbols:', result.error);
            this.symbols = new Map(result.symbols || []);
            this.selectPendingSelection();
        });
        worker.on('error', error => {
            if (this.symbolWorker !== worker) return;
            this.symbolWorker = undefined;
            this.symbols = new Map();
            this.selectPendingSelection();
            console.warn('MIPS Runner symbol lookup failed:', error);
        });
    }

    onEditorSelectionChanged(event) {
        const editor = event.textEditor;
        const document = editor.document;
        if (!this.document || document.uri.toString() !== this.document.uri.toString() ||
            document.version !== this.sourceVersion || event.selections.length !== 1) {
            this.pendingSelection = undefined;
            return;
        }
        const selection = event.selections[0];
        if (selection.start.line !== selection.end.line) { this.pendingSelection = undefined; return; }
        const position = selection.isEmpty ? selection.active : selection.start;
        const name = symbolAt(document.lineAt(position.line).text, position.character);
        const register = name ? registerIndex(name) : undefined;
        const selectedText = selection.isEmpty ? undefined : document.getText(selection);
        if (!name || (selectedText !== undefined && selectedText !== name &&
            !(register !== undefined && selectedText === name.slice(1)))) {
            this.pendingSelection = undefined;
            return;
        }
        this.pendingSelection = { name, register, sourceId: this.sourceId };
        this.selectPendingSelection();
    }

    selectPendingSelection() {
        const pending = this.pendingSelection;
        const current = this.workerState;
        if (!pending || !current?.loaded || current.stale || !current.current) return;
        if (!this.document || this.document.version !== this.sourceVersion || pending.sourceId !== this.sourceId) {
            this.pendingSelection = undefined;
            return;
        }
        if (pending.register === undefined && !this.symbols) return;
        this.pendingSelection = undefined;
        if (pending.register !== undefined) {
            this.worker?.postMessage({ type: 'selectRegister', index: pending.register, sourceId: pending.sourceId });
            return;
        }
        const address = this.symbols.get(pending.name);
        const dataBase = 0x10000000;
        if (Number.isInteger(address) && address >= dataBase && address < dataBase + current.current.data.length) {
            this.worker?.postMessage({ type: 'selectSymbol', name: pending.name, address, sourceId: pending.sourceId });
        }
    }

    startWorker() {
        if (this.worker) return true;
        let worker;
        try {
            worker = new Worker(path.join(this.extensionUri.fsPath, 'src', 'simulator-worker.js'));
        } catch (error) {
            this.workerError(error.stack || String(error));
            return false;
        }
        this.worker = worker;
        worker.on('message', message => {
            if (this.worker !== worker) return;
            if (message.type === 'update') {
                if (message.state.sourceId !== (this.document ? this.sourceId : undefined)) return;
                this.workerState = message.state;
                if (this.ready) this.view?.webview.postMessage({ type: 'update', state: message.state });
                this.syncSourceBreakpoints();
                this.stateEvents.fire(message.state);
                this.selectPendingSelection();
            } else if (message.type === 'executionLocation') this.updateExecutionLocation(message);
            else if (message.type === 'error') {
                this.worker = undefined;
                this.workerState = undefined;
                void worker.terminate();
                this.workerError(message.message);
            }
        });
        worker.on('error', error => {
            if (this.worker !== worker) return;
            this.worker = undefined;
            this.workerState = undefined;
            this.workerError(error.stack || String(error));
        });
        return true;
    }

    sourceBreakpointAddresses(state = this.workerState) {
        if (!state?.loaded || state.stale || !this.document || this.document.version !== this.sourceVersion) return [];
        const addresses = new Set();
        for (const breakpoint of vscode.debug.breakpoints) {
            if (!(breakpoint instanceof vscode.SourceBreakpoint) || !breakpoint.enabled || breakpoint.condition ||
                breakpoint.hitCondition || breakpoint.logMessage || breakpoint.location.uri.toString() !== this.document.uri.toString()) continue;
            const instruction = state.instructions.find(item => item.sourceLine === breakpoint.location.range.start.line);
            if (instruction) addresses.add(instruction.address);
        }
        return [...addresses].sort((a, b) => a - b);
    }

    syncSourceBreakpoints() {
        const current = this.workerState;
        if (!current?.loaded || current.stale || current.sourceId !== this.sourceId) return;
        if (this.pendingBreakpoints && current.breakpointRevision === this.pendingBreakpoints.revision) {
            this.pendingBreakpoints = undefined;
        }
        const addresses = this.sourceBreakpointAddresses(current);
        const actual = [...current.breakpoints].sort((a, b) => a - b);
        const matches = addresses.length === actual.length && addresses.every((address, index) => address === actual[index]);
        if (matches && !this.pendingBreakpoints) return;
        const key = `${this.sourceId}:${addresses.join(',')}`;
        if (this.pendingBreakpoints?.key === key) return;
        const revision = ++this.breakpointRevision;
        this.pendingBreakpoints = { key, revision };
        this.worker?.postMessage({ type: 'setBreakpoints', sourceId: this.sourceId, addresses, revision });
    }

    waitForState(predicate, timeout = 15000) {
        if (this.workerState && predicate(this.workerState)) return Promise.resolve(this.workerState);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { subscription.dispose(); reject(new Error('Timed out waiting for the simulator.')); }, timeout);
            const subscription = this.onDidChangeState(state => {
                if (!predicate(state)) return;
                clearTimeout(timer);
                subscription.dispose();
                resolve(state);
            });
        });
    }

    async ensureSourceBreakpoints() {
        const sourceId = this.sourceId;
        this.syncSourceBreakpoints();
        return this.waitForState(state => {
            if (state.sourceId !== sourceId || !state.loaded || state.stale || this.pendingBreakpoints) return false;
            const desired = this.sourceBreakpointAddresses(state);
            const actual = [...state.breakpoints].sort((a, b) => a - b);
            return desired.length === actual.length && desired.every((address, index) => address === actual[index]);
        });
    }

    sendAction(action) {
        this.worker?.postMessage(action);
    }

    workerError(message) {
        this.executionLine = undefined;
        this.sourceVersion = undefined;
        this.updateDecorations();
        void vscode.window.showErrorMessage(`MIPS Runner could not run SPIM: ${message}`);
    }

    async loadActiveFile() {
        const document = vscode.window.activeTextEditor?.document || this.lastTextDocument;
        if (!document || document.isClosed) {
            await vscode.window.showInformationMessage('Open a MIPS source file before starting MIPS Runner.');
            return;
        }
        await this.loadDocument(document);
    }

    isDocumentLoaded(document) {
        return this.document === document && !document.isClosed;
    }

    async loadDocument(document, preserveEditorFocus = false) {
        if (document.isClosed) return;
        const editor = preserveEditorFocus && vscode.window.activeTextEditor?.document === document
            ? vscode.window.activeTextEditor : undefined;
        this.executionLine = undefined;
        this.sourceVersion = undefined;
        this.updateDecorations();
        this.document = document;
        this.sendSource();
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
        if (editor && this.document === document && !document.isClosed && vscode.window.activeTextEditor?.document === document) {
            await vscode.window.showTextDocument(document, { viewColumn: editor.viewColumn, preserveFocus: false });
        }
    }

    onMessage(message) {
        if (!message || typeof message.type !== 'string') return;
        if (message.type === 'ready') {
            this.ready = true;
            this.startWorker();
            if (this.workerState) this.view?.webview.postMessage({ type: 'update', state: this.workerState });
        } else if (message.type === 'loadActiveFile') {
            void this.loadActiveFile();
        } else if (message.type === 'reloadSource') {
            this.sendSource();
        } else if (message.type === 'simulatorAction' && message.action && typeof message.action.type === 'string') {
            this.sendAction(message.action);
        }
    }

    updateExecutionLocation(message) {
        if (message.sourceId === this.sourceId &&
            this.document && this.document.version === this.sourceVersion) {
            const line = message.line;
            if (line !== null && (!Number.isInteger(line) || line < 0 || line >= this.document.lineCount)) return;
            this.executionLine = line === null ? undefined : line;
            this.updateDecorations(!message.running);
        }
    }

    sendSource() {
        if (!this.document || this.document.isClosed) return;
        if (!this.startWorker()) return;
        this.sourceId += 1;
        this.sourceVersion = this.document.version;
        this.workerState = undefined;
        this.pendingBreakpoints = undefined;
        this.executionLine = undefined;
        this.updateDecorations();
        const source = this.document.getText();
        this.worker.postMessage({
            type: 'source',
            sourceId: this.sourceId,
            text: source,
            name: vscode.workspace.asRelativePath(this.document.uri, false) || this.document.fileName
        });
        this.resolveSymbols(source);
    }

    getHtml(webview) {
        const nonce = crypto.randomBytes(16).toString('base64');
        const uri = (...parts) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...parts)).toString();
        const css = uri('media', 'runner.css');
        const runner = uri('media', 'runner.js');

        return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src ${webview.cspSource};">
    <link rel="stylesheet" href="${css}">
    <title>MIPS Runner</title>
</head>
<body>
    <header class="toolbar">
        <div class="program"><strong id="program-name">No program loaded</strong><span id="program-status" role="status">Open a MIPS file to begin.</span></div>
        <div class="actions">
            <button id="load" type="button">Load active file</button>
            <button id="assemble" type="button" disabled>Assemble</button>
            <button id="run" type="button" disabled>Run</button>
            <button id="step" type="button" disabled>Step</button>
            <button id="reset" type="button" disabled>Reset</button>
        </div>
    </header>
    <main class="panels" id="panels">
        <svg class="pointer-links" id="pointer-links" aria-hidden="true">
            <defs>
                <marker id="register-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" class="register-arrow"></path></marker>
                <marker id="memory-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" class="memory-arrow"></path></marker>
            </defs>
            <g id="pointer-paths"></g>
        </svg>
        <section class="register-panel" aria-labelledby="register-title">
            <div class="panel-title"><h2 id="register-title">Registers</h2><span>Select an address</span></div>
            <label class="register-filter" for="register-filter">Show <select id="register-filter" aria-label="Filter registers"><option value="all">All registers</option><option value="source">Used in code</option><option value="executed">Accessed during execution</option></select></label>
            <div id="registers" class="registers" role="region" aria-label="Registers" tabindex="0"></div>
        </section>
        <section class="memory-panel" aria-labelledby="memory-title">
            <div class="panel-title"><h2 id="memory-title">Memory map</h2><span>32-bit words</span></div>
            <div class="memory-sections">
                <section aria-labelledby="data-title">
                    <div class="section-title"><h3 id="data-title"><span class="region-dot data-dot"></span>Data segment</h3><span id="data-target"></span></div>
                    <form class="address-form" id="data-form"><label for="data-address">Address</label><input id="data-address" spellcheck="false" value="0x10010000"><button type="submit">Go</button></form>
                    <div class="memory-head"><span>Address</span><span>Value</span></div>
                    <div id="data-rows"></div>
                </section>
                <section aria-labelledby="stack-title">
                    <div class="section-title"><h3 id="stack-title"><span class="region-dot stack-dot"></span>Stack</h3><button id="follow-stack" type="button">Follow $sp</button></div>
                    <form class="address-form" id="stack-form"><label for="stack-address">Address</label><input id="stack-address" spellcheck="false"><button type="submit">Go</button></form>
                    <div class="memory-head"><span>Address</span><span>Value</span></div>
                    <div id="stack-rows"></div>
                    <p id="stack-warning" class="notice" hidden></p>
                </section>
            </div>
        </section>
    </main>
    <section class="pointer-summary" aria-label="Pointer trace">
        <div id="pointer-trace" class="pointer-trace" aria-live="polite">Select a register or memory value that looks like an address.</div>
        <p class="pointer-note">Address-like values are possible pointers; their meaning is inferred.</p>
    </section>
    <details class="secondary"><summary>Standard input</summary><label for="stdin">Input for the next assembly or reset (one value per line)</label><textarea id="stdin" rows="3" spellcheck="false"></textarea></details>
    <details class="secondary" open><summary>Output and SPIM log</summary><div class="logs"><section><h3>Output</h3><pre id="output"></pre></section><section><h3>SPIM log</h3><pre id="log"></pre></section></div></details>
    <script nonce="${nonce}" src="${runner}"></script>
</body>
</html>`;
    }
}

function activate(context) {
    const provider = new SimulatorView(context.extensionUri);
    registerHover(context);
    registerValidation(context);
    context.subscriptions.push(
        provider,
        vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
        vscode.commands.registerCommand('mipsRunner.loadActiveFile', () => provider.loadActiveFile()),
        vscode.window.onDidChangeActiveTextEditor(editor => provider.onActiveEditorChanged(editor)),
        vscode.window.onDidChangeTextEditorSelection(event => provider.onEditorSelectionChanged(event)),
        vscode.window.onDidChangeVisibleTextEditors(() => provider.updateDecorations()),
        vscode.workspace.onDidChangeTextDocument(event => provider.onDocumentChanged(event)),
        vscode.debug.onDidChangeBreakpoints(() => provider.syncSourceBreakpoints())
    );
    registerAutoOpen(context, provider);
    registerDebugger(context, provider);
}

module.exports = { activate };
