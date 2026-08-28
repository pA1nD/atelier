// doctor/probe/entry.mjs — the worker entry the probe hands to spawnWorker({runtime}) (doctor/DESIGN.md §4).
// hooks.mjs first (its side effects must precede every module the runtime loads), then the REAL
// host/worker/runtime.mjs: its own `argv[1] === runtime.mjs` guard does not fire for this entry, so
// `main()` is called explicitly — chdir → import the bundle → frozen ctx → router → mountRoutes →
// resources → listen on the socket → READY on fd 3. The runtime is not edited.
// After READY: one {t:'doctor', kind:'stats', rss} line (the worker's RSS at READY).
import fs from 'node:fs'
import { sendSummary, CTL_FD } from './hooks.mjs'

const rt = await import('../../host/worker/runtime.mjs')
try {
  await rt.main()
  try { fs.writeSync(CTL_FD, JSON.stringify({ t: 'doctor', kind: 'stats', rss: process.memoryUsage().rss }) + '\n') } catch {}
} catch (e) {
  // the runtime's own fallback for a main() that throws outside its loadFailed sites
  try { fs.writeSync(CTL_FD, JSON.stringify({ t: 'load-failed', code: 'LOAD-ERROR', message: e?.message ?? String(e), ...rt.locate(e) }) + '\n') } catch {}
  sendSummary('main-threw')
  process.exit(1)
}
