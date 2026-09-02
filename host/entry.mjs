// host/entry.mjs — isMain(fileUrlOrPath): "is this file the process entry?", decided on REAL paths.
//
// `process.argv[1]` is the path node was GIVEN — the image runs the CLI through the /usr/local/bin/atelier symlink, the
// skills dir links the doctor (/work/.claude/skills/atelier-app → /app/atelier/doctor), /app/atelier may itself become a
// link — and a bare `path.resolve` compare never matches a symlink, so the guarded `main()` silently does not run: exit 0,
// nothing printed (the `atelier` no-op in every pod, 2026-09-02). Both sides are realpath'd; a side that cannot be resolved
// is never equal to anything (null === null must not count). One helper for every entry guard in the tree.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const real = (p) => { try { return fs.realpathSync(p) } catch { return null } }

/** @param {string} own  `import.meta.url` (or a plain path) of the file asking
 *  @param {string|undefined} argv1  the entry node was given (default `process.argv[1]`) */
export function isMain(own, argv1 = process.argv[1]) {
  if (!argv1 || !own) return false
  const a = real(argv1)
  return a !== null && a === real(own.startsWith('file:') ? fileURLToPath(own) : own)
}
