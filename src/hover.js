'use strict';

const vscode = require('vscode');
const instructions = require('./instruction-docs');

function registerHover(context) {
    context.subscriptions.push(vscode.languages.registerHoverProvider({ language: 'mips' }, {
        provideHover(document, position) {
            const text = document.lineAt(position.line).text;
            const match = text.match(/^\s*(?:[A-Za-z_.$][A-Za-z0-9_.$]*\s*:\s*)*([A-Za-z][A-Za-z0-9_.]*)/);
            if (!match) return;
            const mnemonic = match[1];
            const start = match[0].length - mnemonic.length;
            if (position.character < start || position.character >= start + mnemonic.length) return;
            if (!Object.prototype.hasOwnProperty.call(instructions, mnemonic)) return;
            const entry = instructions[mnemonic];
            const content = new vscode.MarkdownString();
            content.appendCodeblock(entry[0], 'mips');
            content.appendMarkdown(`${entry[1]}\n\nLes noms d’opérandes sont à remplacer par vos registres ou valeurs.\n\n[Manuel SPIM](https://heather.cs.ucdavis.edu/matloff/public_html/SPIM/Doc/Doc.html)`);
            return new vscode.Hover(content, new vscode.Range(position.line, start, position.line, start + mnemonic.length));
        }
    }));
}

module.exports = { registerHover };
