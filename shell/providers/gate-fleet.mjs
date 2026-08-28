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
//                     session cookie is set and the person lands on `next` (302)
//   unauthDocument:   302 `https://portal/go/<c>/<path>` (path only, query dropped) + the loop breaker:
//                     a `__Host-tried` cookie set with the 302; a request that still carries it and
//                     still has no session → 403 loop page instead of a second mint (§10 item 14)
//   origin:           only when the credential is a cookie; `Origin` must equal the company origin
import { originRule } from './gate-local.mjs'

export const PORTAL_HOST = 'portal.pa1nd.de'
export const TRIED_COOKIE = '__Host-tried'
export const HSTS = 'max-age=63072000; includeSubDomains'
export const CONTINUE_PAGE = (path) => `<!doctype html><meta charset="utf-8"><title>Continue</title><form method="post" action="${path}"><button>Continue to Atelier</button></form>`

const hostOf = (req) => String(req.headers?.host ?? '').replace(/:\d+$/, '').toLowerCase()
const cookie = (req, name) => { const m = new RegExp(`(?:^|;\\s*)${name.replace(/[-]/g, '\\-')}=([^;]*)`).exec(req.headers?.cookie ?? ''); return m ? m[1] : null }

/**
 * createGateFleet({ domain, companies, tickets, sessions, now })
 *   companies(id) → boolean                                   (a registered company id)
 *   tickets.consume(id) → Promise<{ok:true, aud, person, next} | {ok:false, reason:'unknown'|'used'|'expired'}>
 *   tickets.peek(id)    → Promise<{aud} | null>                (the wrong-aud check must not burn it)
 *   sessions.create({person, company}) → Promise<sessionId>
 */
export function createGateFleet({ domain = PORTAL_HOST, companies = () => false, tickets, sessions, now = Date.now } = {}) {
  const companyOf = (host) => (host.endsWith('.' + domain) ? host.slice(0, -(domain.length + 1)) : null)
  const isNavigation = (h) => h['sec-fetch-dest'] === 'document' && h['sec-fetch-mode'] === 'navigate' && h['sec-fetch-user'] === '?1' && !h['sec-purpose'] && !h['purpose']
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
      const sid = await sessions.create({ person: t.person, company })
      const next = typeof t.next === 'string' && t.next.startsWith('/') && !t.next.startsWith('//') ? t.next : `/${company}/`
      res.writeHead(302, { location: next, 'cache-control': 'no-store', 'set-cookie': [`__Host-session=${encodeURIComponent(sid)}; Path=/; Secure; HttpOnly; SameSite=Lax`, `${TRIED_COOKIE}=; Path=/; Secure; HttpOnly; Max-Age=0`] })
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
