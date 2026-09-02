// host/devcli.mjs — the `atelier` verbs: argv parsing, the ONE verdict line per outcome (MESSAGES.verdict, byte for
// byte), the step lines, the exit codes 0/2/3 (1 usage/transport), and a real run against a dev shell rig: the
// stream's step lines to stderr as they arrive, the verdict to stdout.
import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { unprivileged } from '../adapters/os.mjs'
import { createAuth } from '../protocol/auth.mjs'
import { createDevShell } from '../protocol/devshell.mjs'
import { parseArgs, verdictLine, exitCode, stepLine, abortLine, main, EXIT, USAGE } from '../devcli.mjs'
import { MESSAGES } from '../supervisor/deploy.mjs'
import { fakeRegistrar, fakeSupervisor, fakeCollector, tmp } from './protocol-fixtures.mjs'

test('parseArgs: the five verbs, -m required for deploy, --no-backup, rollback needs 7–40 hex, restore one id, bad slugs refused', () => {
  assert.deepEqual(parseArgs(['deploy', 'todo', '-m', 'first release']), { verb: 'deploy', slug: 'todo', noBackup: false, message: 'first release' })
  assert.deepEqual(parseArgs(['deploy', 'todo', '--no-backup', '--message=x']), { verb: 'deploy', slug: 'todo', noBackup: true, message: 'x' })
  assert.match(parseArgs(['deploy', 'todo']).error, /needs -m/)
  assert.match(parseArgs(['deploy', 'todo', '-m', '']).error, /needs -m/)
  assert.match(parseArgs(['deploy', 'todo', '-m', 'x', '--force']).error, /unknown argument/)
  assert.deepEqual(parseArgs(['rollback', 'todo', '0F3C9A1B2D4E']), { verb: 'rollback', slug: 'todo', noBackup: false, commit: '0f3c9a1b2d4e' })
  assert.match(parseArgs(['rollback', 'todo', 'abc']).error, /7–40 hex/)
  assert.match(parseArgs(['rollback', 'todo']).error, /7–40 hex/)
  assert.deepEqual(parseArgs(['restore', 'todo', '20260902T104702Z-rev3-0f3c9a1b2d4e']), { verb: 'restore', slug: 'todo', noBackup: false, backup: '20260902T104702Z-rev3-0f3c9a1b2d4e', yes: false })
  assert.deepEqual(parseArgs(['restore', 'todo', '20260902T104702Z-rev3-0f3c9a1b2d4e', '--yes']), { verb: 'restore', slug: 'todo', noBackup: false, backup: '20260902T104702Z-rev3-0f3c9a1b2d4e', yes: true })
  assert.deepEqual(parseArgs(['restore', 'todo', '--yes', '20260902T104702Z-rev3-0f3c9a1b2d4e']).yes, true)
  assert.match(parseArgs(['restore', 'todo', '20260902T104702Z-rev3-0f3c9a1b2d4e', '--force']).error, /unknown argument '--force'/)
  assert.match(parseArgs(['restore', 'todo', '../x']).error, /one <backup-id>/)
  assert.match(parseArgs(['restore', 'todo', '--yes']).error, /one <backup-id>/)
  assert.deepEqual(parseArgs(['releases', 'todo']), { verb: 'releases', slug: 'todo', noBackup: false })
  assert.match(parseArgs(['backups', 'todo', 'extra']).error, /unexpected/)
  assert.match(parseArgs(['Deploy', 'todo']).error, /unknown verb/)
  assert.match(parseArgs(['deploy', 'Shopping List']).error, /bad slug/)
  assert.match(parseArgs([]).error, /unknown verb/)
  assert.equal(USAGE, MESSAGES.usage)
})

test('the verdict lines are MESSAGES.verdict byte for byte; exit 0 green / 2 red / 3 failed; the step lines; the abort line', () => {
  const url = 'https://demo.portal.pa1nd.de/demo/e2e-104512'
  const green = { t: 'verdict', outcome: 'green', kind: 'deploy', slug: 'e2e-104512', rev: 4, commit: '7a1d0c9e5b6f0000000000000000000000000000', url }
  assert.equal(verdictLine(green), 'deploy green: e2e-104512 rev 4 commit 7a1d0c9e5b6f live — https://demo.portal.pa1nd.de/demo/e2e-104512')
  assert.equal(verdictLine({ ...green, kind: 'rollback', rev: 5, commit: '0f3c9a1b2d4e0000000000000000000000000000' }), 'rollback green: e2e-104512 rev 5 commit 0f3c9a1b2d4e live — https://demo.portal.pa1nd.de/demo/e2e-104512')
  const red = { t: 'verdict', outcome: 'red', kind: 'deploy', slug: 'e2e-104512', rev: 3, commit: '0f3c9a1b2d4e0000000000000000000000000000', step: 'hook', error: 'exit 1', url }
  assert.equal(verdictLine(red), 'deploy RED at hook: exit 1 — nothing deployed, e2e-104512 stays on rev 3 (0f3c9a1b2d4e)')
  assert.equal(verdictLine({ ...red, rev: 0, commit: null }), 'deploy RED at hook: exit 1 — nothing deployed, e2e-104512 stays on rev 0 (none)')
  const failed = { t: 'verdict', outcome: 'failed', kind: 'deploy', slug: 'e2e-104512', rev: 3, step: 'migrate', error: 'exit 2: table users has no column email', backup: '20260902T104702Z-rev3-0f3c9a1b2d4e', url }
  assert.equal(verdictLine(failed), 'deploy FAILED at migrate: exit 2: table users has no column email — e2e-104512 is DOWN, backup 20260902T104702Z-rev3-0f3c9a1b2d4e kept')
  assert.equal(verdictLine({ ...failed, backup: undefined, noBackup: true }), 'deploy FAILED at migrate: exit 2: table users has no column email — e2e-104512 is DOWN, no backup (--no-backup)')
  assert.equal(verdictLine({ t: 'verdict', outcome: 'green', kind: 'restore', slug: 'e2e-104512', rev: 3, backup: '20260902T104702Z-rev3-0f3c9a1b2d4e', url }), 'restore green: e2e-104512 rev 3 data from backup 20260902T104702Z-rev3-0f3c9a1b2d4e live — https://demo.portal.pa1nd.de/demo/e2e-104512')
  assert.equal(verdictLine({ t: 'verdict', outcome: 'failed', kind: 'restore', slug: 'e2e-104512', step: 'start', error: 'no READY within 8000 ms', backup: 'b1' }), 'restore FAILED at start: no READY within 8000 ms — e2e-104512 is DOWN, backup b1 kept')
  assert.equal(verdictLine({ t: 'verdict', outcome: 'red', kind: 'restore', slug: 'e2e-104512', step: 'snapshot', error: 'backup impossible: could not read the data dir (find: Permission denied)', backup: 'b1' }), 'restore RED at snapshot: backup impossible: could not read the data dir (find: Permission denied) — nothing restored, e2e-104512 unchanged, backup b1 untouched')
  assert.equal(exitCode({ outcome: 'red', kind: 'restore' }), EXIT.red)
  assert.deepEqual([green, red, failed].map(exitCode), [EXIT.green, EXIT.red, EXIT.failed]); assert.deepEqual(EXIT, { green: 0, usage: 1, red: 2, failed: 3 })
  assert.equal(stepLine({ t: 'step', name: 'copy', ms: 12, ok: true, note: '3 MB of prod data copied' }), '  copy ok 12 ms — 3 MB of prod data copied')
  assert.equal(stepLine({ t: 'step', name: 'probe', ms: 40, ok: true }), '  probe ok 40 ms')
  assert.equal(stepLine({ t: 'step', name: 'hook', ms: 200, ok: false, note: 'exit 1' }), '  hook FAILED 200 ms — exit 1')
  assert.equal(abortLine('todo', 'ECONNREFUSED'), 'deploy aborted: ECONNREFUSED — read atelier releases todo before running it again')
})

function sink() { const s = new PassThrough(); let text = ''; s.on('data', (c) => { text += c }); return { s, text: () => text } }

test('main() against a dev shell: the stream\'s step lines land on stderr as they arrive, the verdict on stdout, exit by outcome; usage 1; no token 1; the shell down → the abort line + 1', async () => {
  const dir = tmp()
  const registrar = fakeRegistrar({ company: 'acme', principal: { id: 'p-agent', name: 'Bayard' } })
  const rows = [{ instance: 'i-0123456789abcdef', slug: 'todo', company: 'acme', uid: 20001, rev: 3, state: 'live' }]
  const supervisor = fakeSupervisor({ rows })
  const auth = createAuth({ registrar, devToken: 'dev-secret' })
  const dev = createDevShell({ cfg: { nodeEnv: 'production' }, os: unprivileged(), supervisor, collector: fakeCollector(), registrar, auth, sockPath: null, devPort: 0 })
  const { port } = await dev.listen()
  const url = `http://127.0.0.1:${port}`
  try {
    let out = sink(), err = sink()
    let code = await main(['deploy', 'todo', '-m', 'first release'], { stdout: out.s, stderr: err.s, token: 'dev-secret', url })
    assert.equal(code, 0, err.text())
    assert.equal(out.text(), 'deploy green: todo rev 4 commit abcdef123456 live — http://127.0.0.1:1844/acme/todo\n')
    assert.equal(err.text(), '  commit ok 3 ms — abcdef123456 "x"\n  copy ok 1 ms\n')
    assert.deepEqual(supervisor.verbs.at(-1), { verb: 'deploy', instance: 'i-0123456789abcdef', message: 'first release', commit: null, noBackup: false, by: 'agent:p-agent' })
    out = sink(); err = sink()
    code = await main(['rollback', 'todo', '0f3c9a1b2d4e'], { stdout: out.s, stderr: err.s, token: 'dev-secret', url })
    assert.equal(code, 0, err.text()); assert.match(out.text(), /^rollback green: todo rev 4 commit 0f3c9a1b2d4e live/)
    rows[0].script = { t: 'verdict', outcome: 'red', kind: 'deploy', slug: 'todo', rev: 3, commit: 'c'.repeat(40), step: 'hook', error: 'exit 1' }
    out = sink(); err = sink()
    assert.equal(await main(['deploy', 'todo', '-m', 'x'], { stdout: out.s, stderr: err.s, token: 'dev-secret', url }), 2)
    assert.equal(out.text(), 'deploy RED at hook: exit 1 — nothing deployed, todo stays on rev 3 (cccccccccccc)\n')
    rows[0].script = { t: 'verdict', outcome: 'failed', kind: 'deploy', slug: 'todo', rev: 3, step: 'migrate', error: 'exit 2', backup: '20260902T104702Z-rev3-cccccccccccc' }
    out = sink(); err = sink()
    assert.equal(await main(['deploy', 'todo', '-m', 'x'], { stdout: out.s, stderr: err.s, token: 'dev-secret', url }), 3)
    assert.equal(out.text(), 'deploy FAILED at migrate: exit 2 — todo is DOWN, backup 20260902T104702Z-rev3-cccccccccccc kept\n')
    rows[0].script = null
    out = sink(); err = sink()
    assert.equal(await main(['restore', 'todo', '20260902T104702Z-rev3-cccccccccccc', '--yes'], { stdout: out.s, stderr: err.s, token: 'dev-secret', url }), 0)
    assert.equal(out.text(), 'restore green: todo rev 3 data from backup 20260902T104702Z-rev3-cccccccccccc live — http://127.0.0.1:1844/acme/todo\n')
    assert.deepEqual(supervisor.verbs.at(-1), { verb: 'restore', instance: 'i-0123456789abcdef', backup: '20260902T104702Z-rev3-cccccccccccc', yes: true, by: 'agent:p-agent' })
    // a LIVE app's restore without --yes: the fake refuses like the real supervisor (409 + the refusal) → the CLI prints it, exit 1
    out = sink(); err = sink()
    assert.equal(await main(['restore', 'todo', '20260902T104702Z-rev3-cccccccccccc'], { stdout: out.s, stderr: err.s, token: 'dev-secret', url }), 1)
    assert.equal(err.text(), `atelier: 409 ${MESSAGES.refuse.restoreLive('todo', '20260902T104702Z-rev3-cccccccccccc')}\n`)
    // the lists
    rows[0].releases = [{ id: 'r-1', kind: 'deploy', verdict: 'red', rev: 3, commit: '7a1d0c9e5b6f00', message: 'add the email column', at: '2026-09-02T10:47:02Z', by: 'agent:p-agent', error: 'rehearsal red at hook: exit 1' }]
    out = sink(); err = sink()
    assert.equal(await main(['releases', 'todo'], { stdout: out.s, stderr: err.s, token: 'dev-secret', url }), 0)
    assert.equal(out.text(), '2026-09-02T10:47:02Z  deploy   red    rev   3  7a1d0c9e5b6f  "add the email column"  rehearsal red at hook: exit 1\n')
    rows[0].backups = [{ id: '20260902T104702Z-rev3-0f3c9a1b2d4e', at: '2026-09-02T10:47:02Z', rev: 3, mb: 12 }]
    out = sink(); err = sink()
    assert.equal(await main(['backups', 'todo'], { stdout: out.s, stderr: err.s, token: 'dev-secret', url }), 0)
    assert.equal(out.text(), '20260902T104702Z-rev3-0f3c9a1b2d4e      12 MB  rev 3  2026-09-02T10:47:02Z\n')
    rows[0].backups = []; rows[0].releases = []
    out = sink(); err = sink()
    await main(['backups', 'todo'], { stdout: out.s, stderr: err.s, token: 'dev-secret', url })
    assert.equal(out.text(), 'todo: no backups (a backup is taken by every deploy that reaches the gate)\n')
    out = sink(); err = sink()
    await main(['releases', 'todo'], { stdout: out.s, stderr: err.s, token: 'dev-secret', url })
    assert.equal(out.text(), 'todo: no releases yet — atelier deploy todo -m "first release"\n')
    // refusals: unknown app 404 → 1; usage → 1 with the usage text; no token → 1; the shell unreachable → the abort line, 1
    out = sink(); err = sink()
    assert.equal(await main(['deploy', 'nope', '-m', 'x'], { stdout: out.s, stderr: err.s, token: 'dev-secret', url }), 1)
    assert.equal(err.text(), 'atelier: 404 unknown app\n')
    out = sink(); err = sink()
    assert.equal(await main(['deploy', 'todo'], { stdout: out.s, stderr: err.s, token: 'dev-secret', url }), 1)
    assert.ok(err.text().includes(MESSAGES.usage))
    out = sink(); err = sink()
    assert.equal(await main(['deploy', 'todo', '-m', 'x'], { stdout: out.s, stderr: err.s, token: null, url }), 1)
    assert.match(err.text(), /no dev token/)
    await dev.close()
    out = sink(); err = sink()
    assert.equal(await main(['deploy', 'todo', '-m', 'x'], { stdout: out.s, stderr: err.s, token: 'dev-secret', url }), 1)
    assert.match(err.text(), /^deploy aborted: ECONN[A-Z]+ .* — read atelier releases todo before running it again\n$/)
  } finally { try { await dev.close() } catch {} }
})
