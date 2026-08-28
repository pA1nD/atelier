// build.mjs — the client bundle the shell serves at /assets/client.js (shell/DESIGN.md §4).
// esbuild over client/client.jsx: classic JSX runtime (`React.createElement` against the UMD
// global), ES2020, format esm, ONE bundle (client/{bridge,self,route,sheet,picker,reporter,
// waking}.js and ../chrome-resolve.js inlined — the browser fetches one file). `minify` for
// production. Returns the JS text and the newest source mtime (the ETag).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuildBuild } from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const CLIENT_ENTRY = path.join(HERE, 'client.jsx')
export const TEMPLATE = path.join(HERE, 'index.html')
export const SLOTS = ['<!--__STYLES__-->', '<!--__BOOTSTRAP__-->', '<!--__IMPORTMAP__-->', '<!--__PRELOADS__-->', '<!--__CLIENT__-->']   // = shell/document.mjs SLOTS, in head order

export function clientSources() {
  const files = [CLIENT_ENTRY, path.join(HERE, '..', 'chrome-resolve.js')]
  for (const f of fs.readdirSync(HERE)) if (f.endsWith('.js') && f !== 'build.mjs') files.push(path.join(HERE, f))
  return files
}

export function clientMtime() {
  let m = 0
  for (const f of clientSources()) { try { m = Math.max(m, fs.statSync(f).mtimeMs) } catch {} }
  return m
}

export async function buildClient({ minify = false, sourcemap = false } = {}) {
  const r = await esbuildBuild({
    entryPoints: [CLIENT_ENTRY], bundle: true, write: false,
    format: 'esm', platform: 'browser', target: 'es2020',
    loader: { '.jsx': 'jsx', '.js': 'js' }, jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment',
    minify, sourcemap: sourcemap ? 'inline' : false, legalComments: 'none', logLevel: 'silent',
  })
  return { js: r.outputFiles[0].text, mtime: clientMtime() }
}

export function readTemplate() { return fs.readFileSync(TEMPLATE, 'utf8') }
