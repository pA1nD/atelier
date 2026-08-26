// App errors reach the agent, always (PLAN §0 OR19, §4.3 "App errors reach the agent"). The host
// collects every error an app produces — build, backend, http 5xx, worker deaths, frontend
// reports from the kit — and the spine delivers them into the conversation: injected mid-turn,
// a new turn when idle, coalesced so a storm is one message. Silence means LIVE. No hook, no
// polling, no BUILDING.
//
// This module is the coalescing policy as a pure, serialisable state machine so the host, the
// spine and the tests agree on WHAT is delivered and WHEN. One state object per CHAT (the
// conversation the deliveries land in); instances are the chat's apps. The window constants are
// policy, not protocol: exported by name so the spine pins them. protocol/ is the single source
// for the wire shape and the vectors — the spine's own copy (step1-spine) differs today and must
// be ported before a host built on this file can push a single error (README, the diff list).
//
// Rules (§4.3):
//   - fingerprint = kind + file:line + message head (80 chars, first line).
//   - the same fingerprint within FOLD_WINDOW_MS (10 min) of its last delivery is one record with
//     count/firstAt/lastAt — no new message.
//   - per app at most HOURLY_CAP (6) deliveries an hour; the rest fold into `pending` and go out
//     as ONE "+N more" delivery when the hour window reopens (flush()).
//   - per CHAT at most CHAT_HOURLY_CAP (12) deliveries an hour across all its apps (review
//     2026-08-26): every idle-path delivery is a pod wake plus a claude turn, 24/7; a fleet-wide
//     incident (one dependency down for 12 apps) would otherwise be 72 turns an hour per chat —
//     the storm the coalescer exists to prevent, one level up. Over the chat cap a delivery folds
//     into pending exactly like the app cap (`chat-capped`).
//   - errors from a rev older than the running one are dropped (a fleet ship restarting every
//     host is not news). The running rev is a REGISTRATION fact: the host reports it at
//     registration / modules-changed and the spine records it with setRunning() (review
//     2026-08-26: learned only from error events, a rev that built clean is silence and a late
//     error from the older rev was still delivered). A NEWER rev — from setRunning() or from an
//     error event, a save's build error is proof of the save — resets the app's records and its
//     hourly window: the build error of that save must land within ~300 ms [S:g4] even when the
//     same file:line failed in the previous rev — the fold and the cap are per (instance, rev),
//     never across saves. (Policy choice recorded here; not in §4.3's text.)
//   - `rev` CONTRACT (review 2026-08-26): a per-instance counter the host persists on the volume
//     under its root-owned marker dir (`/work/.atelier/<instance>/revision.json`, §4.3) and
//     bumps on every LIVE-or-FAILED build; strictly increasing across host restarts, container
//     restarts and pod recreations. A host restart re-registers the SAME rev (idempotent, no
//     reset). setRunning() is authoritative even when the reported rev is lower (a host that lost
//     its counter): registration is a fact, and the alternative — every later error `stale-rev`
//     until the counter catches up — is the silent channel OR19 forbids.
//   - a frontend report's `rev` is NEVER trusted (review 2026-08-26): fromFrontendReport() takes
//     the host's running rev and drops a report whose body.rev differs (`rev-mismatch`) — a
//     member's tab, or an app looping on console.error with a stale rev, could otherwise mint
//     deliveries without bound and silence the real channel by advancing `running`.
//   - bounded state (review 2026-08-26): at most MAX_PENDING records wait per instance, the rest
//     is an `overflow` counter the "+N more" summary includes; at most MAX_OPEN fingerprints per
//     instance (oldest lastAt evicted, pending ones kept); message ≤ MAX_MESSAGE_CHARS, stack ≤
//     MAX_STACK_CHARS, sample.url ≤ MAX_URL_CHARS, hint ≤ MAX_HINT_CHARS — the spine persists
//     this state per chat and copies the delivery object on every coalesce.
//   - `hint` is the host's fix line — the 8/8 failure classification of [S:agent-contract-1]
//     (`<file>:<line>:<col> <message> — <fix>`) travels host → spine → agent verbatim;
//     formatForAgent() prefers it over the generic per-kind HINTS.

export const APP_ERROR_KINDS = ['build', 'backend', 'frontend', 'http', 'worker']
export const FOLD_WINDOW_MS = 10 * 60 * 1000
export const HOURLY_CAP = 6
export const CHAT_HOURLY_CAP = 12
export const HOUR_MS = 60 * 60 * 1000
export const MESSAGE_HEAD_CHARS = 80
export const MAX_AGENT_TEXT = 2000
export const MAX_PENDING = 20
export const MAX_OPEN = 200
export const MAX_MESSAGE_CHARS = 1000
export const MAX_STACK_CHARS = 4000
export const MAX_URL_CHARS = 1024
export const MAX_HINT_CHARS = 200
export const MAX_UA_CHARS = 200
const OPTIONAL_KEYS = ['stack', 'sample', 'file', 'line', 'col', 'hint']
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
  if (typeof ev.message !== 'string' || ev.message.length > MAX_MESSAGE_CHARS) return bad('schema:message')
  if (ev.stack !== undefined && (typeof ev.stack !== 'string' || ev.stack.length > MAX_STACK_CHARS)) return bad('schema:stack')
  if (ev.hint !== undefined && (typeof ev.hint !== 'string' || ev.hint.length > MAX_HINT_CHARS)) return bad('schema:hint')
  if (ev.sample !== undefined) {
    if (!ev.sample || typeof ev.sample !== 'object' || Array.isArray(ev.sample)) return bad('schema:sample')
    if (ev.sample.url !== undefined && (typeof ev.sample.url !== 'string' || ev.sample.url.length > MAX_URL_CHARS)) return bad('schema:sample')
  }
  if (ev.file !== undefined && typeof ev.file !== 'string') return bad('schema:file')
  for (const k of ['line', 'col']) if (ev[k] !== undefined && !Number.isInteger(ev[k])) return bad('schema:' + k)
  return { ok: true }
}

// fromFrontendReport(body, now, {rev}) → {ok:true, ev} | {ok:false, reason}
// POST /_atelier/report {instance, rev, url, ua, message, stack} → an app-error event of kind
// frontend. `rev` is the host's running revision for that instance — the body's rev only has to
// AGREE with it (a stale tab reports against a rev that is gone: dropped, `rev-mismatch`). Nothing
// about the person is carried beyond what the shell's own id gives the host; every other key in
// the body is ignored, never copied.
export function fromFrontendReport({ instance, rev: bodyRev, url, ua, message, stack } = {}, now, { rev } = {}) {
  if (!Number.isInteger(rev)) return { ok: false, reason: 'no-running-rev' }
  if (bodyRev !== rev) return { ok: false, reason: 'rev-mismatch' }
  const msg = String(message ?? '').slice(0, MAX_MESSAGE_CHARS)
  const ev = {
    instance, rev, kind: 'frontend',
    fingerprint: fingerprint({ kind: 'frontend', message: msg }),
    count: 1, firstAt: now, lastAt: now,
    message: msg,
    sample: { url: typeof url === 'string' ? url.slice(0, MAX_URL_CHARS) : undefined, ua: typeof ua === 'string' ? ua.slice(0, MAX_UA_CHARS) : undefined },
  }
  if (typeof stack === 'string') ev.stack = stack.slice(0, MAX_STACK_CHARS)
  return { ok: true, ev }
}

// One state per chat: running/open/hourly/pending/overflow keyed by instance; chatHourly shared.
export const emptyState = () => ({ running: {}, open: {}, hourly: {}, pending: {}, overflow: {}, chatHourly: [] })

const prune = (list, now) => list.filter((t) => t > now - HOUR_MS)
const record = (ev, now) => ({
  kind: ev.kind, fingerprint: ev.fingerprint, count: ev.count, newCount: ev.count, firstAt: ev.firstAt, lastAt: ev.lastAt,
  lastDeliveredAt: null, message: ev.message, stack: ev.stack, sample: ev.sample, file: ev.file, line: ev.line, col: ev.col, hint: ev.hint, rev: ev.rev, at: now,
})
const strip = (rec) => { const r = { ...rec }; for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k]; delete r.lastDeliveredAt; delete r.at; return r }
const resetInstance = (next, instance, rev) => {
  next.running = { ...next.running, [instance]: rev }
  next.open = { ...next.open, [instance]: {} }
  next.hourly = { ...next.hourly, [instance]: [] }
  next.pending = { ...next.pending, [instance]: [] }
  next.overflow = { ...next.overflow, [instance]: 0 }
}
// Keep `open` bounded: evict the oldest-lastAt fingerprints that are not waiting in pending.
const boundOpen = (open, pending) => {
  const keys = Object.keys(open)
  if (keys.length <= MAX_OPEN) return open
  const waiting = new Set(pending.map((r) => r.fingerprint))
  const evictable = keys.filter((k) => !waiting.has(k)).sort((a, b) => open[a].lastAt - open[b].lastAt)
  const out = { ...open }
  for (const k of evictable.slice(0, keys.length - MAX_OPEN)) delete out[k]
  return out
}

// setRunning(state, instance, rev) → state. The host's registration / modules-changed fact.
// A different rev (higher OR lower, see the contract above) resets the instance; the same rev is
// a no-op, so a host restart re-registering its persisted rev keeps every fold window.
export function setRunning(state, instance, rev) {
  if (!Number.isInteger(rev) || rev < 0 || typeof instance !== 'string' || !instance) return state
  if (state.running[instance] === rev) return state
  const next = { ...state }
  resetInstance(next, instance, rev)
  return next
}

// flush(state, now) → {state, deliver}: emits the "+N more" delivery for every instance whose hour
// window reopened (app cap AND chat cap) and has pending records or overflow. The spine calls it
// on its sweep; coalesce() calls it for the event's instance before processing. One delivery per
// call (per instance), so a caller loops until deliver is null. `onlyInstance` limits the sweep
// to one app (coalesce uses it).
export function flush(state, now, onlyInstance) {
  for (const instance of Object.keys(state.pending)) {
    if (onlyInstance !== undefined && instance !== onlyInstance) continue
    const pend = state.pending[instance] ?? []
    const overflow = state.overflow?.[instance] ?? 0
    if (!pend.length && !overflow) continue
    const hourly = prune(state.hourly[instance] ?? [], now)
    const chatHourly = prune(state.chatHourly ?? [], now)
    if (hourly.length >= HOURLY_CAP || chatHourly.length >= CHAT_HOURLY_CAP) continue   // still capped: the sweep tries again later
    const next = {
      ...state,
      pending: { ...state.pending, [instance]: [] },
      overflow: { ...state.overflow, [instance]: 0 },
      hourly: { ...state.hourly, [instance]: [...hourly, now] },
      chatHourly: [...chatHourly, now],
    }
    const open = { ...(next.open[instance] ?? {}) }
    for (const rec of pend) if (open[rec.fingerprint]) open[rec.fingerprint] = { ...open[rec.fingerprint], lastDeliveredAt: now, newCount: 0 }
    next.open = { ...next.open, [instance]: open }
    const rev = pend.length ? Math.max(...pend.map((r) => r.rev)) : state.running[instance]
    const folded = pend.length + overflow
    return { state: next, deliver: { instance, rev, at: now, summary: `+${folded} more`, folded, records: pend.map(strip) } }
  }
  return { state, deliver: null }
}

// coalesce(state, ev, now) → {state, deliver: null | Delivery, reason?}
//   Delivery = {instance, rev, at, records:[record], summary?, folded?}
export function coalesce(state, ev, now) {
  const v = validateAppError(ev)
  if (!v.ok) return { state, deliver: null, reason: v.reason }
  const { instance } = ev
  const running = state.running[instance]
  if (running !== undefined && ev.rev < running) return { state, deliver: null, reason: 'stale-rev' }
  let next = { ...state, open: { ...state.open }, hourly: { ...state.hourly }, pending: { ...state.pending }, overflow: { ...state.overflow } }
  if (running === undefined || ev.rev > running) resetInstance(next, instance, ev.rev)
  // a reopened hour window drains the pending summary first — never silently
  const drained = flush(next, now, instance)
  next = drained.state
  const open = { ...(next.open[instance] ?? {}) }
  const existing = open[ev.fingerprint]
  if (existing) {
    const rec = { ...existing, count: existing.count + ev.count, newCount: existing.newCount + ev.count, lastAt: Math.max(existing.lastAt, ev.lastAt), message: ev.message, stack: ev.stack ?? existing.stack, sample: ev.sample ?? existing.sample, hint: ev.hint ?? existing.hint }
    open[ev.fingerprint] = rec
    next.open[instance] = open
    const pendingHere = (next.pending[instance] ?? []).some((r) => r.fingerprint === ev.fingerprint)
    if (pendingHere) { next.pending[instance] = next.pending[instance].map((r) => (r.fingerprint === ev.fingerprint ? rec : r)); return { state: next, deliver: drained.deliver, reason: 'folded-pending' } }
    if (existing.lastDeliveredAt !== null && now - existing.lastDeliveredAt < FOLD_WINDOW_MS) return { state: next, deliver: drained.deliver, reason: 'folded' }
  }
  const rec = existing ? open[ev.fingerprint] : record(ev, now)
  const hourly = prune(next.hourly[instance] ?? [], now)
  const chatHourly = prune(next.chatHourly ?? [], now)
  if (drained.deliver) {
    // the hour's first free slot just went to the drained summary: this record rides along in it
    open[ev.fingerprint] = { ...rec, lastDeliveredAt: now, newCount: 0 }
    next.open[instance] = boundOpen(open, next.pending[instance] ?? [])
    next.hourly[instance] = hourly
    next.chatHourly = chatHourly
    const folded = drained.deliver.folded + 1
    const d = { ...drained.deliver, rev: Math.max(drained.deliver.rev, ev.rev), folded, summary: `+${folded} more`, records: [...drained.deliver.records, strip(rec)] }
    return { state: next, deliver: d, reason: 'merged' }
  }
  const capped = hourly.length >= HOURLY_CAP ? 'capped' : chatHourly.length >= CHAT_HOURLY_CAP ? 'chat-capped' : null
  if (capped) {
    open[ev.fingerprint] = rec
    const pend = next.pending[instance] ?? []
    if (pend.length < MAX_PENDING) next.pending[instance] = [...pend, rec]
    else next.overflow[instance] = (next.overflow[instance] ?? 0) + 1
    next.open[instance] = boundOpen(open, next.pending[instance] ?? [])
    next.hourly[instance] = hourly
    next.chatHourly = chatHourly
    return { state: next, deliver: null, reason: capped }
  }
  open[ev.fingerprint] = { ...rec, lastDeliveredAt: now, newCount: 0 }
  next.open[instance] = boundOpen(open, next.pending[instance] ?? [])
  next.hourly[instance] = [...hourly, now]
  next.chatHourly = [...chatHourly, now]
  return { state: next, deliver: { instance, rev: ev.rev, at: now, records: [strip(rec)] } }
}

// Generic per-kind hints — used only when the host sent no `hint` (the classification line).
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
  if (delivery.summary) lines.push(`app-error ${app} rev ${delivery.rev}: ${delivery.summary} (folded — ${HOURLY_CAP}/h per app, ${CHAT_HOURLY_CAP}/h per chat; each line is one distinct error${delivery.folded > delivery.records.length ? `, ${delivery.folded - delivery.records.length} not listed` : ''})`)
  for (const r of delivery.records) {
    const times = r.count > 1 ? ` ×${r.count} (first ${iso(r.firstAt)}, last ${iso(r.lastAt)})` : ` at ${iso(r.lastAt)}`
    if (!delivery.summary) lines.push(`app-error ${app} rev ${r.rev ?? delivery.rev} ${r.kind}${times}`)
    lines.push(`${delivery.summary ? '- ' : ''}${loc(r)} ${messageHead(r.message, 200)}`)
    if (!delivery.summary) {
      lines.push(`fix: ${r.hint ?? HINTS[r.kind](r)}`)
      const rq = reqLine(r.sample)
      if (rq) lines.push(rq)
      if (r.stack) lines.push('stack: ' + r.stack.split('\n').slice(0, 4).map((l) => l.trim()).join(' | '))
    }
  }
  const text = lines.join('\n')
  return text.length > MAX_AGENT_TEXT ? text.slice(0, MAX_AGENT_TEXT - 1) + '…' : text
}
