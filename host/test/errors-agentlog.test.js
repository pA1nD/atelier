// errors/agentlog.mjs — the line format, 0640 root:1000 at creation, ENOSPC swallowed + stderr mirror.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os_ from 'node:os'
import path from 'node:path'
import { memory, unprivileged } from '../adapters/os.mjs'
import { agentLog, formatAppError, AGENT_LOG_MODE, MAX_LINE_CHARS } from '../errors/agentlog.mjs'
import { fakeClock } from './errors.helpers.js'

const T = 1_700_000_000_000
const ISO = new Date(T).toISOString()
const mk = (extra = {}) => {
  const state = {}; const os = memory(state); const clock = fakeClock(T)
  const writes = []; const err = []
  const log = agentLog({ os, path: '/work/.atelier/agent.log', now: clock.now, append: (p, text, mode) => writes.push({ p, text, mode }), stderr: { write: (t) => err.push(t) }, ...extra })
  return { state, os, clock, writes, err, log }
}

test('the file is created 0640 and chowned 0:1000 once, through the adapter; lines are ISO-stamped', () => {
  const { state, writes, log } = mk()
  log.line('host: started')
  log.line('host: ready')
  assert.deepEqual(writes.map((w) => [w.p, w.mode]), [['/work/.atelier/agent.log', AGENT_LOG_MODE], ['/work/.atelier/agent.log', AGENT_LOG_MODE]])
  assert.equal(writes[0].text, `${ISO} host: started\n`)
  assert.deepEqual(state.calls, [['chown', '/work/.atelier/agent.log', 0, 1000]])
  assert.equal(AGENT_LOG_MODE, 0o640)
})

test('§6.3 line format: LIVE | FAILED | STOPPED | RESUMED | KILLED', () => {
  const { writes, log } = mk()
  log.live('weather', 4, 152)
  log.failed('weather', 5, 4, 'frontend.jsx:4:1 Unexpected end of file — close the open JSX element')
  log.failed('delta', 1, undefined, 'module.json:1:1 409 slug already claimed — rename the folder')
  log.stopped('weather', 5); log.resumed('weather', 5, 41); log.killed('weather', 5, 'rss 412M > 384M')
  assert.deepEqual(writes.map((w) => w.text.slice(ISO.length + 1, -1)), [
    '[weather] rev 4 LIVE in 152 ms',
    '[weather] rev 5 FAILED (users still on rev 4) frontend.jsx:4:1 Unexpected end of file — close the open JSX element',
    '[delta] rev 1 FAILED (users see nothing — never live) module.json:1:1 409 slug already claimed — rename the folder',
    '[weather] rev 5 STOPPED', '[weather] rev 5 RESUMED 41 ms', '[weather] rev 5 KILLED rss 412M > 384M',
  ])
})

test('the collector sink: build → FAILED with the hint verbatim, worker → KILLED, runtime kinds with request/url and the fix line', () => {
  const base = { instance: 'i-a', rev: 5, count: 1, firstAt: T, lastAt: T, fingerprint: 'f' }
  assert.equal(formatAppError({ ...base, kind: 'build', message: 'Unexpected end of file', file: 'frontend.jsx', line: 4, col: 1, hint: 'frontend.jsx:4:1 Unexpected end of file — close the open JSX element' }, { slug: 'weather', running: 4 }),
    '[weather] rev 5 FAILED (users still on rev 4) frontend.jsx:4:1 Unexpected end of file — close the open JSX element')
  assert.equal(formatAppError({ ...base, kind: 'build', message: 'no name', file: 'module.json', line: 1, col: 1 }, { running: undefined }),
    '[i-a] rev 5 FAILED (users see nothing — never live) module.json:1:1 no name')
  assert.equal(formatAppError({ ...base, kind: 'worker', message: 'rss 412M > 384M', hint: 'look for a leak' }, { slug: 'weather', running: 5 }), '[weather] rev 5 KILLED rss 412M > 384M — look for a leak')
  assert.equal(formatAppError({ ...base, kind: 'http', count: 3, message: 'boom: id undefined\nstack', file: 'backend.js', line: 3, col: 36, hint: 'fix the handler', sample: { request: { method: 'GET', path: '/api/boom', status: 500 } } }, { slug: 'weather', running: 5 }),
    '[weather] rev 5 http ×3 (GET /api/boom → 500) backend.js:3:36 boom: id undefined — fix: fix the handler')
  assert.equal(formatAppError({ ...base, kind: 'frontend', message: 'TypeError: x', sample: { url: 'https://acme/x', ua: 'M' } }, { slug: 'weather', running: 5 }), '[weather] rev 5 frontend at https://acme/x TypeError: x')
  assert.equal(formatAppError({ ...base, kind: 'backend', message: 'unhandled: nope' }, { slug: 'weather' }), '[weather] rev 5 backend unhandled: nope')
  // through the sink with slugOf
  const { writes, log } = mk({ slugOf: (i) => (i === 'i-a' ? 'weather' : undefined) })
  log.appError({ ...base, kind: 'backend', message: 'nope' }, { running: 5 })
  assert.equal(writes[0].text, `${ISO} [weather] rev 5 backend nope\n`)
})

test('ENOSPC (any append failure) is swallowed, counted and mirrored to stderr with the line; a later append still tries', () => {
  const calls = []
  const { err, log } = mk({ append: (p, text) => { calls.push(text); const e = new Error('no space'); e.code = 'ENOSPC'; throw e } })
  assert.doesNotThrow(() => log.line('[weather] rev 2 FAILED (users still on rev 1) mkdir rev-2: ENOSPC'))
  assert.equal(log.lost, 1)
  assert.equal(err.length, 1)
  assert.match(err[0], /^agent\.log: append ENOSPC — .*FAILED .*ENOSPC\n$/)
  log.line('again')
  assert.equal(calls.length, 2); assert.equal(log.lost, 2)
})

test('newlines are folded into one line; over-long lines are cut', () => {
  const { writes, log } = mk()
  log.line('a\nb\r\nc')
  assert.equal(writes[0].text, `${ISO} a ⏎ b ⏎ c\n`)
  log.line('x'.repeat(MAX_LINE_CHARS + 10))
  assert.equal(writes[1].text.length, ISO.length + 1 + MAX_LINE_CHARS + 2)
})

test('unprivileged(): a real file lands with mode 0640 and the lines in order (chown is a logged no-op)', () => {
  const dir = fs.mkdtempSync(path.join(os_.tmpdir(), 'atelier-agentlog-'))
  const p = path.join(dir, 'agent.log')
  const log = agentLog({ os: unprivileged(), path: p, now: () => T })
  log.live('weather', 1, 10); log.stopped('weather', 1)
  assert.equal(fs.statSync(p).mode & 0o777, 0o640)
  assert.equal(fs.readFileSync(p, 'utf8'), `${ISO} [weather] rev 1 LIVE in 10 ms\n${ISO} [weather] rev 1 STOPPED\n`)
  assert.equal(log.lost, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})
