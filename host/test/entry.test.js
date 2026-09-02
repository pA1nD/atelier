// host/entry.mjs isMain — the one entry guard for every file that runs `main()` when it is the process entry (review
// 2026-09-02 S6): the image runs the CLI through the /usr/local/bin/atelier symlink, the skills dir links the doctor,
// /app/atelier may become a link — and a bare `path.resolve(process.argv[1])` compare never matched a symlink, so the
// guarded main() silently did not run (exit 0, nothing printed). Each site below is driven THROUGH a symlink as a real
// process with an input that makes it refuse at once, and must answer (exit ≠ 0, its own words) — never a silent 0.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isMain } from '../entry.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const at = (rel) => path.join(REPO, rel)
const linked = (rel, name = 'atelier') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-'))
  const link = path.join(dir, name); fs.symlinkSync(at(rel), link)
  return { link, dir, drop: () => fs.rmSync(dir, { recursive: true, force: true }) }
}
const ENV = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? os.tmpdir() }
const run = (entry, { args = [], env = {}, stdio } = {}) => spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', env: { ...ENV, ...env }, timeout: 30_000, stdio })

test('isMain: true through a symlink and by the real path, false for another file, an unresolvable side (never null === null) or no argv[1]; import.meta.url and a plain path both accepted', () => {
  const { link, dir, drop } = linked('host/entry.mjs')
  try {
    const own = at('host/entry.mjs')
    assert.equal(isMain(own, link), true, 'through the symlink')
    assert.equal(isMain(own, own), true, 'by the real path')
    assert.equal(isMain('file://' + own, link), true, 'import.meta.url form')
    assert.equal(isMain(own, at('host/index.mjs')), false, 'another file')
    assert.equal(isMain(own, path.join(dir, 'missing')), false, 'argv[1] unresolvable')
    assert.equal(isMain(path.join(dir, 'missing'), own), false, 'own unresolvable')
    assert.equal(isMain(path.join(dir, 'missing'), path.join(dir, 'missing2')), false, 'both unresolvable: null is never equal to null')
    assert.equal(isMain(own, undefined), false); assert.equal(isMain(own, ''), false)
  } finally { drop() }
})

test('host/index.mjs through a symlink: fleet mode without ATELIER_HOST_TLS refuses to start (exit 2, the line on stderr) — not a silent exit 0', () => {
  const { link, drop } = linked('host/index.mjs')
  try {
    const r = run(link, { env: { ATELIER_SPINE_URL: 'http://spine.invalid' } })
    assert.equal(r.status, 2, `exit ${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`)
    assert.match(r.stderr, /fleet mode needs ATELIER_HOST_TLS=.* — refusing to start/)
  } finally { drop() }
})

test('host/launcher.mjs through a symlink: a plan step that cannot run (ATELIER_WORK under a missing parent) ends the boot with exit 2 and the `boot: a plan step failed` line — not a silent exit 0', () => {
  const { link, dir, drop } = linked('host/launcher.mjs')
  try {
    const gone = path.join(dir, 'missing')
    const r = run(link, { env: { ATELIER_WORK: `${gone}/work`, ATELIER_RUN: `${gone}/run`, ATELIER_CONTROL: `${gone}/control` } })
    assert.equal(r.status, 2, `exit ${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`)
    assert.match(r.stdout + r.stderr, /\[launcher\] boot pid=\d+/)
    assert.match(r.stdout + r.stderr, /boot: a plan step failed before the host spawn — exit 2/)
  } finally { drop() }
})

test('host/worker/runtime.mjs through a symlink with ATELIER_WORKER set: a spec it cannot mount is a `load-failed` line on fd 3 and exit 1 — not a silent exit 0 (without ATELIER_WORKER the file is a library: exit 0, fd 3 silent)', () => {
  const { link, dir, drop } = linked('host/worker/runtime.mjs')
  try {
    const ctl = path.join(dir, 'ctl'); const fd = fs.openSync(ctl, 'w')
    const r = run(link, { env: { ATELIER_WORKER: JSON.stringify({ company: 'acme', slug: 'x' }) }, stdio: ['ignore', 'pipe', 'pipe', fd] })
    fs.closeSync(fd)
    assert.equal(r.status, 1, `exit ${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`)
    const line = JSON.parse(fs.readFileSync(ctl, 'utf8').trim().split('\n')[0])
    assert.equal(line.t, 'load-failed'); assert.equal(line.code, 'LOAD-ERROR')
    const quiet = run(link, { stdio: ['ignore', 'pipe', 'pipe', fs.openSync(ctl, 'w')] })
    assert.equal(quiet.status, 0); assert.equal(fs.readFileSync(ctl, 'utf8'), '')
  } finally { drop() }
})

test('doctor/cli.mjs through a symlink (the skills dir links the doctor): `--bogus` is the usage and exit 2 — not a silent exit 0', () => {
  const { link, drop } = linked('doctor/cli.mjs', 'atelier-app')
  try {
    const r = run(link, { args: ['--bogus'] })
    assert.equal(r.status, 2, `exit ${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`)
    assert.match(r.stderr, /unknown option --bogus/); assert.match(r.stderr, /usage: atelier doctor/)
  } finally { drop() }
})

test('shell/cli-local.mjs through a symlink (`npx atelier` runs the bin symlink): `--bogus` is the usage line and exit 2 — not a silent exit 0', () => {
  const { link, drop } = linked('shell/cli-local.mjs')
  try {
    const r = run(link, { args: ['--bogus'] })
    assert.equal(r.status, 2, `exit ${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`)
    assert.match(r.stderr, /unknown flag --bogus/)
  } finally { drop() }
})

test('no entry guard in the tree compares a bare `path.resolve(process.argv[1])` or a URL `.pathname` any more — every site goes through entry.mjs', () => {
  const sites = ['host/index.mjs', 'host/launcher.mjs', 'host/worker/runtime.mjs', 'host/devcli.mjs', 'doctor/cli.mjs', 'shell/cli-local.mjs']
  for (const rel of sites) {
    const src = fs.readFileSync(at(rel), 'utf8')
    assert.ok(/isMain\(import\.meta\.url\)/.test(src), `${rel}: guards with isMain(import.meta.url)`)
    assert.ok(!/path\.resolve\(process\.argv\[1\]\)\s*===/.test(src), `${rel}: no bare resolve compare`)
    assert.ok(!/new URL\(import\.meta\.url\)\.pathname/.test(src), `${rel}: no URL.pathname compare`)
  }
})
