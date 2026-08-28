// host/errors/collector.mjs — the host's single entry point for every app error (PLAN §4.3 "App
// errors reach the agent, always", OR16; DESIGN §4.2). Build failures, worker exceptions, HTTP
// 5xx, worker deaths and frontend reports all arrive as report(kind, instance, rev, detail) and
// leave as AppErrorEvents (protocol/app-errors validateAppError shape, nothing else) to every
// sink: agent.log always, the spine push in fleet mode, the dev shell's recent() ring.
//
// What the collector decides (the rest is the spine's — the 10-min fold and the 6/h·12/h caps
// run there over protocol/app-errors coalesce()):
//   - stale-rev: an error whose rev is below running(instance) is dropped BEFORE any sink; the
//     running rev is the registration fact (supervisor onSwap → setRunning).
//   - fingerprint: protocol fingerprint() — kind + file:line + message head.
//   - the 1 s tally: the FIRST report of a (instance, fingerprint, rev) goes out at once (a build
//     error must land within ~300 ms of the save [S:g4]); every further report of the same
//     fingerprint inside the next TALLY_MS is folded into ONE trailing event with count/firstAt/
//     lastAt — a storm of 1 000 reports a second is two events a second, and the spine folds
//     the trailing event into the same record (count += N, no new delivery). A report from a
//     NEWER rev closes the open tally and goes out at once: the fold is per (instance, rev),
//     never across saves.
//   - caps: message ≤ MAX_MESSAGE_CHARS, stack ≤ MAX_STACK_CHARS, hint ≤ MAX_HINT_CHARS,
//     sample.url ≤ MAX_URL_CHARS, sample.ua ≤ MAX_UA_CHARS; sample carries ONLY
//     {url, ua, request:{method, path, status}} — nothing about the person.
//   - a sink that throws is logged and never stops the other sinks.
import { fingerprint, validateAppError, APP_ERROR_KINDS, MAX_MESSAGE_CHARS, MAX_STACK_CHARS, MAX_HINT_CHARS, MAX_URL_CHARS, MAX_UA_CHARS } from '../../protocol/index.js'

export const TALLY_MS = 1000
export const RECENT_MAX = 200
export const say = (log, text) => { if (typeof log === 'function') log(text); else log?.line?.(text) }
const cut = (s, n) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n) : s) : undefined)

/** buildEvent(kind, instance, rev, detail, at) → AppErrorEvent (unvalidated; the caller validates). */
export function buildEvent(kind, instance, rev, detail = {}, at) {
  const message = cut(String(detail.message ?? ''), MAX_MESSAGE_CHARS)
  const ev = { instance, rev, kind, fingerprint: fingerprint({ kind, file: detail.file, line: detail.line, message }), count: 1, firstAt: at, lastAt: at, message }
  if (typeof detail.file === 'string') ev.file = detail.file
  if (Number.isInteger(detail.line)) ev.line = detail.line
  if (Number.isInteger(detail.col)) ev.col = detail.col
  const stack = cut(detail.stack, MAX_STACK_CHARS); if (stack !== undefined) ev.stack = stack
  const hint = cut(detail.hint, MAX_HINT_CHARS); if (hint !== undefined) ev.hint = hint
  const sample = sampleOf(detail.sample); if (sample) ev.sample = sample
  return ev
}

function sampleOf(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return undefined
  const out = {}
  const url = cut(s.url, MAX_URL_CHARS); if (url !== undefined) out.url = url
  const ua = cut(s.ua, MAX_UA_CHARS); if (ua !== undefined) out.ua = ua
  const r = s.request
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    const request = {}
    const method = cut(r.method, 16); if (method !== undefined) request.method = method
    const path = cut(r.path, MAX_URL_CHARS); if (path !== undefined) request.path = path
    if (Number.isInteger(r.status)) request.status = r.status
    if (Object.keys(request).length) out.request = request
  }
  return Object.keys(out).length ? out : undefined
}

/** exitDetail(code, signal) → the `worker` detail for a process that died on its own (spawn onExit):
 *  message `exit 134` | `signal SIGSEGV`, with the fix hint the agent reads. */
export function exitDetail(code, signal) {
  const message = signal ? `signal ${signal}` : `exit ${code}`
  const hint = code === 134 || signal === 'SIGABRT'
    ? 'the worker aborted (V8 out of heap or a native crash); check for an unbounded cache or a native module, then save — the host restarts the worker with backoff'
    : 'the worker process died; the host restarts it with backoff — a clean exit from the app (process.exit) is a bug, an app never exits itself'
  return { message, hint }
}

/**
 * createCollector({ log, now, timers, tallyMs })
 *   .report(kind, instance, rev, detail) → {ok:true, fingerprint, emitted:boolean} | {ok:false, reason}
 *       detail = {message, stack?, file?, line?, col?, hint?, sample?:{url?, ua?, request?:{method, path, status}}}
 *   .setRunning(instance, rev)   the registration fact; a changed rev closes that instance's open tallies
 *   .running(instance) → number|undefined
 *   .sink(fn)                    fn(ev, {running}) — called for every emitted event; returns an unsubscribe
 *   .recent(instance, n = 50) → AppErrorEvent[]   oldest → newest, the last n
 *   .now()                       the clock the collector stamps with (integer ms)
 *   .flush()                     emit every open tally now (teardown)
 */
export function createCollector({ log, now = Date.now, timers = { setTimeout, clearTimeout }, tallyMs = TALLY_MS } = {}) {
  const runningRev = new Map()          // instance → rev
  const sinks = []
  const recentByInstance = new Map()    // instance → AppErrorEvent[]
  const tallies = new Map()             // `${instance}\0${fingerprint}` → {rev, pending, timer}

  function emit(ev) {
    const v = validateAppError(ev)
    if (!v.ok) { say(log, `collector: schema ${v.reason} — dropped ${ev.kind} for ${ev.instance}`); return false }
    const run = runningRev.get(ev.instance)
    if (run !== undefined && ev.rev < run) return false          // went stale while tallying
    const ring = recentByInstance.get(ev.instance) ?? []
    ring.push(ev); if (ring.length > RECENT_MAX) ring.splice(0, ring.length - RECENT_MAX)
    recentByInstance.set(ev.instance, ring)
    const ctx = { running: run }
    for (const fn of [...sinks]) { try { fn(ev, ctx) } catch (e) { say(log, `collector: sink threw ${e?.message ?? e}`) } }
    return true
  }

  function closeTally(key) {
    const t = tallies.get(key); if (!t) return
    tallies.delete(key)
    if (t.timer !== null) timers.clearTimeout(t.timer)
    if (t.pending) emit(t.pending)
  }

  return {
    now,
    report(kind, instance, rev, detail = {}) {
      if (!APP_ERROR_KINDS.includes(kind)) { say(log, `collector: bad kind ${String(kind)}`); return { ok: false, reason: 'bad-kind' } }
      if (typeof instance !== 'string' || !instance) { say(log, 'collector: bad instance'); return { ok: false, reason: 'bad-instance' } }
      if (!Number.isInteger(rev) || rev < 0) { say(log, `collector: bad rev ${String(rev)} for ${instance}`); return { ok: false, reason: 'bad-rev' } }
      const run = runningRev.get(instance)
      if (run !== undefined && rev < run) return { ok: false, reason: 'stale-rev' }
      const at = now()
      const ev = buildEvent(kind, instance, rev, detail, at)
      const key = `${instance}\0${ev.fingerprint}`
      let open = tallies.get(key)
      if (open && rev > open.rev) { closeTally(key); open = undefined }     // a newer save: never fold across revs
      if (open) {
        // inside the window: fold into the trailing event (latest message/stack/sample/hint win)
        const p = open.pending
        open.pending = p ? { ...ev, count: p.count + 1, firstAt: p.firstAt, lastAt: at } : ev
        return { ok: true, fingerprint: ev.fingerprint, emitted: false }
      }
      const emitted = emit(ev)
      if (!emitted) return { ok: false, reason: 'schema' }
      const t = { rev, pending: null, timer: null }
      t.timer = timers.setTimeout(() => closeTally(key), tallyMs)
      tallies.set(key, t)
      return { ok: true, fingerprint: ev.fingerprint, emitted: true }
    },
    setRunning(instance, rev) {
      if (typeof instance !== 'string' || !instance || !Number.isInteger(rev) || rev < 0) return
      const prev = runningRev.get(instance)
      runningRev.set(instance, rev)
      if (prev === rev) return
      for (const key of [...tallies.keys()]) if (key.startsWith(instance + '\0')) closeTally(key)   // emit() drops what went stale
    },
    running: (instance) => runningRev.get(instance),
    sink(fn) { sinks.push(fn); return () => { const i = sinks.indexOf(fn); if (i >= 0) sinks.splice(i, 1) } },
    recent(instance, n = 50) { const r = recentByInstance.get(instance) ?? []; return r.slice(Math.max(0, r.length - n)) },
    flush() { for (const key of [...tallies.keys()]) closeTally(key) },
  }
}
