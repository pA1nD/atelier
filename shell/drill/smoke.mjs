// shell/drill/smoke.mjs — the shell with LOCAL providers in front of the REAL host (host/index.mjs,
// local mode) on this Mac: one fixture app, curl-level rows, ends in `VERDICT:`. Lane B's discovery
// and host spawning are stubbed here (a fixed workspace table); everything else is the real code.
// Ports: shell 18440, host dev 18450, host protocol 18460 (1844 is the 1.x atelier on this Mac).
//   node shell/drill/smoke.mjs           (≤ 3 min; run it as ONE background task)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { createShell } from '../index.mjs'
import { createConfig } from '../config.mjs'
import { createMinter } from '../minter.mjs'
import { createIdentityLocal } from '../providers/identity-local.mjs'
import { createGateLocal } from '../providers/gate-local.mjs'
import { createHostLinkLocal } from '../providers/hostlink-local.mjs'
import { createRegistryLocal } from '../providers/registry-local.mjs'
import { createBusLocal } from '../providers/bus-local.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SHELL_PORT = 18440, DEV_PORT = 18450, HOST_PORT = 18460
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-smoke-'))
const work = path.join(root, 'w'), run = path.join(root, 'r')
const appDir = path.join(work, 'apps', 'hello')
fs.mkdirSync(appDir, { recursive: true }); fs.mkdirSync(run, { recursive: true })
const token = randomBytes(32).toString('hex')
fs.writeFileSync(path.join(run, 'dev.token'), token, { mode: 0o600 })
const backend = (marker, broken = false) => `export default {\n  mountRoutes(router) {\n    router.get('/who', (req, res) => res.json({ user: req.user, marker: '${marker}' }))${broken ? '\n    this is not javascript' : ''}\n  },\n}\n`
fs.writeFileSync(path.join(appDir, 'module.json'), JSON.stringify({ name: 'Hello', icon: '👋' }))
fs.writeFileSync(path.join(appDir, 'backend.js'), backend('v1'))
fs.writeFileSync(path.join(appDir, 'frontend.jsx'), `import React from 'react'\nimport { helper } from './helper.js'\nexport const meta = { name: 'Hello' }\nexport default function Hello() { return <div className="p-4">hello {helper()}</div> }\n`)
fs.writeFileSync(path.join(appDir, 'helper.js'), `export const helper = () => 'world'\n`)
const chromeDir = [path.join(os.homedir(), 'pro/001-atelier/catalyst-chrome'), path.join(os.homedir(), 'pro/003-atelier-modules/catalyst-chrome')].find((p) => fs.existsSync(path.join(p, 'frontend.jsx'))) ?? null

const rows = [], say = (l) => process.stdout.write(l + '\n')
const row = (name, ok, detail = '') => { rows.push([name, ok]); say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const deadline = Date.now() + 170_000
const finish = async (code) => { try { await shell?.close(200) } catch {} try { host.kill('SIGCONT'); host.kill('SIGTERM') } catch {}; await sleep(500); try { host.kill('SIGKILL') } catch {}; const fails = rows.filter(([, ok]) => !ok).map(([n]) => n); say(`VERDICT: ${fails.length ? 'FAIL — ' + fails.join(', ') : `PASS — ${rows.length} rows`}`); process.exit(code ?? (fails.length ? 1 : 0)) }
setTimeout(() => { row('deadline', false, '170 s'); finish(1) }, 175_000).unref()

// ---- the real host
const host = spawn(process.execPath, [path.join(REPO, 'host/index.mjs')], { env: { ...process.env, ATELIER_WORK: work, ATELIER_RUN: run, ATELIER_COMPANY: 'global', ATELIER_ORIGIN: `http://localhost:${SHELL_PORT}`, ATELIER_DEV_PORT: String(DEV_PORT), ATELIER_HOST_PORT: String(HOST_PORT), ATELIER_GIT_COMMIT: '0', NODE_ENV: 'production', ...(chromeDir ? { ATELIER_CHROME_DIR: chromeDir } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
let hostLog = ''
host.stdout.on('data', (c) => { hostLog += c })
host.stderr.on('data', (c) => { hostLog += c })
host.on('exit', (c) => say(`[host] exited ${c}`))

// ---- the shell with local providers; lane B's discovery/hosts stubbed by a fixed table
const minter = createMinter()
const hostLink = createHostLinkLocal({ minter, log: say })
const workspaces = () => [{ id: 'global', port: DEV_PORT, token }]
const discover = () => [{ workspace: 'global', id: 'hello', dir: appDir, meta: JSON.parse(fs.readFileSync(path.join(appDir, 'module.json'), 'utf8')), hasFrontend: true, hasBackend: true }, ...(chromeDir ? [{ workspace: 'global', id: path.basename(chromeDir), dir: chromeDir, meta: { isChrome: true }, hasFrontend: true, hasBackend: fs.existsSync(path.join(chromeDir, 'backend.js')) }] : [])]
const registry = createRegistryLocal({ workspaces, discover, chrome: chromeDir ? { qid: `global/${path.basename(chromeDir)}`, dir: chromeDir } : null, hostLink, log: say })
const bus = createBusLocal({ registry, hostLink, log: say })
const { cfg } = createConfig({ mode: 'local', config: {}, env: { PORT: String(SHELL_PORT), NODE_ENV: 'production' } })
const shell = createShell({ cfg, providers: { identity: createIdentityLocal(), gate: createGateLocal(), registry, bus, hostLink }, log: (l) => say(`[shell] ${l}`) })
shell.start()
await shell.listen()
const base = `http://127.0.0.1:${SHELL_PORT}`
const get = async (p, init) => { const r = await fetch(base + p, init); return { status: r.status, headers: r.headers, text: await r.text() } }

// wait for the host: bounded, per-request probes (never a foreground loop in a session — this IS the background task)
let up = false
for (let i = 0; i < 60 && Date.now() < deadline; i++) { const r = await get('/_atelier/wake?company=global'); if (r.text.includes('"ok":true')) { up = true; break } await sleep(1000) }
row('host up within 60 s', up)
if (!up) { say(hostLog.slice(-2000)); await finish(1) }
// the app claimed + built: the rail lists it with a rev
let inst = null
for (let i = 0; i < 60 && !inst; i++) { const r = await get('/_atelier/rail?company=global'); const j = JSON.parse(r.text); const m = j.modules?.find((x) => x.id === 'hello'); if (m?.rev != null) inst = m.instance; else await sleep(1000) }
row('rail lists hello with a rev', !!inst, inst ?? hostLog.slice(-800))
if (!inst) await finish(1)

// a. the document
const doc = await get('/global/hello')
row('document 200', doc.status === 200, String(doc.status))
row('document: chromeApi 2, activeQid, one sheet with ?rev=, preloads after the import map, no ?v=/?token=', /"chromeApi":2/.test(doc.text) && /"activeQid":"global\/hello"/.test(doc.text) && (doc.text.match(/rel="stylesheet"/g) ?? []).length === 1 && /styles\.css\?rev=\d+/.test(doc.text) && !/\?v=|token=/.test(doc.text) && (!doc.text.includes('importmap') || doc.text.indexOf('importmap') < doc.text.indexOf('modulepreload')))
row('document: the entry\'s relative import is preloaded', /modulepreload" href="\/modules\/global\/hello\/helper\.js\?rev=\d+"/.test(doc.text), (doc.text.match(/modulepreload[^>]*/g) ?? []).join(' | ').slice(0, 300))
row('document: no-store + CSP nonce', doc.headers.get('cache-control') === 'no-store' && /nonce-/.test(doc.headers.get('content-security-policy') ?? ''))
const bare = await get('/global/')
row('app-less document 200 with the chrome sheet or none', bare.status === 200 && (chromeDir ? /catalyst-chrome\/styles\.css\?rev=/.test(bare.text) : !bare.text.includes('rel="stylesheet"')))

// b. API through the shell: the worker sees req.user local, the forged header is dropped, set-cookie never returns
const api = await get('/api/global/hello/who?x=1', { headers: { 'x-atelier-user': 'admin', cookie: 'a=b', authorization: 'Bearer nope' } })
let apiJson = null; try { apiJson = JSON.parse(api.text) } catch {}
row('API 200 through the shell with req.user.id === local, marker v1', api.status === 200 && apiJson?.user?.id === 'local' && apiJson?.marker === 'v1', api.text.slice(0, 200))
const asset = await get(`/modules/global/hello/frontend.js`)
row('module asset 200 with ETag rev', asset.status === 200 && /^"rev-\d+"$/.test(asset.headers.get('etag') ?? ''), asset.headers.get('etag') ?? String(asset.status))
row('assets: react + client.js', (await get('/assets/react.js')).status === 200 && (await get('/assets/client.js')).status === 200)

// c. WS sub → a save → one invalidate; snapshot rev moved; the API answers the new marker
const ws = new WebSocket(`ws://127.0.0.1:${SHELL_PORT}/_atelier/ws?company=global`)
const frames = []
ws.on('message', (d) => frames.push(JSON.parse(d)))
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
ws.send(JSON.stringify({ op: 'sub', topics: [inst, 'company:global'] }))
await sleep(200)
row('ws: subscribed on the instance and company:global', frames.filter((f) => f.type === 'subscribed').length === 2, JSON.stringify(frames))
const revBefore = JSON.parse((await get(`/_atelier/topics/${inst}`)).text).rev
fs.writeFileSync(path.join(appDir, 'backend.js'), backend('v2'))
let inv = null
for (let i = 0; i < 100 && !inv; i++) { inv = frames.find((f) => f.type === 'invalidate' && f.topic === inst); if (!inv) await sleep(100) }
row('ws: a good save → one invalidate on the instance topic within 10 s', !!inv, JSON.stringify(inv))
let snap = null
for (let i = 0; i < 50; i++) { snap = JSON.parse((await get(`/_atelier/topics/${inst}`)).text); if (snap.rev > revBefore) break; await sleep(100) }
row('snapshot: rev moved, error null', snap?.rev > revBefore && snap?.error === null, JSON.stringify(snap))
let v2 = false
for (let i = 0; i < 50 && !v2; i++) { const r = await get('/api/global/hello/who'); v2 = r.text.includes('"marker":"v2"'); if (!v2) await sleep(100) }
row('API answers the new marker v2', v2)
// a broken save: users stay on the old rev, the snapshot carries the error, the fix clears it
const nInv = frames.filter((f) => f.type === 'invalidate' && f.topic === inst).length
fs.writeFileSync(path.join(appDir, 'backend.js'), backend('v3', true))
let errSnap = null
for (let i = 0; i < 100; i++) { if (frames.filter((f) => f.type === 'invalidate' && f.topic === inst).length > nInv) { errSnap = JSON.parse((await get(`/_atelier/topics/${inst}`)).text); if (errSnap.error) break } await sleep(100) }
row('broken save: invalidate + snapshot.error with file:line and a hint, rev unchanged', !!errSnap?.error && errSnap.rev === snap.rev && errSnap.error.file === 'backend.js' && Number.isInteger(errSnap.error.line) && /fix/.test(errSnap.error.hint ?? ''), JSON.stringify(errSnap))
row('broken save: the API still answers v2', (await get('/api/global/hello/who')).text.includes('"marker":"v2"'))
fs.writeFileSync(path.join(appDir, 'backend.js'), backend('v3'))
let fixed = null
for (let i = 0; i < 100; i++) { fixed = JSON.parse((await get(`/_atelier/topics/${inst}`)).text); if (fixed.error === null && fixed.rev > snap.rev) break; await sleep(100) }
row('the fix clears the error and moves the rev', fixed?.error === null && fixed?.rev > snap.rev, JSON.stringify(fixed))
// contiguity of everything this socket saw
const seqs = frames.filter((f) => f.type === 'invalidate' && f.topic === inst).map((f) => f.seq)
row('ws: frames contiguous, 0 gaps', seqs.every((s, i) => s === i + 1) && !frames.some((f) => f.type === 'gap'), JSON.stringify(seqs))
// the app-level liveness echo
ws.send(JSON.stringify({ op: 'pong', at: 42 })); await sleep(100)
row('ws: pong {at} answered with ping {at}', frames.some((f) => f.type === 'ping' && f.at === 42))
ws.terminate()

// d. the waking page: SIGSTOP the host → 503 within 1.2 s; SIGCONT → 200
host.kill('SIGSTOP')
const t0 = Date.now()
const waking = await get('/global/hello')
const dt = Date.now() - t0
row('SIGSTOP host → document 503 waking page within 1.2 s', waking.status === 503 && /Waking up global/.test(waking.text) && dt < 1200, `${waking.status} in ${dt} ms`)
const wapi = await get('/api/global/hello/who')
row('SIGSTOP host → fetch 503 {waking:true}', wapi.status === 503 && wapi.text === '{"waking":true}', wapi.text)
host.kill('SIGCONT')
await sleep(300)
let back = null
for (let i = 0; i < 20; i++) { back = await get('/global/hello'); if (back.status === 200) break; await sleep(250) }
row('SIGCONT → document 200 again', back?.status === 200, String(back?.status))
row('no ?token= anywhere in the host log lines the shell caused', !/token=/.test(hostLog))
await finish()
