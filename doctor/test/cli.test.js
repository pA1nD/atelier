// doctor/cli.mjs + report/write.mjs — the verb on the two fixture modules: exit 0, the --out layout, writes
// only under --out, refuses --out inside the corpus, refuses --write without --yes-corpus and on a dirty tree,
// --json is valid JSON, exit 2 on usage; cli.js dispatches `doctor` in ONE line (DESIGN §6, §8).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { run, parseArgs, readEnvKeyNames, UsageError } from '../cli.mjs'
import { applyWrite, canReplaceModuleJson, writeTargets, outInside, WriteRefused } from '../report/write.mjs'
import { HEADER } from '../report/columns.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const CORPUS = path.join(HERE, 'fixtures', 'report-corpus')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-cli-'))
const io = () => { const out = [], err = []; return { out, err, sinks: { stdout: (l) => out.push(l), stderr: (l) => err.push(l) } } }
const treeHash = (dir) => execFileSync('find', [dir, '-type', 'f', '-exec', 'stat', '-f', '%N %m %z', '{}', ';'], { encoding: 'utf8' }).split('\n').sort().join('\n')

test('parseArgs: defaults, every flag, usage errors', () => {
  assert.deepEqual(parseArgs([]), { dir: null, out: './doctor-out', write: false, yesCorpus: false, json: false, noProbe: false, chrome: null, envKeys: null, jobs: 8 })
  assert.deepEqual(parseArgs(['/c', '--out', '/o', '--write', '--yes-corpus', '--json', '--no-probe', '--chrome', '/ch', '--env-keys', '/e', '--jobs', '2']), { dir: '/c', out: '/o', write: true, yesCorpus: true, json: true, noProbe: true, chrome: '/ch', envKeys: '/e', jobs: 2 })
  assert.throws(() => parseArgs(['--bogus']), UsageError)
  assert.throws(() => parseArgs(['--out']), UsageError)
  assert.throws(() => parseArgs(['a', 'b']), UsageError)
})

test('readEnvKeyNames: names only, values never', () => {
  const d = tmp()
  fs.writeFileSync(path.join(d, '.env'), '# c\nCF_API_TOKEN=secret-value\nexport SEATS_AERO="x=y"\n  SPACES_PORT=7402\nnot a key\n')
  assert.deepEqual([...readEnvKeyNames(path.join(d, '.env'))], ['CF_API_TOKEN', 'SEATS_AERO', 'SPACES_PORT'])
})

test('corpus run --no-probe: exit 0, the --out layout, the corpus untouched, the table and VERDICT printed', async () => {
  const out = path.join(tmp(), 'out')
  const before = treeHash(CORPUS)
  const { out: lines, err, sinks } = io()
  const code = await run([CORPUS, '--out', out, '--no-probe'], sinks)
  assert.equal(code, 0)
  assert.equal(treeHash(CORPUS), before)
  const od = path.join(out, 'doctor')
  assert.deepEqual(fs.readdirSync(od).sort(), ['hello-clean', 'legacy-data', 'modules.md', 'portability.csv', 'rows.md', 'summary.json', 'verdict.txt'])
  for (const m of ['hello-clean', 'legacy-data']) {
    const files = fs.readdirSync(path.join(od, m)).sort()
    assert.ok(files.includes('report.json') && files.includes('config-keys.json'), files.join(','))
    const r = JSON.parse(fs.readFileSync(path.join(od, m, 'report.json'), 'utf8'))
    assert.equal(r.module, m)
    assert.equal(r.runtime.state, 'skipped')
    assert.ok(['BREAKS', 'DEGRADES', 'CLEAN'].includes(r.verdict.level))
    const ck = JSON.parse(fs.readFileSync(path.join(od, m, 'config-keys.json'), 'utf8'))
    assert.deepEqual(Object.keys(ck), ['operator', 'config', 'shell', 'laptop'])
  }
  const csv = fs.readFileSync(path.join(od, 'portability.csv'), 'utf8').trimEnd().split('\n')
  assert.equal(csv[0], HEADER)
  assert.deepEqual(csv.slice(1).map((l) => l.split(',')[0]), ['hello-clean', 'legacy-data'])
  const verdict = fs.readFileSync(path.join(od, 'verdict.txt'), 'utf8').trimEnd()
  assert.match(verdict, /^VERDICT: DOCTOR \d\/2 clean, \d degrade, \d break in the fleet \(0\/0 daily\); module\.json \d\/2; rewrites \d+ edits in \d+ modules; probe 0\/2 mounted, 0 broken at mount \[\]; tailwind max n\/a$/)
  assert.equal(lines.at(-1), verdict)
  assert.equal(lines.filter((l) => l.startsWith('DOCTOR ')).length, 2)
  assert.ok(lines.some((l) => l.startsWith('| row | family | break | modules /2 | daily /0 |')))
  const summary = JSON.parse(fs.readFileSync(path.join(od, 'summary.json'), 'utf8'))
  assert.equal(summary.modules, 2)
  assert.ok(Array.isArray(summary.stubbedLanes))
  if (summary.stubbedLanes.length) assert.ok(err.some((l) => l.startsWith('doctor: stubbed lanes')))
  assert.ok(err.some((l) => /N2op/.test(l)))
})

test('single-module run: one row; --json prints valid JSON on stdout and the lines on stderr', async () => {
  const out = path.join(tmp(), 'out')
  const { out: lines, err, sinks } = io()
  const code = await run([path.join(CORPUS, 'legacy-data'), '--out', out, '--no-probe', '--json'], sinks)
  assert.equal(code, 0)
  const s = JSON.parse(lines.join('\n'))
  assert.equal(s.modules, 1)
  assert.ok(err.some((l) => l.startsWith('DOCTOR legacy-data skipped ')))
  assert.ok(err.some((l) => l.startsWith('VERDICT: DOCTOR ')))
  assert.deepEqual(fs.readdirSync(path.join(out, 'doctor')).filter((n) => !n.includes('.')), ['legacy-data'])
})

test('usage: --out inside the corpus, --write over a corpus without --yes-corpus, a non-directory → exit 2', async () => {
  const { sinks, err } = io()
  assert.equal(await run([CORPUS, '--out', path.join(CORPUS, 'doctor-out'), '--no-probe'], sinks), 2)
  assert.match(err.at(-1), /lies inside the judged folder/)
  assert.equal(await run([CORPUS, '--out', tmp(), '--no-probe', '--write'], sinks), 2)
  assert.match(err.at(-1), /--yes-corpus/)
  assert.equal(await run([path.join(tmp(), 'nope'), '--no-probe'], sinks), 2)
  assert.equal(await run(['--bogus'], sinks), 2)
  assert.equal(await run([CORPUS, '--out', tmp(), '--no-probe', '--env-keys', '/nonexistent/.env'], sinks), 2)
  assert.equal(outInside('/a/b/out', ['/a/b']), '/a/b')
  assert.equal(outInside('/a/bout', ['/a/b']), null)
})

test('applyWrite: refused outside git and on a dirty tree; applies on a clean tree; module.json only replaced for the N11 drop', () => {
  const d = tmp()
  const app = path.join(d, 'app')
  fs.mkdirSync(app)
  fs.writeFileSync(path.join(app, 'backend.js'), 'old\n')
  const rewrites = [{ file: 'backend.js', text: 'new\n', edits: [{ line: 1, from: 'old', to: 'new' }] }]
  const moduleJson = { name: 'A', icon: 'x' }
  assert.throws(() => applyWrite({ dir: app, moduleJson, rewrites }), WriteRefused)
  execFileSync('git', ['-C', d, 'init', '-q'])
  execFileSync('git', ['-C', d, 'add', '.'])
  execFileSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base'])
  fs.appendFileSync(path.join(app, 'backend.js'), 'dirty\n')
  assert.throws(() => applyWrite({ dir: app, moduleJson, rewrites }), /uncommitted changes .*backend\.js/)
  execFileSync('git', ['-C', d, 'checkout', '--', 'app/backend.js'])
  assert.deepEqual(applyWrite({ dir: app, moduleJson, rewrites }), ['backend.js', 'module.json'])
  assert.equal(fs.readFileSync(path.join(app, 'backend.js'), 'utf8'), 'new\n')
  assert.equal(fs.readFileSync(path.join(app, 'module.json'), 'utf8'), '{\n  "name": "A",\n  "icon": "x"\n}\n')
  // an existing module.json that differs by more than the N11 key drop is never overwritten
  fs.writeFileSync(path.join(app, 'module.json'), '{"name":"Other","icon":"x","visibility":"chat"}')
  assert.deepEqual(writeTargets({ dir: app, moduleJson, rewrites: [] }), [])
  fs.writeFileSync(path.join(app, 'module.json'), '{"name":"A","icon":"x","visibility":"chat"}')
  assert.deepEqual(writeTargets({ dir: app, moduleJson, rewrites: [] }), ['module.json'])
  assert.equal(canReplaceModuleJson('{"name":"A","icon":"x"}', moduleJson), false)   // no unknown key: nothing to drop
  assert.equal(canReplaceModuleJson('not json', moduleJson), false)
  // no targets → nothing happens, no git needed
  assert.deepEqual(applyWrite({ dir: path.join(tmp()), moduleJson: null, rewrites: [] }), [])
})

test('cli.js dispatches `doctor` in one line to ./doctor/cli.mjs; `node cli.js doctor --bogus` exits 2 with the usage', () => {
  const src = fs.readFileSync(path.join(REPO, 'cli.js'), 'utf8')
  assert.equal(src.split('\n').filter((l) => l.includes("['doctor', './doctor/cli.mjs']")).length, 1)
  const r = spawnSync(process.execPath, [path.join(REPO, 'cli.js'), 'doctor', '--bogus'], { encoding: 'utf8', cwd: REPO, timeout: 20000 })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /usage: atelier doctor/)
  const out = path.join(tmp(), 'out')
  const ok = spawnSync(process.execPath, [path.join(REPO, 'cli.js'), 'doctor', CORPUS, '--out', out, '--no-probe'], { encoding: 'utf8', cwd: REPO, timeout: 60000 })
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout.trimEnd().split('\n').at(-1), /^VERDICT: DOCTOR /)
})
