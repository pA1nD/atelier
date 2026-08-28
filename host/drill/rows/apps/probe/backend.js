// The rows drill's probe app — DESIGN §8.2 row 6 (what a worker can and cannot touch, from inside,
// incl. the dev shell's loopback port without a token) and row 7 (the watchdog attacks: a CPU burn,
// a 2 GB allocation under RLIMIT_DATA, a fork storm at RLIMIT_NPROC). A 1.x module.
import fs from 'node:fs'
import net from 'node:net'
import http from 'node:http'
import { spawn } from 'node:child_process'

const tryRead = (p) => { try { fs.readFileSync(p); return 'READ' } catch (e) { return e.code } }
const tryList = (p) => { try { fs.readdirSync(p); return 'LISTED' } catch (e) { return e.code } }
const tryWrite = (p) => { try { fs.writeFileSync(p, 'probe\n'); return 'WROTE' } catch (e) { return e.code } }
const tryConnect = (p) => new Promise((r) => { const s = net.connect(p); s.on('connect', () => { s.destroy(); r('CONNECTED') }); s.on('error', (e) => r(e.code)) })
const tryHttp = (url) => new Promise((r) => { const q = http.get(url, { timeout: 2000 }, (res) => { res.resume(); r(res.statusCode) }); q.on('error', (e) => r(e.code)); q.on('timeout', () => { q.destroy(); r('TIMEOUT') }) })

let burn = null
export default {
  mountRoutes(router, ctx) {
    router.get('/probe', async (req, res) => {
      const peer = req.query.peer
      const run = '/run/atelier'
      res.json({
        uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(), cwd: process.cwd(), umask: process.umask().toString(8),
        envKeys: Object.keys(process.env).sort(),
        user: req.user ?? null,
        dataDir: { write: tryWrite(ctx.dataDir + '/probe.txt'), list: tryList(ctx.dataDir) },
        denied: {
          pid1Environ: tryRead('/proc/1/environ'),
          bootstrapToken: tryRead(run + '/bootstrap.token'), devToken: tryRead(run + '/dev.token'), sessionDevToken: tryRead(run + '/session/dev.token'),
          claudeCredentials: tryRead('/work/.claude/.credentials.json'), claudeDir: tryList('/work/.claude'), control: tryList('/control'),
          agentLog: tryRead('/work/.atelier/agent.log'), lastGood: tryList('/work/.atelier/last-good'), dataRoot: tryList('/work/.atelier/data'),
          peerDataDir: peer ? tryList(peer) : 'n/a', peerSock: peer ? tryList(peer.replace(/\/work\/\.atelier\/data\//, run + '/w/')) : 'n/a',
          devShellSock: await tryConnect(run + '/dev/shell.sock'), ownAppsDir: tryWrite('/work/apps/probe/planted.txt'),
        },
        devShellHttp: { noToken: await tryHttp('http://127.0.0.1:1844/_atelier/apps'), badToken: await tryHttp('http://127.0.0.1:1844/_atelier/apps?token=' + 'f'.repeat(64)) },
      })
    })
    // row 7a: 100 % of one core in 200 ms slices (the event loop yields between slices so /burn-stop is served)
    router.get('/burn', (req, res) => {
      if (!burn) burn = setInterval(() => { const t = Date.now(); while (Date.now() - t < 200) {} }, 0)
      res.json({ burning: true, pid: process.pid })
    })
    router.get('/burn-stop', (req, res) => { if (burn) clearInterval(burn); burn = null; res.json({ burning: false, pid: process.pid }) })
    // row 7b: ONE 2 GB allocation, untouched (virtual only: RLIMIT_DATA is the wall; the RSS watchdog never sees
    // it). `?chunked=1` allocates 64 MB pieces instead — creeping growth ends wherever the next malloc lands
    // (V8's own semi-space commit → a FATAL abort, SIGABRT, not a RangeError; measured, RESULT.md).
    router.get('/alloc', (req, res) => {
      const chunks = []
      let error = null
      try {
        if (req.query.chunked) for (let i = 0; i < 32; i++) chunks.push(Buffer.allocUnsafe(64 * 1024 * 1024))
        else chunks.push(Buffer.allocUnsafe(2 * 1024 * 1024 * 1024))
      } catch (e) { error = { name: e.name, code: e.code ?? null, message: String(e.message).slice(0, 120) } }
      const mb = chunks.reduce((n, b) => n + b.length / 1048576, 0)
      chunks.length = 0
      res.json({ allocatedMb: mb, error, pid: process.pid, rssMb: Math.round(process.memoryUsage().rss / 1048576) })
    })
    // row 7c: 200 concurrent children; EAGAIN arrives as the child's 'error' event
    router.get('/fork', async (req, res) => {
      const n = Number(req.query.n ?? 200)
      const kids = []
      let eagain = 0, other = []
      for (let i = 0; i < n; i++) {
        const c = spawn('sleep', ['30'], { stdio: 'ignore' })
        c.on('error', (e) => { if (e.code === 'EAGAIN') eagain++; else other.push(e.code) })
        kids.push(c)
      }
      await new Promise((r) => setTimeout(r, 1500))
      const alive = kids.filter((c) => c.pid && c.exitCode === null && !c.killed).length
      for (const c of kids) { try { c.kill('SIGKILL') } catch {} }
      res.json({ requested: n, spawned: alive, eagain, other: other.slice(0, 5), pid: process.pid })
    })
    return () => { if (burn) clearInterval(burn); burn = null; ctx.log('probe teardown') }
  },
}
