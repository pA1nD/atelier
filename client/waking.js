// waking.js — the client half of the waking page (shell/DESIGN.md §3.5, §4): a shell fetch that
// answers `503 {waking:true}` (+ `x-atelier-waking: 1`) means the company's computer is asleep
// or restarting. The client shows a plain fallback and polls `/_atelier/wake?company=<c>` with a
// 2 s → 10 s backoff; `{ok:true}` → full reload. App fetches are the app's own; this covers the
// shell's (`/_atelier/*` snapshots, the bundle imports).

export const WAKE_MIN_MS = 2000
export const WAKE_MAX_MS = 10000

export function nextWakeDelay(prev) {
  if (prev == null) return WAKE_MIN_MS
  return Math.min(prev * 2, WAKE_MAX_MS)
}

export function isWakingResponse(res) {
  if (!res || res.status !== 503) return false
  const h = res.headers && typeof res.headers.get === 'function' ? res.headers.get('x-atelier-waking') : null
  return h === '1' || h === null || h === undefined      // a 503 without the header still counts as waking
}

export function wakeUrl(company) {
  return `/_atelier/wake?company=${encodeURIComponent(company || '')}`
}

// startWakePoll({fetch, setTimeout, clearTimeout, company, reload, onTick}) → stop()
export function startWakePoll({ fetch, setTimeout, clearTimeout, company, reload, onTick = () => {} }) {
  let timer = null, delay = null, stopped = false
  const tick = async () => {
    timer = null
    let ok = false
    try {
      const r = await fetch(wakeUrl(company), { cache: 'no-store', credentials: 'same-origin' })
      if (r.ok) { const j = await r.json().catch(() => ({})); ok = j && j.ok === true }
    } catch {}
    if (stopped) return
    onTick({ ok, delay })
    if (ok) { reload(); return }
    delay = nextWakeDelay(delay)
    timer = setTimeout(tick, delay)
  }
  delay = nextWakeDelay(null)
  timer = setTimeout(tick, delay)
  return () => { stopped = true; if (timer) clearTimeout(timer); timer = null }
}
