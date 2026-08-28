// The host stand-in for the launcher drill (the real host is host/index.mjs, the integrator's).
// Row H contract as seen from inside: fd 3 is the .atelier dirfd, env is the scrubbed row, umask 077.
// It writes host-ready, answers 200 on the pod IP :1845 (the peer's blink probe) and tears down on SIGTERM.
import fs from 'node:fs'
import http from 'node:http'
const run = process.env.ATELIER_RUN ?? '/run/atelier'
const log = (m) => console.log(`[host-stub] ${m}`)
try { process.setgroups([]) } catch {}                 // the real host runs with root's groups empty (§2.2 row H)
let fd3 = 'none'
try { fd3 = fs.fstatSync(3).isDirectory() ? fs.readlinkSync('/proc/self/fd/3') : 'not-a-dir' } catch (e) { fd3 = `error ${e.code}` }
log(`pid=${process.pid} uid=${process.getuid()} umask=${process.umask().toString(8).padStart(4, '0')} fd3=${fd3} cwd=${process.cwd()}`)
log(`env keys: ${Object.keys(process.env).sort().join(',')}`)
const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`ok ${process.pid}\n`) })
srv.listen(Number(process.env.ATELIER_HOST_PORT ?? 1845), '0.0.0.0', () => {
  fs.writeFileSync(`${run}/host-ready`, `${process.pid}\n`, { mode: 0o644 })
  try { fs.chmodSync(`${run}/host-ready`, 0o644) } catch {}   // umask 077 masks the create mode; the real host chmods too (§I1.14)
  log(`ready: listening :${srv.address().port}, ${run}/host-ready written`)
})
process.on('SIGTERM', () => {
  log('SIGTERM → teardown')
  try { fs.unlinkSync(`${run}/host-ready`) } catch {}
  srv.close(() => { log('stopped'); process.exit(0) })
  setTimeout(() => process.exit(0), 1500).unref()
})
