// waking.js — the client half of the waking page (shell/DESIGN.md §3.5, §4): a shell fetch that
// answers `503 {waking:true}` (+ `x-atelier-waking: 1`) means the company's computer is asleep
// or restarting. The client shows a plain fallback and polls `/_atelier/wake?company=<c>[&app=<slug>]`
// with a 2 s → 10 s backoff; `{ok:true}` → full reload. The poll is BOUNDED like the shell's own
// waking page: after WAKE_GIVE_UP_MS (60 s — the shell's `WAKE_GIVE_UP_MS`, kept equal by hand;
// the bundle cannot import shell/) it stops and calls `onGiveUp` so the fallback says so — the
// shell sent the wake on the first `{ok:false}`, the computer is taking unusually long, the
// person reloads by hand. App fetches are the app's own; this covers the shell's (`/_atelier/*`
// snapshots, the bundle imports).

export const WAKE_MIN_MS = 2000
export const WAKE_MAX_MS = 10000
export const WAKE_GIVE_UP_MS = 60000

export function nextWakeDelay(prev) {
  if (prev == null) return WAKE_MIN_MS
  return Math.min(prev * 2, WAKE_MAX_MS)
}

export function isWakingResponse(res) {
  if (!res || res.status !== 503) return false
  const h = res.headers && typeof res.headers.get === 'function' ? res.headers.get('x-atelier-waking') : null
  return h === '1' || h === null || h === undefined      // a 503 without the header still counts as waking
}

// wakeUrl(company, app?) — with `app` the shell asks THAT app's computer (a multi-pod company: the one that is asleep), else the company's freshest
export function wakeUrl(company, app = null) {
  return `/_atelier/wake?company=${encodeURIComponent(company || '')}${app ? `&app=${encodeURIComponent(app)}` : ''}`
}

// startWakePoll({fetch, setTimeout, clearTimeout, company, app?, reload, onTick, onGiveUp, giveUpMs}) → stop()
// The deadline is counted in scheduled delay (the sum of the backoff steps, the last one clipped to land on it), not
// wall-clock: no clock to inject, and the fake clock of the tests drives it exactly. A tick on the deadline still probes.
export function startWakePoll({ fetch, setTimeout, clearTimeout, company, app = null, reload, onTick = () => {}, onGiveUp = () => {}, giveUpMs = WAKE_GIVE_UP_MS }) {
  let timer = null, delay = null, elapsed = 0, stopped = false
  const schedule = () => {
    const left = giveUpMs - elapsed
    if (left <= 0) { onGiveUp(); return }
    delay = Math.min(nextWakeDelay(delay), left)
    elapsed += delay
    timer = setTimeout(tick, delay)
  }
  const tick = async () => {
    timer = null
    let ok = false
    try {
      const r = await fetch(wakeUrl(company, app), { cache: 'no-store', credentials: 'same-origin' })
      if (r.ok) { const j = await r.json().catch(() => ({})); ok = j && j.ok === true }
    } catch {}
    if (stopped) return
    onTick({ ok, delay })
    if (ok) { reload(); return }
    schedule()
  }
  schedule()
  return () => { stopped = true; if (timer) clearTimeout(timer); timer = null }
}
