'use strict';

const { registerIndex } = require('./registers');

// Match the identifier forms accepted by the bundled SPIM scanner.
const IDENTIFIER = '(?:\\$[A-Za-z0-9_.$]+|[A-Za-z_.][A-Za-z0-9_.]*)';
const leadingLabel = new RegExp(`^\\s*(${IDENTIFIER})\\s*:\\s*`);
const declaration = new RegExp(`^\\s*\\.(?:extern|comm|lcomm|label)\\s+(${IDENTIFIER})(?=\\s|,|$)`, 'i');

// Preserve character positions while excluding comments and quoted text.
function codeOnly(line) {
    const chars = line.split('');
    let quote;
    let escaped = false;
    for (let i = 0; i < chars.length; i++) {
        const char = chars[i];
        if (quote) {
            chars[i] = ' ';
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === quote) quote = undefined;
        } else if (char === '#') {
            chars.fill(' ', i);
            break;
        } else if (char === '"' || char === "'") {
            quote = char;
            chars[i] = ' ';
        }
    }
    return chars.join('');
}

function collectLabels(source) {
    const labels = new Set();
    for (const line of source.split(/\r?\n/)) {
        for (let statement of codeOnly(line).split(';')) {
            let match;
            while ((match = statement.match(leadingLabel))) {
                labels.add(match[1]);
                statement = statement.slice(match[0].length);
            }
            match = statement.match(declaration);
            if (match) labels.add(match[1]);
        }
    }
    return Array.from(labels);
}

function collectSourceRegisters(source) {
    const registers = new Set();
    for (const line of source.split(/\r?\n/)) {
        for (let statement of codeOnly(line).split(';')) {
            let label;
            while ((label = statement.match(leadingLabel))) statement = statement.slice(label[0].length);
            if (!/^\s*[A-Za-z][A-Za-z0-9_.]*\b/.test(statement)) continue;
            for (const match of statement.matchAll(/\$[A-Za-z0-9_.$]+/g)) {
                if (match.index && /[A-Za-z0-9_.$]/.test(statement[match.index - 1])) continue;
                const index = registerIndex(match[0]);
                if (index !== undefined) registers.add(index);
            }
        }
    }
    return [...registers].sort((a, b) => a - b);
}

// Find references to the same physical register, including numeric aliases.
function registerReferences(source, index) {
    const references = [];
    source.split(/\r?\n/).forEach((line, lineNumber) => {
        let offset = 0;
        for (const part of codeOnly(line).split(';')) {
            let statement = part;
            let prefix = 0;
            let label;
            while ((label = statement.match(leadingLabel))) {
                prefix += label[0].length;
                statement = statement.slice(label[0].length);
            }
            if (/^\s*[A-Za-z][A-Za-z0-9_.]*\b/.test(statement)) {
                for (const match of statement.matchAll(/\$[A-Za-z0-9_.$]+/g)) {
                    if (match.index && /[A-Za-z0-9_.$]/.test(statement[match.index - 1])) continue;
                    if (registerIndex(match[0]) !== index) continue;
                    const start = offset + prefix + match.index;
                    references.push({ line: lineNumber, start, end: start + match[0].length });
                }
            }
            offset += part.length + 1;
        }
    });
    return references;
}

// Match only exact labels resolved for the selected memory address.
function symbolReferences(source, names) {
    const wanted = new Set(names);
    const references = [];
    if (!wanted.size) return references;
    source.split(/\r?\n/).forEach((line, lineNumber) => {
        const code = codeOnly(line);
        const pattern = new RegExp(IDENTIFIER, 'g');
        for (const match of code.matchAll(pattern)) {
            if (match.index && /[A-Za-z0-9_.$]/.test(code[match.index - 1])) continue;
            if (wanted.has(match[0])) references.push({ line: lineNumber, start: match.index, end: match.index + match[0].length });
        }
    });
    return references;
}

function symbolAt(line, character) {
    const code = codeOnly(line);
    if (character < line.length && code[character] === ' ' && !/\s/.test(line[character])) return undefined;
    const pattern = new RegExp(IDENTIFIER, 'g');
    let match;
    while ((match = pattern.exec(code))) {
        if (match.index && /[A-Za-z0-9_.$]/.test(code[match.index - 1])) continue;
        const end = match.index + match[0].length;
        if (character >= match.index && character <= end) return match[0];
    }
    return undefined;
}

module.exports = { collectLabels, collectSourceRegisters, registerReferences, symbolReferences, symbolAt };
