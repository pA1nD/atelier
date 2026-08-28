// host/protocol/events.mjs — invalidations out to the spine stream (DESIGN §4.3; PLAN §4.4
// "Events"; seed spike-c4/host.js, ported: seq per (stream, topic), one request in flight,
// batches ≤ 128 = ring/2).
//
// Frames are protocol/events' `{stream:'<hostId>:<epoch>', topic:<instance>, seq, type:'invalidate'}`
// (validEvent on every frame before it leaves). Rules from C4 the host side owns:
//   - coalesce per instance per flush: N invalidations of one instance in one tick carry no more
//     information than one (surprise 2); the pending set holds INSTANCES, frames are minted at flush.
//   - batches ≤ maxBatch (128 < ring/2, surprise 2); one POST in flight; the next flush waits.
//   - seq is per (stream, topic) and restarts at 1 when the stream changes — the stream changes when
//     the registrar hands out a new epoch (re-registration); pending instances survive the change
//     and are minted under the new stream (a frame of the old epoch would be `stale-epoch` at ingest).
//   - a failed push keeps its instances pending and retries with a bounded backoff; frames are
//     never re-sent as they were — they are re-minted (the ring wants monotonic seq per stream,
//     and a re-mint after a stream change is the only correct shape).
//   - a frame the ring REJECTED as `stale-epoch` / `unregistered` (minted under an epoch the host
//     has since moved past, or before the registration landed) is an invalidation not yet
//     delivered: its instance goes back to pending and is re-minted under the current stream.
//     Other rejections (`seq-gap`, `bad-frame`) are logged and dropped — a host bug, not a retry.
import { validEvent } from '../../protocol/index.js'

export const MAX_BATCH = 128
export const RETRY_MS = [50, 200, 1000, 5000]
export const REQUEUE_REASONS = new Set(['stale-epoch', 'unregistered'])

/**
 * createEvents({ transport, hostId, epoch, flushMs, maxBatch, log, setTimer, clearTimer })
 *   hostId / epoch: a value or a function (the registrar knows them only after register()).
 *   transport.events(batch) → Promise<{accepted, rejected}> (throws on network/5xx).
 */
export function createEvents({ transport, hostId, epoch, flushMs = 10, maxBatch = MAX_BATCH, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const id = () => (typeof hostId === 'function' ? hostId() : hostId)
  const ep = () => (typeof epoch === 'function' ? epoch() : epoch)
  const pending = new Set()           // instances awaiting a frame
  const seqs = new Map()              // topic → last seq, valid for `seqStream`
  let seqStream = null
  let timer = null, inflight = null, retries = 0
  const stats = { pushed: 0, failed: 0, batches: 0, maxBatch: 0, rejected: 0, requeued: 0 }
  let stopped = false

  function stream() {
    const h = id(), e = ep()
    if (!h || !e) return null
    const s = `${h}:${e}`
    if (s !== seqStream) { seqStream = s; seqs.clear() }   // epoch bump → seq restarts per topic
    return s
  }
  function mint(s, topic) {
    const seq = (seqs.get(topic) ?? 0) + 1
    seqs.set(topic, seq)
    const ev = { stream: s, topic, seq, type: 'invalidate' }
    if (!validEvent(ev)) throw new Error('events: minted an invalid frame ' + JSON.stringify(ev))
    return ev
  }

  function schedule(ms = flushMs) {
    if (timer || stopped) return
    timer = setTimer(() => { timer = null; flush() }, ms)
  }

  // One push. Returns the promise of that push (tests await it); a second call while one is in
  // flight returns the in-flight promise — the queue is drained by the chain.
  function flush() {
    if (inflight) return inflight
    if (!pending.size) return Promise.resolve()
    const s = stream()
    if (!s) { schedule(1000); return Promise.resolve() }     // not registered yet: hold
    const instances = [...pending].slice(0, maxBatch)
    for (const i of instances) pending.delete(i)
    const batch = instances.map((i) => mint(s, i))
    stats.batches++; if (batch.length > stats.maxBatch) stats.maxBatch = batch.length
    inflight = Promise.resolve()
      .then(() => transport.events(batch))
      .then((r) => {
        retries = 0
        stats.pushed += batch.length
        if (r && Array.isArray(r.rejected) && r.rejected.length) {
          stats.rejected += r.rejected.length
          log(`events: ${r.rejected.length} rejected ${JSON.stringify(r.rejected.slice(0, 3))}`)
          for (const rej of r.rejected) {
            if (!REQUEUE_REASONS.has(rej?.reason)) continue
            const frame = Number.isInteger(rej.index) ? batch[rej.index] : null
            if (frame) { pending.add(frame.topic); stats.requeued++ }
          }
        }
      })
      .catch((e) => {
        stats.failed += batch.length
        for (const i of instances) pending.add(i)              // re-queue the instances, re-mint later
        const ms = RETRY_MS[Math.min(retries++, RETRY_MS.length - 1)]
        log(`events: push failed (${e?.message ?? e}), retry in ${ms} ms`)
        schedule(ms)
      })
      .finally(() => { inflight = null; if (pending.size && !timer) schedule() })
    return inflight
  }

  return {
    invalidate(instance) { if (typeof instance !== 'string' || !instance) return; pending.add(instance); schedule() },
    flush,
    // teardown: one best-effort push bounded by `capMs`
    drain(capMs = 1000) {
      if (timer) { clearTimer(timer); timer = null }
      return Promise.race([flush(), new Promise((r) => setTimer(r, capMs))])
    },
    stop() { stopped = true; if (timer) { clearTimer(timer); timer = null } },
    stream, stats, pending, seqs,
  }
}
