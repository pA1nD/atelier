// host/protocol/devshell.mjs — the dev token on both listeners, the 1.x document, assets, same routes, WS frames.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { WebSocket } from 'ws'
import { unprivileged, memory } from '../adapters/os.mjs'
import { createAuth } from '../protocol/auth.mjs'
import { createDevShell, REPO_ROOT } from '../protocol/devshell.mjs'
import { fakeRegistrar, fakeSupervisor, fakeCollector, request, tmp } from './protocol-fixtures.mjs'

function chromeFixture(dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'frontend.jsx'), `import React from 'react'\nimport { Button } from './kit.jsx'\nexport const meta = { isChrome: true }\nexport function chrome({ children }) { return <div className="p-4"><Button/>{children}</div> }\nexport default function Chrome() { return <div>chrome-fixture</div> }\n`)
  fs.writeFileSync(path.join(dir, 'kit.jsx'), `import React from 'react'\nexport function Button() { return <button className="rounded">ok</button> }\n`)
  fs.writeFileSync(path.join(dir, 'styles.css'), `@import "tailwindcss";\n/* chrome-fixture-sheet */\n`)
}

function rig({ chrome = true, devToken = 'dev-secret', privileged = false } = {}) {
  const dir = tmp()
  const chromeDir = path.join(dir, 'chrome-fixture')
  if (chrome) chromeFixture(chromeDir)
  const registrar = fakeRegistrar({ company: 'acme', principal: { id: 'p-agent', name: 'Bayard' } })
  registrar.apps().set('i-0123456789abcdef', { slug: 'todo', uid: 20001, rev: 3, meta: { name: 'Todo', icon: '✅' }, tombstone_at: null })
  const rows = [
    { instance: 'i-0123456789abcdef', slug: 'todo', company: 'acme', uid: 20001, rev: 3, state: 'live' },
    { instance: 'i-fedcba9876543210', slug: 'wiki', company: 'acme', uid: 20002, rev: 1, state: 'stopped' },
  ]
  const assets = { 'i-0123456789abcdef': { 'frontend.js': [{ rev: 3, body: '// todo rev3', type: 'application/javascript; charset=utf-8' }], 'styles.css': [{ rev: 3, body: '.todo{}', type: 'text/css; charset=utf-8' }] } }
  const supervisor = fakeSupervisor({ rows, assets })
  const collector = fakeCollector(); collector.setRunning('i-0123456789abcdef', 3); collector.setRecent('i-0123456789abcdef', [{ kind: 'build', message: 'x' }])
  const logs = []
  const auth = createAuth({ registrar, devToken, log: (l) => logs.push(l) })
  const state = {}
  const os = privileged ? memory(state) : unprivileged()
  const sock = path.join(dir, 'dev.sock')
  const dev = createDevShell({ cfg: { chromeDir: chrome ? chromeDir : undefined, nodeEnv: 'production' }, os, supervisor, collector, registrar, auth, log: (l) => logs.push(l), sockPath: sock, devPort: 0 })
  return { dir, chromeDir, registrar, supervisor, collector, auth, dev, sock, logs, state }
}
const tok = { 'x-atelier-dev-token': 'dev-secret' }

test('every request needs the dev token, on the socket and on loopback — the document included; ?token= and referer carry it too', async () => {
  const r = rig()
  const { sock, port } = await r.dev.listen()
  try {
    assert.equal(sock, r.sock); assert.ok(port > 0)
    for (const target of [{ socketPath: r.sock }, { host: '127.0.0.1', port }]) {
      let res = await request(target, { path: '/' })
      assert.equal(res.status, 401); assert.equal(res.body.toString(), '{}')
      res = await request(target, { path: '/modules/acme/todo/frontend.js' })
      assert.equal(res.status, 401)
      res = await request(target, { path: '/?token=wrong' })
      assert.equal(res.status, 401)
      res = await request(target, { path: '/', headers: tok })
      assert.equal(res.status, 200); assert.equal(res.headers['content-type'], 'text/html; charset=utf-8'); assert.equal(res.headers['cache-control'], 'no-store')
      res = await request(target, { path: '/?token=dev-secret' })
      assert.equal(res.status, 200)
      res = await request(target, { path: '/assets/chrome-resolve.js', headers: { referer: `http://127.0.0.1:${port}/?token=dev-secret` } })
      assert.equal(res.status, 200)
    }
    assert.ok(r.logs.some((l) => /dev: 401 no-token GET \//.test(l)))
  } finally { await r.dev.close() }
})

test('the document: 1.x bootstrap shape, import map to the chrome kit, exactly ONE <link> (app sheet on /<company>/<slug>, chrome sheet otherwise)', async () => {
  const r = rig()
  await r.dev.listen()
  try {
    const t = { socketPath: r.sock }
    let html = (await request(t, { path: '/', headers: tok })).body.toString()
    const boot = JSON.parse(/<script>window\.__ATELIER__ = (.*?);<\/script>/s.exec(html)[1])
    assert.deepEqual(boot, {
      mode: 'host', label: null, observe: false,
      user: { id: 'p-agent', name: 'Bayard', workspaces: [{ id: 'acme', modules: [{ id: 'todo', meta: { name: 'Todo', icon: '✅' } }, { id: 'wiki', meta: {} }] }] },
      workspace: 'acme', workspaces: ['acme'],
      chromeQid: 'global/chrome-fixture', defaultChromeQid: 'global/chrome-fixture', chromes: ['global/chrome-fixture'], backendErrors: [],
    })
    assert.ok(html.includes('<script type="importmap">{"imports":{"@atelier/kit":"/modules/global/chrome-fixture/kit.js"}}</script>'))
    assert.equal((html.match(/<link /g) ?? []).length, 1)
    assert.ok(html.includes('<link id="atelier-chrome-styles" rel="stylesheet" href="/modules/global/chrome-fixture/styles.css">'))
    assert.ok(html.includes('<script src="/assets/react.js"></script>') && html.includes('<script type="module" src="/assets/client.js"></script>'))
    assert.ok(!html.includes('__ATELIER_BOOTSTRAP__') && !html.includes('__ATELIER_IMPORTMAP__') && !html.includes('__ATELIER_CHROME_STYLES__'))
    // `?token=` presented → every URL the host writes carries it (a module import's referer is the
    // importing module, a WS handshake has none): script srcs, the sheet link, the import map
    html = (await request(t, { path: '/acme/todo/items/1?token=dev-secret' })).body.toString()
    assert.equal((html.match(/<link /g) ?? []).length, 1)
    assert.ok(html.includes('href="/modules/acme/todo/styles.css?token=dev-secret"'))
    assert.ok(html.includes('<script src="/assets/react.js?token=dev-secret"></script>') && html.includes('<script type="module" src="/assets/client.js?token=dev-secret"></script>'))
    assert.ok(html.includes('{"imports":{"@atelier/kit":"/modules/global/chrome-fixture/kit.js?token=dev-secret"}}'))
    html = (await request(t, { path: '/acme/nope', headers: tok })).body.toString()
    assert.ok(html.includes('href="/modules/global/chrome-fixture/styles.css"'))
    // act-as changes the document's user
    html = (await request(t, { path: '/', headers: { ...tok, 'x-atelier-user': 'p9', 'x-atelier-name': 'Nine' } })).body.toString()
    assert.ok(html.includes('"user":{"id":"p9","name":"Nine"'))
    // reserved prefixes never fall through to the document
    for (const p of ['/assets/nope.js', '/_atelier/nope', '/_host/nope', '/api/acme/nope/x', '/modules/acme/nope/x']) assert.equal((await request(t, { path: p, headers: tok })).status, 404)
    assert.equal((await request(t, { method: 'POST', path: '/acme/todo', headers: tok })).status, 405)
  } finally { await r.dev.close() }
})

test('no chrome: app-less document without link or import map; whoami; events; apps; healthz', async () => {
  const r = rig({ chrome: false })
  await r.dev.listen()
  try {
    const t = { socketPath: r.sock }
    const html = (await request(t, { path: '/', headers: tok })).body.toString()
    assert.ok(html.includes('"chromeQid":null,"defaultChromeQid":null,"chromes":[]'))
    assert.equal((html.match(/<link /g) ?? []).length, 0); assert.ok(!html.includes('<script type="importmap">{"imports"'))
    assert.deepEqual(JSON.parse((await request(t, { path: '/_atelier/whoami', headers: tok })).body), { id: 'p-agent', name: 'Bayard', anonymous: false })
    assert.deepEqual(JSON.parse((await request(t, { path: '/_atelier/events?app=i-0123456789abcdef', headers: tok })).body), [{ kind: 'build', message: 'x' }])
    assert.equal((await request(t, { path: '/_atelier/events?app=i-nope', headers: tok })).status, 404)
    assert.equal(JSON.parse((await request(t, { path: '/_atelier/apps', headers: tok })).body).length, 2)
    const h = JSON.parse((await request(t, { path: '/_host/healthz', headers: tok })).body)
    assert.equal(h.api, 'atelier/2'); assert.equal(h.apps, 2)
    assert.equal((await request(t, { path: '/modules/global/x/frontend.js', headers: tok })).status, 404)
  } finally { await r.dev.close() }
})

test('assets: React UMDs from node_modules, client.jsx transformed, chrome frontend/kit bundled with the shims, styles.css pass-through, gzip when accepted', async () => {
  const r = rig()
  await r.dev.listen()
  try {
    const t = { socketPath: r.sock }
    let res = await request(t, { path: '/assets/react.js', headers: tok })
    assert.equal(res.status, 200); assert.equal(res.headers['content-type'], 'application/javascript; charset=utf-8')
    assert.equal(res.body.toString(), fs.readFileSync(path.join(REPO_ROOT, 'node_modules/react/umd/react.production.min.js')).toString())
    assert.equal((await request(t, { path: '/assets/react-dom.js', headers: tok })).status, 200)
    res = await request(t, { path: '/assets/client.js', headers: tok })
    assert.equal(res.status, 200); assert.ok(res.body.toString().includes('React.createElement')); assert.ok(!res.body.toString().includes('<div')); assert.match(res.headers.etag, /^"\d+/)
    res = await request(t, { path: '/assets/chrome-resolve.js', headers: tok })
    assert.equal(res.body.toString(), fs.readFileSync(path.join(REPO_ROOT, 'chrome-resolve.js'), 'utf8'))
    res = await request(t, { path: '/modules/global/chrome-fixture/frontend.js', headers: tok })
    assert.equal(res.status, 200)
    const js = res.body.toString()
    assert.ok(js.includes('chrome-fixture')); assert.ok(!js.includes('from "react"')); assert.ok(js.includes('window.React') || js.includes('globalThis.React'))   // shim aliased, bundled, minified
    res = await request(t, { path: '/modules/global/chrome-fixture/kit.js', headers: tok })
    assert.equal(res.status, 200); assert.ok(res.body.toString().includes('rounded'))
    res = await request(t, { path: '/modules/global/chrome-fixture/styles.css', headers: tok })
    assert.equal(res.status, 200); assert.equal(res.headers['content-type'], 'text/css; charset=utf-8'); assert.ok(res.body.toString().includes('chrome-fixture-sheet'))
    assert.equal((await request(t, { path: '/modules/global/chrome-fixture/other.js', headers: tok })).status, 404)
    // gzip
    res = await request(t, { path: '/assets/client.js', headers: { ...tok, 'accept-encoding': 'gzip, br' } })
    assert.equal(res.headers['content-encoding'], 'gzip'); assert.equal(res.headers.vary, 'accept-encoding')
    assert.ok(zlib.gunzipSync(res.body).toString().includes('React.createElement'))
    // a wired chrome sheet wins over pass-through
    const dev2 = createDevShell({ cfg: { chromeDir: r.chromeDir }, os: unprivileged(), supervisor: r.supervisor, collector: r.collector, registrar: r.registrar, auth: r.auth, sockPath: path.join(r.dir, 'd2.sock'), devPort: null, chromeSheet: async () => ({ body: Buffer.from('.compiled{}'), type: 'text/css; charset=utf-8' }) })
    await dev2.listen()
    try { assert.equal((await request({ socketPath: path.join(r.dir, 'd2.sock') }, { path: '/modules/global/chrome-fixture/styles.css', headers: tok })).body.toString(), '.compiled{}') } finally { await dev2.close() }
  } finally { await r.dev.close() }
})

test('app routes are the supervisor’s (same functions as the protocol port): /api handled with the principal, /modules bytes, report → collector', async () => {
  const r = rig()
  await r.dev.listen()
  try {
    const t = { socketPath: r.sock }
    let res = await request(t, { method: 'POST', path: '/api/acme/todo/items?x=1', headers: tok, body: 'hello' })
    assert.equal(res.status, 200)
    const j = JSON.parse(res.body.toString())
    assert.deepEqual(j.user, { id: 'p-agent', name: 'Bayard', claims: {} }); assert.equal(j.url, '/api/acme/todo/items?x=1'); assert.equal(j.bytes, 5)
    assert.deepEqual(r.supervisor.handled.at(-1).slot, 'dev', 'the dev shell serves the DEV slot (D3)')
    assert.deepEqual(r.registrar.servedList, [], 'a dev request is not a served app (the heartbeat counts the company\'s road only)')
    // the dev token in the URL never reaches the worker: stripped before supervisor.handle, the rest of the query kept
    res = await request(t, { method: 'POST', path: '/api/acme/todo/items?token=dev-secret&x=1&y=2', body: 'hi' })
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body.toString()).url, '/api/acme/todo/items?x=1&y=2')
    assert.equal(r.supervisor.handled.at(-1).url, '/api/acme/todo/items?x=1&y=2')
    res = await request(t, { method: 'POST', path: '/api/acme/todo/items?token=dev-secret', body: 'hi' })
    assert.equal(JSON.parse(res.body.toString()).url, '/api/acme/todo/items')
    assert.equal(r.supervisor.handled.some((h) => /token=/.test(h.url)), false)
    res = await request(t, { path: '/modules/acme/todo/frontend.js', headers: tok })
    assert.equal(res.status, 200); assert.equal(res.body.toString(), '// todo rev3'); assert.equal(res.headers.etag, '"rev-3"')
    assert.equal((await request(t, { path: '/modules/acme/todo/frontend.js?rev=9', headers: tok })).status, 404)
    assert.equal((await request(t, { path: '/api/acme/nope/x', headers: tok })).status, 404)
    res = await request(t, { method: 'POST', path: '/_atelier/report', headers: { ...tok, 'content-type': 'application/json' }, body: JSON.stringify({ instance: 'i-0123456789abcdef', rev: 3, message: 'fe boom' }) })
    assert.equal(res.status, 200); assert.equal(r.collector.reports[0].detail.message, 'fe boom')
    res = await request(t, { method: 'POST', path: '/_atelier/report', headers: { ...tok, 'content-type': 'application/json' }, body: JSON.stringify({ instance: 'i-0123456789abcdef', rev: 1, message: 'old' }) })
    assert.equal(res.status, 400)
  } finally { await r.dev.close() }
})

test('the release verbs (D6): POST /_atelier/deploy streams NDJSON step lines + ONE verdict; 401 without the token, 404 unknown app (slug or instance), 409 in progress, 400 no message; rollback = commit; restore; the two lists', async () => {
  const r = rig()
  await r.dev.listen()
  try {
    const t = { socketPath: r.sock }
    const post = (p, body, headers = tok) => request(t, { method: 'POST', path: p, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const lines = (res) => res.body.toString().trim().split('\n').map((l) => JSON.parse(l))
    assert.equal((await post('/_atelier/deploy', { app: 'todo', message: 'x' }, {})).status, 401)
    let res = await post('/_atelier/deploy', { app: 'nope', message: 'x' })
    assert.equal(res.status, 404); assert.deepEqual(JSON.parse(res.body.toString()), { error: 'unknown app' })
    res = await post('/_atelier/deploy', { app: 'todo' })
    assert.equal(res.status, 400)
    res = await post('/_atelier/deploy', { app: 'todo', message: 'first release' })
    assert.equal(res.status, 200); assert.equal(res.headers['content-type'], 'application/x-ndjson; charset=utf-8'); assert.equal(res.headers['cache-control'], 'no-store')
    let ls = lines(res)
    assert.deepEqual(ls.map((l) => l.t), ['step', 'step', 'verdict'])
    assert.equal(ls.at(-1).outcome, 'green'); assert.equal(ls.at(-1).slug, 'todo'); assert.equal(ls.at(-1).rev, 4)
    assert.deepEqual(r.supervisor.verbs.at(-1), { verb: 'deploy', instance: 'i-0123456789abcdef', message: 'first release', commit: null, noBackup: false, by: 'agent:p-agent' })
    // by the instance id too; the act-as header names the principal
    res = await post('/_atelier/deploy', { app: 'i-fedcba9876543210', message: 'x', noBackup: true }, { ...tok, 'x-atelier-user': 'p9' })
    assert.equal(res.status, 200); assert.equal(r.supervisor.verbs.at(-1).by, 'agent:p9'); assert.equal(r.supervisor.verbs.at(-1).noBackup, true)
    // rollback = the same verb with a commit
    res = await post('/_atelier/deploy', { app: 'todo', commit: '0f3c9a1b2d4e' })
    assert.equal(lines(res).at(-1).kind, 'rollback'); assert.equal(r.supervisor.verbs.at(-1).commit, '0f3c9a1b2d4e')
    // 409 while one runs
    r.supervisor.rows[0].deploying = true
    res = await post('/_atelier/deploy', { app: 'todo', message: 'again' })
    assert.equal(res.status, 409); assert.deepEqual(JSON.parse(res.body.toString()), { error: 'deploy in progress' })
    r.supervisor.rows[0].deploying = false
    // a scripted red verdict reaches the stream as the last line
    r.supervisor.rows[0].script = { t: 'verdict', outcome: 'red', kind: 'deploy', slug: 'todo', rev: 3, commit: 'c'.repeat(40), step: 'hook', error: 'exit 1' }
    ls = lines(await post('/_atelier/deploy', { app: 'todo', message: 'broken' }))
    assert.deepEqual(ls.at(-1), r.supervisor.rows[0].script)
    // restore
    res = await post('/_atelier/restore', { app: 'todo', backup: '20260902T104702Z-rev3-0f3c9a1b2d4e' })
    assert.equal(res.status, 200); assert.equal(lines(res).at(-1).kind, 'restore'); assert.equal(r.supervisor.verbs.at(-1).backup, '20260902T104702Z-rev3-0f3c9a1b2d4e')
    assert.equal((await post('/_atelier/restore', { app: 'todo', backup: '../x' })).status, 404)
    // the lists
    r.supervisor.rows[0].releases = [{ id: 'r-1', kind: 'deploy', verdict: 'green', rev: 3, commit: 'c'.repeat(40), message: 'first', at: '2026-09-02T10:00:00.000Z', by: 'agent:p-agent' }]
    r.supervisor.rows[0].backups = [{ id: '20260902T104702Z-rev3-0f3c9a1b2d4e', at: '2026-09-02T10:47:02.000Z', rev: 3, commit: '0f3c9a1b2d4e', bytes: 12582912 }]
    res = await request(t, { path: '/_atelier/releases?app=todo', headers: tok })
    assert.deepEqual(JSON.parse(res.body.toString()), { instance: 'i-0123456789abcdef', slug: 'todo', releases: r.supervisor.rows[0].releases })
    res = await request(t, { path: '/_atelier/backups?app=i-0123456789abcdef', headers: tok })
    assert.deepEqual(JSON.parse(res.body.toString()), { instance: 'i-0123456789abcdef', slug: 'todo', backups: r.supervisor.rows[0].backups })
    assert.equal((await request(t, { path: '/_atelier/releases?app=nope', headers: tok })).status, 404)
    assert.equal((await request(t, { path: '/_atelier/releases', headers: tok })).status, 404)
    assert.equal((await request(t, { path: '/_atelier/events?app=todo', headers: tok })).status, 200, '?app= takes the slug too')
  } finally { await r.dev.close() }
})

test('WS: /_atelier/ws needs the token; broadcast frames carry topic company/slug (last wins); reload and backend-error ride the shell topic', async () => {
  const r = rig()
  const { port } = await r.dev.listen()
  try {
    await new Promise((resolve) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/_atelier/ws`); ws.on('error', () => resolve()); ws.on('unexpected-response', (_, res) => { assert.equal(res.statusCode, 401); ws.terminate(); resolve() }) })
    const ws = new WebSocket(`ws://127.0.0.1:${port}/_atelier/ws?token=dev-secret`)
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
    assert.equal(r.dev.clients.size, 1)
    const frames = []
    ws.on('message', (m) => frames.push(JSON.parse(m.toString())))
    r.dev.broadcast('i-0123456789abcdef', { type: 'run-started', id: 1, topic: 'forged' })
    r.dev.invalidate('i-0123456789abcdef', { rev: 3 })
    r.dev.backendError('i-fedcba9876543210', 'mount threw')
    r.dev.broadcast('i-nope', { type: 'x' })
    await new Promise((res) => setTimeout(res, 50))
    assert.deepEqual(frames, [
      { type: 'run-started', id: 1, topic: 'acme/todo' },
      { type: 'reload', moduleId: 'acme/todo', rev: 3, cssOnly: false, topic: 'shell' },
      { type: 'backend-error', qid: 'acme/wiki', message: 'mount threw', topic: 'shell' },
    ])
    ws.close()
    await new Promise((res) => setTimeout(res, 20))
    assert.equal(r.dev.clients.size, 0)
    // any other upgrade path is dropped
    await new Promise((resolve) => { const w = new WebSocket(`ws://127.0.0.1:${port}/other?token=dev-secret`); w.on('error', () => resolve()); w.on('unexpected-response', () => resolve()) })
  } finally { await r.dev.close() }
})

test('the socket is chowned 0:1000 and chmodded 0660 after bind (recorded by memory(); a no-op on a laptop)', async () => {
  const r = rig({ privileged: true })
  await r.dev.listen()
  try {
    assert.deepEqual(r.state.calls.filter((c) => c[0] === 'chown' || c[0] === 'chmod'), [['chown', r.sock, 0, 1000], ['chmod', r.sock, 0o660]])
  } finally { await r.dev.close() }
})

test('refuse(): a host fault answers 503 on the dev shell before auth or any route', async () => {
  const r = rig()
  let fault = null
  const dev = createDevShell({ cfg: { nodeEnv: 'production' }, os: unprivileged(), supervisor: r.supervisor, collector: r.collector, registrar: r.registrar, auth: r.auth, sockPath: path.join(r.dir, 'f.sock'), devPort: null, refuse: () => fault })
  await dev.listen()
  try {
    const t = { socketPath: path.join(r.dir, 'f.sock') }
    assert.equal((await request(t, { path: '/_atelier/whoami', headers: tok })).status, 200)
    fault = '.atelier renamed'
    const res = await request(t, { path: '/_atelier/whoami', headers: tok })
    assert.equal(res.status, 503); assert.deepEqual(JSON.parse(res.body.toString()), { error: 'host fault', reason: '.atelier renamed' })
    assert.equal((await request(t, { path: '/api/acme/todo/x', headers: tok })).status, 503)
    fault = null
    assert.equal((await request(t, { path: '/_atelier/whoami', headers: tok })).status, 200)
  } finally { await dev.close() }
})

test('no dev token file: both listeners answer 401 to everything (OR12: no fallback)', async () => {
  const r = rig({ devToken: null })
  const { port } = await r.dev.listen()
  try {
    assert.equal((await request({ socketPath: r.sock }, { path: '/?token=anything' })).status, 401)
    assert.equal((await request({ host: '127.0.0.1', port }, { path: '/_atelier/whoami', headers: tok })).status, 401)
    assert.ok(r.logs.some((l) => l.includes('NO DEV TOKEN')))
  } finally { await r.dev.close() }
})
