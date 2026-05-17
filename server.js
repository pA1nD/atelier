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
  RESERVED_NAMES, isSpecialDir, isWorkspaceDir, workspaceName,
} from './atelier.js';

// Env normalization — shell owns the defaults so modules (and any child
// processes they spawn) can read process.env.{NODE_ENV,PORT,BASE_URL}
// without inventing fallbacks of their own. NODE_ENV follows the Node
// canonical 'development'/'production'; ctx.env exposes the short 'dev'
// /'prod' form that Atelier code uses. Default ports differ by env so
// dev (5172) and prod (1844) can coexist on the same machine; an external
// PORT= override wins in either case.
if (process.env.NODE_ENV !== 'production') process.env.NODE_ENV = 'development';
process.env.PORT     ||= process.env.NODE_ENV === 'production' ? '1844' : '5172';
process.env.BASE_URL ||= `http://localhost:${process.env.PORT}`;

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
// See atelier.js for the same logic. PWD is bash's logical cwd (works for
// shared/symlinked atelier/); HOST_DIR is the prod fallback (launchd doesn't
// set PWD; atelier/ is a real dir there).
const ROOT = path.resolve(process.env.PWD || HOST_DIR, '..');
const PORT = parseInt(process.env.PORT, 10);
const BASE_URL = process.env.BASE_URL;
const ENV = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
const IS_DEV = ENV === 'dev';

const [, , requestedId] = process.argv;
const MODE = requestedId ? 'standalone' : 'host';

// Hoisted up here (out of the WS section below) because module mounting
// happens at `await mountPendingBackends()` further down, and a module's
// mountRoutes can spawn child processes whose stdout/stderr stream events
// fire async handlers that call ctx.broadcast → wsBroadcastFromModule → wsClients.
// If wsClients is still in TDZ when one of those handlers fires (typical
// in prod where ATELIER_AGENTS=on spawns a child immediately), the throw
// is uncaught and crashes the server. Declaring it before mounting puts
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

// Workspace lives off-URL (cookie-less). Modules register bare paths like
// `/api/<id>/foo`; the router resolves which mounted instance handles a
// given request by reading the request's workspace tag (Referer / ?ws= /
// X-Atelier-Workspace header) and consulting an `allowedQids` set built
// per-request — workspace module first, root fallthrough next.
//
// Each registered route carries a `qualifiedId` (null for shell-owned
// routes that always match). At dispatch time, routes whose qualifiedId
// is in `allowedQids` (or is null) compete for the match.
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

  function add(method, pathPattern, handler, qualifiedId = null) {
    const { re, paramNames } = compile(pathPattern);
    const entry = { method, re, paramNames, handler, qualifiedId };
    routes.push(entry);
    return entry;
  }

  function remove(entry) {
    const i = routes.indexOf(entry);
    if (i >= 0) routes.splice(i, 1);
  }

  async function handle(req, res, { allowedQids = null } = {}) {
    const url = new URL(req.url, `http://localhost`);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      if (r.qualifiedId !== null && allowedQids && !allowedQids.has(r.qualifiedId)) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = {};
      r.paramNames.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      req.params = params;
      // Strip shell-reserved query params before module handlers see them.
      // `ws` is the workspace selector — it lives only on req.workspace,
      // never as a module-visible query, so a module's own `?ws=archived`
      // semantics (if a not-so-careful author chose that key) can't be
      // reinterpreted as a workspace switch.
      const queryEntries = [...url.searchParams.entries()].filter(([k]) => k !== 'ws');
      req.query = Object.fromEntries(queryEntries);
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
// Workspace resolution — workspace is an ambient session attribute,
// propagated via four channels in a fixed precedence order so no single
// channel breaking silently misroutes a request:
//
//   1. ?ws= on the request URL          — per-tab override, authoritative
//                                          when present
//   2. ?ws= from Referer                 — module-issued fetches inherit
//                                          the page's workspace through
//                                          the browser's Referer header
//   3. X-Atelier-Workspace header        — explicit (MC agent proxy)
//   4. atelier_ws cookie                 — durable backstop. Set by the
//                                          shell on every index serve;
//                                          covers the cold-load gap, the
//                                          1→2 transition window, workers,
//                                          and anything that strips Referer
//   5. exactly-one-workspace default     — if filesystem has one $<ws>/,
//                                          that's the implicit context
//   6. null                              — global / root
//
// Modules are workspace-blind: they call `router.get('/api/<id>/foo', …)`
// and `fetch('/api/<id>/foo')`. The shell decides per-request which
// mounted instance answers (workspace shadows root via allowedQids).
// ------------------------------------------------------------------------

// Workspaces discovered straight from the filesystem — independent of
// which modules happen to be mounted. An empty `$<name>/` directory is
// still a workspace; a name filtered out of `atelier.config.json` can't
// make its workspace disappear.
function listAllWorkspaces() {
  const set = new Set();
  let names;
  try { names = fs.readdirSync(ROOT); } catch { return []; }
  for (const name of names) {
    if (!isWorkspaceDir(name)) continue;
    const ws = workspaceName(name);
    if (!ws || RESERVED_NAMES.has(ws)) continue;
    set.add(ws);
  }
  return [...set].sort();
}

function readWsFromReferer(refererHeader) {
  if (!refererHeader) return null;
  try {
    const u = new URL(refererHeader);
    const v = u.searchParams.get('ws');
    return v ? v.trim() || null : null;
  } catch { return null; }
}

const COOKIE_NAME = 'atelier_ws';

function parseCookies(req) {
  const raw = req.headers.cookie;
  if (!raw || typeof raw !== 'string') return {};
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); }
    catch { out[k] = v; }
  }
  return out;
}

function readWsFromCookie(req) {
  const c = parseCookies(req)[COOKIE_NAME];
  return c && c.trim() ? c.trim() : null;
}

function resolveWorkspaceFromRequest(req) {
  // 1. URL ?ws= (per-tab override)
  try {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    const q = u.searchParams.get('ws');
    if (q && q.trim()) return q.trim();
  } catch {}
  // 2. Referer ?ws= (module-issued fetch inheriting page workspace)
  const fromRef = readWsFromReferer(req.headers.referer);
  if (fromRef) return fromRef;
  // 3. X-Atelier-Workspace header (agent proxy, explicit callers)
  const hdr = req.headers['x-atelier-workspace'];
  if (typeof hdr === 'string' && hdr.trim()) return hdr.trim();
  // 4. atelier_ws cookie (durable backstop)
  const fromCookie = readWsFromCookie(req);
  if (fromCookie) return fromCookie;
  // 5. exactly-one-workspace default
  const all = listAllWorkspaces();
  if (all.length === 1) return all[0];
  // 6. null
  return null;
}

// Build a Set-Cookie value for the resolved workspace. Long Max-Age so
// the cookie survives across browser restarts and quietly bridges the
// 1→2 workspace transition for any open tab. HttpOnly so a buggy module
// can't shadow it from page JS; SameSite=Lax keeps it on top-level
// navigations without bleeding to cross-site contexts.
function buildWsCookie(ws) {
  if (!ws) {
    // Clear: empty value with Max-Age=0.
    return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
  }
  const v = encodeURIComponent(ws);
  return `${COOKIE_NAME}=${v}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`;
}

// For a given workspace context, return the set of qualifiedIds whose
// routes are eligible to match. Rule: each module id resolves to its
// workspace mount when one exists for the active workspace, otherwise to
// the root mount. So `$bigcorp/<id>` shadows root `<id>` for bigcorp
// requests, but a request that names no workspace (or whose workspace
// has no shadow) falls through to root.
function buildAllowedQids(ws) {
  const allowed = new Set();
  const byId = new Map();
  for (const m of getModules()) {
    if (!byId.has(m.id)) byId.set(m.id, []);
    byId.get(m.id).push(m);
  }
  for (const [, mods] of byId) {
    if (ws) {
      const wsm = mods.find((m) => m.workspace === ws);
      if (wsm) { allowed.add(wsm.qualifiedId); continue; }
    }
    const rootm = mods.find((m) => !m.workspace);
    if (rootm) allowed.add(rootm.qualifiedId);
  }
  return allowed;
}

// ------------------------------------------------------------------------
// Module discovery — lazy, re-runs on each call
// ------------------------------------------------------------------------

// Discovery rules (RESERVED_NAMES, isSpecialDir, isWorkspaceDir) are imported
// from atelier.js so the runner and the install CLI agree on what counts as
// a module and what counts as a workspace.
//
// A module is a directory with frontend.jsx or backend.js. Modules can live:
//   • at the root  → global, addressed at /<id>, /api/<id>/…
//   • inside $<ws>/ → workspace-scoped. Addressed via the flat module URL
//                     /<id> with workspace held as ?ws=<ws> session context.
//                     Backend routes are the bare `/api/<id>/…` shared with
//                     the root mount; the shell picks which mount answers
//                     per-request (see buildAllowedQids).
//
// Each entry carries:
//   id          dirname (what modules use as ctx.id)
//   workspace   workspace name (e.g. 'bigcorp') or null for global
//   qualifiedId 'kanban' for global, 'bigcorp/kanban' for workspace — the
//               key used internally for mounts, watchers, slots, WS topics

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
    qualifiedId: workspace ? `${workspace}/${name}` : name,
  };
}

function discoverModules() {
  const out = [];
  let names;
  try { names = fs.readdirSync(ROOT); } catch { return out; }
  for (const name of names) {
    // Workspaces: $<ws>/ recurses one level for modules.
    if (isWorkspaceDir(name)) {
      const ws = workspaceName(name);
      if (!ws || RESERVED_NAMES.has(ws)) continue;
      const wsDir = path.join(ROOT, name);
      let subnames;
      try { subnames = fs.readdirSync(wsDir); } catch { continue; }
      for (const sub of subnames) {
        const m = readModuleAt(path.join(wsDir, sub), sub, ws);
        if (m) out.push(m);
      }
      continue;
    }
    // Global module at root.
    const m = readModuleAt(path.join(ROOT, name), name, null);
    if (m) out.push(m);
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
    // so a module excluded for this env can still be inspected. Match by
    // qualifiedId first ('bigcorp/kanban'); fall back to id ('kanban') so
    // the unambiguous case still works without typing the workspace.
    const only = mods.find((m) => m.qualifiedId === requestedId)
              || mods.find((m) => m.id === requestedId && !m.workspace);
    return only ? [only] : [];
  }
  const cfg = loadModuleConfig(ROOT);
  return applyModuleFilter(mods, cfg[ENV], {
    // Config filter operates on qualifiedId so a workspace module can be
    // listed as 'bigcorp/kanban'. A bare 'kanban' in the list matches the
    // global module; workspace ones must be named explicitly.
    getId: (m) => m.qualifiedId,
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
  const stub = new Proxy({}, { get: () => () => null });
  globalThis.React = stub;
  globalThis.ReactDOM = stub;
  globalThis.window = stub;
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
  const cached = readmeCache.get(m.qualifiedId);
  if (cached && cached.mtimeMs === mtimeMs) return cached.frontmatter;
  let text;
  try { text = fs.readFileSync(src, 'utf8'); }
  catch { return {}; }
  const frontmatter = extractFrontmatter(text);
  readmeCache.set(m.qualifiedId, { frontmatter, mtimeMs });
  return frontmatter;
}

function checkRequires() {
  const mods = getModules();
  // requires can name either a global module ('mission-control') or a
  // workspace one ('bigcorp/kanban'). The set holds qualified ids; bare
  // ids match the global module of that name.
  const idSet = new Set(mods.map((x) => x.qualifiedId));
  for (const m of mods) {
    const fm = getModuleReadme(m);
    const requires = fm.atelier?.requires;
    if (!Array.isArray(requires)) continue;
    for (const req of requires) {
      if (typeof req !== 'string') continue;
      if (idSet.has(req)) continue;
      const pair = `${m.qualifiedId}→${req}`;
      if (warnedRequires.has(pair)) continue;
      warnedRequires.add(pair);
      console.warn(`  ! ${m.qualifiedId} requires '${req}' (declared in README.md frontmatter) but it isn't installed`);
    }
  }
}

// Validate standalone target exists at boot (fail fast if typo).
if (MODE === 'standalone') {
  const all = discoverModules();
  const ok = all.find((m) => m.qualifiedId === requestedId)
          || all.find((m) => m.id === requestedId && !m.workspace);
  if (!ok) {
    console.error(`\n  Module '${requestedId}' not found.`);
    if (all.length) console.error(`  Available: ${all.map((m) => m.qualifiedId).join(', ')}\n`);
    else console.error(`  No modules discovered in ${ROOT}.\n`);
    process.exit(1);
  }
}

console.log(`\n  Atelier · ${MODE}`);
for (const m of getModules()) {
  console.log(`    • ${m.qualifiedId}${m.hasBackend ? '' : ' (frontend-only)'}`);
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
//
// Slots are keyed by (callerWorkspace, id). Root modules and
// $alpha-modules can't leak state through a shared slot — each workspace
// is a tenancy boundary. A workspace-aware infrastructure module that
// genuinely wants to look across workspaces uses persisted records (with
// a workspace column) instead of the slot primitive.
const moduleSlots = (globalThis.__atelierModuleSlots ??= new Map());
function slotKey(callerWorkspace, id) {
  return `${callerWorkspace || ''} ${id}`;
}
function getModuleSlot(callerWorkspace, id) {
  const key = slotKey(callerWorkspace, id);
  if (!moduleSlots.has(key)) moduleSlots.set(key, {});
  return moduleSlots.get(key);
}

function makeCtx(m) {
  return {
    id: m.id,                      // dirname — what modules build paths from
    name: m.id,
    workspace: m.workspace,        // 'bigcorp' for $bigcorp/<mod>, null for global
    env: ENV,
    port: PORT,
    baseUrl: BASE_URL,
    dataDir: path.join(m.dir, 'data'),
    log: (...args) => console.log(`[${m.qualifiedId}]`, ...args),
    // Broadcast a real-time event to every browser tab connected to the
    // shared WebSocket. The topic is the module's qualified id — bare
    // 'kanban' for global, 'bigcorp/kanban' for $bigcorp's kanban — so
    // the shell stays out of authorship questions and same-named modules
    // in different scopes can't cross-broadcast.
    broadcast: (event) => wsBroadcastFromModule(m.qualifiedId, event || {}),
    // In-process slot lookup. Returns the SAME plain object for any
    // caller within the SAME workspace — that's the shared bit. The
    // workspace is the caller's mount workspace (`m.workspace`), so
    // root modules share root slots, $alpha modules share $alpha slots,
    // and they can't cross. See moduleSlots above for the contract.
    module: (id) => getModuleSlot(m.workspace, id),
  };
}

function makeModuleScope(m) {
  const mine = [];
  // No path rewriting. Modules register `/api/<id>/foo` literally. The
  // shell tags each route with the module's qualifiedId so the dispatcher
  // can choose between a workspace mount and a root mount per-request
  // (see buildAllowedQids).
  const qid = m.qualifiedId;
  return {
    get:    (p, h) => { mine.push(router._add('GET',    p, h, qid)); },
    post:   (p, h) => { mine.push(router._add('POST',   p, h, qid)); },
    put:    (p, h) => { mine.push(router._add('PUT',    p, h, qid)); },
    delete: (p, h) => { mine.push(router._add('DELETE', p, h, qid)); },
    patch:  (p, h) => { mine.push(router._add('PATCH',  p, h, qid)); },
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

async function mountBackend(m) {
  watchBackend(m);  // always watch so a broken file can be fixed-and-reloaded
  let plug;
  try { plug = await importBackend(m); }
  catch (err) {
    console.error(`  ! Failed to mount ${m.qualifiedId}: ${err.message}`);
    return;
  }
  if (mountPlug(m, plug)) console.log(`  + mounted ${m.qualifiedId} backend`);
}

async function reloadBackend(m) {
  let plug;
  try { plug = await importBackend(m); }
  catch (err) {
    console.error(`  ! ${m.qualifiedId}: reload failed, keeping current version — ${err.message}`);
    return;
  }
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
  if (backendWatchers.has(m.qualifiedId)) return;
  // Watch the module dir (not just backend.js) so transitive file edits
  // — parser.js, helpers.js, whatever backend.js imports — trigger a
  // reload too. Dir-level watching via chokidar survives atomic saves
  // (rename-over changes inode), which the previous `fs.watch(file)`
  // did not — first edit worked, subsequent ones silently died.
  //
  // `awaitWriteFinish` waits for the file size to settle before firing,
  // so a mid-write read can't hit a half-flushed bundle.
  //
  // Ignore: node_modules, the module's own data/, dotfiles, and any path
  // segment starting with `_` (workspaces have _inbox/_generations/_agents
  // data dirs that aren't modules and shouldn't trigger reloads).
  try {
    const w = chokidar.watch(m.dir, {
      ignored: [/node_modules/, /(^|[\/\\])data[\/\\]/, /(^|[\/\\])\./, /(^|[\/\\])_/],
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
        unmountBackend(m.qualifiedId, 'source removed').catch((err) =>
          console.warn(`  ! unmount ${m.qualifiedId}: ${err.message}`));
      }
    };
    w.on('unlinkDir', onGone).on('unlink', onGone);
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
    let mtime = 0;
    try { mtime = fs.statSync(path.join(m.dir, 'backend.js')).mtimeMs; } catch {}
    if (mtime && mtime === lastReloadMtime.get(m.qualifiedId)) return;
    lastReloadMtime.set(m.qualifiedId, mtime);
    reloadBackend(m).catch((err) => console.error(`  ! reload ${m.qualifiedId}: ${err.message}`));
  }, 150));
}

async function mountPendingBackends() {
  const live = getModules();
  const liveIds = new Set(live.map((m) => m.qualifiedId));
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
    if (attemptedBackends.has(m.qualifiedId)) continue;
    attemptedBackends.add(m.qualifiedId);
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

// Map a content type for a non-JSX/CSS module asset. Conservative list —
// anything else is served as octet-stream.
const RAW_CONTENT_TYPES = {
  '.js':    'application/javascript; charset=utf-8',
  '.mjs':   'application/javascript; charset=utf-8',
  '.json':  'application/json; charset=utf-8',
  '.svg':   'image/svg+xml',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.gif':   'image/gif',
  '.webp':  'image/webp',
  '.ico':   'image/x-icon',
  '.txt':   'text/plain; charset=utf-8',
  '.md':    'text/markdown; charset=utf-8',
  '.wasm':  'application/wasm',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
};

function resolveAssetSource(pathname, ws) {
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
  // /modules/<id>/<...rest> — workspace-aware dir-keyed asset routing.
  //
  // The shell resolves the module to its workspace mount (shadow → root
  // fallthrough), then serves any file under that module's directory.
  // Multi-file modules can `import './helper.js'`; helpers, images,
  // JSON, etc. all live alongside frontend.jsx and ship together.
  //
  // For .js requests, .jsx source wins (JSX builder) if it exists — so
  // `frontend.js` and `import './foo.js'` both resolve to their `.jsx`
  // when one is there, otherwise to the literal `.js` file.
  //
  // Cache-Control: no-store at the response level so two workspaces
  // don't share a cache entry for the same URL.
  m = /^\/modules\/([^/]+)\/(.+)$/.exec(pathname);
  if (m) {
    const id = m[1];
    const rest = m[2];
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
    //                  rules used by isSpecialDir in atelier.js.
    //   • node_modules — module deps; shouldn't be reached this way.
    for (const seg of segs) {
      if (seg === 'backend.js') return null;
      if (seg === 'data') return null;
      if (seg === 'node_modules') return null;
      if (/^[._-]/.test(seg)) return null;
    }

    const all = getModules();
    let mod = null;
    if (ws) mod = all.find((x) => x.id === id && x.workspace === ws);
    if (!mod) mod = all.find((x) => x.id === id && !x.workspace);
    if (!mod) return null;

    const absRoot = path.resolve(mod.dir);
    const abs = path.resolve(absRoot, relPath);
    // Final containment check — anything outside the module's dir is denied.
    if (!abs.startsWith(absRoot + path.sep) && abs !== absRoot) return null;

    // CSS request → .css source if it exists (tailwind/oxide build).
    if (abs.endsWith('.css')) {
      return fs.existsSync(abs) ? { kind: 'css', src: abs } : null;
    }

    // JS request → prefer JSX source if a sibling .jsx exists.
    if (abs.endsWith('.js')) {
      const jsxCandidate = abs.slice(0, -3) + '.jsx';
      if (fs.existsSync(jsxCandidate)) return { kind: 'jsx', src: jsxCandidate };
      if (fs.existsSync(abs)) return { kind: 'jsx', src: abs };  // raw .js — esbuild handles plain JS fine
      return null;
    }

    // .jsx URL — direct match (some imports may be explicit).
    if (abs.endsWith('.jsx') && fs.existsSync(abs)) {
      return { kind: 'jsx', src: abs };
    }

    // Other file types — serve raw with a content-type guess.
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      const ext = path.extname(abs).toLowerCase();
      return { kind: 'raw', src: abs, contentType: RAW_CONTENT_TYPES[ext] || 'application/octet-stream' };
    }
    return null;
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
// Authentication contract — see atelier/AUTH.md.
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
  // Global modules, alphabetical by qualifiedId (== id for global). First
  // mounted module exporting `authenticate` claims the slot.
  for (const m of getModules()) {
    if (m.workspace) continue;
    if (!m.hasBackend) continue;
    const plug = authPlugs.get(m.qualifiedId);
    if (plug && typeof plug.authenticate === 'function') {
      return { m, plug };
    }
  }
  return null;
}

function buildDefaultUser({ metaByQId } = {}) {
  // Synthesized from raw discovery. Has full access to every discovered
  // module/workspace. Authmodule receives this as `defaultUser` and can
  // pass-through, filter, replace, or null. Without an auth module the
  // shell uses it directly (today's dev mode).
  //
  // Workspaces are enumerated from the filesystem (listAllWorkspaces),
  // not from mounted modules — empty workspaces still appear in the
  // picker so the user can see them, and a workspace whose modules are
  // all filtered by atelier.config.json doesn't silently vanish.
  const mods = getModules().filter((m) => m.hasFrontend);
  const globalMods = [];
  const wsMap = new Map();              // ws → [{ id, meta? }]
  // Seed every filesystem workspace with an empty module list so empty
  // ones survive the projection.
  for (const ws of listAllWorkspaces()) wsMap.set(ws, []);
  for (const m of mods) {
    const entry = { id: m.id };
    if (metaByQId) entry.meta = metaByQId.get(m.qualifiedId) || {};
    if (m.workspace) {
      if (!wsMap.has(m.workspace)) wsMap.set(m.workspace, []);
      wsMap.get(m.workspace).push(entry);
    } else {
      globalMods.push(entry);
    }
  }
  const workspaces = [...wsMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, modules]) => ({ id, modules }));
  return { id: 'local', name: 'local', modules: globalMods, workspaces };
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

async function serveIndex(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Auth runs FIRST. A logged-out visitor must NEVER see workspace info
  // leak via a 302 Location header or a Set-Cookie for atelier_ws. The
  // unauth handler owns the response entirely and renders its takeover.
  const template = fs.readFileSync(path.join(HOST_DIR, 'index.html'), 'utf8');
  const allFront = getModules().filter((m) => m.hasFrontend);
  const metas = await Promise.all(allFront.map((m) => getModuleMeta(m)));
  const metaByQId = new Map(allFront.map((m, i) => [m.qualifiedId, metas[i]]));

  const defaultUser = buildDefaultUser({ metaByQId });
  const user = await authenticateRequest(req, res, defaultUser);
  if (!user) return;                    // unauth handler took over the response

  // Canonicalize AFTER auth. The redirect target is scoped to the
  // workspaces THIS user is allowed to see — so a non-admin can't be
  // redirected to a workspace they don't belong in, and a user with
  // a single allowed workspace keeps a bare URL (their personal 1-ws mode).
  const userWs = (user.workspaces || []).map((w) => w.id);
  if (userWs.length >= 2 && !url.searchParams.get('ws')) {
    const preferred = readWsFromCookie(req) || null;
    const target = preferred && userWs.includes(preferred) ? preferred : userWs[0];
    const dest = `${url.pathname}?ws=${encodeURIComponent(target)}${url.hash || ''}`;
    res.writeHead(302, {
      Location: dest,
      'Set-Cookie': buildWsCookie(target),
      'Cache-Control': 'no-store',
    });
    res.end();
    return;
  }

  // req.workspace was set at request entry. Pass it to the client so the
  // UI doesn't have to re-derive — server is the single source of truth
  // for workspace resolution.
  const resolvedWs = req.workspace || null;

  const bootstrap = {
    mode: MODE,
    env: ENV,
    user,
    workspace: resolvedWs,
    // Legacy field — current client.jsx still reads boot.modules. Phase 6
    // updates the client to read user.modules + user.workspaces and this
    // line goes away.
    modules: (user.modules || []).map((m) => ({ ...m, hasFrontend: true, name: m.id })),
  };
  const html = template.replace(
    '/*__ATELIER_BOOTSTRAP__*/',
    `window.__ATELIER__ = ${JSON.stringify(bootstrap)};`
  );
  // Refresh the workspace cookie on every index serve so it's always the
  // most recently-resolved value. Lasts a year; updated on every visit.
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Set-Cookie': buildWsCookie(resolvedWs),
  });
  res.end(html);
}

// ------------------------------------------------------------------------
// WebSocket multiplex — shell-owned shared transport for real-time events.
//
// Workspace-aware fan-out. Each connection is tagged with the workspace
// it was opened from (?ws= on the upgrade URL). When a module broadcasts:
//
//   • workspace module (qid = '<ws>/<id>') → only clients tagged with the
//     same workspace receive.
//   • root module (qid = '<id>')           → clients whose effective <id>
//     is the root mount receive: untagged clients always, workspace-tagged
//     clients only if their workspace has no shadowing `$<ws>/<id>`.
//   • shell broadcasts (topic = 'shell')   → every client.
//
// The frame's `topic` is the bare module id (not the qualified id), so a
// frontend just does `__atelier.subscribe('<id>', …)` — the shell handles
// which workspace's events that subscription actually receives.
//
// Wire protocol: each frame is JSON `{ topic, ...event }`. Topic 'shell'
// carries shell events (hot reload, etc).
// ------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });
// wsClients is declared near the top of the file (hoisted) so module
// mounting can safely call ctx.broadcast before this section runs.

// Broadcast from a module mount. `qid` is the module's qualifiedId — the
// shell parses it to derive (workspace, bareId) and filters clients.
//
// Spread order: shell-owned fields come LAST so a module that accidentally
// (or maliciously) names an event field `topic` can't override the routing
// key. Same defensive ordering everywhere the shell merges module data
// into a structure it owns.
function wsBroadcastFromModule(qid, event) {
  if (wsClients.size === 0) return;
  const slash = qid.indexOf('/');
  const eventWs = slash >= 0 ? qid.slice(0, slash) : null;
  const bareId  = slash >= 0 ? qid.slice(slash + 1) : qid;
  const frame = JSON.stringify({ ...event, topic: bareId });
  for (const ws of wsClients) {
    if (ws.readyState !== 1 /* OPEN */) continue;
    if (!clientReceivesModuleEvent(ws, eventWs, bareId)) continue;
    try { ws.send(frame); } catch { /* drop */ }
  }
}

// Shell-level broadcasts (hot reload, etc) reach every client regardless
// of workspace tag — the on-disk state changed, everyone re-syncs.
function wsBroadcastShell(event) {
  if (wsClients.size === 0) return;
  const frame = JSON.stringify({ ...event, topic: 'shell' });
  for (const ws of wsClients) {
    if (ws.readyState !== 1) continue;
    try { ws.send(frame); } catch { /* drop */ }
  }
}

function clientReceivesModuleEvent(ws, eventWs, bareId) {
  if (eventWs) return ws.workspace === eventWs;
  // Root module event. Untagged clients always see it; workspace clients
  // see it iff their workspace doesn't shadow this module.
  if (!ws.workspace) return true;
  return !mountedBackends.has(`${ws.workspace}/${bareId}`);
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
    for (const id of dirtyIds) wsBroadcastShell({ type: 'reload', moduleId: id });
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

fs.watch(ROOT, { recursive: true }, (event, filename) => {
  if (!filename) return;
  const segs = filename.split(path.sep);
  if (segs.some(watchSkipSeg)) return;
  // backend.js hot-swaps server-side via chokidar — never nudge the browser.
  if (segs[segs.length - 1] === 'backend.js') return;

  // Resolve the qualified id of the (possibly affected) module.
  //   global:    <mod>/...        → qualifiedId = '<mod>'
  //   workspace: $<ws>/<mod>/...  → qualifiedId = '<ws>/<mod>'
  let qualifiedId = null;
  if (segs.length >= 1 && isWorkspaceDir(segs[0])) {
    if (segs.length >= 2) {
      qualifiedId = `${workspaceName(segs[0])}/${segs[1]}`;
    }
    // bare $<ws> (workspace creation) — fall through to shell reload.
  } else if (segs.length > 1) {
    qualifiedId = segs[0];
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
  broadcastReload(qualifiedId);
});

// Shared asset response — used by both shell-asset (public) and module-asset
// (auth-gated) paths. Resolves source via resolveAssetSource and writes the
// appropriate compiled or raw response.
async function serveAsset(req, res, url, reqWs) {
  const asset = resolveAssetSource(url.pathname, reqWs);
  if (!asset) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  try {
    const headers = {};
    let body;
    if (asset.kind === 'jsx') {
      const built = await getJsx(asset.src);
      headers['Content-Type'] = built.contentType;
      body = built.content;
    } else if (asset.kind === 'css') {
      const built = await getCss(asset.src, cssScanSources(), HOST_DIR);
      headers['Content-Type'] = built.contentType;
      body = built.content;
    } else {
      headers['Content-Type'] = asset.contentType;
      body = fs.readFileSync(asset.src);
    }
    // Module assets vary by workspace; bypass caching so two workspaces
    // don't share an entry for the same URL. Shell assets stay cacheable.
    if (url.pathname.startsWith('/modules/')) {
      headers['Cache-Control'] = 'no-store';
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

  // Resolve workspace context once per request. Available to assets, SPA,
  // and API alike. `req.workspace` is exposed for module handlers.
  await mountPendingBackends();
  const reqWs = resolveWorkspaceFromRequest(req);
  req.workspace = reqWs;

  if (url.pathname === '/' || url.pathname === '/index.html') {
    await serveIndex(req, res);
    return;
  }

  // Shell assets (`/assets/*`) are ALWAYS public — the takeover login page
  // itself loads /assets/client.js and /assets/styles.css before any auth
  // cookie exists. These are first-party shell bytes; no module-installation
  // disclosure happens here.
  if (url.pathname.startsWith('/assets/')) {
    await serveAsset(req, res, url, reqWs);
    return;
  }

  // Everything below — module assets and API — is auth-gated. Auth-gating
  // `/modules/*` closes a module-enumeration disclosure: without this, an
  // unauthenticated visitor could probe `/modules/<guess>/frontend.js` and
  // distinguish 200 (installed) from 404 (not), learning what's on the
  // server. The auth module's `authenticate()` whitelists its own bundle
  // path (e.g. `/modules/auth/...`) by returning a synthetic guest user
  // for those paths — same pattern it uses for `/api/auth/login`.
  const apiUser = await authenticateRequest(req, res, buildDefaultUser());
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
      workspace: reqWs,
      anonymous: !!apiUser.anonymous,
    }));
    return;
  }

  // Module assets — workspace-aware, dir-keyed, served only to authed users.
  if (url.pathname.startsWith('/modules/')) {
    await serveAsset(req, res, url, reqWs);
    return;
  }

  // API — router dispatch with workspace-resolved qids.
  const allowedQids = buildAllowedQids(reqWs);
  if (await router.handle(req, res, { allowedQids })) return;

  // SPA fallback. URLs are flat — `/` (empty) or `/<id>` (module). Workspace
  // lives off-URL as `?ws=<x>` query param when 2+ workspaces exist; that's
  // a query, not a path segment, so single-segment match covers it.
  if (req.method === 'GET' && /^\/[a-z0-9-]+\/?$/.test(url.pathname)) {
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
  const user = await gateRequest(req, buildDefaultUser());
  if (!user) {
    try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); } catch {}
    socket.destroy();
    return;
  }

  // Tag the connection with its workspace so wsBroadcastFromModule can
  // filter fan-out. Resolution uses the same order as HTTP requests, but
  // the upgrade URL's `?ws=` is the primary signal — the client always
  // appends it (see client.jsx).
  const connWs = resolveWorkspaceFromRequest(req);
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.user = user;
    ws.workspace = connWs;
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
