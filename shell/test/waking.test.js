// shell/waking.mjs createWaker — the wake call behind /_atelier/wake (step 7): one registry.wake(chat, {by}) per chat
// per WAKE_CALL_MS and one in flight, held inside the window, absent without the verb (local mode), a chat, a chat id
// or an actor; the VERDICT is read from the provider's answer and logged truthfully (review 2026-09-02); a throw is
// logged and keeps the window (a broken spine is not hammered either).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWaker, WAKE_CALL_MS, CHAT_RE, WAKE_OUTCOMES } from '../waking.mjs'

const BY = 'session:s-1'

test('createWaker: sent → held for 30 s → sent; per chat; the verdict is the provider\'s (sent / up / refused / unconfirmed / failed), never `sent` for a refusal; a throw holds the window', async () => {
  assert.equal(WAKE_CALL_MS, 30_000)
  let clock = 1_000_000
  const calls = [], logs = []
  const answers = {
    'chat-a': { ok: true, state: 'waking', status: 202 },
    'chat-b': { ok: true, state: 'up', status: 200 },
    'chat-r': { ok: false, state: null, reason: 'refused', error: 'p1 is not in chat-r', status: 403 },
    'chat-t': { ok: false, state: 'unconfirmed', reason: 'timeout', error: 'no answer in 15000 ms', status: null },
    'chat-n': undefined,
    'chat-s': { ok: true, status: 204 },
  }
  const registry = { kind: 'fleet', async wake(chat, opts) { calls.push([chat, opts]); if (chat === 'chat-x') throw Object.assign(new Error('spine 503'), { code: 'HTTP_503' }); return answers[chat] } }
  const w = createWaker({ registry, now: () => clock, log: (l) => logs.push(l) })
  assert.equal(await w.wake({ chat: 'chat-a', company: 'acme', reason: 'DIAL', by: BY }), 'sent')
  assert.equal(await w.wake({ chat: 'chat-a', company: 'acme', reason: 'DIAL', by: BY }), 'held')
  assert.equal(await w.wake({ chat: 'chat-b', company: 'acme', reason: 'heartbeat-stale', by: BY }), 'up', 'another chat has its own window; a live pod is said to be up')
  clock += WAKE_CALL_MS - 1
  assert.equal(await w.wake({ chat: 'chat-a', company: 'acme', by: BY }), 'held')
  clock += 1
  assert.equal(await w.wake({ chat: 'chat-a', company: 'acme', by: BY }), 'sent')
  assert.deepEqual(calls, [['chat-a', { by: BY }], ['chat-b', { by: BY }], ['chat-a', { by: BY }]], 'the actor rides every call')
  assert.deepEqual(logs, ['wake: acme chat-a (DIAL) sent', 'wake: acme chat-b (heartbeat-stale) up', 'wake: acme chat-a (waking) sent'])
  // the spine said no: refused, with its reason; the window holds so it is not asked again for 30 s
  assert.equal(await w.wake({ chat: 'chat-r', company: 'acme', reason: 'DIAL', by: BY }), 'refused')
  assert.equal(logs.at(-1), 'wake: acme chat-r (DIAL) refused: p1 is not in chat-r')
  assert.equal(await w.wake({ chat: 'chat-r', company: 'acme', reason: 'DIAL', by: BY }), 'held')
  // no verdict inside the portal's clock: unconfirmed (the create may still land)
  assert.equal(await w.wake({ chat: 'chat-t', company: 'acme', reason: 'DIAL', by: BY }), 'unconfirmed'); assert.equal(logs.at(-1), 'wake: acme chat-t (DIAL) unconfirmed: timeout')
  assert.equal(await w.wake({ chat: 'chat-n', company: 'acme', reason: 'DIAL', by: BY }), 'unconfirmed'); assert.equal(logs.at(-1), 'wake: acme chat-n (DIAL) unconfirmed: no verdict')
  assert.equal(await w.wake({ chat: 'chat-s', company: 'acme', reason: 'DIAL', by: BY }), 'unconfirmed', 'a 2xx without a state is not up'); assert.equal(logs.at(-1), 'wake: acme chat-s (DIAL) unconfirmed: no verdict (null)')
  // the call threw: failed, the window kept
  assert.equal(await w.wake({ chat: 'chat-x', company: 'acme', reason: 'DIAL', by: BY }), 'failed')
  assert.equal(await w.wake({ chat: 'chat-x', company: 'acme', reason: 'DIAL', by: BY }), 'held', 'the failed call keeps its window')
  assert.match(logs.at(-1), /^wake: acme chat-x \(DIAL\) failed: HTTP_503$/)
  assert.deepEqual(w.stats(), { sent: 2, up: 1, refused: 1, unconfirmed: 3, failed: 1, held: 4, inFlight: 0 })
  assert.deepEqual(WAKE_OUTCOMES, ['sent', 'up', 'refused', 'unconfirmed', 'failed', 'held'])
})

test('createWaker: nothing is sent without a chat, a chat id or an actor — each said once per company per window; no-host is quiet; the local registry has no verb and stays silent', async () => {
  let clock = 1_000_000
  const calls = [], logs = []
  const w = createWaker({ registry: { kind: 'fleet', async wake(chat, opts) { calls.push([chat, opts]); return { ok: true, state: 'waking', status: 202 } } }, now: () => clock, log: (l) => logs.push(l) })
  assert.equal(await w.wake({ chat: null, company: 'acme', reason: 'no-host', by: BY }), 'no-target'); assert.equal(logs.length, 0)
  assert.equal(await w.wake({ chat: null, company: 'acme', reason: 'DIAL', by: BY }), 'no-target'); assert.equal(logs.length, 1); assert.match(logs[0], /^wake: acme host row names no chat \(DIAL\)/)
  assert.equal(await w.wake({ chat: null, company: 'acme', reason: 'DIAL', by: BY }), 'no-target'); assert.equal(logs.length, 1, 'once per window')
  // the shape: the spine's ids (g_<base64url>, p_<hex>, a mapped name) pass; a path, a space, a 65-char id do not
  for (const ok of ['g_m7cmDcQ5WQmR3xJt1e8p0aE7k5w2sQ_KfRk7h1ZQ-4', 'p_8bb8a1d9', 'bjorn', 'a'.repeat(64)]) assert.ok(CHAT_RE.test(ok), ok)
  for (const bad of ['no such/chat', 'a b', '', 'a'.repeat(65), '+595987303010', '../x']) assert.ok(!CHAT_RE.test(bad), bad)
  assert.equal(await w.wake({ chat: 'no such/chat', company: 'acme', reason: 'DIAL', by: BY }), 'bad-target'); assert.equal(logs.length, 2); assert.match(logs[1], /chat "no such\/chat" is not a chat id \(DIAL\)/)
  assert.equal(await w.wake({ chat: 'a b', company: 'acme', reason: 'DIAL', by: BY }), 'bad-target'); assert.equal(logs.length, 2, 'once per window')
  assert.equal(await w.wake({ chat: 'g_ok', company: 'acme', reason: 'DIAL' }), 'no-actor'); assert.equal(logs.length, 3); assert.match(logs[2], /has no actor/)
  assert.equal(await w.wake({ chat: 'g_ok', company: 'acme', reason: 'DIAL', by: '' }), 'no-actor'); assert.equal(logs.length, 3)
  assert.deepEqual(calls, [], 'nothing reached the door')
  clock += WAKE_CALL_MS
  assert.equal(await w.wake({ chat: null, company: 'acme', reason: 'DIAL', by: BY }), 'no-target'); assert.equal(logs.length, 4, 'the window passed: said again')
  assert.deepEqual(w.stats(), { sent: 0, up: 0, refused: 0, unconfirmed: 0, failed: 0, held: 0, inFlight: 0 })
  // the local registry has no verb: nothing is called, nothing logged
  const local = createWaker({ registry: { kind: 'local' }, now: () => clock, log: (l) => logs.push(l) })
  const n = logs.length
  assert.equal(await local.wake({ chat: 'chat-a', company: 'global', reason: 'DIAL', by: BY }), 'no-verb'); assert.equal(logs.length, n)
})

test('createWaker: one call in flight per chat — a hung door is not asked again when the window passes; the window is set before the call; a log transport that throws is caught, never an unhandled rejection', async () => {
  let clock = 1_000_000
  let calls = 0
  const pending = []
  const registry = { kind: 'fleet', wake: () => { calls++; return new Promise((res) => pending.push(res)) } }
  const logs = []
  const w = createWaker({ registry, now: () => clock, log: (l) => logs.push(l) })
  const first = w.wake({ chat: 'chat-a', company: 'acme', reason: 'DIAL', by: BY })
  assert.equal(await w.wake({ chat: 'chat-a', company: 'acme', reason: 'DIAL', by: BY }), 'held'); assert.equal(calls, 1)
  assert.deepEqual(w.stats(), { sent: 0, up: 0, refused: 0, unconfirmed: 0, failed: 0, held: 1, inFlight: 1 })
  clock += WAKE_CALL_MS + 1
  assert.equal(await w.wake({ chat: 'chat-a', company: 'acme', reason: 'DIAL', by: BY }), 'held', 'past the window, still in flight: held'); assert.equal(calls, 1)
  const second = w.wake({ chat: 'chat-b', company: 'acme', reason: 'DIAL', by: BY }); assert.equal(calls, 2, 'another chat has its own flight')
  assert.equal(w.stats().inFlight, 2)
  pending[0]({ ok: true, state: 'waking', status: 202 })
  assert.equal(await first, 'sent')
  assert.equal(w.stats().inFlight, 1)
  pending[1]({ ok: false, reason: 'refused', error: 'the fleet wakes no more this minute', status: 429 })
  assert.equal(await second, 'refused'); assert.equal(logs.at(-1), 'wake: acme chat-b (DIAL) refused: the fleet wakes no more this minute')
  const third = w.wake({ chat: 'chat-a', company: 'acme', reason: 'DIAL', by: BY }); assert.equal(calls, 3, 'settled and past the window: asked again')
  pending[2]({ ok: true, state: 'waking', status: 202 }); assert.equal(await third, 'sent')
  assert.deepEqual(w.stats(), { sent: 2, up: 0, refused: 1, unconfirmed: 0, failed: 0, held: 2, inFlight: 0 })
  // a throwing log: swallowed inside the waker, the verdict still answered
  const loud = createWaker({ registry: { kind: 'fleet', async wake() { return { ok: true, state: 'waking', status: 202 } } }, now: () => clock, log: () => { throw new Error('stream closed') } })
  assert.equal(await loud.wake({ chat: 'chat-a', company: 'acme', reason: 'DIAL', by: BY }), 'failed')
})
