// The peer's request loop for the deploy drill (row 9d): one identity assertion per request (the fake spine's key,
// like signer.mjs), a GET every <intervalMs> for <count> requests against the host's PROTOCOL port — the prod road —
// printing `<status> <ms> <rev|->` per line. Run on the peer pod.
//   node loop.mjs <url> <app-instance> <count> <intervalMs>
import http from 'node:http'
import fs from 'node:fs'
import { createPrivateKey } from 'node:crypto'
import { mint, HEADER } from '../../../protocol/index.js'

const [target, app, countArg, intervalArg] = process.argv.slice(2)
const count = Number(countArg ?? 200), interval = Number(intervalArg ?? 50)
const state = JSON.parse(fs.readFileSync(process.env.SPINE_STATE ?? '/tmp/spine-state.json', 'utf8'))
const priv = createPrivateKey({ key: Buffer.from(state.priv_pkcs8_hex, 'hex'), format: 'der', type: 'pkcs8' })
const url = new URL(target)
const agent = new http.Agent({ keepAlive: true, maxSockets: 4 })
const one = () => new Promise((resolve) => {
  const headers = { accept: 'application/json', authorization: `Bearer ${state.epoch}.${state.token}` }
  headers[HEADER] = mint(priv, { aud: state.host_id, app, method: 'GET', path: url.pathname + url.search, person: { id: 'p1', name: 'Ada' } }, { now: Math.floor(Date.now() / 1000) })
  const t0 = Date.now()
  const req = http.request({ agent, hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET', headers, timeout: 15_000 }, (res) => {
    const chunks = []
    res.on('data', (c) => chunks.push(c))
    res.on('end', () => { let rev = '-'; try { rev = JSON.parse(Buffer.concat(chunks).toString('utf8')).rev ?? '-' } catch {} resolve(`${res.statusCode} ${Date.now() - t0} ${rev}`) })
  })
  req.on('timeout', () => req.destroy(new Error('timeout')))
  req.on('error', (e) => resolve(`000 ${Date.now() - t0} ${e.code ?? e.message}`))
  req.end()
})
for (let i = 0; i < count; i++) {
  process.stdout.write((await one()) + '\n')
  await new Promise((r) => setTimeout(r, interval))
}
agent.destroy()
