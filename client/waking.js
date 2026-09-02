// waking.js — the client half of the waking page (shell/DESIGN.md §3.5, §4): a shell fetch that
// answers `503 {waking:true}` (+ `x-atelier-waking: 1`) means the company's computer is asleep
// or restarting. The client shows a plain fallback and polls `/_atelier/wake?company=<c>[&app=<slug>]`
// with a 2 s → 10 s backoff; `{ok:true}` → full reload. The poll is BOUNDED like the shell's own
// waking page and on the same clocks: WAKE_GIVE_UP_MS locally, WAKE_GIVE_UP_FLEET_MS in the fleet
// (the shell's constants of the same names, kept equal by hand; the bundle cannot import shell/) of
// WALL-CLOCK time from the first miss, a slow probe counted; every probe fetch is aborted at the
// remaining deadline (a hung shell cannot hold the poll open past it); then it stops and calls
// `onGiveUp` so the fallback says so — the shell sent the wake on the first `{ok:false}`, the
// computer is taking unusually long, the person reloads by hand. A tab that comes back to the
// front (`visibilitychange` → visible) probes at once and starts its deadline over — a phone locked
// while the pod is born never lands on the give-up copy against a computer that is up. App fetches
// are the app's own; this covers the shell's (`/_atelier/*` snapshots, the bundle imports).

export const WAKE_MIN_MS = 2000
export const WAKE_MAX_MS = 10000
export const WAKE_GIVE_UP_MS = 60000
export const WAKE_GIVE_UP_FLEET_MS = 180000

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

// startWakePoll({fetch, setTimeout, clearTimeout, now?, company, app?, reload, onTick, onGiveUp, giveUpMs, document?, AbortController?}) → stop()
// The deadline is wall-clock from the start (`now`, Date.now by default; the tests inject their fake clock's), the same
// bound the shell's page keeps: the time a probe itself takes counts, so a slow shell cannot stretch the budget into
// minutes (review 2026-09-02). The last backoff step is clipped to land on the deadline, and that tick still probes.
// Each fetch carries an AbortController aborted at the remaining deadline (a probe that never settles ends there).
// `document` (the page's, when given) adds the visibility rule: on `visibilitychange` → visible the in-flight probe is
// dropped (its answer is ignored by generation), the deadline re-armed, the backoff reset and a probe sent at once —
// after a give-up too, so a tab that comes back keeps checking (the fallback resets its copy on the next `onTick`).
export function startWakePoll({ fetch, setTimeout, clearTimeout, now = Date.now, company, app = null, reload, onTick = () => {}, onGiveUp = () => {}, giveUpMs = WAKE_GIVE_UP_MS, document = null, AbortController: AC = globalThis.AbortController }) {
  let timer = null, delay = null, stopped = false, gen = 0, ctrl = null, abortAt = null, startedAt = now()
  const left = () => giveUpMs - (now() - startedAt)
  const schedule = () => {
    const l = left()
    if (l <= 0) { onGiveUp(); return }
    delay = Math.min(nextWakeDelay(delay), l)
    timer = setTimeout(tick, delay)
  }
  const tick = async () => {
    timer = null
    const l = left()
    if (l <= 0) { onGiveUp(); return }
    const g = gen
    const ac = typeof AC === 'function' ? new AC() : null
    const at = ac ? setTimeout(() => ac.abort(), l) : null
    ctrl = ac; abortAt = at
    let ok = false
    try {
      const r = await fetch(wakeUrl(company, app), { cache: 'no-store', credentials: 'same-origin', ...(ac ? { signal: ac.signal } : {}) })
      if (r.ok) { const j = await r.json().catch(() => ({})); ok = j && j.ok === true }
    } catch {}
    if (at !== null) clearTimeout(at)
    if (stopped || g !== gen) return
    abortAt = null
    ctrl = null
    onTick({ ok, delay })
    if (ok) { reload(); return }
    schedule()
  }
  const onVisible = () => {
    if (stopped || document.visibilityState !== 'visible') return
    gen++; startedAt = now(); delay = null
    if (timer) { clearTimeout(timer); timer = null }
    if (abortAt !== null) { clearTimeout(abortAt); abortAt = null }
    if (ctrl) { try { ctrl.abort() } catch {} ctrl = null }
    tick()
  }
  if (document && typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', onVisible)
  schedule()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer); timer = null
    if (abortAt !== null) { clearTimeout(abortAt); abortAt = null }
    if (ctrl) { try { ctrl.abort() } catch {} ctrl = null }
    if (document && typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', onVisible)
  }
}
