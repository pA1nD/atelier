#!/usr/bin/env node
/* atelier add — subscribe to a collection and install its modules.
 *
 *   npx atelier add github:owner/repo          first contact: clone + install all
 *   npx atelier add <collection>               pull + install what you're missing
 *   npx atelier add <collection>/<module>      install one module from it
 *
 * THE NORM: the only thing atelier shares is a COLLECTION — a git repo whose
 * top-level folders are modules (what `atelier package` produces). `add` is
 * therefore `git clone`: sources always wear a scheme (github:owner/repo, any
 * git url, http(s) — git's dumb protocol, a local path or .bundle file), bare
 * words always name a collection you're already subscribed to. Subscriptions
 * are mirrors under `_collections/` — pull-pristine channel state; installed
 * modules are working copies COPIED OUT of the mirror into the instance.
 *
 * `add` only ever creates: modules you already have are skipped, never
 * touched (--force replaces one, preserving its live data/). A `.atelier`
 * file written into each installed module records where it came from and at
 * which mirror commit — the provenance a future update needs for its merge
 * base.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  resolveRoot, RESERVED_NAMES, GLOBAL_WORKSPACE,
  loadModuleConfig, collectConfigPaths, resolvePathEntry, isWorkspaceDir,
} from './discovery.js';
import {
  COLLECTIONS_DIR, collectionDir, collectionsRoot, listCollections, listModuleDirs,
  isModuleFolder, readPkg, copyModuleFiltered, git, gitErr, gitHead, CLI_NAME,
} from './collections.js';

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const fail = (msg) => { console.error(`\natelier add: ${msg}\n`); process.exit(1); };

/* ---- args ---------------------------------------------------------------- */
const USAGE = `usage: atelier add <source>                    subscribe to a collection + install all its modules
       atelier add <collection>                pull + install any modules you're missing
       atelier add <collection>/<module>       install one module from a subscribed collection
  <source>   where a collection's git repo lives — always scheme-prefixed:
             github:owner/repo · any git url (git+ssh://…, git@…) · an http(s) url
             (a served collection) · a local path or .bundle file
  --as <name>       local name for a new subscription (default: the source's basename)
  --workspace <ws>  install modules into $<ws>/ instead of the global workspace
  --force           replace an existing module folder (its data/ is preserved)
  --yes             also run the install hints of missing system needs`;
const args = process.argv.slice(2);
let spec = null, as = null, workspace = null, force = false, yes = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--as') as = args[++i] || fail('--as needs a name');
  else if (a === '--workspace') workspace = args[++i] || fail('--workspace needs a name');
  else if (a === '--force') force = true;
  else if (a === '--yes') yes = true;
  else if (!a.startsWith('-') && spec === null) spec = a;
  else fail(`unknown option: ${a}\n\n${USAGE}`);
}
if (!spec) fail(USAGE);
if (workspace && !/^[a-zA-Z0-9][\w.-]*$/.test(workspace)) fail(`"${workspace}" isn't a usable workspace name`);

const ROOT = resolveRoot({ atelierRoot: process.env.ATELIER_ROOT, pwd: process.env.PWD, hostDir: HOST_DIR });
console.log(`\n  instance: ${ROOT}`);

/* ---- what kind of argument is this? ----------------------------------------
 * Sources wear schemes; names never do. Resolution is syntax-directed — the
 * same command means the same thing on every machine, regardless of what
 * happens to be subscribed here.
 * ---------------------------------------------------------------------------- */
const isGitUrl = (s) => /^(git\+ssh:\/\/|git\+https:\/\/|ssh:\/\/|git@|file:\/\/)/.test(s) || /^https?:\/\//.test(s);
const isPathSpec = (s) => /^(\.{1,2}\/|~\/|\/)/.test(s) || s.endsWith('.bundle');
const isSource = (s) => s.startsWith('github:') || isGitUrl(s) || isPathSpec(s);
const NAME_RE = /^[a-zA-Z0-9][\w.-]*$/;

function cloneUrlFor(source) {
  if (source.startsWith('github:')) {
    const repo = source.slice(7);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(`"${source}" — github: takes owner/repo`);
    return `https://github.com/${repo}.git`;
  }
  if (isPathSpec(source)) {
    let p = source;
    if (p === '~' || p.startsWith('~/')) p = path.join(process.env.HOME || '', p.slice(2));
    return path.resolve(process.cwd(), p);
  }
  return source.replace(/^git\+/, '');
}

const localNameFor = (source) =>
  path.basename(cloneUrlFor(source)).replace(/\.git$/, '').replace(/\.bundle$/, '');

/* ---- subscribe (first contact) ---------------------------------------------- */
async function subscribe(source) {
  const url = cloneUrlFor(source);
  const name = as || localNameFor(source);
  if (!NAME_RE.test(name)) fail(`"${name}" isn't a usable collection name — pick one with --as`);
  if (RESERVED_NAMES.has(name)) fail(`"${name}" is a reserved name — pick another with --as`);
  const dest = collectionDir(ROOT, name);
  if (fs.existsSync(dest)) {
    fail(`already subscribed to "${name}" (${COLLECTIONS_DIR}/${name}/)
  Install from it:            ${CLI_NAME} add ${name}
  Subscribe under a new name: ${CLI_NAME} add ${source} --as <name>`);
  }
  fs.mkdirSync(collectionsRoot(ROOT), { recursive: true });
  try {
    // A full clone, deliberately not shallow: the mirror's history is the
    // merge base a future update needs.
    execFileSync('git', ['clone', '-q', url, dest],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  } catch (e) {
    fail(`could not clone ${url}\n  ${gitErr(e)}`);
  }
  if (!listModuleDirs(dest).length) {
    fs.rmSync(dest, { recursive: true, force: true });
    fail(`${source} is not a collection — its top level has no module folders.
  Collections are what \`atelier package\` produces; there is no other shareable shape.`);
  }
  console.log(`  subscribed: ${name}   (cloned → ${COLLECTIONS_DIR}/${name}/)`);
  return name;
}

/* ---- refresh a subscribed mirror (pull-pristine, so ff-only) ----------------- */
function refresh(name) {
  const dir = collectionDir(ROOT, name);
  const hasRemote = (() => { try { git(['remote', 'get-url', 'origin'], dir); return true; } catch { return false; } })();
  if (!hasRemote) return;
  try { git(['pull', '-q', '--ff-only'], dir); }
  catch (e) { console.log(`  ! could not reach ${name}'s origin — installing from the local mirror\n    (${gitErr(e)})`); }
}

/* ---- install one module out of a mirror -------------------------------------- */
const runNpm = (npmArgs, opts = {}) => process.env.npm_execpath
  ? execFileSync(process.execPath, [process.env.npm_execpath, ...npmArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
  : execFileSync('npm', npmArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

let anyDepsFailed = false;

const pendingStagings = new Set();
process.on('exit', () => { for (const s of pendingStagings) { try { fs.rmSync(s, { recursive: true, force: true }); } catch {} } });

// Everywhere this instance already mounts a module with this id — root
// folders, $<ws>/ folders, AND atelier.config.json path-mounts (working
// trees can live anywhere on disk). Installing a same-named module without
// noticing would quietly give the instance two of them.
function existingElsewhere(id, dest) {
  const hits = [];
  const consider = (dir, ws, mounted) => {
    if (dir !== dest && isModuleFolder(dir)) hits.push({ q: `${ws}/${id}`, dir, mounted });
  };
  consider(path.join(ROOT, id), GLOBAL_WORKSPACE, false);
  let ents = [];
  try { ents = fs.readdirSync(ROOT, { withFileTypes: true }); } catch {}
  for (const e of ents) {
    if (e.isDirectory() && isWorkspaceDir(e.name)) consider(path.join(ROOT, e.name, id), e.name.slice(1), false);
  }
  for (const entry of collectConfigPaths(loadModuleConfig(ROOT), { globalWorkspace: GLOBAL_WORKSPACE })) {
    const abs = resolvePathEntry(entry.path, ROOT);
    if (!abs) continue;
    if ((entry.id || path.basename(abs)) === id) consider(abs, entry.workspace, true);
  }
  return hits;
}

function installModule(collection, id) {
  const src = path.join(collectionDir(ROOT, collection), id);
  if (RESERVED_NAMES.has(id)) { console.log(`  ! skipping ${id} — a reserved name in atelier`); return false; }
  const destParent = workspace ? path.join(ROOT, '$' + workspace) : ROOT;
  const dest = path.join(destParent, id);
  const qualified = `${workspace || 'global'}/${id}`;

  if (fs.existsSync(dest) && !force) {
    console.log(`  · ${qualified} already installed — kept (yours; --force replaces it, data/ preserved)`);
    return false;
  }
  const elsewhere = existingElsewhere(id, dest);
  if (elsewhere.length && !force) {
    for (const h of elsewhere) {
      console.log(`  · ${id} already lives in this instance as ${h.q}${h.mounted ? `  (path-mounted from ${h.dir.replace(process.env.HOME, '~')})` : ''} — skipped`);
    }
    console.log(`    (--force installs a separate ${qualified} copy alongside it)`);
    return false;
  }

  // Stage under a dot-prefixed name — invisible to discovery. A RUNNING
  // instance hot-mounts new folders on its next request, so deps install into
  // the staging dir and only a complete module is renamed into place (same
  // parent dir → same fs → atomic).
  fs.mkdirSync(destParent, { recursive: true });
  const staging = path.join(destParent, `.add-${id}-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  pendingStagings.add(staging);
  copyModuleFiltered(src, staging, { includeData: true });   // a cut's data/ is first-install content

  /* deps — the module's own package.json is the manifest */
  const pkg = readPkg(staging);
  let depsFailed = false;
  if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
    console.log(`  installing dependencies for ${id} (${Object.keys(pkg.dependencies).join(', ')})…`);
    try {
      execFileSync(process.env.npm_execpath ? process.execPath : 'npm',
        process.env.npm_execpath
          ? [process.env.npm_execpath, 'install', '--no-fund', '--no-audit']
          : ['install', '--no-fund', '--no-audit'],
        { cwd: staging, stdio: ['ignore', 'inherit', 'inherit'] });
    } catch {
      depsFailed = true;   // still land the module, fail loud below
    }
  }

  // Provenance: which mirror commit this working copy came from — the merge
  // base a future update needs, and never distributed onward (the packaging
  // filter strips it).
  fs.writeFileSync(path.join(staging, '.atelier'), JSON.stringify({
    collection, module: id, commit: gitHead(collectionDir(ROOT, collection)), installedAt: new Date().toISOString(),
  }, null, 2) + '\n');

  // --force: carry the LIVE module's data/ into the staged copy at the last
  // moment — a rename, not a snapshot, so nothing written during a long dep
  // install is lost.
  const oldData = path.join(dest, 'data');
  if (fs.existsSync(oldData)) {
    fs.rmSync(path.join(staging, 'data'), { recursive: true, force: true });
    fs.renameSync(oldData, path.join(staging, 'data'));
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(staging, dest);
  pendingStagings.delete(staging);
  console.log(`  installed: ${qualified}  ←  ${collection}`);
  if (depsFailed) {
    anyDepsFailed = true;
    console.error(`
  ✗ DEPENDENCY INSTALL FAILED for ${qualified}
    The module is in place at ${dest}, but its npm dependencies did not
    install — it will NOT work until they do. Fix the error above, then:
      cd ${dest} && npm install
`);
  }
  reportNeeds(pkg, qualified);
  updateFilter(id);
  return true;
}

/* ---- system needs — the module's own `atelier` block ------------------------ */
function reportNeeds(pkg, qualified) {
  const needs = pkg.atelier && typeof pkg.atelier === 'object' ? pkg.atelier : {};
  const binOk = (b) => { try { execFileSync('/bin/sh', ['-c', `command -v ${b}`], { stdio: 'ignore' }); return true; } catch { return false; } };
  const declaredBins = Object.entries(needs.bins && typeof needs.bins === 'object' ? needs.bins : {})
    .filter(([b]) => /^[A-Za-z0-9._-]+$/.test(b) || (console.log(`  ! ignoring unusable bin name in atelier.bins: ${JSON.stringify(b)}`), false));
  let missingBins = declaredBins.filter(([b]) => !binOk(b));
  if (yes && missingBins.length) {
    for (const [b, hint] of missingBins) {
      if (!hint) continue;
      console.log(`  running install hint for ${b}:  ${hint}`);
      try { execFileSync('/bin/sh', ['-c', String(hint)], { stdio: ['ignore', 'inherit', 'inherit'] }); }
      catch { console.log(`  ! hint for ${b} exited non-zero`); }
    }
    missingBins = declaredBins.filter(([b]) => !binOk(b));   // re-check honestly
  }
  const missingEnv = (Array.isArray(needs.env) ? needs.env : []).filter((k) => !process.env[k]);
  const osMismatch = Array.isArray(needs.os) && needs.os.length && !needs.os.includes(process.platform);
  if (needs.note) console.log(`  note: ${needs.note}`);
  if (osMismatch || missingBins.length || missingEnv.length) {
    console.log(`  ! ACTION NEEDED — ${qualified} is installed and will run, but degraded until:`);
    if (osMismatch) console.log(`    · it targets os [${needs.os.join(', ')}] — this machine is ${process.platform}`);
    for (const [b, hint] of missingBins) console.log(`    · missing ${b}${hint ? `  →  ${hint}` : ''}`);
    for (const k of missingEnv) console.log(`    · missing env ${k} — provide it via your environment or launcher`);
    if (missingBins.some(([, h]) => h) && !yes) console.log(`    (re-run with --yes to run the install hints)`);
  }
}

/* ---- the instance's module filter --------------------------------------------
 * With no config (or no `modules` list) everything runs — nothing to do. With
 * an allow-mode list, a new module must be listed or it silently won't mount;
 * append it (the filter file is re-read per request, so this is live).
 * ------------------------------------------------------------------------------ */
function updateFilter(id) {
  const CONFIG_PATH = path.join(ROOT, 'atelier.config.json');
  let config;
  try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return; }
  if (!config || !Array.isArray(config.modules)) return;
  const entries = config.modules;
  const isDeny = (e) => (typeof e === 'string' && e.startsWith('!')) || (e && typeof e === 'object' && typeof e.workspace === 'string' && e.workspace.startsWith('!'));
  const hasAllow = entries.some((e) => !isDeny(e)), hasDeny = entries.some(isDeny);
  if (!hasAllow) return;
  if (hasDeny) { console.log(`  ! atelier.config.json mixes allow + deny — add "${id}" to its modules list yourself`); return; }
  if (!workspace) {
    if (entries.some((e) => e === id || (e && typeof e === 'object' && e.id === id))) return;
    entries.push(id);
  } else {
    const ws = entries.find((e) => e && typeof e === 'object' && e.workspace === workspace);
    if (!ws) entries.push({ workspace, modules: [id] });
    else if (Array.isArray(ws.modules) && !ws.modules.includes(id)) ws.modules.push(id);
    else if (!Array.isArray(ws.modules)) return;               // whole workspace already included
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  console.log(`  config: added "${id}" to the modules filter (live — no restart needed)`);
}

/* ---- go ----------------------------------------------------------------------- */
let collection, only = null;

if (isSource(spec)) {
  collection = await subscribe(spec);
} else if (NAME_RE.test(spec)) {
  collection = spec;
} else if (/^[a-zA-Z0-9][\w.-]*\/[a-zA-Z0-9][\w.-]*$/.test(spec)) {
  [collection, only] = spec.split('/');
} else {
  fail(`"${spec}" is neither a source (scheme-prefixed) nor a collection name\n\n${USAGE}`);
}

const dir = collectionDir(ROOT, collection);
if (!fs.existsSync(dir)) {
  const have = listCollections(ROOT);
  fail(`not subscribed to "${collection}"${have.length ? ` — you have: ${have.join(', ')}` : ''}
  Subscribe first:  ${CLI_NAME} add github:owner/repo   (or any git url / path / .bundle)`);
}
if (!isSource(spec)) refresh(collection);   // a fresh subscription is already current

const offered = listModuleDirs(dir);
if (only && !offered.includes(only)) {
  fail(`no module "${only}" in collection "${collection}" — it offers: ${offered.join(', ') || '(nothing)'}`);
}
const targets = only ? [only] : offered;
let installed = 0;
for (const id of targets) {
  if (installModule(collection, id)) installed++;
}

if (installed) {
  console.log(`\n  ✓ ${installed} module${installed === 1 ? '' : 's'} installed — a running instance mounts them on the next request.\n`);
} else {
  console.log(`\n  nothing new to install from "${collection}".\n`);
}
if (anyDepsFailed) process.exit(1);
