// Shared harness for supervisor-swap / supervisor-idle: a real, minimal worker runtime speaking the
// DESIGN §4.1 control lane (NDJSON on fd 3, READY / load-failed / suspendable / http5xx), a
// test-local `spawnWorker` over `unprivileged().spawn`, a test-local `proxyRequest` over the
// Unix socket, a fake registrar and a recording report. The worker lane's real spawn/runtime/proxy
// replace these three in the integrator's wiring; the supervisor only sees the §4.1 interfaces.
// (No tests of its own — node --test loads it as a module with 0 tests.)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { unprivileged } from '../adapters/os.mjs'
import { createSupervisor } from '../supervisor/index.mjs'

export const RUNTIME_SRC = `
import http from 'node:http'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
const spec = JSON.parse(process.env.ATELIER_WORKER)
const ctl = (o) => { try { fs.writeSync(3, JSON.stringify(o) + '\\n') } catch {} }
process.chdir(spec.appDir)
let mod
try { mod = await import(pathToFileURL(spec.codeDir + '/backend.js').href) }
catch (e) { ctl({ t: 'load-failed', code: e.code === 'ERR_MODULE_NOT_FOUND' ? 'ERR_MODULE_NOT_FOUND' : 'LOAD-ERROR', message: e.message, file: 'backend.js' }); process.exit(1) }
const routes = []
const on = (m) => (p, h) => routes.push([m, p, h])
const router = { get: on('GET'), post: on('POST'), put: on('PUT'), delete: on('DELETE'), all: on('*') }
const ctx = Object.freeze({ id: spec.slug, workspace: spec.company, qualifiedId: spec.company + '/' + spec.slug, dataDir: spec.dataDir, baseUrl: spec.baseUrl, rev: spec.rev, log: () => {}, broadcast: (event) => ctl({ t: 'broadcast', event }), suspendable: () => ctl({ t: 'suspendable' }), module: () => ({}) })
let teardown
try { teardown = await mod.default.mountRoutes(router, ctx) } catch (e) { ctl({ t: 'load-failed', code: 'MOUNT-ERROR', message: e.message, file: 'backend.js' }); process.exit(1) }
const resources = {}
for (const r of process.getActiveResourcesInfo()) if (r !== 'PipeWrap') resources[r] = (resources[r] || 0) + 1   // stdio pipes + the IPC server excluded
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const r = routes.find(([m, p]) => (m === '*' || m === req.method) && p === url.pathname)
  const rs = { json: (d, s = 200) => { res.writeHead(s, { 'content-type': 'application/json', 'x-rev': String(spec.rev) }); res.end(JSON.stringify(d)) } }
  if (!r) return rs.json({ error: 'no route' }, 404)
  try { await r[2]({ method: req.method, url: req.url, headers: req.headers, query: Object.fromEntries(url.searchParams), user: req.headers['x-atelier-user'] ?? null }, rs) }
  catch (e) { ctl({ t: 'http5xx', method: req.method, path: url.pathname, status: 500, message: e.message }); rs.json({ error: e.message }, 500) }
})
server.listen(spec.sock, () => ctl({ t: 'ready', mountMs: 0, importMs: 0, resources, teardown: typeof teardown === 'function' }))
process.on('SIGTERM', async () => { server.close(); try { await teardown?.() } catch {} process.exit(0) })
process.on('uncaughtException', (e) => ctl({ t: 'error', kind: 'backend', message: e.message, stack: e.stack }))
`

export function writeRuntime(dir) {
  const p = path.join(dir, 'runtime.mjs')
  fs.writeFileSync(p, RUNTIME_SRC)
  return p
}

// spawnWorker per DESIGN §4.1: → {pid, sock, kill, stop}; rejects {error:'no-ready'|'spawn-eagain'|'load-failed', msg}
export function makeSpawn(runtimePath) {
  return function spawnWorker({ os: osx, spec, onControl, onExit, readyTimeoutMs = 8000 }) {
    return new Promise((resolve, reject) => {
      fs.mkdirSync(spec.sockDir, { recursive: true })
      try { fs.rmSync(spec.sock, { force: true }) } catch {}
      const child = osx.spawn({
        argv: [process.execPath, '--no-warnings', runtimePath],
        env: { PATH: process.env.PATH, NODE_ENV: 'test', APP_ID: spec.instance, HOME: spec.tmpDir, HOST: '127.0.0.1', PORT: '1844', BASE_URL: spec.baseUrl, ATELIER_WORKER: JSON.stringify(spec), ...spec.configEnv },
        cwd: '/', umask: 0o002, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      })
      let buf = '', settled = false, failed = null, exited = false
      const handle = {
        pid: child.pid, sock: spec.sock,
        kill: (sig = 'SIGTERM') => { try { child.kill(sig) } catch {} },
        stop: (drainMs = 2000) => new Promise((r) => {
          if (exited) return r()
          try { child.kill('SIGTERM') } catch { return r() }
          const t = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, drainMs)
          child.once('exit', () => { clearTimeout(t); r() })
        }),
      }
      child.stdio[3].on('data', (d) => {
        buf += d
        const lines = buf.split('\n'); buf = lines.pop()
        for (const l of lines) {
          if (!l.trim()) continue
          let msg; try { msg = JSON.parse(l) } catch { continue }
          onControl(msg)
          if (msg.t === 'ready' && !settled) { settled = true; clearTimeout(timer); resolve(handle) }
          if (msg.t === 'load-failed') failed = msg
        }
      })
      child.stderr.on('data', () => {})
      child.on('exit', (code, signal) => {
        exited = true
        if (!settled) { settled = true; clearTimeout(timer); reject({ error: failed ? 'load-failed' : code === 134 ? 'spawn-eagain' : 'no-ready', msg: failed?.message ?? `exit ${code ?? signal} before READY` }) }
        onExit(code, signal)
      })
      const timer = setTimeout(() => { if (!settled) { settled = true; try { child.kill('SIGKILL') } catch {}; reject({ error: 'no-ready', msg: `no READY within ${readyTimeoutMs} ms` }) } }, readyTimeoutMs)
    })
  }
}

// proxyRequest per DESIGN §4.1 (minimal): streams both ways, sets x-atelier-user, 502 on ECONNREFUSED/ENOENT
export function proxyRequest({ sock, req, res, user }) {
  return new Promise((resolve) => {
    const headers = { ...req.headers }
    delete headers.host; delete headers.authorization; delete headers.cookie
    for (const k of Object.keys(headers)) if (k.startsWith('x-atelier-')) delete headers[k]
    if (user) { headers['x-atelier-user'] = user.id; headers['x-atelier-name'] = user.name ?? '' }
    const p = http.request({ socketPath: sock, path: req.url, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers)
      r.pipe(res)
      r.on('end', () => resolve({ status: r.statusCode }))
    })
    p.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'worker unavailable' })); resolve({ status: 502 }) })
    req.pipe(p)
  })
}

// A world: work/apps + .atelier under a short tmp root (macOS socket path cap), a fake registrar, a recording report.
export function world({ chromeDir = null, timing = {}, gitCommit = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'sup-')))
  const work = path.join(root, 'work'), run = path.join(root, 'run')
  fs.mkdirSync(path.join(work, 'apps'), { recursive: true })
  fs.mkdirSync(path.join(work, '.atelier', 'last-good'), { recursive: true })
  fs.mkdirSync(run, { recursive: true })
  const runtime = writeRuntime(root)
  const groups = []   // every os.setgroups() call (the §6.2 app-group rule: [uid] around folder reads, [] after)
  const osx = { ...unprivileged(), setgroups: (g) => { groups.push([...g]); return { skipped: true } } }
  const dirfd = osx.openDir(path.join(work, '.atelier'))
  const reports = [], lines = [], swaps = []
  let nextUid = 20001, nextInst = 1
  const claims = new Map()   // slug → {instance, uid}
  const registrar = {
    company: 'acme', origin: 'http://127.0.0.1:1844', served: () => {}, unlinked: [],
    async claim({ slug }) {
      if (!/^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(slug)) return { refused: { code: 400, error: 'bad-slug' } }
      if (slug === 'taken') return { refused: { code: 409, error: 'claimed by c-2' } }
      let c = claims.get(slug)
      if (!c) { c = { instance: `i-${String(nextInst++).padStart(16, '0')}`, uid: nextUid++ }; claims.set(slug, c); fs.mkdirSync(path.join(work, '.atelier', c.instance), { recursive: true }); fs.writeFileSync(path.join(work, '.atelier', c.instance, 'uid'), String(c.uid)) }
      return { ...c, claimed: true }
    },
    async unlink(inst) { registrar.unlinked.push(inst) },
  }
  const make = (extra = {}) => createSupervisor({
    os: osx, dirfd, cfg: { work, run, chromeDir, gitCommit, company: 'acme' }, log: (l) => lines.push(l),
    report: (kind, instance, rev, detail) => reports.push({ kind, instance, rev, ...detail }),
    registrar, onSwap: (instance, rev) => swaps.push([instance, rev]),
    spawn: makeSpawn(runtime), proxy: proxyRequest, timing: { quiesceMs: 40, swapStopMs: 100, drainMs: 1000, ...timing }, ...extra,
  })
  const app = (slug, files) => { const d = path.join(work, 'apps', slug); fs.mkdirSync(d, { recursive: true }); for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c) } return d }
  const done = async (sup) => { try { await sup?.teardown() } catch {} try { osx.closeFd(dirfd) } catch {} fs.rmSync(root, { recursive: true, force: true }) }
  return { root, work, run, osx, dirfd, registrar, reports, lines, swaps, groups, make, app, done, claims }
}

// A fake http exchange for sup.handle(): returns {status, headers, body}
export function fakeExchange(method, url, { headers = {}, body = null } = {}) {
  const { PassThrough } = requireStream()
  const req = new PassThrough()
  req.method = method; req.url = url; req.headers = { host: 'x', ...headers }
  if (body !== null) req.end(body); else req.end()
  const chunks = []
  const res = new PassThrough()
  const out = { status: null, headers: null, body: null }
  res.writeHead = (s, h) => { out.status = s; out.headers = h ?? {}; res.headersSent = true; return res }
  res.headersSent = false
  const realEnd = res.end.bind(res)
  res.end = (d) => { if (d) chunks.push(Buffer.from(d)); realEnd() }
  res.on('data', (c) => chunks.push(Buffer.from(c)))
  const finished = new Promise((r) => res.on('finish', () => { out.body = Buffer.concat(chunks).toString(); r(out) }))
  return { req, res, finished }
}
import { createRequire } from 'node:module'
const requireStream = () => createRequire(import.meta.url)('node:stream')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const waitFor = async (fn, { ms = 5000, step = 20 } = {}) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('waitFor timeout'); await sleep(step) } }
export const APP_JSON = (name) => JSON.stringify({ name, icon: 'cloud' })
export const BACKEND = (rev) => `export default { mountRoutes(router, ctx) { router.get('/rev', (req, res) => res.json({ rev: ${rev}, ctxRev: ctx.rev, user: req.user })); router.get('/boom', () => { throw new Error('boom ${rev}') }) } }\n`
export const FRONTEND = (rev) => `import { Card } from './card.js'\nexport default function App() { return <div className="p-${rev}">rev ${rev}<Card/></div> }\n`
export const CARD = `export const Card = () => <span className="italic">c</span>\n`
export { os, path, fs }
