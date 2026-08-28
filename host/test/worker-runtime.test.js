// host/worker/runtime.mjs — a REAL worker process on this machine through `unprivileged()` (no uid drop):
// the ctx shape against MODULES.md, env scrubbing (row W), req.user only from the internal headers,
// control messages (ready / http5xx / error / broadcast / suspendable), health, teardown on SIGTERM
// (the module's child process is killed before exit), and the load-failed classes.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { unprivileged } from '../adapters/os.mjs'
import { spawnWorker } from '../worker/spawn.mjs'
import { userHeaders } from '../worker/proxy.mjs'
import { CTX_KEYS, locate, userFromHeaders } from '../worker/runtime.mjs'

const MB = 1024 * 1024
const BACKEND = `
import { spawn } from 'node:child_process'
export default {
  mountRoutes(router, ctx) {
    const child = spawn('sleep', ['30'])
    router.get('/ctx', (req, res) => res.json({
      keys: Object.keys(ctx), frozen: Object.isFrozen(ctx), cwd: process.cwd(), env: Object.keys(process.env).sort(),
      user: req.user, child: child.pid,
      values: { id: ctx.id, name: ctx.name, workspace: ctx.workspace, qualifiedId: ctx.qualifiedId, label: ctx.label, port: ctx.port, host: ctx.host, baseUrl: ctx.baseUrl, dataDir: ctx.dataDir, home: process.env.HOME, tmp: process.env.TMPDIR, baseEnv: process.env.BASE_URL },
    }))
    router.get('/boom', () => { throw new Error('kaboom') })
    router.get('/five', (req, res) => res.json({ bad: true }, 503))
    router.post('/echo', async (req, res) => res.json(await req.json()))
    router.get('/bg', (req, res) => { setTimeout(() => { throw new Error('async boom') }, 5); res.json({ ok: true }) })
    router.get('/cast', (req, res) => { ctx.broadcast({ type: 'x', topic: 'evil' }); ctx.suspendable(); ctx.log('hello', { a: 1 }); res.json({}) })
    router.get('/slot', (req, res) => { const s = ctx.module('other'); s.n = (s.n || 0) + 1; res.json({ n: ctx.module('other').n, same: s === ctx.module('other') }) })
    router.get('/items/:id/*', (req, res) => res.json({ params: req.params, query: req.query }))
    return () => { child.kill('SIGTERM'); process.stderr.write('TEARDOWN ran\\n') }
  },
}
`

function fixture(backend = BACKEND) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'atw-')))          // short: macOS caps a socket path at 104 bytes
  const appDir = path.join(root, 'apps', 'demo')
  const codeDir = path.join(root, 'lg', 'rev-1')
  for (const d of [appDir, codeDir, path.join(root, 'data'), path.join(root, 'tmp'), path.join(root, 'w')]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(codeDir, 'backend.js'), backend)
  fs.writeFileSync(path.join(appDir, 'package.json'), '{"name":"demo"}')
  const spec = {
    instance: 'i-0123456789abcdef', slug: 'demo', name: 'Demo', company: 'acme', uid: process.getuid(), rev: 1,
    codeDir, appDir, dataDir: path.join(root, 'data'), tmpDir: path.join(root, 'tmp'), sockDir: path.join(root, 'w'), sock: path.join(root, 'w', 'w.sock'),
    scratchDir: path.join(root, 'scratch'),
    baseUrl: 'http://127.0.0.1:1844/api/acme/demo', origin: 'http://127.0.0.1:1844',
    configEnv: { DEMO_KEY: 'v' }, rlimits: { data: 1024 * MB, core: 0, nproc: 64, nofile: 1024 },
  }
  return { root, spec }
}
const hostEnv = { PATH: process.env.PATH, NODE_ENV: 'test' }

function call(sock, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, method, path: p, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); let json = null; try { json = JSON.parse(text) } catch {} ; resolve({ status: res.statusCode, headers: res.headers, text, json }) })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}
const until = async (fn, ms = 2000) => { const t = Date.now() + ms; while (Date.now() < t) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)) } return fn() }

test('a real worker: ctx shape, env, req.user, control lane, health, teardown on SIGTERM', async (t) => {
  const { root, spec } = fixture()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const control = [], logs = [], exits = []
  const h = await spawnWorker({ os: unprivileged(), spec, hostEnv, onControl: (m) => control.push(m), onExit: (c, s) => exits.push([c, s]), onLog: (s, l) => logs.push([s, l]), lockSocket: false })
  t.after(() => { try { process.kill(h.pid, 'SIGKILL') } catch {} })

  // READY report shape (§4.1): the module holds one child → never idle-stopped (R14)
  assert.equal(h.ready.t, 'ready')
  assert.equal(h.ready.teardown, true)
  assert.equal(h.ready.resources.ProcessWrap, 1)
  assert.equal(typeof h.ready.mountMs, 'number')
  assert.equal(typeof h.ready.importMs, 'number')

  // ctx = MODULES.md's keys + suspendable, frozen; cwd = the app folder; env = row W exactly (+ config keys)
  const user = { id: 'p1', name: 'Björn Ü', claims: { role: 'admin', tags: ['ä'] } }
  const r = await call(spec.sock, 'GET', '/ctx', { headers: userHeaders(user) })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.keys, CTX_KEYS)
  assert.equal(r.json.frozen, true)
  assert.equal(r.json.cwd, fs.realpathSync(spec.appDir))
  assert.deepEqual(r.json.env, ['APP_ID', 'ATELIER_WORKER', 'BASE_URL', 'DEMO_KEY', 'HOME', 'HOST', 'NODE_ENV', 'PATH', 'PORT', 'TMPDIR'])
  assert.deepEqual(r.json.user, user)
  assert.deepEqual(r.json.values, {
    id: 'demo', name: 'Demo', workspace: 'acme', qualifiedId: 'acme/demo', label: 'Demo', port: 1844, host: '127.0.0.1',
    baseUrl: 'http://127.0.0.1:1844/api/acme/demo', dataDir: spec.dataDir, home: path.join(spec.scratchDir, 'home'), tmp: spec.tmpDir, baseEnv: 'http://127.0.0.1:1844/api/acme/demo',
  })
  const childPid = r.json.child

  // req.user comes only from the internal headers; without them it is null
  const anon = await call(spec.sock, 'GET', '/ctx')
  assert.equal(anon.json.user, null)

  // router surface through the socket
  const it = await call(spec.sock, 'GET', '/items/42/a/b?x=1')
  assert.deepEqual(it.json, { params: { id: '42', '*': 'a/b' }, query: { x: '1' } })
  const echo = await call(spec.sock, 'POST', '/echo', { headers: { 'content-type': 'application/json' }, body: '{"k":[1,2]}' })
  assert.deepEqual(echo.json, { k: [1, 2] })
  const nf = await call(spec.sock, 'GET', '/nope')
  assert.equal(nf.status, 404)
  assert.deepEqual(nf.json, { error: 'not found', app: 'acme/demo', path: '/nope' })
  const health = await call(spec.sock, 'GET', '/_atelier/health')
  assert.equal(health.json.rev, 1)
  assert.equal(typeof health.json.uptime, 'number')

  // a handler throw → 500 + {t:'http5xx'} with file:line; a plain 5xx response → {t:'http5xx'} too
  const boom = await call(spec.sock, 'GET', '/boom')
  assert.equal(boom.status, 500)
  assert.deepEqual(boom.json, { error: 'kaboom' })
  await until(() => control.some((m) => m.t === 'http5xx' && m.path === '/boom'))
  const five = control.find((m) => m.t === 'http5xx' && m.path === '/boom')
  assert.equal(five.status, 500)
  assert.equal(five.message, 'kaboom')
  assert.equal(five.method, 'GET')
  assert.equal(five.file, path.join(spec.codeDir, 'backend.js'))
  assert.equal(typeof five.line, 'number')
  assert.equal((await call(spec.sock, 'GET', '/five')).status, 503)
  await until(() => control.some((m) => m.t === 'http5xx' && m.path === '/five' && m.status === 503))

  // an async throw outside any request → {t:'error', kind:'backend'} and the process stays up
  assert.equal((await call(spec.sock, 'GET', '/bg')).status, 200)
  await until(() => control.some((m) => m.t === 'error'))
  const err = control.find((m) => m.t === 'error')
  assert.equal(err.kind, 'backend')
  assert.equal(err.message, 'async boom')
  assert.equal((await call(spec.sock, 'GET', '/ctx')).status, 200)

  // broadcast (topic stripped — the host stamps it), suspendable, ctx.log → stderr line
  await call(spec.sock, 'GET', '/cast')
  await until(() => control.some((m) => m.t === 'suspendable'))
  assert.deepEqual(control.find((m) => m.t === 'broadcast'), { t: 'broadcast', event: { type: 'x' } })
  assert.ok(logs.some(([s, l]) => s === 'stderr' && l === '[acme/demo] hello { a: 1 }'))
  assert.ok(logs.some(([, l]) => /broadcast with topic 'evil'/.test(l)))

  // ctx.module(): one worker-local slot per id
  await call(spec.sock, 'GET', '/slot')
  const slot = await call(spec.sock, 'GET', '/slot')
  assert.deepEqual(slot.json, { n: 2, same: true })

  // SIGTERM → teardown runs (the module's child dies) → exit 0
  assert.doesNotThrow(() => process.kill(childPid, 0))
  const stopped = await h.stop(3000)
  assert.deepEqual(stopped, { code: 0, signal: null, killed: false })
  assert.ok(await until(() => { try { process.kill(childPid, 0); return false } catch { return true } }))
  assert.ok(logs.some(([, l]) => l === 'TEARDOWN ran'))
  assert.deepEqual(exits, [[0, null]])
})

test('load-failed classes: syntax error → LOAD-ERROR, missing import → ERR_MODULE_NOT_FOUND, throwing mount → MOUNT-ERROR, no default → LOAD-ERROR', async (t) => {
  const cases = [
    ['export default { mountRoutes(r) { r.get(\n', 'LOAD-ERROR', /Unexpected|Unterminated|SyntaxError/i],
    ['import "./nope.js"\nexport default { mountRoutes() {} }', 'ERR_MODULE_NOT_FOUND', /nope\.js/],
    ['export default { mountRoutes() { throw new Error("database is locked") } }', 'MOUNT-ERROR', /database is locked/],
    ['export const meta = {}', 'LOAD-ERROR', /no default\.mountRoutes/],
  ]
  for (const [src, code, re] of cases) {
    const { root, spec } = fixture(src)
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    await assert.rejects(spawnWorker({ os: unprivileged(), spec, hostEnv, onLog: () => {}, lockSocket: false }), (e) => {
      assert.equal(e.error, 'load-failed', `${code}: ${e.msg}`)
      assert.equal(e.code, code)
      assert.match(e.detail.message, re)
      if (code === 'MOUNT-ERROR') assert.equal(e.detail.file, path.join(spec.codeDir, 'backend.js'))
      return true
    })
  }
})

test('locate() and userFromHeaders() (pure)', () => {
  const e = new Error('x')
  e.stack = 'Error: x\n    at mountRoutes (file:///work/apps/demo/backend.js:4:9)\n    at main (/app/host/worker/runtime.mjs:1:1)'
  assert.deepEqual(locate(e), { file: '/work/apps/demo/backend.js', line: 4, col: 9 })
  e.stack = 'Error: x\n    at /work/apps/demo/lib.js:12:3'
  assert.deepEqual(locate(e), { file: '/work/apps/demo/lib.js', line: 12, col: 3 })
  assert.deepEqual(locate({ stack: 'nothing here' }), {})
  assert.deepEqual(userFromHeaders(userHeaders({ id: 'p1', name: 'Björn', claims: { a: 'ä' } })), { id: 'p1', name: 'Björn', claims: { a: 'ä' } })
  assert.equal(userFromHeaders({}), null)
  assert.deepEqual(userFromHeaders({ 'x-atelier-user': 'p2', 'x-atelier-claims': 'not json' }), { id: 'p2', name: '', claims: {} })
})
