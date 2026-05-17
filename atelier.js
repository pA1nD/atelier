/* atelier.js — dual-purpose.
 *
 *   1. Build pipeline: imported by server.js for JSX/CSS compilation.
 *   2. Install CLI:    `npm run atelier -- <cmd>` ships Atelier to ~/.atelier/.
 *
 * The entry-point detection at the bottom selects behavior — CLI only runs
 * when this file is invoked directly (node atelier.js …).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transform as esbuildTransform, build as esbuildBuild } from 'esbuild';
import { compile as twCompile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';

/* ============================================================================
 * BUILD PIPELINE — JSX via esbuild, CSS via Tailwind v4 (+ oxide scanner).
 *
 * No registration, no dist/ folder. The runner passes a source path and
 * gets the compiled bytes back. Output is cached keyed by source path and
 * invalidated when any dependency's mtime changes.
 *
 * Deploy-ready: same code path dev and prod. First request per source pays
 * the compile cost (<500ms typical); every request after is from memory.
 * ============================================================================ */

const cache = new Map();   // srcPath → { mtimeMs, content, contentType }

function maxMtime(paths) {
  let m = 0;
  for (const p of paths) {
    try { m = Math.max(m, fs.statSync(p).mtimeMs); } catch {}
  }
  return m;
}

async function runJsx(srcPath) {
  const src = fs.readFileSync(srcPath, 'utf8');
  const result = await esbuildTransform(src, {
    loader: 'jsx',
    format: 'esm',                     // each file is an ES module
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    target: 'es2020',
    sourcefile: srcPath,
    minify: false,
  });
  return result.code;
}

async function runCss(srcPath, scanSources, scanBase) {
  const src = fs.readFileSync(srcPath, 'utf8');
  const compiler = await twCompile(src, {
    base: scanBase,
    onDependency: () => {},
  });
  const scanner = new Scanner({
    sources: scanSources.map((abs) => ({
      base: scanBase,
      pattern: path.relative(scanBase, abs),
      negated: false,
    })),
  });
  return compiler.build(scanner.scan());
}

export async function getJsx(srcPath) {
  const mtime = maxMtime([srcPath]);
  const cached = cache.get(srcPath);
  if (cached && cached.mtimeMs === mtime) return cached;
  const entry = {
    mtimeMs: mtime,
    content: await runJsx(srcPath),
    contentType: 'application/javascript; charset=utf-8',
  };
  cache.set(srcPath, entry);
  return entry;
}

// Recursive max-mtime over a directory tree. Skips node_modules / dotfiles
// / data/ so npm-install timestamps don't dominate the result. Used for
// cache-busting bundled chromes whose source spans many files.
function maxMtimeRecursive(rootDir) {
  let m = 0;
  const skip = new Set(['node_modules', 'data']);
  const walk = (dir) => {
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of names) {
      if (ent.name.startsWith('.') || skip.has(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else {
        try { m = Math.max(m, fs.statSync(p).mtimeMs); } catch {}
      }
    }
  };
  walk(rootDir);
  return m;
}

// Bundle a JSX entry plus its full first-party dep graph via esbuild
// (instead of esbuildTransform's per-file pass). Used for chrome modules
// that bring real npm dependencies (Headless UI, motion, heroicons, etc.).
// React + ReactDOM are externalized: aliased to /assets/shims/react.js +
// react-dom.js, which re-export `window.React` / `window.ReactDOM` so the
// chrome shares the same React instance as the shell.
//
// Returns the same { mtimeMs, content, contentType } shape as getJsx so
// the asset response path is unified.
export async function getJsxBundle(srcPath, absWorkingDir) {
  // Bundle invalidates when ANY file inside absWorkingDir changes (modulo
  // node_modules/dotfiles). Catalyst components live in side-by-side .jsx
  // files; editing one must rebuild the bundle.
  const mtime = maxMtimeRecursive(absWorkingDir);
  const cacheKey = srcPath + '::bundle';
  const cached = cache.get(cacheKey);
  if (cached && cached.mtimeMs === mtime) return cached;
  const result = await esbuildBuild({
    entryPoints: [srcPath],
    absWorkingDir,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    sourcemap: 'inline',
    target: ['es2020'],
    loader: { '.jsx': 'jsx', '.js': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
    // Automatic JSX runtime — some catalyst files use JSX without importing
    // React directly. The runtime import resolves via the alias below.
    jsx: 'automatic',
    // Most catalyst libs check `process.env.NODE_ENV`; define it so they
    // tree-shake correctly and don't crash on `process` undefined.
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'process.env': '{}',
    },
    // Route bare `react` / `react-dom` imports (including transitive ones
    // from Headless UI / motion / heroicons) to atelier's shim files.
    // alias works for both direct and transitive imports.
    alias: {
      'react': path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'shims/react.js'),
      'react-dom': path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'shims/react-dom.js'),
      'react/jsx-runtime': path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'shims/jsx-runtime.js'),
      'react/jsx-dev-runtime': path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'shims/jsx-runtime.js'),
    },
    logLevel: 'silent',
  });
  const entry = {
    mtimeMs: mtime,
    content: result.outputFiles[0].text,
    contentType: 'application/javascript; charset=utf-8',
  };
  cache.set(cacheKey, entry);
  return entry;
}

export async function getCss(srcPath, scanSources, scanBase) {
  // scanSources are absolute paths; they drive both mtime checks and the
  // scanner's pattern list.
  const mtime = maxMtime([srcPath, ...scanSources]);
  const cached = cache.get(srcPath);
  if (cached && cached.mtimeMs === mtime) return cached;
  const entry = {
    mtimeMs: mtime,
    content: await runCss(srcPath, scanSources, scanBase),
    contentType: 'text/css; charset=utf-8',
  };
  cache.set(srcPath, entry);
  return entry;
}

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
 *     → DENY mode: everything in scope runs EXCEPT the listed denials
 *     (workspaces NOT denied stay included).
 *
 *   Mixing allow + deny markers in the same list → config error → no filter
 *   applied (everything in scope runs).
 *
 *   No entries at all (or only neutral path-only entries) → no filter →
 *   everything runs + paths added.
 *
 * Inside a workspace block (`{workspace: "ws", modules: [...]}`), same rule
 * recurses. Bare names refer to that workspace's modules. Paths inside a
 * workspace default to `<that-workspace>/<basename>`.
 *
 * Examples:
 *
 *   ["kanban"]                              → only global/kanban
 *   ["!scratch"]                            → all globals except scratch
 *                                              + all workspaces
 *   [{"workspace": "bigcorp"}]              → only bigcorp (no globals)
 *   [{"workspace": "!bigcorp"}]             → everything except bigcorp
 *   ["kanban", {"workspace": "bigcorp"}]    → global/kanban + all bigcorp
 *   ["~/work/extra"]                        → global/extra + all globals
 *                                              + all workspaces (path is
 *                                              neutral — no mode set)
 *
 * Used by the runner (per-request filter) and the deploy CLI (filter
 * before rsync to prod).
 * ============================================================================ */

export const CONFIG_FILENAME = 'atelier.config.json';

// Path entries are anything starting with /, ~, ./, ../, or the object
// form { path: ... }. Module names can't start with those chars, so this
// is a clean discriminator.
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
// Returns:
//   {
//     mode: 'allow' | 'deny' | null,    // null = no filter
//     names: string[],                   // bare module ids (no '!' prefix)
//     paths: { path, id? }[],            // additive external mounts
//   }
// Or null on hard failure (mixed allow+deny).
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
    // Unknown entry shape — log and skip.
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

// Parse a top-level list into:
//   {
//     top: { mode, names, paths } | null,   // global-scope filter
//     workspaces: Map<string, WsPolicy>,    // per-workspace policies
//   }
// Returns null when the input isn't an array.
function parseConfigList(list, label) {
  if (!Array.isArray(list)) return null;
  const workspaces = new Map();
  const top = parseFilterList(list, label, { allowWorkspaceObjects: true, workspaces });
  if (!top) return { top: null, workspaces };
  return { top, workspaces };
}

export function loadModuleConfig(workspaceRoot) {
  const file = path.join(workspaceRoot, CONFIG_FILENAME);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return { dev: null, prod: null }; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    process.stderr.write(`! ${CONFIG_FILENAME}: invalid JSON — ${err.message} (treating as missing)\n`);
    return { dev: null, prod: null };
  }
  const m = parsed.modules;
  if (Array.isArray(m)) {
    const v = parseConfigList(m, 'modules');
    return { dev: v, prod: v };
  }
  if (m && typeof m === 'object') {
    return {
      dev:  parseConfigList(m.dev,  'modules.dev'),
      prod: parseConfigList(m.prod, 'modules.prod'),
    };
  }
  return { dev: null, prod: null };
}

// Predicate: should this discovered module mount under the given parsed config?
// Discovered modules carry `{id, workspace}`. External paths are handled
// separately by `collectConfigPaths`.
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
    // Workspace not named in config.
    if (top && top.mode === 'allow') return false;        // allow mode excludes unnamed
    return true;
  }
  if (policy.kind === 'include-all') return true;
  if (policy.kind === 'deny-all')    return false;
  // filter kind
  if (policy.mode === 'allow') return policy.names.includes(mod.id);
  if (policy.mode === 'deny')  return !policy.names.includes(mod.id);
  return true;                                            // inner mode null
}

// Emit the path entries the config asks for. Each carries the workspace
// it should land in. The caller mounts these on top of the filtered
// discovery set.
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

/* ============================================================================
 * DISCOVERY RULES — shared between the runner (server.js) and the install
 * CLI (this file). Keeping these in one place means a folder rejected by
 * one path can't accidentally be accepted by the other.
 *
 *   RESERVED_NAMES — directory names that would shadow URL prefixes the
 *     shell owns, or the shell itself:
 *       • atelier — the shell
 *       • api     — `/api/<ws>/<id>/…` (module route namespace)
 *       • assets  — `/assets/<name>.(js|css)` (host static)
 *       • modules — `/modules/<ws>/<id>/...` (module bundles + assets)
 *       • global  — the synthetic workspace name for root-folder modules;
 *                   `$global/` on disk would collide with it and is
 *                   rejected (modules at the root ARE the global workspace).
 *
 *   isSpecialDir(name) — true when the first char isn't [a-zA-Z0-9]. Hides
 *     `_archive/`, `.git/`, `-scratch/`, etc. without renaming them. Prefix
 *     a folder with `_` or `.` to opt out of discovery.
 * ============================================================================ */

export const RESERVED_NAMES = new Set(['atelier', 'api', 'assets', 'modules', 'global']);

export const GLOBAL_WORKSPACE = 'global';

export const isSpecialDir = (name) => !/^[a-zA-Z0-9]/.test(name);

/* `$<name>/` directory at the workspace root is a workspace — discovery
 * recurses one level into it for modules. The leading `$` is the on-disk
 * marker; URLs use `/<name>/<id>` directly. `$global/` is rejected because
 * root-folder modules already constitute the synthetic `global` workspace.
 * Restrict the rest to the same shape we accept for module names so URLs
 * stay stable. */
export const WORKSPACE_PREFIX = '$';
export const isWorkspaceDir = (name) =>
  name.length > 1
  && name[0] === WORKSPACE_PREFIX
  && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name.slice(1))
  && !RESERVED_NAMES.has(name.slice(1));
export const workspaceName = (dirName) =>
  isWorkspaceDir(dirName) ? dirName.slice(1) : null;

/* ============================================================================
 * INSTALL CLI — subcommands for installing, updating, uninstalling Atelier.
 *
 *   npm run atelier -- install [module…]      deploy atelier + siblings
 *   npm run atelier -- update  [module…]      git pull + redeploy
 *   npm run atelier -- uninstall [module…]    remove modules (no args = nuke)
 *   npm run atelier -- status                 show agent + installed modules
 *
 * Paths:
 *   HERE       = the atelier/ inside the clone
 *   WORKSPACE  = clone's parent (sibling modules live here in dev)
 *   INSTALL    = ~/.atelier/     (production root)
 *   INSTALL/atelier/             (runtime)
 *   INSTALL/<name>/              (siblings — deployed modules)
 * ============================================================================ */

const HERE         = path.dirname(fileURLToPath(import.meta.url));
// PWD is the logical (symlinked) cwd bash cd'd into — needed when atelier/
// is a shared symlink across projects, since import.meta.url resolves to
// the host project, not the caller. HERE is the prod fallback (launchd
// doesn't set PWD; atelier/ is a real dir there so HERE/.. is correct).
const WORKSPACE    = path.resolve(process.env.PWD || HERE, '..');
const HOME         = process.env.HOME;
const INSTALL      = path.join(HOME, '.atelier');
const INSTALL_AT   = path.join(INSTALL, 'atelier');
const PLIST        = path.join(HOME, 'Library', 'LaunchAgents', 'dev.atelier.plist');
const AGENT        = 'dev.atelier';
const UID          = String(process.getuid());
// Use the node binary running the install command — works across fnm/nvm/asdf
// /system installs without a hardcoded path. Whatever ran `npm run atelier --
// install` is what the LaunchAgent will exec on every boot.
const NODE_BIN     = process.execPath;
const HOSTS_LINE   = '127.0.0.1\tatelier';
const URL          = 'http://atelier:1844/';

const RSYNC_EXCLUDES = ['--exclude=.git', '--exclude=node_modules', '--exclude=.DS_Store', '--exclude=*.log'];

/* Extra filters for deploying a module or agent dir. Protects prod runtime
 * state across install / update — rsync's --delete respects excludes, so
 * excluded paths at the destination are preserved.
 *
 *   /data/              module runtime dir at transfer root (backends write
 *                       here via ctx.dataDir)
 *   .claude/            include-first — at ANY depth, ship only definitional
 *                       files (agent/skill/command/hook defs, CLAUDE.md,
 *                       settings.json) and drop everything else so runtime
 *                       state stays resident on prod: agent-memory/,
 *                       projects/, todos/, plans/, shell-snapshots/,
 *                       settings.local.json, …
 *
 * rsync's `**` doesn't match an empty prefix, so we list each .claude/ rule
 * twice — once anchored at the transfer root, once with a `**` prefix for
 * nested .claude/ dirs (e.g. module/skills/my-skill/.claude/). Excluded
 * dirs like node_modules short-circuit descent, so nested .claude/ inside
 * them is never considered.
 *
 * First-match-wins means include rules must precede the catch-all exclude. */
const DEPLOY_FILTERS = [
  '--exclude=/data/',

  // transfer-root .claude/
  '--include=.claude/agents/',   '--include=.claude/agents/**',
  '--include=.claude/skills/',   '--include=.claude/skills/**',
  '--include=.claude/commands/', '--include=.claude/commands/**',
  '--include=.claude/hooks/',    '--include=.claude/hooks/**',
  '--include=.claude/CLAUDE.md',
  '--include=.claude/settings.json',
  '--exclude=.claude/*',

  // nested .claude/ anywhere deeper in the tree
  '--include=**/.claude/agents/',   '--include=**/.claude/agents/**',
  '--include=**/.claude/skills/',   '--include=**/.claude/skills/**',
  '--include=**/.claude/commands/', '--include=**/.claude/commands/**',
  '--include=**/.claude/hooks/',    '--include=**/.claude/hooks/**',
  '--include=**/.claude/CLAUDE.md',
  '--include=**/.claude/settings.json',
  '--exclude=**/.claude/*',
];

/* Non-module dirs that still ship alongside modules. Carved out from the
 * "special dirs are local-only" rule — agents need to exist in the install
 * so prod Claude sessions can cd into them. */
const INSTALL_RESOURCES = ['_agents'];

function log(msg)  { process.stdout.write(msg + '\n'); }
function step(msg) { log('→ ' + msg); }
function ok(msg)   { log('✓ ' + msg); }
function warn(msg) { process.stderr.write('! ' + msg + '\n'); }

/** Thin spawnSync wrapper. Options: {cwd, ignore:bool, input:string}. */
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: opts.input != null ? ['pipe', 'inherit', 'inherit'] : 'inherit', cwd: opts.cwd, input: opts.input });
  if (r.error) throw r.error;
  if (r.status !== 0 && !opts.ignore) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
  }
  return r.status;
}

function isModuleDir(abs) {
  return fs.existsSync(path.join(abs, 'frontend.jsx')) || fs.existsSync(path.join(abs, 'backend.js'));
}

// Discovered modules live at WORKSPACE root. Workspace-scoped modules
// (those inside `$<ws>/`) are NOT picked up by the deploy CLI today —
// `$<ws>/` directories start with `$` and so are skipped by `isSpecialDir`.
// The runtime supports workspace modules; the deploy CLI does not yet.
// Module authors that need a workspace module on prod can use the
// `{ path: ..., id: ... }` path-config form, which mounts to a flat
// `~/.atelier/<id>/` destination regardless of workspace.
//
// Returns `{ id, dir }`. Sorted by id for deterministic ordering across
// filesystems with different readdir semantics.
function discoverSiblings() {
  const out = [];
  for (const name of fs.readdirSync(WORKSPACE)) {
    if (isSpecialDir(name)) continue;
    if (RESERVED_NAMES.has(name)) continue;
    const abs = path.join(WORKSPACE, name);
    try { if (!fs.statSync(abs).isDirectory()) continue; } catch { continue; }
    if (isModuleDir(abs)) out.push({ id: name, dir: abs });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function installedModules() {
  if (!fs.existsSync(INSTALL)) return [];
  return fs.readdirSync(INSTALL)
    .filter((name) => {
      if (isSpecialDir(name)) return false;
      if (RESERVED_NAMES.has(name)) return false;
      const abs = path.join(INSTALL, name);
      try { return fs.statSync(abs).isDirectory(); } catch { return false; }
    });
}

function buildAtelier() {
  step('syncing atelier/ → ' + INSTALL_AT);
  fs.mkdirSync(INSTALL_AT, { recursive: true });
  sh('rsync', ['-a', '--delete', ...RSYNC_EXCLUDES, HERE + '/', INSTALL_AT + '/']);
  step('installing dependencies (--omit=dev)');
  sh('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: INSTALL_AT });
}

// Entries are {id, dir}. Accepts a bare string for CLI-arg ergonomics
// (`npm run atelier -- install kanban` resolves to WORKSPACE/kanban).
function deployModule(entry) {
  const { id, dir } = typeof entry === 'string'
    ? { id: entry, dir: path.join(WORKSPACE, entry) }
    : entry;
  if (!fs.existsSync(dir)) { warn(`no such module: ${id} (${dir})`); return; }
  if (!isModuleDir(dir))   { warn(`${id} has no frontend.jsx/backend.js — skipping`); return; }
  const dest = path.join(INSTALL, id);
  sh('rsync', ['-a', '--delete', ...RSYNC_EXCLUDES, ...DEPLOY_FILTERS, dir + '/', dest + '/']);
  installModuleDeps(id, dest);
  log(`  + ${id}`);
}

/* Modules with their own package.json (e.g. abstract → pngjs) need their
 * deps installed at the install location. node_modules is excluded from
 * rsync — shipping a populated tree would be slow and would mask any
 * platform-specific binaries baked in by the dev npm install. So instead
 * we run `npm ci --omit=dev` (or `npm install` if there's no lockfile)
 * inside the deployed module dir. The bundle's `import.meta.url` define
 * keeps Node's resolver walking up from the module's own backend.js, so
 * node_modules resolves correctly per-module without any shared hoist. */
function installModuleDeps(name, dest) {
  if (!fs.existsSync(path.join(dest, 'package.json'))) return;
  const useCi = fs.existsSync(path.join(dest, 'package-lock.json'));
  step(`installing ${name} dependencies${useCi ? ' (npm ci --omit=dev)' : ' (npm install --omit=dev)'}`);
  const args = useCi
    ? ['ci',      '--omit=dev', '--no-audit', '--no-fund']
    : ['install', '--omit=dev', '--no-audit', '--no-fund'];
  sh('npm', args, { cwd: dest });
}

/* Skills are no longer the install CLI's concern. Modules carry skills
 * at <module>/.claude/skills/<name>/SKILL.md; those files ship to prod
 * via DEPLOY_FILTERS like any other definitional content. Discovery,
 * scope, host install, and session aggregation all live in module
 * space — see the `skills` and `mission-control` modules. */

function deployModules(entries) {
  if (entries.length === 0) { log('  (no modules)'); return; }
  const labels = entries.map((e) => typeof e === 'string' ? e : e.id);
  step('deploying modules: ' + labels.join(', '));
  for (const e of entries) deployModule(e);
}

function deployResources() {
  const present = INSTALL_RESOURCES.filter((n) => fs.existsSync(path.join(WORKSPACE, n)));
  if (present.length === 0) return;
  step('deploying resources: ' + present.join(', '));
  for (const n of present) {
    sh('rsync', ['-a', '--delete', ...RSYNC_EXCLUDES, ...DEPLOY_FILTERS, path.join(WORKSPACE, n) + '/', path.join(INSTALL, n) + '/']);
    log('  + ' + n);
  }
}

/* The repo's root `.env` holds secrets modules need at runtime (API keys,
 * tokens, anything the workspace doesn't want to embed in a module's own
 * source). It's shipped to the install root so prod modules can read it
 * the same way dev modules do. Destination mode is 0600 so the secrets
 * aren't world-readable even on a shared machine. */
function deployRootEnv() {
  const src = path.join(WORKSPACE, '.env');
  if (!fs.existsSync(src)) { warn('no root .env in ' + WORKSPACE + ' — skipping env deploy'); return; }
  const dst = path.join(INSTALL, '.env');
  step('deploying root .env → ' + dst);
  fs.mkdirSync(INSTALL, { recursive: true });
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o600);
  log('  + .env');
}

/* Resolve the prod target set: discovered global modules (the only kind
 * the install CLI currently knows about — workspace deploy is a future
 * task) filtered by the config + any external paths the config names.
 *
 * The prod runtime ALSO reads the config (see deployConfig) so the same
 * filter applies at request time. Path entries get rsynced from their
 * resolved location but land under ~/.atelier/<basename>/ (flat). */
function prodFilteredSiblings() {
  const cfg = loadModuleConfig(WORKSPACE);
  const parsed = cfg.prod;

  // Discovered siblings are global modules (workspace='global' synthetic).
  // Tag them so shouldIncludeModule can reason about them.
  const discovered = discoverSiblings().map((m) => ({ ...m, workspace: GLOBAL_WORKSPACE }));
  const filtered = discovered.filter((m) => shouldIncludeModule(parsed, m));

  // Add external paths from the config. All workspaces' paths get rsynced;
  // workspace assignment is irrelevant on the deploy side today (flat
  // ~/.atelier/<id>/ destination).
  const seen = new Set(filtered.map((m) => m.id));
  const fromPaths = [];
  for (const p of collectConfigPaths(parsed, { globalWorkspace: GLOBAL_WORKSPACE })) {
    const abs = resolvePathEntry(p.path, WORKSPACE);
    if (!abs)                  { warn(`${CONFIG_FILENAME}: path '${p.path}' is malformed — skipping`); continue; }
    if (!fs.existsSync(abs))   { warn(`${CONFIG_FILENAME}: path '${p.path}' does not exist — skipping`); continue; }
    if (!isModuleDir(abs))     { warn(`${CONFIG_FILENAME}: path '${p.path}' is not a module dir — skipping`); continue; }
    const id = p.id || path.basename(abs);
    if (seen.has(id))          { warn(`${CONFIG_FILENAME}: path '${p.path}' resolves to id '${id}' which is already in the target set — skipping`); continue; }
    seen.add(id);
    fromPaths.push({ id, dir: abs });
  }
  return [...filtered, ...fromPaths];
}

/* Ship atelier.config.json to the install root so the prod runtime applies
 * the same prod filter (without it, prod would show every module that
 * happens to be in ~/.atelier/, which can drift from the configured set
 * if a module was ever deployed and later removed from the list). */
function deployConfig() {
  const src = path.join(WORKSPACE, CONFIG_FILENAME);
  if (!fs.existsSync(src)) return;
  const dst = path.join(INSTALL, CONFIG_FILENAME);
  step(`deploying ${CONFIG_FILENAME} → ${dst}`);
  fs.mkdirSync(INSTALL, { recursive: true });
  fs.copyFileSync(src, dst);
  log('  + ' + CONFIG_FILENAME);
}

/** Run a shell command as root via macOS's GUI password prompt. No TTY required. */
function sudoViaOsascript(shellCmd, label) {
  const escaped = shellCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `do shell script "${escaped}" with prompt "Atelier: ${label}" with administrator privileges`;
  sh('osascript', ['-e', script]);
}

function wireHosts() {
  const hosts = fs.readFileSync('/etc/hosts', 'utf8');
  if (hosts.split('\n').some((line) => line.trim() === HOSTS_LINE.replace('\t', ' ') || line.trim() === HOSTS_LINE)) {
    step('/etc/hosts already maps atelier → 127.0.0.1');
    return;
  }
  step('/etc/hosts: map atelier → 127.0.0.1 (macOS will prompt for your password)');
  sudoViaOsascript(`printf '${HOSTS_LINE}\\n' >> /etc/hosts`, 'add atelier host entry');
}

function renderPlist() {
  // EnvironmentVariables.PATH — launchd hands services a minimal PATH
  // (/usr/bin:/bin:/usr/sbin:/sbin), so any module that spawns a binary
  // installed by Homebrew (cloudflared, ffmpeg, gh, …) hits ENOENT in
  // prod even though it works in dev. Include both Apple Silicon
  // (/opt/homebrew/bin) and Intel (/usr/local/bin) Homebrew prefixes
  // so the same plist works on either Mac.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key>            <string>${AGENT}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>server.js</string>
  </array>
  <key>WorkingDirectory</key> <string>${INSTALL_AT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>        <true/>
  <key>KeepAlive</key>        <true/>
  <key>StandardOutPath</key>  <string>/tmp/atelier.log</string>
  <key>StandardErrorPath</key><string>/tmp/atelier.log</string>
</dict></plist>
`;
}

function writePlist() {
  step('writing LaunchAgent plist');
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.writeFileSync(PLIST, renderPlist());
}

/* True when the on-disk plist differs from what renderPlist() would
 * produce now. Used by `update` to decide whether `kickstart -k`
 * (process restart, plist unchanged) is enough or a full re-bootstrap
 * (bootout + bootstrap, picks up plist changes) is needed. */
function plistChanged() {
  let prev;
  try { prev = fs.readFileSync(PLIST, 'utf8'); }
  catch { return true; }
  return prev !== renderPlist();
}

function bootstrapAgent() {
  sh('launchctl', ['bootout', `gui/${UID}`, PLIST], { ignore: true });
  step('bootstrapping agent');
  sh('launchctl', ['bootstrap', `gui/${UID}`, PLIST]);
}

function fullNuke() {
  step('booting out agent');
  sh('launchctl', ['bootout', `gui/${UID}`, PLIST], { ignore: true });
  if (fs.existsSync(PLIST)) { step('removing plist'); fs.rmSync(PLIST, { force: true }); }
  step('removing /etc/hosts entry (macOS will prompt for your password)');
  sudoViaOsascript(`sed -i '' -E '/^127\\.0\\.0\\.1[[:space:]]+atelier$/d' /etc/hosts`, 'remove atelier host entry');
  if (fs.existsSync(INSTALL)) { step('removing ~/.atelier/'); fs.rmSync(INSTALL, { recursive: true, force: true }); }
}

function rmModule(name) {
  const abs = path.join(INSTALL, name);
  if (!fs.existsSync(abs)) { warn(`not installed: ${name}`); return; }
  fs.rmSync(abs, { recursive: true, force: true });
  log('  - ' + name);
}

/* Remove installed modules that aren't in the target set. Mirrors
 * `npm run atelier -- uninstall <name>` semantics: the install dir goes.
 * Host-installed skills (under ~/.claude/skills/) are managed by the
 * `skills` module — removing a module here doesn't clean those up.
 *
 * Only runs on the no-args path of `install` / `update`. Explicit-arg
 * invocations like `update kanban` are scoped to those modules — leaving
 * everything else alone is the contract. */
function reconcileRemovals(targets) {
  const keep = new Set(targets.map((t) => typeof t === 'string' ? t : t.id));
  const orphans = installedModules().filter((name) => !keep.has(name));
  if (orphans.length === 0) return;
  step('removing modules no longer in the install set: ' + orphans.join(', '));
  for (const n of orphans) rmModule(n);
}

/* ----- commands ----- */

async function cmdInstall(mods) {
  buildAtelier();
  wireHosts();
  writePlist();
  bootstrapAgent();
  const targets = mods.length ? mods : prodFilteredSiblings();
  deployModules(targets);
  if (mods.length === 0) {
    deployResources();
    deployRootEnv();
    deployConfig();
    reconcileRemovals(targets);
  }
  ok(URL);
}

async function cmdUpdate(mods) {
  step('git pull in ' + HERE);
  sh('git', ['-C', HERE, 'pull', '--ff-only']);
  buildAtelier();
  // If renderPlist's output drifted (e.g. PATH changes, new launchd keys),
  // refresh the plist file. The actual re-bootstrap happens after deploy
  // so the agent stays alive while modules sync.
  const plistChange = plistChanged();
  if (plistChange) writePlist();
  // "update" defaults to "sync install with the workspace" — every module in
  // the repo gets deployed, so newly added modules pick up without a separate
  // install step. Previously this used installedModules() which missed new
  // modules. With atelier.config.json present, the workspace set is narrowed
  // to the configured prod list before deploying.
  const targets = mods.length ? mods : prodFilteredSiblings();
  deployModules(targets);
  if (mods.length === 0) {
    deployResources();
    deployRootEnv();
    deployConfig();
    reconcileRemovals(targets);
  }
  if (plistChange) {
    step('plist changed → re-bootstrapping agent');
    bootstrapAgent();
  } else {
    step('kickstarting agent');
    sh('launchctl', ['kickstart', '-k', `gui/${UID}/${AGENT}`]);
  }
  ok(URL);
}

async function cmdUninstall(mods) {
  if (mods.length === 0) { fullNuke(); ok('uninstalled'); return; }
  for (const m of mods) rmModule(m);
  step('kickstarting agent (picks up removal)');
  sh('launchctl', ['kickstart', '-k', `gui/${UID}/${AGENT}`], { ignore: true });
  ok('done');
}

async function cmdStatus() {
  log('install root: ' + (fs.existsSync(INSTALL) ? INSTALL : '(not installed)'));
  if (fs.existsSync(INSTALL_AT)) log('runtime:      ' + INSTALL_AT);
  const mods = installedModules();
  log('modules:      ' + (mods.length ? mods.join(', ') : '(none)'));
  const res = INSTALL_RESOURCES.filter((n) => fs.existsSync(path.join(INSTALL, n)));
  if (res.length) log('resources:    ' + res.join(', '));
  log('agent:');
  sh('launchctl', ['print', `gui/${UID}/${AGENT}`], { ignore: true });
}

/* ----- dispatch ----- */

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const CMDS = { install: cmdInstall, update: cmdUpdate, uninstall: cmdUninstall, status: cmdStatus };
  const fn = CMDS[cmd];
  if (!fn) {
    process.stderr.write('usage: npm run atelier -- install|update|uninstall|status [module…]\n');
    process.exit(1);
  }
  try {
    await fn(args);
  } catch (err) {
    process.stderr.write('✗ ' + err.message + '\n');
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
