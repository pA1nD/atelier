// Pure-function characterization of the discovery + config grammar exported
// from discovery.js. Locks the config-filter semantics: allow/deny/mixed,
// workspace blocks, additive paths, and the flat-array-only `modules` shape
// (the dev/prod split was removed in the carve-back). No server boot.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  RESERVED_NAMES, GLOBAL_WORKSPACE,
  isSpecialDir, isWorkspaceDir, workspaceName, isPathEntry, resolvePathEntry,
  loadConfig, loadModuleConfig, shouldIncludeModule, collectConfigPaths, CONFIG_FILENAME,
} from '../discovery.js'

const mod = (id, ws = GLOBAL_WORKSPACE) => ({ id, workspace: ws })

// Write `obj` as the config in a temp dir and hand the dir to `fn`.
function withConfig(obj, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-cfg-'))
  try {
    fs.writeFileSync(path.join(dir, CONFIG_FILENAME), JSON.stringify(obj))
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('reserved names + GLOBAL_WORKSPACE', () => {
  for (const n of ['atelier', 'api', 'assets', 'modules', 'global']) assert.ok(RESERVED_NAMES.has(n))
  assert.equal(GLOBAL_WORKSPACE, 'global')
})

test('isWorkspaceDir / workspaceName', () => {
  assert.equal(isWorkspaceDir('$team'), true)
  assert.equal(isWorkspaceDir('$global'), false)   // reserved
  assert.equal(isWorkspaceDir('team'), false)      // no $
  assert.equal(isWorkspaceDir('$bad+name'), false) // invalid char
  assert.equal(isWorkspaceDir('$'), false)
  assert.equal(workspaceName('$team'), 'team')
  assert.equal(workspaceName('team'), null)
})

test('isSpecialDir hides _/./-/$ prefixes', () => {
  assert.equal(isSpecialDir('_archive'), true)
  assert.equal(isSpecialDir('.git'), true)
  assert.equal(isSpecialDir('-scratch'), true)
  assert.equal(isSpecialDir('$team'), true)
  assert.equal(isSpecialDir('kanban'), false)
})

test('isPathEntry discriminates paths from names', () => {
  for (const p of ['./x', '../x', '~/x', '/abs/x']) assert.equal(isPathEntry(p), true)
  assert.equal(isPathEntry({ path: './y' }), true)
  assert.equal(isPathEntry('kanban'), false)
  assert.equal(isPathEntry({ workspace: 'w' }), false)
})

test('resolvePathEntry resolves ~ and relative', () => {
  assert.equal(resolvePathEntry('/abs/x', '/base'), path.normalize('/abs/x'))
  assert.equal(resolvePathEntry('./x', '/base'), path.normalize('/base/x'))
  if (process.env.HOME) assert.equal(resolvePathEntry('~/x', '/base'), path.join(process.env.HOME, 'x'))
})

test('loadConfig: {} for missing file, raw object otherwise', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-noc-'))
  try { assert.deepEqual(loadConfig(empty), {}) } finally { fs.rmSync(empty, { recursive: true, force: true }) }
  withConfig({ label: 'studio', port: 1899 }, (dir) => {
    const c = loadConfig(dir)
    assert.equal(c.label, 'studio')
    assert.equal(c.port, 1899)
  })
})

test('allow mode: only listed globals run', () => {
  withConfig({ modules: ['alpha'] }, (dir) => {
    const f = loadModuleConfig(dir)
    assert.equal(shouldIncludeModule(f, mod('alpha')), true)
    assert.equal(shouldIncludeModule(f, mod('beta')), false)
  })
})

test('deny mode: everything except listed', () => {
  withConfig({ modules: ['!alpha'] }, (dir) => {
    const f = loadModuleConfig(dir)
    assert.equal(shouldIncludeModule(f, mod('alpha')), false)
    assert.equal(shouldIncludeModule(f, mod('beta')), true)
  })
})

test('mixing allow + deny → no filter applied (all run)', () => {
  withConfig({ modules: ['alpha', '!beta'] }, (dir) => {
    const f = loadModuleConfig(dir)
    assert.equal(shouldIncludeModule(f, mod('alpha')), true)
    assert.equal(shouldIncludeModule(f, mod('beta')), true)
  })
})

test('workspace allow excludes unlisted globals, includes the ws', () => {
  withConfig({ modules: [{ workspace: 'team' }] }, (dir) => {
    const f = loadModuleConfig(dir)
    assert.equal(shouldIncludeModule(f, mod('alpha')), false)
    assert.equal(shouldIncludeModule(f, mod('gamma', 'team')), true)
  })
})

test('workspace deny excludes the ws, keeps globals', () => {
  withConfig({ modules: [{ workspace: '!team' }] }, (dir) => {
    const f = loadModuleConfig(dir)
    assert.equal(shouldIncludeModule(f, mod('alpha')), true)
    assert.equal(shouldIncludeModule(f, mod('gamma', 'team')), false)
  })
})

test('path entries are additive + neutral (no mode set)', () => {
  withConfig({ modules: ['./ext-mod'] }, (dir) => {
    const f = loadModuleConfig(dir)
    assert.equal(shouldIncludeModule(f, mod('alpha')), true)   // path-only → all globals run
    const paths = collectConfigPaths(f)
    assert.equal(paths.length, 1)
    assert.equal(paths[0].path, './ext-mod')
    assert.equal(paths[0].workspace, 'global')
  })
})

test('legacy { dev, prod } object is rejected → no filter (everything runs)', () => {
  withConfig({ modules: { dev: ['alpha'], prod: ['beta'] } }, (dir) => {
    const f = loadModuleConfig(dir)
    assert.equal(f, null)
    assert.equal(shouldIncludeModule(f, mod('alpha')), true)
    assert.equal(shouldIncludeModule(f, mod('beta')), true)
  })
})
