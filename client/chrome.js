// chrome.js — the chrome's URLs and the reload rule (shell/DESIGN.md §2.1 `chromeBase`; step 7 ship C, R-CHROME).
//
// The shell composes every document with ONE chrome: by digest (`boot.chromeBase` = `/_chrome/<digest>`, `chromeRev`
// = the digest) once a release is in play, else the chrome row's `/modules/<qid>/…?rev=<chromeRev>` (today's path).
// An APP document renders the digest its computer REPORTED (the rail row's `chromeDigest`: the app's sheet was built by
// its host with that chrome), an app-less document the company DEFAULT (the rail frame's `chromeRev`/`chrome.digest`).
// A chrome cannot swap inside a document, so a moved digest is a full reload — compared against what THIS document was
// composed with, never an app document against the default: a computer lagging the default (a pinned one, one still
// fetching) would otherwise reload forever. Pure: no DOM, no React.
//
// A row digest counts only when it IS one (64 hex — `asDigest`, the shell's own rule, protocol/registry.js): the shell
// composes a malformed row digest as the DEFAULT, so the client compares against the default too — a raw row value
// here would differ from what was rendered on every frame, and that is a reload loop.

const DIGEST_RE = /^[0-9a-f]{64}$/
export const asDigest = (d) => (typeof d === 'string' && DIGEST_RE.test(d) ? d : null)

// chromeUrl(boot, file) → the chrome bundle's URL for the document's chrome: `${chromeBase}/${file}` by digest (immutable,
// no cache-buster), `/modules/<qid>/<file>?rev=<chromeRev>` by row
export function chromeUrl({ chromeQid, chromeRev, chromeBase }, file) {
  if (chromeBase) return `${chromeBase}/${file}`
  if (!chromeQid) return null
  return `/modules/${chromeQid}/${file}${chromeRev != null ? `?rev=${encodeURIComponent(chromeRev)}` : ''}`
}

// railDefault(rail) → the company default the frame carries (`chromeRev`, else `chrome.digest`/`chrome.rev`), null when none
export function railDefault(rail) {
  if (!rail || typeof rail !== 'object') return null
  return rail.chromeRev ?? rail.chrome?.digest ?? rail.chrome?.rev ?? null
}

// documentDigest(rail, activeId) → the digest a document on this route is composed with: the active app's row
// `chromeDigest` when the row carries one (64 hex), else the default (an app-less route, a row whose computer reports
// none or something that is not a digest)
export function documentDigest(rail, activeId = null) {
  const def = railDefault(rail)
  if (activeId && Array.isArray(rail?.modules)) {
    const row = rail.modules.find((m) => m && m.id === activeId)
    const d = asDigest(row?.chromeDigest)
    if (d) return d
  }
  return def
}

// chromeMoved(bootRev, rail, activeId) → true when the document must reload: it was composed with `bootRev` and the rail
// now names another digest FOR THIS ROUTE. Never on a null side (no chrome, no release: nothing to compare).
export function chromeMoved(bootRev, rail, activeId = null) {
  if (bootRev == null) return false
  const next = documentDigest(rail, activeId)
  return next != null && String(next) !== String(bootRev)
}

// targetDigest({row, railDefault, bootRev}) → the digest a navigation target's document would be composed with (its row's
// `chromeDigest`, else the rail's default, else what this document has); navigating to another digest is a page load
export function targetDigest({ row = null, railDefault: def = null, bootRev = null }) {
  return asDigest(row?.chromeDigest) ?? def ?? bootRev
}
