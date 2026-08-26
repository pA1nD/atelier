// App errors reach the agent, always (PLAN §0 OR19, §4.3 "App errors reach the agent"). The host
// collects every error an app produces — build, backend, http 5xx, worker deaths, frontend
// reports from the kit — and the spine delivers them into the conversation: injected mid-turn,
// a new turn when idle, coalesced so a storm is one message. Silence means LIVE. No hook, no
// polling, no BUILDING.
//
// This module is the coalescing policy as a pure, serialisable state machine so the host, the
// spine and the tests agree on WHAT is delivered and WHEN. The window constants are policy, not
// protocol: exported by name so the spine can pin them. The spine lane keeps a copy of
// vectors/app-errors.json until the repos share the file (README).
//
// Rules (§4.3):
//   - fingerprint = kind + file:line + message head (80 chars, first line).
//   - the same fingerprint within FOLD_WINDOW_MS (10 min) of its last delivery is one record with
//     count/firstAt/lastAt — no new message.
//   - per app at most HOURLY_CAP (6) deliveries an hour; the rest fold into `pending` and go out
//     as ONE "+N more" delivery when the hour window reopens (flush()).
//   - errors from a rev older than the running one are dropped (a fleet ship restarting every
//     host is not news). A NEWER rev resets the app's records and its hourly window: a new rev
//     is Bayard's own save, and the build error of that save must land within ~300 ms
//     [S:g4] even when the same file:line failed in the previous rev — the fold and the cap are
//     per (instance, rev), never across saves. (Policy choice recorded here; not in §4.3's text.)

export const APP_ERROR_KINDS = ['build', 'backend', 'frontend', 'http', 'worker']
export const FOLD_WINDOW_MS = 10 * 60 * 1000
export const HOURLY_CAP = 6
export const HOUR_MS = 60 * 60 * 1000
export const MESSAGE_HEAD_CHARS = 80
export const MAX_AGENT_TEXT = 2000
const OPTIONAL_KEYS = ['stack', 'sample', 'file', 'line', 'col']
const REQUIRED_KEYS = ['instance', 'rev', 'kind', 'fingerprint', 'count', 'firstAt', 'lastAt', 'message']

export function messageHead(message, n = MESSAGE_HEAD_CHARS) {
  const line = String(message ?? '').split('\n')[0].trim()
  return line.length > n ? line.slice(0, n) : line
}
export function fingerprint({ kind, file, line, message }) {
  return `${kind}|${file ?? '-'}:${line ?? '-'}|${messageHead(message)}`
}

// validateAppError(ev) → {ok:true} | {ok:false, reason}. The wire shape host → spine.
export function validateAppError(ev) {
  const bad = (reason) => ({ ok: false, reason })
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return bad('schema')
  for (const k of Object.keys(ev)) if (!REQUIRED_KEYS.includes(k) && !OPTIONAL_KEYS.includes(k)) return bad('schema:' + k)
  if (typeof ev.instance !== 'string' || !ev.instance) return bad('schema:instance')
  if (!Number.isInteger(ev.rev) || ev.rev < 0) return bad('schema:rev')
  if (!APP_ERROR_KINDS.includes(ev.kind)) return bad('schema:kind')
  if (typeof ev.fingerprint !== 'string' || !ev.fingerprint) return bad('schema:fingerprint')
  if (!Number.isInteger(ev.count) || ev.count < 1) return bad('schema:count')
  if (!Number.isInteger(ev.firstAt) || !Number.isInteger(ev.lastAt) || ev.lastAt < ev.firstAt) return bad('schema:at')
  if (typeof ev.message !== 'string') return bad('schema:message')
  if (ev.stack !== undefined && typeof ev.stack !== 'string') return bad('schema:stack')
  if (ev.sample !== undefined && (!ev.sample || typeof ev.sample !== 'object')) return bad('schema:sample')
  if (ev.file !== undefined && typeof ev.file !== 'string') return bad('schema:file')
  for (const k of ['line', 'col']) if (ev[k] !== undefined && !Number.isInteger(ev[k])) return bad('schema:' + k)
  return { ok: true }
}

// fromFrontendReport(body, now): POST /_atelier/report {instance, rev, url, ua, message, stack}
// → an app-error event of kind frontend. Nothing about the person is carried beyond what the
// shell's own id gives the host; every other key in the body is ignored, never copied.
export function fromFrontendReport({ instance, rev, url, ua, message, stack } = {}, now) {
  const ev = {
    instance, rev, kind: 'frontend',
    fingerprint: fingerprint({ kind: 'frontend', message }),
    count: 1, firstAt: now, lastAt: now,
    message: String(message ?? ''),
    sample: { url: typeof url === 'string' ? url : undefined, ua: typeof ua === 'string' ? ua.slice(0, 200) : undefined },
  }
  if (typeof stack === 'string') ev.stack = stack.slice(0, 4000)
  return ev
}

export const emptyState = () => ({ running: {}, open: {}, hourly: {}, pending: {} })

const prune = (list, now) => list.filter((t) => t > now - HOUR_MS)
const record = (ev, now) => ({
  kind: ev.kind, fingerprint: ev.fingerprint, count: ev.count, newCount: ev.count, firstAt: ev.firstAt, lastAt: ev.lastAt,
  lastDeliveredAt: null, message: ev.message, stack: ev.stack, sample: ev.sample, file: ev.file, line: ev.line, col: ev.col, rev: ev.rev, at: now,
})
const strip = (rec) => { const r = { ...rec }; for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k]; delete r.lastDeliveredAt; delete r.at; return r }

// flush(state, now) → {state, deliver}: emits the "+N more" delivery for every instance whose hour
// window reopened and has pending records. The spine calls it on its sweep; coalesce() calls it
// for the event's instance before processing. One delivery per call (per instance), so a caller
// loops until deliver is null. `onlyInstance` limits the sweep to one app (coalesce uses it).
export function flush(state, now, onlyInstance) {
  for (const instance of Object.keys(state.pending)) {
    if (onlyInstance !== undefined && instance !== onlyInstance) continue
    const pend = state.pending[instance]
    if (!pend || !pend.length) continue
    const hourly = prune(state.hourly[instance] ?? [], now)
    if (hourly.length >= HOURLY_CAP) continue                     // still capped: the sweep tries again later
    const next = { ...state, pending: { ...state.pending, [instance]: [] }, hourly: { ...state.hourly, [instance]: [...hourly, now] } }
    const open = { ...(next.open[instance] ?? {}) }
    for (const rec of pend) if (open[rec.fingerprint]) open[rec.fingerprint] = { ...open[rec.fingerprint], lastDeliveredAt: now, newCount: 0 }
    next.open = { ...next.open, [instance]: open }
    const rev = Math.max(...pend.map((r) => r.rev))
    return { state: next, deliver: { instance, rev, at: now, summary: `+${pend.length} more`, records: pend.map(strip) } }
  }
  return { state, deliver: null }
}

// coalesce(state, ev, now) → {state, deliver: null | Delivery, reason?}
//   Delivery = {instance, rev, at, records:[record], summary?}
export function coalesce(state, ev, now) {
  const v = validateAppError(ev)
  if (!v.ok) return { state, deliver: null, reason: v.reason }
  const { instance } = ev
  const running = state.running[instance]
  if (running !== undefined && ev.rev < running) return { state, deliver: null, reason: 'stale-rev' }
  let next = { ...state, running: { ...state.running, [instance]: ev.rev }, open: { ...state.open }, hourly: { ...state.hourly }, pending: { ...state.pending } }
  if (running === undefined || ev.rev > running) { next.open[instance] = {}; next.hourly[instance] = []; next.pending[instance] = [] }
  // a reopened hour window drains the pending summary first — never silently
  const drained = flush(next, now, instance)
  next = drained.state
  const open = { ...(next.open[instance] ?? {}) }
  const existing = open[ev.fingerprint]
  if (existing) {
    const rec = { ...existing, count: existing.count + ev.count, newCount: existing.newCount + ev.count, lastAt: Math.max(existing.lastAt, ev.lastAt), message: ev.message, stack: ev.stack ?? existing.stack, sample: ev.sample ?? existing.sample }
    open[ev.fingerprint] = rec
    next.open[instance] = open
    const pendingHere = (next.pending[instance] ?? []).some((r) => r.fingerprint === ev.fingerprint)
    if (pendingHere) { next.pending[instance] = next.pending[instance].map((r) => (r.fingerprint === ev.fingerprint ? rec : r)); return { state: next, deliver: drained.deliver, reason: 'folded-pending' } }
    if (existing.lastDeliveredAt !== null && now - existing.lastDeliveredAt < FOLD_WINDOW_MS) return { state: next, deliver: drained.deliver, reason: 'folded' }
  }
  const rec = existing ? open[ev.fingerprint] : record(ev, now)
  const hourly = prune(next.hourly[instance] ?? [], now)
  if (drained.deliver) {
    // the hour's first free slot just went to the drained summary: this record rides along in it
    open[ev.fingerprint] = { ...rec, lastDeliveredAt: now, newCount: 0 }
    next.open[instance] = open
    next.hourly[instance] = hourly
    const d = { ...drained.deliver, rev: Math.max(drained.deliver.rev, ev.rev), records: [...drained.deliver.records, strip(rec)] }
    d.summary = `+${d.records.length} more`
    return { state: next, deliver: d, reason: 'merged' }
  }
  if (hourly.length >= HOURLY_CAP) {
    open[ev.fingerprint] = rec
    next.open[instance] = open
    next.hourly[instance] = hourly
    next.pending[instance] = [...(next.pending[instance] ?? []), rec]
    return { state: next, deliver: null, reason: 'capped' }
  }
  open[ev.fingerprint] = { ...rec, lastDeliveredAt: now, newCount: 0 }
  next.open[instance] = open
  next.hourly[instance] = [...hourly, now]
  return { state: next, deliver: { instance, rev: ev.rev, at: now, records: [strip(rec)] } }
}

const HINTS = {
  build: (r) => `fix ${loc(r)} and save — the build re-runs on save; users stay on the last good rev until it passes`,
  backend: () => 'the worker threw while handling the request below; fix the handler and save (the worker reloads, no restart needed)',
  http: () => 'a route answered 5xx; the request below reproduces it — check the handler for the thrown error or the missing await',
  frontend: (r) => `reported by the kit from a browser at ${r.sample?.url ?? 'an unknown url'}; reproduce there and read the first stack frame`,
  worker: () => 'the worker process died (crash or watchdog: RSS/CPU/disk); the host restarts it with backoff — fix the cause and save',
}
const loc = (r) => (r.file ? `${r.file}:${r.line ?? '-'}${r.col !== undefined ? ':' + r.col : ''}` : '(no file)')
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const reqLine = (s) => (s?.request ? `request: ${s.request.method ?? ''} ${s.request.path ?? ''}${s.request.status ? ' → ' + s.request.status : ''}`.trim() : null)

// formatForAgent(delivery, {appName}) → the text the spine pastes into the conversation (≤ 2000 chars).
export function formatForAgent(delivery, { appName } = {}) {
  const app = appName ?? delivery.instance
  const lines = []
  if (delivery.summary) lines.push(`app-error ${app} rev ${delivery.rev}: ${delivery.summary} (folded — ${HOURLY_CAP}/h cap; each line is one distinct error)`)
  for (const r of delivery.records) {
    const times = r.count > 1 ? ` ×${r.count} (first ${iso(r.firstAt)}, last ${iso(r.lastAt)})` : ` at ${iso(r.lastAt)}`
    if (!delivery.summary) lines.push(`app-error ${app} rev ${r.rev ?? delivery.rev} ${r.kind}${times}`)
    lines.push(`${delivery.summary ? '- ' : ''}${loc(r)} ${messageHead(r.message, 200)}`)
    if (!delivery.summary) {
      lines.push(`fix: ${HINTS[r.kind](r)}`)
      const rq = reqLine(r.sample)
      if (rq) lines.push(rq)
      if (r.stack) lines.push('stack: ' + r.stack.split('\n').slice(0, 4).map((l) => l.trim()).join(' | '))
    }
  }
  const text = lines.join('\n')
  return text.length > MAX_AGENT_TEXT ? text.slice(0, MAX_AGENT_TEXT - 1) + '…' : text
}
