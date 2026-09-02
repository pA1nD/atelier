// host/index.mjs — the integrator's pure pieces: config, the host's own dirs, the audit, the mount
// strip, podIp. The wiring itself is proven by the local smoke (README) and the Linux drill.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { config, hostDirs, audit, podIp, readyAfter } from '../index.mjs'
import { mountRelative } from '../supervisor/serve.mjs'
import { unprivileged } from '../adapters/os.mjs'

test('config: defaults are DESIGN §1.2; fleet iff ATELIER_SPINE_URL; dirfd only when numeric', () => {
  const c = config({})
  assert.equal(c.work, '/work'); assert.equal(c.run, '/run/atelier'); assert.equal(c.control, '/control')
  assert.equal(c.hostPort, 1845); assert.equal(c.devPort, 1844); assert.equal(c.company, 'local'); assert.equal(c.origin, 'http://127.0.0.1:1844')
  assert.equal(c.fleet, false); assert.equal(c.dirfd, null); assert.equal(c.chromeDir, null); assert.equal(c.nodeEnv, 'production'); assert.equal(c.gitCommit, true)
  const f = config({ ATELIER_SPINE_URL: 'http://spine:7331', ATELIER_DIRFD: '3', ATELIER_DEV_PORT: '2000', ATELIER_GIT_COMMIT: '0', ATELIER_CHROME_DIR: '' })
  assert.equal(f.fleet, true); assert.equal(f.dirfd, 3); assert.equal(f.origin, 'http://127.0.0.1:2000'); assert.equal(f.gitCommit, false); assert.equal(f.chromeDir, null)
  assert.equal(config({ ATELIER_DIRFD: 'x' }).dirfd, null)
  // ATELIER_APPS_LINKS (shell/ local mode, DESIGN §8 H1): honoured locally, refused in the fleet
  assert.equal(c.appsLinks, false)
  assert.equal(config({ ATELIER_APPS_LINKS: '1' }).appsLinks, true)
  assert.equal(config({ ATELIER_APPS_LINKS: '1', ATELIER_SPINE_URL: 'http://spine:7331' }).appsLinks, false)
  // ATELIER_SEEDED_APPS (DESIGN §10.3 "seeded rows"): the host-level gate of the seeded road — off unless the image says `1`
  assert.equal(c.seededApps, false); assert.equal(f.seededApps, false)
  assert.equal(config({ ATELIER_SEEDED_APPS: '1' }).seededApps, true)
  assert.equal(config({ ATELIER_SEEDED_APPS: 'true' }).seededApps, false)
})

test('hostDirs: fleet adds $run (chmod of the 1777 tmpfs), .atelier/tmp, $run/w, the release rows (data-dev, prod, rehearsal, backup) and the chrome cache to the launcher plan; local carries the launcher rows too', () => {
  const cfg = { work: '/w', run: '/r' }
  assert.deepEqual(hostDirs(cfg, { local: false }), [['/r', 0o711], ['/w/.atelier/tmp', 0o711], ['/r/w', 0o711], ['/w/.atelier/data-dev', 0o711], ['/w/.atelier/prod', 0o711], ['/w/.atelier/rehearsal', 0o711], ['/w/.atelier/backup', 0o711], ['/w/.atelier/chrome', 0o755]])
  const local = hostDirs(cfg, { local: true }).map(([p]) => p)
  assert.deepEqual(local, ['/w/.atelier', '/w/.atelier/data', '/w/.atelier/last-good', '/w/.atelier/scratch', '/w/apps', '/r', '/r/dev', '/r/session', '/r', '/w/.atelier/tmp', '/r/w', '/w/.atelier/data-dev', '/w/.atelier/prod', '/w/.atelier/rehearsal', '/w/.atelier/backup', '/w/.atelier/chrome'])
})

test('audit: a world-readable token, .claude, control, last-good/<inst> or data/<inst> is listed; the tight tree is clean', () => {
  const os = unprivileged()
  const root = fs.mkdtempSync('/tmp/hia-')
  const cfg = { work: path.join(root, 'work'), run: path.join(root, 'run'), control: path.join(root, 'control') }
  fs.mkdirSync(path.join(cfg.work, '.atelier', 'last-good', 'i-1'), { recursive: true, mode: 0o750 })
  fs.mkdirSync(path.join(cfg.work, '.atelier', 'data', 'i-1'), { recursive: true, mode: 0o770 })
  fs.mkdirSync(cfg.run, { recursive: true }); fs.mkdirSync(cfg.control, { mode: 0o700 })
  fs.writeFileSync(path.join(cfg.run, 'bootstrap.token'), 'x', { mode: 0o400 })
  fs.writeFileSync(path.join(cfg.work, '.claude.json'), '{}', { mode: 0o600 })
  const dirfd = os.openDir(path.join(cfg.work, '.atelier'))
  const clean = audit(os, cfg, dirfd)
  assert.deepEqual(clean.bad, [])
  // what is not there is named, not silently skipped (a drill tells "not there yet" from "checked")
  assert.deepEqual(clean.absent, ['dev.token', '.claude', '.mcp.json', '.claude/settings.json'].map((f) => path.join(f === 'dev.token' ? cfg.run : cfg.work, f)))
  fs.chmodSync(path.join(cfg.run, 'bootstrap.token'), 0o644)
  fs.chmodSync(path.join(cfg.work, '.atelier', 'data', 'i-1'), 0o775)
  fs.chmodSync(cfg.control, 0o705)
  fs.chmodSync(path.join(cfg.work, '.claude.json'), 0o640)    // the agent's credential file (API-key tails): group-readable is already too wide
  const { bad } = audit(os, cfg, dirfd)
  assert.equal(bad.length, 4)
  assert.ok(bad.some((b) => b.includes('bootstrap.token 644')))
  assert.ok(bad.some((b) => b.includes('data/i-1 775')))
  assert.ok(bad.some((b) => b.includes('control 705')))
  assert.ok(bad.some((b) => b.includes('.claude.json 640')))
  os.closeFd(dirfd)
  fs.rmSync(root, { recursive: true, force: true })
})

test('mountRelative: /api/<company>/<slug> is stripped once, query kept, bare mount → /, other urls untouched', () => {
  const row = { company: 'acme', slug: 'notes' }
  assert.equal(mountRelative('/api/acme/notes/state', row), '/state')
  assert.equal(mountRelative('/api/acme/notes/a/b?x=1', row), '/a/b?x=1')
  assert.equal(mountRelative('/api/acme/notes', row), '/')
  assert.equal(mountRelative('/api/acme/notes?x=1', row), '/?x=1')
  assert.equal(mountRelative('/api/acme/notesx/state', row), '/api/acme/notesx/state')
  assert.equal(mountRelative('/state', row), '/state')
})

test('podIp: first non-internal IPv4, null without one', () => {
  assert.equal(podIp({ lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }], eth0: [{ address: 'fe80::1', family: 'IPv6', internal: false }, { address: '10.42.0.7', family: 'IPv4', internal: false }] }), '10.42.0.7')
  assert.equal(podIp({ lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }), null)
})

test('readyAfter (S1, review 2026-09-02): a normal host writes host-ready at once, its scan not waited for (OR8); a seeded host waits for the first scan to settle — resolved or rejected — and no longer than the bound, so a broken seeded folder still lets the pod come up', async () => {
  let settle
  const pending = new Promise((r) => { settle = r })
  assert.equal(await readyAfter({ seededApps: false }, pending), 'now')
  const seeded = readyAfter({ seededApps: true }, pending, { timeoutMs: 5000 })
  let done = false; seeded.then(() => { done = true })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(done, false, 'waits for the scan')
  settle(null)
  assert.equal(await seeded, 'scanned')
  assert.equal(await readyAfter({ seededApps: true }, Promise.reject(new Error('scan crashed')), { timeoutMs: 5000 }), 'scanned', 'a rejected scan counts as settled')
  const t0 = Date.now()
  assert.equal(await readyAfter({ seededApps: true }, new Promise(() => {}), { timeoutMs: 40 }), 'timeout')
  assert.ok(Date.now() - t0 >= 35 && Date.now() - t0 < 1000)
})
