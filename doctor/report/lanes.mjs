// doctor/report/lanes.mjs — the report lane's view of lanes A (rules/) and B (probe/), DESIGN §1.
// Each lane file is imported by its DESIGN name when it exists; a missing file is replaced by the stub
// below and named in `stubbed`, so the CLI runs (and says what it could not judge) before the other
// lanes land. THIS is the one place the export names are mapped — change the table, not the callers.
//
//   rules/catalogue.mjs   RULES (Rule[]), optional NODE_NOISE / IMAGE_BINS / SHELL_KEYS / LAPTOP_KEYS / ROW_W_ENV
//   rules/walk.mjs        listModules(corpusDir) → [{id, dir, hasFrontend, hasBackend}]
//   rules/static.mjs      runStatic({id, dir, rules, envKeys}) → {findings, cells?, hits?, files:{source, client, subfolderClient}, env:{KEY: class}, …}
//   rules/meta.mjs        readMeta({dir}) → {declared, literal, error, keys, meta, moduleJson, dropped:[{key, rule, reason}]}
//   rules/env.mjs         classifyEnv(key, envKeys) → 'operator'|'shell-published'|'node'|'laptop'|'config'|'other'
//   rules/rewrite.mjs     rewriteModule({id, dir}) → [{file, text, edits:[{line, from, to}]}]
//   probe/run.mjs         probeModule({id, dir, out, name}) → the runtime object (DESIGN §4; files under <out>/doctor/<id>/probe/)
//                         — wrapped below into {runtime, tailwind:null}; a lane returning {runtime, tailwind} passes through
import fs from 'node:fs'
import path from 'node:path'
import { SEED_RULES, NODE_NOISE, IMAGE_BINS, SHELL_KEYS, LAPTOP_KEYS, ROW_W_ENV } from './seed-rules.mjs'

const here = path.dirname(new URL(import.meta.url).pathname)
const laneFile = (rel) => path.join(here, '..', rel)

async function load(rel) {
  const p = laneFile(rel)
  if (!fs.existsSync(p)) return null
  return import(new URL(`file://${p}`).href)
}

/** The seed's `listModules`: children whose name starts alphanumeric and that carry frontend.jsx or backend.js. */
export function listModulesStub(corpusDir) {
  return fs.readdirSync(corpusDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^[a-zA-Z0-9]/.test(e.name))
    .map((e) => {
      const dir = path.join(corpusDir, e.name)
      return { id: e.name, dir, hasFrontend: fs.existsSync(path.join(dir, 'frontend.jsx')), hasBackend: fs.existsSync(path.join(dir, 'backend.js')) }
    })
    .filter((m) => m.hasFrontend || m.hasBackend)
}

/** A folder is one module when it carries frontend.jsx, backend.js or module.json. */
export function isModuleDir(dir) {
  return ['frontend.jsx', 'backend.js', 'module.json'].some((f) => fs.existsSync(path.join(dir, f)))
}

export function classifyEnvStub(key, envKeys = new Set()) {
  if (envKeys.has(key)) return 'operator'
  if (SHELL_KEYS.has(key)) return 'shell-published'
  if (NODE_NOISE.has(key)) return 'node'
  if (LAPTOP_KEYS.has(key)) return 'laptop'
  return 'config'
}

const STUBS = {
  rules: { RULES: SEED_RULES.map((r) => ({ ...r, detect: {}, rewrite: null, evidence: '' })), NODE_NOISE, IMAGE_BINS, SHELL_KEYS, LAPTOP_KEYS, ROW_W_ENV },
  walk: { listModules: listModulesStub },
  static: { runStatic: async () => ({ findings: [], cells: {}, files: { source: 0, client: 0, subfolderClient: 0 }, env: {} }) },
  meta: { readMeta: async () => ({ declared: false, literal: false, error: null, keys: [], meta: {}, moduleJson: null, dropped: [] }) },
  env: { classifyEnv: classifyEnvStub },
  rewrite: { rewriteModule: async () => [] },
  probe: { probeModule: async () => ({ runtime: { state: 'skipped' }, tailwind: { coldMs: null, longLines: 0 } }) },
}

const FILES = { rules: 'rules/catalogue.mjs', walk: 'rules/walk.mjs', static: 'rules/static.mjs', meta: 'rules/meta.mjs', env: 'rules/env.mjs', rewrite: 'rules/rewrite.mjs', probe: 'probe/run.mjs' }

/** Load every lane; `stubbed` lists the DESIGN file names that were not found. */
export async function loadLanes() {
  const stubbed = []
  const mods = {}
  for (const [k, rel] of Object.entries(FILES)) {
    const m = await load(rel)
    if (m) mods[k] = m
    else { mods[k] = STUBS[k]; stubbed.push(rel) }
  }
  const cat = mods.rules
  // probe/run.mjs's probeModule({id, dir, out, name}) returns the runtime object itself and lays its files out
  // under <out>/doctor/<id>/probe/; the report lane reads {runtime, tailwind}. Either return shape is accepted.
  const probeRaw = mods.probe.probeModule ?? STUBS.probe.probeModule
  const probeModule = async ({ id, dir, out, name, chrome }) => {
    const r = await probeRaw({ id, dir, out, name: name ?? id, chrome })
    return r && typeof r === 'object' && 'runtime' in r ? r : { runtime: r, tailwind: null }
  }
  return {
    rules: cat.RULES ?? cat.default ?? STUBS.rules.RULES,
    constants: { NODE_NOISE: cat.NODE_NOISE ?? NODE_NOISE, IMAGE_BINS: cat.IMAGE_BINS ?? IMAGE_BINS, SHELL_KEYS: cat.SHELL_KEYS ?? SHELL_KEYS, LAPTOP_KEYS: cat.LAPTOP_KEYS ?? LAPTOP_KEYS, ROW_W_ENV: cat.ROW_W_ENV ?? ROW_W_ENV },
    listModules: mods.walk.listModules ?? listModulesStub,
    runStatic: mods.static.runStatic ?? STUBS.static.runStatic,
    readMeta: mods.meta.readMeta ?? STUBS.meta.readMeta,
    classifyEnv: mods.env.classifyEnv ?? classifyEnvStub,
    rewriteModule: mods.rewrite.rewriteModule ?? STUBS.rewrite.rewriteModule,
    probeModule,
    stubbed,
  }
}
