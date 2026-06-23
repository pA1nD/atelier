// Test helpers — boot the real shell as a child process against a fixture
// workspace, so characterization tests exercise the actual entry point
// (server.js) with zero source changes.
//
// The shell computes ROOT = resolve(process.env.PWD, '..'). We set PWD to
// `<fixture>/atelier` so ROOT resolves to the fixture dir — modules are
// discovered there, while HOST_DIR (where server.js lives) still serves the
// shell assets + builtin chrome. PORT is a free ephemeral port so tests never
// collide with a running instance (default 1844).
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.resolve(HERE, '..', 'server.js')

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export { sleep }

export async function startServer(fixtureDir, extraEnv = {}) {
  const port = await freePort()
  const proc = spawn(process.execPath, [SERVER], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      PWD: path.join(fixtureDir, 'atelier'),   // → ROOT = fixtureDir
      PORT: String(port),
      NODE_ENV: 'development',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  proc.stdout.on('data', (d) => { out += d })
  proc.stderr.on('data', (d) => { out += d })
  const base = `http://127.0.0.1:${port}`
  await waitReady(base, proc, () => out)
  return {
    base,
    port,
    proc,
    output: () => out,
    async stop() {
      if (proc.exitCode != null || proc.signalCode != null) return
      proc.kill('SIGTERM')
      await new Promise((res) => {
        const t = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} res() }, 2500)
        proc.once('exit', () => { clearTimeout(t); res() })
      })
    },
  }
}

// Ready = the listener answers any HTTP status (200 / 401 / 404 all mean "up").
async function waitReady(base, proc, getOut, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (proc.exitCode != null) {
      throw new Error(`server exited early (code ${proc.exitCode})\n--- output ---\n${getOut()}`)
    }
    try {
      await fetch(base + '/', { redirect: 'manual' })
      return
    } catch {
      await sleep(150)
    }
  }
  throw new Error(`server not ready in ${timeoutMs}ms\n--- output ---\n${getOut()}`)
}
