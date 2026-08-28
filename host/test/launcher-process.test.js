// host/launcher.mjs as a real process on the laptop (`unprivileged()` + `realIo()`): the plan lands on a
// real filesystem under a mkdtemp with the exact modes, fd 3 reaches the host, the crash line is
// appended by the helper, the restart happens, SIGTERM/exit mirroring works end to end. No uid drop
// here (chown/setpriv are the Linux drill's); no side effect outside the temp dir.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HOST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function scaffold({ hostCrashOnce = false, supExitAfterMs = 0, supExitCode = 3 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-launcher-'))
  const p = { root, work: `${root}/work`, run: `${root}/run`, control: `${root}/control`, tmp: `${root}/tmp` }
  fs.mkdirSync(p.work, { mode: 0o755 }); fs.mkdirSync(p.control, { mode: 0o700 }); fs.mkdirSync(p.tmp, { mode: 0o755 })
  fs.writeFileSync(`${root}/driver.mjs`, `
    import { createLauncher, realIo, config } from ${JSON.stringify(`${HOST_DIR}/launcher.mjs`)}
    import { unprivileged } from ${JSON.stringify(`${HOST_DIR}/adapters/os.mjs`)}
    const cfg = { ...config(process.env), tmp: process.env.DRILL_TMP }
    createLauncher({ os: unprivileged(), io: realIo(), env: process.env, log: console.log, clock: { now: Date.now, setTimeout, clearTimeout },
      exit: (c) => process.exit(c), signals: process, cfg,
      hostArgv: ['node', ${JSON.stringify(`${root}/host.mjs`)}], sessionArgv: ['node', ${JSON.stringify(`${root}/sup.mjs`)}] }).boot()
  `)
  // the host stand-in: crashes once (exit 1) when asked, else proves fd 3 and writes host-ready; SIGTERM → marker + exit 0
  fs.writeFileSync(`${root}/host.mjs`, `
    import fs from 'node:fs'
    const run = process.env.ATELIER_RUN, once = run + '/crashed-once'
    if (${hostCrashOnce} && !fs.existsSync(once)) { fs.writeFileSync(once, ''); process.exit(1) }
    const fd3 = fs.fstatSync(3).isDirectory()
    const seen = JSON.stringify({ pid: process.pid, fd3, umask: process.umask().toString(8), env: Object.keys(process.env).sort(), cwd: process.cwd() })
    fs.writeFileSync(run + '/host-seen', seen); fs.writeFileSync(run + '/host-ready', seen)
    process.on('SIGTERM', () => { fs.writeFileSync(run + '/host-term', String(Date.now())); fs.unlinkSync(run + '/host-ready'); process.exit(0) })
    setInterval(() => {}, 1000)
  `)
  // the session supervisor stand-in (row S carries no ATELIER_* and no test knob, so everything is baked in):
  // exits supExitCode after supExitAfterMs, or 1 on SIGTERM
  fs.writeFileSync(`${root}/sup.mjs`, `
    import fs from 'node:fs'
    const run = ${JSON.stringify(p.run)}
    fs.writeFileSync(run + '/sup-seen', JSON.stringify({ cwd: process.cwd(), home: process.env.HOME, umask: process.umask().toString(8), env: Object.keys(process.env).sort() }))
    process.on('SIGTERM', () => { fs.writeFileSync(run + '/sup-term', String(Date.now())); process.exit(1) })
    if (${supExitAfterMs}) setTimeout(() => process.exit(${supExitCode}), ${supExitAfterMs})
    setInterval(() => {}, 1000)
  `)
  return p
}
function run(p) {
  const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', TERM: 'xterm', CHANNEL_URL: 'http://spine:1', CHANNEL_TOKEN: 'chan', ATELIER_BOOTSTRAP: 'boot-secret',
    ATELIER_WORK: p.work, ATELIER_RUN: p.run, ATELIER_CONTROL: p.control, ATELIER_GRACE_S: '8', DRILL_TMP: p.tmp }
  const child = spawn(process.execPath, [`${p.root}/driver.mjs`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { out += d })
  const done = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })))
  return { child, done, out: () => out }
}
const until = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)) } return false }
const mode = (f) => (fs.statSync(f).mode & 0o7777).toString(8).padStart(4, '0')
// the adapter's `sh -c 'umask …; exec "$@"'` wrapper adds the shell's own PWD/SHLVL/_/OLDPWD; macOS adds __CF_USER_TEXT_ENCODING
const SHELL_ADDED = new Set(['PWD', 'SHLVL', '_', 'OLDPWD', '__CF_USER_TEXT_ENCODING'])
const envKeys = (list) => list.filter((k) => !SHELL_ADDED.has(k))

test('real process: plan on disk, fd 3 to the host, crash → helper line → restart, supervisor exit mirrored', async () => {
  const p = scaffold({ hostCrashOnce: true, supExitAfterMs: 1500, supExitCode: 3 })
  const r = run(p)
  const { code } = await r.done
  const out = r.out()
  assert.equal(code, 3, out)
  // the plan landed with its modes (umask 0 while the plan ran)
  assert.equal(mode(`${p.work}/.atelier`), '0711'); assert.equal(mode(`${p.work}/.atelier/data`), '0711'); assert.equal(mode(`${p.work}/.atelier/last-good`), '0711'); assert.equal(mode(`${p.work}/.atelier/scratch`), '0711')
  assert.equal(mode(`${p.work}/apps`), '0755'); assert.equal(mode(p.run), '0711'); assert.equal(mode(`${p.run}/dev`), '0710'); assert.equal(mode(`${p.run}/session`), '0700')
  assert.equal(mode(`${p.tmp}/tmux-1000`), '0700')
  // mkdir(2) honours the sticky bit on Linux only (BSD/macOS clear it) — the Linux drill stats /tmp/.X11-unix 1777
  assert.equal(mode(`${p.tmp}/.X11-unix`), process.platform === 'linux' ? '1777' : '0777')
  for (const f of ['bootstrap.token', 'dev.token', 'session/dev.token']) assert.equal(mode(`${p.run}/${f}`), '0400', f)
  assert.equal(fs.readFileSync(`${p.run}/bootstrap.token`, 'utf8'), 'boot-secret')
  const dt = fs.readFileSync(`${p.run}/dev.token`, 'utf8'); assert.match(dt, /^[0-9a-f]{64}$/); assert.equal(fs.readFileSync(`${p.run}/session/dev.token`, 'utf8'), dt)
  // first host crashed: one crash line through the helper (`cat >> .host-crash`), then a restart that became ready
  const crash = fs.readFileSync(`${p.control}/.host-crash`, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(crash.length, 1); assert.equal(crash[0].code, 1); assert.equal(crash[0].signal, null); assert.equal(crash[0].exits, 1); assert.ok(crash[0].at > 0)
  assert.match(out, /host: restart in 500 ms/)
  // the restarted host saw fd 3 as a directory, umask 077, cwd /, the row-H env, and was torn down on the supervisor exit
  assert.ok(fs.existsSync(`${p.run}/host-term`), 'host got SIGTERM after the supervisor exit')
  assert.equal(fs.existsSync(`${p.run}/host-ready`), false)
  const ready = JSON.parse(fs.readFileSync(`${p.run}/host-seen`, 'utf8'))
  assert.equal(ready.fd3, true); assert.equal(ready.umask, '77'); assert.equal(ready.cwd, '/')
  assert.deepEqual(envKeys(ready.env), ['ATELIER_CONTROL', 'ATELIER_DIRFD', 'ATELIER_GRACE_S', 'ATELIER_RUN', 'ATELIER_SPINE_URL', 'ATELIER_WORK', 'HOME', 'LANG', 'NODE_ENV', 'PATH', 'TERM'])
  // the supervisor stand-in ran with cwd = work, HOME = /work, umask 022, the row-S env (no ATELIER_*)
  const sup = JSON.parse(fs.readFileSync(`${p.run}/sup-seen`, 'utf8'))
  assert.equal(sup.cwd, fs.realpathSync(p.work)); assert.equal(sup.home, '/work'); assert.equal(sup.umask, '22')
  assert.deepEqual(envKeys(sup.env), ['CHANNEL_TOKEN', 'CHANNEL_URL', 'HOME', 'LANG', 'PATH', 'TERM'], 'row S')
  assert.match(out, /session supervisor: exited code=3 signal=null/); assert.match(out, /exit 3 \(session supervisor code=3/)
  fs.rmSync(p.root, { recursive: true, force: true })
})

test('real process: SIGTERM → host first, supervisor forwarded, exit mirrors the supervisor (1)', async () => {
  const p = scaffold()
  const r = run(p)
  assert.ok(await until(() => fs.existsSync(`${p.run}/host-ready`)), 'host-ready appears: ' + r.out())
  const ready = JSON.parse(fs.readFileSync(`${p.run}/host-ready`, 'utf8'))
  assert.equal(ready.fd3, true)
  assert.ok(await until(() => fs.existsSync(`${p.run}/sup-seen`)))
  r.child.kill('SIGTERM')
  const { code } = await r.done
  const out = r.out()
  assert.equal(code, 1, out)
  assert.ok(fs.existsSync(`${p.run}/host-term`) && fs.existsSync(`${p.run}/sup-term`), out)
  assert.ok(Number(fs.readFileSync(`${p.run}/host-term`, 'utf8')) <= Number(fs.readFileSync(`${p.run}/sup-term`, 'utf8')) + 50, 'host signalled no later than the supervisor')
  assert.match(out, /SIGTERM: host first, session supervisor next, 3000 ms/)
  assert.equal(fs.existsSync(`${p.control}/.host-crash`), false, 'a host exit during teardown is not a crash')
  fs.rmSync(p.root, { recursive: true, force: true })
})
