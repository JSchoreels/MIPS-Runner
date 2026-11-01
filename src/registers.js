'use strict';

const REGISTER_NAMES = [
    'zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3',
    't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
    's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7',
    't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra'
];

// The bundled SPIM accepts these aliases and numeric register names as well.
const REGISTER_INDICES = new Map(REGISTER_NAMES.map((name, index) => [name, index]));
REGISTER_INDICES.set('kt0', 26);
REGISTER_INDICES.set('kt1', 27);
REGISTER_INDICES.set('s8', 30);

function registerIndex(token) {
    if (!token.startsWith('$')) return undefined;
    const name = token.slice(1);
    if (/^\d{1,2}$/.test(name)) {
        const index = Number(name);
        return index < REGISTER_NAMES.length ? index : undefined;
    }
    return REGISTER_INDICES.get(name);
}

module.exports = { REGISTER_NAMES, registerIndex };
