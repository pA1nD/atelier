// host/chrome/fetch.mjs — the chrome cache against a fake transport (DESIGN §6.4, §7; step 7 ship C decisions 7–8):
// verify (every sha, the recomputed digest, the required files, the paths), the cached fallback on a failed or refused
// fetch, the 15 s bound, temp + rename with the manifest last, `current` swapped, prune to current + previous, the
// serialized/coalesced `want()` and its `onSwap`.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureChrome, createChromeCache, currentOf, verifyBundle, verifyOnDisk, pruneChrome, writeBundle, CURRENT } from '../chrome/fetch.mjs'
import { chromeDigestOf, sha256Hex } from '../../protocol/index.js'

const bundle = (stamp = 'a') => ({
  'frontend.js': Buffer.from(`export function chrome() { return ${JSON.stringify(stamp)} }\n`),
  'kit.js': Buffer.from(`export const Button = ${JSON.stringify(stamp)}\n`),
  'styles.css': Buffer.from(`@font-face { src: url('fonts/Inter.woff2') } /* ${stamp} */\n`),
  'chrome.css': Buffer.from(`.rail{--stamp:${JSON.stringify(stamp)}}\n`),
  'fonts/Inter.woff2': Buffer.concat([Buffer.from('wOF2'), Buffer.from(stamp)]),
})
const digestOf = (files) => chromeDigestOf(Object.fromEntries(Object.entries(files).map(([p, b]) => [p, sha256Hex(b)])))
const answerOf = (files, { digest, version = '0.2.2' } = {}) => ({ digest: digest ?? digestOf(files), version, files: Object.fromEntries(Object.entries(files).map(([p, b]) => [p, b.toString('base64')])) })
// a transport: `answers` digest → the answer | an Error | a never-resolving promise; every call recorded
function fakeTransport(answers = {}) {
  const calls = []
  return { calls, answers, chrome: async (digest) => { calls.push(digest); const a = answers[digest]; if (a === undefined) { const e = new Error('spine 404 unknown-digest'); e.status = 404; e.body = { error: 'unknown-digest' }; throw e } if (a instanceof Error) throw a; return typeof a === 'function' ? a() : a } }
}
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-cache-')))
const mode = (p) => fs.statSync(p).mode & 0o777
const link = (cache) => { try { return fs.readlinkSync(path.join(cache, CURRENT)) } catch { return null } }

test('verifyBundle: the shas and the recomputed digest end to end; a wrong byte, a missing required file, a bad path, a foreign digest in the answer are refused', () => {
  const files = bundle()
  const D = digestOf(files)
  const ok = verifyBundle(D, answerOf(files))
  assert.equal(ok.error, undefined); assert.equal(ok.version, '0.2.2'); assert.deepEqual([...ok.files.keys()].sort(), ['chrome.css', 'fonts/Inter.woff2', 'frontend.js', 'kit.js', 'styles.css'])
  const tampered = answerOf(files); tampered.files['kit.js'] = Buffer.from('export const Button = "evil"\n').toString('base64')
  assert.match(verifyBundle(D, tampered).error, /digest mismatch/)
  const { 'chrome.css': _, ...incomplete } = files
  assert.match(verifyBundle(digestOf(incomplete), answerOf(incomplete)).error, /incomplete: missing chrome\.css/)
  assert.match(verifyBundle(D, answerOf({ ...files, '../x.js': Buffer.from('1') }, { digest: D })).error, /bad path/)
  assert.match(verifyBundle(D, answerOf({ ...files, 'manifest.json': Buffer.from('{}') }, { digest: D })).error, /bad path manifest\.json/)
  assert.match(verifyBundle(D, answerOf(files, { digest: 'f'.repeat(64) })).error, /names digest/)
  assert.match(verifyBundle(D, { digest: D }).error, /no files/)
  assert.match(verifyBundle(D, { digest: D, files: { 'kit.js': 7 } }).error, /not base64/)
})

test('ensureChrome: fetches, verifies, writes temp+rename (dirs 0755, files 0644, manifest last with the shas), swaps `current`; the same digest again is a no-op without a fetch; a second digest swaps and keeps the previous; a third prunes the oldest; a digest already on disk swaps without a fetch', async () => {
  const cache = path.join(tmp(), 'chrome')
  const A = bundle('a'), B = bundle('b'), C = bundle('c')
  const dA = digestOf(A), dB = digestOf(B), dC = digestOf(C)
  const t = fakeTransport({ [dA]: answerOf(A), [dB]: answerOf(B), [dC]: answerOf(C, { version: '0.3.0' }) })
  const logs = []
  const r1 = await ensureChrome({ digest: dA, transport: t, cache, log: (l) => logs.push(l) })
  assert.deepEqual(r1, { dir: path.join(cache, dA), digest: dA, fetched: true })
  assert.equal(link(cache), dA); assert.deepEqual(currentOf(cache), { digest: dA, dir: path.join(cache, dA) })
  assert.equal(mode(cache), 0o755); assert.equal(mode(path.join(cache, dA)), 0o755); assert.equal(mode(path.join(cache, dA, 'fonts')), 0o755)
  assert.equal(mode(path.join(cache, dA, 'kit.js')), 0o644); assert.equal(mode(path.join(cache, dA, 'fonts', 'Inter.woff2')), 0o644); assert.equal(mode(path.join(cache, dA, 'manifest.json')), 0o644)
  const m = JSON.parse(fs.readFileSync(path.join(cache, dA, 'manifest.json'), 'utf8'))
  assert.equal(m.digest, dA); assert.equal(m.version, '0.2.2'); assert.deepEqual(m.files['kit.js'], { sha256: sha256Hex(A['kit.js']), bytes: A['kit.js'].length })
  assert.equal(fs.readFileSync(path.join(cache, dA, 'chrome.css'), 'utf8'), A['chrome.css'].toString())
  assert.ok(!fs.readdirSync(cache).some((n) => n.startsWith('.tmp-')), 'no temp dir left')
  assert.equal(t.calls.length, 1)
  assert.deepEqual(await ensureChrome({ digest: dA, transport: t, cache }), { dir: path.join(cache, dA), digest: dA, fetched: false })
  assert.equal(t.calls.length, 1, 'the held digest is never fetched again')
  const r2 = await ensureChrome({ digest: dB, transport: t, cache, log: (l) => logs.push(l) })
  assert.equal(r2.digest, dB); assert.equal(r2.fetched, true); assert.equal(link(cache), dB)
  assert.ok(fs.existsSync(path.join(cache, dA, 'manifest.json')), 'the previous bundle is kept')
  const r3 = await ensureChrome({ digest: dC, transport: t, cache, log: (l) => logs.push(l) })
  assert.equal(r3.digest, dC); assert.equal(link(cache), dC)
  assert.deepEqual(fs.readdirSync(cache).filter((n) => /^[0-9a-f]{64}$/.test(n)).sort(), [dB, dC].sort(), 'pruned to current + previous')
  assert.ok(logs.some((l) => l.includes('pruned 1')), logs.join('\n'))
  // back to B: on disk already — a swap, no fetch
  const calls = t.calls.length
  const r4 = await ensureChrome({ digest: dB, transport: t, cache })
  assert.deepEqual(r4, { dir: path.join(cache, dB), digest: dB, fetched: false }); assert.equal(link(cache), dB); assert.equal(t.calls.length, calls)
})

test('ensureChrome: a fetch failure (404, a network error, a timeout past the bound) and a REFUSED bundle (a tampered byte, a foreign digest) keep `current` — the cached fallback — and say why; with no cache at all the answer is no dir; a bad digest is refused before any call', async () => {
  const cache = path.join(tmp(), 'chrome')
  const A = bundle('a'), B = bundle('b')
  const dA = digestOf(A), dB = digestOf(B), dX = 'f'.repeat(64)
  const tampered = answerOf(B); tampered.files['frontend.js'] = Buffer.from('evil').toString('base64')
  const logs = []
  const t = fakeTransport({ [dA]: answerOf(A), [dB]: tampered, [dX]: () => new Promise(() => {}) })
  // nothing cached yet: a refused fetch is no dir, no throw
  const r0 = await ensureChrome({ digest: dB, transport: t, cache, log: (l) => logs.push(l) })
  assert.deepEqual({ dir: r0.dir, digest: r0.digest, fetched: r0.fetched }, { dir: null, digest: null, fetched: false }); assert.match(r0.error, /digest mismatch/)
  assert.equal(currentOf(cache), null); assert.ok(!fs.existsSync(path.join(cache, dB)), 'nothing written for a refused bundle')
  await ensureChrome({ digest: dA, transport: t, cache, log: (l) => logs.push(l) })
  assert.equal(link(cache), dA)
  for (const [digest, why] of [[dB, /digest mismatch/], ['0'.repeat(64), /spine 404/], [dX, /no answer within 20 ms/]]) {
    const r = await ensureChrome({ digest, transport: t, cache, log: (l) => logs.push(l), fetchMs: 20 })
    assert.deepEqual({ dir: r.dir, digest: r.digest, fetched: r.fetched }, { dir: path.join(cache, dA), digest: dA, fetched: false }, String(why))
    assert.match(r.error, why)
    assert.equal(link(cache), dA, 'current kept')
  }
  const net = fakeTransport({ [dB]: new Error('ECONNREFUSED') })
  const r = await ensureChrome({ digest: dB, transport: net, cache, log: (l) => logs.push(l) })
  assert.equal(r.digest, dA); assert.match(r.error, /ECONNREFUSED/)
  assert.ok(logs.some((l) => /fetch .* failed \(ECONNREFUSED\) — keeping/.test(l)), logs.join('\n'))
  assert.ok(logs.some((l) => /REFUSED \(digest mismatch/.test(l)), logs.join('\n'))
  const bad = await ensureChrome({ digest: 'nope', transport: net, cache })
  assert.equal(bad.digest, dA); assert.match(bad.error, /not a digest/); assert.equal(net.calls.length, 1)
})

test('createChromeCache: no answer / null → nothing; dir() is the fixed folder until a release is held, then the cache\'s current; want() is serialized and coalesced (the last wanted digest wins), onSwap(digest, prev) once per swap with base() and digest() already moved; a refused want keeps the held one and swaps nothing; a boot with `current` on disk holds it at once and sweeps a stale temp dir', async () => {
  const root = tmp(), cache = path.join(root, 'chrome'), fixed = path.join(root, 'opt-chrome')
  fs.mkdirSync(fixed)
  const A = bundle('a'), B = bundle('b'), C = bundle('c')
  const dA = digestOf(A), dB = digestOf(B), dC = digestOf(C)
  let release
  const slow = new Promise((r) => { release = r })
  const t = fakeTransport({ [dA]: answerOf(A), [dB]: () => slow.then(() => answerOf(B)), [dC]: answerOf(C) })
  const swaps = [], logs = []
  const cc = createChromeCache({ cache, fixedDir: fixed, transport: t, log: (l) => logs.push(l), onSwap: (d, p) => swaps.push([d, p, cc.digest(), cc.base()]) })
  assert.equal(cc.dir(), fixed); assert.equal(cc.digest(), null); assert.equal(cc.base(), null)
  cc.want(null); cc.want({ digest: 'x' }); cc.want(undefined)
  await cc.settle()
  assert.deepEqual(t.calls, []); assert.equal(cc.dir(), fixed)
  cc.want({ digest: dA, version: '0.2.2' })
  await cc.settle()
  assert.equal(cc.dir(), path.join(cache, dA)); assert.equal(cc.digest(), dA); assert.equal(cc.base(), `/_chrome/${dA}`); assert.equal(cc.version(), '0.2.2')
  assert.deepEqual(swaps, [[dA, null, dA, `/_chrome/${dA}`]])
  // B is slow; C arrives meanwhile → after B lands, C is fetched and wins (one swap each, in order)
  cc.want({ digest: dB, version: '0.2.3' })
  await new Promise((r) => setTimeout(r, 5))
  cc.want({ digest: dC, version: '0.3.0' })
  cc.want({ digest: dC, version: '0.3.0' })
  release()
  await cc.settle()
  assert.equal(cc.digest(), dC); assert.equal(cc.version(), '0.3.0')
  assert.deepEqual(swaps.map((s) => [s[0], s[1]]), [[dA, null], [dB, dA], [dC, dB]])
  assert.deepEqual(t.calls, [dA, dB, dC])
  // a refused want (unknown at the spine) keeps C
  cc.want({ digest: 'f'.repeat(64) })
  await cc.settle()
  assert.equal(cc.digest(), dC); assert.equal(swaps.length, 3)
  // the same digest again: no fetch, no swap
  cc.want({ digest: dC, version: '0.3.0' })
  await cc.settle()
  assert.equal(t.calls.length, 4); assert.equal(swaps.length, 3)
  // a new host life: current is held from the start, no fetch; a temp dir a dead life left is swept, the previous kept
  fs.mkdirSync(path.join(cache, '.tmp-deadbeef-1'))
  const t2 = fakeTransport({})
  const cc2 = createChromeCache({ cache, fixedDir: fixed, transport: t2, onSwap: () => {} })
  assert.equal(cc2.digest(), dC); assert.equal(cc2.dir(), path.join(cache, dC))
  assert.ok(!fs.existsSync(path.join(cache, '.tmp-deadbeef-1')))
  assert.deepEqual(fs.readdirSync(cache).filter((n) => /^[0-9a-f]{64}$/.test(n)).sort(), [dB, dC].sort())
  cc2.want({ digest: dC })
  await cc2.settle()
  assert.deepEqual(t2.calls, [])
  // open(): a cached bundle's file when its manifest names it
  assert.equal(cc2.open(dC, 'kit.js').toString(), C['kit.js'].toString()); assert.equal(cc2.open(dC, 'manifest.json'), null); assert.equal(cc2.open(dC, 'nope.js'), null); assert.equal(cc2.open('0'.repeat(64), 'kit.js'), null)
  // an onSwap that throws is logged, never unhandled
  const cc3 = createChromeCache({ cache, transport: fakeTransport({ [dA]: answerOf(A) }), log: (l) => logs.push(l), onSwap: () => { throw new Error('boom') } })
  cc3.want({ digest: dA }); await cc3.settle()
  assert.equal(cc3.digest(), dA); assert.ok(logs.some((l) => l.includes('after swap') && l.includes('boom')))
})

test('writeBundle / pruneChrome: a bundle already there is left alone (false); prune keeps `current`, the kept digests and everything that is not a bundle', () => {
  const cache = path.join(tmp(), 'chrome')
  fs.mkdirSync(cache, { recursive: true })
  const A = bundle('a'); const dA = digestOf(A)
  const v = verifyBundle(dA, answerOf(A))
  assert.equal(writeBundle(cache, dA, v), true)
  assert.equal(writeBundle(cache, dA, v), false)
  fs.mkdirSync(path.join(cache, 'b'.repeat(64))); fs.writeFileSync(path.join(cache, 'notes.txt'), 'x'); fs.mkdirSync(path.join(cache, '.tmp-x'))
  assert.deepEqual(pruneChrome(cache, [dA]), ['b'.repeat(64)])
  assert.deepEqual(fs.readdirSync(cache).sort(), [dA, 'notes.txt'].sort())
})

test('built(): the REPORTED digest moves only when onSwap/onHold settle complete (review 2026-09-02, S2) — an incomplete swap keeps reporting the previous digest while the new one is held, every later want at the held digest retries through onHold, onBuilt fires once per move; a hook that throws changes nothing', async () => {
  const cache = path.join(tmp(), 'chrome')
  const A = bundle('a'), B = bundle('b')
  const dA = digestOf(A), dB = digestOf(B)
  const t = fakeTransport({ [dA]: answerOf(A), [dB]: answerOf(B) })
  let verdict = { complete: true }
  const swaps = [], holds = [], builts = [], logs = []
  const cc = createChromeCache({ cache, transport: t, log: (l) => logs.push(l), onSwap: (d, p) => { swaps.push([d, p]); return verdict }, onHold: (d, p) => { holds.push([d, p]); return verdict }, onBuilt: (d, p) => builts.push([d, p, cc.built()]) })
  assert.equal(cc.built(), null)
  cc.want({ digest: dA }); await cc.settle()
  assert.equal(cc.digest(), dA); assert.equal(cc.built(), dA); assert.deepEqual(builts, [[dA, null, dA]]); assert.deepEqual(swaps, [[dA, null]]); assert.deepEqual(holds, [])
  // B lands but the rebuild is incomplete (a row skipped): B is held, A is reported — D over a PREV sheet cannot happen
  verdict = { complete: false }
  cc.want({ digest: dB }); await cc.settle()
  assert.equal(cc.digest(), dB); assert.equal(cc.base(), `/_chrome/${dB}`); assert.equal(cc.built(), dA, 'held B, reporting A'); assert.equal(builts.length, 1)
  // the next beats name B again: onHold retries with the reported digest as `prev`; still incomplete → still A
  cc.want({ digest: dB }); await cc.settle()
  cc.want({ digest: dB }); await cc.settle()
  assert.deepEqual(holds, [[dB, dA], [dB, dA]]); assert.equal(cc.built(), dA); assert.equal(t.calls.length, 2, 'no refetch of a held digest')
  verdict = undefined   // "nothing to say" is complete
  cc.want({ digest: dB }); await cc.settle()
  assert.equal(cc.built(), dB); assert.deepEqual(builts, [[dA, null, dA], [dB, dA, dB]])
  // everything built: onHold still runs (a row can fall behind later — adopted, rolled back), built stays, onBuilt is silent
  cc.want({ digest: dB }); await cc.settle()
  assert.equal(holds.length, 4); assert.equal(builts.length, 2); assert.equal(cc.built(), dB)
  // a hook that throws: logged, nothing moves
  const cc2 = createChromeCache({ cache: path.join(tmp(), 'chrome'), transport: fakeTransport({ [dA]: answerOf(A) }), log: (l) => logs.push(l), onSwap: () => { throw new Error('boom') }, onHold: () => { throw new Error('hold-boom') } })
  cc2.want({ digest: dA }); await cc2.settle()
  assert.equal(cc2.digest(), dA); assert.equal(cc2.built(), null)
  cc2.want({ digest: dA }); await cc2.settle()
  assert.equal(cc2.built(), null); assert.ok(logs.some((l) => l.includes('after swap') && l.includes('boom')) && logs.some((l) => l.includes('after hold') && l.includes('hold-boom')), logs.join('\n'))
})

test('a bundle on disk is verified before it is swapped to or adopted (review 2026-09-02, Codex 2): a corrupt file, a manifest without a sha, a missing required file — the dir is removed and fetched again; a corrupt `current` is not adopted at boot; open() never reads a prototype name', async () => {
  const cache = path.join(tmp(), 'chrome')
  const A = bundle('a'), B = bundle('b')
  const dA = digestOf(A), dB = digestOf(B)
  const t = fakeTransport({ [dA]: answerOf(A), [dB]: answerOf(B) })
  const logs = []
  await ensureChrome({ digest: dA, transport: t, cache }); await ensureChrome({ digest: dB, transport: t, cache })
  assert.equal(link(cache), dB); assert.equal(t.calls.length, 2)
  assert.equal(verifyOnDisk(path.join(cache, dA), dA), true)
  // A (cached, not current) gets a byte flipped: swapping back to A refetches it instead of trusting the manifest
  fs.writeFileSync(path.join(cache, dA, 'kit.js'), 'export const Button = "evil"\n')
  assert.equal(verifyOnDisk(path.join(cache, dA), dA), false)
  const r = await ensureChrome({ digest: dA, transport: t, cache, log: (l) => logs.push(l) })
  assert.equal(r.digest, dA); assert.equal(r.fetched, true); assert.equal(t.calls.length, 3, 'fetched again'); assert.equal(link(cache), dA)
  assert.equal(fs.readFileSync(path.join(cache, dA, 'kit.js'), 'utf8'), A['kit.js'].toString(), 'the good bytes are back')
  assert.ok(logs.some((l) => /on disk does not verify — removed, fetching again/.test(l)), logs.join('\n'))
  // a manifest that names a file without a sha, or lacks a required file, does not verify either
  const m = JSON.parse(fs.readFileSync(path.join(cache, dA, 'manifest.json'), 'utf8'))
  fs.writeFileSync(path.join(cache, dA, 'manifest.json'), JSON.stringify({ ...m, files: { ...m.files, 'kit.js': { bytes: 1 } } }))
  assert.equal(verifyOnDisk(path.join(cache, dA), dA), false)
  const { 'chrome.css': _, ...rest } = m.files
  fs.writeFileSync(path.join(cache, dA, 'manifest.json'), JSON.stringify({ ...m, files: rest }))
  assert.equal(verifyOnDisk(path.join(cache, dA), dA), false)
  fs.writeFileSync(path.join(cache, dA, 'manifest.json'), JSON.stringify(m))
  assert.equal(verifyOnDisk(path.join(cache, dA), dA), true)
  // `current` (A) corrupted on disk: a new host life does not adopt it — no chrome dir until the next want refetches
  fs.writeFileSync(path.join(cache, dA, 'chrome.css'), '.evil{}')
  assert.equal(currentOf(cache), null)
  const cc = createChromeCache({ cache, transport: t, log: (l) => logs.push(l), onSwap: () => {} })
  assert.equal(cc.digest(), null); assert.equal(cc.dir(), null)
  cc.want({ digest: dA }); await cc.settle()
  assert.equal(cc.digest(), dA); assert.equal(t.calls.length, 4); assert.equal(verifyOnDisk(path.join(cache, dA), dA), true)
  // open(): a prototype name is not a manifest path
  for (const p of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.equal(cc.open(dA, p), null, p)
})
