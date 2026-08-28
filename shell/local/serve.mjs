// shell/local/serve.mjs — the shell `npx atelier` puts in front of the hosts: createShell (DESIGN
// §1–3) with the LOCAL providers built from what cli-local.mjs hands in as `workspace`:
//   hosts.workspaces() → [{id, port, token}]   registry-local's `workspaces()`  (one host per workspace)
//   discover()         → the rows of the last scan (sync)                       registry-local's `discover()`
//   chrome             → {qid, dir, …} the elected chrome (one per run)
//   onChange(fn)       → the CLI's rescan (apps root fs.watch, debounced) → registry.refresh() → the rail frame
// One Ed25519 minter per process; the dev token rides in `x-atelier-dev-token` from `hosts.row(ws)`
// (never in a URL); identity is the constant `local`; the gate answers null on every fleet-only lane.
import { createShell } from '../index.mjs'
import { createMinter } from '../minter.mjs'
import { DEFAULT_FONT_HOSTS } from '../config.mjs'
import { createIdentityLocal } from '../providers/identity-local.mjs'
import { createGateLocal } from '../providers/gate-local.mjs'
import { createHostLinkLocal } from '../providers/hostlink-local.mjs'
import { createRegistryLocal } from '../providers/registry-local.mjs'
import { createBusLocal } from '../providers/bus-local.mjs'

/** startShell({ cfg, workspace, log }) → { listen(): Promise<{port}>, close(): Promise<void>, shell, providers, kind } */
export function startShell({ cfg, workspace, log = () => {} }) {
  const shellCfg = { csp: { fontHosts: DEFAULT_FONT_HOSTS }, ...cfg, origin: cfg.origin ?? (() => `http://localhost:${cfg.port}`) }
  const minter = createMinter()
  const hostLink = createHostLinkLocal({ minter, log })
  const chrome = workspace.chrome ? { qid: workspace.chrome.qid, dir: workspace.chrome.dir } : null
  const registry = createRegistryLocal({ workspaces: () => workspace.hosts.workspaces(), discover: () => workspace.discover(), chrome, hostLink, log })
  const bus = createBusLocal({ registry, hostLink, log })
  const providers = { identity: createIdentityLocal(), gate: createGateLocal(), registry, bus, hostLink }
  const shell = createShell({ cfg: shellCfg, providers, log })
  const offChange = workspace.onChange?.(() => { registry.refresh().catch((e) => log(`registry refresh: ${e.message}`)) })
  return {
    kind: 'shell', shell, providers, minter,
    async listen() { shell.start(); return shell.listen({ port: shellCfg.port, host: shellCfg.bind }) },
    async close() { offChange?.(); await shell.close(500) },
  }
}
