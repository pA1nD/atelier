// host/worker/hookrun.mjs — the process behind row K (worker/hook.mjs): `node hookrun.mjs <sh command>`,
// already dropped to the worker uid by the adapter's wrapper. Reads the config document on stdin to EOF
// (exactly what worker/runtime.mjs does), assigns the keys to its env without overriding row W, then runs
// `sh -c <cmd>` in the cwd it was given and exits with the command's code (128 + signal when it died by one).
import { spawnSync } from 'node:child_process'
import { readConfig } from './runtime.mjs'

const cmd = process.argv[2]
if (typeof cmd !== 'string' || !cmd.trim()) { process.stderr.write('hookrun: no command\n'); process.exit(2) }
for (const k of ['PWD', 'OLDPWD', 'SHLVL', '_', '__CF_USER_TEXT_ENCODING']) delete process.env[k]
for (const [k, v] of Object.entries(readConfig(0))) if (!(k in process.env)) process.env[k] = String(v)
const r = spawnSync('sh', ['-c', cmd], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env })
if (r.error) { process.stderr.write(`hookrun: ${r.error.message}\n`); process.exit(2) }
process.exit(r.status ?? (r.signal ? 128 + (Number(r.signal) || 9) : 2))
