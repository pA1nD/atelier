// shell/cli-local.mjs + shell/local/{hosts,settings}.mjs with fakes (DESIGN §7.1 cli-local rows): the
// port plan, each spawned host's env, the dev token minted 0600 before the spawn, ATELIER_GIT_COMMIT=0,
// the chrome staged as an app, SIGTERM order and the ≤ grace bound, the ignored-settings lines, the
// restart backoff and the park rule.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { main, JAIL_LINE } from '../cli-local.mjs'
import { createHosts, portPlan, hostEnv, mintDevToken, runOf, BACKOFF_MS, PARK_EXITS, HOST_ENTRY } from '../local/hosts.mjs'
import { settings, ignoredSettings, parseFlags } from '../local/settings.mjs'
import { workOf } from '../local/stage.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shell-cli-'))
const mod = (root, rel, files) => { const d = path.join(root, rel); fs.mkdirSync(d, { recursive: true }); for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c); return d }
const front = (meta) => `export const meta = ${meta}\nexport default function M() { return null }\n`

function fakeSpawn(record) {
  return (cmd, args, opts) => {
    const child = new EventEmitter()
    child.pid = 1000 + record.length
    child.stdout = null; child.stderr = null
    child.kills = []
    child.kill = (sig) => { child.kills.push(sig); return true }
    const tokenFile = path.join(opts.env.ATELIER_RUN, 'dev.token')
    record.push({ cmd, args, opts, child, tokenAtSpawn: fs.existsSync(tokenFile) ? { mode: fs.statSync(tokenFile).mode & 0o777, value: fs.readFileSync(tokenFile, 'utf8') } : null })
    return child
  }
}
const fakeShell = (events) => ({ cfg, workspace }) => ({
  cfg, workspace,
  listen: async () => { events.push('shell:listen'); return { port: cfg.port } },
  close: async () => { events.push('shell:close') },
})

test('settings + flags + the ignored lines', () => {
  assert.deepEqual(settings({}, {}), { port: 1844, bind: '127.0.0.1', baseUrl: 'http://localhost:1844', nodeEnv: 'production', label: null, defaultChrome: null })
  const s = settings({ port: 2000, host: '0.0.0.0', env: 'development', label: 'L', defaultChrome: './c' }, { PORT: '3000' }, { port: 18440 })
  assert.equal(s.port, 18440); assert.equal(s.bind, '0.0.0.0'); assert.equal(s.nodeEnv, 'development'); assert.equal(s.label, 'L'); assert.equal(s.defaultChrome, './c')
  assert.equal(settings({ port: 2000 }, { PORT: '3000' }).port, 3000)          // env over the file
  assert.deepEqual(ignoredSettings({ port: 1, hotReload: false, auth: 'x', label: 'L', observe: true, foo: 1 }), ['settings honoured here, ignored in the fleet: port, label', 'ignored in 2.0: hotReload', 'ignored in 2.0: auth', 'ignored in 2.0: observe'])
  assert.deepEqual(ignoredSettings({}), [])
  assert.deepEqual(parseFlags(['--port=18440', '--open']), { open: true, port: 18440 })
  assert.match(parseFlags(['--nope']).error, /unknown flag --nope/)
})

test('port plan + host env rows (DESIGN §5.1)', () => {
  assert.deepEqual(portPlan(1844, 0), { dev: 1854, host: 1864 })
  assert.deepEqual(portPlan(18440, 1), { dev: 18451, host: 18461 })
  const e = hostEnv({ root: '/r', ws: 'team', k: 1, port: 18440, chromeDir: '/r/chrome', nodeEnv: 'development', base: { PATH: '/bin', HOME: '/h', SECRET: 'no', CLAUDE_CODE_OAUTH_TOKEN: 'no' } })
  assert.deepEqual(e, { PATH: '/bin', HOME: '/h', ATELIER_WORK: '/r/.atelier/local/team', ATELIER_RUN: runOf('/r', 'team'), ATELIER_COMPANY: 'team', ATELIER_ORIGIN: 'http://localhost:18440', ATELIER_DEV_PORT: '18451', ATELIER_HOST_PORT: '18461', NODE_ENV: 'development', ATELIER_GIT_COMMIT: '0', ATELIER_APPS_LINKS: '1', ATELIER_CHROME_DIR: '/r/chrome' })
  assert.match(runOf('/r', 'team'), /^\/tmp\/atelier-[0-9a-f]{8}\/team$/)
  assert.equal(hostEnv({ root: '/r', ws: 'global', k: 0, port: 1844, base: {} }).ATELIER_CHROME_DIR, undefined)
  assert.equal(hostEnv({ root: '/r', ws: 'global', k: 0, port: 1844, base: {} }).ATELIER_SPINE_URL, undefined)   // local mode: never set
})

test('main: discover → module.json → stage (chrome too) → token 0600 → spawn per workspace → shell; SIGTERM closes the shell first, SIGKILLs a host that ignores SIGTERM within the grace', async () => {
  const root = tmp()
  mod(root, 'alpha', { 'frontend.jsx': front(`{ name: 'Alpha', icon: 'sparkles' }`), 'backend.js': 'export default {}' })
  mod(root, 'scratch', { 'frontend.jsx': front('{}') })
  mod(root, 'My_App', { 'frontend.jsx': front('{}') })
  mod(root, '$team/beta', { 'frontend.jsx': front(`{ name: 'Beta' }`) })
  const chrome = mod(root, 'zchrome', { 'frontend.jsx': front(`{ isChrome: true, hidden: true, name: 'zchrome' }`), 'backend.js': 'export default {}' })
  fs.writeFileSync(path.join(root, 'atelier.config.json'), JSON.stringify({ port: 18440, hotReload: true, auth: 'x', modules: ['!scratch'], label: 'Lab' }))
  const spawned = [], events = [], lines = []
  const signals = new EventEmitter()
  let exitCode = null
  const exited = new Promise((r) => { signals.exit = (c) => { exitCode = c; r() } })
  const h = await main({ argv: [], env: { ATELIER_ROOT: root, PATH: '/bin' }, stderr: { write: (s) => lines.push(s.trimEnd()) }, spawn: fakeSpawn(spawned), signals, exit: signals.exit, startShell: fakeShell(events), graceMs: 50, watch: false })
  assert.equal(h.port, 18440)
  assert.deepEqual(lines.slice(0, 3), ['settings honoured here, ignored in the fleet: port, label, modules', 'ignored in 2.0: hotReload', 'ignored in 2.0: auth'])
  assert.ok(lines.some((l) => l === `! 'My_App' is not a slug — rename the folder (${path.join(root, 'My_App')})`))
  assert.ok(lines.includes(JAIL_LINE))
  assert.ok(lines.includes(`Atelier · local · ${root} · http://localhost:18440 · Lab`))
  assert.ok(lines.includes(`chrome: global/zchrome (${chrome})`))
  // module.json generated for the app and the chrome, not for the denied module
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'alpha', 'module.json'), 'utf8')), { name: 'Alpha', icon: 'sparkles' })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(chrome, 'module.json'), 'utf8')), { name: 'zchrome' })
  assert.equal(fs.existsSync(path.join(root, 'scratch', 'module.json')), false)
  // staged: global = alpha + the chrome (its backend answers under /api/global/zchrome), team = beta
  assert.deepEqual(fs.readdirSync(path.join(workOf(root, 'global'), 'apps')).sort(), ['alpha', 'zchrome'])
  assert.deepEqual(fs.readdirSync(path.join(workOf(root, 'team'), 'apps')), ['beta'])
  // one host per workspace, in host order, the token on disk (0600) before the spawn and equal to the registry row's
  assert.deepEqual(spawned.map((s) => [s.opts.env.ATELIER_COMPANY, s.opts.env.ATELIER_DEV_PORT, s.opts.env.ATELIER_HOST_PORT]), [['global', '18450', '18460'], ['team', '18451', '18461']])
  for (const s of spawned) {
    assert.deepEqual(s.args, [HOST_ENTRY]); assert.equal(s.opts.cwd, root)
    assert.equal(s.opts.env.ATELIER_GIT_COMMIT, '0'); assert.equal(s.opts.env.ATELIER_APPS_LINKS, '1'); assert.equal(s.opts.env.ATELIER_CHROME_DIR, chrome)
    assert.equal(s.opts.env.ATELIER_WORK, workOf(root, s.opts.env.ATELIER_COMPANY)); assert.equal(s.opts.env.NODE_ENV, 'production')
    assert.equal(s.tokenAtSpawn.mode, 0o600); assert.match(s.tokenAtSpawn.value, /^[0-9a-f]{64}$/)
    assert.equal(h.hosts.row(s.opts.env.ATELIER_COMPANY).token, s.tokenAtSpawn.value)
  }
  assert.deepEqual(h.hosts.row('global'), { hostId: 'local', ip: '127.0.0.1', port: 18450, tls: null, token: spawned[0].tokenAtSpawn.value, drainingAt: null })
  assert.equal(h.hosts.row('nope'), null)
  assert.equal(events[0], 'shell:listen')
  // SIGTERM: the shell closes, then every host gets SIGTERM; the team host exits, the global one never does → SIGKILL at the grace bound
  const t0 = Date.now()
  signals.emit('SIGTERM')
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(events, ['shell:listen', 'shell:close'])
  assert.deepEqual(spawned.map((s) => s.child.kills), [['SIGTERM'], ['SIGTERM']])
  spawned[1].child.emit('exit', 0, null)
  await exited
  assert.equal(exitCode, 0)
  assert.ok(Date.now() - t0 < 2000)
  assert.deepEqual(spawned[0].child.kills, ['SIGTERM', 'SIGKILL'])
  assert.equal(spawned.length, 2)                    // no restart of a host that exited during the stop
  fs.rmSync(root, { recursive: true, force: true })
})

test('hosts: a host that dies is restarted with 0.5 → 30 s backoff; 10 exits in 10 min park it (row() null); sync() stops a vanished workspace', async () => {
  const root = tmp()
  const spawned = [], timers = [], lines = []
  let t = 1_000_000
  const hosts = createHosts({ root, port: 18440, spawn: fakeSpawn(spawned), log: (l) => lines.push(l), now: () => t, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, clearTimer: () => {}, env: {} })
  hosts.start('global')
  assert.equal(spawned.length, 1)
  for (let i = 0; i < BACKOFF_MS.length + 1; i++) {
    t += 1000
    spawned[spawned.length - 1].child.emit('exit', 1, null)
    const timer = timers.pop()
    assert.equal(timer.ms, BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)])
    assert.equal(hosts.list()[0].state, 'restarting')
    assert.equal(hosts.row('global').port, 18450)     // the row stays (the shell's dial fails → waking page) until the host is parked
    timer.fn()
    assert.equal(spawned.length, i + 2)
    assert.equal(hosts.row('global').port, 18450)
  }
  assert.ok(lines.some((l) => /host died \(exit 1\) — restart in 0.5 s/.test(l)))
  // a host up for a minute resets the backoff
  t += 60_000
  spawned[spawned.length - 1].child.emit('exit', 0, null)
  const reset = timers.pop()
  assert.equal(reset.ms, 500)
  reset.fn()
  // the park rule: exits within the window (the tally already holds the ones above)
  const before = spawned.length
  for (let i = 0; i < PARK_EXITS; i++) { t += 100; spawned[spawned.length - 1].child.emit('exit', 2, null); if (hosts.list()[0].state === 'parked') break; timers.pop().fn() }
  assert.equal(hosts.row('global'), null)
  assert.equal(hosts.list()[0].state, 'parked')
  assert.ok(lines.some((l) => /host parked after 10 exits in 10 min \(last: exit 2\)/.test(l)))
  assert.ok(spawned.length <= before + PARK_EXITS)
  // sync: a new workspace starts, a vanished one is stopped (SIGTERM; its exit resolves the stop)
  const p = hosts.sync([{ id: 'team', work: workOf(root, 'team') }])
  const team = spawned[spawned.length - 1]
  assert.equal(team.opts.env.ATELIER_COMPANY, 'team')
  assert.equal(team.opts.env.ATELIER_DEV_PORT, '18451')       // k keeps counting: ports never reused within a run
  await p
  assert.deepEqual(hosts.workspaces(), [{ id: 'team', port: 18451, token: team.tokenAtSpawn.value }])
  fs.rmSync(root, { recursive: true, force: true })
})

test('mintDevToken: fresh per run, 0600, the previous file replaced', () => {
  const run = path.join(tmp(), 'run')
  const a = mintDevToken(run), b = mintDevToken(run)
  assert.notEqual(a, b)
  assert.equal(fs.readFileSync(path.join(run, 'dev.token'), 'utf8'), b)
  assert.equal(fs.statSync(path.join(run, 'dev.token')).mode & 0o777, 0o600)
  fs.rmSync(path.dirname(run), { recursive: true, force: true })
})
