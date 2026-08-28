// shell/local/stage.mjs — the symlink tree under `<root>/.atelier/local/<ws>/` (DESIGN §5.3 step 4).
//
// Every host reads `$ATELIER_WORK/apps`; local mode gives each workspace its own `ATELIER_WORK`
// (`<root>/.atelier/local/<ws>`) whose `apps/<id>` is a symlink to the module folder — a real dir,
// so relative imports, `data/`, `node_modules` resolve in place — and the host takes the links
// (ATELIER_APPS_LINKS=1, host H1). `<root>/.atelier/` is a dotdir, so 1.x discovery ignores it.
// Stale links are removed; anything that is not a symlink (a real folder someone put there) is left
// and named — staging never deletes a directory.
import nodeFs from 'node:fs'
import path from 'node:path'

export const LOCAL_DIR = path.join('.atelier', 'local')
export const workOf = (root, ws) => path.join(root, LOCAL_DIR, ws)
// hosts are numbered k = 0… in this order: `global` first (host 0, DESIGN §5.2), then alphabetical
export const orderWorkspaces = (ids) => [...new Set(ids)].sort((a, b) => (a === 'global' ? -1 : b === 'global' ? 1 : a.localeCompare(b)))

/**
 * stage(root, modules, { fs, log }) → { workspaces: [{ id, work, apps: [{ id, dir, link }] }] }
 *   modules: discover() rows (workspace, id, dir); one entry per non-empty workspace, in host order
 */
export function stage(root, modules, { fs = nodeFs, log = () => {} } = {}) {
  const byWs = new Map()
  for (const m of modules) { if (!byWs.has(m.workspace)) byWs.set(m.workspace, []); byWs.get(m.workspace).push(m) }
  const workspaces = []
  for (const ws of orderWorkspaces([...byWs.keys()])) {
    const work = workOf(root, ws), appsDir = path.join(work, 'apps')
    fs.mkdirSync(appsDir, { recursive: true })
    const want = new Map(byWs.get(ws).map((m) => [m.id, path.resolve(m.dir)]))
    let present = []
    try { present = fs.readdirSync(appsDir, { withFileTypes: true }) } catch {}
    for (const ent of present) {
      const link = path.join(appsDir, ent.name)
      if (!ent.isSymbolicLink()) { if (!want.has(ent.name)) log(`! ${link} is not a link — left in place (staging never removes a real folder)`); continue }
      let target = null
      try { target = fs.readlinkSync(link) } catch {}
      if (want.get(ent.name) === target) { want.set(ent.name, null); continue }   // already right
      fs.unlinkSync(link)
      if (!want.has(ent.name)) log(`unlinked stale ${link}`)
    }
    const apps = []
    for (const m of byWs.get(ws)) {
      const link = path.join(appsDir, m.id), target = path.resolve(m.dir)
      const pending = want.get(m.id)
      if (pending !== null) {
        let blocked = false
        try { blocked = !fs.lstatSync(link).isSymbolicLink() } catch {}
        if (blocked) { log(`! ${link} exists and is not a link — '${m.qid ?? m.id}' is not staged`); continue }
        fs.symlinkSync(target, link)
      }
      apps.push({ id: m.id, dir: target, link })
    }
    workspaces.push({ id: ws, work, apps })
  }
  return { workspaces }
}
