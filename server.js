/* Atelier runner — host mode + standalone mode.
 *
 *   node atelier/server.js                         → host mode, all modules in the rail
 *   node atelier/server.js <id>                    → standalone mode — resolves <id> to
 *                                                    global/<id>
 *   node atelier/server.js <workspace>/<id>        → standalone mode — exact qualifiedId
 *
 * Conventions:
 *   • A sibling directory of atelier/ is a global-workspace module iff it
 *     contains `frontend.jsx` or `backend.js`. A `$<ws>/` directory is a
 *     workspace; its sibling subdirectories are that workspace's modules.
 *   • frontend.jsx is compiled as ESM. It should `export default function
 *     Module` and may `export const meta = { icon, color, name, group }`.
 *   • backend.js exports `default { mountRoutes(router, ctx) }`. The
 *     router is scoped — paths are relative (`/spaces`, not `/api/...`).
 *
 * URL shape: every module has a qualifiedId of `<workspace>/<id>`. Root
 * modules use the synthetic `global` workspace, so `/global/kanban` is
 * the kanban module at the root. URLs:
 *
 *   /<ws>/<id>                      → SPA page
 *   /api/<ws>/<id>/...              → module API (scoped router mount)
 *   /modules/<ws>/<id>/...          → module assets + bundles
 *   /assets/<name>.js|css           → shell assets
 *
 * Hot reload: /_atelier/ws is a shared multiplexed WebSocket. fs.watch
 * (recursive) fires on any change under the project root and the server
 * broadcasts a `{ topic: 'shell', type: 'reload', moduleId }` frame — the
 * client hot-swaps a known module in place (re-imports just its bundle and
 * merges it into the live tree) and full-reloads only for a chrome/shell
 * change or a brand-new module. Module topics
 * are qualified ids; subscribers filter client-side.
 *
 * Discovery is per-request so new folders appear without restart. Backends
 * are mounted lazily on first discovery.
 * (Editing server.js, build.js, or discovery.js still requires a manual restart.)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transform as esbuildTransform, build as esbuildBuild } from 'esbuild';
import { WebSocketServer } from 'ws';
import { getJsx, getJsxBundle, getCss } from './build.js';
import { resolveModuleChrome, missingChrome } from './chrome-resolve.js';
import {
  loadConfig, loadModuleConfig, shouldIncludeModule, collectConfigPaths, resolvePathEntry,
  CONFIG_FILENAME,
  RESERVED_NAMES, GLOBAL_WORKSPACE, isSpecialDir, isWorkspaceDir, workspaceName,
} from './discovery.js';

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
// ROOT is the instance folder where modules are discovered. Resolved three ways,
// in order:
//   1. ATELIER_ROOT, if set — the instance folder itself. Explicit; for managed
//      launchers (launchd/systemd/PaaS/Docker) that don't reliably set PWD.
//   2. else atelier/'s parent, derived from PWD — the shell's *logical* cwd,
//      which preserves the symlink path when atelier/ is shared across instances
//      (process.cwd() would resolve the symlink to the shared shell location).
//   3. else atelier/'s parent, derived from HOST_DIR — last-resort fallback when
//      PWD is unset (then ROOT collapses to the shared shell's own parent, which
//      is only correct for a non-symlinked checkout — hence prefer ATELIER_ROOT).
const ROOT = process.env.ATELIER_ROOT
  ? path.resolve(process.env.ATELIER_ROOT)
  : path.resolve(process.env.PWD || HOST_DIR, '..');

const [, , requestedId] = process.argv;
const MODE = requestedId ? 'standalone' : 'host';

// ---- Instance settings — system defaults ← atelier.config.json ← env vars ----
// atelier has no built-in dev/prod concept: one folder = one instance, and the
// config file is that instance's source of truth. Env vars override the file at
// startup (so a PaaS can inject a dynamic PORT), and sensible defaults mean a
// bare folder just runs. Settings are resolved once at boot; the module LIST is
// re-read per request (see getModules) so adding/removing modules stays hot.
const bootConfig = loadConfig(ROOT);
const envOr = (envKey, configKey, fallback) => {
  const e = process.env[envKey];
  if (e != null && e !== '') return e;                  // env wins (string)
  if (bootConfig[configKey] != null) return bootConfig[configKey];
  return fallback;
};
const toBool = (v) => v === true || v === 'true' || v === '1' || v === 'on';

const PORT = Number(envOr('PORT', 'port', 1844));
const BASE_URL = String(envOr('BASE_URL', 'baseUrl', `http://localhost:${PORT}`));
// Frontend build mode. Universal concept → the bare `NODE_ENV` env var (like
// `PORT`/`BASE_URL`), `env` in the config. 'development' (default, matching the
// convention that unset NODE_ENV means dev) ships React + bundled-library dev
// warnings, unminified; 'production' optimizes. Independent of `hotReload`.
const NODE_ENV = String(envOr('NODE_ENV', 'env', 'development'));
const PROD_BUILD = NODE_ENV === 'production';
const HOT_RELOAD = toBool(envOr('ATELIER_HOT_RELOAD', 'hotReload', true));
const LABEL = envOr('ATELIER_LABEL', 'label', null);      // optional instance name
const DEFAULT_CHROME = envOr('ATELIER_DEFAULT_CHROME', 'defaultChrome', null);   // default chrome module path/id, or null
const AUTH = (() => {                                     // auth module path/name, or false (ungated)
  const v = envOr('ATELIER_AUTH', 'auth', false);
  return (v === false || v == null || v === 'false' || v === 'off' || v === '') ? false : v;
})();
const REVALIDATE_MS = Number(envOr('ATELIER_REVALIDATE_MS', 'revalidateMs', 30000)); // WS session re-check interval

// Publish the resolved port/baseUrl so modules (and processes they spawn) read
// the same values. atelier reads NODE_ENV only as the frontend build-mode `env`
// setting (above); it does NOT re-assign process.env.NODE_ENV for spawned child
// processes — a library that wants one reads its own.
process.env.PORT = String(PORT);
process.env.BASE_URL = BASE_URL;

// Footgun guard: an ungated instance reachable somewhere other than localhost
// is wide open. Auth is opt-in (config `auth`); this is just a startup nudge.
if (!AUTH && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE_URL)) {
  console.warn(`  ! auth is off and baseUrl is ${BASE_URL} — this instance is ungated. Set "auth" in ${CONFIG_FILENAME} to gate it.`);
}

// Hoisted up here (out of the WS section below) because module mounting
// happens at `await mountPendingBackends()` further down, and a module's
// mountRoutes can spawn child processes whose stdout/stderr stream events
// fire async handlers that call ctx.broadcast → wsBroadcastFromModule → wsClients.
// If wsClients is still in TDZ when one of those handlers fires (a module
// whose mountRoutes spawns a child during mount), the throw is uncaught and
// crashes the server. Declaring it before mounting puts
// wsClients in scope for every closure that needs it.
const wsClients = new Set();

// authPlugs follows the same hoisting reason. mountPlug populates it on
// every successful mountRoutes call, and that runs during the initial
// `await mountPendingBackends()` below — well before the auth section
// where this Map would otherwise be declared. Without hoisting, every
// mount throws a TDZ ReferenceError.
const authPlugs = new Map();           // qualifiedId → plug

// ------------------------------------------------------------------------
// Router — tiny path+method matcher with req.json / res.json helpers
// ------------------------------------------------------------------------

// Routes are namespaced by URL: a module mounts at `/api/<ws>/<id>` and
// its handlers receive relative paths (`/spaces`, not `/api/kanban/spaces`).
// `makeModuleScope` prefixes paths with `/api/<ws>/<id>` before they hit
// `_add`, so the router itself stays untyped — first match wins.
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
      req.query = Object.fromEntries(url.searchParams.entries());
      req.json = () => bodyOf(req);
      res.json = (data, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      try {
        await r.handler(req, res);
      } catch (err) {
        const status = err.statusCode || 500;
        if (!res.writableEnded) {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        if (status >= 500) console.error(err);   // 4xx are client errors, not shell faults — don't spam the log
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

// Cap request bodies so an exposed instance can't be memory-DoS'd by an
// oversized POST. 10 MB is generous for module APIs; over that, the handler's
// `await req.json()` rejects with a 413 (the error carries statusCode, which
// the router honors). Bodies are only buffered when a handler reads them via
// req.json() — handlers that ignore the body never accumulate it.
const MAX_JSON_BODY = 10 * 1024 * 1024;
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;                      // past the cap — discard, don't grow memory
      size += chunk.length;
      if (size > MAX_JSON_BODY) {
        over = true;
        const err = new Error(`request body exceeds ${MAX_JSON_BODY} bytes`);
        err.statusCode = 413;
        reject(err);
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (over) return;
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Memoize the parsed body on the request. A request stream can only be
// consumed once, but two trusted readers may want it: the auth module's
// `authorize` hook (payload-level checks) and the module's own handler. Both
// go through `bodyOf`, so the stream is read once and they share the result.
function bodyOf(req) {
  return (req.__bodyPromise ??= readJsonBody(req));
}

// ------------------------------------------------------------------------
// Workspaces
//
// Every module has a workspace. Root-folder modules belong to the synthetic
// `global` workspace; modules inside `$<name>/` belong to that workspace.
// Workspace + id together (the qualifiedId, `<ws>/<id>`) is the module's
// stable identity — used for URLs, routes, WS topics, slot keys, watchers.
//
// Workspace lives in the URL path: `/global/kanban`, `/bigcorp/kanban`.
// No cookie, no header precedence chain — the URL is the only source of
// truth. Modules that need their own workspace at runtime derive it
// per-bundle from `import.meta.url` (see the ROUTE/API/TOPIC snippet
// every module's frontend.jsx starts with) — no separate shell global.
// ------------------------------------------------------------------------

// Workspaces present on disk plus the synthetic `global` (always available
// because root modules constitute it). An empty `$<name>/` directory is
// still a workspace; a name filtered out of `atelier.config.json` can't
// make its workspace disappear.
function listAllWorkspaces() {
  const set = new Set([GLOBAL_WORKSPACE]);
  let names;
  try { names = fs.readdirSync(ROOT); } catch { return [...set]; }
  for (const name of names) {
    if (!isWorkspaceDir(name)) continue;
    const ws = workspaceName(name);
    if (!ws || RESERVED_NAMES.has(ws)) continue;
    set.add(ws);
  }
  return [...set].sort();
}

// ------------------------------------------------------------------------
// Module discovery — lazy, re-runs on each call
// ------------------------------------------------------------------------

// Discovery rules (RESERVED_NAMES, isSpecialDir, isWorkspaceDir) are imported
// from discovery.js so there's a single definition of what counts as a
// module and what counts as a workspace.
//
// A module is a directory with frontend.jsx or backend.js. Modules live:
//   • at the root         → workspace = 'global' (synthetic),
//                            qualifiedId = 'global/<id>'
//   • inside $<ws>/<id>   → workspace = '<ws>',
//                            qualifiedId = '<ws>/<id>'
//
// Every module has a workspace. There is no "null" — `global` is always
// the workspace for root-folder modules. URLs are `/<ws>/<id>` (page),
// `/api/<ws>/<id>/…` (api), `/modules/<ws>/<id>/…` (assets, bundles).
//
// Each entry carries:
//   id          dirname (what modules use as ctx.id)
//   workspace   workspace name — 'global' for root, '<ws>' for $<ws>/<id>
//   qualifiedId '<workspace>/<id>' — the key used internally for mounts,
//               watchers, slots, WS topics

function readModuleAt(dir, name, workspace) {
  if (isSpecialDir(name)) return null;
  if (RESERVED_NAMES.has(name)) return null;
  let stat;
  try { stat = fs.statSync(dir); } catch { return null; }
  if (!stat.isDirectory()) return null;
  const hasFrontend = fs.existsSync(path.join(dir, 'frontend.jsx'));
  const hasBackend  = fs.existsSync(path.join(dir, 'backend.js'));
  if (!hasFrontend && !hasBackend) return null;
  return {
    id: name,
    dir,
    hasFrontend,
    hasBackend,
    workspace,
    qualifiedId: `${workspace}/${name}`,
  };
}

const warnedReservedWs = new Set();   // dedupe `$<reserved>/` warnings

// The shell ships NO chrome of its own — zero visual assumptions. A chrome is
// any global-workspace module exporting `meta = { isChrome: true }`; it's
// discovered and mounted like any other module (the user's config typically
// path-mounts one). One is the default (`resolveDefaultChromeQid`); a module
// may pin another via `meta.chrome`. With none installed the client renders an
// "add a chrome" screen.

function discoverModules() {
  const out = [];
  let names;
  try { names = fs.readdirSync(ROOT); } catch { return out; }
  for (const name of names) {
    // `$<reserved>/` (e.g. `$global/`, `$api/`) is rejected by isWorkspaceDir.
    // We detect that case here and warn once so an operator doesn't wonder
    // why their `$global/` folder isn't discovering.
    if (name.startsWith('$') && !isWorkspaceDir(name) && /^\$[a-zA-Z0-9]/.test(name)) {
      if (!warnedReservedWs.has(name)) {
        warnedReservedWs.add(name);
        console.warn(`  ! ${name}/ is not a valid workspace dir (reserved name or invalid characters) — skipping`);
      }
      continue;
    }
    // Workspaces: $<ws>/ recurses one level for modules.
    if (isWorkspaceDir(name)) {
      const ws = workspaceName(name);
      if (!ws || RESERVED_NAMES.has(ws)) continue;     // defensive; isWorkspaceDir already filters
      const wsDir = path.join(ROOT, name);
      let subnames;
      try { subnames = fs.readdirSync(wsDir); } catch { continue; }
      for (const sub of subnames) {
        const m = readModuleAt(path.join(wsDir, sub), sub, ws);
        if (m) out.push(m);
      }
      continue;
    }
    // Root module → synthetic 'global' workspace.
    const m = readModuleAt(path.join(ROOT, name), name, GLOBAL_WORKSPACE);
    if (m) out.push(m);
  }
  // Sort by qualifiedId so auth-slot election + rail order are stable
  // across filesystems with different readdir semantics.
  out.sort((a, b) => a.qualifiedId.localeCompare(b.qualifiedId));
  return out;
}

// Read a module from an explicit path entry in atelier.config.json.
// `entry` is `{ path, id?, workspace }` — workspace comes from where the
// path appeared in the config (top-level → 'global', inside a workspace
// block → that workspace's name). `id` overrides the basename if set.
function readModuleFromPath(entry) {
  const abs = resolvePathEntry(entry.path, ROOT);
  if (!abs) return null;
  const id = entry.id || path.basename(abs);
  return readModuleAt(abs, id, entry.workspace);
}

// Per-id dedupe so a typo in atelier.config.json doesn't spam the log on
// every request (getModules is called multiple times per request).
const warnedConfigMisses = new Set();

function getModules() {
  const discovered = discoverModules();
  if (MODE === 'standalone') {
    // Standalone mode is an explicit user choice — bypass the config filter
    // so a module excluded for this env can still be inspected. Match by
    // qualifiedId first ('bigcorp/kanban' or 'global/kanban'); fall back to
    // bare id, which resolves to the global workspace's mount so users can
    // type `node server.js kanban` without thinking about workspaces.
    // (No chrome is bundled in — a single-module standalone view shows the
    // "add a chrome" screen unless the requested module is itself a chrome.)
    const only = discovered.find((m) => m.qualifiedId === requestedId)
              || discovered.find((m) => m.id === requestedId && m.workspace === GLOBAL_WORKSPACE);
    return only ? [only] : [];
  }
  const parsed = loadModuleConfig(ROOT);

  // Apply the parsed filter to discovered modules.
  const filtered = discovered.filter((m) =>
    shouldIncludeModule(parsed, m, { globalWorkspace: GLOBAL_WORKSPACE })
  );

  // Add external paths from the config. Each carries its target workspace
  // (top-level → 'global', inside a workspace block → that workspace).
  // Path mounts bypass the filter — they're explicit user inclusions.
  // Dedupe by qualifiedId so a path that happens to point inside ROOT
  // doesn't double-mount with the discovered copy.
  const fromPaths = [];
  const seen = new Set(filtered.map((m) => m.qualifiedId));
  for (const entry of collectConfigPaths(parsed, { globalWorkspace: GLOBAL_WORKSPACE })) {
    const m = readModuleFromPath(entry);
    if (!m) {
      const key = `${entry.workspace}/${entry.path}`;
      if (warnedConfigMisses.has(key)) continue;
      warnedConfigMisses.add(key);
      console.warn(`  ! ${CONFIG_FILENAME}: path '${entry.path}' is not a module dir (no frontend.jsx or backend.js)`);
      continue;
    }
    if (seen.has(m.qualifiedId)) continue;
    seen.add(m.qualifiedId);
    fromPaths.push(m);
  }
  return [...filtered, ...fromPaths];
}

// ------------------------------------------------------------------------
// Module meta extraction — read each module's `export const meta = {...}`
// at discovery so the bootstrap can seed the rail with icons/names/groups
// without waiting for the dynamic import on the client. Eliminates the
// first-paint flicker where grouped modules briefly render ungrouped.
//
// How it works: transform the JSX with esbuild, wrap in a data: URL, and
// dynamic-import it in Node. `meta` is a plain top-level object literal —
// no React or browser globals needed at module load — so Proxy stubs for
// `React`, `ReactDOM`, and `window` are enough to let common top-level
// destructures (`const { useState } = React;`, `const { createPortal } =
// ReactDOM;`) and store-init blocks (`if (!window.__store) …`) not throw.
// `document` is intentionally NOT stubbed — modules that touch it at top
// scope must still guard with `typeof document !== 'undefined'` so live
// DOM side-effects don't fire during SSR. Cached by file mtime so
// repeated requests pay the cost once per edit.
// ------------------------------------------------------------------------

const metaCache = new Map();   // moduleId → { meta, mtimeMs }
let reactStubbed = false;

function stubReactOnce() {
  if (reactStubbed) return;
  // React.Component / React.PureComponent must be extendable so modules
  // (or the chrome) declaring `class Foo extends React.Component` at module
  // top level don't blow up during meta extraction. Everything else is a
  // no-op function (covers hooks, createElement, etc.).
  class StubComponent { render() { return null; } }
  const stub = new Proxy({}, {
    get(_, prop) {
      if (prop === 'Component' || prop === 'PureComponent') return StubComponent;
      return () => null;
    },
  });
  globalThis.React = stub;
  globalThis.ReactDOM = stub;
  globalThis.window = stub;
  reactStubbed = true;
}

// Static meta extraction — the PRIMARY path. `meta` is a top-level object
// literal by convention, so a brace-balanced scan + Function-eval reads it
// straight from source, WITHOUT running the module (so a frontend's top-level
// code never executes in Node, and chromes — whose bare-specifier imports
// can't resolve from a data URL — work too). Handles inline (`meta = {...}`
// on one line) and multi-line. Returns {} if `meta` isn't a resolvable
// literal (computed/spread/imported) → caller falls back to executing it.
function extractMetaStatically(src) {
  const re = /export\s+const\s+meta\s*=\s*\{/.exec(src);
  if (!re) return {};
  const start = src.indexOf('{', re.index);
  if (start < 0) return {};
  let depth = 0;
  let str = null;          // current string delimiter (', ", or `)
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (str) {
      if (c === '\\') { i++; continue; }
      if (c === str) str = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return new Function('return (' + src.slice(start, i + 1) + ')')() || {}; }
        catch { return {}; }
      }
    }
  }
  return {};
}

async function readMeta(src) {
  const code = fs.readFileSync(src, 'utf8');
  // Static-first: read the literal `meta` from source without running the
  // module. This is the path for ~every module (their `meta` is a literal),
  // so a frontend's top-level code does NOT execute in Node at discovery.
  const stat = extractMetaStatically(code);
  if (Object.keys(stat).length) return stat;
  // Fallback — `meta` is computed/spread/imported and couldn't be parsed
  // statically: transform + import the module to evaluate it. Top-level code
  // runs here, so keep frontend top-level side-effect-free (browser globals
  // like `document` are undefined in Node — see MODULES.md).
  stubReactOnce();
  try {
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
  } catch {
    return {};
  }
}

async function getModuleMeta(m) {
  if (!m.hasFrontend) return {};
  const src = path.join(m.dir, 'frontend.jsx');
  let mtimeMs;
  try { mtimeMs = fs.statSync(src).mtimeMs; } catch { return {}; }
  const cached = metaCache.get(m.qualifiedId);
  if (cached && cached.mtimeMs === mtimeMs) return cached.meta;
  try {
    const meta = await readMeta(src);
    metaCache.set(m.qualifiedId, { meta, mtimeMs });
    return meta;
  } catch (err) {
    console.warn(`  ! meta read failed for ${m.qualifiedId}: ${err.message}`);
    metaCache.set(m.qualifiedId, { meta: {}, mtimeMs });
    return {};
  }
}

// Validate standalone target exists at boot (fail fast if typo).
if (MODE === 'standalone') {
  const all = discoverModules();
  const ok = all.find((m) => m.qualifiedId === requestedId)
          || all.find((m) => m.id === requestedId && m.workspace === GLOBAL_WORKSPACE);
  if (!ok) {
    console.error(`\n  Module '${requestedId}' not found.`);
    if (all.length) console.error(`  Available: ${all.map((m) => m.qualifiedId).join(', ')}\n`);
    else console.error(`  No modules discovered in ${ROOT}.\n`);
    process.exit(1);
  }
}

console.log(`\n  Atelier · ${MODE}  ·  ${ROOT}  ·  env=${NODE_ENV}`);
for (const m of getModules()) {
  console.log(`    • ${m.qualifiedId}${m.hasBackend ? '' : ' (frontend-only)'}`);
}
if (getModules().length === 0) console.log(`    (no modules yet)`);

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
// Hot-swap only runs when hot reload is enabled (see HOT_RELOAD).
// ------------------------------------------------------------------------

const router = createRouter();
const mountedBackends = new Map();   // id → { scope, teardown }
const attemptedBackends = new Set(); // id → tried once via mountPendingBackends
const backendWatchers = new Map();   // id → fs.FSWatcher
const pendingReloads = new Map();    // id → debounce timer
const lastReloadMtime = new Map();   // id → mtimeMs actually processed

// Cross-module slot registry. Each `(workspace, id)` pair maps to a plain
// object that any module within the same workspace can read or write to.
// Lives on globalThis so hot-reloads of individual modules don't reset
// the shared state. The shell itself isn't hot-reloaded — editing
// server.js requires a manual restart — so this Map is created once per
// `npm run dev` lifetime and survives every backend.js edit.
//
// The contract is plain data: there are NO methods, NO subscribe/notify,
// NO validation. Owning modules read their slot lazily (at use time, not
// at mount time) so the order in which modules mount is irrelevant — the
// fact that `discoverModules` happens to return them alphabetically would
// otherwise create real races (e.g. one module mounting before another it
// shares a slot with).
//
// Workspace boundary: a `global` module and a `$alpha` module can't leak
// state through a shared slot. A workspace-aware infrastructure module
// that genuinely wants to look across workspaces uses persisted records
// (with a workspace column) instead of the slot primitive.
const moduleSlots = (globalThis.__atelierModuleSlots ??= new Map());
function slotKey(callerWorkspace, id) {
  return `${callerWorkspace}/${id}`;
}
function getModuleSlot(callerWorkspace, id) {
  const key = slotKey(callerWorkspace, id);
  if (!moduleSlots.has(key)) moduleSlots.set(key, {});
  return moduleSlots.get(key);
}

function makeCtx(m) {
  return {
    id: m.id,                      // dirname
    name: m.id,
    workspace: m.workspace,        // 'global' for root, '<ws>' for $<ws>/<mod>
    qualifiedId: m.qualifiedId,    // '<workspace>/<id>'
    label: LABEL,
    port: PORT,
    baseUrl: BASE_URL,
    dataDir: path.join(m.dir, 'data'),
    log: (...args) => console.log(`[${m.qualifiedId}]`, ...args),
    // Broadcast a real-time event to every browser tab subscribed to this
    // module's topic. Topic = qualifiedId ('global/kanban' or
    // 'bigcorp/kanban'). Module bundles derive this from `import.meta.url`
    // and subscribe to their own qid. Same-named modules in different
    // workspaces can't cross-broadcast.
    broadcast: (event) => wsBroadcastFromModule(m.qualifiedId, event || {}),
    // In-process slot lookup. Returns the SAME plain object for any caller
    // within the SAME workspace — global modules share global slots,
    // $alpha modules share $alpha slots, and they can't cross.
    module: (id) => getModuleSlot(m.workspace, id),
  };
}

function makeModuleScope(m) {
  const mine = [];
  // Routes are namespaced by URL. The scope prefixes every path with
  // `/api/<workspace>/<id>` before adding to the router, so a module
  // writes `router.get('/spaces', …)` and it answers at
  // `/api/global/kanban/spaces` (or `/api/bigcorp/kanban/spaces`).
  //
  // Empty path ('' or '/') maps to the bare module root — register that
  // for a "module index" endpoint at exactly /api/<ws>/<id>.
  const prefix = `/api/${m.workspace}/${m.id}`;
  const join = (p) => {
    if (!p || p === '/') return prefix;
    return prefix + (p.startsWith('/') ? p : '/' + p);
  };
  return {
    get:    (p, h) => { mine.push(router._add('GET',    join(p), h)); },
    post:   (p, h) => { mine.push(router._add('POST',   join(p), h)); },
    put:    (p, h) => { mine.push(router._add('PUT',    join(p), h)); },
    delete: (p, h) => { mine.push(router._add('DELETE', join(p), h)); },
    patch:  (p, h) => { mine.push(router._add('PATCH',  join(p), h)); },
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
  // at module scope keep working without any migration.
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
  const scope = makeModuleScope(m);
  try {
    const teardown = plug.mountRoutes(scope, makeCtx(m));
    mountedBackends.set(m.qualifiedId, { scope, teardown: typeof teardown === 'function' ? teardown : null, m });
    // Track the plug for non-route surfaces (auth slot's authenticate/
    // handleUnauth, future plug-level hooks). Cleared in unmount.
    authPlugs.set(m.qualifiedId, plug);
    return true;
  } catch (err) {
    console.error(`  ! ${m.qualifiedId}.mountRoutes threw: ${err.message}`);
    scope._dispose();
    return false;
  }
}

// Backends that failed to (re)load, keyed by qualifiedId. The failure is
// ISOLATED: only the broken module's own `/api` lane returns 500, and only its
// frontend gets the overlay — every other module, the chrome, and the shell
// keep running normally. Cleared on a clean (re)load. Streamed to open clients
// over the 'shell' WS topic, and seeded into the bootstrap for fresh loads.
const backendErrors = new Map();   // qid → { message }

// Turn a raw load error into an actionable one. The classic trap: a backend is
// hot-loaded from a `data:` URL, so a static `import x from 'pkg'` can't resolve
// a node_modules dependency — name the fix (`createRequire`) right in the message.
function enrichBackendError(err) {
  let msg = err?.message || String(err);
  // The data: URL a backend is loaded from is a huge base64 blob — collapse it
  // so the actionable part of the message isn't buried.
  msg = msg.replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, 'the backend bundle');
  const spec = /resolve module specifier ["']([^"']+)["']/.exec(msg);
  if (spec) {
    const pkg = spec[1];
    msg += `\n\nA backend is hot-loaded from a data: URL, so a static \`import … from '${pkg}'\` can't resolve a node_modules dependency. Load it at runtime instead:\n  import { createRequire } from 'node:module';\n  const require = createRequire(import.meta.url);\n  const dep = require('${pkg}');`;
  }
  return msg;
}
function setBackendError(qid, message) {
  if (backendErrors.get(qid)?.message === message) return false;  // debounce identical repeats (e.g. a rogue timer)
  backendErrors.set(qid, { message });
  wsBroadcastBackendError(qid, message);
  return true;
}
function clearBackendError(qid) {
  if (backendErrors.delete(qid)) wsBroadcastBackendError(qid, null);
}

async function mountBackend(m) {
  watchBackend(m);  // always watch so a broken file can be fixed-and-reloaded
  let plug;
  try { plug = await importBackend(m); }
  catch (err) {
    const message = enrichBackendError(err);
    console.error(`  ! ${m.qualifiedId}: backend failed to load — ${message}`);
    setBackendError(m.qualifiedId, message);
    return;
  }
  clearBackendError(m.qualifiedId);
  if (mountPlug(m, plug)) console.log(`  + mounted ${m.qualifiedId} backend`);
}

async function reloadBackend(m) {
  let plug;
  try { plug = await importBackend(m); }
  catch (err) {
    const message = enrichBackendError(err);
    console.error(`  ! ${m.qualifiedId}: reload failed, keeping current version — ${message}`);
    setBackendError(m.qualifiedId, message);
    return;
  }
  clearBackendError(m.qualifiedId);
  const prev = mountedBackends.get(m.qualifiedId);
  if (prev) {
    try { prev.teardown?.(); } catch (err) { console.warn(`  ! ${m.qualifiedId}.teardown: ${err.message}`); }
    prev.scope._dispose();
  }
  if (mountPlug(m, plug)) console.log(`  ↻ reloaded ${m.qualifiedId} backend`);
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
  authPlugs.delete(id);
  const w = backendWatchers.get(id);
  if (w) {
    try { await w.close(); } catch {}
    backendWatchers.delete(id);
  }
  attemptedBackends.delete(id);
  lastReloadMtime.delete(id);
  metaCache.delete(id);
  clearBackendError(id);
  const pending = pendingReloads.get(id);
  if (pending) { clearTimeout(pending); pendingReloads.delete(id); }
  console.log(`  - unmounted ${id} backend (${reason})`);
  // Tell open clients to refresh — the rail/SPA was seeded with the old
  // module list at boot. 'shell' is the conventional id that triggers a
  // full window.location.reload() in the client (atelier/client.jsx).
  broadcastReload('shell');
}

function watchBackend(m) {
  if (!HOT_RELOAD) return;            // hot reload off → no backend hot-swap
  if (backendWatchers.has(m.qualifiedId)) return;
  // Native recursive fs.watch on the module DIR (not the file): dir-level
  // watching survives atomic saves (rename-over swaps the file's inode, but the
  // directory handle persists and sees the new file). Same paths that used to
  // be ignored are filtered here; the 150ms debounce + mtime-dedupe in
  // scheduleReload stand in for the old awaitWriteFinish — a half-written read
  // just fails the esbuild rebuild, and the next event reloads cleanly.
  // (Verified across atomic-save, rapid, transitive, and teardown reloads.)
  const ignored = (segs) => segs.some((s) =>
    s === 'node_modules' || s === 'data' || s.startsWith('.') || s.startsWith('_'));
  try {
    const w = fs.watch(m.dir, { recursive: true }, (event, filename) => {
      if (!filename) return;
      const segs = filename.split(path.sep);
      if (ignored(segs)) return;
      // Module dir / backend.js gone → teardown so routes, timers, and file
      // handles don't outlive the source. Existence-checked so a transient
      // event during an atomic save can't false-fire.
      if (!fs.existsSync(m.dir) || !fs.existsSync(path.join(m.dir, 'backend.js'))) {
        unmountBackend(m.qualifiedId, 'source removed').catch((err) =>
          console.warn(`  ! unmount ${m.qualifiedId}: ${err.message}`));
        return;
      }
      if (filename.endsWith('.js')) scheduleReload(m);
    });
    backendWatchers.set(m.qualifiedId, w);
  } catch (err) {
    console.warn(`  ! could not watch ${m.qualifiedId}/: ${err.message}`);
  }
}

function scheduleReload(m) {
  clearTimeout(pendingReloads.get(m.qualifiedId));
  pendingReloads.set(m.qualifiedId, setTimeout(() => {
    pendingReloads.delete(m.qualifiedId);
    // Dedupe by mtime. macOS `fs.watch` on a single file can deliver two
    // events per save, spaced ~150–200ms apart — outside the debounce
    // window, so they become two distinct reloads. Reading the mtime here
    // and comparing to the last one we processed is cheap and robust: real
    // saves always bump mtime, duplicate events don't.
    // Dedupe on the NEWEST .js mtime in the module dir, not just backend.js, so
    // a transitive import edit (lib.js) still reloads while same-save double
    // events (identical max mtime) are dropped.
    let mtime = 0;
    const scan = (dir) => {
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of ents) {
        if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name === 'data') continue;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) scan(p);
        else if (ent.name.endsWith('.js')) { try { mtime = Math.max(mtime, fs.statSync(p).mtimeMs); } catch {} }
      }
    };
    scan(m.dir);
    if (mtime && mtime === lastReloadMtime.get(m.qualifiedId)) return;
    lastReloadMtime.set(m.qualifiedId, mtime);
    reloadBackend(m).catch((err) => console.error(`  ! reload ${m.qualifiedId}: ${err.message}`));
  }, 150));
}

async function mountPendingBackends() {
  const live = getModules();
  const liveIds = new Set(live.map((m) => m.qualifiedId));
  // Reconcile: unmount anything that disappeared from disk since last call.
  // Belt-and-braces with the fs.watch watcher in watchBackend — the watcher
  // catches in-session deletions instantly; this cleans up edge cases (e.g.
  // a module folder removed between server boot and first request, or
  // the watcher missing an event on some filesystems).
  for (const id of [...mountedBackends.keys()]) {
    if (!liveIds.has(id)) await unmountBackend(id, 'not in discovery');
  }
  for (const m of live) {
    if (!m.hasBackend) continue;
    if (attemptedBackends.has(m.qualifiedId)) continue;
    attemptedBackends.add(m.qualifiedId);
    await mountBackend(m);
  }
}

await mountPendingBackends();

// ------------------------------------------------------------------------
// Shutdown — fire every mounted module's teardown on graceful exit.
//
// Without this, Ctrl+C / SIGTERM kills the shell but leaves any child
// processes a module spawned orphaned (reparented to the init process).
// Anything a module spawns — a supervised worker, a sidecar daemon, a
// watcher's child — has this shape and needs a teardown to clean it up.
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

// `prependListener`, not `on`: a module's backend.js may register its own
// `process.on('SIGINT', ...)` during mount. Node fires handlers in
// registration order, and a module handler that calls process.exit()
// immediately would preempt ours. Prepending puts the shell's global
// teardown ahead of any module's per-process signal handler.
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
// Uncaught error handling — isolate module faults, crash on shell faults
//
// A module's backend is untrusted code sharing this process. When it throws
// OUTSIDE a request — a rogue setInterval, an event handler, an unhandled
// rejection in a background task — the error reaches the process, not a
// response. We attribute it (locateModuleFromStack handles disk frames AND the
// data:-URL backend bundles via their inline source map):
//   • a MODULE fault → surface it via that module's backend-error overlay/500
//     and KEEP THE SHELL ALIVE, so every other module + connected user survives.
//     (Surfaced louder than the old crash banner, which only reached the
//     launchd log — see setBackendError / the overlay.)
//   • an un-attributable fault → a SHELL bug (our code): print a highly-visible
//     banner naming what we can, then exit(1), so it can't hide and grow.
//
// Limits — in-process isolation is not a sandbox: a synchronous infinite loop,
// `process.exit()`, or OOM in a module still take the shell down (those need
// true process isolation, which the shared-runtime design intentionally trades
// away). And after an uncaughtException Node considers the process state
// undefined — for a shared multi-tenant runtime, staying up + surfacing loudly
// beats killing everyone for one module's bug.
// ------------------------------------------------------------------------

function locateModuleFromStack(stack) {
  if (!stack) return null;

  // 1) Direct project file frames. Lazy so the path stops at the first
  // `:digit` rather than gobbling further. Allows spaces inside the path
  // (a project may live under a directory whose name contains spaces).
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

// Resolve the qualifiedId of the module a fault came from, by matching the
// located file against discovered module dirs (then by a path segment that is a
// module id, then by global id). Best-effort — used to surface a module's
// uncaught error via its own backend-error overlay/500. Null when it can't be
// pinned to a specific module.
function moduleQidFromStack(stack, loc = locateModuleFromStack(stack)) {
  if (!loc) return null;
  const mods = getModules();
  const abs = path.resolve(ROOT, loc.file);
  const byDir = mods.find((m) => abs === m.dir || abs.startsWith(m.dir + path.sep));
  if (byDir) return byDir.qualifiedId;
  const segs = loc.file.split('/');
  const bySeg = mods.find((m) => segs.includes(m.id));
  if (bySeg) return bySeg.qualifiedId;
  const byId = mods.find((m) => m.id === loc.moduleId && m.workspace === GLOBAL_WORKSPACE);
  return byId ? byId.qualifiedId : null;
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

function handleUncaught(kind, err) {
  const stack = err && err.stack ? err.stack : String(err);
  const loc = locateModuleFromStack(stack);
  if (loc) {
    // A module's own code threw outside a request → isolate it: keep the shell +
    // every other module alive, and surface it where the author looks (the
    // overlay + the module's /api 500), not buried in the log.
    const qid = moduleQidFromStack(stack, loc);
    const message = `Uncaught ${kind} in this module's backend, outside a request handler:\n${stack}`;
    if (qid) {
      if (setBackendError(qid, message)) console.error(`  ! ${qid}: ${kind} — isolated, shell kept alive`);
    } else {
      console.error(`  ! ${loc.moduleId}: ${kind} — isolated, shell kept alive (couldn't map it to a module for the overlay)`);
    }
    return;  // ← do NOT exit; the shared runtime survives
  }
  // No project frame → a shell/runtime bug: nothing to isolate it to. Crash
  // loudly with the banner + exit, as before — hiding a SHELL bug grows it.
  printCrashBanner(kind, err);
  process.exitCode = 1;
  process.exit(1);
}

process.on('uncaughtException', (err) => handleUncaught('uncaughtException', err));
process.on('unhandledRejection', (reason) =>
  handleUncaught('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason))));

// ------------------------------------------------------------------------
// URL → source path mapping
// ------------------------------------------------------------------------

// Map a content type for a non-JSX/CSS module asset. Conservative list —
// anything else is served as octet-stream.
const RAW_CONTENT_TYPES = {
  '.js':    'application/javascript; charset=utf-8',
  '.mjs':   'application/javascript; charset=utf-8',
  '.json':  'application/json; charset=utf-8',
  '.html':  'text/html; charset=utf-8',
  '.htm':   'text/html; charset=utf-8',
  '.svg':   'image/svg+xml',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.gif':   'image/gif',
  '.webp':  'image/webp',
  '.avif':  'image/avif',
  '.ico':   'image/x-icon',
  '.mp4':   'video/mp4',
  '.m4v':   'video/mp4',
  '.webm':  'video/webm',
  '.mov':   'video/quicktime',
  '.mp3':   'audio/mpeg',
  '.m4a':   'audio/mp4',
  '.wav':   'audio/wav',
  '.ogg':   'audio/ogg',
  '.txt':   'text/plain; charset=utf-8',
  '.md':    'text/markdown; charset=utf-8',
  '.wasm':  'application/wasm',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
};

function resolveAssetSource(pathname) {
  // Vendored third-party runtime (React/ReactDOM UMD) — served from
  // node_modules so a checkout boots offline with the version pinned in
  // package.json, not fetched from a CDN at runtime. index.html loads these
  // as the ambient `window.React` / `window.ReactDOM` the shims alias to.
  // Dev vs prod by the `env` setting: 'development' ships the unminified build
  // with React's warnings (invalid hooks, missing keys, readable errors);
  // 'production' ships the minified build.
  const VENDOR = {
    '/assets/react.js':     PROD_BUILD ? 'react/umd/react.production.min.js'     : 'react/umd/react.development.js',
    '/assets/react-dom.js': PROD_BUILD ? 'react-dom/umd/react-dom.production.min.js' : 'react-dom/umd/react-dom.development.js',
  };
  if (VENDOR[pathname]) {
    const src = path.join(HOST_DIR, 'node_modules', VENDOR[pathname]);
    return fs.existsSync(src)
      ? { kind: 'raw', src, contentType: 'text/javascript; charset=utf-8' }
      : null;
  }
  // /assets/<name>.js  → atelier/<name>.jsx (preferred), else atelier/<name>.js.
  // The `.js` fallback lets the shell ship plain shared ES modules (e.g.
  // chrome-resolve.js) that both the server and the browser client import.
  let m = /^\/assets\/([a-z0-9-]+)\.js$/.exec(pathname);
  if (m) {
    const jsx = path.join(HOST_DIR, m[1] + '.jsx');
    if (fs.existsSync(jsx)) return { kind: 'jsx', src: jsx };
    const js = path.join(HOST_DIR, m[1] + '.js');
    if (fs.existsSync(js)) return { kind: 'jsx', src: js };
    return null;
  }
  // /assets/<name>.css → atelier/<name>.css
  m = /^\/assets\/([a-z0-9-]+)\.css$/.exec(pathname);
  if (m) {
    const src = path.join(HOST_DIR, m[1] + '.css');
    return fs.existsSync(src) ? { kind: 'css', src } : null;
  }
  // /modules/<ws>/<id>/<...rest> — workspace-qualified, dir-keyed asset
  // routing. The URL fully identifies the mount; no shadow logic, no
  // fallthrough, no per-request ambient context.
  //
  // Multi-file modules can `import './helper.js'`; helpers, images,
  // JSON, etc. all live alongside frontend.jsx and ship together.
  //
  // For .js requests, .jsx source wins (JSX builder) if it exists — so
  // `frontend.js` and `import './foo.js'` both resolve to their `.jsx`
  // when one is there, otherwise to the literal `.js` file.
  m = /^\/modules\/([^/]+)\/([^/]+)\/(.+)$/.exec(pathname);
  if (m) {
    const ws = m[1];
    const id = m[2];
    const rest = m[3];
    // Path traversal guard. URL decoding happens; resolve and verify the
    // file is inside the module's dir.
    let relPath;
    try { relPath = decodeURIComponent(rest); } catch { return null; }
    if (relPath.includes('\0')) return null;
    if (relPath.startsWith('/')) return null;
    const segs = relPath.split('/');
    if (segs.some((seg) => seg === '..')) return null;
    // Deny server-only / private files at any depth:
    //   • backend.js — module backend; never client-side.
    //   • data/      — runtime state. Never shipped to clients.
    //   • .* / _*    — dotfiles, package metadata, .env, _archive, etc.
    //                  Convention is "private by name" — match the same
    //                  rules used by isSpecialDir in discovery.js.
    //   • node_modules — module deps; shouldn't be reached this way.
    for (const seg of segs) {
      if (seg === 'backend.js') return null;
      if (seg === 'data') return null;
      if (seg === 'node_modules') return null;
      if (/^[._-]/.test(seg)) return null;
    }

    const mod = getModules().find((x) => x.id === id && x.workspace === ws);
    if (!mod) return null;

    const absRoot = path.resolve(mod.dir);
    const abs = path.resolve(absRoot, relPath);
    // Final containment check — anything outside the module's dir is denied.
    if (!abs.startsWith(absRoot + path.sep) && abs !== absRoot) return null;

    // Symlink-safe containment. `path.resolve` is purely lexical — it does NOT
    // follow symlinks, so a symlink planted inside the module dir could point
    // outside it (a module author could expose host files / another tenant's
    // data to any authed user). Re-assert containment against the real,
    // symlink-resolved path of whatever we're about to serve.
    let realRoot;
    try { realRoot = fs.realpathSync(absRoot); } catch { return null; }
    const confined = (p) => {
      let real;
      try { real = fs.realpathSync(p); } catch { return false; }
      return real === realRoot || real.startsWith(realRoot + path.sep);
    };

    // CSS request → .css source if it exists (tailwind/oxide build).
    if (abs.endsWith('.css')) {
      return fs.existsSync(abs) && confined(abs) ? { kind: 'css', src: abs } : null;
    }

    // JS request → prefer JSX source if a sibling .jsx exists.
    if (abs.endsWith('.js')) {
      const jsxCandidate = abs.slice(0, -3) + '.jsx';
      if (fs.existsSync(jsxCandidate) && confined(jsxCandidate)) return { kind: 'jsx', src: jsxCandidate };
      if (fs.existsSync(abs) && confined(abs)) return { kind: 'jsx', src: abs };  // raw .js — esbuild handles plain JS fine
      return null;
    }

    // .jsx URL — direct match (some imports may be explicit).
    if (abs.endsWith('.jsx') && fs.existsSync(abs) && confined(abs)) {
      return { kind: 'jsx', src: abs };
    }

    // Other file types — serve raw with a content-type guess.
    if (fs.existsSync(abs) && fs.statSync(abs).isFile() && confined(abs)) {
      const ext = path.extname(abs).toLowerCase();
      return { kind: 'raw', src: abs, contentType: RAW_CONTENT_TYPES[ext] || 'application/octet-stream' };
    }
    return null;
  }
  return null;
}

// Recursively collect a module's client-reachable .jsx/.js file paths for the
// CSS class scan. Skips exactly what the asset server refuses to serve, so the
// scanner sees only source that can render in the browser: node_modules / data
// dirs, backend.js (server-only), and [._-]-prefixed names (private by
// convention — mirrors resolveAssetSource). A module's Tailwind classes may
// live across many sibling files, not just frontend.jsx.
function walkJsxFiles(dir) {
  const out = [];
  const skip = new Set(['node_modules', 'data']);
  const walk = (d) => {
    let names;
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of names) {
      if (/^[._-]/.test(ent.name) || skip.has(ent.name)) continue;
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (ent.name === 'backend.js') continue;          // server-only, never rendered
      if (/\.(jsx|js)$/.test(ent.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// Every client-reachable source file feeds class names into the CSS scan. A
// module (or the chrome) may split its UI across sibling files, so we walk each
// module's dir recursively rather than reading frontend.jsx alone — a class
// anywhere in a module's client source gets generated. walkJsxFiles skips
// server-only / private files. Chrome and non-chrome modules are scanned
// identically; the scan no longer needs each module's meta.
function cssScanSources() {
  const out = [path.join(HOST_DIR, 'client.jsx')];
  for (const m of getModules()) {
    if (!m.hasFrontend) continue;
    out.push(...walkJsxFiles(m.dir));
  }
  return out;
}

// ------------------------------------------------------------------------
// Authentication contract — see atelier/docs/AUTH.md.
//
// Auth slot: first discovered global module whose mounted plug exports an
// `authenticate` function claims it. Workspace modules are not eligible
// (auth is global by definition). The slot is resolved lazily per request
// so adding/removing the auth module hot-swaps cleanly.
//
// Per request:
//   result = await authPlug.authenticate(req, defaultUser)
//   null  → authPlug.handleUnauth(req, res, ctx)   (shell hands off entirely)
//   user  → req.user = user, route normally.
//
// No auth module installed → req.user = defaultUser, no gate (today's dev).
// ------------------------------------------------------------------------

// authPlugs is hoisted near wsClients (top of file) for the same TDZ
// reason — mountPlug populates it during mountPendingBackends, well before
// this section runs.

function findAuthModule() {
  // Auth is opt-in and EXPLICIT: the `auth` setting names the gating module
  // (a path or a global module id), or is false to run ungated. A module
  // exporting `authenticate` does NOT gate unless it's the configured one, so
  // an instance can't be silently gated by a stray export — nor silently
  // exposed. Only global-workspace modules are eligible; auth gates the whole
  // shell, before any workspace selection.
  if (!AUTH) return null;
  const wantId = path.basename(String(AUTH));
  for (const m of getModules()) {
    if (m.workspace !== GLOBAL_WORKSPACE || !m.hasBackend) continue;
    if (m.qualifiedId !== AUTH && m.qualifiedId !== `${GLOBAL_WORKSPACE}/${wantId}` && m.id !== wantId) continue;
    const plug = authPlugs.get(m.qualifiedId);
    if (plug && typeof plug.authenticate === 'function') return { m, plug };
  }
  return null;
}

function buildDefaultUser({ metaByQId } = {}) {
  // Synthesized from raw discovery. Has full access to every discovered
  // module/workspace. An auth module receives this as `defaultUser` and
  // can pass-through, filter, replace, or null. Without an auth module
  // the shell uses it directly (today's dev mode).
  //
  // Workspaces are enumerated from the filesystem (listAllWorkspaces),
  // not from mounted modules — empty workspaces still appear in the
  // picker, and a workspace whose modules are all filtered by
  // atelier.config.json doesn't silently vanish. `global` is always
  // present.
  const mods = getModules().filter((m) => m.hasFrontend);
  const wsMap = new Map();              // ws → [{ id, meta? }]
  for (const ws of listAllWorkspaces()) wsMap.set(ws, []);
  for (const m of mods) {
    const meta = (metaByQId && metaByQId.get(m.qualifiedId)) || {};
    // Chrome modules and other `hidden` modules don't appear in the rail —
    // they're addressable (assets, bundle imports) but the client treats
    // them as infrastructure, not rail entries.
    if (meta.isChrome === true || meta.hidden === true) continue;
    const entry = { id: m.id, meta };
    if (!wsMap.has(m.workspace)) wsMap.set(m.workspace, []);
    wsMap.get(m.workspace).push(entry);
  }
  // Sort: 'global' first, others alphabetical.
  const workspaces = [...wsMap.entries()]
    .sort(([a], [b]) => {
      if (a === GLOBAL_WORKSPACE) return -1;
      if (b === GLOBAL_WORKSPACE) return 1;
      return a.localeCompare(b);
    })
    .map(([id, modules]) => ({ id, modules }));
  return { id: 'local', name: 'local', workspaces };
}

// Bare gate — runs the auth slot's `authenticate` and returns the user, or
// null when the slot refused. Never touches the response. Shared between
// HTTP requests and WS upgrades; the upgrade path can't render handleUnauth's
// HTML/JSON so it uses this directly and just drops the socket on null.
async function gateRequest(req, defaultUser) {
  const auth = findAuthModule();
  if (!auth) return defaultUser;
  try { return (await auth.plug.authenticate(req, defaultUser)) || null; }
  catch (err) {
    console.error(`  ! ${auth.m.qualifiedId}.authenticate threw: ${err.message}`);
    return null;
  }
}

// Per-request auth gate. Returns the user object on allow, or null when
// the auth module has already taken over the response (handleUnauth ran).
// Callers should set req.user from the return value and proceed if non-null.
async function authenticateRequest(req, res, defaultUser) {
  const user = await gateRequest(req, defaultUser);
  if (user) return user;
  const auth = findAuthModule();
  if (!auth) return null;
  // Unauth → hand off to the auth module entirely. It owns status, body,
  // and the takeover bootstrap if it wants HTML.
  try { await auth.plug.handleUnauth(req, res, makeCtx(auth.m)); }
  catch (err) {
    console.error(`  ! ${auth.m.qualifiedId}.handleUnauth threw: ${err.message}`);
    if (!res.writableEnded) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('auth error: ' + err.message);
    }
  }
  return null;
}

// ------------------------------------------------------------------------
// Index.html — rendered per request with injected bootstrap
// ------------------------------------------------------------------------

// Build the {qualifiedId → meta} map used to enrich entries in the user
// payload. Cached per-qid in metaCache by mtime, so subsequent calls inside
// one request (or across requests) are cheap.
async function getMetaByQId() {
  const allFront = getModules().filter((m) => m.hasFrontend);
  const metas = await Promise.all(allFront.map((m) => getModuleMeta(m)));
  return new Map(allFront.map((m, i) => [m.qualifiedId, metas[i]]));
}

// Resolve which module owns the `chrome` slot. If the `chrome` setting names a
// module (path or id) that's a mounted chrome, it wins; otherwise the first
// global-workspace module declaring `meta.isChrome` (alphabetical by qualifiedId
// for determinism). The shell ships no chrome of its own; with none installed
// this returns null and the client renders an "add a chrome" screen.
//
// The shell's client.jsx dynamic-imports `/modules/<chromeQid>/frontend.js`
// and renders its `chrome` named export as the root component.
// Every mounted chrome qid (global modules declaring `meta.isChrome`), sorted
// alphabetically. This is the set a module may pick from via `meta.chrome`, and
// the set the asset/API layer treats as infrastructure.
function chromeQids(metaByQId) {
  return [...metaByQId.entries()]
    .filter(([qid, meta]) => meta?.isChrome === true && qid.split('/')[0] === GLOBAL_WORKSPACE)
    .map(([qid]) => qid)
    .sort((a, b) => a.localeCompare(b));
}

// The instance DEFAULT chrome: the `chrome` setting if it names a mounted
// chrome, else the alphabetically-first mounted chrome, else null. Used
// whenever a module doesn't pin one — i.e. today's single-chrome behavior.
function resolveDefaultChromeQid(metaByQId) {
  const chromes = chromeQids(metaByQId);
  if (DEFAULT_CHROME) {
    const wantId = path.basename(String(DEFAULT_CHROME));
    const hit = chromes.find((qid) => qid === DEFAULT_CHROME || qid === `${GLOBAL_WORKSPACE}/${wantId}`);
    if (hit) return hit;
    console.warn(`  ! config defaultChrome '${DEFAULT_CHROME}' is not a mounted chrome module — falling back to discovery`);
  }
  return chromes[0] || null;
}

// Resolve the chrome for a specific requested module. A module may pin its
// chrome with `meta.chrome: '<chromeId>'`; it's honored only when that names a
// mounted chrome, otherwise (and for a null/unknown module — a workspace home
// or cold `/`) it falls back to the default. Purely additive: with no
// `meta.chrome` anywhere this returns the default for every URL, exactly as the
// single-chrome shell did.
function resolveChromeForQid(metaByQId, requestedQid) {
  const def = resolveDefaultChromeQid(metaByQId);
  const chrome = requestedQid ? metaByQId.get(requestedQid)?.chrome : null;
  const available = chromeQids(metaByQId);
  const missing = missingChrome(chrome, available);   // shared logic — matches the client
  if (missing) {
    // Not installed → render in the default chrome purely as a host frame; the
    // client shows a "chrome not installed" error (no silent fallback).
    console.warn(`  ! module '${requestedQid}' pins chrome '${missing}', which is not a mounted chrome — the page will show a "chrome not installed" error`);
    return def;
  }
  return resolveModuleChrome(chrome, available, def);
}

// Extract `<ws>/<id>` from a document URL so the initial page boots in that
// module's chrome. Null for `/`, a workspace home, or any non-module path.
function requestedQidFromUrl(reqUrl) {
  const p = (reqUrl || '/').split('?')[0];
  const m = p.match(/^\/([a-zA-Z0-9][a-zA-Z0-9_-]*)\/([a-zA-Z0-9][a-zA-Z0-9_-]*)/);
  return m ? `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}` : null;
}

// Build the per-request import map. A chrome MAY publish a `kit.js`
// (`kit.jsx`) — when present, modules can `import { Button } from
// '@atelier/kit'` and the browser resolves it via this map. The map is
// chrome-decided: each chrome picks what to publish, and modules paired
// with that chrome rely on its specific exports. No enforced contract.
function buildImportMap(chromeQid) {
  if (!chromeQid) return null;
  const m = getModules().find((x) => x.qualifiedId === chromeQid);
  if (!m) return null;
  const imports = {};
  if (fs.existsSync(path.join(m.dir, 'kit.js')) || fs.existsSync(path.join(m.dir, 'kit.jsx'))) {
    imports['@atelier/kit'] = `/modules/${chromeQid}/kit.js`;
  }
  return Object.keys(imports).length ? { imports } : null;
}

async function serveIndex(req, res) {
  // Auth runs FIRST. A logged-out visitor must NEVER see workspace info
  // leak in the bootstrap — the unauth handler owns the response and
  // renders its takeover.
  const template = getPinnedIndexHtml();
  const metaByQId = await getMetaByQId();

  const defaultUser = buildDefaultUser({ metaByQId });
  const user = await authenticateRequest(req, res, defaultUser);
  if (!user) return;                    // unauth handler took over the response

  // Workspace identity now lives in the URL path (`/<ws>/<id>`). No
  // canonicalization, no cookie — the client parses the URL on every
  // render and the picker writes a new URL on switch.
  // Resolve the chrome for THIS document from the requested module (its
  // `meta.chrome` → the default). The client gets the default + available set
  // too, so it can decide SPA vs full-load when navigating across chromes.
  const requestedQid = requestedQidFromUrl(req.url);
  const defaultChromeQid = resolveDefaultChromeQid(metaByQId);
  const chromeQid = resolveChromeForQid(metaByQId, requestedQid);
  const bootstrap = {
    mode: MODE,
    label: LABEL,
    user,
    chromeQid,
    defaultChromeQid,
    chromes: chromeQids(metaByQId),
    // Seed only the backend errors this user can see — same per-module ACL as the
    // live WS frames, so a page load never carries another tenant's error/stack.
    backendErrors: (() => {
      const visible = allowedTopics(user);
      return [...backendErrors].filter(([qid]) => visible.has(qid)).map(([qid, v]) => ({ qid, message: v.message }));
    })(),
  };
  const importMap = buildImportMap(chromeQid);
  const importMapTag = importMap
    ? `<script type="importmap">${JSON.stringify(importMap)}</script>`
    : '';

  // Render-blocking <link> to the chrome's stylesheet so it arrives before
  // the chrome bundle parses and React renders — eliminates the FOUC where
  // Lucide SVGs paint at default 24px before Tailwind utilities apply.
  // Only emit if the chrome ships a styles.css; the chrome's own JS IIFE
  // checks for the `atelier-chrome-styles` id and skips a duplicate.
  let chromeStylesTag = '';
  if (chromeQid) {
    const chromeMod = getModules().find((x) => x.qualifiedId === chromeQid);
    if (chromeMod && fs.existsSync(path.join(chromeMod.dir, 'styles.css'))) {
      chromeStylesTag = `<link id="atelier-chrome-styles" rel="stylesheet" href="/modules/${chromeQid}/styles.css">`;
    }
  }

  let html = template.replace(
    '/*__ATELIER_BOOTSTRAP__*/',
    `window.__ATELIER__ = ${JSON.stringify(bootstrap)};`
  );
  html = html.replace('<!--__ATELIER_IMPORTMAP__-->', importMapTag);
  html = html.replace('<!--__ATELIER_CHROME_STYLES__-->', chromeStylesTag);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

// ------------------------------------------------------------------------
// WebSocket multiplex — shell-owned shared transport for real-time events.
//
// Wire protocol: each frame is JSON `{ topic, ...event }`. Topics are
// qualified ids:
//
//   • '<workspace>/<id>' — events from a specific module mount. A module
//     subscribes to its own qid (derived client-side from `import.meta.url`)
//     and only sees its own broadcasts. Two same-named modules in
//     different workspaces can't cross-talk.
//   • 'shell'            — shell events (hot reload, etc). Every client
//     subscribes to 'shell'.
//
// The server doesn't filter fan-out — every frame goes to every connected
// client, and the client's per-topic subscriber map decides what each one
// actually receives. With qualified topics, that's both correct and simple.
// ------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });
// wsClients is declared near the top of the file (hoisted) so module
// mounting can safely call ctx.broadcast before this section runs.

// Broadcast from a module mount. Topic = qualifiedId.
//
// Spread order: shell-owned `topic` comes LAST so a module that accidentally
// (or maliciously) names an event field `topic` can't override the routing
// key. Same defensive ordering everywhere the shell merges module data
// into a structure it owns.
// The set of WS topics a user may receive — `<ws>/<id>` for every module in
// their workspaces view. Mirrors what the chrome renders the rail from, so a
// client receives a module's frames iff it can see that module. Computed once
// per connection (see the upgrade handler) so the per-frame check stays O(1) —
// it runs for every client on every broadcast.
// The set of modules a user may reach — `<ws>/<id>` for every module in their
// workspaces view. The single source of truth for the module boundary: the
// HTTP presence gate (the `/api/<ws>/<id>` lane) and the WS ACL both gate on
// this, so "can see in the rail", "can call its API", and "receives its
// frames" are the one decision the auth module made in `user.workspaces`.
function userModuleSet(user) {
  const set = new Set();
  for (const ws of user?.workspaces || []) {
    for (const m of ws.modules || []) set.add(`${ws.id}/${m.id}`);
  }
  return set;
}

function allowedTopics(user) {
  const set = userModuleSet(user);
  // Module-level topics only. Per-module sub-room topics (`<ws>/<id>/<room>`)
  // would be added here once the auth module returns per-module `rooms` — see
  // the WS pillar in docs/AUTH.md. The per-frame check stays exact-match.
  return set;
}

const warnedHardcodedTopics = new Set();   // dedupe the dev warning below
function wsBroadcastFromModule(qid, event) {
  // A module's WS topic is ALWAYS its qualifiedId (`<ws>/<id>`, workspace-aware) —
  // the shell stamps it (topic comes last, can't be overridden). If a module
  // passes its own `topic`, it's ignored; warn once so the hardcoded value
  // (which would break when the module moves workspaces) gets caught in dev.
  if (event && event.topic && event.topic !== qid) {
    const key = `${qid} ${event.topic}`;
    if (!warnedHardcodedTopics.has(key)) {
      warnedHardcodedTopics.add(key);
      console.warn(`  ! ${qid} broadcast with topic '${event.topic}' — ignored. WS topics are always your qualifiedId ('${qid}'); subscribe via window.__atelier.self(import.meta.url) so it stays workspace-aware.`);
    }
  }
  if (wsClients.size === 0) return;
  const frame = JSON.stringify({ ...event, topic: qid });
  for (const ws of wsClients) {
    if (ws.readyState !== 1 /* OPEN */) continue;
    // Per-module ACL: only deliver a module's frames to a client whose user can
    // see that module (ws.allowed is the precomputed topic set). With no auth
    // module the user is the full-access defaultUser, so this is a no-op.
    if (ws.allowed && !ws.allowed.has(qid)) continue;
    try { ws.send(frame); } catch { /* drop */ }
  }
}

// Shell-level broadcasts (hot reload, etc) reach every client.
function wsBroadcastShell(event) {
  if (wsClients.size === 0) return;
  const frame = JSON.stringify({ ...event, topic: 'shell' });
  for (const ws of wsClients) {
    if (ws.readyState !== 1) continue;
    try { ws.send(frame); } catch { /* drop */ }
  }
}

// Backend-error frames carry module-specific detail (the error message + a stack
// that can include the operator's server paths), so — unlike other shell events
// — they must respect the per-module ACL: a client only learns a module's
// backend broke if its user can see that module. Without this, a backend failure
// in one tenant's module would leak its error + stack to every connected client.
// The frame stays on the `shell` topic (where the client routes backend-error);
// only delivery is gated, exactly like a module frame (no-op without auth).
function wsBroadcastBackendError(qid, message) {
  if (wsClients.size === 0) return;
  const frame = JSON.stringify({ type: 'backend-error', qid, message, topic: 'shell' });
  for (const ws of wsClients) {
    if (ws.readyState !== 1) continue;
    if (ws.allowed && !ws.allowed.has(qid)) continue;
    try { ws.send(frame); } catch { /* drop */ }
  }
}

wss.on('connection', (ws) => {
  wsClients.add(ws);
  const drop = () => wsClients.delete(ws);
  ws.on('close', drop);
  ws.on('error', drop);
});

// Periodic re-validation of live WS connections. `authenticate` runs only at the
// upgrade, so without this a revoked session would keep streaming. Every
// REVALIDATE_MS we re-run it per open socket against the same upgrade request:
// null → the session ended → close (code 4001); a changed user → refresh
// ws.user + ws.allowed so granted/revoked module access takes effect without a
// reconnect. Only runs when an auth module is configured (an ungated user never
// changes). `authenticate` must be cheap (a session lookup) — it's called once
// per open socket per interval.
if (AUTH) {
  const timer = setInterval(async () => {
    if (wsClients.size === 0) return;
    let defaultUser;
    try { defaultUser = buildDefaultUser({ metaByQId: await getMetaByQId() }); } catch { return; }
    for (const ws of wsClients) {
      if (ws.readyState !== 1 || !ws.authReq) continue;
      let user;
      try { user = await gateRequest(ws.authReq, defaultUser); } catch { user = null; }
      if (!user) { try { ws.close(4001, 'session ended'); } catch {} continue; }
      ws.user = user;
      ws.allowed = allowedTopics(user);
    }
  }, REVALIDATE_MS);
  timer.unref?.();
}

// ------------------------------------------------------------------------
// Hot reload — fs.watch → WS broadcast (topic: 'shell')
// ------------------------------------------------------------------------

const dirtyIds = new Map();   // moduleId → { cssOnly } accumulated over the debounce window
let reloadTimer = null;

// Per-module reload events let the client choose whether to full-reload
// (chrome / shell / unknown module) or hot-swap the module's bundle in place.
// 'shell' is the catch-all for top-level files.
//
// `opts.cssFile` marks THIS change as a stylesheet (.css) edit. The active
// chrome can't hot-swap its component/JS (styles + import map are baked into
// the document at load) — but if its whole window of changes was css-only, the
// client refreshes the stylesheet in place instead of full-reloading (smooth
// theme/token tweaks). A single non-css file in the window (a .jsx/.js
// component) clears the flag, so a real component edit still full-reloads.
function broadcastReload(moduleId, opts = {}) {
  const cssFile = !!opts.cssFile;
  const cur = dirtyIds.get(moduleId);
  if (cur) cur.cssOnly = cur.cssOnly && cssFile;
  else dirtyIds.set(moduleId, { cssOnly: cssFile });
  // Shell-level events (config edits, new workspace dirs) can introduce
  // new path-mounted modules whose dirs live outside ROOT. The boot-time
  // watchOffRootModules pass missed those; re-run it here so the next
  // edit inside the newly mounted module triggers a hot reload too.
  if (moduleId === 'shell') {
    try { watchOffRootModules(); } catch {}
  }
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    for (const [id, st] of dirtyIds) wsBroadcastShell({ type: 'reload', moduleId: id, cssOnly: st.cssOnly });
    dirtyIds.clear();
  }, 150);
}

// Module `data/` dirs hold runtime state (persisted schedules, run archives,
// incremental crawl output). They change often while the app is running and
// must NOT trigger HMR — otherwise a long-running extract reloads the browser
// every few seconds and wipes session state. Same logic for `node_modules`.
//
// Path segments starting with `_`, `.`, or `-` are also skipped: workspaces
// hold their own _inbox/_generations/_agents data dirs that have high write
// rates and aren't modules. `$` is NOT in the skip list — that's the
// workspace marker; workspace contents need to be watched.
const WATCH_SKIP_SEG = new Set(['data', 'node_modules']);
const watchSkipSeg = (s) =>
  RESERVED_NAMES.has(s) ||
  WATCH_SKIP_SEG.has(s) ||
  s.startsWith('_') ||
  s.startsWith('.') ||
  s.startsWith('-');

// Content-dedupe for the frontend watchers. fs.watch fires on every write,
// including a content-IDENTICAL rewrite (an editor saving an unchanged buffer,
// a formatter that changes nothing, a tool re-touching the file it just wrote)
// — that bumps mtime but changes nothing, so reloading on it is pure noise.
// Returns true only when the file's bytes actually differ from what we last
// saw (and updates the record). A directory, a deleted/unreadable file, a
// large asset, or a first sighting is treated as changed — never suppressed —
// so real edits, creations, and deletions always reload. Mirrors the mtime-
// dedupe the backend reload path already does.
const _fileHashes = new Map();   // absPath → sha1 of last-seen content
function contentChanged(absPath) {
  let buf;
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) { _fileHashes.delete(absPath); return true; }
    buf = fs.readFileSync(absPath);
  } catch {
    _fileHashes.delete(absPath);   // gone / unreadable (e.g. a delete) → reload
    return true;
  }
  const h = crypto.createHash('sha1').update(buf).digest('hex');
  const prev = _fileHashes.get(absPath);
  _fileHashes.set(absPath, h);
  return prev !== h;               // undefined prev (first sight) ≠ h → changed
}

// Path-mounted modules (atelier.config.json `{ "path": ... }` entries) can
// live anywhere on disk — outside ROOT, so the ROOT watcher misses them.
// Walk current discovery once at boot and add a watcher per off-ROOT
// module dir. Skips node_modules/dotfiles to avoid getting drowned by
// npm-install events.
const offRootWatched = new Set();
function watchOffRootModules() {
  if (!HOT_RELOAD) return;
  for (const m of getModules()) {
    if (offRootWatched.has(m.qualifiedId)) continue;
    const isUnderRoot = m.dir.startsWith(ROOT + path.sep) || m.dir === ROOT;
    if (isUnderRoot) continue;
    if (!fs.existsSync(m.dir)) continue;
    try {
      fs.watch(m.dir, { recursive: true }, (event, filename) => {
        if (!filename) return;
        const segs = filename.split(path.sep);
        if (segs.some((s) => s === 'node_modules' || s === 'data' || s.startsWith('.'))) return;
        if (!contentChanged(path.join(m.dir, filename))) return;   // skip content-identical touches
        broadcastReload(m.qualifiedId, { cssFile: filename.endsWith('.css') });
      });
      offRootWatched.add(m.qualifiedId);
    } catch (err) {
      console.warn(`  ! could not watch ${m.qualifiedId} at ${m.dir}: ${err.message}`);
    }
  }
}
watchOffRootModules();

if (HOT_RELOAD) fs.watch(ROOT, { recursive: true }, (event, filename) => {
  if (!filename) return;
  const segs = filename.split(path.sep);
  if (segs.some(watchSkipSeg)) return;
  // backend.js hot-swaps server-side via fs.watch — never nudge the browser.
  if (segs[segs.length - 1] === 'backend.js') return;
  // Skip content-identical rewrites (editor write-back, no-op formatter, a tool
  // re-touching a just-edited file on the next message): they bump mtime but
  // change nothing. Dirs, deletes, and new files read as changed, so workspace
  // creation and real edits still fire.
  if (!contentChanged(path.join(ROOT, filename))) return;

  // Resolve the qualified id of the (possibly affected) module.
  //   root:      <mod>/...        → qualifiedId = 'global/<mod>'
  //   workspace: $<ws>/<mod>/...  → qualifiedId = '<ws>/<mod>'
  let qualifiedId = null;
  if (segs.length >= 1 && isWorkspaceDir(segs[0])) {
    if (segs.length >= 2) {
      qualifiedId = `${workspaceName(segs[0])}/${segs[1]}`;
    }
    // bare $<ws> (workspace creation) — fall through to shell reload.
  } else if (segs.length > 1) {
    qualifiedId = `${GLOBAL_WORKSPACE}/${segs[0]}`;
  }

  if (!qualifiedId) {
    // Top-level file or new workspace dir — refresh the shell so discovery
    // re-runs and the rail picks up any newly-appearing $workspace.
    broadcastReload('shell');
    return;
  }

  // If the module isn't in current discovery (mkdir of an empty new
  // module folder, or a non-module dir like 'kit/' with no frontend),
  // stay silent — the next file event inside the folder, once frontend.jsx
  // exists, will trigger a real reload.
  const mod = getModules().find((m) => m.qualifiedId === qualifiedId);
  if (!mod || !mod.hasFrontend) return;
  broadcastReload(qualifiedId, { cssFile: filename.endsWith('.css') });
});

// If `srcPath` is a bundle-entry of a chrome module, return that module's
// dir (used as absWorkingDir for the bundled build). Else null.
// Chrome modules need esbuildBuild (bundling with node_modules resolution
// + react alias) instead of the per-file transform; this detection picks
// the right path lazily so non-chrome modules keep their cheap pipeline.
//
// Bundle entries are `frontend.jsx` (the chrome itself) and `kit.js` /
// `kit.jsx` (the chrome's published primitives for companion modules,
// resolved via the `@atelier/kit` import-map specifier the shell injects
// in serveIndex).
async function chromeBundleRootFor(srcPath) {
  const metaByQId = await getMetaByQId();
  for (const m of getModules()) {
    if (!m.hasFrontend) continue;
    const meta = metaByQId.get(m.qualifiedId) || {};
    if (meta.isChrome !== true) continue;
    if (srcPath === path.join(m.dir, 'frontend.jsx')) return m.dir;
    if (srcPath === path.join(m.dir, 'kit.js'))       return m.dir;
    if (srcPath === path.join(m.dir, 'kit.jsx'))      return m.dir;
  }
  return null;
}

// Shared asset response — used by both shell-asset (public) and module-asset
// (auth-gated) paths. Resolves source via resolveAssetSource and writes the
// appropriate compiled or raw response.
// Shell-owned assets (`/assets/*`, i.e. the compiled `client.js`) are PINNED to
// the running process: built once and served unchanged until the next restart,
// so the server and the client bundle it ships can never drift apart. Editing a
// shell source file therefore has no effect until an explicit restart — by
// design; core-infra changes should be deliberate. (Module and chrome bundles
// under `/modules/*` are NOT pinned — they hot-reload, which is the whole point
// of a module.) This closes the "old server + freshly-recompiled client" skew.
const _pinnedShellAssets = new Map();
function getPinnedShellJsx(src) {
  if (!_pinnedShellAssets.has(src)) _pinnedShellAssets.set(src, getJsx(src));
  return _pinnedShellAssets.get(src);
}

// The shell's index.html template is pinned the same way — read once and held
// for the process, so the bootstrap HTML can't drift from the running server.
let _pinnedIndexHtml = null;
function getPinnedIndexHtml() {
  if (_pinnedIndexHtml == null) _pinnedIndexHtml = fs.readFileSync(path.join(HOST_DIR, 'index.html'), 'utf8');
  return _pinnedIndexHtml;
}

// Append `?v=<v>` to a module's own RELATIVE import specifiers (`./x`, `../x`)
// so a hot-swap re-import busts the module's WHOLE file graph, not just its
// entry. ES module specifiers are URL-keyed and a relative import resolves
// against the importer's URL with the query dropped — so `frontend.js?v=5`
// importing `./helper.js` still resolves to the query-less, browser-cached
// `helper.js`. Without this, editing any sibling of a multi-file module is
// served from the browser's stale module cache and the change never shows
// (you'd have to full-reload). Bare specifiers (`react`, `@atelier/kit`) and
// absolute URLs carry no leading dot, so they're left alone — the shared
// chrome kit isn't needlessly re-fetched on every module edit. The version
// propagates transitively: each re-fetched sibling is itself served with
// `?v`, so its own relative imports get rewritten too.
function versionRelativeImports(code, v) {
  const tag = `?v=${v}`;
  return String(code)
    .replace(/(\bfrom\s*)(["'])(\.{1,2}\/[^"'?]*)(\2)/g,        (_, a, q, p) => `${a}${q}${p}${tag}${q}`)
    .replace(/(\bimport\s*\(\s*)(["'])(\.{1,2}\/[^"'?]*)(\2)/g, (_, a, q, p) => `${a}${q}${p}${tag}${q}`)
    .replace(/(\bimport\s+)(["'])(\.{1,2}\/[^"'?]*)(\2)/g,      (_, a, q, p) => `${a}${q}${p}${tag}${q}`);
}

async function serveAsset(req, res, url) {
  const asset = resolveAssetSource(url.pathname);
  if (!asset) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  try {
    const headers = {};
    let body;
    if (asset.kind === 'jsx') {
      const bundleRoot = await chromeBundleRootFor(asset.src);
      const isModuleFrontend = !bundleRoot && !url.pathname.startsWith('/assets/');
      const built = bundleRoot
        ? await getJsxBundle(asset.src, bundleRoot, NODE_ENV)     // chrome bundle — hot-reloads (a module)
        : url.pathname.startsWith('/assets/')
          ? await getPinnedShellJsx(asset.src)                    // shell asset (client.js) — pinned to the process
          : await getJsx(asset.src);                             // module frontend — hot-reloads
      headers['Content-Type'] = built.contentType;
      // Hot-swap path only: a `?v=N` on a module frontend request means the
      // client is re-importing a changed module — propagate that version onto
      // its relative imports so a multi-file module's siblings re-fetch too.
      // Cold loads carry no `?v`, so this is inert for normal serving.
      const v = isModuleFrontend && url.searchParams.get('v');
      body = (v && /^\d+$/.test(v)) ? versionRelativeImports(built.content, v) : built.content;
    } else if (asset.kind === 'css') {
      const built = await getCss(asset.src, cssScanSources(), HOST_DIR);
      headers['Content-Type'] = built.contentType;
      body = built.content;
    } else {
      headers['Content-Type'] = asset.contentType;
      body = fs.readFileSync(asset.src);
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch (err) {
    console.error(`  ! build failed for ${url.pathname}:`, err.message);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('// build error: ' + err.message);
  }
}

// ------------------------------------------------------------------------
// Server
// ------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  await mountPendingBackends();

  if (url.pathname === '/' || url.pathname === '/index.html') {
    await serveIndex(req, res);
    return;
  }

  // Shell assets (`/assets/*`) are ALWAYS public — the takeover login page
  // itself loads /assets/client.js before any auth cookie exists. These are
  // first-party shell bytes; no module-installation disclosure happens here.
  // (Visual styles live in the chrome module's bundle, not in /assets/.)
  if (url.pathname.startsWith('/assets/')) {
    await serveAsset(req, res, url);
    return;
  }

  // Everything below — module assets and API — is auth-gated. Auth-gating
  // `/modules/*` closes a module-enumeration disclosure: without this, an
  // unauthenticated visitor could probe `/modules/<guess>/<id>/frontend.js`
  // and distinguish 200 (installed) from 404 (not), learning what's on the
  // server. The auth module's `authenticate()` whitelists its own bundle
  // path (e.g. `/modules/global/auth/...`) by returning a synthetic guest
  // user for those paths — same pattern it uses for `/api/global/auth/login`.
  const metaByQId = await getMetaByQId();
  const apiUser = await authenticateRequest(req, res, buildDefaultUser({ metaByQId }));
  if (!apiUser) return;                 // auth module owned the response
  req.user = apiUser;

  // Shell-owned identity probe. Lives in the auth-gated lane so a 401 here
  // unambiguously means "session is dead." Used by the client's WS-drop
  // handler to tell `server unreachable` apart from `you need to sign in`.
  // Always present regardless of which auth module is installed (or none).
  if (url.pathname === '/_atelier/whoami') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      id: apiUser.id || null,
      name: apiUser.name || null,
      anonymous: !!apiUser.anonymous,
    }));
    return;
  }

  // Module assets — `/modules/<ws>/<id>/<rest>`. Workspace+id is fully
  // identified by URL; served only to authed users.
  if (url.pathname.startsWith('/modules/')) {
    await serveAsset(req, res, url);
    return;
  }

  // Authorization for `/api/<ws>/<id>/…` — two TRUSTED layers in front of the
  // (untrusted, possibly vibe-coded) module router. Enforcement never lives in
  // the feature module; see the three pillars in docs/AUTH.md.
  //
  //   1. Presence (shell, mechanical) — the module boundary. The request's
  //      module must be in the user's workspaces view (userModuleSet) — the
  //      same set that draws the rail and gates WS frames. Closes the
  //      cross-tenant hole where any authed user could call any module's API.
  //   2. authorize (auth module, optional) — everything below the boundary:
  //      read/write, payload inspection, sub-resource rules. The decision is
  //      the trusted auth module's; the shell only enforces its verdict. The
  //      module router runs ONLY after both pass.
  //
  // Exempt from both: (a) the configured auth module's OWN routes — you can't
  // gate the gate (login must be reachable), and it governs its own surface
  // through `authenticate`; (b) any mounted chrome — the available-chrome set
  // (`chromeQids`), resolved server-side from discovery. Chromes are excluded
  // from `buildDefaultUser`, so they're in nobody's `user.workspaces` and the
  // presence gate would 403 them for every user; but a chrome (and its own API,
  // e.g. a help/docs endpoint) is shell scaffolding any authed user may load,
  // not tenant data — and with `meta.chrome` a non-default chrome is reachable too.
  // The set is operator-controlled (only mounted `meta.isChrome` modules qualify);
  // a feature module can't widen its own API surface beyond becoming a chrome,
  // which removes it from every rail and workspace.
  // Ungated instances skip this whole block — `findAuthModule()` is null, so
  // there's nothing to enforce.
  if (url.pathname.startsWith('/api/')) {
    const seg = url.pathname.split('/');            // ['', 'api', <ws>, <id>, …]
    const reqQid = seg[2] && seg[3] ? `${seg[2]}/${seg[3]}` : null;
    const auth = findAuthModule();
    const authQid = auth?.m.qualifiedId;
    const isInfra = reqQid != null && chromeQids(metaByQId).includes(reqQid);
    if (reqQid && authQid && reqQid !== authQid && !isInfra) {
      if (!userModuleSet(apiUser).has(reqQid)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden' }));
        return;
      }
      if (typeof auth.plug.authorize === 'function') {
        req.json = () => bodyOf(req);   // memoized — the handler shares this parse
        const modPath = url.pathname.slice(`/api/${reqQid}`.length) || '/';
        try {
          const ok = await auth.plug.authorize(req, apiUser, {
            qualifiedId: reqQid,
            method: req.method,
            path: modPath,
          });
          if (!ok) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'forbidden' }));
            return;
          }
        } catch (err) {
          // A thrown authorize is a denial. It may carry a statusCode (e.g. a
          // 413 from reading an oversized body) — honor it; default to 403.
          const status = err.statusCode || 403;
          if (!res.writableEnded) {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message || 'forbidden' }));
          }
          if (status >= 500) console.error(`  ! ${auth.m.qualifiedId}.authorize threw:`, err);
          return;
        }
      }
    }

    // A backend that failed to (re)load → a clear 500 on ITS OWN api lane only.
    // Scoped to reqQid, so a broken backend never takes the rest of the instance
    // down — other modules' APIs are untouched. Same actionable message the
    // overlay shows. (`reqQid` null for `/api/` with no <ws>/<id> → skipped.)
    if (reqQid && backendErrors.has(reqQid)) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'backend failed to load', module: reqQid, message: backendErrors.get(reqQid).message }));
      return;
    }
  }

  // API — `/api/<ws>/<id>/...`. Routes were registered with the same
  // prefix by `makeModuleScope`, so the dispatcher just matches by URL.
  if (await router.handle(req, res)) return;

  // SPA fallback. Workspace + id is in the URL:
  //   /<ws>/                — workspace home
  //   /<ws>/<id>            — module page
  //   /<ws>/<id>/<sub…>     — module sub-route (the module owns everything after
  //                           ws+id; surfaced client-side via __atelier.useRoute)
  // All serve the same index.html; the client parses the URL on render.
  //
  // Reserved prefixes (/api/, /assets/, /modules/, /_atelier/) must NOT fall
  // through here — an unmatched API route should 404 cleanly instead of
  // serving HTML. The router and asset handler above already claim the happy
  // paths; the explicit prefix check catches the mismatched ones. Module assets
  // live under /modules/ and /api/, never under /<ws>/<id>/…, so the deep-path
  // match below can't shadow an asset.
  const isReservedPrefix =
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/modules/') ||
    url.pathname.startsWith('/_atelier/');
  if (req.method === 'GET'
      && !isReservedPrefix
      && /^\/[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\/.*)?)?\/?$/
        .test(url.pathname)) {
    await serveIndex(req, res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// HTTP → WebSocket upgrade handler. Only `/_atelier/ws` is accepted;
// any other Upgrade request is dropped. The WebSocketServer is in
// `noServer: true` mode so the HTTP server owns the listening socket
// and forwards relevant upgrades.
//
// Gated by the same `authenticate` slot as HTTP. The auth module sees the
// upgrade request (cookies present in headers) and returns a user or null.
// `handleUnauth` doesn't apply — there's no HTML/JSON body on a WS handshake
// to render into — so on null we write a bare 401 and destroy. The client's
// reconnect loop retries after the user signs in.
server.on('upgrade', async (req, socket, head) => {
  let pathname;
  try { pathname = new URL(req.url, `http://localhost:${PORT}`).pathname; }
  catch { socket.destroy(); return; }
  if (pathname !== '/_atelier/ws') { socket.destroy(); return; }

  await mountPendingBackends();
  const user = await gateRequest(req, buildDefaultUser({ metaByQId: await getMetaByQId() }));
  if (!user) {
    try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); } catch {}
    socket.destroy();
    return;
  }

  // Attach the user + a precomputed per-module topic ACL (ws.allowed): the
  // server only fans a module's frames to clients whose user can see it.
  // ws.authReq is kept so the socket can be re-validated periodically below.
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.user = user;
    ws.allowed = allowedTopics(user);
    ws.authReq = req;
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
