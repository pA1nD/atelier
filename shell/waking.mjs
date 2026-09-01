// shell/waking.mjs — the waking page, `/_atelier/wake` and the wake call (DESIGN §3.5; PLAN §4.3 Network).
// A document route whose host is waking (fleet: heartbeat older than 30 s or draining; both modes:
// the 1 s probe failed) serves this page: no chrome, plain, status 503, `Retry-After: 3`,
// `Cache-Control: no-store`, a 2 s JS poll of `/_atelier/wake?company=<c>[&app=<slug>]` that
// reloads on `{ok:true}`. The poll PROBES and, when the host is not serving, WAKES it (step 7):
// the route calls `registry.wake(chat)` — the fleet provider's verb, the spine's
// `POST /v1/computers/<chat>/wake` door — at most once per chat per WAKE_CALL_MS (`createWaker`;
// the spine rate-bounds too, and a 2 s poll must not hammer it). Local mode has no verb (the CLI
// restarts a dead host by itself, README §4), so the poll only probes there. `{ok:true}` still means
// exactly "the host answered a probe". BOUNDED (review 2026-08-30, C13): after WAKE_GIVE_UP_MS of
// `{ok:false}` the page stops polling and says so — the wake was sent, the computer is taking
// unusually long, the person reloads by hand (nothing reloads for them). No `<meta refresh>`: a
// reload would re-arm the poll forever. Fetch routes answer `503 {waking:true}` (proxy.mjs) and
// the client shows its own fallback (client/waking.js — the same poll, the same 60 s bound).
export const WAKE_POLL_MS = 2000
export const WAKE_GIVE_UP_MS = 60_000
export const WAKE_CALL_MS = 30_000
export const ASLEEP_COPY = 'This computer is taking unusually long to wake, and this page has stopped checking. Wait a minute, then reload this page.'
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

// The wake call (one per shell): `wake({chat, company, reason})` sends the registry's `wake(chat)`
// once per chat per WAKE_CALL_MS and answers what it did — 'sent' | 'failed' (the call threw; the
// window is kept so a broken spine is not hammered either) | 'held' (inside the window) |
// 'no-target' (nothing names a chat: an app-less document of a company the spine knows no
// computer for) | 'no-verb' (the provider has none — local mode). Keyed by the CHAT because that
// is what the spine's door takes and a chat owns exactly one computer, so chat = host. The route
// FIRES the call and does not await it (the door is a pod birth, up to 30 s; the portal's client
// puts no clock on it) — its answer never depends on it: `ok` is the probe's; every throw is
// caught here, so a fired call is never an unhandled rejection. THE FLEET'S SILENT GAPS ARE SAID
// (review 2026-09-02): a fleet registry without the verb (a portal whose spine client has no
// `wake` — an older portal in front of this shell) is logged once per process, and a fleet dial
// row that names no chat is logged once per company per window — the spine puts `chat` on every
// row, so a row without one is a contract break (the portal's row shaping dropped it), not a
// state; 'no-host' is not logged here (the spine itself said there is no computer). Local mode has
// no verb by design and stays silent.
export function createWaker({ registry, ms = WAKE_CALL_MS, now = Date.now, log = () => {} }) {
  const sent = new Map()   // chat (or `no-target:<company>`) → until
  const fleet = registry.kind === 'fleet'
  let saidNoVerb = false
  return {
    async wake({ chat, company = null, reason = null }) {
      if (typeof registry.wake !== 'function') {
        if (fleet && !saidNoVerb) { saidNoVerb = true; log('wake: the fleet registry has no wake verb (a portal without spine.wake?) — the poll only probes, nothing wakes') }
        return 'no-verb'
      }
      const t = now()
      for (const [k, until] of sent) if (until <= t) sent.delete(k)
      if (!chat) {
        const k = `no-target:${company ?? '?'}`
        if (fleet && reason !== 'no-host' && !sent.has(k)) { sent.set(k, t + ms); log(`wake: ${company ?? '?'} host row names no chat (${reason ?? 'waking'}) — nothing to wake; the portal's dial row must carry the spine's \`chat\``) }
        return 'no-target'
      }
      if (sent.has(chat)) return 'held'
      sent.set(chat, t + ms)
      try { await registry.wake(chat); log(`wake: ${company ?? '?'} ${chat} (${reason ?? 'waking'})`); return 'sent' }
      catch (e) { log(`wake: ${company ?? '?'} ${chat} (${reason ?? 'waking'}) failed: ${e?.code ?? e?.message ?? e}`); return 'failed' }
    },
  }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

export function wakingHtml({ company, slug = null, nonce }) {
  const url = `/_atelier/wake?company=${encodeURIComponent(company ?? '')}${slug ? `&app=${encodeURIComponent(slug)}` : ''}`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Waking up…</title>
<style>html{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif}main{max-width:32rem;padding:1rem}p{opacity:.7}</style>
</head><body><main><h1 id="h">Waking up ${esc(company ?? '')}…</h1><p id="p">The computer behind this app is starting. This page reloads by itself.</p></main>
<script nonce="${esc(nonce)}">(function(){var t=${WAKE_POLL_MS},until=Date.now()+${WAKE_GIVE_UP_MS};function asleep(){document.title='Still waking…';document.getElementById('h').textContent='Still waking…';document.getElementById('p').textContent=${JSON.stringify(ASLEEP_COPY)}}function poll(){if(Date.now()>until){asleep();return}fetch(${JSON.stringify(url)},{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){if(j&&j.ok)location.reload();else setTimeout(poll,t)}).catch(function(){setTimeout(poll,t)})}setTimeout(poll,t)})();</script>
</body></html>
`
}

export function wakingHeaders({ nonce }) {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'retry-after': '3',
    'x-atelier-waking': '1',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
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
