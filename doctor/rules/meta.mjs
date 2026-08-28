// doctor/rules/meta.mjs — `export const meta` → module.json (PLAN OR10, DESIGN §3; rules N10, N11, D5, I3).
//
//   extractMetaStatically(src)  the 1.x reader verbatim (server.js extractMetaStatically): a brace-balanced
//                               literal evaluated in an empty scope → {meta} | {meta:{}, error}. No sandbox
//                               fallback: a computed meta is a `degrades` finding, not a child process.
//   metaOf(src)                 {declared, literal, computed, error, meta, keys}
//   moduleJsonOf(meta)          {json, dropped:[{key, rule, reason}]} — {name, icon, group, primary, color}
//                               in that order, only the keys present; every other key dropped and named
//   serializeModuleJson(json)   2-space JSON + newline (the bytes written to <out>/doctor/<module>/module.json)
//   readMeta({dir})             lane C's entry: frontend.jsx → {declared, literal, computed, error, keys, meta,
//                               moduleJson, dropped, existing} (existing = checkExistingModuleJson)
//   checkExistingModuleJson(dir)  the host's validator (host/supervisor/discovery.mjs checkModuleJson):
//                               {present:false} | {present:true, ok, json, dropped, invalid, error}
import nodeFs from 'node:fs'
import path from 'node:path'
import { checkModuleJson } from '../../host/supervisor/discovery.mjs'
import { META_KEYS, DROPPED_META_KEYS } from './catalogue.mjs'

export function extractMetaStatically(src) {
  const re = /export\s+const\s+meta\s*=\s*\{/.exec(src)
  if (!re) return { meta: {} }
  const start = src.indexOf('{', re.index)
  if (start < 0) return { meta: {} }
  let depth = 0
  let str = null
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (str) {
      if (c === '\\') { i++; continue }
      if (c === str) str = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { str = c; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        try { return { meta: new Function('return (' + src.slice(start, i + 1) + ')')() || {} } }
        catch (e) { return { meta: {}, error: e.message } }
      }
    }
  }
  return { meta: {} }
}

export const META_DECLARED_RE = /export\s+const\s+meta\s*=/

export function metaOf(src) {
  const declared = META_DECLARED_RE.test(src)
  const st = declared ? extractMetaStatically(src) : { meta: {} }
  const literal = declared && Object.keys(st.meta).length > 0
  return {
    declared, literal, computed: declared && !literal,
    error: st.error || null, meta: st.meta, keys: Object.keys(st.meta),
    line: declared ? src.slice(0, META_DECLARED_RE.exec(src).index).split('\n').length : 0,
  }
}

export function moduleJsonOf(meta) {
  const json = {}
  for (const k of META_KEYS) if (meta[k] !== undefined) json[k] = meta[k]
  const dropped = Object.keys(meta)
    .filter((k) => !META_KEYS.includes(k))
    .map((key) => ({ key, ...(DROPPED_META_KEYS[key] ?? DROPPED_META_KEYS['*']) }))
  return { json, dropped }
}

export function serializeModuleJson(json) {
  return JSON.stringify(json, null, 2) + '\n'
}

export function checkExistingModuleJson(dir, fs = nodeFs) {
  if (!fs.existsSync(path.join(dir, 'module.json'))) return { present: false }
  const c = checkModuleJson(dir, fs)
  if (!c.ok) return { present: true, ok: false, error: c.error, dropped: [], invalid: [] }
  return { present: true, ok: true, json: c.json, meta: c.meta, requested: c.requested, dropped: c.dropped, invalid: c.invalid }
}

export async function readMeta({ dir, fs = nodeFs }) {
  const file = path.join(dir, 'frontend.jsx')
  const existing = checkExistingModuleJson(dir, fs)
  if (!fs.existsSync(file)) return { declared: false, literal: false, computed: false, error: null, keys: [], meta: {}, moduleJson: null, dropped: [], existing }
  const m = metaOf(fs.readFileSync(file, 'utf8'))
  const mj = m.literal ? moduleJsonOf(m.meta) : { json: null, dropped: [] }
  return { ...m, moduleJson: mj.json, dropped: mj.dropped, existing }
}
