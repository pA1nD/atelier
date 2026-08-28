import test from 'node:test'
import assert from 'node:assert/strict'
import { createBridge, hiddenFor, reconnectOnForeground, PING_MS, FG_PONG_MS, STALE_HIDE_MS, SUB_ACK_MS, OFFLINE_GRACE_MS, CONNECT_TIMEOUT_MS } from '../bridge.js'
import { isClientMessage } from '../../protocol/events.js'
import { fakeClock, FakeWebSocket, fakeFetch } from './fakes.js'

// A scriptable shell: snapshots per topic, whoami, and every client message checked against the protocol.
function harness({ hidden = false, snapshots = {}, whoami = () => ({ status: 200, body: {} }) } = {}) {
  FakeWebSocket.reset()
  const clock = fakeClock()
  const snaps = { ...snapshots }
  const fetch = fakeFetch([
    { match: (u) => u.startsWith('/_atelier/topics/'), respond: (u) => { const t = decodeURIComponent(u.slice('/_atelier/topics/'.length)); const s = snaps[t]; return typeof s === 'function' ? s() : (s ? { status: 200, body: s } : { status: 404, body: {} }) } },
    { match: (u) => u === '/_atelier/whoami', respond: whoami },
  ])
  const states = []
  const h = { hidden }
  const bridge = createBridge({
    url: 'ws://x/_atelier/ws', WebSocket: FakeWebSocket, fetch, now: clock.now,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    isHidden: () => h.hidden, onState: (s) => states.push(s),
  })
  const events = []
  const on = (topic) => bridge.subscribe(topic, (ev) => events.push(ev))
  const sock = () => FakeWebSocket.last()
  const openNow = async () => { sock().open(); await clock.flush() }
  const allSent = () => FakeWebSocket.instances.flatMap((s) => s.sent)
  return { clock, fetch, bridge, events, states, on, sock, openNow, snaps, h, allSent }
}

test('every message the tab sends is a valid protocol client message', async () => {
  const H = harness({ snapshots: { t1: { stream: 'h:e1', seq: 5, rev: 1, error: null } } })
  H.bridge.start(); H.on('t1'); await H.openNow()
  H.sock().receive({ type: 'subscribed', topic: 't1', stream: 'h:e1', seq: 5 }); await H.clock.flush()
  await H.clock.advance(PING_MS)                                   // the liveness probe
  H.sock().receive({ type: 'gap', topic: 't1', stream: 'h:e1' }); await H.clock.flush()
  H.sock().serverClose(); await H.clock.advance(300); await H.openNow()
  const sent = H.allSent()
  assert.ok(sent.length >= 4)
  for (const m of sent) assert.equal(isClientMessage(m), true, JSON.stringify(m))
  assert.deepEqual(sent.find((m) => m.op === 'pong'), { op: 'pong', at: H.clock.now() - 300 })
})

test('mount = sub → subscribed → one snapshot → cursor at the snapshot', async () => {
  const H = harness({ snapshots: { t1: { stream: 'h:e1', seq: 5, rev: 3, error: null } } })
  H.bridge.start()
  assert.equal(FakeWebSocket.instances.length, 1)
  H.on('t1')
  await H.openNow()
  assert.deepEqual(H.sock().sent, [{ op: 'sub', topics: ['t1'] }])
  H.sock().receive({ type: 'subscribed', topic: 't1', stream: 'h:e1', seq: 5 })
  await H.clock.flush()
  assert.equal(H.fetch.calls.filter((c) => c.url.startsWith('/_atelier/topics/')).length, 1)
  assert.deepEqual(H.events, [{ type: 'snapshot', topic: 't1', snapshot: { stream: 'h:e1', seq: 5, rev: 3, error: null }, initial: true }])
  const st = H.bridge.state().topics.t1
  assert.equal(st.stream, 'h:e1'); assert.equal(st.seq, 5); assert.equal(st.snapshots, 1); assert.equal(st.pending, null)
  assert.deepEqual(H.states, [])                                   // 'online' is the initial state: no event
})

test('contiguous invalidates reach the handler; dups and old seqs are dropped silently', async () => {
  const H = harness({ snapshots: { t1: { stream: 'h:e1', seq: 5 } } })
  H.bridge.start(); H.on('t1'); await H.openNow()
  H.sock().receive({ type: 'subscribed', topic: 't1', stream: 'h:e1', seq: 5 }); await H.clock.flush()
  H.events.length = 0
  for (const seq of [6, 7, 7, 3, 8]) H.sock().receive({ type: 'invalidate', topic: 't1', stream: 'h:e1', seq })
  assert.deepEqual(H.events.map((e) => e.seq), [6, 7, 8])
  const st = H.bridge.state().topics.t1
  assert.equal(st.seq, 8); assert.equal(st.dup, 2); assert.equal(st.gaps, 0); assert.equal(st.snapshots, 1)
})

test('frames during a snapshot are buffered; those ≤ snapshot.seq dropped, the rest applied in order', async () => {
  let release
  const H = harness({ snapshots: { t1: () => new Promise((r) => { release = () => r({ status: 200, body: { stream: 'h:e1', seq: 7 } }) }) } })
  H.bridge.start(); H.on('t1'); await H.openNow()
  H.sock().receive({ type: 'subscribed', topic: 't1', stream: 'h:e1', seq: 5 }); await H.clock.flush()
  for (const seq of [6, 7, 8, 9]) H.sock().receive({ type: 'invalidate', topic: 't1', stream: 'h:e1', seq })
  assert.equal(H.bridge.state().topics.t1.pending, 4)
  assert.deepEqual(H.events, [])
  release(); await H.clock.flush()
  assert.deepEqual(H.events.map((e) => [e.type, e.seq ?? e.snapshot.seq]), [['snapshot', 7], ['invalidate', 8], ['invalidate', 9]])
  assert.equal(H.bridge.state().topics.t1.seq, 9)
})

test('the cursor survives a socket death: the new socket resumes cursored topics and subs the rest', async () => {
  const H = harness({ snapshots: { t1: { stream: 'h:e1', seq: 5 } } })
  H.bridge.start(); H.on('t1'); await H.openNow()
  H.sock().receive({ type: 'subscribed', topic: 't1', stream: 'h:e1', seq: 5 }); await H.clock.flush()
  H.sock().receive({ type: 'invalidate', topic: 't1', stream: 'h:e1', seq: 6 })
  const first = H.sock()
  first.serverClose(1006)
  assert.equal(H.bridge.state().open, false)
  H.on('t2')                                                       // subscribed while down
  await H.clock.advance(250)                                       // backoff 250 ms
  assert.equal(FakeWebSocket.instances.length, 2)
  await H.openNow()
  const sent = H.sock().sent
  assert.deepEqual(sent, [{ op: 'resume', topic: 't1', stream: 'h:e1', seq: 6 }, { op: 'sub', topics: ['t2'] }])
  H.sock().receive({ type: 'resumed', topic: 't1', stream: 'h:e1', seq: 6 }); await H.clock.flush()
  assert.equal(H.bridge.state().topics.t1.snapshots, 1)           // resumed → nothing
  H.sock().receive({ type: 'invalidate', topic: 't1', stream: 'h:e1', seq: 7 })
  assert.equal(H.bridge.state().topics.t1.seq, 7)
  assert.equal(H.bridge.state().topics.t1.dup, 0)
})

test('gap → exactly one snapshot → resume at the snapshot cursor; delivery continues contiguously', async () => {
  const H = harness({ snapshots: { t1: { stream: 'h:e1', seq: 305 } } })
  H.bridge.start(); H.on('t1'); await H.openNow()
  H.snaps.t1 = { stream: 'h:e1', seq: 5 }
  H.sock().receive({ type: 'subscribed', topic: 't1', stream: 'h:e1', seq: 5 }); await H.clock.flush()
  H.snaps.t1 = { stream: 'h:e1', seq: 305 }
  H.events.length = 0
  H.sock().receive({ type: 'gap', topic: 't1', stream: 'h:e1' })
  H.sock().receive({ type: 'invalidate', topic: 't1', stream: 'h:e1', seq: 306 })   // arrives mid-snapshot
  await H.clock.flush()
  assert.deepEqual(H.events.map((e) => [e.type, e.seq ?? e.snapshot.seq]), [['snapshot', 305], ['invalidate', 306]])
  assert.deepEqual(H.sock().ops('resume'), [{ op: 'resume', topic: 't1', stream: 'h:e1', seq: 306 }])   // at the cursor AFTER the buffered frames
  H.sock().receive({ type: 'resumed', topic: 't1', stream: 'h:e1', seq: 306 })
  H.sock().receive({ type: 'invalidate', topic: 't1', stream: 'h:e1', seq: 306 })   // the resume replay: a dup
  H.sock().receive({ type: 'invalidate', topic: 't1', stream: 'h:e1', seq: 307 })
  const st = H.bridge.state().topics.t1
  assert.equal(st.gaps, 1); assert.equal(st.snapshots, 2); assert.equal(st.seq, 307); assert.equal(st.dup, 1)
  assert.equal(H.events.filter((e) => e.type === 'invalidate').length, 2)
})

test('a non-contiguous seq is treated as a gap: one snapshot, then resume', async () => {
  const H = harness({ snapshots: { t1: { stream: 'h:e1', seq: 5 } } })
  H.bridge.start(); H.on('t1'); await H.openNow()
  H.sock().receive({ type: 'subscribed', topic: 't1', stream: 'h:e1', seq: 5 }); await H.clock.flush()
  H.snaps.t1 = { stream: 'h:e1', seq: 9 }
  H.events.length = 0
  H.sock().receive({ type: 'invalidate', topic: 't1', stream: 'h:e1', seq: 8 })      // 6 and 7 never came
  await H.clock.flush()
  assert.deepEqual(H.events, [{ type: 'snapshot', topic: 't1', snapshot: { stream: 'h:e1', seq: 9 }, initial: false }])   // a gap snapshot is a change, never `initial`
  assert.deepEqual(H.sock().ops('resume'), [{ op: 'resume', topic: 't1', stream: 'h:e1', seq: 9 }])
  assert.equal(H.bridge.state().topics.t1.gaps, 1)
})

test('a stream change (host restart) → one snapshot, no resume needed', async () => {
  const H = harness({ snapshots: { t1: { stream: 'h:e1', seq: 5 } } })
  H.bridge.start(); H.on('t1'); await H.openNow()
  H.sock().receive({ type: 'subscribed', topic: 't1', stream: 'h:e1', seq: 5 }); await H.clock.flush()
  H.snaps.t1 = { stream: 'h:e2', seq: 1 }
  H.events.length = 0
  H.sock().receive({ type: 'invalidate', topic: 't1', stream: 'h:e2', seq: 1 })
  await H.clock.flush()
  assert.deepEqual(H.events, [{ type: 'snapshot', topic: 't1', snapshot: { stream: 'h:e2', seq: 1 }, initial: false }])
  assert.deepEqual(H.sock().ops('resume'), [])
  assert.equal(H.bridge.state().topics.t1.stream, 'h:e2')
  H.sock().receive({ type: 'invalidate', topic: 't1', stream: 'h:e2', seq: 2 })
  assert.equal(H.events.length, 2)
})

test('an empty ring: the snapshot has no stream, a gap resumes with `sub`, the echo is not a second snapshot', async () => {
  const H = harness({ snapshots: { t1: { stream: null, seq: 0 } } })
  H.bridge.start(); H.on('t1'); await H.openNow()
  H.sock().receive({ type: 'subscribed', topic: 't1', stream: null, seq: 0 }); await H.clock.flush()
  assert.equal(H.bridge.state().topics.t1.snapshots, 1)
  H.sock().receive({ type: 'gap', topic: 't1', stream: null }); await H.clock.flush()
  assert.deepEqual(H.sock().sent.slice(-1), [{ op: 'sub', topics: ['t1'] }])
  H.sock().receive({ type: 'subscribed', topic: 't1', stream: null, seq: 0 }); await H.clock.flush()
  assert.equal(H.bridge.state().topics.t1.snapshots, 2)          // gap's snapshot only; the sub echo at the same head is not one more
  H.sock().receive({ type: 'invalidate', topic: 't1', stream: 'h:e1', seq: 1 })
  assert.equal(H.bridge.state().topics.t1.stream, 'h:e1')       // the first event names the stream
  assert.equal(H.bridge.state().topics.t1.seq, 1)
})

test('a silent socket is probed with `pong {at}` after PING_MS (the shell echoes `ping`); no answer within PING_MS → killed and reconnected', async () => {
  const H = harness({ snapshots: { t1: { stream: 'h:e1', seq: 5 } } })
  H.bridge.start(); H.on('t1'); await H.openNow()
  H.sock().receive({ type: 'subscribed', topic: 't1', stream: 'h:e1', seq: 5 }); await H.clock.flush()
  const first = H.sock()
  await H.clock.advance(PING_MS)                                   // silent for 1 s → probe
  assert.deepEqual(first.ops('pong'), [{ op: 'pong', at: H.clock.now() }])
  assert.equal(H.bridge.state().probing, true)
  first.receive({ type: 'ping', at: H.clock.now() })              // the echo answers it — and is never answered back (no loop)
  assert.equal(H.bridge.state().probing, false)
  assert.equal(first.ops('pong').length, 1)
  await H.clock.advance(PING_MS)                                   // silent again → another probe, unanswered
  assert.equal(first.ops('pong').length, 2)
  await H.clock.advance(PING_MS + 1)
  assert.equal(first.closedByClient, true)
  assert.equal(FakeWebSocket.instances.length, 2)                 // reconnect at once, no backoff
  assert.notEqual(H.sock(), first)
  await H.openNow()
  assert.deepEqual(H.sock().sent, [{ op: 'resume', topic: 't1', stream: 'h:e1', seq: 5 }])
})

test('any frame answers the probe; a hidden tab is never probed', async () => {
  const H = harness({ snapshots: { t1: { stream: 'h:e1', seq: 5 } } })
  H.bridge.start(); H.on('t1'); await H.openNow()
  H.sock().receive({ type: 'subscribed', topic: 't1', stream: 'h:e1', seq: 5 }); await H.clock.flush()
  H.h.hidden = true; H.bridge.onHidden()
  await H.clock.advance(10 * PING_MS)
  assert.equal(H.sock().ops('pong').length, 0)
  assert.equal(FakeWebSocket.instances.length, 1)
  H.h.hidden = false; H.bridge.onForeground('visibilitychange')   // 10 s hidden < 30 s → probe with the 500 ms budget
  assert.equal(H.sock().ops('pong').length, 1)
  H.sock().receive({ type: 'invalidate', topic: 't1', stream: 'h:e1', seq: 6 })   // an invalidate is an answer too
  await H.clock.advance(FG_PONG_MS + 1)
  assert.equal(FakeWebSocket.instances.length, 1)
})

test('foreground after > 30 s hidden (Date.now) → reconnect at once', async () => {
  const H = harness({ snapshots: { t1: { stream: 'h:e1', seq: 5 } } })
  H.bridge.start(); H.on('t1'); await H.openNow()
  H.sock().receive({ type: 'subscribed', topic: 't1', stream: 'h:e1', seq: 5 }); await H.clock.flush()
  const first = H.sock()
  H.h.hidden = true; H.bridge.onHidden()
  await H.clock.advance(STALE_HIDE_MS + 1)
  H.h.hidden = false; H.bridge.onForeground('visibilitychange')
  assert.equal(first.closedByClient, true)
  assert.equal(FakeWebSocket.instances.length, 2)
  await H.openNow()
  assert.deepEqual(H.sock().sent, [{ op: 'resume', topic: 't1', stream: 'h:e1', seq: 5 }])
})

test('foreground after a short hide: probe, 500 ms pong budget, killed when unanswered', async () => {
  const H = harness({ snapshots: { t1: { stream: 'h:e1', seq: 5 } } })
  H.bridge.start(); H.on('t1'); await H.openNow()
  H.sock().receive({ type: 'subscribed', topic: 't1', stream: 'h:e1', seq: 5 }); await H.clock.flush()
  const first = H.sock()
  H.h.hidden = true; H.bridge.onHidden()
  await H.clock.advance(5000)
  H.h.hidden = false; H.bridge.onForeground('visibilitychange')
  assert.equal(first.ops('pong').length, 1)
  await H.clock.advance(FG_PONG_MS - 1)
  assert.equal(FakeWebSocket.instances.length, 1)
  await H.clock.advance(2)
  assert.equal(first.closedByClient, true)
  assert.equal(FakeWebSocket.instances.length, 2)
})

test('pageshow(persisted) → reconnect at once whatever the hidden time; `online` with an open socket → probe', async () => {
  const H = harness({ snapshots: { t1: { stream: 'h:e1', seq: 5 } } })
  H.bridge.start(); H.on('t1'); await H.openNow()
  H.sock().receive({ type: 'subscribed', topic: 't1', stream: 'h:e1', seq: 5 }); await H.clock.flush()
  const first = H.sock()
  H.bridge.onForeground('pageshow')
  assert.equal(first.closedByClient, true)
  assert.equal(FakeWebSocket.instances.length, 2)
  await H.openNow()
  H.bridge.onForeground('online')
  assert.equal(H.sock().ops('resume').length, 1)                  // the announce
  assert.equal(H.sock().ops('pong').length, 1)                    // the probe
  assert.equal(FakeWebSocket.instances.length, 2)
})

test('a probe needs no cursored topic: a fresh subscription on a silent socket is probed too', async () => {
  const H = harness()
  H.bridge.start(); H.on('t1'); await H.openNow()
  H.sock().receive({ type: 'subscribed', topic: 't1', stream: null, seq: 0 }); await H.clock.flush()
  await H.clock.advance(PING_MS)
  assert.equal(H.sock().ops('pong').length, 1)
})

test('foreground with no socket → connect; while connecting → wait for onclose/backoff', async () => {
  const H = harness()
  H.bridge.start(); H.on('t1')
  H.sock().serverClose()
  assert.equal(H.bridge.state().open, false)
  H.bridge.onForeground('visibilitychange')
  assert.equal(FakeWebSocket.instances.length, 2)                 // connected at once
  H.bridge.onForeground('online')                                  // readyState 0 after a short hide → nothing
  assert.equal(FakeWebSocket.instances.length, 2)
})

test('a socket stuck CONNECTING is not trusted: killed after CONNECT_TIMEOUT_MS, and at once on a foreground after a long hide', async () => {
  const H = harness()
  H.bridge.start(); H.on('t1')
  const first = H.sock(); assert.equal(first.readyState, 0)
  await H.clock.advance(CONNECT_TIMEOUT_MS)                        // the handshake never completes
  assert.equal(first.closedByClient, true); assert.equal(FakeWebSocket.instances.length, 2)   // killed + reconnected
  await H.openNow()                                                // the second opens: its timer is cleared
  H.h.hidden = true; H.bridge.onHidden()
  await H.clock.advance(STALE_HIDE_MS)                             // no probe while hidden, no connect timer either
  assert.equal(H.sock().closedByClient, false)
  H.sock().serverClose(); await H.clock.advance(300)               // dies while hidden → the backoff reconnect is in flight
  const third = H.sock(); assert.equal(third.readyState, 0); assert.equal(FakeWebSocket.instances.length, 3)
  H.h.hidden = false; H.bridge.onForeground('visibilitychange')    // hidden > 30 s with a CONNECTING socket: killed at once, not trusted
  assert.equal(third.closedByClient, true); assert.equal(FakeWebSocket.instances.length, 4)
})

test('`initial` marks only the snapshot that established the topic; a later handler on a live topic sees a gap snapshot as a change', async () => {
  const H = harness({ snapshots: { t1: { stream: 'h:e1', seq: 5 } } })
  H.bridge.start(); H.on('t1'); await H.openNow()
  H.sock().receive({ type: 'subscribed', topic: 't1', stream: 'h:e1', seq: 5 }); await H.clock.flush()
  assert.equal(H.events[0].initial, true)
  const late = []
  H.bridge.subscribe('t1', (ev) => late.push(ev))                 // a module (re)mounting on the topic the client already holds
  assert.equal(H.sock().ops('sub').length, 1)                      // no second announce, no mount snapshot
  H.snaps.t1 = { stream: 'h:e1', seq: 301 }
  H.sock().receive({ type: 'gap', topic: 't1', stream: 'h:e1' }); await H.clock.flush()
  assert.deepEqual(late, [{ type: 'snapshot', topic: 't1', snapshot: { stream: 'h:e1', seq: 301 }, initial: false }])
})

test('hiddenFor / reconnectOnForeground', () => {
  assert.equal(hiddenFor(null, 100), null)
  assert.equal(hiddenFor(100, 30_100), 30_000)
  assert.equal(hiddenFor(200, 100), 0)
  assert.equal(reconnectOnForeground('visibilitychange', 30_000), false)
  assert.equal(reconnectOnForeground('visibilitychange', 30_001), true)
  assert.equal(reconnectOnForeground('online', null), false)
  assert.equal(reconnectOnForeground('pageshow', 0), true)
})

test('a sub that is never acked on an open socket is a dead socket', async () => {
  const H = harness()
  H.bridge.start(); H.on('t1'); await H.openNow()
  const first = H.sock()
  await H.clock.advance(SUB_ACK_MS + PING_MS)
  assert.equal(first.closedByClient, true)
  assert.equal(FakeWebSocket.instances.length, 2)
})

test('denied → the handler hears it once and the topic is never announced again', async () => {
  const H = harness()
  H.bridge.start(); H.on('shell'); H.on('t1'); await H.openNow()
  H.sock().receive({ type: 'denied', topic: 'shell' })
  assert.deepEqual(H.events, [{ type: 'denied', topic: 'shell' }])
  H.sock().serverClose(); await H.clock.advance(250); await H.openNow()
  assert.deepEqual(H.sock().sent, [{ op: 'sub', topics: ['t1'] }])
})

test('a waking snapshot (503) → `waking` to the handler, retried with backoff until it answers', async () => {
  let n = 0
  const H = harness({ snapshots: { t1: () => (++n < 3 ? { status: 503, body: { waking: true }, headers: { 'x-atelier-waking': '1' } } : { status: 200, body: { stream: 'h:e1', seq: 2 } }) } })
  H.bridge.start(); H.on('t1'); await H.openNow()
  H.sock().receive({ type: 'subscribed', topic: 't1', stream: 'h:e1', seq: 2 }); await H.clock.flush()
  assert.deepEqual(H.events, [{ type: 'waking', topic: 't1' }])
  await H.clock.advance(1000)                                      // retry 1 s → waking again
  await H.clock.advance(2000)                                      // retry 2 s → answers
  assert.equal(H.events.at(-1).type, 'snapshot')
  assert.equal(H.bridge.state().topics.t1.seq, 2)
  assert.equal(H.bridge.state().topics.t1.pending, null)
})

test('a 401 snapshot → the banner state `unauthed`; a socket that stays down → `offline` after the grace probe', async () => {
  const H = harness({ snapshots: { t1: () => ({ status: 401, body: {} }) } })
  H.bridge.start(); H.on('t1'); await H.openNow()
  H.sock().receive({ type: 'subscribed', topic: 't1', stream: 'h:e1', seq: 2 }); await H.clock.flush()
  assert.deepEqual(H.states, ['unauthed'])
  H.sock().serverClose()
  await H.clock.advance(250); await H.openNow()
  assert.deepEqual(H.states, ['unauthed', 'online'])
})

test('offline: a closed socket that never reopens → `offline` after OFFLINE_GRACE_MS (whoami unreachable), `online` on reopen', async () => {
  const H = harness({ whoami: () => { throw new Error('ECONNREFUSED') } })
  H.bridge.start(); H.on('t1'); await H.openNow()
  H.sock().serverClose()
  await H.clock.advance(OFFLINE_GRACE_MS + 1)
  assert.deepEqual(H.states, ['offline'])
  await H.clock.advance(5000)
  await H.openNow()
  assert.deepEqual(H.states, ['offline', 'online'])
})

test('unsubscribe keeps the cursor; a re-subscribe resumes on the next socket', async () => {
  const H = harness({ snapshots: { t1: { stream: 'h:e1', seq: 5 } } })
  H.bridge.start()
  const off = H.on('t1'); await H.openNow()
  H.sock().receive({ type: 'subscribed', topic: 't1', stream: 'h:e1', seq: 5 }); await H.clock.flush()
  off()
  H.sock().serverClose(); await H.clock.advance(250); await H.openNow()
  assert.deepEqual(H.sock().sent, [])                              // nothing wanted
  H.on('t1')
  assert.deepEqual(H.sock().sent, [{ op: 'resume', topic: 't1', stream: 'h:e1', seq: 5 }])
})

test('stop() closes the socket and every timer', async () => {
  const H = harness()
  H.bridge.start(); H.on('t1'); await H.openNow()
  H.bridge.stop()
  assert.equal(H.sock().closedByClient, true)
  await H.clock.advance(60_000)
  assert.equal(FakeWebSocket.instances.length, 1)
  assert.equal(H.clock.pending(), 0)
})
