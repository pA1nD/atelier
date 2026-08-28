// probe-dirty — every 1.x habit the probe must see at mount: a sidecar listen (D2), a laptop binary
// (D12), a process.env read (N2), a write into <app>/data (N1), the jobs beacon over the loopback and
// /api/global/ (N4, N5), a cross-app ctx.module (D3), a signal handler (N8). It still mounts.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export default {
  mountRoutes(router, ctx) {
    const port = Number(process.env.SPACES_PORT || 7475)
    const side = http.createServer((req, res) => res.end('sidecar'))
    side.listen(port, '0.0.0.0', () => ctx.log(`sidecar on ${port}`))
    const childEnv = { ...process.env, FFREPORT: '1' }   // an enumeration: one envSpread, no per-key reads
    const child = spawn('ffmpeg', ['-version'], { env: childEnv })
    child.on('error', () => {})
    try { fs.mkdirSync(path.join(HERE, 'data'), { recursive: true }) } catch {}
    try { fs.writeFileSync(path.join(HERE, 'data', 'x'), 'x') } catch {}
    fs.existsSync(path.join(HERE, 'data', 'y'))
    fetch('http://127.0.0.1:1844/api/global/jobs/beacon', { method: 'POST', body: '{}' }).catch(() => {})
    ctx.module('jobs').registered = true
    process.on('SIGINT', () => {})
    router.get('/', (req, res) => res.json({ ok: true }))
    return () => side.close()
  },
}
