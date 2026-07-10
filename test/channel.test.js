// The channel vs. the outbox — reception and provenance follow the PUBLISHED
// channel (origin/HEAD), never the mirror's local branch. Locks the fix for
// the silent-overwrite bug: packaging into a subscribed mirror (an unpublished
// local cut) must never become the merge baseline, and a diverged mirror must
// keep receiving. Also locks publish's divergence recipe.
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
const sh = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8' })

function producer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-chan-prod-'))
  const dir = path.join(root, 'app')
  fs.mkdirSync(dir)
  const write = (version, fmarker, bmarker) => {
    fs.writeFileSync(path.join(dir, 'frontend.jsx'), `export default function App() { return <div>${fmarker}</div>; }\n`)
    fs.writeFileSync(path.join(dir, 'backend.js'), `export default { mountRoutes(router, ctx) { /* ${bmarker} */ } };\n`)
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', version }))
  }
  write('1.0.0', 'v1', 'v1')
  assert.equal(cli(root, ['package', 'app', '--yes']).code, 0)
  return { root, write, cut: () => assert.equal(cli(root, ['package', 'app', '--yes']).code, 0), coll: path.join(root, '_collections', 'app') }
}

const headOf = (repo) => sh('git', ['rev-parse', 'HEAD'], repo).stdout.trim()
const provOf = (root) => JSON.parse(fs.readFileSync(path.join(root, 'app', '.atelier'), 'utf8'))

test('unpublished local cuts never become the channel — no silent overwrite', () => {
  const p = producer()
  const c = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-chan-cons-'))
  assert.equal(cli(c, ['add', p.coll]).code, 0)

  // consumer edits the module, then cuts INTO THE MIRROR (unpublished outbox)
  fs.writeFileSync(path.join(c, 'app', 'frontend.jsx'),
    'export default function App() { return <div>MINE</div>; }\n')
  assert.equal(cli(c, ['package', 'app', '--yes']).code, 0)

  // update: channel unchanged → nothing to do; provenance must still point at
  // the PUBLISHED commit, not the consumer's own local cut
  const r = cli(c, ['update', 'app'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /unpublished local cut/)
  assert.match(r.out, /up to date/)
  assert.equal(provOf(c).commit, headOf(p.coll), 'provenance = published channel, never the outbox')
  assert.match(fs.readFileSync(path.join(c, 'app', 'frontend.jsx'), 'utf8'), /MINE/)

  // upstream publishes v2 (backend change — disjoint from consumer's edit)
  p.write('1.1.0', 'v1', 'v2'); p.cut()

  // reception works despite the diverged mirror branch; the edit is still
  // seen as a LOCAL EDIT → skipped without a flag, never silently overwritten
  const r2 = cli(c, ['update', 'app'])
  assert.equal(r2.code, 0, r2.out)
  assert.match(r2.out, /skipped — you have local edits/)
  assert.match(fs.readFileSync(path.join(c, 'app', 'frontend.jsx'), 'utf8'), /MINE/, 'the silent-overwrite bug')

  // and --merge brings both sides together
  const r3 = cli(c, ['update', 'app', '--merge'])
  assert.equal(r3.code, 0, r3.out)
  assert.match(fs.readFileSync(path.join(c, 'app', 'frontend.jsx'), 'utf8'), /MINE/, 'local edit survived')
  assert.match(fs.readFileSync(path.join(c, 'app', 'backend.js'), 'utf8'), /v2/, 'upstream change arrived')
  assert.equal(provOf(c).commit, headOf(p.coll), 'provenance advanced to the new published cut')
})

test('publish rejection prints the realign recipe (non-TTY: manual commands)', () => {
  const bare = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-chan-origin-')), 'app')
  sh('git', ['init', '-q', '--bare', bare])
  const p = producer()
  assert.equal(cli(p.root, ['publish', 'app', '--to', bare]).code, 0)

  const c = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-chan-cons2-'))
  assert.equal(cli(c, ['add', bare]).code, 0)
  fs.appendFileSync(path.join(c, 'app', 'backend.js'), '// my tweak\n')
  assert.equal(cli(c, ['package', 'app', '--yes']).code, 0)   // unpublished cut in the mirror

  p.write('1.1.0', 'v2', 'v1'); p.cut()
  assert.equal(cli(p.root, ['publish', 'app']).code, 0)        // upstream moves first

  const r = cli(c, ['publish', 'app'])                         // consumer's push must be rejected
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /push rejected/)
  assert.match(r.out, /package app --to app/)                  // recut hint names the module
  assert.match(r.out, /update-ref refs\/atelier\/discarded/)   // non-destructive keep-ref
  assert.match(r.out, /reset --hard/)

  // reception is unaffected by the divergence
  const r2 = cli(c, ['add', 'app'])
  assert.equal(r2.code, 0, r2.out)
  assert.match(r2.out, /unpublished local cut/)
})
