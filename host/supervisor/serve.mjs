// host/supervisor/serve.mjs — the supervisor's request side (DESIGN §4.1 `handle`/`asset`, §4.3, §10.3 D3/D9/D10).
// `protocol/server.mjs` and `protocol/devshell.mjs` are two callers of the same two functions —
// the same-bytes property (§8.1) — each naming its SLOT: the protocol port serves `prod` (the
// company's :1845 road), the dev shell serves `dev` (Bayard's). A request captures ONE revision:
// `handle` reads `slot.live` once ({rev, sock}) and proxies to that socket; `asset` serves the
// slot's CURRENT rev's stored bytes (or a kept older rev when `rev` is given) — never the folder
// for js/css; static files (images, json) come from the slot's app dir (the agent's tree for dev,
// the export for prod) through the host's app-group read.
//
// The prod gate (D9): while `slot.gate` is set a request waits ≤ GATE_HOLD_MS for the release, then
// answers the shell's exact waking bytes (503 `{"waking":true}`, `retry-after: 2`, `x-atelier-waking: 1`,
// `cache-control: no-store` — the client already shows its fallback; protocol-samebytes pins them to
// shell/proxy.mjs). A slot left `down` by a failed deploy (D10) answers 503 `{error, backup}` — no
// waking flag, no automatic rollback — until a green deploy or a restore.
import path from 'node:path'
import { MESSAGES } from './deploy.mjs'

export const JS_TYPE = 'application/javascript; charset=utf-8'
export const CSS_TYPE = 'text/css; charset=utf-8'
const TYPES = { html: 'text/html; charset=utf-8', json: 'application/json; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', css: CSS_TYPE, js: JS_TYPE, mjs: JS_TYPE, woff: 'font/woff', woff2: 'font/woff2', wasm: 'application/wasm', map: 'application/json; charset=utf-8' }
export const contentType = (name) => TYPES[path.extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream'

export const GATE_HOLD_MS = 10_000
export const WAKING_STATUS = 503
export const WAKING_BODY = JSON.stringify({ waking: true })
export const WAKING_HEADERS = Object.freeze({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '2', 'x-atelier-waking': '1' })
/** The one waking answer (byte-equal to the shell's DIAL/TIMEOUT answer). */
export function waking(res) {
  res.writeHead(WAKING_STATUS, { ...WAKING_HEADERS, 'content-length': Buffer.byteLength(WAKING_BODY) })
  res.end(WAKING_BODY)
}

// safeRel(rel) → segments | null — 1.x resolveAssetSource's rules: decoded, no NUL, not absolute,
// no `..`, and no `backend.js` / `data` / `node_modules` / `[._-]`-prefixed segment at any depth.
export function safeRel(rel) {
  let s
  try { s = decodeURIComponent(String(rel)) } catch { return null }
  if (!s || s.includes('\0') || s.startsWith('/')) return null
  const segs = s.split('/').filter((x) => x !== '')
  if (!segs.length) return null
  for (const seg of segs) {
    if (seg === '..' || seg === '.' || seg === 'backend.js' || seg === 'data' || seg === 'node_modules') return null
    if (/^[._-]/.test(seg)) return null
  }
  return segs
}

/**
 * createServe({row, store, proxy, resume, awaitBuild, readStatic, served, keptRev, timing})
 *   row(instance) → the internal row; proxy = worker/proxy.mjs proxyRequest; resume(row, slot) → live|null
 *   awaitBuild(row) → the in-flight dev build (dev requests are held during a load with no live worker)
 *   readStatic(row, slot, name) → Buffer|null; served(instance) → registrar.served (prod only); keptRev(row, slot, rev) → bool
 */
// mountRelative(url, row) → the path the worker's router sees: `/api/<company>/<slug>` stripped
// (DESIGN §4.3: req.url reaches the supervisor untouched; the mount is derivable from the row).
export const mountOf = (row) => `/api/${row.company}/${row.slug}`
export function mountRelative(url, row) {
  const mount = mountOf(row)
  if (url === mount || url.startsWith(mount + '/') || url.startsWith(mount + '?')) {
    const rest = url.slice(mount.length)
    return rest.startsWith('/') ? rest : '/' + rest
  }
  return url
}

// awaitGate(slot, holdMs) → true when the gate released inside the hold, false past it
export function awaitGate(slot, holdMs) {
  const gate = slot.gate
  if (!gate) return Promise.resolve(true)
  return new Promise((resolve) => {
    let done = false
    const t = setTimeout(() => { if (!done) { done = true; resolve(false) } }, holdMs)
    t.unref?.()
    gate.then(() => { if (!done) { done = true; clearTimeout(t); resolve(true) } }, () => { if (!done) { done = true; clearTimeout(t); resolve(true) } })
  })
}

export function createServe({ row: rowOf, store, proxy, resume, awaitBuild = async () => {}, readStatic, served = () => {}, keptRev, timing = {} }) {
  const json = (res, status, body) => { if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)) }
  const holdMs = timing.gateHoldMs ?? GATE_HOLD_MS

  async function handle(appRow, req, res, user, { slot: name = 'prod' } = {}) {
    const row = rowOf(appRow.instance)
    if (!row || !row.linked) return json(res, 404, { error: 'not found' })
    const slot = row[name]
    if (!slot) return json(res, 404, MESSAGES.body.notDeployed)
    if (slot.gate && !(await awaitGate(slot, holdMs))) { req.resume(); return waking(res) }
    if (slot.state === 'down') return json(res, 503, MESSAGES.body.down(slot.down?.backup ?? null))
    let live = slot.live
    if (!live && name === 'dev' && row.installing) { await row.installing; live = slot.live }     // a two-phase install: the freeze SIGKILLs the worker uid — no resume into it
    if (!live && name === 'dev' && row.building) { await awaitBuild(row); live = slot.live }
    if (!live && slot.rev != null) live = await resume(row, slot)
    if (!live) return json(res, 503, { error: 'app not ready' })
    if (!live.sock) return json(res, 404, { error: 'this app has no backend' })
    if (name === 'prod') served(row.instance)
    slot.inflight++
    slot.lastServedAt = Date.now()
    try {
      return await proxy({ sock: live.sock, req, res, user, path: mountRelative(req.url, row), mount: mountOf(row), bodyCap: timing.bodyCap, timeoutMs: timing.proxyTimeoutMs })
    } finally {
      slot.inflight--
      slot.lastServedAt = Date.now()
      row.armIdle?.(slot)
    }
  }

  async function asset(appRow, rel, { rev, slot: name = 'prod' } = {}) {
    const row = rowOf(appRow.instance)
    if (!row || !row.linked) return null
    const slot = row[name]
    if (!slot) return null
    const segs = safeRel(rel)
    if (!segs) return null
    const r = rev ?? slot.rev
    if (r == null) return null
    if (rev != null && !keptRev(row, slot, rev)) return null
    const fname = segs.join('/')
    if (fname === 'styles.css') { const body = store.read(row.instance, r, 'styles.css'); return body ? { body, type: CSS_TYPE, rev: r } : null }
    if (fname.endsWith('.js')) { const body = store.read(row.instance, r, path.join('frontend', fname)); return body ? { body, type: JS_TYPE, rev: r } : null }
    const body = readStatic(row, slot, fname)
    return body ? { body, type: contentType(fname), rev: r } : null
  }

  return { handle, asset }
}
