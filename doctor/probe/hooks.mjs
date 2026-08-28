// doctor/probe/hooks.mjs — the probe's observation hooks (doctor/DESIGN.md §4). Installed in the
// worker process BEFORE host/worker/runtime.mjs loads (entry.mjs imports this file first), so every
// habit the fleet refuses is seen at the module's import and mount:
//
//   process.env            Proxy — every `get`/`has` of a string key            → envRead   (N2/N2op/N3)
//   net.Server#listen      recorded, never bound; 'listening' on the next tick  → listen    (D2)
//   child_process.*        the binary recorded, never run; ENOENT-shaped errors → spawn     (D12)
//   fs writes              outside dataDir/tmpDir/HOME/<probe dir> → EACCES     → writeOutside (N1, D13)
//                          (every path a call writes: rename's source AND destination, the link/symlink/copy destination)
//   fs reads/writes        under <app>/data recorded                            → selfData  (N1)
//   node:sqlite            DatabaseSync(path) is a write at that path           → writeOutside
//   fetch/http/https/net   target recorded (`via`), refused (ENETUNREACH; no network) → egress (N4, N5, I2)
//   process.on('SIG…')     recorded                                             → signal    (N8)
//   process.exit           recorded, then passed through                        → exit      (N8)
//   ctx.module(id)         the runtime's slot map is pre-seeded with a Map that records the id → ctxModule (D3)
//
// Attribution: every hook captures the stack and marks the observation `app` when the first frame
// outside this file / entry.mjs / `node:` internals belongs to the app (the bundle or its deps),
// `runtime` when it is host/worker/runtime.mjs or spawn.mjs, `node` when there is no such frame. Only
// `app` observations are sent; the others are counted in `skipped`. The runtime's own `server.listen(sock)`,
// `unlinkSync(sock)`, `PORT`/`HOST` reads and `process.on('SIGTERM')` are therefore invisible to the rules.
//
// Reporting: one NDJSON line per app observation on fd 3 as {t:'doctor', kind, by:'app', …} (the control
// lane spawn.mjs already parses; unknown `t` reaches onControl), and ONE {t:'doctor', kind:'summary'} at
// process exit with the counts. There is no uid drop on a laptop: the EACCES is this file's emulation of
// the fleet's ownership rules (`jail: 'hook-emulated'` in the report).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import cp from 'node:child_process'
import sqlite from 'node:sqlite'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { KINDS, attributeStack } from './common.mjs'

export const CTL_FD = 3
export const STREAM_CAP = 40          // app observations streamed per kind; the summary carries the full counts

const writeSync = fs.writeSync              // captured before any patch; the lane to the host
const realEnv = process.env                  // the real env object; the Proxy below wraps it
const spec = JSON.parse(realEnv.ATELIER_WORKER)

// ---------------------------------------------------------------------------------------------
// paths

const realpathOr = (p) => { try { return fs.realpathSync.native(p) } catch { return p } }
const both = (p) => (p ? [p, realpathOr(p)] : [])
const APP_ROOTS = both(spec.appDir)
const SELF_DATA = APP_ROOTS.map((a) => path.join(a, 'data'))
// the worker may write here: ctx.dataDir, TMPDIR, HOME (scratch), the probe dir (rev-1/data/tmp/scratch all live in it), the socket dir
const ALLOWED = [...both(spec.dataDir), ...both(spec.tmpDir), ...both(realEnv.HOME), ...both(path.dirname(spec.dataDir)), ...both(path.dirname(spec.sock))]
const under = (p, root) => p === root || p.startsWith(root + path.sep)
const isAllowed = (p) => p === '/dev/null' || ALLOWED.some((r) => under(p, r))
const inSelfData = (p) => SELF_DATA.some((r) => under(p, r))
const inApp = (p) => APP_ROOTS.some((r) => under(p, r))
const norm = (p) => {
  if (p instanceof URL) { try { p = fileURLToPath(p) } catch { return null } }
  if (Buffer.isBuffer(p)) p = p.toString()
  if (typeof p !== 'string') return null      // an fd, a FileHandle, a stream: not a path
  return path.resolve(p)                      // relative paths resolve against the cwd (= appDir after the runtime's chdir), as the real call would
}
const PROBE_ROOTS = both(path.dirname(spec.dataDir))
const short = (p) => {
  const s = String(p)
  for (const a of APP_ROOTS) if (under(s, a)) return '<app>' + s.slice(a.length)
  for (const a of PROBE_ROOTS) if (under(s, a)) return '<probe>' + s.slice(a.length)
  return s.replace(/^\/(Users|home)\/[^/]+/, '~')
}

// ---------------------------------------------------------------------------------------------
// attribution (common.mjs attributeStack) — 30 frames so the app's frame is found below Node's internals

Error.stackTraceLimit = Math.max(Error.stackTraceLimit, 30)
const attribute = (opts) => attributeStack(new Error().stack, opts)

// ---------------------------------------------------------------------------------------------
// the observation store + the lane to the host

const counts = Object.fromEntries(KINDS.map((k) => [k, 0]))
const streamed = Object.fromEntries(KINDS.map((k) => [k, 0]))
const skipped = { runtime: 0, node: 0 }
const envReads = new Map()          // key → n (app-attributed reads)
const seen = new Set()              // `${kind} ${dedupe key}` — one streamed line per distinct observation
const send = (msg) => { try { writeSync(CTL_FD, JSON.stringify(msg) + '\n') } catch {} }

/** record(kind, at, fields, key) — counts every app observation; streams the first STREAM_CAP distinct ones per kind. */
function record(kind, at, fields, key) {
  if (at.by !== 'app') { skipped[at.by]++; return false }
  counts[kind]++
  const k = `${kind} ${key ?? JSON.stringify(fields)}`
  if (seen.has(k) || streamed[kind] >= STREAM_CAP) return true
  seen.add(k); streamed[kind]++
  send({ t: 'doctor', kind, by: 'app', ...fields, frame: at.frame })
  return true
}

let summarySent = false
export function sendSummary(reason) {
  if (summarySent) return
  summarySent = true
  send({ t: 'doctor', kind: 'summary', reason, counts, skipped, envReads: Object.fromEntries(envReads), envSpread, jail: 'hook-emulated' })
}

// ---------------------------------------------------------------------------------------------
// process.env → Proxy over the real env object (writes still land in the real env)

// An enumeration (`{ ...process.env }`, Object.assign, for-in — a child's env being built) reads EVERY
// published key; those gets are not config reads. ownKeys marks the keys about to be copied, the next
// get of each is counted once as one `envSpread`, and the mark expires with the current tick.
let spreadKeys = null
let envSpread = 0                   // app-attributed enumerations of process.env
process.env = new Proxy(realEnv, {
  ownKeys(t) {
    const keys = Reflect.ownKeys(t)
    if (attribute().by === 'app') { spreadKeys = new Set(keys); envSpread++; process.nextTick(() => { spreadKeys = null }) }
    return keys
  },
  get(t, k, r) { if (typeof k === 'string') noteEnv(k); return Reflect.get(t, k, r) },
  has(t, k) { if (typeof k === 'string') noteEnv(k); return Reflect.has(t, k) },
})
function noteEnv(key) {
  if (spreadKeys?.has(key)) { spreadKeys.delete(key); return }
  const at = attribute()
  if (at.by !== 'app') { skipped[at.by]++; return }
  envReads.set(key, (envReads.get(key) ?? 0) + 1)
  record('envRead', at, { key }, key)
}

// ---------------------------------------------------------------------------------------------
// listen: an app's server is recorded and never bound; the runtime's socket server passes through

function listenTarget(args) {
  const a0 = args[0]
  if (a0 && typeof a0 === 'object') return { port: a0.port, host: a0.host, path: a0.path }
  if (typeof a0 === 'string' && !/^\d+$/.test(a0)) return { path: a0 }
  return { port: a0, host: typeof args[1] === 'string' ? args[1] : undefined }
}
{
  const orig = net.Server.prototype.listen
  net.Server.prototype.listen = function listen(...args) {
    const at = attribute()
    if (at.by !== 'app') { skipped[at.by]++; return orig.apply(this, args) }
    const o = listenTarget(args)
    const target = o.path ? `unix:${short(o.path)}` : `${o.host || '*'}:${o.port ?? '?'}`
    record('listen', at, { target }, target)
    const cb = args.find((a) => typeof a === 'function')
    this.address = () => (o.path ? o.path : { address: o.host || '0.0.0.0', port: Number(o.port) || 0, family: 'IPv4' })
    process.nextTick(() => { this.emit('listening'); cb?.() })
    return this
  }
}

// ---------------------------------------------------------------------------------------------
// child_process: the binary is recorded, never run (the image has no laptop binaries — D12)

{
  const fake = (bin) => {
    const c = new EventEmitter()
    c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.stdin = new PassThrough()
    c.pid = 0; c.kill = () => true; c.killed = false; c.exitCode = null; c.unref = () => c; c.ref = () => c
    process.nextTick(() => {
      c.emit('error', Object.assign(new Error(`spawn ${bin} ENOENT (doctor: the image has no ${bin})`), { code: 'ENOENT', errno: -2, syscall: `spawn ${bin}`, path: bin }))
      c.stdout.end(); c.stderr.end(); c.emit('close', -2, null); c.emit('exit', -2, null)
    })
    return c
  }
  const enoent = (bin) => Object.assign(new Error(`spawn ${bin} ENOENT (doctor: the image has no ${bin})`), { code: 'ENOENT', errno: -2, syscall: `spawn ${bin}`, path: bin })
  // the script a node/sh/python spawn runs (its first `.js/.mjs/.cjs/.sh/.py` argument), shortened — a walked
  // file's own habits are judged by the static rules (dashboard/mcp-server.js listens on 4748)
  const scriptOf = (args) => { const a = Array.isArray(args) ? args.find((x) => typeof x === 'string' && /\.(m?js|cjs|sh|py)$/.test(x)) : null; return a ? short(path.resolve(a)) : undefined }
  const rec = (fn, cmd, args) => { const bin = String(cmd).trim().split(/\s+/)[0]; const script = scriptOf(args); record('spawn', attribute(), { bin, fn, ...(script ? { script } : {}) }, bin); return bin }
  cp.spawn = (bin, args) => fake(rec('spawn', bin, args))
  cp.fork = (bin) => fake(rec('fork', bin, [bin]))
  cp.exec = (cmd, o, cb) => { const b = rec('exec', cmd); const f = typeof o === 'function' ? o : cb; if (f) process.nextTick(() => f(Object.assign(new Error(`${b}: not found (doctor: the image has no ${b})`), { code: 127 }), '', '')); return fake(b) }
  cp.execFile = (bin, a, o, cb) => { const b = rec('execFile', bin, a); const f = [a, o, cb].find((x) => typeof x === 'function'); if (f) process.nextTick(() => f(enoent(b), '', '')); return fake(b) }
  cp.execSync = (cmd) => { const b = rec('execSync', cmd); throw Object.assign(new Error(`${b}: not found (doctor: the image has no ${b})`), { status: 127 }) }
  cp.execFileSync = (bin, a) => { const b = rec('execFileSync', bin, a); throw enoent(b) }
  cp.spawnSync = (bin, a) => { const b = rec('spawnSync', bin, a); return { status: null, signal: null, error: enoent(b), stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), pid: 0, output: [] } }
}

// ---------------------------------------------------------------------------------------------
// fs: writes outside the worker's places → EACCES (app frames only); any touch of <app>/data recorded

const O = fs.constants
const isWriteFlag = (f) => {
  if (f == null || typeof f === 'function' || typeof f === 'object') return false          // absent flags = 'r'; a callback/options object in the flag slot = 'r'
  if (typeof f === 'number') return (f & (O.O_WRONLY | O.O_RDWR | O.O_CREAT | O.O_TRUNC | O.O_APPEND)) !== 0
  return /[wa+]/.test(String(f))
}
/** check(p, op, isWrite, wrapper) → an EACCES Error to raise, or null to let the call through. */
function check(p, op, isWrite, wrapper) {
  const r = norm(p)
  if (r == null) return null
  if (inSelfData(r)) { const at = attribute(); record('selfData', at, { op, path: short(r), write: isWrite }, `${op} ${r}`); if (!isWrite) return null; if (at.by !== 'app') return null; return refuse(r, p, op, wrapper, at) }
  if (!isWrite || isAllowed(r)) return null
  const at = attribute()
  if (at.by !== 'app') { skipped[at.by]++; return null }
  return refuse(r, p, op, wrapper, at)
}
function refuse(r, p, op, wrapper, at) {
  record('writeOutside', at, { op, path: short(r), inApp: inApp(r) }, `${op} ${r}`)
  const e = new Error(`EACCES: permission denied (doctor: the worker owns nothing outside ctx.dataDir), ${op.replace(/Sync$/, '')} '${String(p)}'`)
  Object.assign(e, { code: 'EACCES', errno: -13, syscall: op.replace(/Sync$/, ''), path: String(p) })
  if (wrapper) Error.captureStackTrace(e, wrapper)      // the stack starts at the app's call site (the runtime's locate() reads it)
  return e
}
{
  const keep = (w, o) => { for (const k of Object.keys(o)) w[k] = o[k]; return w }     // fs.realpathSync.native, fs.realpath.native stay reachable
  // specs = the path arguments a call touches: [{idx, write}] — every written path is checked (rename unlinks its
  // source AND creates its destination; copy/cp/link read arg 0 and create arg 1; symlink creates arg 1 — its
  // arg 0 is the link's TEXT, not a path); the first refusal wins. flagIdx: the open() flags decide `write`.
  const checkAll = (a, name, specs, flagIdx, w) => {
    for (const { idx, write } of specs) { const e = check(a[idx], name, write && (flagIdx == null || isWriteFlag(a[flagIdx])), w); if (e) return e }
    return null
  }
  const guardSync = (name, specs = W0, flagIdx = null) => {
    const o = fs[name]; if (typeof o !== 'function') return
    const w = function (...a) { const e = checkAll(a, name, specs, flagIdx, w); if (e) throw e; return o.apply(this, a) }
    fs[name] = keep(w, o)
  }
  const guardCb = (name, specs = W0, flagIdx = null) => {
    const o = fs[name]; if (typeof o !== 'function') return
    const w = function (...a) {
      const e = checkAll(a, name, specs, flagIdx, w)
      if (e) { const cb = a.find((x) => typeof x === 'function'); if (cb) { process.nextTick(cb, e); return } throw e }
      return o.apply(this, a)
    }
    fs[name] = keep(w, o)
  }
  const guardP = (name, specs = W0, flagIdx = null) => {
    const o = fsp[name]; if (typeof o !== 'function') return
    const w = function (...a) { const e = checkAll(a, name, specs, flagIdx, w); if (e) return Promise.reject(e); return o.apply(this, a) }
    fsp[name] = keep(w, o)
  }
  const W0 = [{ idx: 0, write: true }], R0 = [{ idx: 0, write: false }]
  const guard = (n, specs, flagIdx) => { guardSync(n + 'Sync', specs, flagIdx); guardCb(n, specs, flagIdx); guardP(n, specs, flagIdx) }
  for (const n of ['writeFile', 'appendFile', 'mkdir', 'rm', 'rmdir', 'unlink', 'truncate', 'mkdtemp', 'chmod', 'chown', 'utimes']) guard(n, W0)
  guard('rename', [{ idx: 0, write: true }, { idx: 1, write: true }])
  for (const n of ['copyFile', 'cp', 'link']) guard(n, [{ idx: 0, write: false }, { idx: 1, write: true }])
  guard('symlink', [{ idx: 1, write: true }])
  guardSync('openSync', W0, 1); guardCb('open', W0, 1); guardP('open', W0, 1)
  for (const n of ['readFile', 'readdir', 'stat', 'lstat', 'access', 'realpath', 'opendir', 'watch']) guard(n, R0)
  guardSync('existsSync', R0); guardSync('watchFile', R0); guardSync('createReadStream', R0)
  const ocws = fs.createWriteStream
  const cws = function createWriteStream(p, o) { const e = check(p, 'createWriteStream', true, cws); if (e) throw e; return ocws.call(this, p, o) }
  fs.createWriteStream = cws
}

// node:sqlite — opening a database file is a write at that path (a `-wal`/`-shm` appear beside it)
{
  const Orig = sqlite.DatabaseSync
  sqlite.DatabaseSync = new Proxy(Orig, {
    construct(t, args, nt) {
      const p = args[0]
      if (typeof p === 'string' && p !== '' && !p.startsWith(':') && !p.startsWith('file:')) { const e = check(p, 'DatabaseSync', !args[1]?.readOnly, null); if (e) throw e }
      return Reflect.construct(t, args, nt)
    },
  })
}

// ---------------------------------------------------------------------------------------------
// egress: recorded, refused — the probe has no network; the fleet's peers are Unix sockets (N5)

const LOOPBACK_RE = /^(?:[a-z]+:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:\/|$)/i
{
  const rec = (via, target) => { const s = String(target).slice(0, 160); record('egress', attribute(), { via, target: s, loopback: LOOPBACK_RE.test(s) }, `${via} ${s}`) }
  const netErr = () => Object.assign(new Error('ENETUNREACH (doctor: no network in the probe)'), { code: 'ENETUNREACH', errno: -51, syscall: 'connect' })
  globalThis.fetch = async function fetch(u) { rec('fetch', u?.url || u); throw Object.assign(new TypeError('fetch failed (doctor: no network in the probe)'), { cause: netErr() }) }
  const deadSocket = () => { const s = new net.Socket(); process.nextTick(() => s.destroy(netErr())); return s }
  for (const m of [http, https]) {
    const proto = m === https ? 'https' : 'http'
    m.request = function request(u, o, cb) {
      const opts = typeof u === 'string' || u instanceof URL ? (o && typeof o === 'object' ? o : {}) : (u ?? {})
      const t = typeof u === 'string' || u instanceof URL ? String(u) : `${proto}://${opts.hostname || opts.host || 'localhost'}${opts.port ? ':' + opts.port : ''}${opts.path || '/'}`
      rec(proto, t)
      if (typeof o === 'function') cb = o
      const req = new http.ClientRequest({ hostname: '127.0.0.1', port: 1, path: '/', method: opts.method || 'GET', agent: false, createConnection: deadSocket })   // agent:false → createConnection is honoured
      if (cb) req.once('response', cb)
      return req
    }
    m.get = function get(u, o, cb) { const r = m.request(u, o, cb); r.end(); return r }
  }
  const oc = net.Socket.prototype.connect
  net.Socket.prototype.connect = function connect(...a) {
    const at = attribute()
    if (at.by !== 'app') { skipped[at.by]++; return oc.apply(this, a) }
    const o = a[0] && typeof a[0] === 'object' ? a[0] : { port: a[0], host: typeof a[1] === 'string' ? a[1] : undefined, path: typeof a[0] === 'string' && !/^\d+$/.test(a[0]) ? a[0] : undefined }
    const t = o.path ? `unix:${short(o.path)}` : `${o.host || 'localhost'}:${o.port}`
    record('egress', at, { via: 'net', target: t, loopback: !o.path && LOOPBACK_RE.test(t) }, `net ${t}`)
    process.nextTick(() => this.destroy(netErr()))
    return this
  }
}

// ---------------------------------------------------------------------------------------------
// process.on('SIG…') / process.exit: recorded; the runtime's own handlers and exits are not

{
  for (const m of ['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']) {
    const orig = process[m].bind(process)
    process[m] = function (ev, fn) { if (/^SIG/.test(String(ev))) record('signal', attribute(), { signal: String(ev) }, String(ev)); return orig(ev, fn) }
  }
  const origExit = process.exit.bind(process)
  process.exit = function exit(code) {
    const at = attribute()
    record('exit', at, { code: code ?? null }, `exit ${code}`)
    sendSummary(at.by === 'app' ? 'process.exit' : 'exit')
    return origExit(code)
  }
  EventEmitter.prototype.on.call(process, 'exit', () => sendSummary('exit'))
}

// ---------------------------------------------------------------------------------------------
// ctx.module(id): the runtime does `globalThis.__atelierModuleSlots ??= new Map()` — seeded here with a
// Map that records the ids asked for. Only app code calls ctx.module, so the attribution is fixed.

globalThis.__atelierModuleSlots = new (class extends Map {
  has(k) {
    const id = String(k).startsWith(spec.company + '/') ? String(k).slice(spec.company.length + 1) : String(k)
    record('ctxModule', { by: 'app', frame: attribute({ skipRuntime: true }).frame }, { id, cross: id !== spec.slug }, id)
    return super.has(k)
  }
})()

syncBuiltinESMExports()
