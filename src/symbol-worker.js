'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parentPort, workerData } = require('worker_threads');
const { performance } = require('perf_hooks');
const { collectLabels } = require('./source-symbols');

const labels = collectLabels(workerData.source);
if (!labels.length) {
    parentPort.postMessage({ symbols: [] });
} else {
    // Assemble a separate copy containing a table of label addresses. The running
    // simulator and its memory are never modified by this probe.
    const random = crypto.randomBytes(16);
    const marker = Array.from({ length: 4 }, (_, index) => random.readUInt32LE(index * 4));
    const table = marker.map(value => `.word 0x${value.toString(16)}`)
        .concat(labels.map(label => `.word ${label}`)).join('\n');
    const source = `${workerData.source}\n.data\n.align 2\n${table}\n`;
    const runtime = path.join(__dirname, '..', 'vendor', 'spim');
    const log = [];
    let completed = false;
    const finish = result => {
        if (completed) return;
        completed = true;
        parentPort.postMessage(result);
    };
    try {
        const data = fs.readFileSync(path.join(runtime, 'wasm.data'));
        const context = {
            ArrayBuffer, DataView, Float32Array, Float64Array, Int8Array, Int16Array, Int32Array,
            Uint8Array, Uint16Array, Uint32Array, WebAssembly, TextDecoder, TextEncoder, performance, setTimeout, clearTimeout,
            location: { pathname: '/symbols' }, document: { currentScript: null },
            Module: {
                wasmBinary: fs.readFileSync(path.join(runtime, 'wasm.wasm')),
                getPreloadedPackage: () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
                print: text => log.push(String(text)), printErr: text => log.push(String(text)),
                onRuntimeInitialized() {
                    try {
                        context.FS.writeFile('input.s', source);
                        context.Module.init();
                        const parserError = log.find(line => /\(parser\)\s+(?!warning:)/i.test(line));
                        if (parserError) {
                            finish({ error: `SPIM could not assemble the symbol lookup: ${parserError}` });
                            return;
                        }
                        const memory = context.Module.getUserData();
                        // This SPIM build exposes the data byte count as the typed view length.
                        const wordCount = Math.floor(memory.length / 4);
                        let found = -1;
                        for (let index = 0; index + marker.length + labels.length <= wordCount; index++) {
                            if (!marker.every((value, offset) => memory[index + offset] === value)) continue;
                            if (found !== -1) { finish({ error: 'Ambiguous SPIM symbol lookup.' }); return; }
                            found = index;
                        }
                        if (found === -1) { finish({ error: 'SPIM symbol lookup was not found in data memory.' }); return; }
                        finish({ symbols: labels.map((label, index) => [label, memory[found + marker.length + index] >>> 0]) });
                    } catch (error) {
                        finish({ error: String(error.stack || error) });
                    }
                },
                onAbort(reason) { finish({ error: String(reason) }); }
            }
        };
        vm.runInNewContext(fs.readFileSync(path.join(runtime, 'wasm.js'), 'utf8'), context, { filename: 'spim-wasm.js' });
    } catch (error) {
        finish({ error: String(error.stack || error) });
    }
}
