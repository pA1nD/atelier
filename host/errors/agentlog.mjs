// host/errors/agentlog.mjs — /work/.atelier/agent.log (PLAN §4.3 last-good "the error goes to the
// agent: dev shell, agent.log"; ENOSPC paragraph; DESIGN §3 row agent.log, §6.3 line format).
//
// The file is `0:1000 0640` under the root-owned `.atelier` dirfd: the agent (uid 1000, group
// 1000) reads it, workers (groups cleared) cannot. It is created with its mode (open 'a' with
// 0o640, then chmod 0640 because the host's umask 077 masks the open mode — before the chown, never
// after) and chowned once through the adapter. Every append is
// try/caught: ENOSPC [S:data-storage-4] or any other failure is mirrored to stderr with the line
// itself and NEVER thrown into the caller — an uncaught append inside a build promise would
// take the host down as an unhandled rejection.
//
// Line format (§6.3): `<ISO> [<slug>] rev <N> <LIVE in <ms> ms | FAILED (users still on rev M) <hint> | STOPPED | RESUMED <ms> ms | KILLED <why>>`;
// the collector sink (`appError`) writes FAILED (build) and KILLED (worker) lines and
// `<kind> ×N <file:line:col> <message> — fix: <hint>` for backend/http/frontend; the supervisor
// writes LIVE/STOPPED/RESUMED through live()/stopped()/resumed(). Host-level lines (`host: …`)
// go through line().
import fs from 'node:fs'
import { messageHead } from '../../protocol/index.js'

export const AGENT_LOG_MODE = 0o640
export const AGENT_LOG_OWNER = { uid: 0, gid: 1000 }
export const MAX_LINE_CHARS = 2000

const iso = (ms) => new Date(ms).toISOString()
const loc = (ev) => (ev.file ? `${ev.file}:${ev.line ?? '-'}${ev.col !== undefined ? ':' + ev.col : ''}` : '')

/** formatAppError(ev, {slug, running}) → the agent.log text after the timestamp (pure; tested). */
export function formatAppError(ev, { slug, running } = {}) {
  const app = `[${slug ?? ev.instance}] rev ${ev.rev}`
  const times = ev.count > 1 ? ` ×${ev.count}` : ''
  const where = loc(ev)
  const head = messageHead(ev.message, 200)
  if (ev.kind === 'build') {
    const users = Number.isInteger(running) && running < ev.rev ? `(users still on rev ${running})` : '(users see nothing — never live)'
    return `${app} FAILED ${users} ${ev.hint ?? [where, head].filter(Boolean).join(' ')}`
  }
  if (ev.kind === 'worker') return `${app} KILLED ${head}${ev.hint ? ' — ' + ev.hint : ''}`
  const rq = ev.sample?.request ? ` (${ev.sample.request.method ?? ''} ${ev.sample.request.path ?? ''}${ev.sample.request.status ? ' → ' + ev.sample.request.status : ''})`.replace('( ', '(') : ''
  const at = ev.kind === 'frontend' && ev.sample?.url ? ` at ${ev.sample.url}` : ''
  return `${app} ${ev.kind}${times}${rq}${at} ${[where, head].filter(Boolean).join(' ')}${ev.hint ? ' — fix: ' + ev.hint : ''}`
}

/**
 * agentLog({ os, path, now, stderr, append, slugOf })
 *   .line(text)                       one line, timestamped; never throws
 *   .live(slug, rev, ms) .failed(slug, rev, usersRev, hint) .stopped(slug, rev) .resumed(slug, rev, ms) .killed(slug, rev, why)
 *   .appError(ev, ctx)                the collector sink (ctx.running from the collector, slug via slugOf)
 *   .path                             where it writes
 *   .lost                             appends that failed since boot (the drill reads it)
 * `append(path, text, mode)` defaults to fs.appendFileSync with {mode}; tests inject a recorder or a thrower.
 */
export function agentLog({ os, path, now, stderr = process.stderr, append, slugOf = () => undefined } = {}) {
  const clock = now ?? os?.now ?? Date.now
  const write = append ?? ((p, text, mode) => fs.appendFileSync(p, text, { mode }))
  let owned = false
  let lost = 0
  function ensureOwner() {
    if (owned || !os) return
    try { os.chmod(path, AGENT_LOG_MODE); os.chown(path, AGENT_LOG_OWNER.uid, AGENT_LOG_OWNER.gid); owned = true } catch (e) { mirror(`agent.log: chown ${e?.code ?? e?.message ?? e}`) }
  }
  function mirror(text) { try { stderr.write(text.endsWith('\n') ? text : text + '\n') } catch {} }
  function line(text) {
    const t = String(text).replace(/\r?\n/g, ' ⏎ ')
    const out = `${iso(clock())} ${t.length > MAX_LINE_CHARS ? t.slice(0, MAX_LINE_CHARS) + '…' : t}\n`
    try { write(path, out, AGENT_LOG_MODE); ensureOwner() } catch (e) { lost++; mirror(`agent.log: append ${e?.code ?? e?.message ?? e} — ${out}`) }
  }
  const api = {
    path,
    get lost() { return lost },
    line,
    live: (slug, rev, ms) => line(`[${slug}] rev ${rev} LIVE in ${ms} ms`),
    failed: (slug, rev, usersRev, hint) => line(`[${slug}] rev ${rev} FAILED ${Number.isInteger(usersRev) ? `(users still on rev ${usersRev})` : '(users see nothing — never live)'} ${hint}`),
    stopped: (slug, rev) => line(`[${slug}] rev ${rev} STOPPED`),
    resumed: (slug, rev, ms) => line(`[${slug}] rev ${rev} RESUMED ${ms} ms`),
    killed: (slug, rev, why) => line(`[${slug}] rev ${rev} KILLED ${why}`),
    appError: (ev, ctx = {}) => line(formatAppError(ev, { slug: ctx.slug ?? slugOf(ev.instance), running: ctx.running })),
  }
  return api
}
