#!/usr/bin/env node
/* atelier add — install a module into this instance.
 *
 *   npx atelier add <spec> [--from <owner/repo>] [--workspace <ws>] [--force]
 *
 * A bare <spec> (`kanban`) names one folder of a marketplace repo — a github
 * repo whose top-level folders are modules. The repo is `--from <owner/repo>`,
 * else each entry of `marketplaces` in atelier.config.json, in order. Any
 * other spec — a registry name (`@scope/kanban`), a git url, a tarball url,
 * or a local folder — is fetched via `npm pack`.
 *
 * The shipping convention this implements (docs/MODULES.md): a module ships
 * everything it needs — its npm deps declared in its own package.json — so
 * installing is: copy the folder, run `npm install` inside it. A failing
 * install fails LOUDLY and leaves the folder in place for a manual retry.
 * `data/` is runtime state: never copied in, and preserved across --force.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveRoot, RESERVED_NAMES } from './discovery.js';

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));

const fail = (msg) => { console.error(`\natelier add: ${msg}\n`); process.exit(1); };

/* ---- args ---------------------------------------------------------------- */
const USAGE = `usage: atelier add <spec> [--from <owner/repo>] [--workspace <ws>] [--force] [--yes]
       atelier add --marketplace <owner/repo | git url>   register a marketplace (installs nothing)
       atelier add --list                         what your marketplaces offer
  <spec>   a bare module name (a folder of a registered marketplace), or anything
           npm can fetch: @scope/name, a git url, a tarball url, a local folder
  --from   install a bare name from a specific repo (registered or not)
  --workspace  install into $<ws>/ instead of the global workspace
  --force  replace an existing module folder (its data/ is preserved)
  --yes    also run the install hints of missing system needs (the module's
           \`atelier.bins\` declarations — author-supplied commands)`;
const args = process.argv.slice(2);
let spec = null, from = null, workspace = null, force = false, yes = false, registerRepo = null, list = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--from') from = args[++i] || fail('--from needs <owner/repo>');
  else if (a === '--workspace') workspace = args[++i] || fail('--workspace needs a name');
  else if (a === '--force') force = true;
  else if (a === '--yes') yes = true;
  else if (a === '--marketplace') registerRepo = args[++i] || fail('--marketplace needs <owner/repo>');
  else if (a === '--list') list = true;
  else if (!a.startsWith('-') && spec === null) spec = a;
  else fail(`unknown option: ${a}\n\n${USAGE}`);
}
if (!spec && !registerRepo && !list) fail(USAGE);
// A marketplace entry is a github <owner/repo> (fetched as a tarball, no auth)
// or ANY git url you can clone — git+ssh://…, git@host:…, https://….git — which
// uses your local git auth (ssh keys / credential helper), so private stores work.
const isRepoShorthand = (s) => /^[\w.-]+\/[\w.-]+$/.test(s);
const isGitUrl = (s) => /^(git\+ssh:\/\/|git\+https:\/\/|ssh:\/\/|git@)/.test(s) || /^https?:\/\/.+\.git$/.test(s) || /^file:\/\//.test(s);
const normMarket = (r) => {
  const n = String(r).replace(/^github:/, '');
  if (isRepoShorthand(n)) return n;
  if (isGitUrl(n)) return n.replace(/^git\+/, '');
  fail(`a marketplace is a github <owner/repo> or a git url (git+ssh://… for private stores), got "${r}"`);
};
if (from) from = normMarket(from);
if (workspace && !/^[a-zA-Z0-9][\w.-]*$/.test(workspace)) fail(`"${workspace}" isn't a usable workspace name`);

/* ---- the instance --------------------------------------------------------- */
const ROOT = resolveRoot({ atelierRoot: process.env.ATELIER_ROOT, pwd: process.env.PWD, hostDir: HOST_DIR });
const CONFIG_PATH = path.join(ROOT, 'atelier.config.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch { return null } };
const config = readConfig();
console.log(`\n  instance: ${ROOT}`);

/* ---- fetching -------------------------------------------------------------- */
const isBareName = (s) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(s);
const isModuleFolder = (dir) =>
  fs.existsSync(path.join(dir, 'frontend.jsx')) || fs.existsSync(path.join(dir, 'backend.js'));
const readPkg = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch { return {} } };

const runNpm = (args, opts = {}) => process.env.npm_execpath
  ? execFileSync(process.execPath, [process.env.npm_execpath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
  : execFileSync('npm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

const repoRoots = new Map();   // marketplace entry → local root (fetched once)
async function fetchRepoRoot(repo) {
  if (repoRoots.has(repo)) return repoRoots.get(repo);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-add-'));
  let root;
  if (isRepoShorthand(repo)) {
    // public github shorthand — anonymous tarball, no git needed
    const url = `https://codeload.github.com/${repo}/tar.gz/HEAD`;
    const res = await fetch(url).catch((e) => fail(`could not reach github.com for ${repo}: ${e.message}`));
    if (!res.ok) fail(`could not download github.com/${repo} (HTTP ${res.status}) — is it a public repo? (private stores work as git urls: git+ssh://…)`);
    fs.writeFileSync(path.join(tmp, 'repo.tgz'), Buffer.from(await res.arrayBuffer()));
    const out = path.join(tmp, 'repo');
    fs.mkdirSync(out);
    execFileSync('tar', ['-xzf', path.join(tmp, 'repo.tgz'), '-C', out]);
    root = path.join(out, fs.readdirSync(out)[0]);   // single "<repo>-<ref>" top dir
  } else {
    // any git url — shallow clone with YOUR git auth (ssh keys / credential helper)
    root = path.join(tmp, 'repo');
    try {
      execFileSync('git', ['clone', '--depth', '1', repo, root],
        { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    } catch (e) {
      const detail = (e.stderr || '').toString().trim().split('\n').slice(-2).join('\n  ');
      fail(`could not clone ${repo} — check your access (ssh key / credential helper)\n  ${detail}`);
    }
  }
  repoRoots.set(repo, root);
  return root;
}
const repoModuleDirs = (root) => fs.readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^[a-zA-Z0-9]/.test(d.name))
  .map((d) => d.name)
  .filter((n) => isModuleFolder(path.join(root, n)));

async function fetchModule() {
  if (isBareName(spec)) {
    const repos = from ? [from]
      : (Array.isArray(config?.marketplaces) ? config.marketplaces.map(normMarket) : []);
    if (!repos.length) {
      fail(`"${spec}" is a bare module name, but there is no marketplace to resolve it against.
  Pass one:            atelier add ${spec} --from <owner/repo>
  Or configure them:   "marketplaces": ["<owner/repo>"] in ${CONFIG_PATH}
  (Full specs — @scope/name, git urls, tarballs, local folders — need neither.)`);
    }
    // Marketplaces are a SET, not a search order: exactly one hit installs,
    // several hits stop and ask (silent shadowing would be worse than a prompt).
    const hits = [], seen = [];
    for (const repo of [...new Set(repos)]) {
      const root = await fetchRepoRoot(repo);
      const src = path.join(root, spec);
      if (fs.existsSync(src) && isModuleFolder(src)) hits.push({ repo, src });
      else seen.push(`${repo}: ${repoModuleDirs(root).join(', ') || '(no modules)'}`);
    }
    if (hits.length === 1) return { src: hits[0].src, id: spec, origin: isRepoShorthand(hits[0].repo) ? `github.com/${hits[0].repo}` : hits[0].repo };
    if (hits.length > 1) {
      fail(`"${spec}" exists in ${hits.length} of your marketplaces — pick one:\n${hits.map((h) => `  atelier add ${spec} --from ${h.repo}`).join('\n')}`);
    }
    fail(`no module "${spec}" in ${repos.length === 1 ? 'that marketplace' : 'any of your marketplaces'} — available:\n  ${seen.join('\n  ')}`);
  }
  // anything npm can pack
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-add-'));
  let tgz;
  try {
    tgz = runNpm(['pack', spec, '--pack-destination', tmp]).trim().split('\n').pop();
  } catch (e) {
    const detail = (e.stderr || e.message || '').toString().trim().split('\n').slice(-3).join('\n  ');
    fail(`could not fetch "${spec}" — not something npm can pack (registry name, git url, tarball url, or folder)\n  ${detail}`);
  }
  const src = path.join(tmp, 'extracted');
  fs.mkdirSync(src);
  execFileSync('tar', ['-xzf', path.join(tmp, tgz), '-C', src, '--strip-components', '1']);
  if (!isModuleFolder(src)) fail(`"${spec}" fetched, but it isn't a module (no frontend.jsx or backend.js at its top level)`);
  const id = (readPkg(src).name || tgz.replace(/\.tgz$/, '')).split('/').pop();
  return { src, id, origin: spec };
}

/* ---- --marketplace / --list — subscribe & browse without installing -------- */
const installedIds = () => {
  const ids = new Set();
  try {
    for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('$')) {
        try { for (const w of fs.readdirSync(path.join(ROOT, e.name))) ids.add(w); } catch {}
      } else ids.add(e.name);
    }
  } catch {}
  return ids;
};

if (registerRepo) {
  const repo = normMarket(registerRepo);
  const cfg = config || {};
  cfg.marketplaces = Array.isArray(cfg.marketplaces) ? cfg.marketplaces : [];
  if (cfg.marketplaces.map(normMarket).includes(repo)) {
    console.log(`  ${repo} is already a registered marketplace.`);
  } else {
    cfg.marketplaces.push(repo);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`  registered: ${repo}  (in ${CONFIG_PATH})`);
  }
  const root = await fetchRepoRoot(repo);
  const have = installedIds();
  console.log(`  it offers:`);
  for (const n of repoModuleDirs(root)) console.log(`    ${have.has(n) ? '✓' : '·'} ${n}${have.has(n) ? '  (installed)' : ''}`);
  console.log(`\n  install one with:  npx atelier add <name>\n`);
  process.exit(0);
}

if (list) {
  const repos = (Array.isArray(config?.marketplaces) ? config.marketplaces : []).map(normMarket);
  if (!repos.length) fail(`no marketplaces registered — add one with:  atelier add --marketplace <owner/repo>`);
  const have = installedIds();
  for (const repo of [...new Set(repos)]) {
    const root = await fetchRepoRoot(repo);
    console.log(`  ${repo}:`);
    const mods = repoModuleDirs(root);
    for (const n of mods) console.log(`    ${have.has(n) ? '✓' : '·'} ${n}${have.has(n) ? '  (installed)' : ''}`);
    if (!mods.length) console.log('    (no modules)');
  }
  console.log(`\n  install with:  npx atelier add <name>\n`);
  process.exit(0);
}

const { src, id, origin } = await fetchModule();
if (RESERVED_NAMES.has(id)) fail(`"${id}" is a reserved name in atelier — rename the module folder`);

/* ---- install --------------------------------------------------------------- */
const destParent = workspace ? path.join(ROOT, '$' + workspace) : ROOT;
const dest = path.join(destParent, id);
const qualified = `${workspace || 'global'}/${id}`;

if (fs.existsSync(dest) && !force) {
  fail(`${qualified} already exists at ${dest}
  It may carry local edits — atelier add never overwrites silently.
  Re-run with --force to replace it (its data/ is preserved).`);
}

// --force: keep the old module's data/ (runtime state) across the swap.
let savedData = null;
if (fs.existsSync(dest)) {
  const dataDir = path.join(dest, 'data');
  if (fs.existsSync(dataDir)) {
    savedData = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-add-data-'));
    fs.cpSync(dataDir, path.join(savedData, 'data'), { recursive: true });
  }
}

// Stage under a dot-prefixed name — invisible to discovery. A RUNNING instance
// hot-mounts new folders on its next request, so copying into place and THEN
// installing deps leaves a window where the backend mounts against an empty
// node_modules and fails. Deps install into the staging dir; only a complete
// module is renamed into place (same parent dir → same fs → atomic).
fs.mkdirSync(destParent, { recursive: true });
const staging = path.join(destParent, `.add-${id}-${process.pid}`);
fs.rmSync(staging, { recursive: true, force: true });
let staged = true;
process.on('exit', () => { if (staged) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch {} } });
fs.cpSync(src, staging, {
  recursive: true,
  filter: (p) => {
    const rel = path.relative(src, p);
    const top = rel.split(path.sep)[0];
    return top !== 'node_modules' && top !== 'data' && top !== '.git';
  },
});
if (savedData) fs.cpSync(path.join(savedData, 'data'), path.join(staging, 'data'), { recursive: true });

/* ---- dependencies — the module's own package.json is the manifest ---------- */
const pkg = readPkg(staging);
let depsFailed = false;
if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
  console.log(`  installing dependencies (${Object.keys(pkg.dependencies).join(', ')})…`);
  try {
    execFileSync(process.env.npm_execpath ? process.execPath : 'npm',
      process.env.npm_execpath
        ? [process.env.npm_execpath, 'install', '--no-fund', '--no-audit']
        : ['install', '--no-fund', '--no-audit'],
      { cwd: staging, stdio: ['ignore', 'inherit', 'inherit'] });
  } catch {
    depsFailed = true;   // still land the module (documented behavior), fail loud below
  }
}

fs.rmSync(dest, { recursive: true, force: true });
fs.renameSync(staging, dest);
staged = false;
console.log(`  installed: ${qualified}  ←  ${origin}`);
if (depsFailed) {
  console.error(`
  ✗ DEPENDENCY INSTALL FAILED for ${qualified}
    The module is in place at ${dest}, but its npm dependencies did not
    install — it will NOT work until they do. Fix the error above, then:
      cd ${dest} && npm install
`);
  process.exit(1);
}

/* ---- system needs — the module's own `atelier` block ------------------------
 * Declarative, in the module's package.json:
 *   "atelier": { "os": ["darwin"],
 *                "bins": { "ffmpeg": "brew install ffmpeg" },
 *                "env": ["SOME_API_KEY"],
 *                "note": "free-text caveat" }
 * The installer CHECKS and REPORTS — it never runs anything beyond npm unless
 * --yes, which executes the missing bins' author-supplied install hints (the
 * same trust already extended to the module's npm lifecycle scripts).
 */
const needs = pkg.atelier && typeof pkg.atelier === 'object' ? pkg.atelier : {};
const binOk = (b) => { try { execFileSync('/bin/sh', ['-c', `command -v ${b}`], { stdio: 'ignore' }); return true } catch { return false } };
const declaredBins = Object.entries(needs.bins && typeof needs.bins === 'object' ? needs.bins : {})
  .filter(([b]) => /^[A-Za-z0-9._-]+$/.test(b) || (console.log(`  ! ignoring unusable bin name in atelier.bins: ${JSON.stringify(b)}`), false));
let missingBins = declaredBins.filter(([b]) => !binOk(b));

if (yes && missingBins.length) {
  for (const [b, hint] of missingBins) {
    if (!hint) continue;
    console.log(`  running install hint for ${b}:  ${hint}`);
    try { execFileSync('/bin/sh', ['-c', String(hint)], { stdio: ['ignore', 'inherit', 'inherit'] }); }
    catch { console.log(`  ! hint for ${b} exited non-zero`); }
  }
  missingBins = declaredBins.filter(([b]) => !binOk(b));   // re-check honestly
}

const missingEnv = (Array.isArray(needs.env) ? needs.env : []).filter((k) => !process.env[k]);
const osMismatch = Array.isArray(needs.os) && needs.os.length && !needs.os.includes(process.platform);
if (needs.note) console.log(`  note: ${needs.note}`);
if (osMismatch || missingBins.length || missingEnv.length) {
  console.log(`\n  ! ACTION NEEDED — ${qualified} is installed and will run, but degraded until:`);
  if (osMismatch) console.log(`    · it targets os [${needs.os.join(', ')}] — this machine is ${process.platform}`);
  for (const [b, hint] of missingBins) console.log(`    · missing ${b}${hint ? `  →  ${hint}` : ''}`);
  for (const k of missingEnv) console.log(`    · missing env ${k} — provide it via your environment or launcher`);
  if (missingBins.some(([, h]) => h) && !yes) console.log(`    (re-run with --yes to run the install hints)`);
} else if (declaredBins.length || (needs.env || []).length) {
  console.log(`  needs: all present ✓`);
}

/* ---- the instance's module filter ------------------------------------------
 * With no config (or no `modules` list) everything runs — nothing to do. With
 * an allow-mode list, the new module must be listed or it silently won't
 * mount; append it (the filter file is re-read per request, so this is live).
 * Deny-mode lists already include it. Mixed lists are a config error the
 * shell warns about — leave those alone and tell the operator.
 */
function updateFilter() {
  if (!config || !Array.isArray(config.modules)) return;
  const entries = config.modules;
  const isDeny = (e) => (typeof e === 'string' && e.startsWith('!')) || (e && typeof e === 'object' && typeof e.workspace === 'string' && e.workspace.startsWith('!'));
  const isAllow = (e) => !isDeny(e);
  const hasAllow = entries.some(isAllow), hasDeny = entries.some(isDeny);
  if (!hasAllow) return;                                       // deny mode (or empty): included already
  if (hasDeny) { console.log(`  ! atelier.config.json mixes allow + deny — add "${id}" to its modules list yourself`); return; }
  if (!workspace) {
    if (entries.some((e) => e === id || (e && typeof e === 'object' && e.id === id))) return;
    entries.push(id);
  } else {
    const ws = entries.find((e) => e && typeof e === 'object' && e.workspace === workspace);
    if (!ws) entries.push({ workspace, modules: [id] });
    else if (Array.isArray(ws.modules) && !ws.modules.includes(id)) ws.modules.push(id);
    else if (!Array.isArray(ws.modules)) return;               // whole workspace already included
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  console.log(`  config: added "${id}" to the modules filter (live — no restart needed)`);
}
updateFilter();

console.log(`
  ✓ ${qualified} is installed — a running instance mounts it on the next request.
    open: /${qualified}
`);
