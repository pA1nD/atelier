// Event frames + the per-topic ring (PLAN §4.4 "Events", seed spike-c4/stream.js + shell.js:28-53).
// Invalidations travel host → spine ring → shell socket → tab. Nothing here opens a socket.
//
// Locked by C4 (RESULT.md surprises 1-5, 7):
//   1. seq is per (stream, topic) — a single-topic subscriber verifies contiguity alone.
//   2. an ingest batch larger than ring/2 is a gap for every healthy subscriber → MAX_BATCH.
//   3. gap detection keys on cursor lag, never on bufferedAmount; after `gap` the server stops
//      delivery on that (socket, topic) until the tab sends `resume`; the ack is `resumed`,
//      never `subscribed` (a tab resets its state on `subscribed`).
//   5. the topic's epoch bumps at host REGISTRATION (registerEpoch), and append rejects the old
//      stream from that moment — not from the first new-epoch event (the zombie-host window).
//   7. mount = subscribe (cursor = head) → snapshot → drop buffered frames with seq ≤ snapshot.seq;
//      a tab treats ANY non-contiguous seq as a gap (a failed push leaves a hole the ring cannot see).
//
// Stream id = `<hostId>:<epoch>`. The registrar returns a random, opaque epoch per host start
// (§4.4); ordering comes from `epochSeq`, an integer the ring assigns per topic at registration —
// the vectors pin both. C4's `:epoch<n>` regex is gone.

export const RING = 256
export const MAX_BATCH = RING / 2
export const PING_MS = 1000              // loopback-tuned, NOT protocol (§4.4 tab liveness)
export const RESERVED_TOPICS = ['shell']
export const COMPANY_TOPIC_PREFIX = 'company:'
export const companyTopic = (companyId) => COMPANY_TOPIC_PREFIX + companyId
export const isReservedTopic = (t) => RESERVED_TOPICS.includes(t) || String(t).startsWith(COMPANY_TOPIC_PREFIX)

export function splitStream(stream) {
  if (typeof stream !== 'string') return null
  const i = stream.indexOf(':')
  if (i <= 0 || i === stream.length - 1) return null
  return { hostId: stream.slice(0, i), epoch: stream.slice(i + 1) }
}
const isSeq = (n) => Number.isInteger(n) && n >= 0
export function validEvent(ev) {
  return !!ev && typeof ev === 'object' && ev.type === 'invalidate' && !!splitStream(ev.stream) &&
    typeof ev.topic === 'string' && ev.topic.length > 0 && Number.isInteger(ev.seq) && ev.seq > 0
}

export class EventRing {
  constructor({ ring = RING } = {}) {
    this.ringSize = ring
    this.maxBatch = Math.floor(ring / 2)
    this.rings = new Map()      // topic → { stream, epoch, epochSeq, epochs: Map(epoch → epochSeq), events: [] }
  }
  #topic(topic) {
    let r = this.rings.get(topic)
    if (!r) { r = { stream: null, epoch: null, epochSeq: 0, epochs: new Map(), events: [] }; this.rings.set(topic, r) }
    return r
  }
  // The registrar hello: `epoch` becomes the topic's only accepted epoch from now on.
  // Returns {ok, epochSeq}; re-registering the current epoch is idempotent; an older one is refused.
  registerEpoch(topic, epoch) {
    if (typeof epoch !== 'string' || !epoch) return { ok: false, reason: 'envelope' }
    const r = this.#topic(topic)
    if (r.epochs.has(epoch)) return epoch === r.epoch ? { ok: true, epochSeq: r.epochSeq } : { ok: false, reason: 'epoch-reused' }
    r.epochSeq += 1
    r.epochs.set(epoch, r.epochSeq)
    r.epoch = epoch
    r.stream = null                // the stream string is learned from the first event of this epoch
    r.events = []                  // ring resets; seq restarts per (stream, topic)
    return { ok: true, epochSeq: r.epochSeq }
  }
  append(ev) {
    if (!validEvent(ev)) return { ok: false, reason: 'envelope' }
    const { epoch } = splitStream(ev.stream)
    const r = this.#topic(ev.topic)
    if (r.epoch === null) this.registerEpoch(ev.topic, epoch)       // implicit first adoption (no registrar in the loop)
    else if (epoch !== r.epoch) return { ok: false, reason: 'stale-epoch' }
    if (r.stream === null) r.stream = ev.stream
    const last = r.events[r.events.length - 1]
    if (last && ev.seq <= last.seq) return { ok: false, reason: 'seq-not-monotonic' }
    r.events.push(ev)
    if (r.events.length > this.ringSize) r.events.splice(0, r.events.length - this.ringSize)
    return { ok: true }
  }
  // One host push. The whole batch is refused when too large or when any event claims a stream
  // that is not this host's (C4 test 4: a forged `host1:*` from host2 is a 403 at ingest).
  ingest(hostId, events) {
    if (!Array.isArray(events)) return { ok: false, reason: 'envelope' }
    if (events.length > this.maxBatch) return { ok: false, reason: 'batch-too-large', max: this.maxBatch }
    for (let i = 0; i < events.length; i++) {
      const s = splitStream(events[i]?.stream)
      if (!s || s.hostId !== hostId) return { ok: false, reason: 'envelope', index: i }
    }
    const rejected = []
    let accepted = 0
    events.forEach((ev, index) => { const a = this.append(ev); if (a.ok) accepted++; else rejected.push({ index, reason: a.reason }) })
    return { ok: true, accepted, rejected }
  }
  epochOf(topic) { const r = this.rings.get(topic); return r ? { epoch: r.epoch, epochSeq: r.epochSeq } : null }
  head(topic) {
    const r = this.rings.get(topic)
    if (!r || !r.events.length) return null
    return { stream: r.stream, seq: r.events[r.events.length - 1].seq }
  }
  // cursor = {stream, seq} | null → {events, gap, streamChange}
  since(topic, cursor) {
    const r = this.rings.get(topic)
    if (!r || !r.events.length) return { events: [], gap: false, streamChange: false }
    if (!cursor || !cursor.stream || cursor.stream !== r.stream) return { events: r.events.slice(), gap: false, streamChange: true }
    const ev = r.events
    const head = ev[ev.length - 1].seq
    if (cursor.seq > head) return { events: [], gap: true, streamChange: false }           // ahead of the ring: inconsistent, re-snapshot
    if (ev[0].seq > cursor.seq + 1) return { events: [], gap: true, streamChange: false }  // fell off the ring (head − cursor > ring when contiguous)
    let i = ev.length - 1
    while (i >= 0 && ev[i].seq > cursor.seq) i--
    return { events: ev.slice(i + 1), gap: false, streamChange: false }
  }
}

// ---- socket frames (server → tab) and client messages (tab → server)
export const frames = {
  subscribed: ({ topic, stream, seq }) => ({ type: 'subscribed', topic, stream, seq }),
  resumed: ({ topic, stream, seq }) => ({ type: 'resumed', topic, stream, seq }),
  denied: ({ topic }) => ({ type: 'denied', topic }),
  gap: ({ topic, stream }) => ({ type: 'gap', topic, stream }),
  invalidate: (ev) => ({ type: 'invalidate', stream: ev.stream, topic: ev.topic, seq: ev.seq }),
  ping: ({ at }) => ({ type: 'ping', at }),
}
export const messages = {
  sub: ({ topics }) => ({ op: 'sub', topics }),
  resume: ({ topic, stream, seq }) => ({ op: 'resume', topic, stream, seq }),
  pong: ({ at }) => ({ op: 'pong', at }),
}
const isTopic = (t) => typeof t === 'string' && t.length > 0
const isStreamOrNull = (s) => s === null || !!splitStream(s)
export function isFrame(f) {
  if (!f || typeof f !== 'object') return false
  switch (f.type) {
    case 'subscribed':
    case 'resumed': return isTopic(f.topic) && isStreamOrNull(f.stream) && isSeq(f.seq)
    case 'denied': return isTopic(f.topic)
    case 'gap': return isTopic(f.topic) && isStreamOrNull(f.stream)
    case 'invalidate': return validEvent(f)
    case 'ping': return Number.isInteger(f.at)
    default: return false
  }
}
export function isClientMessage(m) {
  if (!m || typeof m !== 'object') return false
  switch (m.op) {
    case 'sub': return Array.isArray(m.topics) && m.topics.length > 0 && m.topics.every(isTopic)
    case 'resume': return isTopic(m.topic) && !!splitStream(m.stream) && isSeq(m.seq)
    case 'pong': return Number.isInteger(m.at)
    default: return false
  }
}
