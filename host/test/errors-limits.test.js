// errors/limits.mjs — 512M refused, default 1 GiB, core 0, the --max-old-space-size and RSS-cap formulas.
import test from 'node:test'
import assert from 'node:assert/strict'
import { rlimitsFor, maxOldSpaceMb, nodeArgv, rssCapKb, MB, RLIMIT_DATA_DEFAULT, RLIMIT_DATA_FLOOR, fmtMb } from '../errors/limits.mjs'
import { prlimitArgv } from '../adapters/os.mjs'

test('rlimitsFor: default 1 GiB data, core 0, nproc 64, nofile 1024 — never RLIMIT_AS', () => {
  assert.deepEqual(rlimitsFor('i-a'), { data: 1073741824, core: 0, nproc: 64, nofile: 1024 })
  assert.equal(RLIMIT_DATA_DEFAULT, 1024 * MB); assert.equal(RLIMIT_DATA_FLOOR, 1024 * MB)
  assert.deepEqual(prlimitArgv(rlimitsFor('i-a')), ['prlimit', '--data=1073741824', '--core=0', '--nproc=64', '--nofile=1024', '--'])
  assert.equal('as' in rlimitsFor('i-a'), false)
})

test('a data limit below the floor is a RangeError: 512M aborts node at boot', () => {
  assert.throws(() => rlimitsFor('i-a', { data: 512 * MB }), (e) => e instanceof RangeError && /512M for i-a is below the 1024M floor/.test(e.message))
  assert.throws(() => rlimitsFor('i-a', { data: 1024 * MB - 1 }), RangeError)
  assert.throws(() => rlimitsFor('i-a', { data: '1024M' }), RangeError)
  assert.equal(rlimitsFor('i-a', { data: 1536 * MB }).data, 1536 * MB)
})

test('--max-old-space-size = (data − 576 MB) × 0.85 in MB, min 256', () => {
  assert.equal(maxOldSpaceMb(), 380)
  assert.equal(maxOldSpaceMb(1536 * MB), 816)
  assert.equal(maxOldSpaceMb(700 * MB), 256)
  assert.deepEqual(nodeArgv(), ['--max-old-space-size=380'])
  assert.deepEqual(nodeArgv(rlimitsFor('i-a', { data: 2048 * MB })), ['--max-old-space-size=1251'])
})

test('RSS cap = data − 640 MB, min 256 MB, in KB as /proc reports it', () => {
  assert.equal(rssCapKb(), 384 * 1024)
  assert.equal(rssCapKb(2048 * MB), 1408 * 1024)
  assert.equal(rssCapKb(800 * MB), 256 * 1024)
  assert.equal(fmtMb(412 * MB), '412M'); assert.equal(fmtMb(undefined), 'undefined')
})
