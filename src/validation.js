'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const vscode = require('vscode');

class Validator {
    constructor(context) {
        this.diagnostics = vscode.languages.createDiagnosticCollection('MIPS Runner');
        this.output = vscode.window.createOutputChannel('MIPS Runner validation');
        this.pending = new Map();
        this.workerPath = path.join(context.extensionPath, 'src', 'validator-worker.js');
    }

    schedule(document) {
        if (document.languageId !== 'mips' || document.isClosed) return;
        const key = document.uri.toString();
        this.cancel(key);
        // Do not leave a diagnostic attached to an older version while typing.
        this.diagnostics.delete(document.uri);
        const pending = { timer: setTimeout(() => this.validate(document, key, pending), 400) };
        this.pending.set(key, pending);
    }

    validate(document, key, pending) {
        pending.timer = undefined;
        const source = document.getText();
        const version = document.version;
        let worker;
        try {
            worker = new Worker(this.workerPath, { workerData: { source } });
        } catch (error) {
            this.pending.delete(key);
            this.output.appendLine(`SPIM validation could not start: ${error.stack || error}`);
            return;
        }
        pending.worker = worker;
        worker.on('message', result => {
            if (this.pending.get(key) !== pending || document.isClosed || document.version !== version) return;
            if (result.error) this.output.appendLine(result.error);
            else this.diagnostics.set(document.uri, spimDiagnostics(result.log, source, document));
            this.pending.delete(key);
            void worker.terminate();
        });
        worker.on('error', error => {
            if (this.pending.get(key) !== pending) return;
            this.pending.delete(key);
            this.output.appendLine(`SPIM validation failed: ${error.stack || error}`);
        });
    }

    close(document) {
        this.cancel(document.uri.toString());
        this.diagnostics.delete(document.uri);
    }

    cancel(key) {
        const pending = this.pending.get(key);
        if (!pending) return;
        clearTimeout(pending.timer);
        if (pending.worker) void pending.worker.terminate();
        this.pending.delete(key);
    }

    dispose() {
        for (const key of this.pending.keys()) this.cancel(key);
        this.diagnostics.dispose();
        this.output.dispose();
    }
}

function spimDiagnostics(log, source, document) {
    const sourceLines = source.split(/\r?\n/);
    const diagnostics = [];
    for (let index = 0; index < log.length; index++) {
        const match = log[index].match(/^spim: \(parser\)\s+(.+?) on line (\d+) of file input\.s$/i);
        if (!match) continue;
        let line = Number(match[2]) - 1;
        const printedLine = log[index + 1]?.replace(/^\t  /, '').trim();
        // At an end-of-line error the scanner has already incremented its line counter.
        if (printedLine && sourceLines[line]?.trim() !== printedLine && sourceLines[line - 1]?.trim() === printedLine) line--;
        if (line < 0 || line >= document.lineCount) continue;
        const warning = /^warning:/i.test(match[1]);
        const message = match[1].replace(/^warning:\s*/i, '');
        const diagnostic = new vscode.Diagnostic(document.lineAt(line).range, message,
            warning ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
        diagnostic.source = 'SPIM';
        diagnostics.push(diagnostic);
    }
    return diagnostics;
}

function registerValidation(context) {
    const validator = new Validator(context);
    context.subscriptions.push(
        validator,
        vscode.workspace.onDidOpenTextDocument(document => validator.schedule(document)),
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.contentChanges.length) validator.schedule(event.document);
        }),
        vscode.workspace.onDidCloseTextDocument(document => validator.close(document))
    );
    for (const document of vscode.workspace.textDocuments) validator.schedule(document);
}

module.exports = { registerValidation };
