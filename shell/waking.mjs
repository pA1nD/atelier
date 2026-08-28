// shell/waking.mjs — the waking page and `/_atelier/wake` (DESIGN §3.5; PLAN §4.3 Network).
// A document route whose host is waking (fleet: heartbeat older than 30 s or draining; both modes:
// the 1 s probe failed) serves this page: no chrome, plain, status 503, `Retry-After: 3`,
// `Cache-Control: no-store`, a `<meta refresh>` of 3 s plus a 2 s JS poll of
// `/_atelier/wake?company=<c>` that reloads on `{ok:true}`. Fetch routes answer `503 {waking:true}`
// (proxy.mjs) and the client shows its own fallback.
export const WAKE_POLL_MS = 2000
export const HEARTBEAT_STALE_MS = 30_000

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

export function wakingHtml({ company, nonce }) {
  const url = `/_atelier/wake?company=${encodeURIComponent(company ?? '')}`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="3"><title>Waking up…</title>
<style>html{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif}p{opacity:.7}</style>
</head><body><main><h1>Waking up ${esc(company ?? '')}…</h1><p>The computer behind this app is starting. This page reloads by itself.</p></main>
<script nonce="${esc(nonce)}">(function(){var t=${WAKE_POLL_MS};function poll(){fetch(${JSON.stringify(url)},{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){if(j&&j.ok)location.reload();else setTimeout(poll,t)}).catch(function(){setTimeout(poll,t)})}setTimeout(poll,t)})();</script>
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

// hostState({registry, hostLink, bus, company, now}) → {waking:false, hostRow, probe} | {waking:true, reason, hostRow}
export async function hostState({ registry, hostLink, bus, company, now = Date.now, staleMs = HEARTBEAT_STALE_MS }) {
  const hostRow = await registry.host(company)
  if (!hostRow) return { waking: true, reason: 'no-host', hostRow: null }
  if (hostRow.drainingAt != null) return { waking: true, reason: 'draining', hostRow }
  if (registry.kind === 'fleet' && (hostRow.heartbeatAt == null || now() - hostRow.heartbeatAt > staleMs)) return { waking: true, reason: 'heartbeat-stale', hostRow }
  const probe = await hostLink.probe(hostRow)
  registry.noteProbe?.(company, probe)
  if (probe.ok) await bus?.reprobe?.(company, probe)
  return probe.ok ? { waking: false, hostRow, probe } : { waking: true, reason: probe.code ?? 'probe', hostRow }
}
