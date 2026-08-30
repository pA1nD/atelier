// shell/waking.mjs — the waking page and `/_atelier/wake` (DESIGN §3.5; PLAN §4.3 Network).
// A document route whose host is waking (fleet: heartbeat older than 30 s or draining; both modes:
// the 1 s probe failed) serves this page: no chrome, plain, status 503, `Retry-After: 3`,
// `Cache-Control: no-store`, a 2 s JS poll of `/_atelier/wake?company=<c>[&app=<slug>]` that
// reloads on `{ok:true}` — BOUNDED (review 2026-08-30, C13): nothing in the fleet wakes a chat pod
// outside a turn (the wake verb is step 7's sleep/wake), so after WAKE_GIVE_UP_MS of `{ok:false}` the
// page stops polling and says so honestly — the computer is asleep, a message in its chat wakes it.
// No `<meta refresh>`: a reload would re-arm the poll forever. Fetch routes answer `503 {waking:true}`
// (proxy.mjs) and the client shows its own fallback (client/waking.js — its own backoff is unbounded;
// R3-12 keeps client/ closed in step 5, named in LANES-STEP5 Deferred).
export const WAKE_POLL_MS = 2000
export const WAKE_GIVE_UP_MS = 60_000
export const ASLEEP_COPY = 'This computer is asleep — send a message in its chat to wake it (it comes back within a minute of your message).'
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

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

export function wakingHtml({ company, slug = null, nonce }) {
  const url = `/_atelier/wake?company=${encodeURIComponent(company ?? '')}${slug ? `&app=${encodeURIComponent(slug)}` : ''}`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Waking up…</title>
<style>html{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif}main{max-width:32rem;padding:1rem}p{opacity:.7}</style>
</head><body><main><h1 id="h">Waking up ${esc(company ?? '')}…</h1><p id="p">The computer behind this app is starting. This page reloads by itself.</p></main>
<script nonce="${esc(nonce)}">(function(){var t=${WAKE_POLL_MS},until=Date.now()+${WAKE_GIVE_UP_MS};function asleep(){document.title='Asleep';document.getElementById('h').textContent='Asleep';document.getElementById('p').textContent=${JSON.stringify(ASLEEP_COPY)}}function poll(){if(Date.now()>until){asleep();return}fetch(${JSON.stringify(url)},{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){if(j&&j.ok)location.reload();else setTimeout(poll,t)}).catch(function(){setTimeout(poll,t)})}setTimeout(poll,t)})();</script>
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
