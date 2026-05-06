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
import { transform as esbuildTransform } from 'esbuild';
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
 * MODULE CONFIG — optional whitelist at <workspace>/atelier.config.json.
 *
 * Shape:
 *   { "modules": ["a","b"] }                        // both envs filtered
 *   { "modules": { "dev": [...], "prod": [...] } }  // either key optional
 *
 * Missing file, missing/non-array key, or invalid JSON ⇒ no filter (all
 * modules enabled — current behavior). Items in the list that don't match
 * a real module dir get a non-fatal warning.
 *
 * Used by the runner (filter discovered modules per ENV at request time)
 * and the deploy CLI (filter siblings before installing/updating in prod).
 * ============================================================================ */

export const CONFIG_FILENAME = 'atelier.config.json';

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
  if (Array.isArray(m)) return { dev: m, prod: m };
  if (m && typeof m === 'object') {
    return {
      dev:  Array.isArray(m.dev)  ? m.dev  : null,
      prod: Array.isArray(m.prod) ? m.prod : null,
    };
  }
  return { dev: null, prod: null };
}

export function applyModuleFilter(modules, allowList, { getId = (x) => x, warn = () => {} } = {}) {
  if (!allowList) return modules;
  const ids = new Set(modules.map(getId));
  for (const a of allowList) {
    if (!ids.has(a)) warn(a);
  }
  const allow = new Set(allowList);
  return modules.filter((m) => allow.has(getId(m)));
}

/* ============================================================================
 * DISCOVERY RULES — shared between the runner (server.js) and the install
 * CLI (this file). Keeping these in one place means a folder rejected by
 * one path can't accidentally be accepted by the other.
 *
 *   RESERVED_NAMES — directory names that would shadow URL prefixes the
 *     shell owns, or the shell itself:
 *       • atelier — the shell
 *       • api     — `/api/<id>/…` (every module's route namespace)
 *       • assets  — `/assets/<name>.(js|css)` (host static)
 *       • modules — `/modules/<id>/frontend.js` (module bundles)
 *
 *   isSpecialDir(name) — true when the first char isn't [a-zA-Z0-9]. Hides
 *     `_archive/`, `.git/`, `-scratch/`, etc. without renaming them. Prefix
 *     a folder with `_` or `.` to opt out of discovery.
 * ============================================================================ */

export const RESERVED_NAMES = new Set(['atelier', 'api', 'assets', 'modules']);

export const isSpecialDir = (name) => !/^[a-zA-Z0-9]/.test(name);

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
const WORKSPACE    = path.resolve(HERE, '..');
const HOME         = process.env.HOME;
const INSTALL      = path.join(HOME, '.atelier');
const INSTALL_AT   = path.join(INSTALL, 'atelier');
const CLAUDE_SKILLS = path.join(HOME, '.claude', 'skills');
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

function discoverSiblings() {
  return fs.readdirSync(WORKSPACE)
    .filter((name) => {
      if (isSpecialDir(name)) return false;
      if (RESERVED_NAMES.has(name)) return false;
      const abs = path.join(WORKSPACE, name);
      try { if (!fs.statSync(abs).isDirectory()) return false; } catch { return false; }
      return isModuleDir(abs);
    });
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

function deployModule(name) {
  const src = path.join(WORKSPACE, name);
  if (!fs.existsSync(src)) { warn(`no such module: ${name}`); return; }
  if (!isModuleDir(src))    { warn(`${name} has no frontend.jsx/backend.js — skipping`); return; }
  const dest = path.join(INSTALL, name);
  sh('rsync', ['-a', '--delete', ...RSYNC_EXCLUDES, ...DEPLOY_FILTERS, src + '/', dest + '/']);
  installModuleDeps(name, dest);
  const n = syncGlobalSkills(name);
  log(`  + ${name}${n ? ` (+${n} global skill${n > 1 ? 's' : ''})` : ''}`);
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

/* Modules can ship skills at <module>/.claude/skills/<name>/SKILL.md — the
 * same path Claude Code auto-loads when the module directory is the workspace
 * (for dev: `cd <module> && claude`). A skill with `scope: global` in its
 * frontmatter is also copied to ~/.claude/skills/<name>/ at install time so
 * any Claude session on the machine can load it. Skills without `scope:
 * global` stay bundled with the module. */
function listModuleSkills(name) {
  const dir = path.join(INSTALL, name, '.claude', 'skills');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((n) => ({ name: n, dir: path.join(dir, n) }))
    .filter((s) => { try { return fs.statSync(s.dir).isDirectory(); } catch { return false; } });
}

function readSkillScope(skillDir) {
  const md = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(md)) return null;
  const body = fs.readFileSync(md, 'utf8');
  const m = /^---\n([\s\S]*?)\n---/m.exec(body);
  if (!m) return null;
  const line = m[1].split('\n').find((l) => /^\s*scope\s*:/.test(l));
  if (!line) return null;
  return line.split(':')[1].trim();
}

function syncGlobalSkills(moduleName) {
  let n = 0;
  for (const skill of listModuleSkills(moduleName)) {
    if (readSkillScope(skill.dir) !== 'global') continue;
    fs.mkdirSync(CLAUDE_SKILLS, { recursive: true });
    sh('rsync', ['-a', '--delete', skill.dir + '/', path.join(CLAUDE_SKILLS, skill.name) + '/']);
    n++;
  }
  return n;
}

function removeGlobalSkillsFor(moduleName) {
  // Read the skills dir in the install BEFORE the module is deleted.
  for (const skill of listModuleSkills(moduleName)) {
    if (readSkillScope(skill.dir) !== 'global') continue;
    fs.rmSync(path.join(CLAUDE_SKILLS, skill.name), { recursive: true, force: true });
  }
}

function deployModules(names) {
  if (names.length === 0) { log('  (no modules)'); return; }
  step('deploying modules: ' + names.join(', '));
  for (const n of names) deployModule(n);
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

/* Apply the prod allowlist from atelier.config.json to the discovered
 * siblings. Empty/missing config ⇒ all siblings (current behavior). The
 * prod runtime ALSO reads the config and filters at request time, so
 * shipping the file is what makes the filter effective on the live
 * atelier — see deployConfig below. */
function prodFilteredSiblings() {
  const cfg = loadModuleConfig(WORKSPACE);
  return applyModuleFilter(discoverSiblings(), cfg.prod, {
    warn: (id) => warn(`${CONFIG_FILENAME} lists '${id}' for prod but no such module exists in ${WORKSPACE}`),
  });
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
  // Read + remove global skills before the install dir goes away.
  for (const name of installedModules()) removeGlobalSkillsFor(name);
  if (fs.existsSync(INSTALL)) { step('removing ~/.atelier/'); fs.rmSync(INSTALL, { recursive: true, force: true }); }
}

function rmModule(name) {
  const abs = path.join(INSTALL, name);
  if (!fs.existsSync(abs)) { warn(`not installed: ${name}`); return; }
  removeGlobalSkillsFor(name);            // must run before the rmSync below
  fs.rmSync(abs, { recursive: true, force: true });
  log('  - ' + name);
}

/* Remove installed modules that aren't in the target set. Mirrors
 * `npm run atelier -- uninstall <name>` semantics: the install dir goes
 * and any global skills the module shipped get stripped from
 * ~/.claude/skills/.
 *
 * Only runs on the no-args path of `install` / `update`. Explicit-arg
 * invocations like `update kanban` are scoped to those modules — leaving
 * everything else alone is the contract. */
function reconcileRemovals(targets) {
  const keep = new Set(targets);
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
