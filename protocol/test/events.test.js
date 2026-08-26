import test from 'node:test'
import assert from 'node:assert/strict'
import { EventRing, frames, messages, isFrame, isClientMessage, RING, MAX_BATCH, PING_MS, SERVER_PING_MS, SERVER_PING_MISSES, SOCKET_BUDGET, CLOSE_EVICTED, companyTopic, isReservedTopic, splitStream } from '../events.js'
import vectors from '../vectors/events.json' with { type: 'json' }

const gen = ({ stream, topic, from, to }) => Array.from({ length: to - from + 1 }, (_, i) => ({ stream, topic, seq: from + i, type: 'invalidate' }))

for (const c of vectors.cases) {
  test(`vector: ${c.name}`, () => {
    if (c.fn) return assert.equal({ isFrame, isClientMessage }[c.fn](c.input), c.expect)
    const ring = new EventRing({ ring: c.ring ?? RING, adoptFirst: c.adoptFirst ?? false })
    c.steps.forEach((s, i) => {
      const at = `step ${i} (${s.op})`
      switch (s.op) {
        case 'register': return assert.deepEqual(ring.registerEpoch(s.topic, s.epoch), s.expect, at)
        case 'append': return assert.deepEqual(ring.append(s.ev), s.expect, at)
        case 'ingest': return assert.deepEqual(ring.ingest(s.hostId, s.events ?? gen(s.generate)), s.expect, at)
        case 'head': return assert.deepEqual(ring.head(s.topic), s.expect, at)
        case 'epochOf': return assert.deepEqual(ring.epochOf(s.topic), s.expect, at)
        case 'since': {
          const r = ring.since(s.topic, s.cursor)
          const got = { gap: r.gap, streamChange: r.streamChange, count: r.events.length }
          if (r.events.length) { got.first = r.events[0].seq; got.last = r.events[r.events.length - 1].seq }
          for (let k = 1; k < r.events.length; k++) assert.equal(r.events[k].seq, r.events[k - 1].seq + 1, `${at}: contiguous`)
          return assert.deepEqual(got, s.expect, at)
        }
        default: throw new Error('unknown op ' + s.op)
      }
    })
  })
}

test('constants and topic helpers', () => {
  assert.deepEqual(vectors.constants, { RING, MAX_BATCH, PING_MS, SERVER_PING_MS, SERVER_PING_MISSES, SOCKET_BUDGET, CLOSE_EVICTED })
  assert.equal(MAX_BATCH, RING / 2)
  assert.deepEqual([SERVER_PING_MS, SERVER_PING_MISSES, SOCKET_BUDGET, CLOSE_EVICTED], [10_000, 2, 8, 4001])   // §4.5 verbatim
  assert.equal(companyTopic('acme'), 'company:acme')
  assert.ok(isReservedTopic('shell') && isReservedTopic('company:acme') && !isReservedTopic('inst-A'))
  assert.deepEqual(splitStream('host1:abc:def'), { hostId: 'host1', epoch: 'abc:def' })
  assert.equal(splitStream(':x'), null)
})

test('constructors produce frames the validators accept', () => {
  const ev = { stream: 'host1:1', topic: 'inst-A', seq: 3, type: 'invalidate' }
  for (const f of [frames.subscribed({ topic: 't', stream: null, seq: 0 }), frames.resumed({ topic: 't', stream: 'h:1', seq: 9 }),
    frames.denied({ topic: 't' }), frames.gap({ topic: 't', stream: 'h:1' }), frames.invalidate(ev), frames.ping({ at: 5 })]) assert.ok(isFrame(f), f.type)
  for (const m of [messages.sub({ topics: ['t'] }), messages.resume({ topic: 't', stream: 'h:1', seq: 1 }), messages.pong({ at: 5 })]) assert.ok(isClientMessage(m), m.op)
  assert.deepEqual(frames.invalidate({ ...ev, extra: 'dropped' }), ev)
})
