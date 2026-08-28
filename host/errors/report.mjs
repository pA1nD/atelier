// host/errors/report.mjs — POST /_atelier/report (PLAN §4.3: frontend errors from the kit —
// window.onerror, unhandledrejection, console.error opt-in; DESIGN §4.2). The protocol server
// resolves the body's instance to a row of THIS host and calls the function below; the wire
// shape and the rev rule are protocol/app-errors fromFrontendReport: the body's rev only has to
// AGREE with the host's running rev (a stale tab is `rev-mismatch`, never a new running rev).
//
// Nothing about the person beyond the id the shell holds: only {url, ua, message, stack} are read
// from the body; every other key is ignored, never copied (a `person`, `email` or `cookie` key in
// the body is dead on arrival). A tab looping on console.error is bounded here at RATE_PER_MIN
// accepted reports per instance per minute (`rate-limited`) — the push queue and the spine's
// caps are the next fences, but a flood must not crowd out a backend error at the host.
import { fromFrontendReport } from '../../protocol/index.js'

export const RATE_PER_MIN = 60
const MINUTE_MS = 60_000

/**
 * frontendReport({ collector, now = collector.now, ratePerMin }) → (body, {instance}) → {ok:true, fingerprint} | {ok:false, reason}
 *   reasons: bad-body | no-message | no-running-rev | rev-mismatch | rate-limited | <collector reason>
 */
export function frontendReport({ collector, now, ratePerMin = RATE_PER_MIN }) {
  const clock = now ?? collector.now ?? Date.now
  const buckets = new Map()   // instance → {start, n}
  function allow(instance, at) {
    const b = buckets.get(instance)
    if (!b || at - b.start >= MINUTE_MS) { buckets.set(instance, { start: at, n: 1 }); return true }
    if (b.n >= ratePerMin) return false
    b.n++; return true
  }
  return function report(body, { instance } = {}) {
    if (typeof instance !== 'string' || !instance) return { ok: false, reason: 'bad-instance' }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'bad-body' }
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (!message) return { ok: false, reason: 'no-message' }
    const at = clock()
    const r = fromFrontendReport({ instance, rev: body.rev, url: body.url, ua: body.ua, message, stack: body.stack }, at, { rev: collector.running(instance) })
    if (!r.ok) return r
    if (!allow(instance, at)) return { ok: false, reason: 'rate-limited' }
    const { ev } = r
    const out = collector.report('frontend', instance, ev.rev, { message: ev.message, stack: ev.stack, sample: ev.sample })
    return out.ok ? { ok: true, fingerprint: out.fingerprint } : out
  }
}
