// A module's uncaught async throw (a rogue timer, an unhandled rejection in a
// background task) must NOT take the whole shell down. It's attributed to the
// module and surfaced via its backend-error overlay/500 — while the shell and
// every OTHER module keep running. (A SHELL-level fault still crashes; only
// module faults are isolated.)
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer, sleep } from './helpers.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 'crash-isolation')

let server
before(async () => { server = await startServer(FIXTURE) })
after(async () => { await server?.stop() })

test("a module's uncaught async throw is isolated — shell survives, the module 500s, siblings stay 200", async () => {
  // First request mounts both backends; crasher schedules a throwing timer.
  assert.equal((await fetch(server.base + '/api/global/good/ping')).status, 200)

  await sleep(300)   // let crasher's setTimeout fire → uncaughtException → isolated

  // The shell is still alive — an unrelated module keeps serving normally.
  assert.equal((await fetch(server.base + '/api/global/good/ping')).status, 200)

  // The faulting module surfaces a 500, attributed, with the error message.
  const res = await fetch(server.base + '/api/global/crasher/ping')
  assert.equal(res.status, 500)
  const body = await res.json()
  assert.equal(body.module, 'global/crasher')
  assert.match(body.message, /boom from a module timer/)
})
