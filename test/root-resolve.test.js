// Unit tests for resolveRoot — the instance-root resolver. Pure (no server
// spawn), so it can exercise the node_modules branch that an integration test
// can't reach without physically relocating server.js into a node_modules tree.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { resolveRoot } from '../discovery.js'

// Build platform-correct absolute paths so the node_modules marker (path.sep-based) matches.
const abs = (...segs) => path.join(path.sep, ...segs)

describe('resolveRoot', () => {
  test('ATELIER_ROOT wins over PWD and node_modules host dir (and is absolutized)', () => {
    const r = resolveRoot({
      atelierRoot: abs('srv', 'instance'),
      pwd: abs('nonexistent', 'atelier'),
      hostDir: abs('opt', 'app', 'node_modules', '@pa1nd', 'atelier'),
    })
    assert.equal(r, path.resolve(abs('srv', 'instance')))
  })

  test('installed as a dependency → the folder that owns node_modules', () => {
    const instance = abs('Users', 'me', 'my-studio')
    const hostDir = path.join(instance, 'node_modules', '@pa1nd', 'atelier')
    assert.equal(resolveRoot({ pwd: instance, hostDir }), instance)
  })

  test('pnpm nested store → the consumer project, not the store', () => {
    const instance = abs('Users', 'me', 'my-studio')
    const hostDir = path.join(instance, 'node_modules', '.pnpm', '@pa1nd+atelier@0.10.0', 'node_modules', '@pa1nd', 'atelier')
    assert.equal(resolveRoot({ pwd: instance, hostDir }), instance)
  })

  test('legacy subfolder layout → parent of PWD', () => {
    const instance = abs('Users', 'me', 'instance')
    const hostDir = path.join(instance, 'atelier')
    assert.equal(resolveRoot({ pwd: hostDir, hostDir }), path.resolve(instance))
  })

  test('legacy with no PWD → parent of hostDir', () => {
    const instance = abs('Users', 'me', 'instance')
    const hostDir = path.join(instance, 'atelier')
    assert.equal(resolveRoot({ pwd: undefined, hostDir }), path.resolve(instance))
  })
})
