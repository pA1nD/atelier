#!/usr/bin/env node
/* atelier package — cut a verified snapshot of a module into a collection.
 *
 *   npx atelier package <module> [--to <collection>] [--data] [--yes] [--no-chrome]
 *
 * The defined moment: working trees are edited constantly (often by agents,
 * often mid-refactor), so distribution NEVER reads them — it reads cuts. A cut
 * only lands if the module builds: frontend sources must esbuild-transform,
 * backend.js must bundle, a chrome must bundle whole. The cut is a filtered
 * copy (no node_modules / .git / .env* / provenance; data/ only with --data)
 * committed into `_collections/<collection>/<module>/` — a collection is
 * always a git repo, which is what makes it publishable and subscribable.
 *
 * With no --to, the collection is named after the module (a collection of
 * one). If the module pins a chrome via `meta.chrome`, the chrome is offered
 * into the collection alongside — so what arrives on the other side is the
 * app as its author saw it, not an unstyled fragment.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  resolveRoot, RESERVED_NAMES, GLOBAL_WORKSPACE,
  loadModuleConfig, collectConfigPaths, resolvePathEntry,
} from './discovery.js';
import {
  COLLECTIONS_DIR, collectionDir, isModuleFolder, readPkg, readModuleMeta,
  copyModuleFiltered, isGitRepo, git, gitCommitAll, CLI_NAME,
} from './collections.js';
import { buildProblems } from './gate.js';

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const fail = (msg) => { console.error(`\natelier package: ${msg}\n`); process.exit(1); };

/* ---- args ---------------------------------------------------------------- */
const USAGE = `usage: atelier package <module> [--to <collection>] [--data] [--yes] [--no-chrome]
  <module>      a module in this instance: <id>, or <ws>/<id> for a workspace module
  --to          the collection to cut into (default: a collection named after the module)
  --data        include the module's data/ in the cut (content ships; point-in-time)
  --yes         no prompts — accept defaults (include a pinned chrome)
  --no-chrome   never include the pinned chrome`;
const args = process.argv.slice(2);
let modArg = null, to = null, includeData = false, yes = false, noChrome = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--to') to = args[++i] || fail('--to needs a collection name');
  else if (a === '--data') includeData = true;
  else if (a === '--yes' || a === '-y') yes = true;
  else if (a === '--no-chrome') noChrome = true;
  else if (!a.startsWith('-') && modArg === null) modArg = a;
  else fail(`unknown option: ${a}\n\n${USAGE}`);
}
if (!modArg) fail(USAGE);

/* ---- locate the module ----------------------------------------------------- */
const ROOT = resolveRoot({ atelierRoot: process.env.ATELIER_ROOT, pwd: process.env.PWD, hostDir: HOST_DIR });
console.log(`\n  instance: ${ROOT}`);

// Where does this module live? Folders inside the instance root first
// (<id> / $<ws>/<id>), then the config's path-mounts — an instance may mount
// its working trees from anywhere (atelier.config.json `modules` path
// entries), and packaging is done from the instance, wherever the folder is.
function moduleDirFor(spec) {
  const [a, b] = spec.split('/');
  const direct = b ? path.join(ROOT, '$' + a, b) : path.join(ROOT, a);
  if (isModuleFolder(direct)) return direct;
  const wantWs = b ? a : null, wantId = b || a;
  const hits = [];
  for (const entry of collectConfigPaths(loadModuleConfig(ROOT), { globalWorkspace: GLOBAL_WORKSPACE })) {
    const abs = resolvePathEntry(entry.path, ROOT);
    if (!abs) continue;
    const id = entry.id || path.basename(abs);
    if (id !== wantId) continue;
    if (wantWs && entry.workspace !== wantWs) continue;
    if (isModuleFolder(abs)) hits.push({ abs, workspace: entry.workspace });
  }
  if (hits.length === 1) return hits[0].abs;
  if (hits.length > 1) {
    fail(`"${spec}" is mounted in ${hits.length} workspaces — say which one:\n${hits.map((h) => `  ${CLI_NAME} package ${h.workspace}/${wantId}`).join('\n')}`);
  }
  return direct;   // not found anywhere — the caller errors with this path
}
const modDir = moduleDirFor(modArg);
const modId = modArg.split('/').pop();
if (!isModuleFolder(modDir)) fail(`${modArg} is not a module here — not at ${modDir}, and no matching path-mount in atelier.config.json`);

const collection = to || modId;
if (!/^[a-zA-Z0-9][\w.-]*$/.test(collection)) fail(`"${collection}" isn't a usable collection name`);
if (RESERVED_NAMES.has(collection)) fail(`"${collection}" is a reserved name — pick another collection name`);

/* ---- the build gate (shared with `atelier update` — see gate.js) ------------- */
async function gate(dir, id, { isChrome }) {
  const problems = await buildProblems(dir, { isChrome });
  if (problems.length) {
    console.error(`\n  ✗ ${id} failed the build gate — NOT cut. The collection is unchanged.\n`);
    console.error('  ' + problems.join('\n  ').split('\n').join('\n  ') + '\n');
    process.exit(1);
  }
}

/* ---- chrome closure ----------------------------------------------------------
 * meta.chrome names the chrome this module renders in. If that chrome lives in
 * this instance, offer to cut it into the collection too — a collection should
 * be the working set, not a fragment.
 * ------------------------------------------------------------------------------ */
const meta = readModuleMeta(modDir);
const toCut = [{ dir: modDir, id: modId, isChrome: !!meta.isChrome, data: includeData }];

const pinned = meta.chrome ? String(meta.chrome).split('/').pop() : null;
if (pinned && pinned !== modId && !noChrome) {
  const chromeDir = moduleDirFor(pinned);   // instance folder or a config path-mount
  if (!isModuleFolder(chromeDir)) {
    console.log(`  ! ${modId} pins chrome "${pinned}", which isn't in this instance — not included`);
  } else {
    // Only the FIRST inclusion asks — once the chrome is in the collection,
    // the decision is made; recuts include it silently to keep it fresh
    // (--no-chrome skips a recut without removing the existing cut).
    const alreadyIn = isModuleFolder(path.join(collectionDir(ROOT, collection), pinned));
    let include = true;
    if (!alreadyIn && !yes && process.stdin.isTTY && process.stdout.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`  ${modId} pins chrome "${pinned}" — include it in the collection? [Y/n] `);
      rl.close();
      include = !/^n/i.test(answer.trim());
    }
    if (include) toCut.push({ dir: chromeDir, id: pinned, isChrome: true, data: false });
  }
}

/* ---- gate, cut, commit ------------------------------------------------------- */
for (const m of toCut) await gate(m.dir, m.id, m);

const collDir = collectionDir(ROOT, collection);
fs.mkdirSync(collDir, { recursive: true });
if (!isGitRepo(collDir)) git(['init', '-q'], collDir);

// SQLite databases in data/ are snapshotted through sqlite's own backup API
// (`sqlite3 src ".backup dest"`), which takes a CONSISTENT copy while the
// running module keeps writing — no unmount, no quiet period needed. Only if
// that fails (no sqlite3 binary, not actually a sqlite file) do we fall back
// to the plain copy and say so.
function snapshotDatabases(srcData, destData) {
  const snapped = [];
  if (!fs.existsSync(destData)) return snapped;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(sqlite3?|db)$/.test(e.name)) continue;
      const rel = path.relative(destData, p);
      const src = path.join(srcData, rel);
      try {
        fs.rmSync(p);
        execFileSync('sqlite3', [src, `.backup "${p}"`], { stdio: ['ignore', 'pipe', 'pipe'] });
        for (const sfx of ['-wal', '-shm']) fs.rmSync(p + sfx, { force: true });
        snapped.push(rel);
      } catch {
        try { fs.cpSync(src, p); } catch {}
        console.log(`  ! data: ${rel} copied plainly — a live database copy can be mid-write; cut while the instance is quiet (sqlite3 not available or backup failed)`);
      }
    }
  };
  walk(destData);
  return snapped;
}

const listFiles = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else out.push(path.relative(dir, path.join(d, e.name)));
    }
  };
  walk(dir);
  return out;
};

const cutNames = [];
for (const m of toCut) {
  const version = readPkg(m.dir).version || '0.0.0';
  const target = path.join(collDir, m.id);
  const prevVersion = fs.existsSync(target) ? (readPkg(target).version || '0.0.0') : null;
  fs.rmSync(target, { recursive: true, force: true });
  copyModuleFiltered(m.dir, target, { includeData: m.data });
  const snapped = m.data ? snapshotDatabases(path.join(m.dir, 'data'), path.join(target, 'data')) : [];
  // --force before the change check: a module's own .gitignore (usually
  // ignoring data/) travels with the cut and would otherwise hide from git
  // exactly what the copy filter deliberately included.
  git(['add', '-A', '--force', '--', m.id], collDir);
  const changed = !!git(['status', '--porcelain', '--', m.id], collDir).trim();
  const dataDir = path.join(target, 'data');
  let data = null;
  if (m.data && fs.existsSync(dataDir)) {
    const files = listFiles(dataDir);
    data = {
      label: files.length <= 3 ? files.join(', ') : `${files.length} files`,
      changed: !!git(['status', '--porcelain', '--', `${m.id}/data`], collDir).trim(),
      snapped: snapped.length > 0,
    };
  }
  cutNames.push({ id: m.id, version, prevVersion, changed, data });
}

const message = 'package ' + cutNames.map((c) => `${c.id}@${c.version}`).join(' + ');
const hash = gitCommitAll(collDir, message);

// Per-module report: the module line, and data — deliberately — on its own
// line, with its own changed/unchanged verdict.
console.log('');
for (const c of cutNames) {
  console.log(`  ${c.changed ? '✓' : '·'} ${c.id} ${c.version}${c.changed ? '' : '   (unchanged)'}`);
  if (c.data) {
    console.log(`      data: ${c.data.label} — ${c.data.changed ? 'changed' : 'unchanged'}${c.data.snapped ? ' · live sqlite snapshot' : ''}`);
  }
  if (c.changed && c.prevVersion !== null && c.prevVersion === c.version) {
    console.log(`      ! recut at the same version (${c.version}) — consider bumping it in the module's package.json`);
  }
}
if (!hash) {
  console.log(`\n  nothing new to commit — collection "${collection}" is current.\n`);
  process.exit(0);
}
console.log(`\n  ✓ packaged  →  ${COLLECTIONS_DIR}/${collection}/  (commit ${hash})`);
console.log(`    publish it:  ${CLI_NAME} publish ${collection} --serve      (share on this network)`);
console.log(`                 ${CLI_NAME} publish ${collection} --to <git-url>\n`);
