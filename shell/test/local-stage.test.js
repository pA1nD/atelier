// shell/local/stage.mjs — the symlink tree under <root>/.atelier/local/<ws>/apps (DESIGN §5.3 step 4)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stage, workOf, orderWorkspaces } from '../local/stage.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shell-stage-'))
const dir = (root, rel) => { const d = path.join(root, rel); fs.mkdirSync(d, { recursive: true }); return d }

test('orderWorkspaces: global first (host 0), then alphabetical', () => {
  assert.deepEqual(orderWorkspaces(['zeta', 'team', 'global', 'team']), ['global', 'team', 'zeta'])
})

test('stage: one apps dir per workspace, links to the module folders, stale links removed, real folders left', () => {
  const root = tmp()
  const alpha = dir(root, 'alpha'), beta = dir(root, '$team/beta'), gamma = dir(root, 'gamma')
  const log = []
  let s = stage(root, [{ workspace: 'team', id: 'beta', dir: beta }, { workspace: 'global', id: 'alpha', dir: alpha }, { workspace: 'global', id: 'gamma', dir: gamma }], { log: (l) => log.push(l) })
  assert.deepEqual(s.workspaces.map((w) => [w.id, w.work]), [['global', workOf(root, 'global')], ['team', workOf(root, 'team')]])
  assert.deepEqual(s.workspaces[0].apps.map((a) => a.id), ['alpha', 'gamma'])
  const link = path.join(workOf(root, 'global'), 'apps', 'alpha')
  assert.equal(fs.readlinkSync(link), alpha)
  assert.equal(fs.readlinkSync(path.join(workOf(root, 'team'), 'apps', 'beta')), beta)
  // a real folder someone put into apps/ is never removed; a stale link is; an unchanged link is kept (same inode)
  const real = dir(root, '.atelier/local/global/apps/manual')
  const ino = fs.lstatSync(link).ino
  s = stage(root, [{ workspace: 'global', id: 'alpha', dir: alpha }], { log: (l) => log.push(l) })
  assert.equal(fs.lstatSync(link).ino, ino)
  assert.equal(fs.existsSync(path.join(workOf(root, 'global'), 'apps', 'gamma')), false)
  assert.ok(fs.statSync(real).isDirectory())
  assert.ok(log.some((l) => /unlinked stale .*gamma/.test(l)))
  assert.ok(log.some((l) => /manual is not a link — left in place/.test(l)))
  // a link whose target moved is re-pointed; a real folder in the way of a wanted id is reported, not replaced
  const alpha2 = dir(root, 'elsewhere/alpha')
  s = stage(root, [{ workspace: 'global', id: 'alpha', dir: alpha2 }, { workspace: 'global', id: 'manual', dir: alpha, qid: 'global/manual' }], { log: (l) => log.push(l) })
  assert.equal(fs.readlinkSync(link), alpha2)
  assert.deepEqual(s.workspaces[0].apps.map((a) => a.id), ['alpha'])
  assert.ok(log.some((l) => /'global\/manual' is not staged/.test(l)))
  assert.ok(fs.statSync(real).isDirectory())
  fs.rmSync(root, { recursive: true, force: true })
})
