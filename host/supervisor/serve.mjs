// host/supervisor/serve.mjs — the supervisor's request side (DESIGN §4.1 `handle`/`asset`, §4.3).
// `protocol/server.mjs` and `protocol/devshell.mjs` are two callers of the same two functions —
// the same-bytes property (§8.1). A request captures ONE revision: `handle` reads `row.live`
// once ({rev, sock}) and proxies to that socket; `asset` serves the CURRENT rev's stored bytes
// (or a kept older rev when `rev` is given) — never the folder for js/css; static files (images,
// json) come from the app folder through the host's app-group read.
import path from 'node:path'

export const JS_TYPE = 'application/javascript; charset=utf-8'
export const CSS_TYPE = 'text/css; charset=utf-8'
const TYPES = { html: 'text/html; charset=utf-8', json: 'application/json; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', css: CSS_TYPE, js: JS_TYPE, mjs: JS_TYPE, woff: 'font/woff', woff2: 'font/woff2', wasm: 'application/wasm', map: 'application/json; charset=utf-8' }
export const contentType = (name) => TYPES[path.extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream'

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
 *   row(instance) → the internal row; proxy = worker/proxy.mjs proxyRequest; resume(row) → live|null
 *   awaitBuild(row) → the in-flight build (requests are held during a load with no live worker)
 *   readStatic(row, name) → Buffer|null; served(instance) → registrar.served; keptRev(row, rev) → bool
 */
// mountRelative(url, row) → the path the worker's router sees: `/api/<company>/<slug>` stripped
// (DESIGN §4.3: req.url reaches the supervisor untouched; the mount is derivable from the row).
export function mountRelative(url, row) {
  const mount = `/api/${row.company}/${row.slug}`
  if (url === mount || url.startsWith(mount + '/') || url.startsWith(mount + '?')) {
    const rest = url.slice(mount.length)
    return rest.startsWith('/') ? rest : '/' + rest
  }
  return url
}

export function createServe({ row: rowOf, store, proxy, resume, awaitBuild = async () => {}, readStatic, served = () => {}, keptRev, timing = {} }) {
  const json = (res, status, body) => { if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)) }

  async function handle(appRow, req, res, user) {
    const row = rowOf(appRow.instance)
    if (!row || row.state === 'unclaimed') return json(res, 404, { error: 'not found' })
    let live = row.live
    if (!live && row.building) { await awaitBuild(row); live = row.live }
    if (!live && row.rev != null) live = await resume(row)
    if (!live) return json(res, 503, { error: 'app not ready' })
    if (!live.sock) return json(res, 404, { error: 'this app has no backend' })
    served(row.instance)
    row.inflight++
    row.lastServedAt = Date.now()
    try {
      return await proxy({ sock: live.sock, req, res, user, path: mountRelative(req.url, row), bodyCap: timing.bodyCap, timeoutMs: timing.proxyTimeoutMs })
    } finally {
      row.inflight--
      row.lastServedAt = Date.now()
      row.armIdle?.()
    }
  }

  async function asset(appRow, rel, { rev } = {}) {
    const row = rowOf(appRow.instance)
    if (!row || row.state === 'unclaimed') return null
    const segs = safeRel(rel)
    if (!segs) return null
    const r = rev ?? row.rev
    if (r == null) return null
    if (rev != null && !keptRev(row, rev)) return null
    const name = segs.join('/')
    if (name === 'styles.css') { const body = store.read(row.instance, r, 'styles.css'); return body ? { body, type: CSS_TYPE, rev: r } : null }
    if (name.endsWith('.js')) { const body = store.read(row.instance, r, path.join('frontend', name)); return body ? { body, type: JS_TYPE, rev: r } : null }
    const body = readStatic(row, name)
    return body ? { body, type: contentType(name), rev: r } : null
  }

  return { handle, asset }
}
