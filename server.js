/* Atelier runner — host mode + standalone mode.
 *
 *   node host/server.js              → host mode, all modules listed in the rail
 *   node host/server.js <module-id>  → standalone mode, just that module
 *
 * Conventions:
 *   • A sibling directory of host/ is a module iff it contains a `frontend.jsx`
 *     or `backend.js`. The directory name is the id and default name.
 *   • frontend.jsx is compiled as ESM. It should `export default function Module`
 *     and may `export const meta = { icon, color }` to customize the rail item.
 *   • backend.js exports `default { mountRoutes(router, ctx) }` for API routes.
 *
 * Asset URLs (convention-driven, no registration):
 *   /assets/<name>.js              → host/<name>.jsx        (esbuild, ESM)
 *   /assets/<name>.css             → host/<name>.css        (tailwind + oxide)
 *   /modules/<id>/frontend.js      → <id>/frontend.jsx      (esbuild, ESM)
 *
 * Hot reload: /_atelier/hot is an SSE stream. fs.watch (recursive) fires on
 * any change under the project root and the server broadcasts 'reload' — the
 * client does a full page reload. Discovery is per-request so new folders
 * appear without restart. Backends are mounted lazily on first discovery.
 * (Editing server.js or build.js still requires a manual restart.)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transform as esbuildTransform, build as esbuildBuild } from 'esbuild';
import chokidar from 'chokidar';
import { getJsx, getCss } from './atelier.js';

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
    get:  (p, h) => { add('GET',  p, h); },
    post: (p, h) => { add('POST', p, h); },
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

const SKIP = new Set(['atelier']);
const isSpecialDir = (name) => !/^[a-zA-Z0-9]/.test(name);

function discoverModules() {
  const out = [];
  for (const name of fs.readdirSync(ROOT)) {
    if (isSpecialDir(name)) continue;
    if (SKIP.has(name)) continue;
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

function getModules() {
  let mods = discoverModules();
  if (MODE === 'standalone') {
    const only = mods.find((m) => m.id === requestedId);
    return only ? [only] : [];
  }
  return mods;
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

function makeCtx(m) {
  return {
    id: m.id,
    name: m.id,
    env: ENV,
    dataDir: path.join(m.dir, 'data'),
    log: (...args) => console.log(`[${m.id}]`, ...args),
  };
}

function makeModuleScope() {
  const mine = [];
  return {
    get:  (p, h) => { mine.push(router._add('GET',  p, h)); },
    post: (p, h) => { mine.push(router._add('POST', p, h)); },
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
  for (const m of getModules()) {
    if (!m.hasBackend) continue;
    if (attemptedBackends.has(m.id)) continue;
    attemptedBackends.add(m.id);
    await mountBackend(m);
  }
}

await mountPendingBackends();

// ------------------------------------------------------------------------
// URL → source path mapping
// ------------------------------------------------------------------------

function resolveAssetSource(pathname) {
  // /assets/<name>.js  → host/<name>.jsx
  let m = /^\/assets\/([a-z0-9-]+)\.js$/.exec(pathname);
  if (m) {
    const src = path.join(HOST_DIR, m[1] + '.jsx');
    return fs.existsSync(src) ? { kind: 'jsx', src } : null;
  }
  // /assets/<name>.css → host/<name>.css
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
// Hot reload — SSE + fs.watch
// ------------------------------------------------------------------------

const hotClients = new Set();
let reloadTimer = null;

function broadcastReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    const data = 'data: reload\n\n';
    for (const res of hotClients) {
      try { res.write(data); } catch { hotClients.delete(res); }
    }
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
  if (segs.some((s) => SKIP.has(s) || WATCH_SKIP_SEG.has(s) || isSpecialDir(s))) return;
  broadcastReload();
});

function serveHotStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('retry: 500\n\n');
  hotClients.add(res);
  req.on('close', () => hotClients.delete(res));
}

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

  if (url.pathname === '/_atelier/hot') {
    serveHotStream(req, res);
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
