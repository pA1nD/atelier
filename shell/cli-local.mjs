// shell/cli-local.mjs — `npx atelier`: 2.0 local mode (DESIGN §5). One shell on the port 1.x used
// (config `port` | env PORT | `--port=N` | 1844) in front of one host process per non-empty
// workspace (`global` = host 0), each on loopback ports P+10+k (dev shell) and P+20+k (protocol).
//
//   1. the instance folder as 1.x resolved it (discovery.js resolveRoot), atelier.config.json read once
//      for settings (live for the module list), the ignored settings printed once
//   2. discover (1.x rules, the config filter, path entries; ids and workspaces must be slugs), elect
//      the chrome, write module.json where a module has none
//   3. stage: <root>/.atelier/local/<ws>/apps/<id> → the module folder (symlinks)
//   4. mint a dev token per host (0600), spawn the hosts (host/index.mjs, local mode), start the shell
//   5. watch the root and every $<ws>/ folder: a new/removed module or a config change → rescan →
//      restage → hosts.sync → workspace.onChange (the registry's rail refresh)
//   6. SIGINT/SIGTERM: close the shell, SIGTERM every host, wait ≤ 5 s, exit
//
// `atelier <id>` (standalone) and the collection verbs never reach this file (cli.js dispatch).
import fs from 'node:fs'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isMain } from '../host/entry.mjs'
import { resolveRoot, loadConfig, isWorkspaceDir, CONFIG_FILENAME } from '../discovery.js'
import { discover, ensureModuleJson } from './local/discover.mjs'
import { stage } from './local/stage.mjs'
import { createHosts, portPlan, STOP_GRACE_MS } from './local/hosts.mjs'
import { settings, ignoredSettings, parseFlags } from './local/settings.mjs'
import { startShell as stubShell } from './local/serve.mjs'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const RESCAN_DEBOUNCE_MS = 300
export const JAIL_LINE = 'jail: lifecycle-only (no uid drop) — apps are not isolated from each other on this machine'

// plan(root, { defaultChrome, log }) → { modules, chrome, refused, staged } — one discovery + staging pass;
// the chrome is staged as an app too (its backend answers under /api/global/<chrome>, DESIGN §8)
export function plan(root, { defaultChrome = null, log = () => {} } = {}) {
  const d = discover(root, { log, defaultChrome })
  for (const r of d.refused) log(`! ${r.reason} (${r.dir})`)
  const toStage = d.modules.filter((m) => !m.isChrome || m === d.chrome)
  for (const m of toStage) ensureModuleJson(m, { log })
  const staged = stage(root, toStage, { log })
  return { ...d, staged }
}

export async function main({
  argv = process.argv.slice(2), env = process.env, cwd = process.cwd(), stderr = process.stderr,
  spawn = nodeSpawn, signals = process, exit = (c) => process.exit(c), startShell = stubShell,
  graceMs = STOP_GRACE_MS, watch = true, open = null,
} = {}) {
  const say = (line) => { try { stderr.write(`${line}\n`) } catch {} }
  const flags = parseFlags(argv)
  if (flags.error) { say(flags.error); exit(2); return null }

  const root = resolveRoot({ atelierRoot: env.ATELIER_ROOT, pwd: env.PWD ?? cwd, hostDir: REPO_ROOT })
  const config = loadConfig(root)
  const s = settings(config, env, flags)
  for (const line of ignoredSettings(config)) say(line)

  const first = plan(root, { defaultChrome: s.defaultChrome, log: say })
  const chromeDir = first.chrome ? path.resolve(first.chrome.dir) : null
  const hosts = createHosts({ root, port: s.port, chromeDir, nodeEnv: s.nodeEnv, spawn, log: say, env })
  const listeners = new Set()
  const workspace = {
    root, config, settings: s, chrome: first.chrome, hosts,
    discover: () => current.modules,            // registry-local's `discover()`: the rows of the last scan (sync)
    staged: () => current.staged,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },   // registry-local's `refresh()` hooks here
  }
  let current = first
  const cfg = { mode: 'local', port: s.port, bind: s.bind, origin: () => s.baseUrl, chromeQid: first.chrome?.qid ?? null, chromeDir, nodeEnv: s.nodeEnv, label: s.label, portalOrigin: null }
  const shell = startShell({ cfg, workspace, log: say })

  await hosts.sync(first.staged.workspaces)
  const listening = await shell.listen()
  say(`Atelier · local · ${root} · http://localhost:${listening.port}${s.label ? ` · ${s.label}` : ''}`)
  say(JAIL_LINE)
  say(first.chrome ? `chrome: ${first.chrome.qid} (${chromeDir})` : 'chrome: none (app-less documents)')
  for (const h of hosts.list()) say(`[${h.ws}] host ${h.k} → dev 127.0.0.1:${h.devPort} · protocol 127.0.0.1:${h.hostPort} · ${h.work}`)
  if (!first.staged.workspaces.length) say(`no modules found under ${root} (a module is a folder with frontend.jsx or backend.js)`)

  // the live module list: the root (modules, $<ws>/ folders, atelier.config.json) and each workspace folder
  const watches = new Map()
  let timer = null, scanning = null
  const rescan = () => {
    if (scanning) return scanning
    scanning = (async () => {
      const next = plan(root, { defaultChrome: s.defaultChrome, log: say })
      const before = current
      current = next
      if ((next.chrome?.qid ?? null) !== (before.chrome?.qid ?? null)) say(`chrome changed to ${next.chrome?.qid ?? 'none'} — restart atelier to apply it (one chrome per run)`)
      await hosts.sync(next.staged.workspaces)
      syncWatches()
      for (const fn of listeners) { try { fn() } catch (e) { say(`onChange: ${e.message}`) } }
    })().finally(() => { scanning = null })
    return scanning
  }
  const debounced = () => { clearTimeout(timer); timer = setTimeout(() => rescan().catch((e) => say(`rescan: ${e.message}`)), RESCAN_DEBOUNCE_MS) }
  const syncWatches = () => {
    if (!watch) return
    const want = new Set([root])
    let names = []
    try { names = fs.readdirSync(root) } catch {}
    for (const n of names) if (isWorkspaceDir(n)) want.add(path.join(root, n))
    for (const [d, w] of watches) if (!want.has(d)) { try { w.close() } catch {}; watches.delete(d) }
    for (const d of want) {
      if (watches.has(d)) continue
      try { const w = fs.watch(d, { persistent: false }, debounced); w.on('error', () => { try { w.close() } catch {}; watches.delete(d) }); watches.set(d, w) } catch (e) { say(`watch ${d}: ${e.code ?? e.message}`) }
    }
  }
  syncWatches()

  if (flags.open) (open ?? openBrowser)(`http://localhost:${listening.port}`)

  let stopping = false
  async function stop(signal) {
    if (stopping) return
    stopping = true
    say(`${signal} → stopping`)
    clearTimeout(timer)
    for (const w of watches.values()) { try { w.close() } catch {} }
    await shell.close().catch(() => {})
    await hosts.stopAll(graceMs)
    exit(0)
  }
  signals.on('SIGINT', () => stop('SIGINT'))
  signals.on('SIGTERM', () => stop('SIGTERM'))
  return { root, config, settings: s, hosts, shell, workspace, rescan, stop, port: listening.port }
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try { nodeSpawn(cmd, [url], { stdio: 'ignore', detached: true }).unref() } catch {}
}

// runs when this file is the entry, or when cli.js dispatched here (a test imports `main` with fakes) — REAL paths
// (host/entry.mjs): `npx atelier` runs the bin symlink, and a bare resolve compare made it a silent no-op
if (isMain(import.meta.url) || isMain(path.join(REPO_ROOT, 'cli.js'))) {
  main().catch((e) => { process.stderr.write(`atelier: ${e?.stack ?? e}\n`); process.exit(2) })
}
