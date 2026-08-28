// shell/test/fixtures.mjs — fakes for the shell tests: a fake host (the dev/protocol lanes the shell
// dials), an in-memory registry with both column shapes, a fake bus, the fleet stores.
import http from 'node:http'
import { EventRing, companyTopic, decode } from '../../protocol/index.js'

export const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
export const TODO = 'i-0123456789abcdef', WIKI = 'i-fedcba9876543210', CHROME_APP = 'i-cccccccccccccccc'

// fakeHost(): what the shell dials — healthz, apps, events, modules, api echo, report
export function fakeHost({ epoch = 'e1', company = 'acme', rows } = {}) {
  const seen = []
  const state = { epoch, rows: rows ?? [{ instance: TODO, slug: 'todo', company, rev: 3, state: 'live' }, { instance: WIKI, slug: 'wiki', company, rev: 1, state: 'stopped' }, { instance: CHROME_APP, slug: 'catalyst-chrome', company, rev: 2, state: 'live' }], events: {} }
  const server = http.createServer(async (req, res) => {
    const chunks = []; try { for await (const c of req) chunks.push(c) } catch { return res.destroy() }
    const body = Buffer.concat(chunks)
    const u = new URL(req.url, 'http://h')
    const identity = req.headers['x-atelier-identity'] ? decode(req.headers['x-atelier-identity']) : null
    seen.push({ method: req.method, url: req.url, headers: req.headers, body, identity })
    const json = (s, b, h = {}) => { const buf = Buffer.from(JSON.stringify(b)); res.writeHead(s, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, ...h }); res.end(buf) }
    if (u.pathname === '/_host/healthz') return json(200, { api: 'atelier/2', hostId: 'local', epoch: state.epoch, uptime: 1, apps: state.rows.length })
    if (u.pathname === '/_atelier/apps') return json(200, state.rows)
    if (u.pathname === '/_atelier/events') return json(200, state.events[u.searchParams.get('app')] ?? [])
    if (u.pathname === '/_atelier/report') return json(200, { ok: true, app: identity?.app ?? null })
    const m = /^\/(api|modules)\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(u.pathname)
    if (!m) return json(404, {})
    const [, kind, c, s, rest] = m
    if (kind === 'modules') {
      if (rest === 'frontend.js') { const b = `import './x.js'\nimport React from 'react'\nexport default () => React.createElement('div', null, '${c}/${s}')\n`; res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', etag: `"rev-${u.searchParams.get('rev') ?? 0}"`, 'cache-control': 'no-cache' }); return res.end(b) }
      if (rest === 'styles.css') { res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }); return res.end('.x{}') }
      if (rest === 'kit.js') { res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' }); return res.end('export const kit = 1') }
      return json(404, {})
    }
    return json(200, { method: req.method, url: req.url, person: identity?.person ?? null, app: identity?.app ?? null, bytes: body.length, cookie: req.headers.cookie ?? null, authorization: req.headers.authorization ?? null, forged: req.headers['x-atelier-user'] ?? null }, { 'set-cookie': 'leak=1', 'x-worker': 'yes' })
  })
  return { server, seen, state, start: () => listen(server), stop: () => new Promise((r) => server.close(r)) }
}

// fakeRegistry({mode, companies: {acme: {apps: [...], host: {...}}}, chrome, present})
export function fakeRegistry({ mode = 'local', companies, chrome = { qid: 'global/catalyst-chrome', digest: 1700 }, present = async () => true, domain = 'portal.pa1nd.de', now = Date.now } = {}) {
  const watchers = new Map()
  const probes = new Map()
  const all = () => Object.entries(companies).flatMap(([id, c]) => (c.apps ?? []).map((a) => ({ company: id, hasFrontend: true, primary: false, meta: {}, ...a })))
  return {
    kind: mode,
    company(host) { const h = String(host ?? '').replace(/:\d+$/, ''); return mode === 'fleet' && h.endsWith('.' + domain) ? h.slice(0, -(domain.length + 1)) : null },
    companies() { return mode === 'fleet' ? [] : Object.keys(companies).map((id) => ({ id, name: id, href: `/${id}/` })) },
    async apps(company) { return all().filter((a) => a.company === company) },
    async resolve(company, slug) { return all().find((a) => a.company === company && a.slug === slug) ?? null },
    async byInstance(instance) { return all().find((a) => a.instance === instance) ?? null },
    present,
    async host(company) { const h = companies[company]?.host; if (!h) return null; const p = probes.get(company); return { hostId: 'local', epoch: p?.epoch ?? h.epoch ?? null, token: h.token ?? 'dev', ip: '127.0.0.1', port: h.port, tls: null, heartbeatAt: h.heartbeatAt !== undefined ? h.heartbeatAt : (p?.heartbeatAt ?? now()), drainingAt: h.drainingAt ?? null } },
    chrome() { return { qid: chrome?.qid ?? null, dir: chrome?.dir ?? null, digest: chrome?.digest ?? null } },
    watch(company, fn) { let s = watchers.get(company); if (!s) { s = new Set(); watchers.set(company, s) } s.add(fn); return () => s.delete(fn) },
    fire(company) { for (const fn of watchers.get(company) ?? []) fn() },
    noteProbe(company, r) { if (r?.ok) probes.set(company, { heartbeatAt: now(), epoch: r.epoch }) },
    async refresh() { return false },
    watchers,
  }
}

export function fakeBus({ registry, adoptFirst = true } = {}) {
  const ring = new EventRing({ adoptFirst })
  const listeners = new Set()
  const seqs = new Map()
  const append = (stream, topic) => { const k = `${stream}|${topic}`; const seq = (seqs.get(k) ?? 0) + 1; seqs.set(k, seq); const ev = { stream, topic, seq, type: 'invalidate' }; const r = ring.append(ev); if (!r.ok) throw new Error(r.reason); for (const fn of listeners) fn(ev); return ev }
  const bus = {
    kind: 'fake', ring, published: [], started: false,
    start() { bus.started = true }, stop() { bus.started = false },
    onAppend(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    publish(topic) { bus.published.push(topic); if (!ring.epochOf(topic)?.epoch) ring.registerEpoch(topic, 'shell1'); return append('shell:shell1', topic) },
    emit(topic, n = 1, stream = 'local:e1') { let ev; for (let i = 0; i < n; i++) ev = append(stream, topic); return ev },
    async snapshot(topic) {
      const head = ring.head(topic); const base = { stream: head?.stream ?? null, seq: head?.seq ?? 0 }
      if (topic.startsWith('company:')) { const c = topic.slice(8); const rows = await registry.apps(c); return { ...base, modules: rows.map((r) => ({ id: r.slug, instance: r.instance, rev: r.rev })), chrome: registry.chrome(c), chromeRev: registry.chrome(c).digest } }
      const row = await registry.byInstance(topic); return row ? { ...base, rev: row.rev, error: null } : null
    },
    reprobes: [], async reprobe(company, probe) { bus.reprobes.push([company, probe?.epoch]); return false },
  }
  return bus
}

export const fleetStores = () => {
  const sessions = new Map(), tickets = new Map(), epochs = new Map()
  return {
    sessions: { get: async (id) => sessions.get(id) ?? null, create: async ({ person, company }) => { const id = 's-' + Math.random().toString(16).slice(2); sessions.set(id, { person, epoch: epochs.get(person.id) ?? 1, aud: company }); return id }, map: sessions },
    tickets: { peek: async (id) => tickets.get(id) ?? null, consume: async (id) => { const t = tickets.get(id); if (!t) return { ok: false, reason: 'unknown' }; if (t.used) return { ok: false, reason: 'used' }; t.used = true; return { ok: true, ...t } }, map: tickets },
    epochOf: (personId) => epochs.get(personId) ?? 1, bump: (personId) => epochs.set(personId, (epochs.get(personId) ?? 1) + 1),
  }
}
export { companyTopic }
