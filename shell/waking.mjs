// shell/waking.mjs — the waking state, `/_atelier/wake` and the wake call (DESIGN §3.5; PLAN §4.3 Network).
// A document route whose host is waking (fleet: heartbeat older than 30 s or draining; both modes:
// the 1 s probe failed) serves THE DOCUMENT with `waking` in its bootstrap (2026-09-17; before: a bare
// page without the chrome): status 503, `Retry-After: 3`, `x-atelier-waking: 1`, `Cache-Control:
// no-store` (document.mjs renderDocument). The client renders the chrome with a waking panel in the
// content area and runs the poll (client/waking.js startWakePoll: 2 s → 5 s, the bounds below) of
// `/_atelier/wake?company=<c>[&app=<slug>]`, reloading on `{ok:true}`. The poll PROBES and, when the host is not serving, WAKES it (step 7):
// the route calls `registry.wake(chat, {by})` — the fleet provider's verb, the spine's
// `POST /v1/computers/<chat>/wake {by:"session:<id>"}` door — at most once per chat per WAKE_CALL_MS
// per replica and never while a call is in flight (`createWaker`; the spine's own bound is the real
// limit). Never a DRAINING computer (the drain is somebody's decision — a rollout, the 24 h sleep —
// and a wake would fight it: probe only); never for a caller who is not present on the target chat
// (routes.mjs decides; the spine refuses too). Local mode has no verb (the CLI restarts a dead host
// by itself, README §4), so the poll only probes there. `{ok:true}` still means exactly "the host
// answered a probe". BOUNDED (review 2026-08-30, C13; 2026-09-02): after the give-up — WAKE_GIVE_UP_MS
// locally, WAKE_GIVE_UP_FLEET_MS in the fleet, where a cold pod birth is a schedule, a 700 MB pull and
// a host boot — of `{ok:false}` the page stops polling and says so; every poll fetch is aborted at the
// remaining deadline (a hung shell cannot hold the poll past it); a tab that comes back to the front
// (`visibilitychange`) probes at once and starts its deadline over, so the give-up is only ever reached
// in front of someone. No `<meta refresh>`: a reload would re-arm the poll forever. Fetch routes answer
// `503 {waking:true}` (proxy.mjs) and the client shows the same panel (client/waking.js — the same
// poll, the same bounds). The constants below are the contract the client keeps by hand
// (client/waking.js WAKE_GIVE_UP_*, client/client.jsx ASLEEP_COPY) — the bundle cannot import shell/.
export const WAKE_GIVE_UP_MS = 60_000
export const WAKE_GIVE_UP_FLEET_MS = 180_000
export const WAKE_CALL_MS = 30_000
export const ASLEEP_COPY = 'This computer is taking unusually long to wake, and this page has stopped checking. Wait a minute, then reload this page.'
// the shape of a chat id the door is asked about (the spine's canonical ids: `g_<base64url>`, `p_<hex>`, a mapped name)
export const CHAT_RE = /^[A-Za-z0-9_-]{1,64}$/
export const WAKE_OUTCOMES = ['sent', 'up', 'refused', 'unconfirmed', 'failed', 'held']
export const HEARTBEAT_STALE_MS = 30_000
export const WAKING_MARK_MS = 2000

// The waking marks (one set per shell): a host that just failed a probe or a dial is answered
// 503 {waking:true} on fetch routes for WAKING_MARK_MS without a new dial — a stopped computer
// costs one second once, not one second (or the 30 s idle cap) per request; a mark expires by
// itself and the next request dials. Keyed by the HOST (`hostKey`: its address — a company owns
// one host per chat it owns in the fleet, review 2026-08-30; one host per workspace locally), so a
// stopped chat pod marks its own apps waking and no other pod's. The local registry's
// `unreachableAt(company)` (a failed /_atelier/apps fetch) counts as a mark for that company too.
export const hostKey = (hostRow, company) => (hostRow ? `${hostRow.ip}:${hostRow.port}` : `company:${company}`)
export function createWakingMarks({ ms = WAKING_MARK_MS } = {}) {
  const marks = new Map()
  return {
    mark(key, now = Date.now()) { if (key) marks.set(key, now + ms) },
    clear(key) { marks.delete(key) },
    isWaking(key, now = Date.now(), registry = null, company = null) {
      const at = registry?.unreachableAt?.(company ?? key)
      if (at != null && now - at < ms) return true
      const until = marks.get(key)
      if (until === undefined) return false
      if (until <= now) { marks.delete(key); return false }
      return true
    },
  }
}

// The wake call (one per shell): `wake({chat, company, reason, by})` sends the registry's `wake(chat, {by})`
// once per chat per WAKE_CALL_MS and never while a call for that chat is in flight (`{until, inFlight}` per
// chat: a hung door gets no second socket, however long it holds), and answers what it did:
//   'sent'         the spine accepted the create (202 waking)
//   'up'           the spine says the pod is live already (200 up) — the host inside it is what failed the
//                  probe; the wake did nothing, the spine's sweep is the repair
//   'refused'      the spine said no ({ok:false} with its reason: not present in the chat, no usable login,
//                  the fleet's wake bound, a plane below v41) — logged with the reason
//   'unconfirmed'  no verdict: the portal's clock ran out (the create may still land), a 2xx without a state,
//                  a verb that answers nothing
//   'failed'       the call threw (a provider that throws; the portal's never does)
//   'held'         inside the window, or a call in flight
//   'no-target' | 'bad-target' | 'no-actor' | 'no-verb'   nothing sent: no chat / not a chat id / no `by` /
//                  the provider has no verb (local mode)
// THE VERDICT IS READ (review 2026-09-02): the provider answers `{ok, state, reason, error, status}` (the
// portal's spine client) and the log says which — never `sent` for a refusal. The window is kept on every
// outcome (a refusing spine is not hammered either). Keyed by the CHAT because that is what the spine's door
// takes and a chat owns exactly one computer. `by` is the caller — `session:<portal session id>` — and a
// call without one is never sent: the spine resolves the actor and refuses a person who is not in the chat.
// The route FIRES the call and does not await it: its answer never depends on it (`ok` is the probe's); the
// whole body is inside one try, so a fired call is never an unhandled rejection, a throwing log included.
// THE FLEET'S SILENT GAPS ARE SAID: a fleet registry without the verb (an older portal) is logged once per
// process; a dial row that names no chat, or one whose chat is not a chat id, once per company per window
// (the spine puts `chat` on every row — a row without one is a contract break, not a state); 'no-host' is
// not logged (the spine itself said there is no computer). Local mode has no verb by design and stays silent.
// `stats()` → the counters the metrics exposition reads (WAKE_OUTCOMES + inFlight).
export function createWaker({ registry, ms = WAKE_CALL_MS, now = Date.now, log = () => {} }) {
  const calls = new Map()    // chat → { until, inFlight }
  const said = new Map()     // `<kind>:<company>` → until (the once-per-window gap lines)
  const fleet = registry.kind === 'fleet'
  let saidNoVerb = false
  const counts = Object.fromEntries(WAKE_OUTCOMES.map((k) => [k, 0]))
  let inFlight = 0
  const sayOnce = (key, t, line) => { if (fleet && !(said.get(key) > t)) { said.set(key, t + ms); log(line) } }
  const verdictOf = (r) => {
    if (r == null || typeof r !== 'object') return { verdict: 'unconfirmed', detail: 'unconfirmed: no verdict' }
    if (r.state === 'unconfirmed') return { verdict: 'unconfirmed', detail: `unconfirmed: ${r.reason ?? r.error ?? '?'}` }
    if (r.ok === true && r.state === 'up') return { verdict: 'up', detail: 'up' }
    if (r.ok === true && r.state === 'waking') return { verdict: 'sent', detail: 'sent' }
    if (r.ok === false) return { verdict: 'refused', detail: `refused: ${r.error ?? r.reason ?? r.status ?? '?'}` }
    return { verdict: 'unconfirmed', detail: `unconfirmed: no verdict (${JSON.stringify(r.state ?? null)})` }
  }
  return {
    stats: () => ({ ...counts, inFlight }),
    async wake({ chat, company = null, reason = null, by = null }) {
      try {
        if (typeof registry.wake !== 'function') {
          if (fleet && !saidNoVerb) { saidNoVerb = true; log('wake: the fleet registry has no wake verb (a portal without spine.wake?) — the poll only probes, nothing wakes') }
          return 'no-verb'
        }
        const t = now()
        for (const [k, until] of said) if (until <= t) said.delete(k)
        for (const [k, c] of calls) if (c.until <= t && !c.inFlight) calls.delete(k)
        const who = `${company ?? '?'}`
        if (!chat) {
          if (reason !== 'no-host') sayOnce(`no-target:${who}`, t, `wake: ${who} host row names no chat (${reason ?? 'waking'}) — nothing to wake; the portal's dial row must carry the spine's \`chat\``)
          return 'no-target'
        }
        if (typeof chat !== 'string' || !CHAT_RE.test(chat)) { sayOnce(`bad-target:${who}`, t, `wake: ${who} host row's chat ${JSON.stringify(String(chat)).slice(0, 80)} is not a chat id (${reason ?? 'waking'}) — nothing sent`); return 'bad-target' }
        if (typeof by !== 'string' || !by) { sayOnce(`no-actor:${who}`, t, `wake: ${who} ${chat} (${reason ?? 'waking'}) has no actor — nothing sent (a wake names who asked)`); return 'no-actor' }
        const c = calls.get(chat)
        if (c && (c.inFlight || c.until > t)) { counts.held++; return 'held' }
        const entry = { until: t + ms, inFlight: true }
        calls.set(chat, entry); inFlight++
        let out
        try { const r = await registry.wake(chat, { by }); out = verdictOf(r) }
        catch (e) { out = { verdict: 'failed', detail: `failed: ${e?.code ?? e?.message ?? e}` } }
        finally { entry.inFlight = false; inFlight-- }
        counts[out.verdict]++
        log(`wake: ${who} ${chat} (${reason ?? 'waking'}) ${out.detail}`)
        return out.verdict
      } catch (e) { try { log(`wake: ${company ?? '?'} ${chat ?? '?'} threw: ${e?.message ?? e}`) } catch {} return 'failed' }
    },
  }
}

// hostState({registry, hostLink, bus, company, app, now}) → {waking:false, hostRow, probe} | {waking:true, reason, hostRow}
// The host is the APP's (`registry.hostOf(row)` — the computer its row lives on); with no app row
// (an app-less document, `/<c>/`) it is the company's freshest (`registry.host(c)`): "is anything
// of this company up". Marks are per host (hostKey).
export async function hostState({ registry, hostLink, bus, company, app = null, marks = null, now = Date.now, staleMs = HEARTBEAT_STALE_MS }) {
  const hostRow = app ? await registry.hostOf(app) : await registry.host(company)
  const key = hostKey(hostRow, company)
  if (!hostRow) { marks?.mark(key, now()); return { waking: true, reason: 'no-host', hostRow: null } }
  if (hostRow.drainingAt != null) return { waking: true, reason: 'draining', hostRow }
  if (registry.kind === 'fleet' && (hostRow.heartbeatAt == null || now() - hostRow.heartbeatAt > staleMs)) return { waking: true, reason: 'heartbeat-stale', hostRow }
  const probe = await hostLink.probe(hostRow)
  registry.noteProbe?.(company, probe)
  if (probe.ok) { marks?.clear(key); await bus?.reprobe?.(company, probe); return { waking: false, hostRow, probe } }
  marks?.mark(key, now())
  return { waking: true, reason: probe.code ?? 'probe', hostRow }
}
