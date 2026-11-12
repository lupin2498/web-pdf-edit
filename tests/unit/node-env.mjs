// Node implementations of environment services used by the core.
import fs from 'node:fs';
import path from 'node:path';
import { FontRegistry } from '../../src/core/fonts.js';
import { ROOT } from './helpers.mjs';

export function nodeFontRegistry() {
  return new FontRegistry(async (d) => {
    if (d.source === 'bundled') return new Uint8Array(fs.readFileSync(path.join(ROOT, 'src', 'assets', 'fonts', d.file)));
    return new Uint8Array(fs.readFileSync(d.file));
  });
}

export function assetStore(map = {}) {
  return { get: async (id) => map[id] };
}
