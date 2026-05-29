/* atelier · discovery rules + module-config parsing.
 *
 * Shared vocabulary for "what is a module / workspace" and the optional
 * `atelier.config.json` filter. Kept dependency-free (fs/path only) and
 * separate from the build pipeline so the runner has one place to ask
 * "should this folder mount, and under what identity?"
 */
import fs from 'node:fs';
import path from 'node:path';

/* ============================================================================
 * DISCOVERY RULES
 *
 *   RESERVED_NAMES — directory names that would shadow URL prefixes the shell
 *     owns, or the shell itself:
 *       • atelier — the shell
 *       • api     — `/api/<ws>/<id>/…` (module route namespace)
 *       • assets  — `/assets/<name>.(js|css)` (host static)
 *       • modules — `/modules/<ws>/<id>/...` (module bundles + assets)
 *       • global  — the synthetic workspace name for root-folder modules;
 *                   `$global/` on disk would collide and is rejected.
 *
 *   isSpecialDir(name) — true when the first char isn't [a-zA-Z0-9]. Hides
 *     `_archive/`, `.git/`, `-scratch/`, etc. without renaming them. Prefix a
 *     folder with `_` or `.` to opt out of discovery.
 *
 *   `$<name>/` at the workspace root is a workspace — discovery recurses one
 *     level into it for modules. The leading `$` is the on-disk marker; URLs
 *     use `/<name>/<id>` directly. `$global/` is rejected (root-folder modules
 *     already constitute the synthetic `global` workspace).
 * ============================================================================ */

export const RESERVED_NAMES = new Set(['atelier', 'api', 'assets', 'modules', 'global']);

export const GLOBAL_WORKSPACE = 'global';

export const isSpecialDir = (name) => !/^[a-zA-Z0-9]/.test(name);

export const WORKSPACE_PREFIX = '$';
export const isWorkspaceDir = (name) =>
  name.length > 1
  && name[0] === WORKSPACE_PREFIX
  && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name.slice(1))
  && !RESERVED_NAMES.has(name.slice(1));
export const workspaceName = (dirName) =>
  isWorkspaceDir(dirName) ? dirName.slice(1) : null;

/* ============================================================================
 * MODULE CONFIG — optional filter + path inclusion at
 * <workspace>/atelier.config.json.
 *
 * Shape:
 *   { "modules": [...] }                            // both envs
 *   { "modules": { "dev": [...], "prod": [...] } }  // either key optional
 *
 * Top-level entries are EITHER global-module entries or workspace objects.
 *
 *   GLOBAL MODULE ENTRIES (apply to root-folder modules, i.e. the `global`
 *   workspace):
 *     "kanban"                  bare name — allow this global module
 *     "!scratch"                bang name — deny this global module
 *     "./path/to/dir"           path     — mount external dir as global/<basename>
 *     "~/work/dir"              path     — same, $HOME-relative
 *     { "path": "./dir" }              — object form, optional `id` to rename
 *     { "path": "./dir", "id": "x" }   — mounts as global/x
 *
 *   WORKSPACE OBJECTS:
 *     { "workspace": "ws" }                      include all of ws
 *     { "workspace": "!ws" }                     deny all of ws
 *     { "workspace": "ws", "modules": [...] }    include ws + filter its modules
 *
 * MODE classification (per scope: top level and inside each workspace's
 * `modules` list):
 *
 *   ALLOW markers — bare name, path, `{workspace: "ws"}`, `{workspace: "ws",
 *     modules: [...]}`. Presence of any allow marker → ALLOW mode: only
 *     explicitly listed things run (workspaces NOT listed are excluded).
 *
 *   DENY markers — `!name`, `{workspace: "!ws"}`. Presence of any deny marker
 *     → DENY mode: everything in scope runs EXCEPT the listed denials.
 *
 *   Mixing allow + deny in the same list → config error → no filter applied.
 *
 *   No entries at all (or only neutral path-only entries) → no filter →
 *   everything runs + paths added. Paths are always additive.
 * ============================================================================ */

export const CONFIG_FILENAME = 'atelier.config.json';

// Path entries start with /, ~, ./, ../, or use the object form { path: ... }.
// Module names can't start with those chars, so this is a clean discriminator.
export function isPathEntry(s) {
  if (s && typeof s === 'object' && !Array.isArray(s) && typeof s.path === 'string') return true;
  return typeof s === 'string'
    && (s.startsWith('/') || s.startsWith('~') || s.startsWith('./') || s.startsWith('../'));
}

// Resolve `~` (and `~/foo`) to $HOME-anchored absolute paths. Relative paths
// resolve against `base` (typically the workspace root).
export function resolvePathEntry(p, base) {
  if (typeof p !== 'string' || !p) return null;
  let s = p;
  if (s === '~' || s.startsWith('~/')) {
    const home = process.env.HOME;
    if (!home) return null;
    s = s === '~' ? home : path.join(home, s.slice(2));
  }
  if (!path.isAbsolute(s)) s = path.resolve(base, s);
  return path.normalize(s);
}

// Normalize a path entry into { path, id? }. Returns null for malformed input.
function normalizePathEntry(e) {
  if (typeof e === 'string') return { path: e };
  if (e && typeof e === 'object' && typeof e.path === 'string') {
    const out = { path: e.path };
    if (typeof e.id === 'string' && e.id) out.id = e.id;
    return out;
  }
  return null;
}

// Parse one scope's list (top-level or a workspace block's `modules`).
// Returns { mode: 'allow'|'deny'|null, names: string[], paths: {path,id?}[] }
// or null on hard failure (mixed allow+deny).
function parseFilterList(list, label, { allowWorkspaceObjects = false, workspaces = null } = {}) {
  if (!Array.isArray(list)) return null;
  const names = [];
  const paths = [];
  let firstAllow = null;
  let firstDeny = null;
  for (const e of list) {
    if (isPathEntry(e)) {
      const p = normalizePathEntry(e);
      if (p) paths.push(p);
      continue;
    }
    if (typeof e === 'string') {
      if (e.startsWith('!')) {
        firstDeny ??= e;
        names.push(e.slice(1));
        continue;
      }
      firstAllow ??= e;
      names.push(e);
      continue;
    }
    if (allowWorkspaceObjects && e && typeof e === 'object' && typeof e.workspace === 'string') {
      const wsRaw = e.workspace;
      const wsDeny = wsRaw.startsWith('!');
      const wsName = wsDeny ? wsRaw.slice(1) : wsRaw;
      if (!wsName) {
        process.stderr.write(`! ${CONFIG_FILENAME}: ${label}: workspace name is empty\n`);
        continue;
      }
      if (RESERVED_NAMES.has(wsName)) {
        process.stderr.write(`! ${CONFIG_FILENAME}: ${label}: workspace '${wsName}' is a reserved name — skipping\n`);
        continue;
      }
      if (wsDeny) {
        firstDeny ??= wsRaw;
        if (Array.isArray(e.modules)) {
          process.stderr.write(`! ${CONFIG_FILENAME}: ${label}: '${wsRaw}' is a deny — its inner 'modules' list is ignored\n`);
        }
        workspaces.set(wsName, { kind: 'deny-all' });
      } else {
        firstAllow ??= wsRaw;
        if (workspaces.has(wsName)) {
          process.stderr.write(`! ${CONFIG_FILENAME}: ${label}: workspace '${wsName}' appears more than once — keeping the first\n`);
          continue;
        }
        if (Array.isArray(e.modules)) {
          const inner = parseFilterList(e.modules, `${label} → workspace '${wsName}'`, { allowWorkspaceObjects: false });
          if (inner) workspaces.set(wsName, { kind: 'filter', ...inner });
          else workspaces.set(wsName, { kind: 'include-all' });
        } else {
          workspaces.set(wsName, { kind: 'include-all' });
        }
      }
      continue;
    }
    process.stderr.write(`! ${CONFIG_FILENAME}: ${label}: unrecognized entry ${JSON.stringify(e)} — skipping\n`);
  }
  if (firstAllow && firstDeny) {
    process.stderr.write(`! ${CONFIG_FILENAME}: ${label}: mixes allow ('${firstAllow}') and deny ('${firstDeny}') entries — pick one (treating ${label} filter as missing)\n`);
    return null;
  }
  let mode = null;
  if (firstDeny) mode = 'deny';
  else if (firstAllow) mode = 'allow';
  return { mode, names, paths };
}

// Parse a top-level list into { top, workspaces }. Returns null when not an array.
function parseConfigList(list, label) {
  if (!Array.isArray(list)) return null;
  const workspaces = new Map();
  const top = parseFilterList(list, label, { allowWorkspaceObjects: true, workspaces });
  if (!top) return { top: null, workspaces };
  return { top, workspaces };
}

// Read + parse atelier.config.json. Returns the raw config object, or {} when
// the file is missing or invalid (a warning logs for invalid JSON). This is the
// single read; instance settings AND the module filter both derive from it.
export function loadConfig(workspaceRoot) {
  const file = path.join(workspaceRoot, CONFIG_FILENAME);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return {}; }
  try { return JSON.parse(raw); }
  catch (err) {
    process.stderr.write(`! ${CONFIG_FILENAME}: invalid JSON — ${err.message} (treating as empty)\n`);
    return {};
  }
}

// Parse the module filter from a config's `modules` — a flat array (one folder
// = one instance; there is no dev/prod split). Returns the parsed filter, or
// null for "no filter": a missing key, or — with a warning — the removed
// { dev, prod } object form.
export function parseModuleFilter(modules) {
  if (Array.isArray(modules)) return parseConfigList(modules, 'modules');
  if (modules && typeof modules === 'object') {
    process.stderr.write(`! ${CONFIG_FILENAME}: "modules" must be a flat array — the dev/prod split was removed (one folder = one instance). Treating as no filter.\n`);
    return null;
  }
  return null;
}

// Convenience: read the config and return its module filter. The runner
// re-reads this per request so adding/removing modules in the config stays hot.
export function loadModuleConfig(workspaceRoot) {
  return parseModuleFilter(loadConfig(workspaceRoot).modules);
}

// Predicate: should this discovered module mount under the given parsed config?
export function shouldIncludeModule(parsedEnv, mod, { globalWorkspace = 'global' } = {}) {
  if (!parsedEnv) return true;                            // no config → all
  const { top, workspaces } = parsedEnv;

  if (mod.workspace === globalWorkspace) {
    if (!top) return true;
    if (top.mode === 'allow') return top.names.includes(mod.id);
    if (top.mode === 'deny')  return !top.names.includes(mod.id);
    return true;                                          // top mode null
  }

  // Workspace module.
  const policy = workspaces.get(mod.workspace);
  if (!policy) {
    if (top && top.mode === 'allow') return false;        // allow mode excludes unnamed
    return true;
  }
  if (policy.kind === 'include-all') return true;
  if (policy.kind === 'deny-all')    return false;
  if (policy.mode === 'allow') return policy.names.includes(mod.id);
  if (policy.mode === 'deny')  return !policy.names.includes(mod.id);
  return true;                                            // inner mode null
}

// Emit the path entries the config asks for, each tagged with the workspace
// it should land in. The caller mounts these on top of the filtered set.
export function collectConfigPaths(parsedEnv, { globalWorkspace = 'global' } = {}) {
  if (!parsedEnv) return [];
  const out = [];
  if (parsedEnv.top) {
    for (const p of parsedEnv.top.paths) out.push({ ...p, workspace: globalWorkspace });
  }
  for (const [ws, policy] of parsedEnv.workspaces) {
    if (policy.kind !== 'filter') continue;
    for (const p of policy.paths) out.push({ ...p, workspace: ws });
  }
  return out;
}
