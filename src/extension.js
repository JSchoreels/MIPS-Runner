'use strict';

const crypto = require('crypto');
const vscode = require('vscode');
const { registerHover } = require('./hover');
const { registerValidation } = require('./validation');
const { registerAutoOpen } = require('./auto-open');

const VIEW_ID = 'mipsRunner.simulator';

class SimulatorView {
    constructor(extensionUri) {
        this.extensionUri = extensionUri;
        this.view = undefined;
        this.document = undefined;
        this.lastTextDocument = vscode.window.activeTextEditor?.document;
        this.ready = false;
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
                vscode.Uri.joinPath(this.extensionUri, 'media'),
                vscode.Uri.joinPath(this.extensionUri, 'vendor', 'spim')
            ]
        };
        view.webview.html = this.getHtml(view.webview);
        view.webview.onDidReceiveMessage(message => this.onMessage(message));
        view.onDidDispose(() => {
            this.view = undefined;
            this.ready = false;
            this.sourceVersion = undefined;
            this.executionLine = undefined;
            this.updateDecorations();
        });
    }

    onActiveEditorChanged(editor) {
        if (editor) this.lastTextDocument = editor.document;
    }

    onDocumentChanged(event) {
        if (event.contentChanges.length && this.document && event.document.uri.toString() === this.document.uri.toString()) {
            this.sourceVersion = undefined;
            this.executionLine = undefined;
            this.updateDecorations();
            this.view?.webview.postMessage({ type: 'sourceChanged' });
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
        const wasReady = this.ready;
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
        if (wasReady && this.ready && this.document === document && !document.isClosed) this.sendSource();
        if (editor && this.document === document && !document.isClosed && vscode.window.activeTextEditor?.document === document) {
            await vscode.window.showTextDocument(document, { viewColumn: editor.viewColumn, preserveFocus: false });
        }
    }

    onMessage(message) {
        if (!message || typeof message.type !== 'string') return;
        if (message.type === 'ready') {
            this.ready = true;
            this.sendSource();
        } else if (message.type === 'loadActiveFile') {
            void this.loadActiveFile();
        } else if (message.type === 'reloadSource') {
            this.sendSource();
        } else if (message.type === 'executionLocation' && message.sourceId === this.sourceId &&
            this.document && this.document.version === this.sourceVersion) {
            const line = message.line;
            if (line !== null && (!Number.isInteger(line) || line < 0 || line >= this.document.lineCount)) return;
            this.executionLine = line === null ? undefined : line;
            this.updateDecorations(!message.running);
        }
    }

    sendSource() {
        if (!this.ready || !this.view || !this.document || this.document.isClosed) return;
        this.sourceId += 1;
        this.sourceVersion = this.document.version;
        this.executionLine = undefined;
        this.updateDecorations();
        this.view.webview.postMessage({
            type: 'source',
            sourceId: this.sourceId,
            text: this.document.getText(),
            name: vscode.workspace.asRelativePath(this.document.uri, false) || this.document.fileName
        });
    }

    getHtml(webview) {
        const nonce = crypto.randomBytes(16).toString('base64');
        const uri = (...parts) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...parts)).toString();
        const css = uri('media', 'runner.css');
        const runner = uri('media', 'runner.js');
        const glue = uri('vendor', 'spim', 'wasm.js');
        const wasm = uri('vendor', 'spim', 'wasm.wasm');
        const data = uri('vendor', 'spim', 'wasm.data');

        return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src ${webview.cspSource};">
    <meta name="spim-wasm" content="${wasm}">
    <meta name="spim-data" content="${data}">
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
    <main class="panels">
        <section class="register-panel" aria-labelledby="register-title">
            <div class="panel-title"><h2 id="register-title">Registers</h2><span>hexadecimal</span></div>
            <div class="register-head"><span>Register</span><span>Value</span><span>Decimal</span></div>
            <div id="registers" class="registers"></div>
        </section>
        <section class="memory-panel" aria-labelledby="memory-title">
            <div class="panel-title"><h2 id="memory-title">Memory</h2><span>32-bit words</span></div>
            <div class="memory-sections">
                <section aria-labelledby="data-title">
                    <div class="section-title"><h3 id="data-title">Data segment</h3><span id="data-target"></span></div>
                    <form class="address-form" id="data-form"><label for="data-address">Address</label><input id="data-address" spellcheck="false" value="0x10010000"><button type="submit">Go</button></form>
                    <div class="memory-head"><span>Address</span><span>Value</span><span>Decimal</span></div>
                    <div id="data-rows"></div>
                </section>
                <section aria-labelledby="stack-title">
                    <div class="section-title"><h3 id="stack-title">Stack</h3><button id="follow-stack" type="button">Follow $sp</button></div>
                    <form class="address-form" id="stack-form"><label for="stack-address">Address</label><input id="stack-address" spellcheck="false"><button type="submit">Go</button></form>
                    <div class="memory-head"><span>Address</span><span>Value</span><span>Decimal</span></div>
                    <div id="stack-rows"></div>
                    <p id="stack-warning" class="notice" hidden></p>
                </section>
            </div>
        </section>
    </main>
    <details class="secondary" id="instructions-panel"><summary>Instructions and breakpoints</summary><p>Click an instruction address to toggle a breakpoint.</p><div id="instructions" class="instructions"></div></details>
    <details class="secondary"><summary>Standard input</summary><label for="stdin">Input for the next assembly or reset (one value per line)</label><textarea id="stdin" rows="3" spellcheck="false"></textarea></details>
    <details class="secondary" open><summary>Output and SPIM log</summary><div class="logs"><section><h3>Output</h3><pre id="output"></pre></section><section><h3>SPIM log</h3><pre id="log"></pre></section></div></details>
    <script nonce="${nonce}" src="${runner}"></script>
    <script nonce="${nonce}" src="${glue}"></script>
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
        vscode.window.onDidChangeVisibleTextEditors(() => provider.updateDecorations()),
        vscode.workspace.onDidChangeTextDocument(event => provider.onDocumentChanged(event))
    );
    registerAutoOpen(context, provider);
}

module.exports = { activate };
