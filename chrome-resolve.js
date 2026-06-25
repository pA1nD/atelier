/* atelier · shared chrome resolution.
 *
 * ONE source of truth for "which chrome does a module render in?" — imported by
 * the server (Node), the client (browser, served at /assets/chrome-resolve.js),
 * and the tests. Keeping it in one place is what guarantees the server (which
 * picks the document's chrome) and the client (which decides SPA-push vs
 * full-reload) can never disagree. Pure: no Node / browser / React deps.
 *
 * Chromes are always global-workspace modules, addressed as `global/<id>`.
 */

// A module's `meta.chrome` is a chrome id (folder name) or a full qid; normalize
// it to the chrome's qid.
export function chromeQidFor(chrome) {
  return 'global/' + String(chrome).split('/').pop();
}

// The chrome a module renders in: its `meta.chrome` when that names one of the
// `availableChromes` (an array of chrome qids), otherwise `defaultChromeQid`.
export function resolveModuleChrome(chrome, availableChromes, defaultChromeQid) {
  if (chrome) {
    const want = chromeQidFor(chrome);
    if (availableChromes.includes(want)) return want;
  }
  return defaultChromeQid;
}

// When a module pins a `meta.chrome` that ISN'T available, the pinned name (so
// the caller can show a "chrome not installed" error rather than silently fall
// back). Null otherwise — no chrome pinned, or the pinned chrome is present.
export function missingChrome(chrome, availableChromes) {
  if (!chrome) return null;
  return availableChromes.includes(chromeQidFor(chrome)) ? null : String(chrome);
}
