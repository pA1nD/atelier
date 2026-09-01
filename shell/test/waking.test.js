// shell/waking.mjs createWaker — the wake call behind /_atelier/wake (step 7): one registry.wake per chat per
// WAKE_CALL_MS, held inside the window, absent without the verb (local mode) or a chat; a throw is logged and
// keeps the window (a broken spine is not hammered either).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWaker, WAKE_CALL_MS } from '../waking.mjs'

test('createWaker: sent → held for 30 s → sent; per chat; no verb / no target answer without a call; a throw is logged and holds the window', async () => {
  assert.equal(WAKE_CALL_MS, 30_000)
  let clock = 1_000_000
  const calls = [], logs = []
  const registry = { kind: 'fleet', async wake(chat) { calls.push(chat); if (chat === 'chat-x') throw Object.assign(new Error('spine 503'), { code: 'HTTP_503' }) } }
  const w = createWaker({ registry, now: () => clock, log: (l) => logs.push(l) })
  assert.equal(await w.wake({ chat: 'chat-a', company: 'acme', reason: 'DIAL' }), 'sent')
  assert.equal(await w.wake({ chat: 'chat-a', company: 'acme', reason: 'DIAL' }), 'held')
  assert.equal(await w.wake({ chat: 'chat-b', company: 'acme', reason: 'heartbeat-stale' }), 'sent', 'another chat has its own window')
  clock += WAKE_CALL_MS - 1
  assert.equal(await w.wake({ chat: 'chat-a', company: 'acme' }), 'held')
  clock += 1
  assert.equal(await w.wake({ chat: 'chat-a', company: 'acme' }), 'sent')
  assert.deepEqual(calls, ['chat-a', 'chat-b', 'chat-a'])
  assert.deepEqual(logs, ['wake: acme chat-a (DIAL)', 'wake: acme chat-b (heartbeat-stale)', 'wake: acme chat-a (waking)'])
  assert.equal(await w.wake({ chat: null, company: 'acme', reason: 'no-host' }), 'no-target'); assert.equal(calls.length, 3)
  assert.equal(await w.wake({ chat: 'chat-x', company: 'acme', reason: 'DIAL' }), 'failed')
  assert.equal(await w.wake({ chat: 'chat-x', company: 'acme', reason: 'DIAL' }), 'held', 'the failed call keeps its window')
  assert.match(logs.at(-1), /^wake: acme chat-x \(DIAL\) failed: HTTP_503$/)
  // the local registry has no verb: nothing is called, nothing logged
  const local = createWaker({ registry: { kind: 'local' }, now: () => clock, log: (l) => logs.push(l) })
  const n = logs.length
  assert.equal(await local.wake({ chat: 'chat-a', company: 'global', reason: 'DIAL' }), 'no-verb'); assert.equal(logs.length, n)
})
