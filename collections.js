/* atelier · shared vocabulary for the collection verbs (package / publish /
 * add / list).
 *
 * A COLLECTION is a folder of module folders — and, always, a git repo:
 * `atelier package` cuts verified module snapshots into it as commits,
 * `atelier publish` moves it somewhere, `atelier add` clones it back down.
 * Collections live under `_collections/` at the instance root; the `_`
 * prefix keeps them invisible to module discovery.
 *
 * Kept dependency-free (node builtins + git via execFileSync) and separate
 * from the server: nothing here runs in the serving process.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const COLLECTIONS_DIR = '_collections';

// How to invoke the CLI *on this machine* — used in printed next-step hints.
// Installed as a dependency → the bin is only reachable through npx; running
// from a checkout → the operator has their own invocation, `atelier` reads
// cleanest. Hints for the RECEIVING side of a share always say `npx atelier`
// (their setup is unknown; npx is the documented default).
export const CLI_NAME = /[\\/]node_modules[\\/]/.test(fileURLToPath(import.meta.url)) ? 'npx atelier' : 'atelier';

export const isModuleFolder = (dir) =>
  fs.existsSync(path.join(dir, 'frontend.jsx')) || fs.existsSync(path.join(dir, 'backend.js'));

export const readPkg = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); }
  catch { return {}; }
};

// The module folders at a collection's top level (its "offerings").
export const listModuleDirs = (root) => {
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return ents
    .filter((d) => d.isDirectory() && /^[a-zA-Z0-9]/.test(d.name))
    .map((d) => d.name)
    .filter((n) => isModuleFolder(path.join(root, n)));
};

export const collectionsRoot = (instanceRoot) => path.join(instanceRoot, COLLECTIONS_DIR);
export const collectionDir = (instanceRoot, name) => path.join(collectionsRoot(instanceRoot), name);

export const listCollections = (instanceRoot) => {
  let ents;
  try { ents = fs.readdirSync(collectionsRoot(instanceRoot), { withFileTypes: true }); } catch { return []; }
  return ents.filter((d) => d.isDirectory() && /^[a-zA-Z0-9]/.test(d.name)).map((d) => d.name);
};

/* ---- git ------------------------------------------------------------------ */

export function git(args, cwd, opts = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    ...opts,
  });
}

// Last stderr lines of a failed git call — the part a human needs.
export const gitErr = (e) =>
  (e.stderr || e.message || '').toString().trim().split('\n').slice(-2).join('\n  ');

export const isGitRepo = (dir) => fs.existsSync(path.join(dir, '.git'));

export const gitHead = (dir) => {
  try { return git(['rev-parse', 'HEAD'], dir).trim(); } catch { return null; }
};

/* ---- the channel vs. the outbox ---------------------------------------------
 * A subscription RECEIVES from the remote-tracking head (origin/HEAD) — the
 * published channel. The mirror's local branch may sit ahead of it with
 * unpublished cuts (`package --to` into a subscribed collection): that's the
 * OUTBOX, and it is never what installs, updates, or provenance read from.
 * This is what keeps `.atelier` pointers valid no matter what happens to the
 * local branch (they only ever reference published commits), and what makes
 * "your unpublished cut becomes the baseline and upstream silently overwrites
 * your work" impossible. Authored/remoteless collections have no channel —
 * their HEAD is it.
 * ------------------------------------------------------------------------------ */
export function channelHead(dir) {
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master']) {
    try { return git(['rev-parse', ref], dir).trim(); } catch {}
  }
  return gitHead(dir);
}

// How many local (unpublished) commits sit on the branch beyond the channel.
export function aheadOfChannel(dir) {
  try { return parseInt(git(['rev-list', '--count', `${channelHead(dir)}..HEAD`], dir).trim(), 10) || 0; }
  catch { return 0; }
}

// Extract one folder of a repo AT A COMMIT into dest — reads the ref, never
// the working tree (which may hold unpublished local cuts).
let extractN = 0;
export function extractTreeAt(repoDir, commit, subpath, dest) {
  const buf = git(['archive', '--format=tar', commit, '--', subpath], repoDir,
    { encoding: 'buffer', maxBuffer: 1 << 30 });
  const t = path.join(os.tmpdir(), `atelier-x-${process.pid}-${++extractN}.tar`);
  fs.writeFileSync(t, buf);
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('tar', ['-xf', t, '--strip-components', '1', '-C', dest]);
  fs.rmSync(t);
}

// Commit everything in `dir`. Returns the new short hash, or null when there
// was nothing to commit. Falls back to a synthetic identity so packaging
// works on machines without a global git user configured.
//
// --force: the packaging COPY FILTER is the single decider of what a cut
// contains. A module's own .gitignore (typically ignoring data/) travels
// with the cut, and the operator's global excludes exist too — without
// --force they'd silently drop files the filter deliberately included
// (observed: `--data` shipping nothing because the module ignored data/).
export function gitCommitAll(dir, message) {
  git(['add', '-A', '--force'], dir);
  if (!git(['status', '--porcelain'], dir).trim()) return null;
  try {
    git(['commit', '-q', '-m', message], dir);
  } catch {
    git(['-c', 'user.name=atelier', '-c', 'user.email=atelier@instance', 'commit', '-q', '-m', message], dir);
  }
  return git(['rev-parse', '--short', 'HEAD'], dir).trim();
}

/* ---- meta ------------------------------------------------------------------
 * Static `export const meta = {...}` extraction — same brace-balanced scan the
 * server uses for its fast path, minus the sandbox fallback: the CLI only
 * needs `meta.chrome` / `meta.isChrome`, and a computed meta simply reads as
 * {} here (the server still resolves it fully at serve time).
 * ---------------------------------------------------------------------------- */
export function extractMetaStatic(src) {
  const re = /export\s+const\s+meta\s*=\s*\{/.exec(src);
  if (!re) return {};
  const start = src.indexOf('{', re.index);
  if (start < 0) return {};
  let depth = 0;
  let str = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (str) {
      if (c === '\\') { i++; continue; }
      if (c === str) str = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return new Function('return (' + src.slice(start, i + 1) + ')')() || {}; }
        catch { return {}; }
      }
    }
  }
  return {};
}

export function readModuleMeta(dir) {
  for (const f of ['frontend.jsx', 'backend.js']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    let src;
    try { src = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const meta = extractMetaStatic(src);
    if (Object.keys(meta).length) return meta;
  }
  return {};
}

/* ---- copying ----------------------------------------------------------------
 * The filter both directions share. Never carried across the wire:
 *   node_modules  — the consumer's npm install rebuilds it
 *   .git          — the collection has its own history; a module's is private
 *   .atelier      — install provenance is per-instance, never distributed
 *   .env*         — secrets stay home
 *   data/         — runtime state; a cut includes it only with --data, an
 *                   install copies whatever the cut carries (first-install
 *                   content), and --force reinstalls preserve the live copy
 * ---------------------------------------------------------------------------- */
export function copyModuleFiltered(src, dest, { includeData = true } = {}) {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (p) => {
      if (path.basename(p) === '.DS_Store') return false;   // any depth — force-add would commit it
      const rel = path.relative(src, p);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      if (top === 'node_modules' || top === '.git' || top === '.atelier') return false;
      if (top.startsWith('.env')) return false;
      if (top === 'data' && !includeData) return false;
      return true;
    },
  });
}
