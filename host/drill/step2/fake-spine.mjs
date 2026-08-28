// The step-2 drill's stand-in for the spine's registrar lane (DESIGN §7 routes), run on the peer
// pod. Every request lands as one JSON line in /tmp/spine.jsonl ({at, method, path, auth, body,
// valid?}); app-error bodies are checked with protocol/'s validateAppError (the step1-contract
// shape: {kind:'app-error', error:<AppErrorEvent>}). The shell key pair, the bearer pair and the
// host id are written to /tmp/spine-state.json for signer.mjs. Listens on 0.0.0.0:7999.
import http from 'node:http'
import fs from 'node:fs'
import { randomBytes, generateKeyPairSync } from 'node:crypto'
import { publicKeyHex, validateAppError, authorizeWrite, reclaimRule } from '../../../protocol/index.js'

const PORT = Number(process.env.SPINE_PORT ?? 7999)
const LOG = process.env.SPINE_LOG ?? '/tmp/spine.jsonl'
const STATE = process.env.SPINE_STATE ?? '/tmp/spine-state.json'
const BOOTSTRAP = process.env.SPINE_BOOTSTRAP ?? 'drill-bootstrap-secret'
const computer = 'computer-drill', company = 'acme'
const keys = generateKeyPairSync('ed25519')
const s = { token: null, epoch: null, apps: new Map(), registrations: 0 }
const EPOCH_MOVED = 'host-epoch-moved'

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
const read = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { r(b ? JSON.parse(b) : {}) } catch { r({ _unparsable: b.slice(0, 200) }) } }) })
const record = (o) => fs.appendFileSync(LOG, JSON.stringify(o) + '\n')
const saveState = () => fs.writeFileSync(STATE, JSON.stringify({ host_id: computer, company, epoch: s.epoch, token: s.token, bootstrap: BOOTSTRAP, priv_pkcs8_hex: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex'), pub_hex: publicKeyHex(keys.publicKey), registrations: s.registrations }, null, 1))

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/_drill/log') { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); return res.end(fs.existsSync(LOG) ? fs.readFileSync(LOG) : '') }
  if (url.pathname === '/_drill/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(fs.readFileSync(STATE)) }
  const body = await read(req)
  const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null
  const entry = { at: Date.now(), method: req.method, path: url.pathname, auth: auth === BOOTSTRAP ? 'bootstrap' : auth === s.token ? 'token' : auth ? 'other' : 'none', body }
  const reply = (code, out) => { entry.status = code; record(entry); json(res, code, out) }
  if (url.pathname === '/v1/host/register') {
    if (auth !== BOOTSTRAP) return reply(401, { error: 'bad-bootstrap' })
    s.token = randomBytes(12).toString('hex'); s.epoch = randomBytes(8).toString('hex'); s.registrations++
    saveState()
    return reply(200, { host_id: computer, epoch: s.epoch, token: s.token, company, origin: `https://${company}.portal.pa1nd.de`, chat: 'chat-drill', principal: { id: 'p-agent', name: 'Bayard' },
      apps: [...s.apps.entries()].map(([instance, a]) => ({ instance, slug: a.slug, uid: a.uid, rev: a.rev, tombstone_at: a.tombstone_at })), shell_public_key_hex: publicKeyHex(keys.publicKey) })
  }
  if (auth !== s.token) return reply(401, { error: EPOCH_MOVED })
  let m
  if (url.pathname === '/v1/host/heartbeat') return reply(200, { ok: true })
  if (url.pathname === '/v1/host/modules-changed') { for (const a of body.apps ?? []) { const row = s.apps.get(a.instance); if (row) { row.rev = a.rev; row.uid = a.uid } } return reply(200, { ok: true }) }
  if (url.pathname === '/v1/host/events') return reply(200, { accepted: Array.isArray(body) ? body.length : 0, rejected: [] })
  if (url.pathname === '/v1/host/event') {
    const v = body?.kind === 'app-error' ? validateAppError(body.error) : { ok: false, reason: 'kind' }
    entry.valid = v.ok; if (!v.ok) entry.reason = v.reason
    return v.ok ? reply(200, { ok: true }) : reply(400, { error: `app-error: schema:${v.reason}` })
  }
  if (url.pathname === '/v1/host/draining') return reply(200, { ok: true })
  if ((m = /^\/v1\/apps\/([^/]+)\/config$/.exec(url.pathname))) return reply(200, { env: { DRILL_CONFIG: 'from-spine' } })
  if ((m = /^\/v1\/apps\/([^/]+)\/unlink$/.exec(url.pathname))) { const a = s.apps.get(m[1]); if (!a) return reply(404, { error: 'unknown-instance' }); a.tombstone_at ??= Date.now(); return reply(200, { tombstone_at: a.tombstone_at }) }
  if ((m = /^\/v1\/apps\/([^/]+)$/.exec(url.pathname)) && req.method === 'PUT') {
    const instance = m[1], existing = s.apps.get(instance)
    const w = authorizeWrite({ callerComputer: computer, computerRow: { id: computer, company }, existingRow: existing ? { ...existing, computer, company } : null, body })
    if (!w.ok) return reply(w.code, { error: w.error })
    if (existing) { existing.slug = body.slug; existing.meta = w.row.meta; existing.tombstone_at = null; return reply(200, { instance_id: instance, updated: true }) }
    const held = [...s.apps.entries()].find(([, a]) => a.slug === body.slug)
    if (held) { const rule = reclaimRule({ existing: { computer, tombstone_at: held[1].tombstone_at }, callerComputer: computer, now: Date.now() }); held[1].tombstone_at = null; held[1].meta = w.row.meta; return reply(200, { instance_id: held[0], adopted: true, revived: rule === 'revive' }) }
    s.apps.set(instance, { slug: body.slug, uid: null, rev: null, meta: w.row.meta, requested_primary: w.row.requested_primary, tombstone_at: null })
    return reply(201, { instance_id: instance, claimed: true })
  }
  reply(404, { error: 'no-route' })
}).listen(PORT, '0.0.0.0', () => { saveState(); console.log(`fake spine on :${PORT}, log ${LOG}, state ${STATE}`) })
