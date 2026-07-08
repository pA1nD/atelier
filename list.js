#!/usr/bin/env node
/* atelier list — your collections and what they offer.
 *
 *   npx atelier list
 *
 * Walks `_collections/` (authored cuts and subscribed mirrors alike — same
 * shape) and marks which offered modules are installed in this instance.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRoot } from './discovery.js';
import { COLLECTIONS_DIR, CLI_NAME, collectionDir, listCollections, listModuleDirs, git } from './collections.js';

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = resolveRoot({ atelierRoot: process.env.ATELIER_ROOT, pwd: process.env.PWD, hostDir: HOST_DIR });

const installedIds = () => {
  const ids = new Set();
  try {
    for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('$')) {
        try { for (const w of fs.readdirSync(path.join(ROOT, e.name))) ids.add(w); } catch {}
      } else ids.add(e.name);
    }
  } catch {}
  return ids;
};

const names = listCollections(ROOT);
if (!names.length) {
  console.log(`\n  no collections yet in ${COLLECTIONS_DIR}/
  cut one:        ${CLI_NAME} package <module>
  subscribe:      ${CLI_NAME} add github:owner/repo\n`);
  process.exit(0);
}
const have = installedIds();
console.log(`\n  instance: ${ROOT}`);
for (const name of names) {
  const dir = collectionDir(ROOT, name);
  const origin = (() => { try { return git(['remote', 'get-url', 'origin'], dir).trim(); } catch { return '(local — authored here)'; } })();
  console.log(`\n  ${name}   ${origin}`);
  const mods = listModuleDirs(dir);
  for (const m of mods) console.log(`    ${have.has(m) ? '✓' : '·'} ${m}${have.has(m) ? '  (installed)' : ''}`);
  if (!mods.length) console.log('    (no modules)');
}
console.log(`\n  install with:  ${CLI_NAME} add <collection>   or   ${CLI_NAME} add <collection>/<module>\n`);
