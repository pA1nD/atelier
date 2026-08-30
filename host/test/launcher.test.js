// host/launcher.mjs + host/hygiene.mjs — the boot plan as data, its execution order on the memory
// adapter, the token files, and the env rows H/S/X (DESIGN §2.1 steps 1–3b, §2.2, §8.1 launcher row).
import test from 'node:test'
import assert from 'node:assert/strict'
import { memory } from '../adapters/os.mjs'
import { AGENT, AGENT_DATA_GID, SECRETS, NEVER_BELOW, scrub, bootPlan, hostEnv, sessionEnv, helperEnv } from '../hygiene.mjs'
import { runPlan, createLauncher, config, crashLine } from '../launcher.mjs'

const CFG = { work: '/work', run: '/run/atelier', control: '/control', tmp: '/tmp', graceS: 40 }

// A recording io that shares the memory adapter's call log so cross-object order is one list.
function fakeIo(state) {
  return {
    umask: (m) => state.calls.push(['umask', m]),
    write: (p, data, mode) => {
      if (state.fs[p]) { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e }
      state.fs[p] = { uid: 0, gid: 0, mode, type: 'file', data }; state.calls.push(['write', p, mode])
    },
    unlink: (p) => { delete state.fs[p]; state.calls.push(['unlink', p]) },
  }
}
// root WITHOUT CAP_DAC_OVERRIDE (the four-cap set, R1): creating an entry needs write on the parent by the
// ordinary bits — owner 0 → the owner bits, group 0 → the group bits, else "other". The memory adapter
// models no permissions; this wraps it for the rows that are about them (a parent the state does not
// carry — /run, /tmp — is fine).
function withDac(os, io, state) {
  const dirname = (p) => p.slice(0, p.lastIndexOf('/')) || '/'
  const mayCreateIn = (dir) => { const e = state.fs[dir]; if (!e) return true; const bit = e.uid === 0 ? 0o200 : e.gid === 0 ? 0o020 : 0o002; return (e.mode & bit) !== 0 }
  const deny = () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e }
  const mkdir = os.mkdir, write = io.write
  os.mkdir = (p, mode) => { if (!state.fs[p] && !mayCreateIn(dirname(p))) deny(); return mkdir(p, mode) }
  io.write = (p, data, mode) => { if (!mayCreateIn(dirname(p))) deny(); return write(p, data, mode) }
}
const POD_ENV = {
  PATH: '/work/.local/bin:/usr/local/bin:/usr/bin:/bin', HOME: '/work', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'xterm-256color',
  CHAT_ID: 'c1', PERSONA: 'bayard', PERSONA_TEXT: 'You are…', STORY_TEXT: 'story',
  CHANNEL_URL: 'http://spine:7331', CHANNEL_TOKEN: 'chan-secret', CHANNEL_CHAT: 'c1',
  ANTHROPIC_MODEL: 'claude-x', ANTHROPIC_API_KEY: 'sk-ant-secret', CLAUDE_MODEL: 'claude-y', DISABLE_AUTOUPDATER: '1', OPENAI_VOICE_TOKEN: 'voice-secret',
  HORSE_BROWSER_BIN: '/usr/local/bin/chrome-egress', HORSE_BROWSER_UNATTENDED: '1', FLEET_EGRESS: 'http://exit', FLEET_EGRESS_TZ: 'Europe/Berlin',
  PIP_USER: '1', NPM_CONFIG_PREFIX: '/work/.npm-global',
  ATELIER_BOOTSTRAP: 'boot-secret', ATELIER_GRACE_S: '40', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret', KUBERNETES_SERVICE_HOST: '10.0.0.1',
  // a wrapper that forgot the unset: the leaf PEMs are dropped under every key list (NEVER_BELOW), never below the launcher
  ATELIER_HOST_TLS_CERT: '-----BEGIN CERTIFICATE-----', ATELIER_HOST_TLS_KEY: '-----BEGIN PRIVATE KEY-----', ATELIER_HOST_TLS_CA: '-----BEGIN CERTIFICATE-----',
}

test('bootPlan: the step list is byte-exact (DESIGN §2.1 steps 1–3b)', () => {
  const plan = bootPlan(CFG, { bootstrap: 'B', devToken: 'D' })
  assert.deepEqual(plan, [
    { op: 'umask', mode: 0 },
    { op: 'chownIf', path: '/work', ifOwner: [1000, 1000], uid: 0, gid: 0 },
    { op: 'mkdir', path: '/work/.atelier', mode: 0o711, owner: [0, 0] },
    { op: 'mkdir', path: '/work/.atelier/data', mode: 0o711, owner: [0, 0] },
    { op: 'mkdir', path: '/work/.atelier/last-good', mode: 0o711, owner: [0, 0] },
    { op: 'mkdir', path: '/work/.atelier/scratch', mode: 0o711, owner: [0, 0] },
    { op: 'mkdir', path: '/run/atelier', mode: 0o711, owner: [0, 0] },
    { op: 'chmodIfRootOwned', path: '/run/atelier', mode: 0o711 },
    { op: 'mkdir', path: '/run/atelier/dev', mode: 0o710, owner: [0, 1000] },
    { op: 'chown', path: '/run/atelier/dev', uid: 0, gid: 1000 },
    { op: 'mkdir', path: '/run/atelier/session', mode: 0o700, owner: [1000, 1000], reclaim: true },
    { op: 'openDir', path: '/work/.atelier', as: 'dirfd' },
    { op: 'unlink', path: '/run/atelier/host-ready' },
    { op: 'chownIf', path: '/work/lost+found', ifOwner: [0, 0], uid: 1000, gid: 1000, missingOk: true },
    { op: 'mkdirIfMissing', path: '/work/apps', mode: 0o755, uid: 1000, gid: 1000 },
    { op: 'chown', path: '/work', uid: 1000, gid: 1000 },
    { op: 'mkdir', path: '/tmp/tmux-1000', mode: 0o700, owner: [1000, 1000] },
    { op: 'chown', path: '/tmp/tmux-1000', uid: 1000, gid: 1000 },
    { op: 'mkdir', path: '/tmp/.X11-unix', mode: 0o1777, owner: [0, 0] },
    { op: 'unlink', path: '/run/atelier/bootstrap.token' },
    { op: 'write', path: '/run/atelier/bootstrap.token', data: 'B', mode: 0o400 },
    { op: 'unlink', path: '/run/atelier/dev.token' },
    { op: 'write', path: '/run/atelier/dev.token', data: 'D', mode: 0o400 },
    { op: 'unlink', path: '/run/atelier/session/dev.token' },
    { op: 'write', path: '/run/atelier/session/dev.token', data: 'D', mode: 0o400 },
    { op: 'chown', path: '/run/atelier/session/dev.token', uid: 1000, gid: 1000 },
    { op: 'chown', path: '/run/atelier/session', uid: 1000, gid: 1000 },
    { op: 'umask', mode: 0o077 },
  ])
  // no chmod after a chown anywhere: the one chmod op is the root-owned $run mount root, before every chown; every mkdir carries its final mode; the bootstrap write is absent without a secret
  assert.equal(plan.some((s) => s.op === 'chmod'), false)
  assert.equal(plan.findIndex((s) => s.op === 'chmodIfRootOwned'), plan.findIndex((s) => s.op === 'mkdir' && s.path === '/run/atelier') + 1)
  assert.ok(plan.findIndex((s) => s.op === 'chmodIfRootOwned') < plan.findIndex((s) => s.op === 'chown'))
  // the /work round trip brackets the markers: taken back (iff the agent's) before the first mkdir, handed over after /work/apps
  assert.equal(plan.findIndex((s) => s.op === 'chownIf' && s.path === '/work'), 1)
  assert.ok(plan.findIndex((s) => s.op === 'chown' && s.path === '/work') > plan.findIndex((s) => s.op === 'mkdirIfMissing' && s.path === '/work/apps'))
  assert.ok(plan.filter((s) => s.op === 'mkdir').every((s) => typeof s.mode === 'number'))
  assert.equal(bootPlan(CFG, { devToken: 'D' }).some((s) => s.path === '/run/atelier/bootstrap.token' && s.op === 'write'), false)
})

test('runPlan on a fresh volume: order, chown-iff-0:0, populate-then-chown, modes at creation', () => {
  const state = { fs: { '/work': { uid: 0, gid: 0, mode: 0o755, type: 'dir' }, '/work/lost+found': { uid: 0, gid: 0, mode: 0o700, type: 'dir' } } }
  const os = memory(state), io = fakeIo(state), logs = []
  const r = runPlan(bootPlan(CFG, { bootstrap: 'B', devToken: 'D' }), { os, io, log: (l) => logs.push(l) })
  assert.equal(r.failed, undefined)
  assert.equal(r.dirfd, 3)
  const ops = state.calls.map((c) => c[0])
  // umask 0 brackets every creation; 077 closes the plan
  assert.deepEqual(state.calls[0], ['umask', 0]); assert.deepEqual(state.calls.at(-1), ['umask', 0o077])
  // every marker mkdir precedes every chown
  const firstChown = ops.indexOf('chown'), lastMarker = state.calls.findLastIndex((c) => c[0] === 'mkdir' && c[1].startsWith('/work/.atelier'))
  assert.ok(lastMarker < firstChown, 'markers before any chown')
  // the dirfd opens before lost+found / the /work chown
  assert.ok(ops.indexOf('openDir') < state.calls.findIndex((c) => c[0] === 'chown' && c[1] === '/work/lost+found'))
  // lost+found before /work; /work/apps created (and chowned) before the /work chown
  const at = (op, p) => state.calls.findIndex((c) => c[0] === op && c[1] === p)
  assert.ok(at('chown', '/work/lost+found') < at('chown', '/work'))
  assert.ok(at('mkdir', '/work/apps') < at('chown', '/work/apps') && at('chown', '/work/apps') < at('chown', '/work'))
  // /work was 0:0 → chowned; lost+found was 0:0 → chowned
  assert.deepEqual([state.fs['/work'].uid, state.fs['/work'].gid], [1000, 1000])
  assert.deepEqual([state.fs['/work/lost+found'].uid, state.fs['/work/lost+found'].gid], [1000, 1000])
  // tmux dir: mkdir 0700 then chown, never chmod; X11: 1777 root, no chown
  assert.ok(at('mkdir', '/tmp/tmux-1000') < at('chown', '/tmp/tmux-1000'))
  assert.equal(ops.includes('chmod'), false)
  assert.deepEqual(state.fs['/tmp/tmux-1000'], { uid: 1000, gid: 1000, mode: 0o700, type: 'dir' })
  assert.deepEqual(state.fs['/tmp/.X11-unix'], { uid: 0, gid: 0, mode: 0o1777, type: 'dir' })
  // tokens: 0400, root copies stay root; the session copy is chowned, then the dir — after the write
  assert.deepEqual(state.fs['/run/atelier/bootstrap.token'], { uid: 0, gid: 0, mode: 0o400, type: 'file', data: 'B' })
  assert.deepEqual(state.fs['/run/atelier/dev.token'], { uid: 0, gid: 0, mode: 0o400, type: 'file', data: 'D' })
  assert.deepEqual(state.fs['/run/atelier/session/dev.token'], { uid: 1000, gid: 1000, mode: 0o400, type: 'file', data: 'D' })
  assert.ok(at('write', '/run/atelier/session/dev.token') < at('chown', '/run/atelier/session/dev.token'))
  assert.ok(at('chown', '/run/atelier/session/dev.token') < at('chown', '/run/atelier/session'))
  assert.deepEqual(state.fs['/run/atelier/session'], { uid: 1000, gid: 1000, mode: 0o700, type: 'dir' })
  assert.deepEqual(state.fs['/run/atelier/dev'], { uid: 0, gid: 1000, mode: 0o710, type: 'dir' })
  assert.deepEqual(state.fs['/run/atelier'], { uid: 0, gid: 0, mode: 0o711, type: 'dir' })
  for (const p of ['/work/.atelier/data', '/work/.atelier/last-good', '/work/.atelier/scratch']) assert.deepEqual(state.fs[p], { uid: 0, gid: 0, mode: 0o711, type: 'dir' })
  assert.deepEqual(state.fs['/work/.atelier'], { uid: 0, gid: 0, mode: 0o711, type: 'dir' })
  // the previous life's sentinel is unlinked before anything is spawned
  assert.ok(ops.includes('unlink'))
  assert.match(logs[1], /^chownIf \/work 0:0: ok \(already 0:0 — untouched\)$/)   // fresh: root's already, nothing taken back
  assert.match(logs[2], /^mkdir \/work\/.atelier 0711: ok$/)
  assert.match(logs.find((l) => l.startsWith('chown /work 1000:1000')), /: ok$/)
})

test('runPlan on a migrated volume: /work 1000:1000 untouched, existing markers audited, session dir reclaimed', () => {
  const state = { fs: {
    '/work': { uid: 1000, gid: 1000, mode: 0o2775, type: 'dir' },
    '/work/apps': { uid: 1000, gid: 1000, mode: 0o755, type: 'dir' },
    '/work/.atelier': { uid: 0, gid: 0, mode: 0o711, type: 'dir' },
    '/work/.atelier/data': { uid: 1000, gid: 1000, mode: 0o711, type: 'dir' },   // wrong owner: logged, left
    '/run/atelier': { uid: 0, gid: 0, mode: 0o711, type: 'dir' },
    '/run/atelier/session': { uid: 1000, gid: 1000, mode: 0o700, type: 'dir' },  // the previous container life
    '/run/atelier/session/dev.token': { uid: 1000, gid: 1000, mode: 0o400, type: 'file', data: 'old' },
    '/run/atelier/host-ready': { uid: 0, gid: 0, mode: 0o644, type: 'file' },
  } }
  const os = memory(state), io = fakeIo(state), logs = []
  const r = runPlan(bootPlan(CFG, { devToken: 'NEW' }), { os, io, log: (l) => logs.push(l) })
  assert.equal(r.failed, undefined)
  // the round trip: taken back before the markers (EEXIST-audited here), handed to the agent after /work/apps — the volume ends as it came
  const rt = (uid) => state.calls.findIndex((c) => c[0] === 'chown' && c[1] === '/work' && c[2] === uid)
  assert.ok(rt(0) >= 0 && rt(0) < state.calls.findIndex((c) => c[0] === 'mkdir') && rt(1000) > rt(0))
  assert.deepEqual(state.fs['/work'], { uid: 1000, gid: 1000, mode: 0o2775, type: 'dir' }, '2775 kept: chown touches no mode')
  assert.equal(state.calls.some((c) => c[0] === 'mkdir' && c[1] === '/work/apps'), false)
  assert.match(logs.find((l) => l.startsWith('chownIf /work ')), /1000:1000 → 0:0/)
  assert.match(logs.find((l) => l.startsWith('chownIf /work/lost\\+found') || l.startsWith('chownIf /work/lost+found')), /absent/)
  assert.match(logs.find((l) => l.startsWith('mkdir /work/.atelier/data')), /exists 1000:1000 0711 — wrong \(want 0:0 0711\), left/)
  assert.deepEqual([state.fs['/work/.atelier/data'].uid, state.fs['/work/.atelier/data'].gid], [1000, 1000], 'left, not repaired')
  // the session dir: reclaimed 0:0 → old token unlinked → new token written → chowned back
  const at = (op, p) => state.calls.findIndex((c) => c[0] === op && c[1] === p)
  const reclaim = state.calls.findIndex((c) => c[0] === 'chown' && c[1] === '/run/atelier/session' && c[2] === 0)
  assert.ok(reclaim >= 0 && reclaim < at('unlink', '/run/atelier/session/dev.token'))
  assert.ok(at('unlink', '/run/atelier/session/dev.token') < at('write', '/run/atelier/session/dev.token'))
  assert.deepEqual(state.fs['/run/atelier/session/dev.token'], { uid: 1000, gid: 1000, mode: 0o400, type: 'file', data: 'NEW' })
  assert.deepEqual([state.fs['/run/atelier/session'].uid, state.fs['/run/atelier/session'].gid], [1000, 1000])
  assert.equal(state.fs['/run/atelier/host-ready'], undefined, 'stale sentinel unlinked')
})

test('runPlan on a MIGRATED volume without .atelier — the first step-5 boot (review 2026-08-30): root without DAC_OVERRIDE is "other" on the 1000-owned /work, so the plan takes /work back for the markers and hands it to the agent again', () => {
  const migrated = () => ({ fs: {
    '/work': { uid: 1000, gid: 1000, mode: 0o2775, type: 'dir' },           // the per-conversation recipe: chown -R 1000:1000, g+ws
    '/work/apps': { uid: 1000, gid: 1000, mode: 0o755, type: 'dir' },
    '/work/lost+found': { uid: 1000, gid: 1000, mode: 0o700, type: 'dir' },
  } })
  const plan = bootPlan(CFG, { bootstrap: 'B', devToken: 'D' })
  // the model bites: the plan MINUS its reclaim step dies at the first marker with the errno D0 row c measured
  const s0 = migrated(); const os0 = memory(s0), io0 = fakeIo(s0); withDac(os0, io0, s0)
  const r0 = runPlan(plan.filter((s) => !(s.op === 'chownIf' && s.path === '/work')), { os: os0, io: io0, log: () => {} })
  assert.equal(r0.failed?.step.path, '/work/.atelier'); assert.equal(r0.failed?.error.code, 'EACCES')
  // the plan as shipped
  const s = migrated(); const os = memory(s), io = fakeIo(s); withDac(os, io, s); const logs = []
  const r = runPlan(plan, { os, io, log: (l) => logs.push(l) })
  assert.equal(r.failed, undefined, logs.join('\n'))
  assert.equal(r.dirfd, 3)
  const at = (op, p, uid) => s.calls.findIndex((c) => c[0] === op && c[1] === p && (uid === undefined || c[2] === uid))
  assert.ok(at('chown', '/work', 0) >= 0 && at('chown', '/work', 0) < at('mkdir', '/work/.atelier'), 'taken back before the first marker')
  assert.ok(at('mkdir', '/work/.atelier/scratch') < at('chown', '/work', 1000), 'handed over after the markers')
  assert.ok(at('openDir', '/work/.atelier') < at('chown', '/work', 1000))
  assert.ok(at('chown', '/work', 1000) < s.calls.findIndex((c) => c[0] === 'spawn' || c[0] === 'write'), 'the agent owns /work again before any token is written')
  assert.deepEqual(s.fs['/work'], { uid: 1000, gid: 1000, mode: 0o2775, type: 'dir' })
  for (const p of ['/work/.atelier', '/work/.atelier/data', '/work/.atelier/last-good', '/work/.atelier/scratch']) assert.deepEqual(s.fs[p], { uid: 0, gid: 0, mode: 0o711, type: 'dir' })
  assert.deepEqual(s.fs['/work/lost+found'], { uid: 1000, gid: 1000, mode: 0o700, type: 'dir' }, 'already the agent\'s: untouched')
  assert.equal(s.calls.some((c) => c[0] === 'mkdir' && c[1] === '/work/apps'), false)
  assert.match(logs[1], /^chownIf \/work 0:0: ok \(1000:1000 → 0:0\)$/)
  assert.equal(logs.filter((l) => l.includes('FAILED')).length, 0)
  // the fresh volume under the same model still passes (root owns it: the owner bits)
  const f = { fs: { '/work': { uid: 0, gid: 0, mode: 0o755, type: 'dir' } } }; const osf = memory(f), iof = fakeIo(f); withDac(osf, iof, f)
  assert.equal(runPlan(plan, { os: osf, io: iof, log: () => {} }).failed, undefined)
  assert.deepEqual([f.fs['/work'].uid, f.fs['/work'].gid], [1000, 1000])
})

test('runPlan: the $run tmpfs mount root arrives 0:0 1777 → chmodded 0711 before any token or spawn; a non-root $run is left and logged', () => {
  const state = { fs: { '/work': { uid: 0, gid: 0, mode: 0o755, type: 'dir' }, '/run/atelier': { uid: 0, gid: 0, mode: 0o1777, type: 'dir' } } }
  const os = memory(state), io = fakeIo(state), logs = []
  const r = runPlan(bootPlan(CFG, { devToken: 'D' }), { os, io, log: (l) => logs.push(l) })
  assert.equal(r.failed, undefined)
  assert.deepEqual(state.calls.filter((c) => c[0] === 'chmod'), [['chmod', '/run/atelier', 0o711]])
  assert.equal(state.fs['/run/atelier'].mode, 0o711)
  const at = (op, p) => state.calls.findIndex((c) => c[0] === op && c[1] === p)
  assert.ok(at('chmod', '/run/atelier') < at('write', '/run/atelier/dev.token') && at('chmod', '/run/atelier') < state.calls.findIndex((c) => c[0] === 'chown'))
  assert.match(logs.find((l) => l.startsWith('chmodIfRootOwned /run/atelier')), /1777 → 0711/)
  const state2 = { fs: { '/work': { uid: 0, gid: 0, mode: 0o755, type: 'dir' }, '/run/atelier': { uid: 1000, gid: 1000, mode: 0o1777, type: 'dir' } } }
  const logs2 = []
  runPlan(bootPlan(CFG, { devToken: 'D' }), { os: memory(state2), io: fakeIo(state2), log: (l) => logs2.push(l) })
  assert.equal(state2.calls.some((c) => c[0] === 'chmod'), false)
  assert.match(logs2.find((l) => l.startsWith('chmodIfRootOwned /run/atelier')), /1000:1000 1777 — not root-owned, left/)
})

test('runPlan: a failing step stops the plan and is reported; the launcher exits 2 before any spawn', () => {
  const state = { fs: { '/work': { uid: 0, gid: 0, mode: 0o755, type: 'dir' } } }   // a pod always has /work mounted; a missing one is a fault of its own (step 0's lstat)
  const os = memory(state), io = fakeIo(state)
  os.mkdir = (p, mode) => { if (p === '/run/atelier') { const e = new Error('EROFS'); e.code = 'EROFS'; throw e } state.fs[p] = { uid: 0, gid: 0, mode, type: 'dir' }; state.calls.push(['mkdir', p, mode]) }
  const logs = []
  const r = runPlan(bootPlan(CFG, { devToken: 'D' }), { os, io, log: (l) => logs.push(l) })
  assert.equal(r.failed.step.path, '/run/atelier'); assert.equal(r.failed.error.code, 'EROFS')
  assert.match(logs.at(-1), /^mkdir \/run\/atelier 0711: FAILED EROFS/)
  assert.equal(state.calls.some((c) => c[0] === 'spawn'), false)
  let code = null
  const l = createLauncher({ os, io, env: {}, log: () => {}, clock: { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} }, exit: (c) => { code = c }, signals: { on() {} } })
  l.boot()
  assert.equal(code, 2)
  assert.equal(state.spawned.length, 0)
})

test('env rows: H has no secret and no CHANNEL_*; S keeps the supervisor contract minus ATELIER_*; X is PATH only', () => {
  const H = hostEnv(POD_ENV, config(POD_ENV))
  for (const k of SECRETS) assert.equal(k in H, false, `${k} not in H`)
  for (const k of NEVER_BELOW) assert.equal(k in POD_ENV, true, `${k} staged in POD_ENV so the drop is exercised`)
  assert.equal(Object.keys(H).some((k) => k.startsWith('CHANNEL_')), false)
  assert.deepEqual(H, {
    PATH: POD_ENV.PATH, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'xterm-256color', ATELIER_GRACE_S: '40',
    ATELIER_DIRFD: '3', ATELIER_RUN: '/run/atelier', ATELIER_WORK: '/work', ATELIER_CONTROL: '/control',
    ATELIER_SPINE_URL: 'http://spine:7331', HOME: '/root', NODE_ENV: 'production',
  })
  const S = sessionEnv(POD_ENV)
  assert.equal('ATELIER_BOOTSTRAP' in S, false); assert.equal('ATELIER_GRACE_S' in S, false); assert.equal('KUBERNETES_SERVICE_HOST' in S, false)
  assert.deepEqual(S, {
    PATH: POD_ENV.PATH, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'xterm-256color', CHAT_ID: 'c1', PERSONA: 'bayard', PERSONA_TEXT: 'You are…', STORY_TEXT: 'story',
    CHANNEL_URL: 'http://spine:7331', CHANNEL_TOKEN: 'chan-secret', CHANNEL_CHAT: 'c1', ANTHROPIC_MODEL: 'claude-x', ANTHROPIC_API_KEY: 'sk-ant-secret', CLAUDE_MODEL: 'claude-y',
    DISABLE_AUTOUPDATER: '1', OPENAI_VOICE_TOKEN: 'voice-secret', HORSE_BROWSER_BIN: '/usr/local/bin/chrome-egress', HORSE_BROWSER_UNATTENDED: '1', FLEET_EGRESS: 'http://exit', FLEET_EGRESS_TZ: 'Europe/Berlin',
    PIP_USER: '1', NPM_CONFIG_PREFIX: '/work/.npm-global', HOME: '/work',
  })
  assert.deepEqual(helperEnv(POD_ENV), { PATH: POD_ENV.PATH })
  // the leaf PEMs reach no row: not H (despite ATELIER_* in HOST_KEEP), not S, not X
  for (const k of ['ATELIER_HOST_TLS_CERT', 'ATELIER_HOST_TLS_KEY', 'ATELIER_HOST_TLS_CA']) {
    assert.equal(k in H, false, `${k} not in H`); assert.equal(k in S, false, `${k} not in S`)
  }
  // scrub never spreads: a key not in the list is absent; a NEVER_BELOW key is absent even when named or prefix-matched
  assert.deepEqual(scrub({ A: '1', B: '2', ATELIER_BOOTSTRAP: 'x' }, ['A', 'ATELIER_BOOTSTRAP']), { A: '1' })
  assert.deepEqual(scrub({ ATELIER_HOST_TLS: '/run/atelier/tls/cert.pem,…', ATELIER_HOST_TLS_KEY: 'pem' }, ['ATELIER_*', 'ATELIER_HOST_TLS_KEY']), { ATELIER_HOST_TLS: '/run/atelier/tls/cert.pem,…' })
  assert.deepEqual(scrub({ FOO_X: '1', FOO_Y: '2', BAR: '3' }, ['FOO_*']), { FOO_X: '1', FOO_Y: '2' })
})

test('boot: spawn rows H and S are exact — argv, uid/gid/groups, umask, cwd, stdio (fd 3 = dirfd), env', () => {
  const state = { fs: { '/work': { uid: 0, gid: 0, mode: 0o755, type: 'dir' } } }
  const os = memory(state), io = fakeIo(state)
  const l = createLauncher({ os, io, env: POD_ENV, log: () => {}, clock: { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} }, exit: () => {}, signals: { on() {} },
    hostArgv: ['node', '/app/host/index.mjs'], sessionArgv: ['node', '/app/session-supervisor.mjs'], devToken: 'D' })
  l.boot()
  assert.equal(state.spawned.length, 2)
  const [host, sup] = state.spawned
  assert.deepEqual(host.spec, { argv: ['node', '/app/host/index.mjs'], env: hostEnv(POD_ENV, config(POD_ENV)), cwd: '/', umask: 0o077, stdio: ['ignore', 'inherit', 'inherit', 3] })
  assert.deepEqual(host.argv, ['sh', '-c', 'umask 77; exec "$@"', 'sh', 'node', '/app/host/index.mjs'])
  assert.deepEqual(sup.spec, { argv: ['node', '/app/session-supervisor.mjs'], env: sessionEnv(POD_ENV), cwd: '/work', uid: AGENT.uid, gid: AGENT.gid, groups: [AGENT_DATA_GID], umask: 0o022, stdio: ['ignore', 'inherit', 'inherit'] })
  assert.deepEqual(sup.argv, ['sh', '-c', 'umask 22; exec "$@"', 'sh', 'setpriv', '--reuid=1000', '--regid=1000', '--groups=19999', '--', 'node', '/app/session-supervisor.mjs'])
  // the plan ran to completion before the first spawn; the dev token reached both files
  const firstSpawn = state.calls.findIndex((c) => c[0] === 'spawn')
  assert.equal(state.calls[firstSpawn - 1][0], 'umask')
  assert.equal(state.fs['/run/atelier/dev.token'].data, 'D'); assert.equal(state.fs['/run/atelier/session/dev.token'].data, 'D')
})

test('a minted dev token is 32 random bytes as hex', () => {
  const state = { fs: { '/work': { uid: 0, gid: 0, mode: 0o755, type: 'dir' } } }
  const os = memory(state), io = fakeIo(state)
  createLauncher({ os, io, env: {}, log: () => {}, clock: { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} }, exit: () => {}, signals: { on() {} } }).boot()
  assert.match(state.fs['/run/atelier/dev.token'].data, /^[0-9a-f]{64}$/)
  assert.equal(state.fs['/run/atelier/bootstrap.token'], undefined, 'no ATELIER_BOOTSTRAP → no bootstrap.token')
})

test('crashLine is one JSON object per line with at/code/signal/exits', () => {
  assert.equal(crashLine({ at: 1700000000000, code: 1, signal: null, exits: 3 }), '{"at":1700000000000,"code":1,"signal":null,"exits":3}')
})
