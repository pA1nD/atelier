/* Atelier runner — host mode + standalone mode.
 *
 *   node atelier/server.js              → host mode, all modules listed in the rail
 *   node atelier/server.js <module-id>  → standalone mode, just that module
 *
 * Conventions:
 *   • A sibling directory of atelier/ is a module iff it contains a `frontend.jsx`
 *     or `backend.js`. The directory name is the id and default name.
 *   • frontend.jsx is compiled as ESM. It should `export default function Module`
 *     and may `export const meta = { icon, color }` to customize the rail item.
 *   • backend.js exports `default { mountRoutes(router, ctx) }` for API routes.
 *
 * Asset URLs (convention-driven, no registration):
 *   /assets/<name>.js              → atelier/<name>.jsx     (esbuild, ESM)
 *   /assets/<name>.css             → atelier/<name>.css     (tailwind + oxide)
 *   /modules/<id>/frontend.js      → <id>/frontend.jsx      (esbuild, ESM)
 *
 * Hot reload: /_atelier/ws is a shared multiplexed WebSocket. fs.watch
 * (recursive) fires on any change under the project root and the server
 * broadcasts a `{ topic: 'shell', type: 'reload', moduleId }` frame — the
 * client full-reloads when the active module / shell changed, otherwise
 * marks the module dirty and reloads on next navigation. Discovery is
 * per-request so new folders appear without restart. Backends are mounted
 * lazily on first discovery.
 * (Editing server.js or atelier.js still requires a manual restart.)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transform as esbuildTransform, build as esbuildBuild } from 'esbuild';
import chokidar from 'chokidar';
import { WebSocketServer } from 'ws';
import {
  getJsx, getCss,
  loadModuleConfig, applyModuleFilter, CONFIG_FILENAME,
  RESERVED_NAMES, isSpecialDir,
} from './atelier.js';

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HOST_DIR, '..');
const PORT = parseInt(process.env.PORT || '1844', 10);

const [, , requestedId] = process.argv;
const MODE = requestedId ? 'standalone' : 'host';

// "dev" is any atelier NOT running from ~/.atelier/atelier (i.e. anywhere
// other than the installed production copy). Used to badge the UI and
// passed to module backends via ctx.env so each module can tune its own
// behavior — e.g. the agents supervisor self-disables in dev by default.
const INSTALL_ROOT = path.join(process.env.HOME || '', '.atelier', 'atelier');
const IS_DEV = HOST_DIR !== INSTALL_ROOT;
const ENV = IS_DEV ? 'dev' : 'prod';

// Hoisted up here (out of the WS section below) because module mounting
// happens at `await mountPendingBackends()` further down, and a module's
// mountRoutes can spawn child processes whose stdout/stderr stream events
// fire async handlers that call ctx.broadcast → wsBroadcast → wsClients.
// If wsClients is still in TDZ when one of those handlers fires (typical
// in prod where ATELIER_AGENTS=on spawns a child immediately), the throw
// is uncaught and crashes the server. Declaring it before mounting puts
// wsClients in scope for every closure that needs it.
const wsClients = new Set();

// ------------------------------------------------------------------------
// Router — tiny path+method matcher with req.json / res.json helpers
// ------------------------------------------------------------------------

function createRouter() {
  const routes = [];

  function compile(pathPattern) {
    const paramNames = [];
    const re = new RegExp(
      '^' +
        pathPattern
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/:([a-zA-Z_]\w*)/g, (_, n) => {
            paramNames.push(n);
            return '([^/]+)';
          }) +
        '$'
    );
    return { re, paramNames };
  }

  function add(method, pathPattern, handler) {
    const { re, paramNames } = compile(pathPattern);
    const entry = { method, re, paramNames, handler };
    routes.push(entry);
    return entry;
  }

  function remove(entry) {
    const i = routes.indexOf(entry);
    if (i >= 0) routes.splice(i, 1);
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://localhost`);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = {};
      r.paramNames.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      req.params = params;
      req.query = Object.fromEntries(url.searchParams);
      req.json = () => readJsonBody(req);
      res.json = (data, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      try {
        await r.handler(req, res);
      } catch (err) {
        if (!res.writableEnded) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        console.error(err);
      }
      return true;
    }
    return false;
  }

  return {
    get:    (p, h) => { add('GET',    p, h); },
    post:   (p, h) => { add('POST',   p, h); },
    put:    (p, h) => { add('PUT',    p, h); },
    delete: (p, h) => { add('DELETE', p, h); },
    patch:  (p, h) => { add('PATCH',  p, h); },
    handle,
    _add: add,        // returns the entry — used by per-module scopes
    _remove: remove,  // used on hot-swap to strip a module's routes
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ------------------------------------------------------------------------
// Module discovery — lazy, re-runs on each call
// ------------------------------------------------------------------------

// Discovery rules (RESERVED_NAMES, isSpecialDir) are imported from atelier.js
// so the runner and the install CLI agree on what counts as a module.

function discoverModules() {
  const out = [];
  for (const name of fs.readdirSync(ROOT)) {
    if (isSpecialDir(name)) continue;
    if (RESERVED_NAMES.has(name)) continue;
    const dir = path.join(ROOT, name);
    let stat;
    try { stat = fs.statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;

    const hasFrontend = fs.existsSync(path.join(dir, 'frontend.jsx'));
    const hasBackend  = fs.existsSync(path.join(dir, 'backend.js'));
    if (!hasFrontend && !hasBackend) continue;

    out.push({ id: name, dir, hasFrontend, hasBackend });
  }
  return out;
}

// Per-id dedupe so a typo in atelier.config.json doesn't spam the log on
// every request (getModules is called multiple times per request).
const warnedConfigMisses = new Set();

function getModules() {
  let mods = discoverModules();
  if (MODE === 'standalone') {
    // Standalone mode is an explicit user choice — bypass the config filter
    // so a module excluded for this env can still be inspected via
    // `node server.js <id>`.
    const only = mods.find((m) => m.id === requestedId);
    return only ? [only] : [];
  }
  const cfg = loadModuleConfig(ROOT);
  return applyModuleFilter(mods, cfg[ENV], {
    getId: (m) => m.id,
    warn: (id) => {
      if (warnedConfigMisses.has(id)) return;
      warnedConfigMisses.add(id);
      console.warn(`  ! ${CONFIG_FILENAME}: '${id}' listed for ${ENV} but no such module exists`);
    },
  });
}

// ------------------------------------------------------------------------
// Module meta extraction — read each module's `export const meta = {...}`
// at discovery so the bootstrap can seed the rail with icons/names/groups
// without waiting for the dynamic import on the client. Eliminates the
// first-paint flicker where grouped modules briefly render ungrouped.
//
// How it works: transform the JSX with esbuild, wrap in a data: URL, and
// dynamic-import it in Node. `meta` is a plain top-level object literal —
// no React needed at module load — so a Proxy stub for `React` is enough
// to let `const { useState } = React;` not throw. Cached by file mtime so
// repeated requests pay the cost once per edit.
// ------------------------------------------------------------------------

const metaCache = new Map();   // moduleId → { meta, mtimeMs }
let reactStubbed = false;

function stubReactOnce() {
  if (reactStubbed) return;
  globalThis.React = new Proxy({}, { get: () => () => null });
  reactStubbed = true;
}

async function readMeta(src) {
  stubReactOnce();
  const code = fs.readFileSync(src, 'utf8');
  const out = await esbuildTransform(code, {
    loader: 'jsx',
    format: 'esm',
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
  });
  const url = 'data:text/javascript;base64,' + Buffer.from(out.code).toString('base64');
  const mod = await import(url);
  return mod.meta || {};
}

async function getModuleMeta(m) {
  if (!m.hasFrontend) return {};
  const src = path.join(m.dir, 'frontend.jsx');
  let mtimeMs;
  try { mtimeMs = fs.statSync(src).mtimeMs; } catch { return {}; }
  const cached = metaCache.get(m.id);
  if (cached && cached.mtimeMs === mtimeMs) return cached.meta;
  try {
    const meta = await readMeta(src);
    metaCache.set(m.id, { meta, mtimeMs });
    return meta;
  } catch (err) {
    console.warn(`  ! meta read failed for ${m.id}: ${err.message}`);
    metaCache.set(m.id, { meta: {}, mtimeMs });
    return {};
  }
}

// ------------------------------------------------------------------------
// README frontmatter — optional per-module declarations.
//
// A module *may* have a README.md, and that README *may* start with a YAML
// frontmatter block (`---\n…\n---\n`). Both are optional. Currently the
// only declaration we read is `atelier.requires`, a list of other module
// ids this module needs. Missing dependencies log a warning at mount time
// — purely informational, never fatal. Other declarations are preserved
// on the parsed object for future use.
//
// We intentionally don't pull in a YAML library: the surface we accept is
// small (see parseYamlSubset below) and a tiny indent-based parser keeps
// the shell dep-free.
// ------------------------------------------------------------------------

const readmeCache    = new Map();   // moduleId → { frontmatter, mtimeMs }
const warnedRequires = new Set();   // dedupe `<module>→<missing>` pairs

/**
 * Strip a single matched pair of leading/trailing single or double quotes.
 * Mixed quotes (`"foo'`) and unbalanced quotes are left as-is — we treat
 * frontmatter as authored by humans, not generated, so the surface is small.
 */
function stripFrontmatterQuotes(value) {
  if (value.length < 2) return value;
  const first = value[0];
  const last  = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse the supported subset of YAML used in module README frontmatter:
 *
 *   • Top-level mappings:      `key: value`
 *   • Nested mappings:         indent under a key with no inline value
 *   • Sequences of scalars:    `- item` lines, indented under a key
 *   • Sequences of mappings:   `-` on its own line, followed by an indented
 *                              block (the inline form `- key: value` is NOT
 *                              recognized as a mapping — it parses as the
 *                              literal string `"key: value"`)
 *   • Single-quoted strings:   `'foo'`     → foo
 *   • Double-quoted strings:   `"foo"`     → foo
 *   • Comments:                lines starting with `#` (after indentation)
 *
 * NOT supported (silently treated as plain strings or skipped): flow-style
 * `[a, b]` / `{k: v}`, multiline scalars (`|`, `>`), anchors (`&`, `*`),
 * tags (`!!str`), escape sequences inside quotes, type coercion (`true` /
 * `42` come out as the strings `"true"` / `"42"`). If a module needs any
 * of those it should use plain strings — or we add a real YAML dep when
 * the cost stops being worth it.
 *
 * Indentation is space-only (tabs are treated as content). Empty lines are
 * ignored. The parser is single-pass and recursive on indent depth.
 */
function parseYamlSubset(text) {
  // Tokenize: keep only lines with content, recording each line's indent
  // depth and the trimmed-left content. Comments and blanks are dropped.
  const lines = [];
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = raw.match(/^ */)[0].length;
    lines.push({ indent, content: raw.slice(indent) });
  }

  let pos = 0;

  // Look ahead from `pos` to find the indent of the next line, falling back
  // to `floor + 2` when we're at EOF. Used to start a child block when a
  // key/list-item has no inline value.
  function nextIndentOr(floor) {
    return pos < lines.length ? lines[pos].indent : floor + 2;
  }

  // Parse a contiguous run of lines whose indent ≥ minIndent. Returns an
  // array (if the first line at minIndent is a list item), an object (if
  // it's a `key: value` mapping), or {} for an empty block.
  function parseBlock(minIndent) {
    let collection = null;   // null until we know whether we're array or object

    while (pos < lines.length) {
      const line = lines[pos];
      if (line.indent < minIndent) break;

      // List item: `- foo` or `-` (with a child block on following lines).
      if (line.content.startsWith('- ') || line.content === '-') {
        if (collection === null) collection = [];
        const inline = line.content === '-' ? '' : line.content.slice(2).trim();
        pos++;
        if (inline === '') {
          collection.push(parseBlock(nextIndentOr(line.indent)));
        } else {
          collection.push(stripFrontmatterQuotes(inline));
        }
        continue;
      }

      // Mapping: `key: value` or `key:` (with a child block on following lines).
      const match = line.content.match(/^([^:]+):\s*(.*)$/);
      if (!match) { pos++; continue; }    // unrecognized line — skip rather than throw
      if (collection === null) collection = {};
      const key   = match[1].trim();
      const value = match[2].trim();
      pos++;

      if (value === '') {
        // Child block only if it's actually indented past this line; otherwise
        // we have an empty-string value (e.g. trailing `key:` at end of file).
        const childIndent = nextIndentOr(line.indent);
        collection[key] = childIndent > line.indent ? parseBlock(childIndent) : '';
      } else {
        collection[key] = stripFrontmatterQuotes(value);
      }
    }

    return collection === null ? {} : collection;
  }

  return parseBlock(0);
}

/**
 * Extract the YAML frontmatter block from a markdown document. Recognized
 * shape: the file starts with a `---` line, followed by zero or more YAML
 * lines, followed by a closing `---` line. Returns `{}` for documents that
 * don't open with `---` or don't have a closing fence, and for malformed
 * frontmatter (parse errors are swallowed — frontmatter is purely advisory).
 */
function extractFrontmatter(text) {
  if (!/^---\r?\n/.test(text)) return {};
  const afterOpen = text.replace(/^---\r?\n/, '');
  const closeAt   = afterOpen.search(/\r?\n---(\r?\n|$)/);
  if (closeAt < 0) return {};
  try { return parseYamlSubset(afterOpen.slice(0, closeAt)); }
  catch { return {}; }
}

function getModuleReadme(m) {
  const src = path.join(m.dir, 'README.md');
  let mtimeMs;
  try { mtimeMs = fs.statSync(src).mtimeMs; }
  catch { return {}; }                     // no README — fine
  const cached = readmeCache.get(m.id);
  if (cached && cached.mtimeMs === mtimeMs) return cached.frontmatter;
  let text;
  try { text = fs.readFileSync(src, 'utf8'); }
  catch { return {}; }
  const frontmatter = extractFrontmatter(text);
  readmeCache.set(m.id, { frontmatter, mtimeMs });
  return frontmatter;
}

function checkRequires() {
  const mods = getModules();
  const idSet = new Set(mods.map((x) => x.id));
  for (const m of mods) {
    const fm = getModuleReadme(m);
    const requires = fm.atelier?.requires;
    if (!Array.isArray(requires)) continue;
    for (const req of requires) {
      if (typeof req !== 'string') continue;
      if (idSet.has(req)) continue;
      const pair = `${m.id}→${req}`;
      if (warnedRequires.has(pair)) continue;
      warnedRequires.add(pair);
      console.warn(`  ! ${m.id} requires '${req}' (declared in README.md frontmatter) but it isn't installed`);
    }
  }
}

// Validate standalone target exists at boot (fail fast if typo).
if (MODE === 'standalone') {
  const all = discoverModules();
  if (!all.find((m) => m.id === requestedId)) {
    console.error(`\n  Module '${requestedId}' not found.`);
    if (all.length) console.error(`  Available: ${all.map((m) => m.id).join(', ')}\n`);
    else console.error(`  No modules discovered in ${ROOT}.\n`);
    process.exit(1);
  }
}

console.log(`\n  Atelier · ${MODE}`);
for (const m of getModules()) {
  console.log(`    • ${m.id}${m.hasBackend ? '' : ' (frontend-only)'}`);
}
if (getModules().length === 0) console.log(`    (no modules yet)`);
checkRequires();

// ------------------------------------------------------------------------
// Backend mounting — lazy, per-module, hot-swappable in dev.
//
// Each module's `backend.js` is mounted via a scoped router that tracks
// exactly the routes that module added. Editing the file triggers a
// per-module reload: the new version is imported first (cache-busted),
// and only if it imports cleanly does the old version get torn down.
// A typo in a module keeps the old version running so other modules
// are unaffected.
//
// Module API (existing contract, plus one addition):
//   export default {
//     mountRoutes(router, ctx) {
//       // ... register routes, start timers, open watchers, etc.
//       return () => { ... };  // optional — called before reload/teardown
//     }
//   }
//
// If `mountRoutes` returns a function, it's treated as the module's
// teardown (close watchers, kill children, end SSE clients, remove
// process.once listeners). Without it, routes still get stripped but
// module-held state leaks across reloads.
//
// Hot-swap is dev-only (see IS_DEV) — prod runs untouched under launchd.
// ------------------------------------------------------------------------

const router = createRouter();
const mountedBackends = new Map();   // id → { scope, teardown }
const attemptedBackends = new Set(); // id → tried once via mountPendingBackends
const backendWatchers = new Map();   // id → fs.FSWatcher
const pendingReloads = new Map();    // id → debounce timer
const lastReloadMtime = new Map();   // id → mtimeMs actually processed

// Cross-module slot registry. Each module id maps to a plain object that
// any module can read or write to. Lives on globalThis so hot-reloads of
// individual modules don't reset the shared state. The shell itself isn't
// hot-reloaded — editing server.js requires a manual restart — so this
// Map is created once per `npm run dev` lifetime and survives every
// backend.js edit.
//
// The contract is plain data: there are NO methods, NO subscribe/notify,
// NO validation. Owning modules read their slot lazily (at use time, not
// at mount time) so the order in which modules mount is irrelevant — the
// fact that `discoverModules` happens to return them alphabetically would
// otherwise create real races (e.g. `mc-lab` mounting before
// `mission-control`).
//
// Owners decide what shape they accept; consumers write that shape; both
// sides document the contract in their own source. The shell stays
// neutral about meaning.
const moduleSlots = (globalThis.__atelierModuleSlots ??= new Map());
function getModuleSlot(id) {
  if (!moduleSlots.has(id)) moduleSlots.set(id, {});
  return moduleSlots.get(id);
}

function makeCtx(m) {
  return {
    id: m.id,
    name: m.id,
    env: ENV,
    dataDir: path.join(m.dir, 'data'),
    log: (...args) => console.log(`[${m.id}]`, ...args),
    // Broadcast a real-time event to every browser tab connected to the
    // shared WebSocket. The topic is fixed to the module's id, so the
    // shell stays out of authorship questions: a module can only emit
    // under its own name.
    broadcast: (event) => wsBroadcast(m.id, event || {}),
    // In-process slot lookup. Returns the SAME plain object regardless of
    // who calls it — that's the shared bit. See moduleSlots above for the
    // full contract; the short version: owners read lazily, consumers
    // write directly.
    module: (id) => getModuleSlot(id),
  };
}

function makeModuleScope() {
  const mine = [];
  return {
    get:    (p, h) => { mine.push(router._add('GET',    p, h)); },
    post:   (p, h) => { mine.push(router._add('POST',   p, h)); },
    put:    (p, h) => { mine.push(router._add('PUT',    p, h)); },
    delete: (p, h) => { mine.push(router._add('DELETE', p, h)); },
    patch:  (p, h) => { mine.push(router._add('PATCH',  p, h)); },
    _dispose() {
      for (const e of mine) router._remove(e);
      mine.length = 0;
    },
  };
}

async function importBackend(m) {
  // Bundle the module's backend + first-party transitive imports into a
  // single data-URL ESM chunk and import that. Each bundle produces a new
  // URL (unique byte content → unique data URL), so Node's import cache
  // naturally drops old versions when a new version replaces them. This
  // fixes the "edit parser.js, nothing happens" bug: all first-party
  // imports are baked in, one import invalidates everything.
  //
  // `packages: 'external'` keeps node_modules resolved through Node's
  // normal cache (we don't want to re-bundle express on every save).
  // `define` rewrites `import.meta.url` to the original file URL so
  // modules using `fileURLToPath(import.meta.url)` to locate themselves
  // at module scope (posts, agents, kanban, extract, dev-tools) keep
  // working without migration.
  const entry = path.join(m.dir, 'backend.js');
  const result = await esbuildBuild({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    packages: 'external',
    sourcemap: 'inline',
    target: 'node20',
    logLevel: 'silent',
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(entry).href) },
  });
  const code = result.outputFiles[0].text;
  const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  const mod = await import(url);
  const plug = mod.default;
  if (!plug?.mountRoutes) throw new Error('no default.mountRoutes export');
  return plug;
}

function mountPlug(m, plug) {
  const scope = makeModuleScope();
  try {
    const teardown = plug.mountRoutes(scope, makeCtx(m));
    mountedBackends.set(m.id, { scope, teardown: typeof teardown === 'function' ? teardown : null });
    return true;
  } catch (err) {
    console.error(`  ! ${m.id}.mountRoutes threw: ${err.message}`);
    scope._dispose();
    return false;
  }
}

async function mountBackend(m) {
  watchBackend(m);  // always watch so a broken file can be fixed-and-reloaded
  let plug;
  try { plug = await importBackend(m); }
  catch (err) {
    console.error(`  ! Failed to mount ${m.id}: ${err.message}`);
    return;
  }
  if (mountPlug(m, plug)) console.log(`  + mounted ${m.id} backend`);
}

async function reloadBackend(m) {
  let plug;
  try { plug = await importBackend(m); }
  catch (err) {
    console.error(`  ! ${m.id}: reload failed, keeping current version — ${err.message}`);
    return;
  }
  const prev = mountedBackends.get(m.id);
  if (prev) {
    try { prev.teardown?.(); } catch (err) { console.warn(`  ! ${m.id}.teardown: ${err.message}`); }
    prev.scope._dispose();
  }
  if (mountPlug(m, plug)) console.log(`  ↻ reloaded ${m.id} backend`);
}

// Tear down a mounted module — fires its teardown, releases its routes,
// closes its file watcher, and clears all per-id state so the same id can
// be remounted later (e.g. if the folder reappears). Also clears the
// frontend meta cache and pings open browser tabs so their sidebar
// (rendered from the boot-time module list) refreshes to reflect the new
// reality. Without that ping, the rail still shows the removed module
// until the user manually reloads, and clicks land on a 404 SPA page.
async function unmountBackend(id, reason = 'removed') {
  const prev = mountedBackends.get(id);
  if (prev) {
    try { prev.teardown?.(); } catch (err) { console.warn(`  ! ${id}.teardown: ${err.message}`); }
    try { prev.scope._dispose(); } catch (err) { console.warn(`  ! ${id} dispose: ${err.message}`); }
    mountedBackends.delete(id);
  }
  const w = backendWatchers.get(id);
  if (w) {
    try { await w.close(); } catch {}
    backendWatchers.delete(id);
  }
  attemptedBackends.delete(id);
  lastReloadMtime.delete(id);
  metaCache.delete(id);
  const pending = pendingReloads.get(id);
  if (pending) { clearTimeout(pending); pendingReloads.delete(id); }
  console.log(`  - unmounted ${id} backend (${reason})`);
  // Tell open clients to refresh — the rail/SPA was seeded with the old
  // module list at boot. 'shell' is the conventional id that triggers a
  // full window.location.reload() in the client (atelier/client.jsx).
  broadcastReload('shell');
}

function watchBackend(m) {
  if (!IS_DEV) return;                // prod stays untouched
  if (backendWatchers.has(m.id)) return;
  // Watch the module dir (not just backend.js) so transitive file edits
  // — parser.js, helpers.js, whatever backend.js imports — trigger a
  // reload too. Dir-level watching via chokidar survives atomic saves
  // (rename-over changes inode), which the previous `fs.watch(file)`
  // did not — first edit worked, subsequent ones silently died.
  //
  // `awaitWriteFinish` waits for the file size to settle before firing,
  // so a mid-write read can't hit a half-flushed bundle.
  try {
    const w = chokidar.watch(m.dir, {
      ignored: [/node_modules/, /\/data\//, /(^|[\/\\])\./],
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 40 },
    });
    const onFile = (p) => { if (p.endsWith('.js')) scheduleReload(m); };
    w.on('change', onFile).on('add', onFile);
    // Module folder removed (or backend.js gone) → teardown immediately so
    // routes, timers, and file handles don't outlive the source on disk.
    // Existence check guards against transient unlink events that chokidar
    // can emit during atomic saves on some filesystems.
    const onGone = () => {
      if (!fs.existsSync(m.dir) || !fs.existsSync(path.join(m.dir, 'backend.js'))) {
        unmountBackend(m.id, 'source removed').catch((err) =>
          console.warn(`  ! unmount ${m.id}: ${err.message}`));
      }
    };
    w.on('unlinkDir', onGone).on('unlink', onGone);
    backendWatchers.set(m.id, w);
  } catch (err) {
    console.warn(`  ! could not watch ${m.id}/: ${err.message}`);
  }
}

function scheduleReload(m) {
  clearTimeout(pendingReloads.get(m.id));
  pendingReloads.set(m.id, setTimeout(() => {
    pendingReloads.delete(m.id);
    // Dedupe by mtime. macOS `fs.watch` on a single file can deliver two
    // events per save, spaced ~150–200ms apart — outside the debounce
    // window, so they become two distinct reloads. Reading the mtime here
    // and comparing to the last one we processed is cheap and robust: real
    // saves always bump mtime, duplicate events don't.
    let mtime = 0;
    try { mtime = fs.statSync(path.join(m.dir, 'backend.js')).mtimeMs; } catch {}
    if (mtime && mtime === lastReloadMtime.get(m.id)) return;
    lastReloadMtime.set(m.id, mtime);
    reloadBackend(m).catch((err) => console.error(`  ! reload ${m.id}: ${err.message}`));
  }, 150));
}

async function mountPendingBackends() {
  const live = getModules();
  const liveIds = new Set(live.map((m) => m.id));
  // Reconcile: unmount anything that disappeared from disk since last call.
  // Belt-and-braces with the chokidar watcher in watchBackend — the watcher
  // catches in-session deletions instantly; this cleans up edge cases (e.g.
  // a module folder removed between server boot and first request, or
  // chokidar missing an event on some filesystems).
  for (const id of [...mountedBackends.keys()]) {
    if (!liveIds.has(id)) await unmountBackend(id, 'not in discovery');
  }
  for (const m of live) {
    if (!m.hasBackend) continue;
    if (attemptedBackends.has(m.id)) continue;
    attemptedBackends.add(m.id);
    await mountBackend(m);
  }
  checkRequires();
}

await mountPendingBackends();

// ------------------------------------------------------------------------
// Shutdown — fire every mounted module's teardown on graceful exit.
//
// Without this, Ctrl+C / SIGTERM kills the shell but leaves module
// children orphaned to launchd (PPID 1). The clearest case is statusbar
// (Swift NSStatusItem keeps drawing until the child's own stdin EOF
// detection trips, if it has one), but anything spawned by a module —
// agents' supervised claude processes, posts' workers, the voice
// sidecar — has the same shape.
//
// Idempotent: we may be reached via SIGINT, SIGTERM, AND 'exit' for the
// same shutdown. Run teardowns once and immediately exit.
// ------------------------------------------------------------------------

function teardownAllBackends(reason) {
  if (teardownAllBackends.called) return;
  teardownAllBackends.called = true;
  if (mountedBackends.size === 0) return;
  console.log(`\n  ${reason}: tearing down ${mountedBackends.size} backend(s)`);
  for (const [id, { scope, teardown }] of mountedBackends) {
    try { teardown?.(); } catch (err) { console.warn(`  ! ${id}.teardown: ${err.message}`); }
    try { scope._dispose(); } catch {}
  }
  mountedBackends.clear();
}

// `prependListener`, not `on`: agents/backend.js registers its own
// `process.on('SIGINT', stopAll)` during mount. Node fires handlers in
// registration order, and stopAll calls process.exit(0) immediately when
// it has no live children (the common dev case), which preempted mine.
// Prepending puts our global teardown ahead of any module's per-process
// signal handler.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.prependListener(sig, () => {
    teardownAllBackends(sig);
    // Exit code 130 for SIGINT (Ctrl+C), 0 for SIGTERM. Matches conventional
    // shell behavior so callers can tell the difference.
    process.exit(sig === 'SIGINT' ? 130 : 0);
  });
}
// Fallback for natural exit (e.g. an uncaught exception that Node walks
// past). Synchronous teardowns only — process is already shutting down.
process.on('exit', () => teardownAllBackends('exit'));

// ------------------------------------------------------------------------
// Crash banners
//
// We deliberately do NOT swallow uncaughtException / unhandledRejection —
// hiding bugs grows them. But the default Node output buries the cause
// under teardown noise, so when scrolling /tmp/atelier-dev.log after a
// crash you can't tell at a glance which module killed the server.
//
// These handlers print a single highly-visible banner identifying the
// fault before letting Node exit normally. The banner names the originating
// module by parsing the first frame of the stack that lives under the
// project root (skipping node:internal frames).
// ------------------------------------------------------------------------

function locateModuleFromStack(stack) {
  if (!stack) return null;

  // 1) Direct project file frames. Lazy so the path stops at the first
  // `:digit` rather than gobbling further. Allows spaces inside the path
  // (the project lives under "X002 - Atelier").
  for (const line of stack.split('\n')) {
    for (const m of line.matchAll(/(\/[^()\n]+?):(\d+)(?::\d+)?/g)) {
      const file = m[1];
      if (!file.startsWith(ROOT + '/')) continue;
      if (file.includes('/node_modules/')) continue;
      const rel = file.slice(ROOT.length + 1);
      return { file: rel, line: m[2], moduleId: rel.split('/')[0] };
    }
  }

  // 2) data:text/javascript;base64,... frames — module backends are
  // bundled by esbuild and loaded as data URIs (see mountBackend), so
  // their stack frames don't reference disk paths. The bundle carries
  // an inline source map whose `sources` array names the original files.
  // The entry point is the LAST source — pick it and resolve its module
  // id from the first path segment after the leading `../`.
  const du = stack.match(/data:text\/javascript;base64,([A-Za-z0-9+/=]+)/);
  if (du) {
    try {
      const code = Buffer.from(du[1], 'base64').toString('utf8');
      const smm = code.match(
        /\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)/
      );
      if (smm) {
        const sm = JSON.parse(Buffer.from(smm[1], 'base64').toString('utf8'));
        const sources = Array.isArray(sm.sources) ? sm.sources : [];
        for (let i = sources.length - 1; i >= 0; i--) {
          const s = sources[i].replace(/^(\.\.\/)+/, '');
          if (s.includes('/node_modules/')) continue;
          return { file: s, line: null, moduleId: s.split('/')[0] };
        }
      }
    } catch {}
  }

  return null;
}

function printCrashBanner(kind, err) {
  const stack = err && err.stack ? err.stack : String(err);
  const loc = locateModuleFromStack(stack);
  const where = loc
    ? `${loc.moduleId}  (${loc.file}${loc.line ? ':' + loc.line : ''})`
    : '<unknown — no project frame in stack>';
  const message = err && err.message ? err.message : String(err);
  const bar = '═'.repeat(72);
  // stderr so it doesn't interleave with module log lines on stdout.
  process.stderr.write(
    `\n${bar}\n` +
    `  FATAL — atelier dev server killed by ${kind}\n` +
    `  in:    ${where}\n` +
    `  error: ${message}\n` +
    `${bar}\n` +
    (stack ? `${stack}\n` : '') +
    `${bar}\n\n`
  );
}

process.on('uncaughtException', (err) => {
  printCrashBanner('uncaughtException', err);
  // Let Node's own crash path run (teardown via 'exit' handler, exit code 1).
  // Re-throwing inside the handler would loop; setting exitCode + exit is
  // the documented way to preserve the failure signal.
  process.exitCode = 1;
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  printCrashBanner('unhandledRejection', err);
  process.exitCode = 1;
  process.exit(1);
});

// ------------------------------------------------------------------------
// URL → source path mapping
// ------------------------------------------------------------------------

function resolveAssetSource(pathname) {
  // /assets/<name>.js  → atelier/<name>.jsx
  let m = /^\/assets\/([a-z0-9-]+)\.js$/.exec(pathname);
  if (m) {
    const src = path.join(HOST_DIR, m[1] + '.jsx');
    return fs.existsSync(src) ? { kind: 'jsx', src } : null;
  }
  // /assets/<name>.css → atelier/<name>.css
  m = /^\/assets\/([a-z0-9-]+)\.css$/.exec(pathname);
  if (m) {
    const src = path.join(HOST_DIR, m[1] + '.css');
    return fs.existsSync(src) ? { kind: 'css', src } : null;
  }
  // /modules/<id>/frontend.js → <id>/frontend.jsx
  m = /^\/modules\/([^/]+)\/frontend\.js$/.exec(pathname);
  if (m) {
    const mod = getModules().find((x) => x.id === m[1]);
    if (!mod || !mod.hasFrontend) return null;
    return { kind: 'jsx', src: path.join(mod.dir, 'frontend.jsx') };
  }
  return null;
}

// Every JSX source feeds class names into the CSS scan.
function cssScanSources() {
  return [
    path.join(HOST_DIR, 'client.jsx'),
    ...getModules().filter((m) => m.hasFrontend).map((m) => path.join(m.dir, 'frontend.jsx')),
  ];
}

// ------------------------------------------------------------------------
// Index.html — rendered per request with injected bootstrap
// ------------------------------------------------------------------------

async function serveIndex(res) {
  const template = fs.readFileSync(path.join(HOST_DIR, 'index.html'), 'utf8');
  const mods = getModules().filter((m) => m.hasFrontend);
  const metas = await Promise.all(mods.map((m) => getModuleMeta(m)));
  const bootstrap = {
    mode: MODE,
    env: ENV,
    modules: mods.map((m, i) => ({
      id: m.id,
      name: m.id,
      hasFrontend: m.hasFrontend,
      meta: metas[i],
    })),
  };
  const html = template.replace(
    '/*__ATELIER_BOOTSTRAP__*/',
    `window.__ATELIER__ = ${JSON.stringify(bootstrap)};`
  );
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ------------------------------------------------------------------------
// WebSocket multiplex — shell-owned shared transport for real-time events.
//
// Browsers cap HTTP/1.1 to 6 connections per origin. Per-tab, we used to
// hold one SSE for hot-reload + one per module that wanted real-time
// updates (mission-control, eventually others). With 2 tabs open this
// pushed past the budget and stalled page navigations.
//
// WebSocket per-origin limits are an order of magnitude higher (Chrome
// ~255 globally), so one shared WS per tab is effectively unbounded.
// Modules emit events via `ctx.broadcast(event)` and the shell prefixes
// the topic with the module id. Frontends subscribe to the topics they
// care about; the rest is ignored at the client.
//
// Wire protocol: each frame is a JSON object `{ topic, ...event }`.
//   - Topic 'shell' carries shell events (hot reload, etc).
//   - Each module gets a topic equal to its module id.
// ------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });
// wsClients is declared near the top of the file (hoisted) so module
// mounting can safely call ctx.broadcast before this section runs.

function wsBroadcast(topic, event) {
  if (wsClients.size === 0) return;
  const frame = JSON.stringify({ topic, ...event });
  for (const ws of wsClients) {
    if (ws.readyState !== 1 /* OPEN */) continue;
    try { ws.send(frame); } catch { /* drop */ }
  }
}

wss.on('connection', (ws) => {
  wsClients.add(ws);
  const drop = () => wsClients.delete(ws);
  ws.on('close', drop);
  ws.on('error', drop);
});

// ------------------------------------------------------------------------
// Hot reload — fs.watch → WS broadcast (topic: 'shell')
// ------------------------------------------------------------------------

const dirtyIds = new Set();
let reloadTimer = null;

// Per-module reload events let the client choose whether to full-reload
// (active module / shell / unknown) or mark dirty for next navigation.
// 'shell' is the catch-all for top-level files.
function broadcastReload(moduleId) {
  dirtyIds.add(moduleId);
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    for (const id of dirtyIds) wsBroadcast('shell', { type: 'reload', moduleId: id });
    dirtyIds.clear();
  }, 150);
}

// Module `data/` dirs hold runtime state (persisted schedules, run archives,
// incremental crawl output). They change often while the app is running and
// must NOT trigger HMR — otherwise a long-running extract reloads the browser
// every few seconds and wipes session state. Same logic for `node_modules`.
const WATCH_SKIP_SEG = new Set(['data', 'node_modules']);

fs.watch(ROOT, { recursive: true }, (event, filename) => {
  if (!filename) return;
  const segs = filename.split(path.sep);
  if (segs.some((s) => RESERVED_NAMES.has(s) || WATCH_SKIP_SEG.has(s) || isSpecialDir(s))) return;
  if (segs.length > 1) {
    // backend.js hot-swaps server-side via chokidar — never nudge the browser.
    if (segs[segs.length - 1] === 'backend.js') return;
    // Skip dirs that aren't modules at all, and modules without a frontend
    // (the client wouldn't recognize the id and would full-reload as a fallback).
    const mod = getModules().find((m) => m.id === segs[0]);
    if (!mod || !mod.hasFrontend) return;
    broadcastReload(segs[0]);
  } else {
    broadcastReload('shell');
  }
});

// ------------------------------------------------------------------------
// Server
// ------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    await mountPendingBackends();
    await serveIndex(res);
    return;
  }

  // Compiled assets
  const asset = resolveAssetSource(url.pathname);
  if (asset) {
    try {
      const built = asset.kind === 'jsx'
        ? await getJsx(asset.src)
        : await getCss(asset.src, cssScanSources(), HOST_DIR);
      res.writeHead(200, { 'Content-Type': built.contentType });
      res.end(built.content);
    } catch (err) {
      console.error(`  ! build failed for ${url.pathname}:`, err.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('// build error: ' + err.message);
    }
    return;
  }

  // API — make sure any new module backends are mounted before routing
  await mountPendingBackends();
  if (await router.handle(req, res)) return;

  // SPA fallback: a single-segment GET (e.g. /hello, /activity) serves index.
  // The client reads window.location.pathname and picks the matching module.
  if (req.method === 'GET' && /^\/[a-z0-9-]+\/?$/.test(url.pathname)) {
    await serveIndex(res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// HTTP → WebSocket upgrade handler. Only `/_atelier/ws` is accepted;
// any other Upgrade request is dropped. The WebSocketServer is in
// `noServer: true` mode so the HTTP server owns the listening socket
// and forwards relevant upgrades.
server.on('upgrade', (req, socket, head) => {
  let pathname;
  try { pathname = new URL(req.url, `http://localhost:${PORT}`).pathname; }
  catch { socket.destroy(); return; }
  if (pathname !== '/_atelier/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is in use. Try: PORT=1845 npm run dev\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`  http://localhost:${PORT}\n`);
});
