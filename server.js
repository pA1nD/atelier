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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getJsx, getCss } from './atelier.js';

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HOST_DIR, '..');
const PORT = parseInt(process.env.PORT || '1844', 10);

const [, , requestedId] = process.argv;
const MODE = requestedId ? 'standalone' : 'host';

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
    routes.push({ method, re, paramNames, handler });
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
    get:  (p, h) => add('GET',  p, h),
    post: (p, h) => add('POST', p, h),
    handle,
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

const SKIP = new Set(['atelier', '_design']);

function discoverModules() {
  const out = [];
  for (const name of fs.readdirSync(ROOT)) {
    if (name.startsWith('.')) continue;
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
// Backend mounting — lazy, once per module
// ------------------------------------------------------------------------

const router = createRouter();
const mountedBackends = new Set();

async function mountPendingBackends() {
  for (const m of getModules()) {
    if (!m.hasBackend || mountedBackends.has(m.id)) continue;
    try {
      const mod = await import(path.join(m.dir, 'backend.js'));
      const plug = mod.default;
      if (!plug?.mountRoutes) {
        console.warn(`  ! ${m.id}/backend.js has no default.mountRoutes export — skipping`);
        mountedBackends.add(m.id); // don't retry
        continue;
      }
      const ctx = {
        id: m.id,
        name: m.id,
        dataDir: path.join(m.dir, 'data'),
        log: (...args) => console.log(`[${m.id}]`, ...args),
      };
      plug.mountRoutes(router, ctx);
      mountedBackends.add(m.id);
      console.log(`  + mounted ${m.id} backend`);
    } catch (err) {
      console.error(`  ! Failed to mount ${m.id}: ${err.message}`);
      mountedBackends.add(m.id); // don't retry on broken backend
    }
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

function serveIndex(res) {
  const template = fs.readFileSync(path.join(HOST_DIR, 'index.html'), 'utf8');
  const bootstrap = {
    mode: MODE,
    modules: getModules().map((m) => ({
      id: m.id,
      name: m.id,
      hasFrontend: m.hasFrontend,
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

fs.watch(ROOT, { recursive: true }, (event, filename) => {
  if (!filename) return;
  const segs = filename.split(path.sep);
  if (segs.some((s) => SKIP.has(s) || s.startsWith('.'))) return;
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
    serveIndex(res);
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
    serveIndex(res);
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
  writeDiscoveryFile();
});

/* Discovery: agents find atelier by reading ~/.atelier/url. Written on boot,
 * removed on graceful shutdown so a stale file never points at a dead port.
 *
 * Only the installed server (running from ~/.atelier/atelier) advertises.
 * Dev instances via `npm run dev` don't — they'd fight the install's file. */
const DISCOVERY_PATH = path.join(os.homedir(), '.atelier', 'url');
const IS_INSTALLED = HOST_DIR === path.join(os.homedir(), '.atelier', 'atelier');

function writeDiscoveryFile() {
  if (!IS_INSTALLED) return;
  try {
    fs.mkdirSync(path.dirname(DISCOVERY_PATH), { recursive: true });
    fs.writeFileSync(
      DISCOVERY_PATH,
      `http://localhost:${PORT}\nworkspace: ${ROOT}\n`,
      { mode: 0o600 }
    );
  } catch (err) {
    console.warn(`  ! couldn't write ${DISCOVERY_PATH}: ${err.message}`);
  }
}

function removeDiscoveryFile() {
  if (!IS_INSTALLED) return;
  try { fs.unlinkSync(DISCOVERY_PATH); } catch {}
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    removeDiscoveryFile();
    process.exit(0);
  });
}
