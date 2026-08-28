// host/protocol/events.mjs — seq per (stream, topic), coalescing per flush, batch ≤ 128, epoch bump, retry.
import test from 'node:test'
import assert from 'node:assert/strict'
import { validEvent, EventRing, MAX_BATCH as RING_MAX_BATCH } from '../../protocol/index.js'
import { createEvents, MAX_BATCH } from '../protocol/events.mjs'

const fakeTransport = () => { const t = { batches: [], fail: 0, events: async (b) => { if (t.fail > 0) { t.fail--; throw new Error('spine down') } t.batches.push(b); return { accepted: b.length, rejected: [] } } }; return t }

test('one invalidate per instance per flush; seq per topic; stream = hostId:epoch; every frame is validEvent', async () => {
  const t = fakeTransport()
  let epoch = 'e1'
  const ev = createEvents({ transport: t, hostId: () => 'computer-1', epoch: () => epoch, flushMs: 1 })
  for (let i = 0; i < 5; i++) ev.invalidate('i-a')
  ev.invalidate('i-b'); ev.invalidate('i-a')
  await new Promise((r) => setTimeout(r, 15))
  assert.equal(t.batches.length, 1)
  assert.deepEqual(t.batches[0], [
    { stream: 'computer-1:e1', topic: 'i-a', seq: 1, type: 'invalidate' },
    { stream: 'computer-1:e1', topic: 'i-b', seq: 1, type: 'invalidate' },
  ])
  assert.ok(t.batches[0].every(validEvent))
  ev.invalidate('i-a'); await ev.flush()
  assert.deepEqual(t.batches[1], [{ stream: 'computer-1:e1', topic: 'i-a', seq: 2, type: 'invalidate' }])
  // the spine's ring accepts the whole sequence (protocol/events, adoptFirst for the test)
  const ring = new EventRing({ adoptFirst: true })
  for (const b of t.batches) { const r = ring.ingest('computer-1', b); assert.equal(r.rejected.length, 0) }
  assert.deepEqual(ring.head('i-a'), { stream: 'computer-1:e1', seq: 2 })
  // epoch bump at re-registration: new stream, seq restarts, the ring accepts after registerEpoch
  epoch = 'e2'
  ev.invalidate('i-a'); ev.invalidate('i-b'); await ev.flush()
  assert.deepEqual(t.batches[2], [
    { stream: 'computer-1:e2', topic: 'i-a', seq: 1, type: 'invalidate' },
    { stream: 'computer-1:e2', topic: 'i-b', seq: 1, type: 'invalidate' },
  ])
  ring.registerEpoch('i-a', 'e2'); ring.registerEpoch('i-b', 'e2')
  assert.equal(ring.ingest('computer-1', t.batches[2]).rejected.length, 0)
  ev.stop()
})

test('batches are ≤ 128 = ring/2 (C4 surprise 2): 300 instances → 128 + 128 + 44', async () => {
  assert.equal(MAX_BATCH, RING_MAX_BATCH)
  const t = fakeTransport()
  const ev = createEvents({ transport: t, hostId: 'h', epoch: 'e', flushMs: 1 })
  for (let i = 0; i < 300; i++) ev.invalidate(`i-${i}`)
  await ev.flush(); await ev.flush(); await ev.flush()
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(t.batches.map((b) => b.length), [128, 128, 44])
  assert.equal(ev.stats.pushed, 300)
  assert.equal(ev.stats.maxBatch, 128)
  ev.stop()
})

test('a failed push keeps the instances pending and re-mints on retry; unregistered host holds', async () => {
  const t = fakeTransport(); t.fail = 1
  const logs = []
  const ev = createEvents({ transport: t, hostId: 'h', epoch: 'e', flushMs: 1, log: (l) => logs.push(l) })
  ev.invalidate('i-a')
  await ev.flush()
  assert.equal(ev.stats.failed, 1)
  assert.equal(ev.pending.has('i-a'), true)
  await new Promise((r) => setTimeout(r, 80))     // RETRY_MS[0] = 50
  assert.deepEqual(t.batches, [[{ stream: 'h:e', topic: 'i-a', seq: 2, type: 'invalidate' }]])   // re-minted: seq moved on (the ring wants monotonic)
  assert.ok(logs.some((l) => l.includes('push failed')))
  ev.stop()
  const t2 = fakeTransport()
  const held = createEvents({ transport: t2, hostId: () => null, epoch: () => null, flushMs: 1 })
  held.invalidate('i-a'); await held.flush()
  assert.equal(t2.batches.length, 0); assert.equal(held.pending.size, 1)
  held.stop()
})

test('frames the ring rejected as stale-epoch / unregistered go back to pending and are re-minted under the current stream; other rejections are dropped', async () => {
  const t = fakeTransport()
  let rejectNext = null
  t.events = async (b) => { t.batches.push(b); const rejected = rejectNext ?? []; rejectNext = null; return { accepted: b.length - rejected.length, rejected } }
  let epoch = 'e1'
  const ev = createEvents({ transport: t, hostId: 'h', epoch: () => epoch, flushMs: 1 })
  ev.invalidate('i-a'); ev.invalidate('i-b'); ev.invalidate('i-c')
  rejectNext = [{ index: 0, reason: 'stale-epoch' }, { index: 1, reason: 'unregistered' }, { index: 2, reason: 'seq-not-monotonic' }]
  await ev.flush()
  assert.deepEqual([...ev.pending].sort(), ['i-a', 'i-b'], 'the two recoverable rejections are pending again; the seq bug is dropped')
  assert.equal(ev.stats.requeued, 2); assert.equal(ev.stats.rejected, 3)
  epoch = 'e2'
  await ev.flush()
  assert.deepEqual(t.batches[1], [
    { stream: 'h:e2', topic: 'i-a', seq: 1, type: 'invalidate' },
    { stream: 'h:e2', topic: 'i-b', seq: 1, type: 'invalidate' },
  ])
  assert.equal(ev.pending.size, 0)
  ev.stop()
})

test('invalid instance ids are ignored; drain() pushes once within its cap', async () => {
  const t = fakeTransport()
  const ev = createEvents({ transport: t, hostId: 'h', epoch: 'e', flushMs: 10_000 })
  ev.invalidate(''); ev.invalidate(null); ev.invalidate('i-z')
  await ev.drain(200)
  assert.deepEqual(t.batches, [[{ stream: 'h:e', topic: 'i-z', seq: 1, type: 'invalidate' }]])
  ev.stop()
})
