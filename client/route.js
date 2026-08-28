// route.js — the document's URL grammar, pure (shell/DESIGN.md §4 "kept": 1.x parseUrl/buildUrl
// with one DNS label per segment and a single decode).
//
//   /                    cold landing — the client lands on the company's primary app or its home
//   /<company>/          company home — no app selected
//   /<company>/<app>     the app page
//   /<company>/<app>/<rest…>   the app's own sub-route (window.__atelier.useRoute)
//
// A segment that is not one DNS label (SLUG_RE — protocol/registry's rule, copied because this
// file is served to the browser) is null: the client tidies the URL back to a real place. The
// mount prefixes (`modules`, `api`, `assets`) are never a company.

export const SLUG_RE = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/
export const MOUNT_PREFIXES = ['modules', 'api', 'assets']

function dec(s) { try { return decodeURIComponent(s) } catch { return null } }

export function parseUrl(pathname) {
  const none = { ws: null, id: null, rest: '' }
  const m = /^\/([^/]+)(?:\/([^/]+)(?:\/(.*))?)?\/?$/.exec(String(pathname ?? ''))
  if (!m) return none
  const ws = dec(m[1])
  if (ws === null || !SLUG_RE.test(ws) || MOUNT_PREFIXES.includes(ws)) return none
  if (m[2] === undefined) return { ws, id: null, rest: '' }
  const id = dec(m[2])
  if (id === null || !SLUG_RE.test(id)) return { ws, id: null, rest: '' }
  const rest = m[3] ? dec(m[3].replace(/\/+$/, '')) : ''
  return { ws, id, rest: rest === null ? '' : rest }
}

export function buildUrl(ws, id, rest) {
  if (!ws) return '/'
  if (!id) return `/${encodeURIComponent(ws)}/`
  const base = `/${encodeURIComponent(ws)}/${encodeURIComponent(id)}`
  const sub = rest ? String(rest).replace(/^\/+|\/+$/g, '') : ''
  return sub ? `${base}/${sub}` : base
}
