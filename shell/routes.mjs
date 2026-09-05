// shell/routes.mjs — the route matrix, lanes in order (DESIGN §2.4; PLAN §4.1 "Route matrix").
//
// A lane takes the request context and returns a response record, `{handled:true}` when it wrote
// the response itself (the proxy, the socket, the ticket lane), or `null` = next lane. `fleet`
// lanes exist only through the fleet gate — the local gate answers `null` and the lane is a no-op
// BY EVALUATION; nothing here branches on `cfg.mode` except the picker's default company.
//
//   0  normalise    percent-decode once, remove dot segments, collapse `//`, refuse NUL and a second
//                   `%` layer — before anything reads the path [S:B6]; `..` past the root → 404
//   1  https        gate.https → 301 (+ HSTS)                                               fleet
//   2  Host         gate.hostAllowed → portal / company / 404 (never a redirect)              fleet
//   3  ticket       gate.ticket on /_t/<opaque> — creates the session                        fleet
//   4a assets       /assets/* — public bytes; /_chrome/<digest>/<path> — a chrome release's bytes off the
//                   shell's read-only store (chrome-store.mjs; immutable, etag = digest:path; 404 without
//                   a store, for an unknown digest or a path its manifest does not name)               both
//   4b documents    Host-first: Host = path company (fleet) → identity → 302-to-/go (fleet) →
//                   the APP's host waking (its row's computer; the company's freshest for an
//                   app-less document) → compose — the module list is the person's (presence)   both
//   4c fetches      session-first: identity fails → 401 {} without Location → Host = path
//                   company (fleet) → reserved company heads → 404                            both
//   5  presence     registry.resolve → 404; registry.present → 404 (same as a stranger); the
//                   chrome's /modules/<chrome qid>/* and /api/<chrome qid>/* are session-gated
//                   only (no presence) on EVERY origin, served by the host of the qid's company
//                   (the fleet: `portal/catalyst-chrome` from the system host; locally the staged
//                   `global/<chrome>`); the assertion carries the chrome row's instance          both
//   6  Origin       gate.origin on writes + the WS upgrade, only when the credential is a cookie both
//   7  authorize    the per-app hook — none in 2.0.0 (presence is the ACL); a visible no-op    both
//   8  proxy        /api, /modules through hostLink to the APP's host (`registry.hostOf(row)` — a
//                   company owns one host per chat it owns; waking marks are per host);
//                   /_atelier/{ws,whoami,report,topics,rail,wake} (rail/topics: the person's rows);
//                   /_atelier/metrics — the operator's exposition (shell/metrics.mjs), admitted to
//                   an operator session or in local mode, 404 to anyone else                    both
//   anything else → 404 {}; a non-GET/HEAD on a document route → 401 unauthenticated (no Location,
//   no ticket mint), 405 with a session; an Upgrade anywhere but
//   /_atelier/ws → 426. The 1.x-only surfaces (/_atelier/inflight, client-errors, takeover, observe)
//   do not exist in 2.0 — gone, not skipped (§4.8 N6).
import fs from 'node:fs'
import path from 'node:path'
import { SLUG_RE, DIGEST_RE, asDigest, companyTopic, isReservedTopic } from '../protocol/index.js'
import { send } from './assets.mjs'
import { CHROME_CACHE_CONTROL } from './chrome-store.mjs'
import { renderDocument, relativeImports, appAsset } from './document.mjs'
import { proxyRequest, json as sendJson } from './proxy.mjs'
import { CONTENT_TYPE as METRICS_CONTENT_TYPE } from './metrics.mjs'
import { wakingHtml, wakingHeaders, hostState, hostKey, WAKE_GIVE_UP_MS, WAKE_GIVE_UP_FLEET_MS } from './waking.mjs'
import { newNonce } from './document.mjs'
import { visibleRows } from './presence.mjs'

export const RESERVED_HEADS = new Set(['api', 'assets', 'modules', '_atelier', '_chrome', '_host', '_t', 'favicon.ico', 'robots.txt'])
export const RESERVED_MODULE_COMPANIES = new Set(['api', 'assets', 'modules', '_atelier'])
export const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
export const REPORT_CAP = 64 * 1024

// ---- lane 0
// normalise(rawUrl) → {ok:true, path, forward, search} | {ok:false, status}
//   path:    decoded, dot segments removed, `//` collapsed — what the lanes read
//   forward: the path re-encoded segment by segment + the ORIGINAL query — what is signed and sent
export function normalise(rawUrl) {
  const s = String(rawUrl ?? '')
  if (!s.startsWith('/')) return { ok: false, status: 400 }
  const qi = s.indexOf('?')
  const rawPath = qi < 0 ? s : s.slice(0, qi)
  const search = qi < 0 ? '' : s.slice(qi)
  let decoded
  try { decoded = decodeURIComponent(rawPath) } catch { return { ok: false, status: 400 } }
  if (decoded.includes('\0') || /%[0-9a-f]{2}/i.test(decoded)) return { ok: false, status: 400 }   // NUL, a second % layer
  if (decoded.includes('\\')) return { ok: false, status: 400 }
  const out = []
  for (const seg of decoded.split('/').slice(1)) {
    if (seg === '' || seg === '.') { if (seg === '' && out.length) out.trail = true; continue }
    if (seg === '..') { if (!out.length) return { ok: false, status: 404 }; out.pop(); continue }
    out.push(seg)
  }
  const trailing = decoded.endsWith('/') && out.length > 0
  const pth = '/' + out.join('/') + (trailing ? '/' : '')
  const forward = '/' + out.map(encodeURIComponent).join('/') + (trailing ? '/' : '') + search
  return { ok: true, path: pth, forward, search }
}

// parseRoute(path) → the route family
export function parseRoute(p) {
  if (p === '/') return { kind: 'document', company: null, slug: null, rest: '' }
  const segs = p.split('/').slice(1)
  const head = segs[0]
  if (head === 'assets') return { kind: 'assets' }
  if (head === '_chrome') {
    const [, digest, ...rest] = segs
    if (!digest || !DIGEST_RE.test(digest) || !rest.length || rest.some((x) => !x)) return { kind: 'none' }
    return { kind: 'chrome', digest, rest: rest.join('/') }
  }
  if (head === '_atelier') return { kind: 'atelier', name: segs[1] ?? '', rest: segs.slice(2).join('/') }
  if (head === '_t') return { kind: 'ticket' }
  if (head === 'api' || head === 'modules') {
    const [, company, slug, ...rest] = segs
    if (!company || !slug) return { kind: 'none' }
    if (!SLUG_RE.test(company) || !SLUG_RE.test(slug) || RESERVED_MODULE_COMPANIES.has(company)) return { kind: 'none' }
    return { kind: head, company, slug, rest: rest.join('/') }
  }
  if (RESERVED_HEADS.has(head) || !SLUG_RE.test(head)) return { kind: 'none' }
  const slug = segs[1] ?? null
  if (slug !== null && slug !== '' && !SLUG_RE.test(slug)) return { kind: 'none' }
  return { kind: 'document', company: head, slug: slug || null, rest: segs.slice(2).join('/') }
}

const r = (lane, status, extra = {}) => ({ lane, status, ...extra })
// notice(ctx, status, heading, text): a PERSON's answer for a document that has nowhere to go — the shell's owner renders
// the page (`cfg.pageFor({status, heading, text, home}) → {body, headers?}`, the portal's own notice layout); without
// an owner page the JSON `{}` of before. 2026-09-05: "https://staging.pa1nd.de/xxx should be handled as well".
const notice = (ctx, status, heading, text, fallback = null) => {
  let p = null
  try { p = ctx.cfg?.pageFor?.({ status, heading, text, home: true }) ?? null } catch (e) { ctx.log?.(`pageFor: ${e?.message ?? e}`) }
  if (p?.body) return r('document', status, { body: p.body, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...(p.headers ?? {}) } })
  return fallback ?? jsonR('document', status, {})
}
const jsonR = (lane, status, body, headers = {}) => r(lane, status, { body: JSON.stringify(body), headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } })

// ---- the lanes
export async function laneNormalise(ctx) {
  const n = normalise(ctx.rawUrl)
  if (!n.ok) return jsonR('normalise', n.status, {})
  ctx.path = n.path; ctx.forward = n.forward; ctx.search = n.search; ctx.route = parseRoute(n.path)
  return null
}
export async function laneHttps(ctx) {
  const h = ctx.gate.https(ctx.req)
  if (!h) return null
  return r('https', 301, { headers: { location: h.redirect, 'cache-control': 'no-store' } })
}
export async function laneHost(ctx) {
  const h = ctx.gate.hostAllowed(ctx.req)
  if (!h) return null
  if (h.status) return jsonR('host', h.status, {})
  if (h.portal) return jsonR('host', 404, {})       // the portal is another origin's server, never this shell
  ctx.hostCompany = h.company
  return null
}
export async function laneTicket(ctx) {
  if (ctx.route.kind !== 'ticket') return null
  if (ctx.upgrade) return jsonR('ticket', 404, {})
  const handled = await ctx.gate.ticket(ctx.req, ctx.res)
  return handled ? { lane: 'ticket', handled: true } : jsonR('ticket', 404, {})
}
export async function laneAssets(ctx) {
  if (ctx.route.kind === 'chrome') return laneChrome(ctx)
  if (ctx.route.kind !== 'assets') return null
  if (ctx.upgrade) return jsonR('assets', 426, {})
  await ctx.assets.handle(ctx.req, ctx.res, ctx.path)
  return { lane: 'assets', handled: true }
}
// /_chrome/<digest>/<path> (step 7 ship C, decision 4): a release's bytes off the read-only store, public
// (no identity — the same bytes for everyone, as /assets/*), `cache-control: public, max-age=31536000,
// immutable` + `etag: "<digest>:<path>"` (the URL names the bytes; one validator per resource), gzip ≥ 1 KiB for text. No store (local mode,
// a portal without the artifacts mount), an unknown digest or a path the manifest does not name → 404.
export async function laneChrome(ctx) {
  if (ctx.upgrade) return jsonR('chrome', 426, {})
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return jsonR('chrome', 404, {})
  const store = ctx.chromeStore
  const { digest, rest } = ctx.route
  const body = store ? store.open(digest, rest) : null
  if (!body) return jsonR('chrome', 404, {})
  send(ctx.req, ctx.res, 200, body, store.type(rest), { etag: `"${digest}:${rest}"`, 'cache-control': CHROME_CACHE_CONTROL })   // one validator per resource, not per bundle (N3)
  return { lane: 'chrome', handled: true }
}

async function resolvePerson(ctx) {
  if (ctx.identity) return ctx.identity
  ctx.identity = await ctx.providers.identity.resolve(ctx.req)
  return ctx.identity
}

// the document's company: the Host's (fleet) or the path's; `/` locally = the first workspace
function documentCompany(ctx) {
  const pathCompany = ctx.route.company
  if (ctx.hostCompany) return pathCompany && pathCompany !== ctx.hostCompany ? null : ctx.hostCompany
  if (pathCompany) return pathCompany
  const list = ctx.providers.registry.companies?.() ?? []
  return list.find((c) => c.id === 'global')?.id ?? list[0]?.id ?? null
}

export async function laneDocument(ctx) {
  if (ctx.route.kind !== 'document') return null
  if (ctx.upgrade) return jsonR('document', 426, {})
  const company = documentCompany(ctx)
  if (!company) return notice(ctx, 404, 'Not here', 'Nothing lives at this address.')
  const known = ctx.providers.registry.companies?.() ?? []          // local: the workspaces; fleet: [] (the Host gate decided)
  if (known.length && !known.some((c) => c.id === company)) return notice(ctx, 404, 'Not here', 'Nothing lives at this address.')
  const isRead = ctx.method === 'GET' || ctx.method === 'HEAD'
  const id = await resolvePerson(ctx)
  if (!id.ok) {
    if (!isRead) return jsonR('document', 401, {})                   // no Location, no ticket mint (PLAN §4.1: non-GET/HEAD 401)
    const u = ctx.gate.unauthDocument(ctx.req, { company, path: ctx.path })
    if (!u) return jsonR('document', 401, {})
    if (u.status === 302) return r('document', 302, { headers: { location: u.location, 'cache-control': 'no-store', ...(u.cookie ? { 'set-cookie': u.cookie } : {}) } })
    return notice(ctx, u.status, 'This page could not sign you in', 'Open it from the portal, or sign in there first.', r('document', u.status, { body: 'This page could not sign you in. Open it from the portal, or sign in there first.', headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } }))
  }
  if (!isRead) return jsonR('document', 405, {})
  // the host that must be up is the APP's (its row's computer); an app-less document, or a slug the registry does
  // not know, asks whether anything of the company is up (the freshest host) and renders — the client tidies the URL.
  // PRESENCE FIRST (review 2026-08-30, C06): a slug the person is not present on is a slug that does not exist for
  // them — the same app-less 200 as a stranger's, never a waking page naming it (an existence + liveness oracle) and
  // never a probe of a pod that is none of their business (presence.mjs: the rail and the module list keep the same law)
  const row = ctx.route.slug ? await ctx.providers.registry.resolve(company, ctx.route.slug) : null
  const app = row && (await ctx.providers.registry.present(id.person.id, row.instance)) ? row : null
  const state = await hostState({ registry: ctx.providers.registry, hostLink: ctx.providers.hostLink, bus: ctx.providers.bus, company, app, marks: ctx.marks, now: ctx.now })
  const nonce = newNonce()
  if (state.waking) {
    ctx.log(`document: ${company}${app ? '/' + app.slug : ''} waking (${state.reason})`)
    return r('document', 503, { body: wakingHtml({ company, slug: app ? app.slug : null, nonce, giveUpMs: ctx.cfg.mode === 'fleet' ? WAKE_GIVE_UP_FLEET_MS : WAKE_GIVE_UP_MS }), headers: wakingHeaders({ nonce }) })
  }
  const doc = await composeFor(ctx, { company, slug: ctx.route.slug, person: id.person, epoch: id.epoch, nonce, logout: id.logout ?? null })
  ctx.metrics?.bootstrap(company, doc.bootstrapBytes)
  ctx.ensureWatch?.(company)
  return r('document', 200, { body: doc.html, headers: doc.headers })
}

// chromeShape(registry, company, app) → the document's chrome (step 7 ship C, decision 5): an APP document renders
// the digest its computer REPORTED (`app.chromeDigest` — the sheet its host built carries that chrome's rules, so JS and
// CSS must be one digest), an app-less document the company default (`registry.chrome(company).digest`); a release
// digest (64 hex) puts every chrome asset under `/_chrome/<digest>/` (`base`), and NO digest — the fleet before the
// first release, local mode's mtime stamp — is today's `/modules/<qid>/…?rev=` path, byte for byte. `asDigest`
// (protocol/registry.js) is the shape rule — the rail rows, the bootstrap rows and the client apply the same one.
export { asDigest }
export const chromeShape = (registry, company, app = null) => {
  const c = registry.chrome(company)
  if (!c?.qid) return null
  const digest = app ? (asDigest(app.chromeDigest) ?? asDigest(c.digest)) : asDigest(c.digest)
  if (digest) return { qid: c.qid, rev: digest, hasKit: true, hasStyles: true, base: `/_chrome/${digest}` }
  const has = (n) => (c.dir ? ['js', 'jsx'].some((x) => { try { return fs.statSync(path.join(c.dir, `${n}.${x}`)).isFile() } catch { return false } }) : true)
  const hasStyles = c.dir ? (() => { try { return fs.statSync(path.join(c.dir, 'styles.css')).isFile() } catch { return false } })() : true
  // the row path: the chrome row's content id (`rev`, the spine's `deployed_rev` of that row) names the bytes — see
  // document.mjs assetRev; without one the assets ride bare and a cache in front may hold them
  return { qid: c.qid, rev: c.digest ?? c.rev ?? null, hasKit: has('kit'), hasStyles }
}

// composeFor(): the PERSON's rows (presence — a member outside an app's chat sees no trace of it, PLAN §4.1) + chrome
// + the entry's relative imports (fetched once per (instance, rev)) → the document
export async function composeFor(ctx, { company, slug, person, epoch, nonce, logout = null }) {
  const registry = ctx.providers.registry
  const rows = await visibleRows(registry, person.id, (await registry.apps(company)).filter((x) => !x.isChrome))
  const app = slug ? rows.find((x) => x.slug === slug && x.instance) : null
  const chrome = chromeShape(registry, company, app)
  let entryImports = []
  if (app && app.hasFrontend !== false) entryImports = await entryImportsFor(ctx, { company, app, person })
  const companies = registry.companies?.() ?? []
  // the PERSON's places (registry.placesFor — the portal names them; absent = single-place): each with its visible rows
  let places = null
  if (typeof registry.placesFor === 'function') {
    try {
      const named = (await registry.placesFor(person.id)) ?? []
      places = []
      for (const p of named) {
        if (!p?.id) continue
        try { places.push({ ...p, rows: p.id === company ? rows : await visibleRows(registry, person.id, (await registry.apps(p.id)).filter((x) => !x.isChrome)) }) }
        catch (e) { ctx.log?.(`places: ${p.id} unread (${e?.message ?? e}) — left out`) }
      }
      if (!places.some((p) => p.id === company)) places.unshift({ id: company, name: company, rows })
    } catch (e) { ctx.log?.(`places: ${e?.message ?? e}`); places = null }
  }
  const versions = (await ctx.assets.versions?.()) ?? {}   // the shell's own assets under their content hashes
  return renderDocument({ cfg: ctx.cfg, template: ctx.assets.template(), company, slug, person: { id: person.id, name: person.name, epoch: epoch ?? null, logout }, modules: rows, chrome, companies, portal: ctx.cfg.portalOrigin ?? null, entryImports, nonce, places, assetVersion: (u) => versions[u] ?? null })
}
async function entryImportsFor(ctx, { company, app, person }) {
  const key = `${app.instance}:${app.rev}`
  const hit = ctx.entryCache.get(key)
  if (hit) return hit
  const hostRow = await ctx.providers.registry.hostOf(app)
  if (!hostRow) return []
  try {
    const up = await ctx.providers.hostLink.request({ hostRow, app, person, method: 'GET', path: appAsset(company, app.slug, 'frontend.js', app.rev), headers: { accept: 'application/javascript' } })
    const chunks = []; for await (const c of up.body) chunks.push(c)
    const list = up.status === 200 ? relativeImports(Buffer.concat(chunks).toString('utf8')) : []
    ctx.entryCache.set(key, list)
    if (ctx.entryCache.size > 512) ctx.entryCache.delete(ctx.entryCache.keys().next().value)
    return list
  } catch (e) { ctx.log(`document: entry imports ${company}/${app.slug}: ${e.code ?? e.message}`); return [] }
}

export async function laneFetch(ctx) {
  const k = ctx.route.kind
  if (k !== 'api' && k !== 'modules' && k !== 'atelier') return null
  const id = await resolvePerson(ctx)
  if (!id.ok) return jsonR('fetch', 401, {})
  ctx.person = id.person; ctx.credential = id.credential; ctx.op = id.op === true
  if (k === 'atelier') {
    ctx.company = ctx.hostCompany ?? null
    if (!ctx.company) {
      const q = new URLSearchParams(ctx.search).get('company')
      if (q && SLUG_RE.test(q)) ctx.company = q
    }
    return null
  }
  // the chrome's /modules/<qid>/* and /api/<qid>/* (its backend) are not company paths: the ONE chrome the
  // Host company's registry names — the fleet answers the system host's `portal/catalyst-chrome` for every
  // company, locally `global/<chrome>` — is served on every origin (§2.2; PLAN §4.1 — the chrome is not an
  // app). The fleet registry learns a company's chrome when it reads the company's rows, so a cross-company
  // fetch reads them first (cached per TTL — one spine call, never one per request) before the comparison:
  // a fresh replica's first `kit.js` on a company origin must not be a 404.
  if (ctx.hostCompany && ctx.route.company !== ctx.hostCompany) await ctx.providers.registry.apps(ctx.hostCompany)
  const isChrome = `${ctx.route.company}/${ctx.route.slug}` === chromeOf(ctx, ctx.hostCompany ?? ctx.route.company)
  if (ctx.hostCompany && ctx.route.company !== ctx.hostCompany && !isChrome) return jsonR('fetch', 404, {})
  ctx.company = isChrome ? (ctx.hostCompany ?? ctx.route.company) : ctx.route.company
  return null
}

const chromeOf = (ctx, company) => ctx.providers.registry.chrome(company)?.qid ?? null
export async function lanePresence(ctx) {
  const k = ctx.route.kind
  if (k !== 'api' && k !== 'modules') return null
  const { company, slug } = ctx.route
  const registry = ctx.providers.registry
  const qid = `${company}/${slug}`
  // the chrome (assets and its backend) is not an app: session-gated only, exempt from presence. Its row
  // lives on the QID'S company — the fleet's `portal/catalyst-chrome` is the system host's row on company
  // `portal`, named by every company's registry and served to every company origin (a chat's pod carries
  // no chrome of its own); locally the staged `global/<chrome>` row. The proxy dials that company's host,
  // and the host verifies the assertion's `app` against the row's instance (a synthetic id would be a 401
  // there). No row → 404 with a log line: chrome delivery by digest per computer (PLAN §10 item 6) is step 7.
  const chromeCompany = ctx.hostCompany ?? (registry.companies?.() ?? []).find((c) => c.id === company)?.id ?? (registry.companies?.() ?? [])[0]?.id ?? company
  if (qid === chromeOf(ctx, chromeCompany)) {
    const row = await registry.resolve(company, slug)
    if (!row) { ctx.log(`presence: 404 chrome ${qid} has no registry row on ${company} (PLAN §10 item 6)`); return jsonR('presence', 404, {}) }
    ctx.app = { ...row, chrome: true }; ctx.appCompany = company
    return null
  }
  const row = await registry.resolve(company, slug)
  if (!row) return jsonR('presence', 404, {})
  if (!(await registry.present(ctx.person.id, row.instance))) { ctx.log(`presence: 404 ${ctx.person.id} ${qid} → ${row.instance}`); return jsonR('presence', 404, {}) }
  ctx.app = row; ctx.appCompany = company
  return null
}
export async function laneOrigin(ctx) {
  if (!ctx.person) return null
  if (ctx.credential === 'cookie' && ctx.method === 'OPTIONS' && ctx.req.headers['access-control-request-method']) return r('origin', 204, { headers: { 'cache-control': 'no-store' } })   // the shell answers preflights itself: no CORS headers, ever
  if (!ctx.upgrade && !WRITE_METHODS.has(ctx.method)) return null
  const o = ctx.gate.origin(ctx.req, ctx.credential)
  if (!o) return null
  ctx.log(`origin: ${o.status} ${ctx.person.id} ${ctx.method} ${ctx.path} origin=${ctx.req.headers.origin ?? '<none>'}`)
  return jsonR('origin', o.status, {})
}
export async function laneAuthorize() { return null }     // 2.0.0: no per-app hook; presence is the ACL (§9)

export async function laneProxy(ctx) {
  const k = ctx.route.kind
  const { registry, hostLink, bus } = ctx.providers
  if (k === 'api' || k === 'modules') {
    if (ctx.upgrade) return jsonR('proxy', 426, {})
    // THE APP'S HOST: the computer its registry row lives on (the chrome row's: the system host). A company owns one
    // host per chat it owns, so `registry.host(company)` — the freshest heartbeat — would send this app to another
    // chat's pod half the time (review 2026-08-30); the waking mark is that host's, not the company's
    const hostRow = await registry.hostOf(ctx.app)
    const key = hostKey(hostRow, ctx.appCompany)
    if (!hostRow || ctx.marks.isWaking(key, ctx.now(), registry, ctx.appCompany)) { ctx.metrics?.proxyOutcome(key, 'waking'); ctx.req.resume(); return jsonR('proxy', 503, { waking: true }, { 'retry-after': '2', 'x-atelier-waking': '1' }) }
    const app = ctx.app.chrome ? { instance: ctx.app.instance, company: ctx.app.company, slug: ctx.app.slug } : ctx.app
    // the origin the answer is served on is this request's (`ctx.company` = the Host company in the fleet) — an ACAO
    // may match only that one
    const out = await proxyRequest({ req: ctx.req, res: ctx.res, hostLink, hostRow, app, person: ctx.person, credential: ctx.credential, companyOrigin: ctx.cfg.origin(ctx.company ?? ctx.appCompany), forwardPath: ctx.forward, log: ctx.log, metrics: ctx.metrics, hostKey: key })
    if (out.error === 'DIAL' || out.error === 'TIMEOUT') ctx.marks.mark(key, ctx.now())
    return { lane: 'proxy', handled: true }
  }
  if (k !== 'atelier') return null
  const name = ctx.route.name
  if (name === 'ws') {
    if (!ctx.upgrade) return jsonR('proxy', 426, {}, { upgrade: 'websocket' })
    ctx.events.upgrade(ctx.req, ctx.socket, ctx.head, { person: ctx.person, company: ctx.company, credential: ctx.credential })
    return { lane: 'ws', handled: true }
  }
  if (ctx.upgrade) return jsonR('proxy', 426, {})
  // the operator's exposition (shell/metrics.mjs, PLAN §4.5). Admitted to an operator session
  // (`op: true` on the spine's session row, carried by the identity provider) and to local mode —
  // where the shell IS the operator's process. To anyone else it is 404, not 403: the shell's law
  // for a surface that is none of your business is the same 404 a stranger gets (lane 5), and an
  // unknown `/_atelier/<name>` is 404 already, so the route is not even an existence oracle.
  if (name === 'metrics' && ctx.method === 'GET') {
    if (!ctx.metrics || !(ctx.cfg.mode === 'local' || ctx.op)) return jsonR('proxy', 404, {})
    const body = ctx.metrics.render({ events: ctx.events, bus, registry, waker: ctx.waker })
    return r('proxy', 200, { body, headers: { 'content-type': METRICS_CONTENT_TYPE, 'cache-control': 'no-store' } })
  }
  // whoami carries the identity provider's sign-out door when it has one (fleet: the portal's /logout) — the chrome's
  // account menu shows Sign out only then
  if (name === 'whoami' && ctx.method === 'GET') return jsonR('proxy', 200, { id: ctx.person.id, name: ctx.person.name, anonymous: false, ...(ctx.identity?.logout ? { logout: ctx.identity.logout } : {}) })
  if (name === 'topics' && ctx.method === 'GET') {
    const topic = ctx.route.rest
    if (!topic) return jsonR('proxy', 404, {})
    if (topic.startsWith('company:')) { if (!ctx.company || topic !== companyTopic(ctx.company)) return jsonR('proxy', 404, {}) }
    else {
      if (isReservedTopic(topic)) return jsonR('proxy', 404, {})
      const row = await registry.byInstance(topic)
      if (!row || (ctx.company && row.company !== ctx.company) || !(await registry.present(ctx.person.id, topic))) return jsonR('proxy', 404, {})
    }
    const snap = await bus.snapshot(topic, { person: ctx.person })
    return snap ? jsonR('proxy', 200, snap) : jsonR('proxy', 404, {})
  }
  if (name === 'rail' && ctx.method === 'GET') {
    if (!ctx.company) return jsonR('proxy', 404, {})
    const snap = await bus.snapshot(companyTopic(ctx.company), { person: ctx.person })
    return snap ? jsonR('proxy', 200, snap) : jsonR('proxy', 404, {})
  }
  if (name === 'wake' && ctx.method === 'GET') {
    const company = ctx.company
    if (!company) return jsonR('proxy', 200, { ok: false })
    // `?app=<slug>` (the waking page of an app document sends it): that app's host; without it the company's freshest.
    // Presence first (C06): an app the person is not present on is asked about as if it did not exist — the company's
    // freshest host answers, no probe of the other room's pod, no waking mark on it
    const slug = new URLSearchParams(ctx.search).get('app')
    const row = slug && SLUG_RE.test(slug) ? await registry.resolve(company, slug) : null
    const app = row && (await registry.present(ctx.person.id, row.instance)) ? row : null
    const state = await hostState({ registry, hostLink, bus, company, app, marks: ctx.marks, now: ctx.now })
    // A computer that is not serving is WOKEN, not only probed (step 7) — NEVER A DRAINING ONE (review 2026-09-02, C1: the
    // drain is a decision — a rollout, the 24 h sleep — and a 2 s poll must not fight it; probe only, whatever drained it
    // brings it back). The target is the DIAL ROW's chat (`state.hostRow`, the routing seam), the app row's own `chat`
    // when the spine knows no computer for it (no-host). PRESENCE FIRST for the wake as for the probe (C5): on the app
    // path the person is present on the app (above); on the app-less path the host is the company's freshest, a room
    // the person may not be in — woken only when they are present on THAT chat (`registry.presentOnChat`), else probe
    // only. `by` is the caller's portal session (the spine resolves the actor and refuses a stranger too); a poll with
    // no session id never wakes. The waker holds one call per chat per 30 s and one in flight, and never changes the
    // answer: `ok` is the probe's; the page keeps polling until the host answers. FIRED, NOT AWAITED: the door can hold
    // (the portal's client bounds it at 15 s) — awaiting would sit the 2 s poll on that hop. createWaker catches every
    // throw; the `.catch` here is the last net (a log transport that throws is not an unhandled rejection)
    if (state.waking && state.reason !== 'draining' && ctx.waker) {
      const chat = state.hostRow?.chat ?? app?.chat ?? null
      const mayWake = app ? true : !!chat && !!(await registry.presentOnChat?.(ctx.person.id, company, chat))
      if (mayWake) {
        const sid = ctx.providers.identity.session?.(ctx.req) ?? null
        void ctx.waker.wake({ chat, company, reason: state.reason, by: sid ? `session:${sid}` : null }).catch(() => {})
      }
    }
    return jsonR('proxy', 200, { ok: !state.waking, ...(state.waking ? { reason: state.reason } : {}) })
  }
  if (name === 'report' && ctx.method === 'POST') {
    let body
    try { body = await readBody(ctx.req, REPORT_CAP) } catch (e) { return jsonR('proxy', e.status ?? 400, {}) }
    let parsed; try { parsed = JSON.parse(body.toString('utf8')) } catch { return jsonR('proxy', 400, {}) }
    const instance = parsed?.instance
    const row = typeof instance === 'string' ? await registry.byInstance(instance) : null
    if (!row || (ctx.company && row.company !== ctx.company)) return jsonR('proxy', 404, {})
    if (!(await registry.present(ctx.person.id, row.instance))) return jsonR('proxy', 404, {})
    const hostRow = await registry.hostOf(row)
    if (!hostRow) return jsonR('proxy', 503, { waking: true }, { 'retry-after': '2', 'x-atelier-waking': '1' })
    try {
      const up = await hostLink.request({ hostRow, app: row, person: ctx.person, method: 'POST', path: '/_atelier/report', headers: { 'content-type': 'application/json', 'content-length': body.length }, body })
      const chunks = []; for await (const c of up.body) chunks.push(c)
      return r('proxy', up.status, { body: Buffer.concat(chunks), headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
    } catch (e) { return jsonR('proxy', e.code === 'DIAL' || e.code === 'TIMEOUT' ? 503 : 502, e.code === 'DIAL' || e.code === 'TIMEOUT' ? { waking: true } : {}) }
  }
  return jsonR('proxy', 404, {})
}

export function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const cl = Number(req.headers['content-length'])
    if (Number.isFinite(cl) && cl > cap) { const e = new Error('too large'); e.status = 413; req.resume(); return reject(e) }
    const chunks = []; let size = 0, over = false
    req.on('data', (c) => { if (over) return; size += c.length; if (size > cap) { over = true; const e = new Error('too large'); e.status = 413; reject(e); req.destroy(); return } chunks.push(c) })
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)) })
    req.on('error', reject)
  })
}

export const LANES = [
  ['normalise', laneNormalise], ['https', laneHttps], ['host', laneHost], ['ticket', laneTicket],
  ['assets', laneAssets], ['document', laneDocument], ['fetch', laneFetch],
  ['presence', lanePresence], ['origin', laneOrigin], ['authorize', laneAuthorize], ['proxy', laneProxy],
]

// dispatch(ctx) → the first non-null lane result, else 404 (or 426 on a stray upgrade)
export async function dispatch(ctx) {
  ctx.hostCompany ??= null
  for (const [, lane] of LANES) {
    const out = await lane(ctx)
    if (out) return out
  }
  return ctx.upgrade ? jsonR('none', 426, {}) : jsonR('none', 404, {})
}
