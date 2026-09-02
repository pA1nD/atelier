// DESIGN §8.1 same-bytes: `/modules/<c>/<s>/frontend.js` and `styles.css` are byte-identical through
// the protocol port (bearer + assertion) and the dev shell (dev token) — one supervisor.asset behind both.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { unprivileged } from '../adapters/os.mjs'
import { createAuth } from '../protocol/auth.mjs'
import { createServer } from '../protocol/server.mjs'
import { createDevShell } from '../protocol/devshell.mjs'
import { fakeRegistrar, fakeSupervisor, fakeCollector, keys, assertionFor, request, tmp } from './protocol-fixtures.mjs'
import { WAKING_BODY, WAKING_HEADERS, WAKING_STATUS, waking, awaitGate, createServe } from '../supervisor/serve.mjs'
import { WAKING_BODY as SHELL_BODY, WAKING_HEADERS as SHELL_HEADERS } from '../../shell/proxy.mjs'
import { fakeExchange } from './supervisor-harness.test.js'

test('the prod gate\'s 503 is byte-equal to the shell\'s waking answer (DESIGN §10.3 D9): body, status and every header pinned to shell/proxy.mjs; a deployed app whose dev rev == prod rev serves the same bytes on both slots', async () => {
  assert.equal(WAKING_BODY, SHELL_BODY)
  assert.deepEqual({ ...WAKING_HEADERS }, { ...SHELL_HEADERS })
  assert.equal(WAKING_STATUS, 503)
  const x = fakeExchange('GET', '/x')
  waking(x.res)
  const out = await x.finished
  assert.equal(out.status, 503); assert.equal(out.body, SHELL_BODY)
  assert.deepEqual(out.headers, { ...SHELL_HEADERS, 'content-length': Buffer.byteLength(SHELL_BODY) })
  // awaitGate: released inside the hold → true; past it → false (the request answers the waking bytes)
  let release
  const slot = { gate: new Promise((r) => { release = r }) }
  const late = awaitGate(slot, 30)
  assert.equal(await late, false)
  const soon = awaitGate(slot, 5000); release()
  assert.equal(await soon, true)
  assert.equal(await awaitGate({ gate: null }, 1), true)
  // same bytes on both slots: one store, one rev dir — asset() reads the slot's rev; when both point at rev 7 the bytes are one
  const inst = 'i-0123456789abcdef'
  const rows = new Map([[inst, { instance: inst, linked: true, dev: { name: 'dev', rev: 7, kept: [] }, prod: { name: 'prod', rev: 7, kept: [] } }]])
  const serve = createServe({ row: (i) => rows.get(i), store: { read: (i, r, rel) => Buffer.from(`${rel}@${r}`) }, proxy: null, resume: null, readStatic: () => null, keptRev: () => true })
  const a = await serve.asset({ instance: inst }, 'frontend.js', { slot: 'dev' }), b = await serve.asset({ instance: inst }, 'frontend.js', { slot: 'prod' })
  assert.ok(a.body.equals(b.body)); assert.equal(a.rev, b.rev)
  rows.get(inst).dev.rev = 9
  assert.equal((await serve.asset({ instance: inst }, 'frontend.js', { slot: 'dev' })).rev, 9); assert.equal((await serve.asset({ instance: inst }, 'frontend.js')).rev, 7, 'a dev save never moves what the shell serves')
})

test('same bytes via server and devshell for frontend.js and styles.css (and the same ETag)', async () => {
  const dir = tmp()
  const { privateKey, publicKey } = keys()
  const registrar = fakeRegistrar({ hostId: 'computer-1', epoch: 'e1', token: 'tok1', publicKey, company: 'acme' })
  const inst = 'i-0123456789abcdef'
  const big = 'export default ' + JSON.stringify('x'.repeat(200_000)) + '\n// ' + Array.from({ length: 2000 }, (_, i) => `line${i}`).join('\n')
  const supervisor = fakeSupervisor({
    rows: [{ instance: inst, slug: 'todo', company: 'acme', uid: 20001, rev: 7, state: 'live' }],
    assets: { [inst]: { 'frontend.js': [{ rev: 7, body: big, type: 'application/javascript; charset=utf-8' }], 'styles.css': [{ rev: 7, body: '.a{color:red}\n'.repeat(5000), type: 'text/css; charset=utf-8' }] } },
  })
  const collector = fakeCollector()
  const auth = createAuth({ registrar, devToken: 'dev-secret' })
  const server = createServer({ auth, supervisor, collector, registrar, listen: { path: path.join(dir, 'h.sock') } })
  const dev = createDevShell({ cfg: {}, os: unprivileged(), supervisor, collector, registrar, auth, sockPath: path.join(dir, 'd.sock'), devPort: null })
  await server.listen(); await dev.listen()
  try {
    for (const rel of ['frontend.js', 'styles.css']) {
      const p = `/modules/acme/todo/${rel}`
      const viaServer = await request({ socketPath: path.join(dir, 'h.sock') }, { path: p, headers: { authorization: 'Bearer e1.tok1', 'x-atelier-identity': assertionFor(privateKey, { hostId: 'computer-1', instance: inst, method: 'GET', path: p }) } })
      const viaDev = await request({ socketPath: path.join(dir, 'd.sock') }, { path: p, headers: { 'x-atelier-dev-token': 'dev-secret' } })
      assert.equal(viaServer.status, 200); assert.equal(viaDev.status, 200)
      assert.ok(viaServer.body.equals(viaDev.body), `${rel}: bytes differ`)
      assert.equal(viaServer.headers.etag, viaDev.headers.etag)
      assert.equal(viaServer.headers['content-type'], viaDev.headers['content-type'])
      assert.equal(viaServer.body.length, rel === 'frontend.js' ? Buffer.byteLength(big) : 14 * 5000)
    }
  } finally { await server.close(); await dev.close() }
})
