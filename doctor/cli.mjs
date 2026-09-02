#!/usr/bin/env node
// doctor/cli.mjs — `atelier doctor [<dir>|<corpus>] [--out <dir>] [--write] [--write-partial] [--yes-corpus] [--json]
//                   [--no-probe] [--chrome <dir>] [--env-keys <file>] [--jobs <n>]`   (DESIGN §6)
// Dispatched from cli.js (`['doctor', './doctor/cli.mjs']`); the verb has already been stripped, so the
// arguments start at argv[2]. Runs lane A (static) and lane B (probe) per module through report/lanes.mjs,
// merges (report/merge.mjs), writes the --out layout (report/write.mjs), prints the table and the VERDICT.
// Exit 0 = the run completed (whatever the verdicts), 1 = a lane crashed, 2 = usage (incl. a refused --write).
import fs from 'node:fs'
import path from 'node:path'
import { loadLanes, isModuleDir } from './report/lanes.mjs'
import { isMain } from '../host/entry.mjs'
import { mergeModule } from './report/merge.mjs'
import { buildRows, rowsMd, summaryOf } from './report/table.mjs'
import { finalVerdict, failVerdict } from './report/verdict.mjs'
import { writeModuleOut, writeCorpusOut, applyWrite, outInside, WriteRefused } from './report/write.mjs'
import { isDaily } from './report/daily.mjs'

export const USAGE = 'usage: atelier doctor [<dir>|<corpus>] [--out <dir>] [--write] [--write-partial] [--yes-corpus] [--json] [--no-probe] [--chrome <dir>] [--env-keys <file>] [--jobs <n>]'

export class UsageError extends Error {}

export function parseArgs(argv) {
  const o = { dir: null, out: './doctor-out', write: false, writePartial: false, yesCorpus: false, json: false, noProbe: false, chrome: null, envKeys: null, jobs: 8 }
  const takes = { '--out': 'out', '--chrome': 'chrome', '--env-keys': 'envKeys', '--jobs': 'jobs' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--write') o.write = true
    else if (a === '--write-partial') o.writePartial = true
    else if (a === '--yes-corpus') o.yesCorpus = true
    else if (a === '--json') o.json = true
    else if (a === '--no-probe') o.noProbe = true
    else if (a === '--help' || a === '-h') throw new UsageError(USAGE)
    else if (a in takes) {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value\n${USAGE}`)
      o[takes[a]] = argv[++i]
    } else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}\n${USAGE}`)
    else if (o.dir == null) o.dir = a
    else throw new UsageError(`one directory only (got ${o.dir} and ${a})\n${USAGE}`)
  }
  o.jobs = Math.max(1, Number(o.jobs) || 8)
  return o
}

/** A `.env`-shaped file → its key NAMES; nothing past the `=` is read. */
export function readEnvKeyNames(file) {
  const src = fs.readFileSync(file, 'utf8')
  return new Set([...src.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((m) => m[1]))
}

/** Which folders to judge: one module, or every module child of a corpus folder. */
export function resolveTarget(dir, listModules) {
  const abs = path.resolve(dir ?? process.cwd())
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new UsageError(`not a directory: ${abs}`)
  if (isModuleDir(abs)) {
    return { mode: 'module', root: abs, modules: [{ id: path.basename(abs), dir: abs, hasFrontend: fs.existsSync(path.join(abs, 'frontend.jsx')), hasBackend: fs.existsSync(path.join(abs, 'backend.js')) }] }
  }
  const modules = listModules(abs)
  if (!modules.length) throw new UsageError(`no module at ${abs} (needs frontend.jsx / backend.js / module.json, or children that have them)`)
  return { mode: 'corpus', root: abs, modules }
}

async function pool(items, jobs, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i) } }
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, worker))
  return out
}

/** The whole run as a function (the tests call it); `io` = {stdout, stderr} line sinks. */
export async function run(argv, io = { stdout: (l) => process.stdout.write(l + '\n'), stderr: (l) => process.stderr.write(l + '\n') }) {
  let opts
  try { opts = parseArgs(argv) } catch (e) { if (e instanceof UsageError) { io.stderr(e.message); return 2 } throw e }
  const lanes = await loadLanes()
  if (lanes.stubbed.length) io.stderr(`doctor: stubbed lanes (not found): ${lanes.stubbed.join(', ')} — their findings are absent from this run`)
  let target
  try { target = resolveTarget(opts.dir, lanes.listModules) } catch (e) { if (e instanceof UsageError) { io.stderr(e.message); return 2 } throw e }
  const outDir = path.resolve(opts.out)
  const inside = outInside(outDir, [target.root])
  if (inside) { io.stderr(`--out ${outDir} lies inside the judged folder ${inside}; choose an --out elsewhere`); return 2 }
  if (opts.write && target.mode === 'corpus' && !opts.yesCorpus) { io.stderr(`--write over a corpus of ${target.modules.length} folders needs --yes-corpus`); return 2 }
  let envKeys = new Set()
  if (opts.envKeys) {
    try { envKeys = readEnvKeyNames(opts.envKeys) } catch (e) { io.stderr(`--env-keys ${opts.envKeys}: ${e.message}`); return 2 }
  } else io.stderr('doctor: no --env-keys file — N2op (operator .env keys) is 0 by construction')
  const say = opts.json ? io.stderr : io.stdout
  const refused = []
  let reports
  try {
    fs.mkdirSync(path.join(outDir, 'doctor'), { recursive: true })
    reports = await pool(target.modules, opts.jobs, async (m) => {
      const st = await lanes.runStatic({ id: m.id, dir: m.dir, rules: lanes.rules, envKeys })
      const meta = await lanes.readMeta({ dir: m.dir })
      const rewrites = await lanes.rewriteModule({ id: m.id, dir: m.dir })
      let probe
      if (!m.hasBackend) probe = { runtime: { state: 'no-backend' }, tailwind: null }
      else if (opts.noProbe) probe = { runtime: { state: 'skipped' }, tailwind: null }
      else probe = await lanes.probeModule({ id: m.id, dir: m.dir, out: outDir, name: meta.moduleJson?.name ?? m.id, chrome: opts.chrome })
      const report = mergeModule({ id: m.id, dir: m.dir, daily: isDaily(m.id), static: st, meta, rewrites, runtime: probe?.runtime, tailwind: probe?.tailwind, rules: lanes.rules, envKeys, classifyEnv: lanes.classifyEnv, constants: lanes.constants })
      writeModuleOut({ outDir, report, rewrites })
      if (opts.write) {
        try {
          const w = applyWrite({ dir: m.dir, moduleJson: report.moduleJson, rewrites, writePartial: opts.writePartial })
          if (w.length) io.stderr(`doctor: wrote ${w.map((f) => path.join(m.id, f)).join(', ')}${report.rewriteLeftover.length ? ` (N1 partial — self-pathed data/ stays at ${report.rewriteLeftover.join(', ')})` : ''}`)
        } catch (e) { if (e instanceof WriteRefused) { refused.push(e.message); io.stderr(e.message) } else throw e }
      }
      say(report.verdict.line)
      return report
    })
  } catch (e) {
    const line = failVerdict(`${e?.message ?? e}${e?.stack ? '\n' + e.stack.split('\n').slice(1, 4).join('\n') : ''}`)
    io.stderr(line)
    try { fs.mkdirSync(path.join(outDir, 'doctor'), { recursive: true }); fs.writeFileSync(path.join(outDir, 'doctor', 'verdict.txt'), line.split('\n')[0] + '\n') } catch {}
    return 1
  }
  const rows = buildRows(reports)
  const summary = summaryOf(rows, reports, lanes.rules)
  summary.stubbedLanes = lanes.stubbed
  const verdictLine = refused.length ? failVerdict(`--write refused for ${refused.length} folder(s): ${refused.join('; ')}`) : finalVerdict(rows, summary)
  writeCorpusOut({ outDir, rows, rules: lanes.rules, summary, verdictLine })
  if (opts.json) io.stdout(JSON.stringify(summary, null, 2))
  else io.stdout(rowsMd(rows, lanes.rules).trimEnd())
  say(verdictLine)
  if (opts.json) io.stderr(verdictLine)
  return refused.length ? 2 : 0
}

// the entry guard compares REAL paths (host/entry.mjs) — the skills dir links this file (/work/.claude/skills/atelier-app → doctor/),
// and the old `new URL(...).pathname` compare was also wrong for a path with a space or a `%`
if (isMain(import.meta.url) || process.env.ATELIER_DOCTOR_MAIN === '1' || (process.argv[1] && /(^|\/)cli\.js$/.test(process.argv[1]))) {
  process.exitCode = await run(process.argv.slice(2))
}
