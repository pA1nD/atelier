// sheet.js — the per-app stylesheet swap (shell/DESIGN.md §4 "per-app sheet swap on SPA
// navigation"): the 1.x FOUC-free clone-load-drop mechanism generalised to a target href.
//
// One `<link id="atelier-chrome-styles">` is baked into the document by the shell (the active
// app's sheet, or the chrome's on an app-less route). On every navigation the client asks for
// the sheet of the new route; the new link is inserted right after the old one, the id moves to
// it at once, and the old link is dropped only when the new one has loaded (or errored — a
// build that 500s must not strand two links). An equal href is a no-op. Pure over an injected
// document so it runs under node with a fake DOM.

export const SHEET_ID = 'atelier-chrome-styles'

// The sheet the shell serves for a route: an app → its own sheet at its revision; no app → the
// chrome's sheet at the chrome's revision (`?rev=` everywhere, never `?v=`) — or, by digest
// (`chrome.base` = `/_chrome/<digest>`, step 7 ship C), the bundle's compiled chrome-only sheet
// `<base>/chrome.css`, immutable, no cache-buster.
export function sheetHref(app, chrome) {
  if (app && app.company && app.slug) {
    // the content id first (deployed_rev — the URL names the bytes; shell/document.mjs assetRev), the counter as the fallback
    const rev = app.deployed_rev ?? app.rev
    const q = rev != null ? `?rev=${encodeURIComponent(rev)}` : ''
    return `/modules/${encodeURIComponent(app.company)}/${encodeURIComponent(app.slug)}/styles.css${q}`
  }
  if (!chrome || !chrome.qid) return null
  if (chrome.base) return `${chrome.base}/chrome.css`
  const q = chrome.rev != null ? `?rev=${encodeURIComponent(chrome.rev)}` : ''
  return `/modules/${chrome.qid}/styles.css${q}`
}

// swapSheet(doc, href) → { swapped: boolean, done: Promise<{ok, ms}> | null }
export function swapSheet(doc, href, { id = SHEET_ID, now = () => Date.now() } = {}) {
  const cur = doc && doc.getElementById(id)
  if (!cur || !href) return { swapped: false, done: null }
  if ((cur.getAttribute('href') || '') === href) return { swapped: false, done: null }
  const t0 = now()
  const next = cur.cloneNode(false)
  next.setAttribute('href', href)
  const done = new Promise((resolve) => {
    const finish = (ok) => { try { cur.remove() } catch {} resolve({ ok, ms: now() - t0 }) }
    next.addEventListener('load', () => finish(true))
    next.addEventListener('error', () => finish(false))
  })
  cur.removeAttribute('id')                                   // the replacement owns the id from here
  cur.parentNode.insertBefore(next, cur.nextSibling)
  return { swapped: true, done }
}
