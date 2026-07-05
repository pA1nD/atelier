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
const [spec, ...flags] = process.argv.slice(2);
if (!spec || spec.startsWith('-')) {
  fail(`usage: atelier add <spec> [--from <owner/repo>] [--workspace <ws>] [--force] [--yes]
  <spec>   a bare module name (a folder of a marketplace repo), or anything
           npm can fetch: @scope/name, a git url, a tarball url, a local folder
  --from   the marketplace repo for bare names (else the \`marketplaces\` list
           in atelier.config.json)
  --workspace  install into $<ws>/ instead of the global workspace
  --force  replace an existing module folder (its data/ is preserved)
  --yes    also run the install hints of missing system needs (the module's
           \`atelier.bins\` declarations — author-supplied commands)`);
}
let from = null, workspace = null, force = false, yes = false;
for (let i = 0; i < flags.length; i++) {
  if (flags[i] === '--from') from = flags[++i] || fail('--from needs <owner/repo>');
  else if (flags[i] === '--workspace') workspace = flags[++i] || fail('--workspace needs a name');
  else if (flags[i] === '--force') force = true;
  else if (flags[i] === '--yes') yes = true;
  else fail(`unknown option: ${flags[i]}`);
}
if (from) {
  from = from.replace(/^github:/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(from)) fail(`--from must be a github <owner/repo>, got "${from}"`);
}
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

const repoRoots = new Map();   // owner/repo → extracted tarball root (downloaded once)
async function fetchRepoRoot(repo) {
  if (repoRoots.has(repo)) return repoRoots.get(repo);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-add-'));
  const url = `https://codeload.github.com/${repo}/tar.gz/HEAD`;
  const res = await fetch(url).catch((e) => fail(`could not reach github.com for ${repo}: ${e.message}`));
  if (!res.ok) fail(`could not download github.com/${repo} (HTTP ${res.status}) — is it a public repo?`);
  fs.writeFileSync(path.join(tmp, 'repo.tgz'), Buffer.from(await res.arrayBuffer()));
  const out = path.join(tmp, 'repo');
  fs.mkdirSync(out);
  execFileSync('tar', ['-xzf', path.join(tmp, 'repo.tgz'), '-C', out]);
  const root = path.join(out, fs.readdirSync(out)[0]);   // single "<repo>-<ref>" top dir
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
      : (Array.isArray(config?.marketplaces) ? config.marketplaces.map((r) => String(r).replace(/^github:/, '')) : []);
    if (!repos.length) {
      fail(`"${spec}" is a bare module name, but there is no marketplace to resolve it against.
  Pass one:            atelier add ${spec} --from <owner/repo>
  Or configure them:   "marketplaces": ["<owner/repo>"] in ${CONFIG_PATH}
  (Full specs — @scope/name, git urls, tarballs, local folders — need neither.)`);
    }
    const seen = [];
    for (const repo of repos) {
      const root = await fetchRepoRoot(repo);
      const src = path.join(root, spec);
      if (fs.existsSync(src) && isModuleFolder(src)) return { src, id: spec, origin: `github.com/${repo}` };
      seen.push(`${repo}: ${repoModuleDirs(root).join(', ') || '(no modules)'}`);
    }
    fail(`no module "${spec}" in ${repos.length === 1 ? 'that marketplace' : 'any configured marketplace'} — available:\n  ${seen.join('\n  ')}`);
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
  fs.rmSync(dest, { recursive: true, force: true });
}

fs.mkdirSync(destParent, { recursive: true });
fs.cpSync(src, dest, {
  recursive: true,
  filter: (p) => {
    const rel = path.relative(src, p);
    const top = rel.split(path.sep)[0];
    return top !== 'node_modules' && top !== 'data' && top !== '.git';
  },
});
if (savedData) fs.cpSync(path.join(savedData, 'data'), path.join(dest, 'data'), { recursive: true });
console.log(`  installed: ${qualified}  ←  ${origin}`);

/* ---- dependencies — the module's own package.json is the manifest ---------- */
const pkg = readPkg(dest);
if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
  console.log(`  installing dependencies (${Object.keys(pkg.dependencies).join(', ')})…`);
  try {
    execFileSync(process.env.npm_execpath ? process.execPath : 'npm',
      process.env.npm_execpath
        ? [process.env.npm_execpath, 'install', '--no-fund', '--no-audit']
        : ['install', '--no-fund', '--no-audit'],
      { cwd: dest, stdio: ['ignore', 'inherit', 'inherit'] });
  } catch {
    console.error(`
  ✗ DEPENDENCY INSTALL FAILED for ${qualified}
    The module is in place at ${dest}, but its npm dependencies did not
    install — it will NOT work until they do. Fix the error above, then:
      cd ${dest} && npm install
`);
    process.exit(1);
  }
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
