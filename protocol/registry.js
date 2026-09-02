// Registry token scope + manifest meta allowlist (PLAN §4.4 "Registry writes", §2, OR12, OR20;
// seed spike-d1/registry.js:10 META_ALLOW, :37 allowMeta, :52-75 claimOrUpsert). Pure decisions:
// no sqlite, no http — the spine's SQLite store (§4.9 step 1) calls these and applies the answer.
//
// Rules (D1 tests 5-6, RESULT.md items 2-3, 5-6):
//   - the caller IS the token's computer; a body `computer` is ignored, a row owned by another
//     computer is 403 not-your-row.
//   - company DERIVES from the computer row (OR10, D1 item 3); a body company that differs is
//     409 company-is-fixed. The registry enforces the meta schema itself (D1 item 2): the
//     registrar's stripping is a courtesy, the token can reach the API without it.
//   - `primary` from module.json is a REQUEST (OR12, the R3-27 hole: an agent choosing the
//     company landing page). D1 let `primary` through; PLAN §4.4 does not. Split: allowMeta()
//     keeps {name, icon, group, color} as meta and returns {primary} as `requested` — the spine
//     stores it as requested_primary and applies it only from the portal / a confirmation.
//   - OR20 (2026-08-26): v1 has NO `visibility` field and no promotion verb — not in module.json,
//     not on the wire, not in the skill. A `visibility` key in module.json is an unknown key
//     (`dropped`, like `trusted`); a `visibility` field in the PUT body is 400 unknown-field.
//     The enum and the promotion verb return with the dyno target (PLAN §12), not before.
//     (Review 2026-08-26: the earlier "valid wire value, 403 no-promotion-in-v1" kept the verb's
//     shadow on the wire — exactly the surface the ruling removes.)
//   - reclaim (D1 items 5-6): a tombstoned slug is reserved 24 h against OTHER computers; the
//     owning computer adopts a live row / revives a tombstoned one (same instance id, data dir back).

import { createHash } from 'node:crypto'

// One DNS label, no leading/trailing `-` (§2). Shared by company ids and app slugs.
export const SLUG_RE = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/
// §2 verbatim: `api assets modules global atelier portal apps www go` (`go`: the portal's /go route,
// agent-contract-6; `modules`/`api`: B6 surprise 7) plus the `p-*` prefix for personal spaces.
export const RESERVED_COMPANY_IDS = ['api', 'assets', 'modules', 'global', 'atelier', 'portal', 'apps', 'www', 'go']
export const RESERVED_COMPANY_PREFIX = 'p-'      // personal spaces (OR4) are minted by the spine, never claimed
export const META_ALLOW = ['name', 'icon', 'group', 'primary', 'color']   // module.json keys read at all (OR12 minus visibility, OR20)
export const META_KEEP = ['name', 'icon', 'group', 'color']              // registrar-writable meta (§4.4)
export const META_REQUEST = ['primary']                                  // recorded as a request, never applied
export const BODY_KEYS = ['slug', 'company', 'meta', 'computer']         // the PUT body; anything else is 400 unknown-field
export const TOMBSTONE_MS = 24 * 3600 * 1000
export const LIMITS = { name: 64, group: 32, iconCodepoints: 8, iconToken: 64 }

const COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const ICON_TOKEN_RE = /^[a-z0-9][a-z0-9:_./-]{0,63}$/
const validators = {
  name: (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= LIMITS.name,
  group: (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= LIMITS.group,
  icon: (v) => typeof v === 'string' && v.length > 0 && ([...v].length <= LIMITS.iconCodepoints || ICON_TOKEN_RE.test(v)),
  color: (v) => typeof v === 'string' && COLOR_RE.test(v),
  primary: (v) => typeof v === 'boolean',
}

// ---- chrome releases (step 7 ship C, R-CHROME; LANES-CHROME decision 3): the digest rule the verb
// computes, the spine checks end to end (registry/protocol.ts), the shell keys its store by and the
// host verifies a fetched bundle against. A bundle = `{frontend.js, kit.js, styles.css, chrome.css,
// fonts/*.woff2}`; digest = sha256 over the sorted manifest lines `<path>\n<sha256(bytes)>\n`, 64
// lowercase hex. The manifest itself (`manifest.json`) is the store's, never a bundle path.
export const DIGEST_RE = /^[0-9a-f]{64}$/
export const CHROME_REQUIRED_FILES = ['frontend.js', 'kit.js', 'styles.css', 'chrome.css']
// a bundle path: relative, at most three plain segments, no dot segments
export const CHROME_PATH_RE = /^(?:[a-z0-9][a-z0-9_.-]{0,63}\/){0,2}[a-z0-9][a-z0-9_.-]{0,63}$/i
export const CHROME_MANIFEST = 'manifest.json'
export const validChromePath = (p) => typeof p === 'string' && p !== CHROME_MANIFEST && CHROME_PATH_RE.test(p) && !p.split('/').some((s) => s === '.' || s === '..')
// chromeManifestLines(shas: {path → sha256 hex}) → the digest's input; chromeDigestOf(shas) → the digest
export const chromeManifestLines = (shas) => Object.keys(shas).sort().map((p) => `${p}\n${shas[p]}\n`).join('')
export const chromeDigestOf = (shas) => createHash('sha256').update(chromeManifestLines(shas)).digest('hex')
export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex')

export const isReservedCompany = (id) => RESERVED_COMPANY_IDS.includes(id) || String(id).startsWith(RESERVED_COMPANY_PREFIX)
export const validCompany = (id) => typeof id === 'string' && SLUG_RE.test(id) && !isReservedCompany(id)
// A computer's OWN company row is spine-minted: a personal space (p-<id>, OR4) is a company on the
// same code path and may hold apps. The p- prefix is reserved against CLAIMING it as a company id
// (validCompany), never against the row the spine minted (operator ruling 2026-08-28).
export const validComputerCompany = (id) => typeof id === 'string' && SLUG_RE.test(id) && !RESERVED_COMPANY_IDS.includes(id)

// allowMeta(meta) → {meta, requested, dropped, invalid}
export function allowMeta(meta) {
  const out = { meta: {}, requested: {}, dropped: [], invalid: [] }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return out
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue
    if (!META_ALLOW.includes(k)) { out.dropped.push(k); continue }
    if (!validators[k](v)) { out.invalid.push(k); continue }
    if (META_KEEP.includes(k)) out.meta[k] = v
    else out.requested[k] = v
  }
  return out
}

// authorizeWrite({callerComputer, computerRow, existingRow, body}) → {ok:true, row} | {ok:false, code, error}
//   callerComputer: the computer id the bearer token resolved to (null = no/unknown token)
//   computerRow:    {id, company} from the computers table
//   existingRow:    {instance_id, company, slug, computer, ...} | null — the row for body's instance id
//   body:           the PUT body {slug, company?, meta?, computer? (ignored)} — any other key is 400 unknown-field
export function authorizeWrite({ callerComputer, computerRow, existingRow = null, body = {} }) {
  const refuse = (code, error, extra = {}) => ({ ok: false, code, error, ...extra })
  if (!callerComputer) return refuse(401, 'no-token')
  if (!computerRow || computerRow.id !== callerComputer) return refuse(401, 'unknown-computer')
  const company = computerRow.company
  if (!validComputerCompany(company)) return refuse(400, 'reserved-company', { company })
  for (const k of Object.keys(body)) if (!BODY_KEYS.includes(k)) return refuse(400, 'unknown-field', { field: k })
  if (body.company !== undefined && body.company !== company) return refuse(409, 'company-is-fixed', { company })
  if (typeof body.slug !== 'string' || !SLUG_RE.test(body.slug)) return refuse(400, 'bad-slug')
  if (existingRow) {
    if (existingRow.computer !== callerComputer) return refuse(403, 'not-your-row', { computer: existingRow.computer })
    if (existingRow.company !== company) return refuse(409, 'company-is-fixed', { company: existingRow.company })
  }
  const m = allowMeta(body.meta)
  return {
    ok: true,
    row: { company, slug: body.slug, computer: callerComputer, meta: m.meta, requested_primary: m.requested.primary ?? null },
    dropped: m.dropped, invalid: m.invalid,
  }
}

// reclaimRule({existing, callerComputer, now, tombstoneMs}) → adopt | revive | refuse-claimed | refuse-tombstoned | insert
//   existing: the row holding (company, slug) — {computer, tombstone_at: null | ms} — or null.
export function reclaimRule({ existing, callerComputer, now, tombstoneMs = TOMBSTONE_MS }) {
  if (!existing) return 'insert'
  const tombstoned = existing.tombstone_at !== null && existing.tombstone_at !== undefined
  if (existing.computer === callerComputer) return tombstoned ? 'revive' : 'adopt'
  if (!tombstoned) return 'refuse-claimed'
  return existing.tombstone_at + tombstoneMs > now ? 'refuse-tombstoned' : 'insert'   // expired tombstone: purge + insert
}
