'use strict';

const vscode = require('vscode');

function registerAutoOpen(context, provider) {
    const offered = new Set();
    let prompting = false;

    async function consider(editor) {
        const document = editor?.document;
        if (!document || document.isClosed || document.languageId !== 'mips' || provider.isDocumentLoaded(document)) return;
        const behavior = vscode.workspace.getConfiguration('mipsRunner', document.uri).get('openBehavior', 'auto');
        if (behavior === 'auto') {
            await provider.loadDocument(document, true);
            return;
        }
        const key = document.uri.toString();
        if (behavior !== 'ask' || prompting || offered.has(key)) return;
        offered.add(key);
        prompting = true;
        try {
            const name = vscode.workspace.asRelativePath(document.uri, false);
            const choice = await vscode.window.showInformationMessage(`Load ${name} in MIPS Runner?`, 'Load');
            if (choice === 'Load' && !document.isClosed && vscode.window.activeTextEditor?.document === document &&
                !provider.isDocumentLoaded(document)) await provider.loadDocument(document, true);
        } finally {
            prompting = false;
            const active = vscode.window.activeTextEditor;
            if (active && active.document !== document) void consider(active);
        }
    }

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => { void consider(editor); }),
        vscode.workspace.onDidOpenTextDocument(document => {
            if (vscode.window.activeTextEditor?.document === document) void consider(vscode.window.activeTextEditor);
        }),
        vscode.workspace.onDidCloseTextDocument(document => { offered.delete(document.uri.toString()); })
    );
    void consider(vscode.window.activeTextEditor);
}

module.exports = { registerAutoOpen };
