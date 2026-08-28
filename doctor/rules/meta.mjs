// doctor/rules/meta.mjs — `export const meta` → module.json (PLAN OR10, DESIGN §3; rules N10, N11, D5, I3).
//
//   extractMetaStatically(src)  the 1.x reader's balancer (server.js extractMetaStatically) with the evaluation
//                               gated: the brace-balanced slice is tokenised (pureLiteral) and evaluated only
//                               when it is a pure literal — strings, numbers, true/false/null/undefined,
//                               nested {}/[] and plain keys. An identifier in value position, a call, an
//                               operator or a template hole → {meta:{}, error:'computed meta: <token>'} —
//                               nothing from the judged folder ever runs in the doctor's process. No sandbox
//                               fallback: a computed meta is a `degrades` finding, not a child process.
//   metaOf(src)                 {declared, literal, computed, error, meta, keys}
//   moduleJsonOf(meta)          {json, dropped:[{key, rule, reason}]} — {name, icon, group, primary, color}
//                               in that order, only the keys present; every other key dropped and named
//                               (a meta with isChrome:true is D14: the callers generate no module.json)
//   serializeModuleJson(json)   2-space JSON + newline (the bytes written to <out>/doctor/<module>/module.json)
//   readMeta({dir})             lane C's entry: frontend.jsx → {declared, literal, computed, error, keys, meta,
//                               moduleJson, dropped, existing} (existing = checkExistingModuleJson)
//   checkExistingModuleJson(dir)  the host's validator (host/supervisor/discovery.mjs checkModuleJson):
//                               {present:false} | {present:true, ok, json, dropped, invalid, error}
import nodeFs from 'node:fs'
import path from 'node:path'
import { checkModuleJson } from '../../host/supervisor/discovery.mjs'
import { META_KEYS, DROPPED_META_KEYS } from './catalogue.mjs'

// pureLiteral(slice) → null when the slice is a literal object, else the first offending token.
const NUMBER = /^[+-]?(?:0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)/
const IDENT = /^[A-Za-z_$][\w$]*/
const LITERAL_IDENT = new Set(['true', 'false', 'null', 'undefined'])
export function pureLiteral(slice) {
  let i = 0
  const n = slice.length
  while (i < n) {
    const c = slice[i]
    if (/\s/.test(c)) { i++; continue }
    if (c === '/' && slice[i + 1] === '/') { const e = slice.indexOf('\n', i); i = e < 0 ? n : e; continue }
    if (c === '/' && slice[i + 1] === '*') { const e = slice.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < n && slice[j] !== c) {
        if (slice[j] === '\\') j++
        else if (c === '`' && slice[j] === '$' && slice[j + 1] === '{') return '${'
        j++
      }
      i = j + 1; continue
    }
    if ('{}[]:,'.includes(c)) { i++; continue }
    const num = NUMBER.exec(slice.slice(i))
    if (num) { i += num[0].length; continue }
    const id = IDENT.exec(slice.slice(i))
    if (id) {
      const after = slice.slice(i + id[0].length).replace(/^\s+/, '')
      if (LITERAL_IDENT.has(id[0]) || after[0] === ':') { i += id[0].length; continue }
      return id[0]
    }
    return c
  }
  return null
}

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
        const slice = src.slice(start, i + 1)
        const bad = pureLiteral(slice)
        if (bad !== null) return { meta: {}, error: `computed meta: ${bad}` }
        try { return { meta: new Function('return (' + slice + ')')() || {} } }
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
  const mj = m.literal && !m.meta.isChrome ? moduleJsonOf(m.meta) : { json: null, dropped: [] }
  return { ...m, moduleJson: mj.json, dropped: mj.dropped, existing }
}
