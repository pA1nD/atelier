// shell/providers/gate-fleet.mjs — the fleet-only rules (DESIGN §1.3; PLAN §4.1 https/HSTS,
// Host allowlist, the ticket lane, the 302-to-/go with its loop breaker, Origin on cookie writes).
// The stores are seams (the spine's single-use ticket store, the session store); the shell tests
// pass Maps. Rules:
//   https(req):       `x-forwarded-proto: http` → 301 to https (path + query kept); hsts(req) = the
//                     HSTS value on `portal.pa1nd.de` and its subdomains (includeSubDomains)
//   hostAllowed(req): Host is the portal → {portal:true}; `<c>.<domain>` with a registered company
//                     → {company}; anything else → {status:404} — never a redirect
//   ticket(req,res):  `/_t/<opaque>` — consumed only on a top-level user-gesture navigation
//                     (sec-fetch-dest document ∧ mode navigate ∧ user ?1 ∧ no Sec-Purpose); any other
//                     fetch gets the Continue page (a same-origin POST is the second gesture path);
//                     used/expired → 410, wrong aud → 403 (not burnt), unknown → 404; on success the
//                     session cookie is set and the person lands on `next` (302). `next` is trusted
//                     only as a normalised app path of THIS company (`/<c>/<slug>[/rest]`, no `//`,
//                     scheme, dot segments, reserved head as the slug) — anything else lands on `/<c>/`
//   the loop breaker (PLAN §4.1, §10 item 14) — a client that does not store `__Host-session` loops
//                     deep → /go → /_t → deep, minting a ticket per cycle. Two layers:
//                     (1) `__Host-tried` set with the 302; a document request that still carries it
//                         and has no session → 403 loop page. Cheap, but it covers only a client
//                         that stores cookies at all: one that drops `__Host-session` drops this one
//                         too (same `__Host-`/Secure/HttpOnly/SameSite=Lax attributes).
//                     (2) the ticket lane refuses to redirect a second ticket for the same
//                         person + next within LOOP_WINDOW_MS when the request carries no session
//                         cookie: the ticket is consumed (single use holds), the answer is the 403
//                         loop page, not another 302 — the cycle ends at the shell's door after two
//                         tickets. Per replica (an in-memory map); /go's own refusal on the
//                         portal/spine (the same rule, store-backed) is step 5.
//   origin:           only when the credential is a cookie; `Origin` must equal the company origin
import { originRule } from './gate-local.mjs'
import { normalise, parseRoute, RESERVED_HEADS } from '../routes.mjs'

export const PORTAL_HOST = 'portal.pa1nd.de'
export const TRIED_COOKIE = '__Host-tried'
export const SESSION_COOKIE = '__Host-session'
export const LOOP_WINDOW_MS = 30_000
export const LOOP_MAP_MAX = 4096
export const HSTS = 'max-age=63072000; includeSubDomains'
export const CONTINUE_PAGE = (path) => `<!doctype html><meta charset="utf-8"><title>Continue</title><form method="post" action="${path}"><button>Continue to Atelier</button></form>`
export const LOOP_PAGE = 'Sign-in did not stick on this origin (cookies blocked?). Open the link again from the portal.'

const hostOf = (req) => String(req.headers?.host ?? '').replace(/:\d+$/, '').toLowerCase()
const cookie = (req, name) => { const m = new RegExp(`(?:^|;\\s*)${name.replace(/[-]/g, '\\-')}=([^;]*)`).exec(req.headers?.cookie ?? ''); return m ? m[1] : null }

// safeNext(next, company) → the normalised path (+ query) to land on, or null
export function safeNext(next, company) {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) return null
  const n = normalise(next)
  if (!n.ok) return null
  const route = parseRoute(n.path)
  if (route.kind !== 'document' || route.company !== company) return null
  if (route.slug && RESERVED_HEADS.has(route.slug)) return null
  return n.forward
}

/**
 * createGateFleet({ domain, companies, tickets, sessions, now })
 *   companies(id) → boolean                                   (a registered company id)
 *   tickets.consume(id) → Promise<{ok:true, aud, person, next} | {ok:false, reason:'unknown'|'used'|'expired'}>
 *   tickets.peek(id)    → Promise<{aud} | null>                (the wrong-aud check must not burn it)
 *   sessions.create({person, company}) → Promise<sessionId>
 */
export function createGateFleet({ domain = PORTAL_HOST, companies = () => false, tickets, sessions, now = Date.now, loopWindowMs = LOOP_WINDOW_MS } = {}) {
  const companyOf = (host) => (host.endsWith('.' + domain) ? host.slice(0, -(domain.length + 1)) : null)
  const isNavigation = (h) => h['sec-fetch-dest'] === 'document' && h['sec-fetch-mode'] === 'navigate' && h['sec-fetch-user'] === '?1' && !h['sec-purpose'] && !h['purpose']
  const consumed = new Map()      // `${company}|${person.id}|${next}` → at (the loop breaker's second layer)
  const loopPage = (res) => { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(LOOP_PAGE) }
  function recentlyConsumed(key) {
    const t = now()
    for (const [k, at] of consumed) if (t - at > loopWindowMs) consumed.delete(k)
    const hit = consumed.has(key)
    consumed.set(key, t)
    if (consumed.size > LOOP_MAP_MAX) consumed.delete(consumed.keys().next().value)
    return hit
  }
  return {
    kind: 'fleet',
    https(req) {
      if (String(req.headers?.['x-forwarded-proto'] ?? 'https').split(',')[0].trim() !== 'http') return null
      return { redirect: `https://${hostOf(req)}${req.url}`, hsts: true }
    },
    hsts(req) { const h = hostOf(req); return h === domain || h.endsWith('.' + domain) ? HSTS : null },
    hostAllowed(req) {
      const h = hostOf(req)
      if (h === domain) return { portal: true }
      const c = companyOf(h)
      if (c && !c.includes('.') && companies(c)) return { company: c }
      return { status: 404 }
    },
    async ticket(req, res) {
      const m = /^\/_t\/([A-Za-z0-9_-]{16,})$/.exec(String(req.url).split('?')[0])
      if (!m) return false
      const company = companyOf(hostOf(req))
      if (!company) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return true }
      if (req.url.includes('?')) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return true }   // a query-string ticket is a 404 (ITP link decoration)
      const id = m[1]
      const gesture = req.method === 'POST' || (req.method === 'GET' && isNavigation(req.headers ?? {}))
      if (!gesture) {
        const t = await tickets.peek(id)
        if (!t) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return true }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(CONTINUE_PAGE(`/_t/${id}`)); return true
      }
      const peek = await tickets.peek(id)
      if (!peek) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return true }
      if (peek.aud !== company) { res.writeHead(403, { 'cache-control': 'no-store' }); res.end(); return true }   // not burnt
      const t = await tickets.consume(id)
      if (!t.ok) { res.writeHead(t.reason === 'unknown' ? 404 : 410, { 'cache-control': 'no-store' }); res.end(); return true }
      const next = safeNext(t.next, company) ?? `/${company}/`
      // the same person landing on the same next again within the window, still without a session
      // cookie: the previous ticket's cookie was never stored — a loop, not a sign-in
      if (recentlyConsumed(`${company}|${t.person?.id}|${next}`) && !cookie(req, SESSION_COOKIE)) { loopPage(res); return true }
      const sid = await sessions.create({ person: t.person, company })
      res.writeHead(302, { location: next, 'cache-control': 'no-store', 'set-cookie': [`${SESSION_COOKIE}=${encodeURIComponent(sid)}; Path=/; Secure; HttpOnly; SameSite=Lax`, `${TRIED_COOKIE}=; Path=/; Secure; HttpOnly; Max-Age=0`] })
      res.end(); return true
    },
    unauthDocument(req, { company, path }) {
      if (cookie(req, TRIED_COOKIE)) return { status: 403, loop: true }
      const p = String(path ?? req.url).split('?')[0]
      const rel = p.startsWith(`/${company}/`) ? p.slice(company.length + 2) : p.replace(/^\//, '')
      return { status: 302, location: `https://${domain}/go/${company}/${rel}`, cookie: `${TRIED_COOKIE}=1; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=30` }
    },
    origin(req, credential) { return credential === 'cookie' ? originRule(req, `https://${hostOf(req)}`) : null },
  }
}
