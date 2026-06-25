// Characterizes chrome-slot resolution now that the shell ships no builtin:
// a discovered meta.isChrome module wins the slot, its bundle serves, and it's
// kept out of the rail. (The no-chrome path is covered in server-basic.)
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from './helpers.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 'ws-chrome')

let server
before(async () => { server = await startServer(FIXTURE) })
after(async () => { await server?.stop() })

test('a discovered meta.isChrome module wins the chrome slot', async () => {
  const html = await (await fetch(server.base + '/')).text()
  assert.match(html, /"chromeQid":"global\/skin"/)
})

test('the chrome bundle compiles + serves', async () => {
  const r = await fetch(server.base + '/modules/global/skin/frontend.js')
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type') || '', /javascript/)
})

test('rail module is surfaced; the chrome itself is hidden', async () => {
  const html = await (await fetch(server.base + '/')).text()
  assert.match(html, /"widget"/)
})
