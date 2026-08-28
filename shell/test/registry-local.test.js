// shell/providers/registry-local.mjs — the mount table from a stubbed discover() joined with the
// host's /_atelier/apps; present() true; watch fires on change; chrome digest.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRegistryLocal, chromeDigest } from '../providers/registry-local.mjs'
import { createHostLinkLocal } from '../providers/hostlink-local.mjs'
import { createMinter } from '../minter.mjs'
import { fakeHost, TODO, WIKI, CHROME_APP } from './fixtures.mjs'

async function rig(t) {
  const host = fakeHost({ company: 'global' })
  const hp = await host.start()
  const rows = [
    { workspace: 'global', id: 'todo', dir: '/tmp/x/todo', meta: { name: 'Todo', icon: '✅', primary: true, group: 'Tools', color: '#fff', trusted: true }, hasFrontend: true, hasBackend: true },
    { workspace: 'global', id: 'wiki', dir: '/tmp/x/wiki', meta: {}, hasFrontend: true, hasBackend: false },
    { workspace: 'global', id: 'pending', dir: '/tmp/x/pending', meta: { name: 'Not claimed yet' }, hasFrontend: true, hasBackend: false },
    { workspace: 'global', id: 'catalyst-chrome', dir: '/tmp/x/chrome', meta: { isChrome: true }, hasFrontend: true, hasBackend: true },
    { workspace: 'lab', id: 'other', dir: '/tmp/x/other', meta: {}, hasFrontend: true, hasBackend: false },
  ]
  const workspaces = [{ id: 'global', port: hp, token: 'dev' }, { id: 'lab', port: 1, token: 'dev' }]
  const chromeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-'))
  fs.writeFileSync(path.join(chromeDir, 'frontend.jsx'), 'x')
  const hostLink = createHostLinkLocal({ minter: createMinter(), dialMs: 300 })
  const logs = []
  let clock = 1_000_000
  const registry = createRegistryLocal({ workspaces: () => workspaces, discover: () => rows, chrome: { qid: 'global/catalyst-chrome', dir: chromeDir }, hostLink, log: (l) => logs.push(l), now: () => clock, ttlMs: 100 })
  const out = { host, rows, workspaces, registry, logs, chromeDir, tick: (ms) => { clock += ms }, stopped: false }
  t.after(async () => { registry.stop(); hostLink.close(); if (!out.stopped) await host.stop() })
  return out
}

test('the mount table: discovered folders joined with the host rows; meta split; the chrome staged as a hidden app; unclaimed folders wait', async (t) => {
  const r = await rig(t)
  assert.deepEqual(r.registry.companies(), [{ id: 'global', name: 'global', href: '/global/' }, { id: 'lab', name: 'lab', href: '/lab/' }])
  const apps = await r.registry.apps('global')
  assert.deepEqual(apps.map((a) => a.slug), ['todo', 'wiki', 'catalyst-chrome'])
  assert.deepEqual(apps[0], { instance: TODO, slug: 'todo', company: 'global', meta: { name: 'Todo', icon: '✅', group: 'Tools', color: '#fff' }, requestedPrimary: true, primary: true, rev: 3, state: 'live', hasFrontend: true, dir: '/tmp/x/todo' })
  assert.deepEqual(apps[1].meta, { name: 'wiki' }); assert.equal(apps[1].primary, false)
  assert.equal(apps[2].isChrome, true); assert.equal(apps[2].instance, CHROME_APP); assert.equal(apps[2].hasFrontend, false)
  assert.equal((await r.registry.resolve('global', 'wiki')).instance, WIKI)
  assert.equal(await r.registry.resolve('global', 'pending'), null)
  assert.equal((await r.registry.byInstance(TODO)).slug, 'todo')
  assert.equal(await r.registry.byInstance('i-0000000000000000'), null)
  assert.equal(await r.registry.present('anyone', TODO), true)
  // lab's host is down: no rows, no throw
  assert.deepEqual(await r.registry.apps('lab'), [])
  const h = await r.registry.host('global')
  assert.equal(h.port, r.workspaces[0].port); assert.equal(h.token, 'dev'); assert.equal(h.ip, '127.0.0.1'); assert.equal(h.tls, null); assert.equal(h.drainingAt, null)
  assert.equal(h.heartbeatAt, 1_000_000)   // the successful /_atelier/apps fetch counts as a heartbeat
  assert.equal(await r.registry.host('nope'), null)
  // the host goes away: the last rows are served stale, the company is marked waking
  await r.host.stop()
  r.tick(200)
  assert.deepEqual((await r.registry.apps('global')).map((a) => a.slug), ['todo', 'wiki', 'catalyst-chrome'])
  assert.ok(r.logs.some((l) => /host unreachable/.test(l)))
  r.stopped = true
})

test('watch fires on refresh when the host rows changed (a new claim, a new rev); the chrome digest is the folder max mtime', async (t) => {
  const r = await rig(t)
  const fired = []
  r.registry.watch('global', () => fired.push('global'))
  await r.registry.refresh()
  assert.deepEqual(fired, [])
  r.host.state.rows.push({ instance: 'i-1111111111111111', slug: 'pending', company: 'global', rev: 1, state: 'live' })
  assert.equal(await r.registry.refresh('global'), true)
  assert.deepEqual(fired, ['global'])
  assert.equal((await r.registry.resolve('global', 'pending')).instance, 'i-1111111111111111')
  r.host.state.rows[0].rev = 4
  r.tick(200)
  await r.registry.refresh('global')
  assert.deepEqual(fired, ['global', 'global'])
  assert.equal((await r.registry.byInstance(TODO)).rev, 4)
  assert.ok(r.logs.some((l) => /registry: global changed/.test(l)))
  const c = r.registry.chrome('global')
  assert.equal(c.qid, 'global/catalyst-chrome'); assert.equal(c.dir, r.chromeDir)
  assert.equal(c.digest, chromeDigest(r.chromeDir)); assert.ok(c.digest > 0)
  r.registry.noteProbe('global', { ok: true, epoch: 'e9' })
  assert.equal((await r.registry.host('global')).epoch, 'e9')
})

test('the host unreachable: refresh() and the poll serve the LAST rows (byInstance still resolves — the socket ACL keeps its topics), fresh rows on return', async (t) => {
  const r = await rig(t)
  assert.equal((await r.registry.byInstance(TODO)).slug, 'todo')
  await r.host.stop(); r.stopped = true
  r.tick(200)
  assert.equal(await r.registry.refresh('global'), false)          // the mount table did not move
  assert.equal((await r.registry.byInstance(TODO)).slug, 'todo')
  assert.ok(r.registry.unreachableAt('global') > 0)
  assert.ok(r.logs.some((l) => /unreachable .* serving 3 stale rows/.test(l)), r.logs.join('\n'))
})
