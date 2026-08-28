// The real thing: `node cli.js` (bare → shell/cli-local.mjs) over a fixture instance with two apps in
// two workspaces → two real hosts + the shell. Document 200 and API 200 through the shell with no token
// in any URL, a save through the symlinked folder becomes a new revision, SIGTERM leaves no process.
// One bounded wait per row (≤ 60 s boot, ≤ 30 s rebuild, ≤ 15 s stop).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runBase } from '../local/hosts.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const front = (meta) => `export const meta = ${meta}\nexport default function M() { return React.createElement('div', null, 'm') }\n`
const backend = (marker) => `export default { mountRoutes(router) { router.get('/ping', (req, res) => res.json({ ok: true, marker: '${marker}', user: req.user?.id ?? null })) } }\n`
const free = (port) => new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(port, '127.0.0.1', () => s.close(() => r(true))) })
async function portTriple() {
  for (let i = 0; i < 50; i++) {
    const p = 20000 + Math.floor(Math.random() * 20000)
    const ok = await Promise.all([p, p + 10, p + 11, p + 20, p + 21].map(free))
    if (ok.every(Boolean)) return p
  }
  throw new Error('no free port triple')
}
const get = async (url) => { const r = await fetch(url, { redirect: 'manual' }); return { status: r.status, text: await r.text() } }
async function until(fn, ms, label) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const v = await fn().catch(() => null); if (v) return v; await new Promise((r) => setTimeout(r, 250)) }
  throw new Error(`VERDICT: timeout — ${label} after ${ms} ms`)
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code !== 'ESRCH' } }

test('npx atelier over two fixture apps: document 200, API 200, a save is a new rev, shutdown leaves no process', { timeout: 150_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atl-spawn-'))
  fs.mkdirSync(path.join(root, 'alpha')); fs.mkdirSync(path.join(root, '$team', 'beta'), { recursive: true })
  fs.writeFileSync(path.join(root, 'alpha', 'frontend.jsx'), front(`{ name: 'Alpha', icon: 'sparkles' }`))
  fs.writeFileSync(path.join(root, 'alpha', 'backend.js'), backend('v1'))
  fs.writeFileSync(path.join(root, '$team', 'beta', 'frontend.jsx'), front(`{ name: 'Beta' }`))
  const port = await portTriple()
  const log = []
  const cli = spawn(process.execPath, [path.join(REPO, 'cli.js')], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, ATELIER_ROOT: root, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = new Promise((r) => cli.on('exit', (code, signal) => r({ code, signal })))
  const relay = (s) => { let buf = ''; s.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { log.push(buf.slice(0, i)); buf = buf.slice(i + 1) } }) }
  relay(cli.stdout); relay(cli.stderr)
  try {
    const base = `http://localhost:${port}`
    const doc = await until(async () => { const r = await get(`${base}/global/alpha`); return r.status === 200 ? r : null }, 60_000, 'document 200')
    assert.match(doc.text, /window\.__ATELIER__/)
    assert.doesNotMatch(doc.text, /token=/)                                  // no token in any browser URL
    const api = await until(async () => { const r = await get(`${base}/api/global/alpha/ping`); return r.status === 200 ? r : null }, 60_000, 'API 200')
    assert.deepEqual(JSON.parse(api.text), { ok: true, marker: 'v1', user: 'local' })
    assert.equal((await get(`${base}/team/beta`)).status, 200)
    assert.equal((await get(`${base}/modules/team/beta/frontend.js`)).status, 200)
    assert.equal((await get(`${base}/modules/global/alpha/frontend.js`)).status, 200)
    assert.equal((await get(`${base}/api/global/nope/x`)).status, 404)
    // the two host pids from the CLI's own lines; both alive
    const pids = log.map((l) => /^\[(\w+)\] host \d+ pid (\d+)/.exec(l)).filter(Boolean).map((m) => [m[1], Number(m[2])])
    assert.deepEqual(pids.map(([ws]) => ws), ['global', 'team'])
    assert.ok(pids.every(([, pid]) => alive(pid)))
    assert.ok(log.includes('jail: lifecycle-only (no uid drop) — apps are not isolated from each other on this machine'))
    assert.ok(fs.existsSync(path.join(root, 'alpha', 'module.json')))
    assert.equal(fs.readlinkSync(path.join(root, '.atelier', 'local', 'global', 'apps', 'alpha')), path.join(root, 'alpha'))
    // a save in the real folder reaches the host through the link: a new revision answers
    fs.writeFileSync(path.join(root, 'alpha', 'backend.js'), backend('v2'))
    await until(async () => { const r = await get(`${base}/api/global/alpha/ping`); return r.status === 200 && JSON.parse(r.text).marker === 'v2' ? r : null }, 30_000, 'rev 2 live')
    // shutdown: the CLI exits 0 and neither host is left behind
    cli.kill('SIGTERM')
    const ex = await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('VERDICT: timeout — cli did not exit in 15 s')), 15_000))])
    assert.deepEqual(ex, { code: 0, signal: null })
    await new Promise((r) => setTimeout(r, 300))
    for (const [ws, pid] of pids) assert.equal(alive(pid), false, `host ${ws} pid ${pid} still alive`)
    const dead = await get(`${base}/global/alpha`).catch((e) => ({ status: e.cause?.code ?? 'ERR' }))
    assert.notEqual(dead.status, 200)
  } catch (e) {
    e.message += `\n--- cli log ---\n${log.join('\n')}`
    try { cli.kill('SIGKILL') } catch {}
    throw e
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(runBase(root), { recursive: true, force: true })
  }
})
