// host/worker/runtime.mjs — the process a worker runs (DESIGN §4.1 steps 1–9). One app instance,
// uid 20000+i, loads the last-good bundle with the 1.x backend contract verbatim
// (docs/MODULES.md: `export default { mountRoutes(router, ctx) }` returning an optional teardown)
// and serves it on a Unix socket. Control lane = NDJSON on fd 3, worker → host only.
//
// Importing this module registers nothing; `main()` runs only when the file is the entry point
// and ATELIER_WORKER is set (so tests import `createRouter`, `locate`, `userFromHeaders`).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { format } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const JSON_BODY_CAP = 10 * 1024 * 1024
export const CTL_FD = 3
export const CONFIG_FD = 0
export const CHILD_DRAIN_MS = 1500     // below the host's 2 s drain (spawn.mjs DRAIN_MS): the worker exits on its own before the pgroup SIGKILL
/** MODULES.md "ctx exposes exactly" + `suspendable` (R14). Frozen at mount. */
export const CTX_KEYS = ['id', 'name', 'workspace', 'qualifiedId', 'label', 'port', 'host', 'baseUrl', 'dataDir', 'log', 'broadcast', 'module', 'suspendable']

// ---------------------------------------------------------------------------------------------
// Router — port of design/atelier2/spike-b6/router.js. Every path is relative to the app's mount
// (the supervisor strips `/api/<company>/<slug>`).
//   router.get('/', h)             bare root  — matches ''  and '/'
//   router.get('/items/:id', h)    :param     — one segment, decoded
//   router.get('/s/:id/*', h)      wildcard   — rest of the path in req.params['*'] (matches the bare parent too)
//   router.all('/*', h)            catch-all, any method
//   get/post/put/delete/patch/head/options — every method; HEAD falls back to GET routes.
// First registration wins (register the specific route before the wildcard).
// `onError(err, req, res, status)` is called for every handler throw that became a ≥ 500 response.
export function createRouter({ onError = (err) => console.error(err) } = {}) {
  const routes = []

  function compile(pattern) {
    const names = []
    let p = String(pattern || '/')
    if (!p.startsWith('/')) p = '/' + p
    let src = p
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')                       // escape, but keep ':' and '*'
      .replace(/:([A-Za-z_]\w*)/g, (_, n) => { names.push(n); return '([^/]+)' })
      .replace(/\/\*$/, () => { names.push('*'); return '(?:/(.*))?' })   // trailing wildcard
    if (src === '/') src = ''                                        // bare root: '' or '/'
    return { re: new RegExp('^' + src + '/?$'), names }
  }

  function add(method, pattern, handler) {
    const { re, names } = compile(pattern)
    const entry = { method, re, names, handler }
    routes.push(entry)
    return entry
  }

  function match(method, pathname) {
    for (const r of routes) {
      if (r.method !== 'ALL' && r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue
      const m = r.re.exec(pathname)
      if (!m) continue
      const params = {}
      try {
        r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1] ?? '') })
      } catch { const e = new Error('bad path encoding'); e.statusCode = 400; throw e }
      return { route: r, params }
    }
    return null
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://worker')
    let hit
    try { hit = match(req.method, url.pathname) }
    catch (e) { res.writeHead(e.statusCode || 400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); return true }
    if (!hit) return false
    req.params = hit.params
    req.path = url.pathname
    req.query = Object.fromEntries(url.searchParams.entries())
    let body
    req.json = () => (body ??= readJson(req))                        // memoized (MODULES.md)
    res.json = (data, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    try {
      await hit.route.handler(req, res)
    } catch (err) {
      const status = err.statusCode || 500
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' })
      if (!res.writableEnded) res.end(JSON.stringify({ error: err.message }))
      if (status >= 500) onError(err, req, res, status)
    }
    return true
  }

  const api = { handle, match, _add: add, _remove: (e) => { const i = routes.indexOf(e); if (i >= 0) routes.splice(i, 1) } }
  for (const m of ['get', 'post', 'put', 'delete', 'patch', 'head', 'options']) {
    api[m] = (p, h) => { add(m.toUpperCase(), p, h); return api }
  }
  api.all = (p, h) => { add('ALL', p, h); return api }
  return api
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '', size = 0, over = false
    req.on('data', (c) => {
      if (over) return
      size += c.length
      if (size > JSON_BODY_CAP) { over = true; const e = new Error('body too large'); e.statusCode = 413; reject(e); return }
      body += c
    })
    req.on('end', () => { if (over) return; if (!body) return resolve({}); try { resolve(JSON.parse(body)) } catch (e) { e.statusCode = 400; reject(e) } })
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------------------------
// Helpers the host side shares (pure).

/** `file:line:col` of the first stack frame, for the agent's error line. */
export function locate(err) {
  const stack = String(err?.stack ?? '')
  const m = /(?:\(|at )(?:async )?((?:file:\/\/)?\/[^():\n]+):(\d+):(\d+)\)?/.exec(stack)
  if (!m) return {}
  let file = m[1]
  if (file.startsWith('file://')) { try { file = fileURLToPath(file) } catch {} }
  return { file, line: Number(m[2]), col: Number(m[3]) }
}

/** req.user from the three internal headers the proxy sets (proxy.mjs `userHeaders`); null without them. */
export function userFromHeaders(h) {
  const id = h['x-atelier-user']
  if (!id) return null
  let name = ''
  try { name = decodeURIComponent(String(h['x-atelier-name'] ?? '')) } catch { name = String(h['x-atelier-name'] ?? '') }
  let claims = {}
  try { claims = JSON.parse(String(h['x-atelier-claims'] ?? '{}')) } catch { claims = {} }
  return { id: String(id), name, claims }
}

export function countResources() {
  const c = {}
  for (const r of process.getActiveResourcesInfo()) c[r] = (c[r] || 0) + 1
  return c
}
export function diffResources(after, before) {
  const out = {}
  for (const [k, v] of Object.entries(after)) { const d = v - (before[k] || 0); if (d > 0) out[k] = d }
  return out
}

const errorDetail = (e) => {
  const err = e instanceof Error ? e : new Error(String(e))
  return { message: err.message, stack: err.stack, ...locate(err) }
}

// ---------------------------------------------------------------------------------------------
// The worker.

/** readConfig(fd) → {K:V}: the OR14 config the host wrote to stdin (one JSON document, then EOF); {} when stdin carries nothing. */
export function readConfig(fd = CONFIG_FD) {
  let text = ''
  try { text = fs.readFileSync(fd, 'utf8') } catch { return {} }
  if (!text.trim()) return {}
  try { const j = JSON.parse(text); return j && typeof j.env === 'object' && j.env ? j.env : {} } catch { return {} }
}

export async function main({ spec = JSON.parse(process.env.ATELIER_WORKER), ctlFd = CTL_FD, configFd = CONFIG_FD, drainMs = CHILD_DRAIN_MS } = {}) {
  const send = (msg) => { try { fs.writeSync(ctlFd, JSON.stringify(msg) + '\n') } catch {} }
  const qid = `${spec.company}/${spec.slug}`
  const log = (...a) => process.stderr.write(`[${qid}] ${format(...a)}\n`)
  const t0 = performance.now()
  const baseline = countResources()
  // the spawn wrapper's shell exports its own bookkeeping (and macOS's libSystem injects __CF_USER_TEXT_ENCODING);
  // the module sees row W exactly
  for (const k of ['PWD', 'OLDPWD', 'SHLVL', '_', '__CF_USER_TEXT_ENCODING']) delete process.env[k]
  // the OR14 config: read after the uid drop, before the import — never through the root wrapper chain's env
  for (const [k, v] of Object.entries(readConfig(configFd))) if (!(k in process.env)) process.env[k] = String(v)
  let teardown = null
  let stopping = false
  let inflight = 0

  // 7. the process stays up on async failures; the host hears every one (registered before the import so
  //    import-time async throws are reported, not fatal).
  process.on('uncaughtException', (e) => send({ t: 'error', kind: 'backend', ...errorDetail(e) }))
  process.on('unhandledRejection', (r) => send({ t: 'error', kind: 'backend', ...errorDetail(r) }))

  // 9. SIGTERM → stop accepting (idle keep-alive sockets closed, in-flight responses kept), run the
  //    module's teardown, wait ≤ drainMs for the in-flight responses AND the module's child processes,
  //    then exit. Never a bare exit before teardown (a bare process.exit(0) orphans children —
  //    migration-local-2); never an exit with a response half-sent (the proxy would turn it into a 502).
  let server = null
  process.on('SIGTERM', async () => {
    if (stopping) return
    stopping = true
    const deadline = Date.now() + drainMs
    try { server?.close(); server?.closeIdleConnections?.() } catch {}
    try { await teardown?.() } catch (e) { log(`teardown threw: ${e.message}`) }
    while ((inflight > 0 || (countResources().ProcessWrap ?? 0) > 0) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
    if (inflight > 0) log(`exiting with ${inflight} response(s) still open after ${drainMs} ms`)
    try { server?.closeAllConnections?.() } catch {}
    process.exit(0)
  })

  const loadFailed = (code, e) => { send({ t: 'load-failed', code, ...errorDetail(e) }); process.exit(1) }

  // 1. cwd = the app folder (createRequire and HERE-relative reads resolve there)
  try { process.chdir(spec.appDir) } catch (e) { loadFailed('LOAD-ERROR', e) }

  // 2. import the bundle from the rev dir — never the app folder
  let plug
  try {
    const mod = await import(pathToFileURL(path.join(spec.codeDir, 'backend.js')).href)
    plug = mod.default
    if (typeof plug?.mountRoutes !== 'function') throw new Error('backend.js has no default.mountRoutes export')
  } catch (e) { loadFailed(e.code === 'ERR_MODULE_NOT_FOUND' ? 'ERR_MODULE_NOT_FOUND' : 'LOAD-ERROR', e) }
  const importMs = Math.round(performance.now() - t0)

  // 3. ctx — immutable at mount; exactly MODULES.md's keys + suspendable
  const slots = (globalThis.__atelierModuleSlots ??= new Map())
  let warnedTopic = false
  const name = spec.name ?? spec.slug
  const ctx = Object.freeze({
    id: spec.slug,
    name,
    workspace: spec.company,
    qualifiedId: qid,
    label: name,
    port: Number(process.env.PORT),
    host: process.env.HOST,
    baseUrl: spec.baseUrl,
    dataDir: spec.dataDir,
    log,
    // the host stamps `topic = company/slug`; a module cannot choose its topic (MODULES.md)
    broadcast: (event) => {
      const { topic, ...rest } = event && typeof event === 'object' ? event : {}
      if (topic !== undefined && topic !== qid && !warnedTopic) { warnedTopic = true; log(`broadcast with topic '${topic}' — ignored; the topic is always '${qid}'`) }
      send({ t: 'broadcast', event: rest })
    },
    module: (id) => { const key = `${spec.company}/${id}`; if (!slots.has(key)) slots.set(key, {}); return slots.get(key) },
    suspendable: () => send({ t: 'suspendable' }),
  })

  // 4. router; a handler throw that became a 5xx is reported with the request that triggered it
  const router = createRouter({
    onError: (err, req, res, status) => { res.__atelierReported = true; send({ t: 'http5xx', method: req.method, path: req.path ?? req.url, status, ...errorDetail(err) }) },
  })

  // 5. mount
  const t1 = performance.now()
  try {
    const t = await plug.mountRoutes(router, ctx)
    teardown = typeof t === 'function' ? t : null
  } catch (e) { loadFailed('MOUNT-ERROR', e) }
  const mountMs = Math.round(performance.now() - t1)
  await new Promise((r) => setImmediate(r))
  // 8. what the module holds after mount, beyond this process's own baseline (R14: empty → idle-stop candidate)
  const resources = diffResources(countResources(), baseline)

  // 6. the socket server: health first, then req.user from the internal headers, then the router
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://worker')
    if (url.pathname === '/_atelier/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ rev: spec.rev, uptime: Math.round(performance.now() - t0) }))
    }
    req.user = userFromHeaders(req.headers)
    inflight++
    res.once('close', () => { inflight-- })
    res.on('finish', () => {
      if (res.statusCode >= 500 && !res.__atelierReported) send({ t: 'http5xx', method: req.method, path: url.pathname, status: res.statusCode, message: `response ${res.statusCode}` })
    })
    try {
      if (await router.handle(req, res)) return
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      if (!res.writableEnded) res.end(JSON.stringify({ error: e.message }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found', app: qid, path: url.pathname }))
  })
  try { fs.unlinkSync(spec.sock) } catch {}
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(spec.sock, resolve) })
  } catch (e) { loadFailed('LOAD-ERROR', e) }
  send({ t: 'ready', mountMs, importMs, resources, teardown: !!teardown })
}

if (process.env.ATELIER_WORKER && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { try { fs.writeSync(CTL_FD, JSON.stringify({ t: 'load-failed', code: 'LOAD-ERROR', ...errorDetail(e) }) + '\n') } catch {} ; process.exit(1) })
}
