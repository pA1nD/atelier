// The sharing loop — package → publish → add — exercised through the real CLI
// (cli.js spawned as a child process) against throwaway instances, the same
// characterization style as the server tests. Locks THE NORM: the only
// shareable shape is a collection (a git repo of module folders), `add` is a
// git clone, cuts are build-gated, and installs are clobber-safe.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { freePort, sleep } from './helpers.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(HERE, '..', 'cli.js')

function mkInstance() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-coll-'))
}

function mkModule(root, id, { frontend, backend, pkg, data, extras } = {}) {
  const dir = path.join(root, id)
  fs.mkdirSync(dir, { recursive: true })
  if (frontend !== null) {
    fs.writeFileSync(path.join(dir, 'frontend.jsx'),
      frontend ?? `export default function M() { return <div>${id}</div>; }\n`)
  }
  if (backend) fs.writeFileSync(path.join(dir, 'backend.js'), backend)
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify(pkg ?? { name: id, version: '1.0.0' }, null, 2))
  if (data) {
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true })
    for (const [f, c] of Object.entries(data)) fs.writeFileSync(path.join(dir, 'data', f), c)
  }
  for (const [f, c] of Object.entries(extras ?? {})) {
    const p = path.join(dir, f)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, c)
  }
  return dir
}

function cli(root, args, opts = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ATELIER_ROOT: root, GIT_TERMINAL_PROMPT: '0' },
    ...opts,
  })
  return { code: res.status, out: (res.stdout || '') + (res.stderr || '') }
}

/* ---- package ---------------------------------------------------------------- */

test('package cuts a filtered, committed snapshot', () => {
  const root = mkInstance()
  mkModule(root, 'kanban', {
    backend: 'export default { mountRoutes(router, ctx) {} };\n',
    data: { 'state.json': '{}' },
    extras: { 'node_modules/junk/index.js': '!!', '.env': 'SECRET=1' },
  })
  const r = cli(root, ['package', 'kanban', '--yes'])
  assert.equal(r.code, 0, r.out)
  const cut = path.join(root, '_collections', 'kanban', 'kanban')
  assert.ok(fs.existsSync(path.join(cut, 'frontend.jsx')))
  assert.ok(fs.existsSync(path.join(cut, 'backend.js')))
  assert.ok(!fs.existsSync(path.join(cut, 'node_modules')), 'node_modules never travels')
  assert.ok(!fs.existsSync(path.join(cut, 'data')), 'data/ only with --data')
  assert.ok(!fs.existsSync(path.join(cut, '.env')), 'secrets stay home')
  assert.ok(fs.existsSync(path.join(root, '_collections', 'kanban', '.git')), 'a collection is always a git repo')
  assert.match(r.out, /✓ kanban 1\.0\.0/)
  assert.match(r.out, /✓ packaged  →/)
})

test('package refuses a module that does not build — collection unchanged', () => {
  const root = mkInstance()
  mkModule(root, 'broken', { backend: 'export default { mountRoutes(r, c) {\n' })  // unclosed brace
  const r = cli(root, ['package', 'broken', '--yes'])
  assert.notEqual(r.code, 0)
  assert.match(r.out, /NOT cut/)
  assert.ok(!fs.existsSync(path.join(root, '_collections', 'broken', 'broken')))
})

test('package --data ships content; recut at same version warns', () => {
  const root = mkInstance()
  mkModule(root, 'notes', { data: { 'notes.md': 'hello' } })
  let r = cli(root, ['package', 'notes', '--data', '--yes'])
  assert.equal(r.code, 0, r.out)
  assert.equal(fs.readFileSync(path.join(root, '_collections', 'notes', 'notes', 'data', 'notes.md'), 'utf8'), 'hello')
  // change content, same version → cut lands but warns about the version
  fs.appendFileSync(path.join(root, 'notes', 'frontend.jsx'), '// changed\n')
  r = cli(root, ['package', 'notes', '--data', '--yes'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /recut at the same version/)
})

test('package pulls a pinned chrome into the collection (closure)', () => {
  const root = mkInstance()
  mkModule(root, 'app', {
    frontend: `export const meta = { chrome: 'mychrome' };\nexport default function App() { return <div>app</div>; }\n`,
  })
  mkModule(root, 'mychrome', {
    frontend: `export const meta = { isChrome: true };\nexport default function Chrome({ children }) { return <div>{children}</div>; }\n`,
  })
  const r = cli(root, ['package', 'app', '--yes'])
  assert.equal(r.code, 0, r.out)
  assert.ok(fs.existsSync(path.join(root, '_collections', 'app', 'app', 'frontend.jsx')))
  assert.ok(fs.existsSync(path.join(root, '_collections', 'app', 'mychrome', 'frontend.jsx')), 'pinned chrome travels')
  assert.match(r.out, /✓ app 1\.0\.0/)
  assert.match(r.out, /✓ mychrome 1\.0\.0/)
})

test('package --data snapshots sqlite databases live-consistently (no wal/shm in the cut)', (t) => {
  try { spawnSync('sqlite3', ['--version']) } catch { return t.skip('no sqlite3 binary') }
  const root = mkInstance()
  const dir = mkModule(root, 'ledger', {})
  // the module's own .gitignore MUST NOT hide data/ from the collection's git
  // (regression: --data shipped nothing because the cut inherited "data/")
  fs.writeFileSync(path.join(dir, '.gitignore'), 'data/\nnode_modules/\n')
  fs.mkdirSync(path.join(dir, 'data'))
  const db = path.join(dir, 'data', 'ledger.db')
  spawnSync('sqlite3', [db, 'PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (42);'])
  const r = cli(root, ['package', 'ledger', '--data', '--yes'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /data: ledger\.db — changed · live sqlite snapshot/)
  const coll = path.join(root, '_collections', 'ledger')
  const tracked = spawnSync('git', ['ls-files'], { cwd: coll, encoding: 'utf8' }).stdout
  assert.ok(tracked.includes('ledger/data/ledger.db'), 'data is COMMITTED despite the module .gitignore')
  const cutDb = path.join(coll, 'ledger', 'data', 'ledger.db')
  // sidecar check FIRST — merely opening the WAL-mode db (the SELECT below) recreates them
  assert.ok(!fs.existsSync(cutDb + '-wal') && !fs.existsSync(cutDb + '-shm'), 'wal/shm sidecars never travel')
  const q = spawnSync('sqlite3', [cutDb, 'SELECT x FROM t;'], { encoding: 'utf8' })
  assert.equal(q.stdout.trim(), '42', 'snapshot is a valid, queryable database')
  // idempotent re-run reports module AND data status on their own lines
  const r2 = cli(root, ['package', 'ledger', '--data', '--yes'])
  assert.equal(r2.code, 0, r2.out)
  assert.match(r2.out, /· ledger 1\.0\.0   \(unchanged\)/)
  assert.match(r2.out, /data: ledger\.db — unchanged/)
})

test('package finds a path-mounted module (atelier.config.json) — cut lands in the instance', () => {
  const root = mkInstance()
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-elsewhere-'))
  mkModule(elsewhere, 'worldclock', {})
  fs.writeFileSync(path.join(root, 'atelier.config.json'), JSON.stringify({
    modules: [{ workspace: 'travel', modules: [path.join(elsewhere, 'worldclock')] }],
  }))
  const r = cli(root, ['package', 'worldclock', '--yes'])
  assert.equal(r.code, 0, r.out)
  assert.ok(fs.existsSync(path.join(root, '_collections', 'worldclock', 'worldclock', 'frontend.jsx')),
    'cut lands in the INSTANCE _collections, wherever the working tree lives')
})

/* ---- add (from a local source) ----------------------------------------------- */

function producerWithApp() {
  const producer = mkInstance()
  mkModule(producer, 'app', {
    frontend: `export const meta = { chrome: 'mychrome' };\nexport default function App() { return <div>app</div>; }\n`,
    backend: 'export default { mountRoutes(router, ctx) {} };\n',
  })
  mkModule(producer, 'mychrome', {
    frontend: `export const meta = { isChrome: true };\nexport default function Chrome({ children }) { return <div>{children}</div>; }\n`,
  })
  const r = cli(producer, ['package', 'app', '--yes'])
  assert.equal(r.code, 0, r.out)
  return { producer, collDir: path.join(producer, '_collections', 'app') }
}

test('add <path> subscribes (full clone) and installs every module, with provenance', () => {
  const { collDir } = producerWithApp()
  const consumer = mkInstance()
  const r = cli(consumer, ['add', collDir])
  assert.equal(r.code, 0, r.out)
  assert.ok(fs.existsSync(path.join(consumer, '_collections', 'app', '.git')), 'mirror is a git clone')
  assert.ok(fs.existsSync(path.join(consumer, 'app', 'frontend.jsx')))
  assert.ok(fs.existsSync(path.join(consumer, 'mychrome', 'frontend.jsx')), 'whole collection installs')
  const prov = JSON.parse(fs.readFileSync(path.join(consumer, 'app', '.atelier'), 'utf8'))
  assert.equal(prov.collection, 'app')
  assert.match(prov.commit, /^[0-9a-f]{40}$/)
  // re-add: clobber-safe, installs nothing new
  const r2 = cli(consumer, ['add', 'app'])
  assert.equal(r2.code, 0, r2.out)
  assert.match(r2.out, /already installed/)
  assert.match(r2.out, /nothing new to install/)
  // single-module path form reinstalls one module
  fs.rmSync(path.join(consumer, 'mychrome'), { recursive: true })
  const r3 = cli(consumer, ['add', 'app/mychrome'])
  assert.equal(r3.code, 0, r3.out)
  assert.ok(fs.existsSync(path.join(consumer, 'mychrome', 'frontend.jsx')))
  // list shows the subscription with installed marks
  const r4 = cli(consumer, ['list'])
  assert.equal(r4.code, 0, r4.out)
  assert.match(r4.out, /✓ app/)
})

test('add rejects a repo that is not a collection, and unknown module names', () => {
  const notColl = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-notcoll-'))
  fs.writeFileSync(path.join(notColl, 'README.md'), 'not modules')
  spawnSync('git', ['init', '-q'], { cwd: notColl })
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: notColl })
  const consumer = mkInstance()
  const r = cli(consumer, ['add', notColl])
  assert.notEqual(r.code, 0)
  assert.match(r.out, /not a collection/)
  assert.ok(!fs.existsSync(path.join(consumer, '_collections', path.basename(notColl))), 'failed clone is cleaned up')

  const { collDir } = producerWithApp()
  const c2 = mkInstance()
  assert.equal(cli(c2, ['add', collDir]).code, 0)
  const r2 = cli(c2, ['add', 'app/nope'])
  assert.notEqual(r2.code, 0)
  assert.match(r2.out, /it offers: app, mychrome/)
})

test('add flags a module the instance already mounts elsewhere (path-mount in a workspace)', () => {
  const { collDir } = producerWithApp()
  const consumer = mkInstance()
  // consumer already develops "app" — a working tree elsewhere, path-mounted into a workspace
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-mine-'))
  mkModule(elsewhere, 'app', {})
  fs.writeFileSync(path.join(consumer, 'atelier.config.json'), JSON.stringify({
    modules: [{ workspace: 'travel', modules: [path.join(elsewhere, 'app')] }],
  }))
  const r = cli(consumer, ['add', collDir])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /app already lives in this instance as travel\/app/)
  assert.match(r.out, /path-mounted/)
  assert.ok(!fs.existsSync(path.join(consumer, 'app')), 'no silent duplicate installed')
  assert.ok(fs.existsSync(path.join(consumer, 'mychrome', 'frontend.jsx')), 'non-colliding modules still install')
  // explicit --force installs the separate copy alongside
  const r2 = cli(consumer, ['add', 'app/app', '--force'])
  assert.equal(r2.code, 0, r2.out)
  assert.ok(fs.existsSync(path.join(consumer, 'app', 'frontend.jsx')))
})

test('installPath routes modules and chromes to separate folders, auto-mounts them, and update finds them there', () => {
  const { producer, collDir } = producerWithApp()
  const consumer = mkInstance()
  const modHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-mods-'))
  const chromeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-chromes-'))
  fs.writeFileSync(path.join(consumer, 'atelier.config.json'), JSON.stringify({
    installPath: { modules: modHome, chromes: chromeHome },
  }))
  const r = cli(consumer, ['add', collDir])
  assert.equal(r.code, 0, r.out)
  assert.ok(fs.existsSync(path.join(modHome, 'app', 'frontend.jsx')), 'module routed to installPath.modules')
  assert.ok(fs.existsSync(path.join(chromeHome, 'mychrome', 'frontend.jsx')), 'chrome routed to installPath.chromes')
  assert.ok(!fs.existsSync(path.join(consumer, 'app')) && !fs.existsSync(path.join(consumer, 'mychrome')),
    'nothing lands in the instance folder')
  const cfg = JSON.parse(fs.readFileSync(path.join(consumer, 'atelier.config.json'), 'utf8'))
  assert.ok(cfg.modules.includes(path.join(modHome, 'app')), 'module path-mounted automatically')
  assert.ok(cfg.modules.includes(path.join(chromeHome, 'mychrome')), 'chrome path-mounted automatically')
  // list sees them as installed through the path-mounts
  assert.match(cli(consumer, ['list']).out, /✓ app/)
  // re-add stays clobber-safe against the external location
  const r2 = cli(consumer, ['add', 'app'])
  assert.match(r2.out, /already installed — kept|already lives in this instance/)
  // upstream cuts a new version → update finds and upgrades the EXTERNAL working copy in place
  fs.writeFileSync(path.join(producer, 'app', 'frontend.jsx'),
    `export const meta = { chrome: 'mychrome' };\nexport default function App() { return <div>v2</div>; }\n`)
  fs.writeFileSync(path.join(producer, 'app', 'package.json'), JSON.stringify({ name: 'app', version: '2.0.0' }))
  assert.equal(cli(producer, ['package', 'app', '--yes']).code, 0)
  const r3 = cli(consumer, ['update', 'app'])
  assert.equal(r3.code, 0, r3.out)
  assert.match(r3.out, /1\.0\.0 → 2\.0\.0/)
  assert.match(fs.readFileSync(path.join(modHome, 'app', 'frontend.jsx'), 'utf8'), /v2/, 'updated in place, outside the instance')
})

/* ---- publish ------------------------------------------------------------------ */

test('publish --bundle round-trips through add', () => {
  const { producer } = producerWithApp()
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-bundle-')), 'app.bundle')
  const r = cli(producer, ['publish', 'app', '--bundle', out])
  assert.equal(r.code, 0, r.out)
  assert.ok(fs.existsSync(out))
  const consumer = mkInstance()
  const r2 = cli(consumer, ['add', out])
  assert.equal(r2.code, 0, r2.out)
  assert.ok(fs.existsSync(path.join(consumer, 'app', 'frontend.jsx')), 'bundle installs like any source')
  assert.ok(fs.existsSync(path.join(consumer, '_collections', 'app', '.git')), 'and still subscribes (history intact)')
})

test('publish --serve hosts a collection git-clonable over plain http', async () => {
  const { producer } = producerWithApp()
  const port = await freePort()
  const server = spawn(process.execPath, [CLI, 'publish', 'app', '--serve', '--port', String(port)], {
    env: { ...process.env, ATELIER_ROOT: producer, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  server.stdout.on('data', (d) => { out += d })
  server.stderr.on('data', (d) => { out += d })
  try {
    for (let i = 0; i < 100 && !/atelier add http/.test(out); i++) await sleep(50)
    assert.match(out, /atelier add http/, `serve never came up: ${out}`)
    const consumer = mkInstance()
    const r = cli(consumer, ['add', `http://127.0.0.1:${port}/app`])
    assert.equal(r.code, 0, r.out)
    assert.ok(fs.existsSync(path.join(consumer, 'app', 'frontend.jsx')))
    assert.ok(fs.existsSync(path.join(consumer, 'mychrome', 'frontend.jsx')))
  } finally {
    server.kill('SIGTERM')
  }
})
