// shell/document.mjs — the company document (DESIGN §2.1–2.3; PLAN §4.1).
//
// Pure composition: the bootstrap object, its escaping, the head in the contract order, the
// preload list, the CSP. Nothing here reads a file or dials a host — `assets.mjs` hands in the
// template, `routes.mjs` hands in the registry rows and the app entry's relative imports.
//
// Head order is contract [S:migration-local-3]: (1) ONE render-blocking sheet, (2) the React UMDs,
// (3) the bootstrap, (4) the import map, (5) the modulepreloads — AFTER the import map, always: a
// preload before it resolves `@atelier/kit` eagerly, caches the failure and the later `import()`
// dies with zero network errors — (6) the client module. The template (client/index.html, lane C)
// carries the five slots below; the built-in fallback is the same skeleton so the shell composes
// without the fork present.
import { randomBytes } from 'node:crypto'
import { asDigest } from '../protocol/index.js'

export const SLOTS = {
  styles: '<!--__STYLES__-->',
  bootstrap: '<!--__BOOTSTRAP__-->',
  importmap: '<!--__IMPORTMAP__-->',
  preloads: '<!--__PRELOADS__-->',
  client: '<!--__CLIENT__-->',
}
export const CHROME_API = 2
export const SHEET_ID = 'atelier-chrome-styles'
export const CLIENT_JS = '/assets/client.js'
export const CHROME_RESOLVE_JS = '/assets/chrome-resolve.js'

export const FALLBACK_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Atelier</title>
  <style>html{color-scheme:light dark}html,body{margin:0}</style>
  ${SLOTS.styles}
  <script src="/assets/react.js"></script>
  <script src="/assets/react-dom.js"></script>
  ${SLOTS.bootstrap}
  ${SLOTS.importmap}
  ${SLOTS.preloads}
</head>
<body>
  <div id="root"></div>
  ${SLOTS.client}
</body>
</html>
`

export const hasSlots = (template) => Object.values(SLOTS).every((s) => template.includes(s))
export const newNonce = () => randomBytes(16).toString('base64url')

// escapeBootstrap(obj): JSON with `<` → < (no `</script>` can close the tag), U+2028/9 escaped
// (valid JSON, invalid JS source before ES2019 — Safari), functions dropped by the replacer.
export function escapeBootstrap(obj) {
  return JSON.stringify(obj, (k, v) => (typeof v === 'function' ? undefined : v))
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

// relativeImports(code) → ["./x.js", …] the STATIC `from "./x"` / `import "./x"` specifiers of an
// entry — what the browser fetches next (depth 2 of the critical path); a dynamic `import()` is not
// preloaded. `.jsx` is served as `.js`.
export function relativeImports(code) {
  const out = new Set()
  for (const m of String(code).matchAll(/\b(?:from|import)\s*["'](\.\.?\/[^"']+)["']/g)) out.add(m[1].replace(/[?#].*$/, '').replace(/\.jsx$/, '.js'))   // the host versions relative imports (`./x.js?rev=N`): the preload adds its own ?rev
  return [...out]
}

// a row's `chromeDigest` (the digest its computer reports, step 7 ship C) rides only when there is one — 64 hex, the
// same rule the document is composed by (routes.mjs chromeShape), so the client never compares against a digest the
// shell did not render: a document with no release in play is byte for byte the step-5 document
const moduleRow = (r) => ({
  id: r.slug, instance: r.instance, rev: assetRev(r), hasFrontend: r.hasFrontend !== false,
  meta: { ...(r.meta ?? {}), ...(r.primary ? { primary: true } : {}) },
  ...(asDigest(r.chromeDigest) ? { chromeDigest: r.chromeDigest } : {}),
})

/**
 * bootstrapFor({cfg, company, slug, person, modules, chrome, companies, portal})
 *   modules: registry AppRow[] of the company; chrome: {qid, rev, base?} — `base` (`/_chrome/<digest>`, step 7 ship C)
 *   rides into the bootstrap as `chromeBase` only when the document is composed by digest; `chromeRev` is then the digest
 */
export function bootstrapFor({ cfg = {}, company, slug = null, person, modules = [], chrome, companies = [], portal = null }) {
  const rows = modules.filter((r) => r.instance).map(moduleRow)
  const active = slug && rows.some((r) => r.id === slug) ? `${company}/${slug}` : null
  const chromeQid = chrome?.qid ?? null
  return {
    mode: 'host', label: cfg.label ?? null, observe: false,
    chromeApi: CHROME_API,
    // `logout`: the identity provider's sign-out door (fleet: the portal's /logout) — the chrome's account menu offers Sign out
    user: { id: person.id, name: person.name, epoch: person.epoch ?? null, ...(person.logout ? { logout: person.logout } : {}), workspaces: [{ id: company, name: company, modules: rows }] },
    workspace: company, workspaces: [{ id: company, name: company }],
    companies, portal,
    activeQid: active,
    chromeQid, defaultChromeQid: chromeQid, chromes: chromeQid ? [chromeQid] : [],
    chromeRev: chrome?.rev ?? null,
    ...(chrome?.base ? { chromeBase: chrome.base } : {}),
    backendErrors: [],
  }
}

// THE URL NAMES THE BYTES (2026-09-05): a row's asset rides under its CONTENT id — `deployed_rev`, the hash of what the
// host built — never the row's counter alone: counters restart with the row (a re-seeded host starts at 1 again) and a
// cache in front (the browser's, Cloudflare's, max-age from the host) then hands out yesterday's sheet for today's
// `?rev=1`. Same bytes, same URL; new bytes, new URL — on every plane, no purge. The counter stays the fallback for a row
// the registry knows no content id for (a bare dev row).
export const assetRev = (r) => (r?.deployed_rev != null && r.deployed_rev !== '' ? String(r.deployed_rev) : (r?.rev ?? null))
const q = (rev) => (rev === null || rev === undefined ? '' : `?rev=${encodeURIComponent(String(rev))}`)
export const appAsset = (company, slug, file, rev) => `/modules/${encodeURIComponent(company)}/${encodeURIComponent(slug)}/${file}${q(rev)}`
// chromeAsset(): by digest the immutable `/_chrome/<digest>/<file>` (no `?rev=`: the URL names the bytes), else the
// chrome row's `/modules/<qid>/<file>?rev=` as before
export const chromeAsset = (chrome, file) => (chrome.base ? `${chrome.base}/${file}` : `/modules/${chrome.qid}/${file}${q(chrome.rev)}`)

// sheetFor(): the ONE render-blocking sheet — the app's on /<c>/<s>, the chrome's on an app-less document (by digest the
// bundle's compiled chrome-only sheet `chrome.css`; the row's `styles.css` otherwise)
export function sheetFor({ company, slug, modules, chrome }) {
  const app = slug ? modules.find((r) => r.slug === slug && r.instance) : null
  if (app) return appAsset(company, slug, 'styles.css', assetRev(app))
  if (chrome?.qid && chrome.base) return chromeAsset(chrome, 'chrome.css')
  if (chrome?.qid && chrome.hasStyles !== false) return chromeAsset(chrome, 'styles.css')
  return null
}

// preloadsFor(): client, chrome-resolve, the chrome bundle, kit, the app entry and its relative imports
export function preloadsFor({ company, slug, modules, chrome, entryImports = [], assetVersion = null }) {
  const out = [versioned(CLIENT_JS, assetVersion), versioned(CHROME_RESOLVE_JS, assetVersion)]
  if (chrome?.qid) { out.push(chromeAsset(chrome, 'frontend.js')); if (chrome.hasKit) out.push(chromeAsset(chrome, 'kit.js')) }
  const app = slug ? modules.find((r) => r.slug === slug && r.instance) : null
  if (app) {
    out.push(appAsset(company, slug, 'frontend.js', assetRev(app)))
    for (const rel of entryImports) if (rel.startsWith('./')) out.push(appAsset(company, slug, rel.slice(2), assetRev(app)))
  }
  return out
}

const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/**
 * composeDocument({template, nonce, bootstrap, bootstrapJson, sheet, importMap, preloads}) → html
 *   importMap:     {imports} | null
 *   bootstrapJson: the escaped bootstrap, when the caller already has it (renderDocument measures
 *                  its bytes for the metrics row and does not pay a second escape)
 */
// versioned(u, assetVersion): the shell's own asset under its content hash (`?v=`), bare when the shell knows none
export const versioned = (u, assetVersion) => { const v = assetVersion?.(u); return v ? u + '?v=' + encodeURIComponent(v) : u }
export function composeDocument({ template = FALLBACK_TEMPLATE, nonce, bootstrap, bootstrapJson = escapeBootstrap(bootstrap), sheet, importMap, preloads = [], assetVersion = null }) {
  if (!hasSlots(template)) throw new Error('document: the template lacks a slot (' + Object.values(SLOTS).join(' ') + ')')
  const pre = preloads.map((u) => `<link rel="modulepreload" href="${attr(u)}">`).join('\n  ')
  return template
    .replace(SLOTS.styles, sheet ? `<link id="${SHEET_ID}" rel="stylesheet" href="${attr(sheet)}">` : '')
    .replace(SLOTS.bootstrap, `<script nonce="${attr(nonce)}">window.__ATELIER__ = ${bootstrapJson};</script>`)
    .replace(SLOTS.importmap, importMap ? `<script type="importmap" nonce="${attr(nonce)}">${escapeBootstrap(importMap)}</script>` : '')
    .replace(SLOTS.preloads, pre)
    .replace(SLOTS.client, `<script type="module" src="${attr(versioned(CLIENT_JS, assetVersion))}"></script>`)
    .replace(/src="(\/assets\/react(?:-dom)?\.js)"/g, (_, u) => `src="${attr(versioned(u, assetVersion))}"`)
}

// renderDocument(): the whole thing for one route — what routes.mjs calls. `bootstrapBytes` is
// PLAN §4.5's bootstrap-bytes row (shell/metrics.mjs): what the shell composed into the page.
export function renderDocument({ cfg = {}, template, company, slug = null, person, modules = [], chrome = null, companies = [], portal = null, entryImports = [], nonce = newNonce(), assetVersion = null }) {
  const bootstrap = bootstrapFor({ cfg, company, slug, person, modules, chrome, companies, portal })
  const bootstrapJson = escapeBootstrap(bootstrap)
  const sheet = sheetFor({ company, slug, modules, chrome })
  const importMap = chrome?.qid && chrome.hasKit ? { imports: { '@atelier/kit': chromeAsset(chrome, 'kit.js') } } : null
  const preloads = preloadsFor({ company, slug, modules, chrome, entryImports, assetVersion })
  const html = composeDocument({ template, nonce, bootstrap, bootstrapJson, sheet, importMap, preloads, assetVersion })
  return { html, nonce, bootstrap, bootstrapBytes: Buffer.byteLength(bootstrapJson), sheet, preloads, headers: documentHeaders({ cfg, nonce, portal }) }
}

// csp({nonce, fontHosts, portalOrigin}) — §2.3
export function csp({ nonce, fontHosts = [], portalOrigin = null }) {

  const fontsList = fontHosts.length ? ' ' + fontHosts.join(' ') : ''

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'unsafe-inline'${fontsList}`,
    `font-src 'self' data:${fontsList}`,
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    `form-action 'self'${portalOrigin ? ' ' + portalOrigin : ''}`,
    "object-src 'none'",
  ].join('; ')
}

export function documentHeaders({ cfg = {}, nonce, portal = null }) {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': csp({ nonce, fontHosts: cfg.csp?.fontHosts ?? [], portalOrigin: portal ?? cfg.portalOrigin ?? null }),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
  }
}
