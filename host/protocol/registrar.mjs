// host/protocol/registrar.mjs — the registrar client and the two transports (DESIGN §4.4, §7;
// PLAN §2 "registry", §4.3 "Credentials", §4.4 "Registry writes"; seed spike-d1/registrar.js,
// ported: claim / adopt / revive / refuse-with-CLAIM-REFUSED.txt / unlink / boot reconcile).
//
// What the registrar owns: the host's identity after registration (hostId, epoch, token, company,
// origin, principal, the shell's assertion key), the apps table of THIS computer (instance →
// {slug, uid, rev, meta, tombstone_at}), the worker uid assignment (20000+i, persisted at the spine
// and in `<inst>/uid`, reused on pod recreation), the 10 s heartbeat, and every write to the
// registry — always through `transport`, always its own rows (the registry refuses the rest).
//
// Rules carried from D1 and the plan:
//   - the token is in memory only; `register()` exchanges the bootstrap secret for it and the
//     spine revokes the previous epoch at that exchange; a `401 host-epoch-moved` on any call
//     registers again and retries the call once.
//   - `startedAt` is stamped at every successful registration — it is the C3 restart fence
//     (assertions with iat before it are refused by auth.mjs).
//   - meta goes through protocol/registry allowMeta (unknown keys dropped); `primary` travels in
//     the PUT body as a REQUEST — the registry records it as requested_primary, never applies it.
//   - a refusal (4xx from the registry, or a bad slug) lands as `CLAIM-REFUSED.txt` in the app
//     folder, written AS UID 1000 (never root into an agent-owned dir, §4.3 symlink rule), `wx`.
//   - the host's markers (`<inst>/slug`, `uid`, `registered.json`) are dirfd-relative writes into
//     root-owned `/work/.atelier/<inst>/` (0711), each 0600 — nothing outside the host reads them, and
//     a worker must not enumerate its peers' instance ids / slugs; never into the app folder.
//   - `lane` = the two push lanes (events, appError) routed through `call()`: a `401 host-epoch-moved`
//     on either re-registers and retries once, the same as every registry write.
//   - reconcile: rows with no folder are unlinked only after `/work/apps` was readable for a
//     5 s settle, at most 5 per pass (more → one loud log line, the rest next pass).
//   - `release(row)` = `POST /v1/host/release` through `call()` (DESIGN §10.3 step 4): a spine that does
//     not answer it yet (404), a 5xx or a network failure is logged and NEVER blocks a deploy — the
//     host's own `releases.jsonl` is the row until the spine answers. `beat()` reads `config:
//     [{instance, updated}]` from the heartbeat reply and hands each stamp to `onConfigStamp` (D16),
//     returns the answer, and reads `chrome: {digest, version} | null` — the computer's EFFECTIVE chrome
//     (step 7 ship C) — from the register AND heartbeat answers into `onChrome` (host/chrome/fetch.mjs
//     fetches it); the heartbeat body carries `chrome_digest` = the digest the host HOLDS (`chromeDigest()`,
//     null = no cache yet). `chromeFetch(digest)` = `GET /v1/host/chrome/<digest>` through `call()`.
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { randomBytes, generateKeyPairSync } from 'node:crypto'
import { allowMeta, publicKeyFromHex, publicKeyHex, SLUG_RE, DIGEST_RE, reclaimRule, EventRing } from '../../protocol/index.js'

export const WORKER_UID_BASE = 20000
export const WORKER_UID_MAX = 65535
export const INSTANCE_RE = /^i-[0-9a-f]{16}$/
export const HEARTBEAT_MS = 10_000
export const VISIBLE_WINDOW_MS = 10 * 60 * 1000
export const RECONCILE_SETTLE_MS = 5000
export const RECONCILE_MAX = 5
export const REGISTER_BACKOFF_MS = [500, 1000, 2000, 5000, 10_000, 30_000]
export const EPOCH_MOVED = 'host-epoch-moved'
export const CONNECT_MS = 5000
export const TOTAL_MS = 30_000
export const CHROME_FETCH_MS = 15_000
export const AGENT = { uid: 1000, gid: 1000 }

export const newInstanceId = () => 'i-' + randomBytes(8).toString('hex')
export const newEpoch = () => randomBytes(8).toString('hex')

export class TransportError extends Error {
  constructor(status, body) { super(`spine ${status} ${body?.error ?? ''}`.trim()); this.status = status; this.body = body ?? {} }
}
const isEpochMoved = (e) => e instanceof TransportError && e.status === 401 && e.body?.error === EPOCH_MOVED

// The default file seam (tests pass a memory one): plain reads/writes with a mode, nothing privileged.
export const nodeFsx = {
  readFile: (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } },
  writeFile: (p, data, mode) => fs.writeFileSync(p, data, { mode }),
}

// The one host write into an app folder: CLAIM-REFUSED.txt, as uid 1000, `wx` (O_EXCL refuses a
// planted symlink on the final component), mode 0644. Runs through the adapter (row G shape).
const REFUSE_SCRIPT = 'const fs=require("node:fs");const [p,t]=process.argv.slice(1);try{fs.writeFileSync(p,t,{flag:"wx",mode:0o644})}catch(e){if(e.code!=="EEXIST")throw e}'
export function writeClaimRefused(os, dir, why, now = Date.now) {
  const text = `${new Date(now()).toISOString()} ${why}\nDelete this file to retry.\n`
  return os.spawnSync({
    argv: ['node', '-e', REFUSE_SCRIPT, '--', dir + '/CLAIM-REFUSED.txt', text],
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' }, cwd: '/',
    uid: AGENT.uid, gid: AGENT.gid, groups: [], umask: 0o022, stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * createRegistrar({ os, dirfd, transport, cfg, log, now, fsx, backoffMs, liveWorkers, setTimer })
 *   liveWorkers: () => instance[] — the supervisor's live workers (heartbeat's visible_apps input)
 */
export function createRegistrar({ os, dirfd, transport, cfg = {}, log = () => {}, now = Date.now, fsx = nodeFsx, backoffMs = REGISTER_BACKOFF_MS, liveWorkers = () => [], chromeDigest = () => null, setTimer = setTimeout, clearTimer = clearTimeout, onConfigStamp = null, onChrome = null }) {
  const st = { hostId: null, epoch: null, startedAt: null, company: cfg.company ?? null, origin: cfg.origin ?? null, chat: null, principal: null, token: null, pubKey: null, lastServedAt: null, chrome: null }
  const apps = new Map()              // instance → {slug, uid, rev, meta, tombstone_at}
  const lastServed = new Map()        // instance → ms
  let settleFrom = null, hb = null, stopped = false, registering = null

  const sleep = (ms) => new Promise((r) => setTimer(r, ms))

  function apply(r) {
    st.hostId = r.host_id; st.epoch = r.epoch; st.token = r.token
    st.company = r.company ?? st.company; st.origin = r.origin ?? st.origin; st.chat = r.chat ?? null
    st.principal = r.principal ?? { id: 'local', name: 'local' }
    st.pubKey = r.shell_public_key_hex ? publicKeyFromHex(r.shell_public_key_hex) : null
    st.startedAt = now()
    for (const a of r.apps ?? []) {
      const prev = apps.get(a.instance)
      // `deployed_rev` (DESIGN §10.3): a 40-hex commit, "legacy" (a migrated registry, no release row yet) or null — the boot announce's anchor
      apps.set(a.instance, { slug: a.slug, uid: a.uid ?? prev?.uid ?? null, rev: a.rev ?? prev?.rev ?? null, meta: a.meta ?? prev?.meta ?? {}, tombstone_at: a.tombstone_at ?? null, deployed_rev: a.deployed_rev ?? prev?.deployed_rev ?? null })
    }
    transport.setToken?.(st.token)
    readChrome(r)
  }
  // the answer's `chrome` (register and heartbeat): `{digest, version}` | null; an absent field keeps the last word
  function readChrome(r) {
    if (!r || !('chrome' in r)) return
    const c = r.chrome && typeof r.chrome === 'object' && typeof r.chrome.digest === 'string' && DIGEST_RE.test(r.chrome.digest) ? { digest: r.chrome.digest, version: typeof r.chrome.version === 'string' ? r.chrome.version : null } : null
    st.chrome = c
    try { hooks.onChrome?.(c) } catch (e) { log(`registrar: chrome ${c?.digest?.slice(0, 12) ?? 'null'}: ${e?.message ?? e}`) }
  }

  // register(): bootstrap → token + epoch. Retries with backoff until it succeeds or stop().
  function register() {
    if (registering) return registering
    registering = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await transport.register({ pod_ip: cfg.podIp ?? null, host_started_at: now() })
          apply(r)
          log(`registrar: registered host=${st.hostId} epoch=${st.epoch} company=${st.company} apps=${apps.size}`)
          return { hostId: st.hostId, epoch: st.epoch, apps: [...apps.keys()] }
        } catch (e) {
          if (stopped) throw e
          const ms = backoffMs[Math.min(attempt, backoffMs.length - 1)]
          log(`registrar: register failed (${e?.message ?? e}), retry in ${ms} ms`)
          await sleep(ms)
          if (stopped) throw e
        }
      }
    })().finally(() => { registering = null })
    return registering
  }

  // Every other call: a 401 host-epoch-moved registers again and retries once.
  async function call(name, ...args) {
    try { return await transport[name](...args) } catch (e) {
      if (!isEpochMoved(e)) throw e
      log(`registrar: ${name}: ${EPOCH_MOVED} → re-register`)
      await register()
      return transport[name](...args)
    }
  }

  function lowestFreeUid() {
    const used = new Set([...apps.values()].map((a) => a.uid))
    for (let uid = WORKER_UID_BASE + 1; uid <= WORKER_UID_MAX; uid++) if (!used.has(uid)) return uid
    throw new Error('registrar: no free worker uid below 65536')
  }
  // The `<inst>/uid` marker is the in-computer authority for a uid the spine has not persisted
  // yet (a claim before the first modules-changed) — never re-allocate a uid that is on disk.
  function markerUid(instance) {
    const n = Number(String(fsx.readFile(os.at(dirfd, `${instance}/uid`)) ?? '').trim())
    return Number.isInteger(n) && n > WORKER_UID_BASE && n <= WORKER_UID_MAX ? n : null
  }
  function writeMarkers(instance, slug, uid) {
    const dir = os.at(dirfd, instance)
    try { os.mkdir(dir, 0o711) } catch (e) { if (e.code !== 'EEXIST') throw e }
    os.chmod(dir, 0o711)   // the host runs under umask 077: the mode is set explicitly (root-owned, before any chown)
    const put = (name, text, mode) => { const p = os.at(dirfd, `${instance}/${name}`); fsx.writeFile(p, text, mode); os.chmod(p, mode) }
    put('slug', slug + '\n', 0o600)
    put('uid', uid + '\n', 0o600)
    put('registered.json', JSON.stringify({ instance, slug, uid, company: st.company }) + '\n', 0o600)
  }
  function refuse(dir, code, error) {
    if (dir) writeClaimRefused(os, dir, `${code} ${error}`, now)
    log(`registrar: claim refused ${dir ?? ''}: ${code} ${error}`)
    return { refused: { code, error } }
  }

  // claim({slug, meta, dir}) → {instance, uid, verdict:'claimed'|'adopted'|'revived'} | {refused:{code, error}}
  async function claim({ slug, meta, dir }) {
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return refuse(dir, 400, `bad slug '${slug}'`)
    const m = allowMeta(meta)
    const existing = [...apps.entries()].find(([, a]) => a.slug === slug)
    const instance = existing?.[0] ?? newInstanceId()
    const uid = existing?.[1].uid ?? markerUid(instance) ?? lowestFreeUid()
    let r
    try { r = await call('putApp', instance, { slug, meta: { ...m.meta, ...m.requested } }) } catch (e) {
      if (e instanceof TransportError && e.status >= 400 && e.status < 500) return refuse(dir, e.status, e.body?.error ?? 'refused')
      throw e
    }
    const id = r.instance_id ?? instance
    const verdict = r.claimed ? 'claimed' : (r.revived || existing?.[1].tombstone_at != null) ? 'revived' : 'adopted'
    apps.set(id, { slug, uid, rev: existing?.[1].rev ?? null, meta: m.meta, tombstone_at: null })
    writeMarkers(id, slug, uid)
    log(`registrar: ${verdict} ${st.company}/${slug} instance=${id} uid=${uid}`)
    return { instance: id, uid, verdict, [verdict]: true }
  }

  async function unlink(instance) {
    const a = apps.get(instance)
    if (!a) return null
    const r = await call('unlink', instance)
    a.tombstone_at = r?.tombstone_at ?? now()
    log(`registrar: unlinked ${st.company}/${a.slug} instance=${instance}`)
    return { instance, tombstone_at: a.tombstone_at }
  }

  async function modulesChanged(instance, rev) {
    const a = apps.get(instance)
    if (!a) return null
    a.rev = rev
    return call('modulesChanged', { apps: [{ instance, slug: a.slug, uid: a.uid, rev }] })
  }

  function visibleApps() {
    const t = now(), v = new Set(liveWorkers())
    for (const [i, at] of lastServed) if (t - at < VISIBLE_WINDOW_MS) v.add(i)
    return v.size
  }
  async function beat() {
    let r
    let held = null
    try { held = chromeDigest() ?? null } catch {}
    try { r = await call('heartbeat', { visible_apps: visibleApps(), last_served_at: st.lastServedAt, pod_ip: cfg.podIp ?? null, chrome_digest: held }) } catch (e) { log(`registrar: heartbeat failed (${e?.message ?? e})`); return null }
    // D16: a config PUT at the spine is a release — the reply names the instances whose app_config moved
    for (const c of Array.isArray(r?.config) ? r.config : []) {
      if (typeof c?.instance !== 'string' || c.updated == null) continue
      try { hooks.onConfigStamp?.(c.instance, c.updated) } catch (e) { log(`registrar: config stamp ${c.instance}: ${e?.message ?? e}`) }
    }
    readChrome(r)
    return r
  }
  const hooks = { onConfigStamp, onChrome }
  // release(row) → the spine's {ok, id} | null (logged, never thrown): the release row is the host's first;
  // a green deploy/rollback/adopt moves the local `deployed_rev` too (the next boot's anchor)
  async function release(row) {
    try {
      const r = await call('release', row)
      const a = apps.get(row?.instance)
      if (a && row.verdict === 'green' && ['deploy', 'rollback', 'adopt'].includes(row.kind) && typeof row.commit === 'string') a.deployed_rev = row.commit
      return r
    } catch (e) {
      const why = e instanceof TransportError ? `spine ${e.status} ${e.body?.error ?? ''}`.trim() : (e?.message ?? String(e))
      log(`registrar: release ${row?.instance ?? '?'} ${row?.kind ?? ''}/${row?.verdict ?? ''} not recorded at the spine (${why}) — kept in releases.jsonl`)
      return null
    }
  }
  function heartbeat(ms = HEARTBEAT_MS) {
    if (hb) clearInterval(hb)
    hb = setInterval(beat, ms)
    hb.unref?.()
    return hb
  }
  function served(instance) { const t = now(); lastServed.set(instance, t); st.lastServedAt = t }

  // reconcile(rows | null): rows = the discovered folders [{slug, dir, meta}]; null = /work/apps unreadable.
  async function reconcile(rows) {
    if (rows === null || rows === undefined) { settleFrom = null; return { skipped: 'unreadable' } }
    if (settleFrom === null) settleFrom = now()
    if (now() - settleFrom < RECONCILE_SETTLE_MS) return { skipped: 'settle' }
    const present = new Set(rows.map((r) => r.slug))
    const missing = [...apps.entries()].filter(([, a]) => a.tombstone_at === null && !present.has(a.slug))
    if (missing.length > RECONCILE_MAX) log(`registrar: reconcile: ${missing.length} registered apps have no folder — unlinking ${RECONCILE_MAX} this pass, the rest next pass`)
    const unlinked = []
    for (const [instance] of missing.slice(0, RECONCILE_MAX)) { await unlink(instance); unlinked.push(instance) }
    return { unlinked, remaining: missing.length - unlinked.length }
  }

  return {
    get hostId() { return st.hostId }, get epoch() { return st.epoch }, get startedAt() { return st.startedAt },
    get company() { return st.company }, get origin() { return st.origin }, get chat() { return st.chat },
    get principal() { return st.principal }, get token() { return st.token }, get chrome() { return st.chrome },
    register, claim, unlink, modulesChanged, heartbeat, beat, served, reconcile, visibleApps, release,
    set onConfigStamp(fn) { hooks.onConfigStamp = fn }, get onConfigStamp() { return hooks.onConfigStamp },
    set onChrome(fn) { hooks.onChrome = fn }, get onChrome() { return hooks.onChrome },
    // chromeFetch(digest) → {digest, version, files:{path: base64}} — the bundle by digest (host/chrome/fetch.mjs verifies it)
    chromeFetch: (digest) => call('chrome', digest),
    draining: () => call('draining'),
    appConfig: (instance) => call('appConfig', instance),
    lane: { events: (batch) => call('events', batch), appError: (body) => call('appError', body) },
    publicKey: () => st.pubKey,
    apps: () => apps,
    lowestFreeUid,
    stop() { stopped = true; if (hb) { clearInterval(hb); hb = null } },
  }
}

// ---- spineTransport(cfg, opts): HTTP to ATELIER_SPINE_URL (DESIGN §7). Bearer = the host token;
// register() alone uses the bootstrap secret (read once from $ATELIER_RUN/bootstrap.token).
export function spineTransport(cfg, { bootstrapToken, connectMs = CONNECT_MS, totalMs = TOTAL_MS, chromeMs = CHROME_FETCH_MS } = {}) {
  const base = new URL(cfg.spineUrl)
  const bootstrap = bootstrapToken ?? (() => { try { return fs.readFileSync(cfg.run + '/bootstrap.token', 'utf8').trim() } catch { return null } })()
  let token = null
  const lib = base.protocol === 'https:' ? https : http

  function request(method, path, body, { auth = 'token', totalMs: total = totalMs } = {}) {
    return new Promise((resolve, reject) => {
      const cred = auth === 'bootstrap' ? bootstrap : token
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
      const headers = { accept: 'application/json', ...(cred ? { authorization: `Bearer ${cred}` } : {}) }
      if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = payload.length }
      const req = lib.request({ protocol: base.protocol, hostname: base.hostname, port: base.port || undefined, path: base.pathname.replace(/\/$/, '') + path, method, headers, timeout: connectMs }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null; try { json = text ? JSON.parse(text) : null } catch { json = null }
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new TransportError(res.statusCode, json ?? { error: text.slice(0, 200) }))
          resolve({ status: res.statusCode, body: json ?? {} })
        })
        res.on('error', reject)
      })
      const totalTimer = setTimeout(() => req.destroy(new Error(`spine: total timeout ${total} ms`)), total)
      totalTimer.unref?.()
      req.on('timeout', () => req.destroy(new Error(`spine: connect timeout ${connectMs} ms`)))   // fires before the socket is live: no bytes yet
      req.on('socket', (s) => s.once('connect', () => req.setTimeout(0)))
      req.on('error', (e) => { clearTimeout(totalTimer); reject(e) })
      req.on('close', () => clearTimeout(totalTimer))
      req.end(payload ?? undefined)
    })
  }
  const body = (p) => p.then((r) => r.body)
  return {
    kind: 'spine',
    setToken: (t) => { token = t },
    register: (b) => body(request('POST', '/v1/host/register', b, { auth: 'bootstrap' })),
    heartbeat: (b) => body(request('POST', '/v1/host/heartbeat', b)),
    putApp: (instance, b) => request('PUT', `/v1/apps/${encodeURIComponent(instance)}`, b).then((r) => ({ status: r.status, ...r.body })),
    unlink: (instance) => body(request('POST', `/v1/apps/${encodeURIComponent(instance)}/unlink`, {})),
    modulesChanged: (b) => body(request('POST', '/v1/host/modules-changed', b)),
    events: (batch) => body(request('POST', '/v1/host/events', batch)),
    appError: (b) => body(request('POST', '/v1/host/event', b)),
    appConfig: (instance) => body(request('GET', `/v1/apps/${encodeURIComponent(instance)}/config`)),
    draining: () => body(request('POST', '/v1/host/draining', {})),
    release: (b) => body(request('POST', '/v1/host/release', b)),
    // the chrome bundle by digest (~1.2 MB base64): its own bound (15 s), the fetch lane's budget
    chrome: (digest) => body(request('GET', `/v1/host/chrome/${encodeURIComponent(digest)}`, undefined, { totalMs: chromeMs })),
  }
}

// ---- localTransport(cfg, dirfd, {os, fsx, now, keys}): the in-process twin, answering from
// `.atelier/registry.json` (0600 root). One computer, company = cfg.company, identity `local`.
// Events land in an EventRing({adoptFirst:true}) (no registrar in the loop, protocol/events);
// app errors are kept in memory (`appErrors`) for the dev shell / tests.
export function localTransport(cfg = {}, dirfd, { os, fsx = nodeFsx, now = Date.now, keys = generateKeyPairSync('ed25519') } = {}) {
  const file = os.at(dirfd, 'registry.json')
  const load = () => { try { const j = JSON.parse(fsx.readFile(file) ?? 'null'); return j && Array.isArray(j.apps) ? j : null } catch { return null } }
  const state = load() ?? { host_id: 'local', apps: [] }
  state.releases ??= []
  const save = () => fsx.writeFile(file, JSON.stringify(state, null, 1) + '\n', 0o600)
  const ring = new EventRing({ adoptFirst: true })
  const appErrors = []
  const row = (a) => ({ instance: a.instance, slug: a.slug, uid: a.uid ?? null, rev: a.rev ?? null, meta: a.meta ?? {}, tombstone_at: a.tombstone_at ?? null })
  const company = cfg.company ?? 'local'
  return {
    kind: 'local', keys, ring, appErrors, state,
    setToken() {},
    async register() {
      return { host_id: 'local', epoch: newEpoch(), token: randomBytes(16).toString('hex'), company, origin: cfg.origin ?? 'http://127.0.0.1:1844', chat: null,
        principal: { id: 'local', name: 'local' }, apps: state.apps.map(row), shell_public_key_hex: publicKeyHex(keys.publicKey) }
    },
    async heartbeat() { return { ok: true, config: [] } },
    async putApp(instance, body) {
      if (typeof body?.slug !== 'string' || !SLUG_RE.test(body.slug)) throw new TransportError(400, { error: 'bad-slug' })
      const m = allowMeta(body.meta)
      const byId = state.apps.find((a) => a.instance === instance)
      const bySlug = state.apps.find((a) => a.slug === body.slug)
      if (byId) {
        if (bySlug && bySlug.instance !== instance) throw new TransportError(409, { error: 'slug-claimed', by: 'local' })
        const renamed = byId.slug !== body.slug
        Object.assign(byId, { slug: body.slug, meta: m.meta, requested_primary: m.requested.primary ?? null, tombstone_at: null })
        save(); return { status: 200, instance_id: instance, updated: true, renamed }
      }
      const rule = reclaimRule({ existing: bySlug ? { computer: 'local', tombstone_at: bySlug.tombstone_at ?? null } : null, callerComputer: 'local', now: now() })
      if (rule === 'adopt' || rule === 'revive') {
        Object.assign(bySlug, { meta: m.meta, requested_primary: m.requested.primary ?? null, tombstone_at: null })
        save(); return { status: 200, instance_id: bySlug.instance, adopted: true, revived: rule === 'revive' }
      }
      if (rule === 'insert' && bySlug) state.apps.splice(state.apps.indexOf(bySlug), 1)   // expired tombstone: purge
      state.apps.push({ instance, slug: body.slug, uid: null, rev: null, meta: m.meta, requested_primary: m.requested.primary ?? null, tombstone_at: null })
      save(); return { status: 201, instance_id: instance, claimed: true }
    },
    async unlink(instance) {
      const a = state.apps.find((x) => x.instance === instance)
      if (!a) throw new TransportError(404, { error: 'unknown-instance' })
      if (a.tombstone_at == null) { a.tombstone_at = now(); save() }
      return { tombstone_at: a.tombstone_at }
    },
    async modulesChanged({ apps }) {
      for (const u of apps ?? []) { const a = state.apps.find((x) => x.instance === u.instance); if (a) { a.rev = u.rev; if (u.uid != null) a.uid = u.uid } }
      save(); return { ok: true }
    },
    async events(batch) { const r = ring.ingest('local', batch); if (!r.ok) throw new TransportError(400, { error: r.reason }); return { accepted: r.accepted, rejected: r.rejected } },
    async appError(b) { appErrors.push(b); if (appErrors.length > 200) appErrors.shift(); return { ok: true } },
    async appConfig() { return { env: {} } },
    async draining() { return { ok: true } },
    async chrome(digest) { throw new TransportError(404, { error: 'unknown-digest', digest }) },   // no releases on a laptop: the fixed folder is the chrome
    // the release twin: the row kept (last 50), `deployed_rev` on the app row when green
    async release(r) {
      if (!r || typeof r.instance !== 'string') throw new TransportError(400, { error: 'bad-instance' })
      state.releases.push(r); if (state.releases.length > 50) state.releases.splice(0, state.releases.length - 50)
      const a = state.apps.find((x) => x.instance === r.instance)
      if (a && r.verdict === 'green' && typeof r.commit === 'string') { a.deployed_rev = r.commit; if (Number.isInteger(r.rev)) a.rev = r.rev }
      save(); return { ok: true, id: r.id ?? null }
    },
  }
}
