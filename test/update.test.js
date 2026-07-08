// atelier update — the merge-aware upgrade verb, exercised through the real
// CLI. Locks the contract: no local edits → gated swap; local edits + no
// flags + no TTY → skip and report (an agent never chooses); --merge lands a
// verified-clean merge but STAGES true conflicts (never markers in the live
// module, never auto-picked sides); --overwrite takes the cut as published;
// --continue gates and lands a resolved staging; live data/ survives every
// path; provenance advances with each landing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(HERE, '..', 'cli.js')

function cli(root, args) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ATELIER_ROOT: root, GIT_TERMINAL_PROMPT: '0' },
  })
  return { code: res.status, out: (res.stdout || '') + (res.stderr || '') }
}

// producer instance with module `app`; returns helpers to cut new versions
function producer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-upd-prod-'))
  const dir = path.join(root, 'app')
  fs.mkdirSync(dir)
  const write = (version, frontendBody, backendBody) => {
    fs.writeFileSync(path.join(dir, 'frontend.jsx'),
      `export default function App() { return <div>${frontendBody}</div>; }\n`)
    fs.writeFileSync(path.join(dir, 'backend.js'),
      `export default { mountRoutes(router, ctx) { /* ${backendBody} */ } };\n`)
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', version }))
  }
  const cut = () => {
    const r = cli(root, ['package', 'app', '--yes'])
    assert.equal(r.code, 0, r.out)
  }
  write('1.0.0', 'v1', 'v1')
  cut()
  return { root, dir, write, cut, coll: path.join(root, '_collections', 'app') }
}

function consumerOf(p) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-upd-cons-'))
  const r = cli(root, ['add', p.coll])
  assert.equal(r.code, 0, r.out)
  // live runtime state, created after install — must survive every update path
  fs.mkdirSync(path.join(root, 'app', 'data'), { recursive: true })
  fs.writeFileSync(path.join(root, 'app', 'data', 'state.json'), '{"mine":true}')
  return root
}

const frontendOf = (root) => fs.readFileSync(path.join(root, 'app', 'frontend.jsx'), 'utf8')
const backendOf = (root) => fs.readFileSync(path.join(root, 'app', 'backend.js'), 'utf8')
const provOf = (root) => JSON.parse(fs.readFileSync(path.join(root, 'app', '.atelier'), 'utf8'))

test('clean update: gated swap, provenance advances, data/ survives', () => {
  const p = producer()
  const c = consumerOf(p)
  p.write('1.1.0', 'v2', 'v1'); p.cut()
  const r = cli(c, ['update', 'app'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /1\.0\.0 → 1\.1\.0/)
  assert.match(r.out, /no local edits/)
  assert.match(frontendOf(c), /v2/)
  assert.equal(fs.readFileSync(path.join(c, 'app', 'data', 'state.json'), 'utf8'), '{"mine":true}')
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: p.coll, encoding: 'utf8' }).stdout.trim()
  assert.equal(provOf(c).commit, head, 'provenance = mirror HEAD')
  // idempotent: run again → up to date, nothing rewritten
  const r2 = cli(c, ['update'])
  assert.equal(r2.code, 0, r2.out)
  assert.match(r2.out, /up to date/)
})

test('local edits + no flag + no TTY → skipped and reported, module untouched', () => {
  const p = producer()
  const c = consumerOf(p)
  fs.appendFileSync(path.join(c, 'app', 'backend.js'), '// my local tweak\n')
  p.write('1.1.0', 'v2', 'v1'); p.cut()
  const r = cli(c, ['update', 'app'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /skipped — you have local edits/)
  assert.match(frontendOf(c), /v1/, 'nothing changed')
  assert.match(backendOf(c), /my local tweak/)
})

test('--merge lands a clean merge: upstream change + local edit both survive', () => {
  const p = producer()
  const c = consumerOf(p)
  fs.appendFileSync(path.join(c, 'app', 'backend.js'), '// my local tweak\n')   // local: backend
  p.write('1.1.0', 'v2', 'v1'); p.cut()                                        // upstream: frontend
  const r = cli(c, ['update', 'app', '--merge'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /edited file.*kept|kept/)
  assert.match(frontendOf(c), /v2/, 'upstream change arrived')
  assert.match(backendOf(c), /my local tweak/, 'local edit survived')
  assert.equal(fs.readFileSync(path.join(c, 'app', 'data', 'state.json'), 'utf8'), '{"mine":true}')
})

test('--overwrite takes the cut as published, discarding edits (data/ still survives)', () => {
  const p = producer()
  const c = consumerOf(p)
  // conflicting edit on the same file upstream also changes
  fs.writeFileSync(path.join(c, 'app', 'frontend.jsx'),
    'export default function App() { return <div>mine</div>; }\n')
  p.write('1.1.0', 'v2', 'v1'); p.cut()
  const r = cli(c, ['update', 'app', '--overwrite'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /overwritten — your edits discarded/)
  assert.match(frontendOf(c), /v2/)
  assert.ok(!/mine/.test(frontendOf(c)))
  assert.equal(fs.readFileSync(path.join(c, 'app', 'data', 'state.json'), 'utf8'), '{"mine":true}')
})

test('conflict lifecycle: --merge stages, abort restores, re-stage, resolve, --continue lands', () => {
  const p = producer()
  const c = consumerOf(p)
  fs.writeFileSync(path.join(c, 'app', 'frontend.jsx'),
    'export default function App() { return <div>mine</div>; }\n')             // same line as upstream
  p.write('1.1.0', 'v2', 'v1'); p.cut()

  // --merge cannot auto-pick a side → stages the half-merged tree, exit 1
  const r = cli(c, ['update', 'app', '--merge'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /staged:/)
  assert.match(r.out, /--continue/)
  const stagingDir = path.join(c, 'app', '.update-merge')
  assert.ok(fs.existsSync(path.join(stagingDir, '.state.json')))
  assert.match(fs.readFileSync(path.join(stagingDir, 'frontend.jsx'), 'utf8'), /^<{7} /m, 'markers live in staging')
  assert.match(frontendOf(c), /mine/, 'live module untouched — still running the old version')

  // a second update refuses to double-stage
  const rPend = cli(c, ['update', 'app', '--merge'])
  assert.match(rPend.out, /staged merge pending/)

  // abort discards the staging, module unchanged
  const rAbort = cli(c, ['update', 'app/app', '--abort'])
  assert.equal(rAbort.code, 0, rAbort.out)
  assert.ok(!fs.existsSync(stagingDir))
  assert.match(frontendOf(c), /mine/)

  // stage again, refuse --continue while markers remain, then resolve and land
  assert.equal(cli(c, ['update', 'app', '--merge']).code, 1)
  const rEarly = cli(c, ['update', 'app/app', '--continue'])
  assert.notEqual(rEarly.code, 0)
  assert.match(rEarly.out, /conflict markers still present/)
  fs.writeFileSync(path.join(stagingDir, 'frontend.jsx'),
    'export default function App() { return <div>v2 and mine</div>; }\n')
  const rCont = cli(c, ['update', 'app/app', '--continue'])
  assert.equal(rCont.code, 0, rCont.out)
  assert.ok(!fs.existsSync(stagingDir), 'staging cleared after landing')
  assert.match(frontendOf(c), /v2 and mine/)
  assert.equal(fs.readFileSync(path.join(c, 'app', 'data', 'state.json'), 'utf8'), '{"mine":true}')
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: p.coll, encoding: 'utf8' }).stdout.trim()
  assert.equal(provOf(c).commit, head, 'provenance advanced to the merged-in cut')
  // and now everything is current
  assert.match(cli(c, ['update']).out, /up to date/)
})

test('a new cut that does not build here is refused, running version untouched', () => {
  const p = producer()
  const c = consumerOf(p)
  // producer force-lands a broken cut by writing directly into the collection
  // (bypassing package's gate — simulating a bad actor / hand-edited repo)
  fs.writeFileSync(path.join(p.coll, 'app', 'backend.js'), 'export default { broken(\n')
  fs.writeFileSync(path.join(p.coll, 'app', 'package.json'), JSON.stringify({ name: 'app', version: '9.9.9' }))
  spawnSync('git', ['add', '-A'], { cwd: p.coll })
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'bad'], { cwd: p.coll })
  const r = cli(c, ['update', 'app'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /doesn't build here — skipped/)
  assert.match(backendOf(c), /mountRoutes/, 'running version untouched')
})
