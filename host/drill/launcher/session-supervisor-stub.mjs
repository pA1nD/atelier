// The session supervisor stand-in for the launcher drill: the image's /app/session-supervisor.mjs is
// replaced by this sleeper (the real one is drilled in r2/spike-g3-step1). It reports what the
// launcher gave it (uid/gid/groups, cwd, umask, env keys) and exits 1 on SIGTERM like the real one.
const log = (m) => console.log(`[session-stub] ${m}`)
log(`pid=${process.pid} uid=${process.getuid()} gid=${process.getgid()} groups=${process.getgroups().join(',')} cwd=${process.cwd()} umask=${process.umask().toString(8).padStart(4, '0')} HOME=${process.env.HOME}`)
log(`env keys: ${Object.keys(process.env).sort().join(',')}`)
setInterval(() => {}, 60_000)
process.on('SIGTERM', () => { log('SIGTERM → exit 1'); process.exit(1) })
