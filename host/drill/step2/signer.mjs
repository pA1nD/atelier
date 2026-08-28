// The drill's tiny shell: mints an identity assertion with protocol/identity (the fake spine's
// key) and the bearer pair, sends ONE request to the host's protocol port and prints
//   STATUS <code> ETAG <etag|-> <ms>ms
// followed by the body. Run on the peer pod, outside the computer pod.
//   node signer.mjs <METHOD> <url> [--app <instance>] [--no-assert] [--no-bearer] [--person id:name] [--body <json>] [--wrong-key]
import http from 'node:http'
import fs from 'node:fs'
import { createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { mint, HEADER } from '../../../protocol/index.js'

const args = process.argv.slice(2)
const [method, target] = args
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
const has = (k) => args.includes(k)
const state = JSON.parse(fs.readFileSync(process.env.SPINE_STATE ?? '/tmp/spine-state.json', 'utf8'))
const url = new URL(target)
const headers = { accept: 'application/json' }
if (!has('--no-bearer')) headers.authorization = `Bearer ${state.epoch}.${state.token}`
if (!has('--no-assert') && opt('--app')) {
  const priv = has('--wrong-key') ? generateKeyPairSync('ed25519').privateKey : createPrivateKey({ key: Buffer.from(state.priv_pkcs8_hex, 'hex'), format: 'der', type: 'pkcs8' })
  const [id, name] = (opt('--person') ?? 'p1:Ada').split(':')
  headers[HEADER] = mint(priv, { aud: state.host_id, app: opt('--app'), method, path: url.pathname + url.search, person: { id, name } }, { now: Math.floor(Date.now() / 1000) })
}
const body = opt('--body')
if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(body) }
const t0 = Date.now()
const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers, timeout: 10_000 }, (res) => {
  const chunks = []
  res.on('data', (c) => chunks.push(c))
  res.on('end', () => { process.stdout.write(`STATUS ${res.statusCode} ETAG ${res.headers.etag ?? '-'} ${Date.now() - t0}ms\n${Buffer.concat(chunks).toString('utf8')}\n`) })
})
req.on('timeout', () => { req.destroy(new Error('timeout')) })
req.on('error', (e) => { process.stdout.write(`STATUS 000 ETAG - ${Date.now() - t0}ms\n${e.code ?? e.message}\n`); process.exit(0) })
req.end(body)
