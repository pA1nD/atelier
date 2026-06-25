// ATELIER_ROOT names the instance folder explicitly, overriding the PWD-derived
// default — the documented path for managed launchers (launchd/systemd/Docker)
// that may not set PWD. With a deliberately wrong PWD, the resolved root must
// still come from ATELIER_ROOT.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from './helpers.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 'ws-settings')
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

describe('ATELIER_ROOT', () => {
  test('overrides a wrong PWD-derived root', async () => {
    // PWD points somewhere with no instance; only ATELIER_ROOT names the real
    // folder. If ATELIER_ROOT weren't honored, ROOT would resolve from PWD and
    // the startup banner would print the wrong path.
    const server = await startServer(FIXTURE, { PWD: '/nonexistent/elsewhere', ATELIER_ROOT: FIXTURE })
    try {
      // The startup banner prints `Atelier · <mode> · <root> · env=<env>`.
      assert.match(server.output(), new RegExp(escapeRe(FIXTURE)), 'banner shows ROOT resolved from ATELIER_ROOT')
    } finally {
      await server.stop()
    }
  })
})
