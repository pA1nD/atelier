// reporter.js — the always-on client error reporter (shell/DESIGN.md §4 "removed": the 1.x
// observe-gated reporter becomes always on; OR16, the kit's channel). `window.onerror`,
// `unhandledrejection` and the FIRST occurrence of each distinct `console.error` message are
// POSTed to `/_atelier/report` as `{instance, rev, url, ua, kind, message, stack}` for the ACTIVE
// app; ≤ 10 reports/min per page; nothing to report when no app is active (the shell's report
// route is presence-gated on `body.instance`). Reporting itself never throws.

export const REPORT_BUDGET = 10
export const REPORT_WINDOW_MS = 60_000

export function createReporter({ fetch, now = () => Date.now(), context, url = '/_atelier/report', page = () => '', ua = '' }) {
  let stamps = []
  const seen = new Set()
  function report(kind, message, stack) {
    try {
      const ctx = typeof context === 'function' ? context() : null
      if (!ctx || !ctx.instance) return false
      const t = now()
      stamps = stamps.filter((s) => t - s < REPORT_WINDOW_MS)
      if (stamps.length >= REPORT_BUDGET) return false
      stamps.push(t)
      const body = {
        instance: ctx.instance, rev: ctx.rev ?? null,
        url: String(page() || '').slice(0, 500), ua: String(ua || '').slice(0, 300),
        kind, message: String(message || 'unknown').slice(0, 300), stack: String(stack || '').slice(0, 1500),
      }
      Promise.resolve(fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) })).catch(() => {})
      return true
    } catch { return false }
  }
  function consoleError(args) {
    try {
      const msg = args.map((a) => (typeof a === 'string' ? a : (a && a.message) || String(a))).join(' ').slice(0, 300)
      const key = msg.slice(0, 200)
      if (!msg || seen.has(key)) return false
      seen.add(key)
      return report('console', msg, args.find((a) => a && a.stack)?.stack)
    } catch { return false }
  }
  function install(win, con) {
    win.addEventListener('error', (e) => report('error', e.message, e.error?.stack))
    win.addEventListener('unhandledrejection', (e) => report('unhandledrejection', e.reason?.message || String(e.reason || 'unhandled rejection'), e.reason?.stack))
    const orig = con.error
    con.error = (...args) => { consoleError(args); orig.apply(con, args) }
  }
  return { report, consoleError, install }
}
