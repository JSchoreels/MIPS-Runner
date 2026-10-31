'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parentPort, workerData } = require('worker_threads');

const runtime = path.join(__dirname, '..', 'vendor', 'spim');
const data = fs.readFileSync(path.join(runtime, 'wasm.data'));
const log = [];
const context = {
    ArrayBuffer, DataView, Float32Array, Float64Array, Int8Array, Int16Array, Int32Array,
    Uint8Array, Uint16Array, Uint32Array, WebAssembly, TextDecoder, TextEncoder,
    setTimeout, clearTimeout,
    location: { pathname: '/validator' },
    document: { currentScript: null },
    Module: {
        wasmBinary: fs.readFileSync(path.join(runtime, 'wasm.wasm')),
        getPreloadedPackage: () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        print: text => log.push(String(text)),
        printErr: text => log.push(String(text)),
        onRuntimeInitialized() {
            try {
                context.FS.writeFile('input.s', workerData.source);
                context.Module.init();
                parentPort.postMessage({ log });
            } catch (error) {
                parentPort.postMessage({ error: String(error.stack || error) });
            }
        }
    }
};

try {
    vm.runInNewContext(fs.readFileSync(path.join(runtime, 'wasm.js'), 'utf8'), context, { filename: 'spim-wasm.js' });
} catch (error) {
    parentPort.postMessage({ error: String(error.stack || error) });
}
