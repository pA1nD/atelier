#!/usr/bin/env node
// host/devcli.mjs — the `atelier` command inside a chat's computer (DESIGN §10.3 D6; symlinked
// /usr/local/bin/atelier in the image, mode 100755). Bayard's door to a release:
//
//   atelier deploy <slug> -m "<what changed, one line>" [--no-backup]   commit + rehearsal + release
//   atelier rollback <slug> <commit>                                   the same verb for an older commit (code only)
//   atelier releases <slug>                                            the host's release rows, newest first
//   atelier backups <slug>                                             the kept backups, newest first
//   atelier restore <slug> <backup-id> [--yes]                         prod data back from a backup (--yes: the app is live)
//
// Transport: the dev shell on 127.0.0.1:1844 (`ATELIER_DEV_PORT` when set; `ATELIER_DEV_URL` overrides the whole
// base) with the dev token from /run/atelier/session/dev.token (`ATELIER_DEV_TOKEN_FILE`). A deploy/restore is an
// NDJSON stream: every step line goes to stderr as it arrives, the ONE verdict line to stdout — the words are
// supervisor/deploy.mjs MESSAGES (LANES-DEPLOY-MESSAGES.md), nowhere else. Exit 0 green · 2 red (nothing
// deployed) · 3 failed (the app is down) · 1 usage or transport (no dev token, the dev shell unreachable, the
// stream cut before a verdict).
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { MESSAGES } from './supervisor/deploy.mjs'
import { isMain } from './entry.mjs'
import { commit12 } from './supervisor/slots.mjs'

export const TOKEN_FILE = '/run/atelier/session/dev.token'
export const DEV_URL = 'http://127.0.0.1:1844'
export const EXIT = Object.freeze({ green: 0, usage: 1, red: 2, failed: 3 })
export const VERBS = Object.freeze(['deploy', 'rollback', 'releases', 'backups', 'restore'])
export const USAGE = MESSAGES.usage
const SLUG_RE = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** parseArgs(argv) → {verb, slug, message?, commit?, backup?, noBackup} | {error} — pure, tested. */
export function parseArgs(argv) {
  const [verb, slug, ...rest] = argv
  if (!verb || !VERBS.includes(verb)) return { error: `unknown verb '${verb ?? ''}'` }
  if (!slug || !SLUG_RE.test(slug)) return { error: `bad slug '${slug ?? ''}'` }
  const out = { verb, slug, noBackup: false }
  if (verb === 'deploy') {
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k]
      if (a === '-m' || a === '--message') { out.message = rest[++k] }
      else if (a.startsWith('--message=')) out.message = a.slice('--message='.length)
      else if (a === '--no-backup') out.noBackup = true
      else return { error: `unknown argument '${a}'` }
    }
    if (typeof out.message !== 'string' || !out.message.trim()) return { error: 'deploy needs -m "<what changed, one line>"' }
    return out
  }
  if (verb === 'rollback') { if (!rest[0] || !/^[0-9a-f]{7,40}$/i.test(rest[0]) || rest.length > 1) return { error: 'rollback needs one <commit> (7–40 hex)' }; out.commit = rest[0].toLowerCase(); return out }
  if (verb === 'restore') {
    const flags = rest.filter((a) => a.startsWith('--')), args = rest.filter((a) => !a.startsWith('--'))
    if (flags.some((f) => f !== '--yes')) return { error: `unknown argument '${flags.find((f) => f !== '--yes')}'` }
    if (!args[0] || args.length > 1 || args[0].includes('/')) return { error: 'restore needs one <backup-id>' }
    out.backup = args[0]; out.yes = flags.includes('--yes'); return out
  }
  if (rest.length) return { error: `unexpected argument '${rest[0]}'` }
  return out
}

/** verdictLine(v, verb) → the ONE line (MESSAGES.verdict), exitCode(v) → 0|2|3. */
export function verdictLine(v, verb = v.kind === 'rollback' ? 'rollback' : 'deploy') {
  const c = (x) => (x ? commit12(x) : 'none')
  if (v.kind === 'restore') return v.outcome === 'green' ? MESSAGES.verdict.restoreGreen(v.slug, v.rev, v.backup, v.url) : v.outcome === 'red' ? MESSAGES.verdict.restoreRed(v.step, v.error, v.slug, v.backup) : MESSAGES.verdict.restoreFailed(v.step, v.error, v.slug, v.backup)
  if (v.outcome === 'green') return MESSAGES.verdict.green(verb, v.slug, v.rev, c(v.commit), v.url)
  if (v.outcome === 'red') return MESSAGES.verdict.red(verb, v.step, v.error, v.slug, v.rev ?? 0, c(v.commit))
  return v.backup ? MESSAGES.verdict.failed(verb, v.step, v.error, v.slug, v.backup) : MESSAGES.verdict.failedNoBackup(verb, v.step, v.error, v.slug)
}
export const exitCode = (v) => (v.outcome === 'green' ? EXIT.green : v.outcome === 'red' ? EXIT.red : EXIT.failed)
export const stepLine = (s) => (s.ok ? MESSAGES.step.ok(s.name, s.ms, s.note) : MESSAGES.step.fail(s.name, s.ms, s.note ?? ''))
export const abortLine = (slug, reason) => `deploy aborted: ${reason} — read atelier releases ${slug} before running it again`
export const IDLE_TIMEOUT_MS = 300_000   // no byte for 5 min (the longest silent step is the rehearsal's 240 s) → the abort line, never a hung turn

export function readToken(file = process.env.ATELIER_DEV_TOKEN_FILE ?? TOKEN_FILE) {
  try { return fs.readFileSync(file, 'utf8').trim() || null } catch { return null }
}
export const devUrl = (env = process.env) => env.ATELIER_DEV_URL ?? (env.ATELIER_DEV_PORT ? `http://127.0.0.1:${env.ATELIER_DEV_PORT}` : DEV_URL)

// request(url, token, {method, path, body, onLine}) → {status, body:string} — NDJSON lines reach onLine as they arrive
export function request(base, token, { method = 'GET', path: p = '/', body, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base)
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const headers = { 'x-atelier-dev-token': token, accept: 'application/json' }
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = payload.length }
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: p, method, headers }, (res) => {
      let buf = '', all = ''
      res.setEncoding('utf8')
      res.on('data', (c) => {
        all += c
        if (!onLine) return
        buf += c
        let i
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) onLine(line) }
      })
      res.on('end', () => { if (onLine && buf.trim()) onLine(buf); resolve({ status: res.statusCode, body: all }) })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error(`no answer for ${IDLE_TIMEOUT_MS / 1000} s`)))
    req.end(payload ?? undefined)
  })
}

/** main(argv, io) → the exit code. */
export async function main(argv, { stdout = process.stdout, stderr = process.stderr, token = readToken(), url = devUrl() } = {}) {
  const say = (s) => stderr.write(s + '\n')
  const args = parseArgs(argv)
  if (args.error) { say(`atelier: ${args.error}\n${USAGE}`); return EXIT.usage }
  if (!token) { say(`atelier: no dev token at ${process.env.ATELIER_DEV_TOKEN_FILE ?? TOKEN_FILE} — this command runs inside the chat's computer`); return EXIT.usage }
  const verb = args.verb === 'rollback' ? 'rollback' : 'deploy'
  try {
    if (args.verb === 'releases' || args.verb === 'backups') {
      const r = await request(url, token, { path: `/_atelier/${args.verb}?app=${encodeURIComponent(args.slug)}` })
      if (r.status !== 200) { say(`atelier: ${r.status} ${r.body.trim()}`); return EXIT.usage }
      const j = JSON.parse(r.body)
      const rows = args.verb === 'releases' ? j.releases.map(MESSAGES.list.release) : j.backups.map((b) => MESSAGES.list.backup({ ...b, mb: b.mb ?? (b.bytes != null ? Math.round(b.bytes / 1024 / 1024) : '?') }))
      stdout.write((rows.length ? rows.join('\n') : (args.verb === 'releases' ? MESSAGES.list.releasesNone(args.slug) : MESSAGES.list.backupsNone(args.slug))) + '\n')
      return EXIT.green
    }
    let verdict = null
    const body = args.verb === 'restore' ? { app: args.slug, backup: args.backup, yes: args.yes === true } : { app: args.slug, message: args.message, commit: args.commit ?? null, noBackup: args.noBackup }
    const r = await request(url, token, {
      method: 'POST', path: args.verb === 'restore' ? '/_atelier/restore' : '/_atelier/deploy', body,
      onLine: (line) => {
        let j; try { j = JSON.parse(line) } catch { return }
        if (j.t === 'step') say(stepLine(j))
        else if (j.t === 'verdict') verdict = j
      },
    })
    if (r.status !== 200) { let e = ''; try { e = JSON.parse(r.body).error } catch { e = r.body.trim() }; say(`atelier: ${r.status} ${e}`); return EXIT.usage }
    if (!verdict) { say(abortLine(args.slug, 'the stream ended without a verdict')); return EXIT.usage }
    stdout.write(verdictLine(verdict, verb) + '\n')
    return exitCode(verdict)
  } catch (e) {
    say(abortLine(args.slug, `${e?.code ?? ''} ${e?.message ?? e}`.trim()))
    return EXIT.usage
  }
}

// The entry guard (the test suite imports `main`, so the file must not run on import) compares REAL paths (entry.mjs): the
// image runs this file through the `/usr/local/bin/atelier` symlink, and `process.argv[1]` is the symlink — a bare
// `path.resolve` never matched, so the CLI was a silent no-op (exit 0, nothing printed) in every pod (2026-09-02).
if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { process.stderr.write(`atelier: ${e?.stack ?? e}\n`); process.exit(EXIT.usage) })
}
