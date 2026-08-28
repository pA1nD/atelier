// self.js — a frontend's self-identity under a mount (shell/DESIGN.md §4 "three-base self()";
// the port of design/atelier2/spike-b6/self.js plus the 1.x fields). Pure: works in the browser
// (default input = location.pathname) and in node (pass a string).
//
// Accepts any of the three URL shapes an app frontend can observe:
//   /modules/<company>/<app>/…   the asset mount (import.meta.url, static files)
//   /api/<company>/<app>/…       the API mount
//   /<company>/<app>/…           the document route
// Query string / hash / origin are ignored; only the FIRST two segments after the (optional)
// /modules or /api prefix identify the app — a deep path that happens to contain "/modules/"
// again cannot re-target it. `modules` / `api` as a first segment never parse as a company.
//
// 1.x compatibility: `workspace` (= company), `id` (= app), `topic` (= qid) and
// `subscribe(handler)`. A module still writes `self.subscribe(fn)` and never sees instance ids:
// `subscribe` maps the qid to the app's INSTANCE through `instanceFor(company, app)` (the
// bootstrap module row) and subscribes on that topic. 2.0 events are invalidations — the handler
// receives `{type:'invalidate', topic:<qid>, seq}`; the very first snapshot of a subscription
// (mount = subscribe → snapshot) is not a change and is not delivered.

const NONE = { company: '', app: '', qid: '', base: '', modules: '', api: '', rest: '' }

export function self(input, { instanceFor, subscribe } = {}) {
  const raw = input ?? (typeof location !== 'undefined' ? location.pathname : '')
  let pathname = String(raw)
  try { pathname = new URL(pathname, 'http://x').pathname } catch {}
  const m = /^\/(?:(modules|api)\/)?([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(pathname)
  let out = { ...NONE }
  if (m && !(!m[1] && (m[2] === 'modules' || m[2] === 'api'))) {
    const dec = (s) => { try { return decodeURIComponent(s) } catch { return s } }
    const company = dec(m[2]), app = dec(m[3])
    const enc = `${encodeURIComponent(company)}/${encodeURIComponent(app)}`
    out = {
      company, app,
      qid: `${company}/${app}`,
      base: `/${enc}/`,
      modules: `/modules/${enc}/`,
      api: `/api/${enc}`,
      rest: (m[4] || '').replace(/\/+$/, ''),
    }
  }
  const { company, app, qid } = out
  return {
    ...out,
    workspace: company,
    id: app,
    topic: qid,
    subscribe: (handler) => {
      if (!qid || typeof handler !== 'function' || typeof subscribe !== 'function') return () => {}
      const instance = (typeof instanceFor === 'function' && instanceFor(company, app)) || qid
      let first = true
      return subscribe(instance, (ev) => {
        if (ev.type === 'snapshot') {
          if (first) { first = false; return }
          handler({ type: 'invalidate', topic: qid, seq: ev.snapshot?.seq ?? null })
          return
        }
        if (ev.type === 'invalidate') { first = false; handler({ type: 'invalidate', topic: qid, seq: ev.seq }) }
      })
    },
  }
}
