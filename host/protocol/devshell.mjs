// host/protocol/devshell.mjs — the local-mode shell inside the host (DESIGN §4.3
// "protocol/devshell.mjs", §6.5 "Dev shell", §3 rows /run/atelier/dev; PLAN §4.3 "Dev shell",
// §2 "dev shell", OR8 byte-identical view, OR12 no cookie / token on every request).
//
// Two listeners, one handler: the Unix socket `$ATELIER_RUN/dev/shell.sock` (dir 0710 root:1000
// from the launcher; the socket is chowned 0:1000 and chmodded 0660 after bind — the agent's
// uid-1000 tree connects, worker uids get EACCES) and `127.0.0.1:1844` for the agent's headless
// browser. EVERY request needs the dev token (auth.devRequest: header, `?token=`, or the
// `?token=` of a same-origin referer); the document is no exception — 401 `{}` otherwise.
// Identity = the chat's principal (registrar.principal); the act-as headers work only beside
// the token.
//
// What it serves — the 1.x document, verbatim assets, and the SAME bytes the protocol port
// serves for `/modules/<company>/<slug>/*` and `/api/<company>/<slug>/*` (supervisor.asset /
// supervisor.handle, DESIGN §8.1 same-bytes):
//   /                          index.html with window.__ATELIER__ (1.x bootstrap shape), the
//                              import map (`@atelier/kit` → the chrome's kit.js when it has one),
//                              ONE render-blocking <link>: the app's sheet on /<company>/<slug>…,
//                              the chrome's sheet on app-less documents
//   /assets/react.js, react-dom.js   the UMDs from node_modules (production builds when NODE_ENV=production)
//   /assets/client.js          ../../client.jsx transformed (classic runtime, es2020) — pinned by mtime
//   /assets/chrome-resolve.js  ../../chrome-resolve.js as is
//   /modules/global/<chrome>/{frontend.js,kit.js}   esbuild bundle of the chrome folder with react*
//                              aliased to ../../shims/*, minified in production
//   /modules/global/<chrome>/styles.css   `chromeSheet()` when wired (supervisor/tailwind.mjs), else
//                              the chrome's styles.css passed through
//   /_atelier/whoami, /_atelier/apps, /_atelier/events?app=<instance> (collector.recent),
//   /_atelier/report (POST), /_host/healthz, /_atelier/ws (frames from worker broadcasts stamped
//   topic = company/slug; `shell` frames for reload and backend-error; `shell` is reserved)
// gzip when accepted (text bodies ≥ 1 KiB).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { transform as esbuildTransform, build as esbuildBuild } from 'esbuild'
import { PROTOCOL } from '../../protocol/index.js'
import { json, parseMount, safeRel, readJson, serveAssetResult, appsView, findInstance, frontendReportHandler } from './server.mjs'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const DEFAULT_DEV_PORT = 1844
export const GZIP_MIN = 1024
export const RESERVED_PREFIXES = ['/api/', '/assets/', '/modules/', '/_atelier/', '/_host/']
const JS = 'application/javascript; charset=utf-8', CSS = 'text/css; charset=utf-8', HTML = 'text/html; charset=utf-8'

function maxMtimeRecursive(rootDir) {
  let m = 0
  const skip = new Set(['node_modules', 'data'])
  const walk = (dir) => {
    let names; try { names = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of names) {
      if (ent.name.startsWith('.') || skip.has(ent.name)) continue
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(p); else { try { m = Math.max(m, fs.statSync(p).mtimeMs) } catch {} }
    }
  }
  walk(rootDir)
  return m
}

/**
 * createDevShell({ cfg, os, supervisor, collector, registrar, auth, principal, log, frontendReport,
 *                  chromeSheet, repoRoot, sockPath, devPort, devHost })
 *   chromeSheet: () => Promise<{body:Buffer, type}> — the chrome's compiled sheet (supervisor lane); absent = pass-through
 */
export function createDevShell({ cfg = {}, os, supervisor, collector, registrar, auth, principal, log = () => {}, frontendReport, chromeSheet, repoRoot = REPO_ROOT, sockPath, devPort, devHost = '127.0.0.1' }) {
  const report = frontendReport ?? frontendReportHandler({ collector })
  const startedAt = Date.now()
  const prod = (cfg.nodeEnv ?? process.env.NODE_ENV ?? 'production') === 'production'
  const chromeDir = cfg.chromeDir ? path.resolve(cfg.chromeDir) : null
  const chromeId = chromeDir ? path.basename(chromeDir) : null
  const chromeQid = chromeId ? `global/${chromeId}` : null
  const sock = sockPath ?? (cfg.run ? path.join(cfg.run, 'dev', 'shell.sock') : null)
  const port = devPort === undefined ? (cfg.devPort ?? DEFAULT_DEV_PORT) : devPort   // null/false = socket only
  const hostRequire = createRequire(path.join(repoRoot, 'package.json'))
  const company = () => registrar.company ?? cfg.company ?? 'local'
  const who = () => principal ?? registrar.principal ?? { id: 'local', name: 'local' }
  const cache = new Map()
  let template = null

  const exists = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
  const chromeHas = (name) => !!chromeDir && exists(path.join(chromeDir, name))

  // ---- assets
  async function clientJs() {
    const src = path.join(repoRoot, 'client.jsx')
    const mtime = fs.statSync(src).mtimeMs
    const hit = cache.get(src)
    if (hit && hit.mtime === mtime) return hit
    const r = await esbuildTransform(fs.readFileSync(src, 'utf8'), { loader: 'jsx', format: 'esm', jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', target: 'es2020', sourcefile: src, minify: false })
    const e = { mtime, body: Buffer.from(r.code), type: JS }
    cache.set(src, e)
    return e
  }
  async function chromeBundle(entry) {
    const src = ['jsx', 'js'].map((x) => path.join(chromeDir, `${entry}.${x}`)).find(exists)
    if (!src) return null
    const mtime = maxMtimeRecursive(chromeDir)
    const key = `${src}::bundle::${prod}`
    const hit = cache.get(key)
    if (hit && hit.mtime === mtime) return hit
    const shim = (n) => path.join(repoRoot, 'shims', n)
    const r = await esbuildBuild({
      entryPoints: [src], absWorkingDir: chromeDir, bundle: true, format: 'esm', platform: 'browser', write: false,
      minify: prod, sourcemap: prod ? false : 'inline', target: ['es2020'],
      loader: { '.jsx': 'jsx', '.js': 'jsx', '.svg': 'dataurl', '.png': 'dataurl' }, jsx: 'automatic',
      define: { 'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development'), 'process.env': '{}' },
      plugins: [{ name: 'atelier-no-css-import', setup(b) { b.onLoad({ filter: /\.css$/ }, (a) => ({ errors: [{ text: `CSS imports aren't bundled in atelier — put chrome styles in styles.css, not an import of "${path.basename(a.path)}"` }] })) } }],
      alias: { react: shim('react.js'), 'react-dom': shim('react-dom.js'), 'react/jsx-runtime': shim('jsx-runtime.js'), 'react/jsx-dev-runtime': shim('jsx-runtime.js') },
      logLevel: 'silent',
    })
    const e = { mtime, body: Buffer.from(r.outputFiles[0].text), type: JS }
    cache.set(key, e)
    return e
  }
  function vendor(name) {
    const [pkg, rel] = name === 'react' ? ['react', prod ? 'umd/react.production.min.js' : 'umd/react.development.js'] : ['react-dom', prod ? 'umd/react-dom.production.min.js' : 'umd/react-dom.development.js']
    const p = path.join(path.dirname(hostRequire.resolve(`${pkg}/package.json`)), rel)
    return exists(p) ? { body: fs.readFileSync(p), type: JS } : null
  }

  // ---- the document (1.x serveIndex shape, DESIGN §6.5)
  function requestedSlug(pathname) {
    const m = /^\/([^/]+)\/([^/]+)/.exec(pathname)
    return m && decodeURIComponent(m[1]) === company() ? decodeURIComponent(m[2]) : null
  }
  function document(pathname, user) {
    template ??= fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8')
    const c = company()
    const rows = supervisor.apps().filter((r) => r.company === c)
    const modules = rows.map((r) => ({ id: r.slug, meta: registrar.apps?.().get(r.instance)?.meta ?? {} }))
    const bootstrap = {
      mode: 'host', label: null, observe: false,
      user: { id: user.id, name: user.name, workspaces: [{ id: c, modules }] },
      workspace: c, workspaces: [c],
      chromeQid, defaultChromeQid: chromeQid, chromes: chromeQid ? [chromeQid] : [],
      backendErrors: [],
    }
    const importMap = chromeQid && (chromeHas('kit.js') || chromeHas('kit.jsx')) ? { imports: { '@atelier/kit': `/modules/${chromeQid}/kit.js` } } : null
    const slug = requestedSlug(pathname)
    const app = slug ? rows.find((r) => r.slug === slug) : null
    let link = ''
    if (app) link = `<link id="atelier-chrome-styles" rel="stylesheet" href="/modules/${c}/${app.slug}/styles.css">`
    else if (chromeQid && chromeHas('styles.css')) link = `<link id="atelier-chrome-styles" rel="stylesheet" href="/modules/${chromeQid}/styles.css">`
    return template
      .replace('/*__ATELIER_BOOTSTRAP__*/', `window.__ATELIER__ = ${JSON.stringify(bootstrap)};`)
      .replace('<!--__ATELIER_IMPORTMAP__-->', importMap ? `<script type="importmap">${JSON.stringify(importMap)}</script>` : '')
      .replace('<!--__ATELIER_CHROME_STYLES__-->', link)
  }

  // ---- responses
  const gzipOk = (req) => /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
  const textual = (type) => /^(text\/|application\/(javascript|json|xml))/.test(type)
  const encoder = (req) => (gzipOk(req) ? (body, type) => (textual(type) && body.length >= GZIP_MIN ? { body: zlib.gzipSync(body), headers: { 'content-encoding': 'gzip', vary: 'accept-encoding' } } : null) : null)
  function send(req, res, status, body, type, extra = {}) {
    const headers = { 'content-type': type, 'cache-control': 'no-cache', ...extra }
    let buf = Buffer.isBuffer(body) ? body : Buffer.from(body)
    const enc = encoder(req)?.(buf, type)
    if (enc) { buf = enc.body; Object.assign(headers, enc.headers) }
    headers['content-length'] = buf.length
    res.writeHead(status, headers)
    res.end(req.method === 'HEAD' ? undefined : buf)
  }

  async function handle(req, res) {
    let url
    try { url = new URL(req.url, 'http://dev') } catch { return json(res, 400, {}) }
    const a = auth.devRequest(req)
    if (!a.ok) { log(`dev: 401 ${a.reason} ${req.method} ${url.pathname}`); return json(res, 401, {}) }
    const user = a.user, p = url.pathname
    if (p === '/_atelier/whoami') return json(res, 200, { id: user.id, name: user.name, anonymous: false })
    if (p === '/_atelier/apps') return json(res, 200, appsView(supervisor))
    if (p === '/_host/healthz') return json(res, 200, { api: PROTOCOL, hostId: registrar.hostId, epoch: registrar.epoch, uptime: Math.round((Date.now() - startedAt) / 1000), apps: supervisor.apps().length })
    if (p === '/_atelier/events') {
      const row = findInstance(supervisor, url.searchParams.get('app'))
      if (!row) return json(res, 404, {})
      return json(res, 200, collector.recent(row.instance))
    }
    if (p === '/_atelier/report' && req.method === 'POST') {
      let body
      try { body = await readJson(req) } catch (e) { return json(res, e.status ?? 400, {}) }
      const row = findInstance(supervisor, body?.instance)
      if (!row) return json(res, 404, {})
      const r = report(body, { instance: row.instance })
      return r.ok ? json(res, 200, { ok: true }) : json(res, 400, { ok: false, reason: r.reason })
    }
    if (p === '/assets/react.js' || p === '/assets/react-dom.js') { const v = vendor(p === '/assets/react.js' ? 'react' : 'react-dom'); return v ? send(req, res, 200, v.body, v.type) : json(res, 404, {}) }
    if (p === '/assets/client.js') { const e = await clientJs(); return send(req, res, 200, e.body, e.type, { etag: `"${e.mtime}"` }) }
    if (p === '/assets/chrome-resolve.js') return send(req, res, 200, fs.readFileSync(path.join(repoRoot, 'chrome-resolve.js')), JS)
    if (p.startsWith('/assets/')) return json(res, 404, {})
    const chromeAsset = chromeQid && /^\/modules\/global\/([^/]+)\/([^/]+)$/.exec(p)
    if (chromeAsset && chromeAsset[1] === chromeId) {
      const [, , file] = chromeAsset
      if (file === 'frontend.js' || file === 'kit.js') { const e = await chromeBundle(file.replace(/\.js$/, '')); return e ? send(req, res, 200, e.body, e.type, { etag: `"${e.mtime}"` }) : json(res, 404, {}) }
      if (file === 'styles.css') {
        if (chromeSheet) { const s = await chromeSheet(); return send(req, res, 200, s.body, s.type ?? CSS) }
        return chromeHas('styles.css') ? send(req, res, 200, fs.readFileSync(path.join(chromeDir, 'styles.css')), CSS) : json(res, 404, {})
      }
      return json(res, 404, {})
    }
    const mount = parseMount(p)
    if (mount) {
      const row = supervisor.resolve(mount.company, mount.slug)
      if (!row) return json(res, 404, {})
      if (mount.kind === 'api') { registrar.served?.(row.instance); return supervisor.handle(row, req, res, user) }
      const rel = safeRel(mount.rel)
      if (!rel) return json(res, 404, {})
      const revQ = url.searchParams.get('rev')
      const asset = await supervisor.asset(row, rel, { rev: revQ !== null && /^\d+$/.test(revQ) ? Number(revQ) : undefined })
      if (!asset) return json(res, 404, {})
      return serveAssetResult(req, res, asset, { encode: encoder(req) })
    }
    if (RESERVED_PREFIXES.some((x) => p.startsWith(x))) return json(res, 404, {})
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, {})
    return send(req, res, 200, document(p, user), HTML, { 'cache-control': 'no-store' })
  }

  // ---- WS multiplex (1.x wire: JSON frames {topic, ...event}; every client gets every frame,
  // the client's per-topic map routes — one company per computer, one principal per dev shell)
  const wss = new WebSocketServer({ noServer: true })
  const clients = new Set()
  wss.on('connection', (ws) => { clients.add(ws); ws.on('close', () => clients.delete(ws)); ws.on('error', () => clients.delete(ws)) })
  const fanout = (frame) => { const s = JSON.stringify(frame); for (const ws of clients) if (ws.readyState === 1) { try { ws.send(s) } catch {} } }
  function onUpgrade(req, socket, head) {
    let pathname; try { pathname = new URL(req.url, 'http://dev').pathname } catch { return socket.destroy() }
    if (pathname !== '/_atelier/ws') return socket.destroy()
    if (!auth.devRequest(req).ok) { try { socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n') } catch {} return socket.destroy() }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  }
  const qidOf = (instance) => { const r = findInstance(supervisor, instance); return r ? `${r.company}/${r.slug}` : null }

  const onRequest = (req, res) => { handle(req, res).catch((e) => { log(`dev: 500 ${req.method} ${req.url}: ${e?.stack ?? e}`); if (!res.headersSent) json(res, 500, {}); else res.destroy() }) }
  const servers = []
  const mk = () => { const s = http.createServer(onRequest); s.on('upgrade', onUpgrade); servers.push(s); return s }
  const listenOne = (s, ...args) => new Promise((resolve, reject) => { s.once('error', reject); s.listen(...args, () => { s.off('error', reject); resolve(s.address()) }) })

  const close = () => Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()) }))).then(() => { for (const ws of clients) { try { ws.terminate() } catch {} } })
  return {
    async listen() {
      const out = {}
      try {
        if (sock) {
          try { fs.unlinkSync(sock) } catch {}
          out.sock = await listenOne(mk(), sock)
          os.chown(sock, 0, 1000); os.chmod(sock, 0o660)     // 0:1000 0660 — agent connects, workers EACCES (no-op under unprivileged())
        }
        if (port !== null && port !== false) out.port = (await listenOne(mk(), port, devHost)).port
      } catch (e) { await close(); throw e }
      log(`dev: listening ${sock ?? '-'} ${devHost}:${out.port ?? '-'}${auth.hasDevToken ? '' : ' (NO DEV TOKEN — every request is 401)'}`)
      return out
    },
    close,
    // worker {t:'broadcast'} → the app's topic (company/slug); the shell owns `topic`, last wins
    broadcast(instance, event) { const qid = qidOf(instance); if (qid) fanout({ ...event, topic: qid }) },
    // a swap → the 1.x reload frame (the client re-imports the bundle and re-points the sheet)
    invalidate(instance, { cssOnly = false } = {}) { const r = findInstance(supervisor, instance); if (r) fanout({ type: 'reload', moduleId: r.slug, cssOnly, topic: 'shell' }) },
    backendError(instance, message) { const qid = qidOf(instance); if (qid) fanout({ type: 'backend-error', qid, message, topic: 'shell' }) },
    clients, document, chromeQid,
  }
}
