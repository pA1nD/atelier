// host/errors/push.mjs — app-error → spine (PLAN §4.3: events travel host → spine on the
// registrar's lane; DESIGN §4.2, §7 `transport.appError`). The body is exactly the step-1
// contract's (agent-orchestrator/docs/step1-contract.md "Channel events"):
//   {kind:'app-error', error:<AppErrorEvent>}   — nested under `error` because the event's own
//   `kind` is build|backend|frontend|http|worker; the spine's parseAppError is protocol/'s
//   validateAppError, so the same validator runs here FIRST: a refused event is a host bug
//   (logged `push: schema <reason>`, dropped), never a 400 at the spine.
// The transport (protocol/registrar.mjs, fleet only) owns the URL, the bearer token, the epoch
// and the re-registration on `401 host-epoch-moved`; push owns the queue and the retry ladder:
//   - one request in flight; the queue holds ≤ QUEUE_MAX events, the OLDEST is dropped past it
//     (a full queue means the spine was unreachable for a while — the freshest state matters
//     when it returns; what was dropped is counted and logged once per DROP_LOG_EVERY);
//   - a transport rejection with a 4xx `status` (except 401/408/429) is dropped with a log line —
//     the spine refused the event and a retry would refuse it again;
//   - anything else (5xx, no status = network, 401 while the transport re-registers, 408, 429)
//     is retried at backoffMs[i] then the last rung forever, the ladder reset on success;
//   - `running(instance)` (the collector's) drops an event that went stale while it waited.
import { validateAppError } from '../../protocol/index.js'
import { say } from './collector.mjs'

export const QUEUE_MAX = 200
export const DROP_LOG_EVERY = 100
export const BACKOFF_MS = [500, 2000, 8000, 30000]
const RETRYABLE_4XX = new Set([401, 408, 429])

/**
 * push({ transport, backoffMs, queueMax, log, timers, running }) → sink(ev)
 *   sink.size()      queued (excluding the one in flight)
 *   sink.inFlight()  boolean
 *   sink.dropped()   events dropped since boot (queue overflow + 4xx + stale)
 *   sink.idle()      Promise that resolves when the queue is empty and nothing is in flight
 *   sink.stop()      stop retrying (teardown); queued events are left, never sent
 */
export function push({ transport, backoffMs = BACKOFF_MS, queueMax = QUEUE_MAX, log, timers = { setTimeout, clearTimeout }, running } = {}) {
  const queue = []
  let inFlight = false
  let attempt = 0
  let timer = null
  let stopped = false
  let dropped = 0
  let overflow = 0
  const waiters = []

  function settleIdle() { if (!inFlight && !queue.length) for (const w of waiters.splice(0)) w() }
  function drop(reason) { dropped++; say(log, `push: ${reason}`) }

  async function pump() {
    if (inFlight || stopped) return
    while (queue.length && running) {
      const head = queue[0]
      const run = running(head.instance)
      if (run !== undefined && head.rev < run) { queue.shift(); dropped++; continue }
      break
    }
    if (!queue.length) { settleIdle(); return }
    const ev = queue[0]
    inFlight = true
    try {
      await transport.appError({ kind: 'app-error', error: ev })
      queue.shift(); attempt = 0; inFlight = false
      pump()
    } catch (e) {
      inFlight = false
      const status = Number.isInteger(e?.status) ? e.status : null
      if (status !== null && status >= 400 && status < 500 && !RETRYABLE_4XX.has(status)) {
        queue.shift(); drop(`${status} ${e?.message ?? ''} — dropped ${ev.kind} ${ev.fingerprint} for ${ev.instance}`.trim())
        attempt = 0
        pump(); return
      }
      const wait = backoffMs[Math.min(attempt, backoffMs.length - 1)]
      attempt++
      if (attempt === 1 || attempt % 10 === 0) say(log, `push: ${status ?? e?.code ?? 'network'} ${e?.message ?? ''} — retry in ${wait} ms (${queue.length} queued)`.replace(/\s+—/, ' —'))
      if (stopped) return
      timer = timers.setTimeout(() => { timer = null; pump() }, wait)
    }
  }

  function sink(ev) {
    if (stopped) return
    const v = validateAppError(ev)
    if (!v.ok) { drop(`schema ${v.reason} — dropped ${ev?.kind} for ${ev?.instance}`); return }
    queue.push(ev)
    if (queue.length > queueMax) {
      queue.splice(inFlight ? 1 : 0, 1)      // never the one being sent
      dropped++; overflow++
      if (overflow % DROP_LOG_EVERY === 1) say(log, `push: queue full (${queueMax}) — dropped oldest (${overflow} so far)`)
    }
    pump()
  }
  sink.size = () => queue.length - (inFlight ? 1 : 0)
  sink.inFlight = () => inFlight
  sink.dropped = () => dropped
  sink.idle = () => (!inFlight && !queue.length ? Promise.resolve() : new Promise((r) => waiters.push(r)))
  sink.stop = () => { stopped = true; if (timer !== null) { timers.clearTimeout(timer); timer = null } }
  return sink
}
