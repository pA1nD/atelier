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

const HERE       = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE  = path.resolve(HERE, '..');
const HOME       = process.env.HOME;
const INSTALL    = path.join(HOME, '.atelier');
const INSTALL_AT = path.join(INSTALL, 'atelier');
const PLIST      = path.join(HOME, 'Library', 'LaunchAgents', 'dev.atelier.plist');
const AGENT      = 'dev.atelier';
const UID        = String(process.getuid());
const NODE_BIN   = '/Users/pa1nd/.local/share/fnm/aliases/default/bin/node';
const HOSTS_LINE = '127.0.0.1\tatelier';
const URL        = 'http://atelier:1844/';

const RSYNC_EXCLUDES = ['--exclude=.git', '--exclude=node_modules', '--exclude=.DS_Store', '--exclude=*.log'];

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
      if (name.startsWith('.') || name.startsWith('_')) return false;
      if (name === 'atelier') return false;
      const abs = path.join(WORKSPACE, name);
      try { if (!fs.statSync(abs).isDirectory()) return false; } catch { return false; }
      return isModuleDir(abs);
    });
}

function installedModules() {
  if (!fs.existsSync(INSTALL)) return [];
  return fs.readdirSync(INSTALL)
    .filter((name) => {
      if (name === 'atelier') return false;
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
  sh('rsync', ['-a', '--delete', ...RSYNC_EXCLUDES, src + '/', path.join(INSTALL, name) + '/']);
  log('  + ' + name);
}

function deployModules(names) {
  if (names.length === 0) { log('  (no modules)'); return; }
  step('deploying modules: ' + names.join(', '));
  for (const n of names) deployModule(n);
}

function wireHosts() {
  const hosts = fs.readFileSync('/etc/hosts', 'utf8');
  if (hosts.split('\n').some((line) => line.trim() === HOSTS_LINE.replace('\t', ' ') || line.trim() === HOSTS_LINE)) {
    step('/etc/hosts already maps atelier → 127.0.0.1');
    return;
  }
  step('/etc/hosts: map atelier → 127.0.0.1 (sudo)');
  sh('sudo', ['sh', '-c', `printf '${HOSTS_LINE}\\n' >> /etc/hosts`]);
}

function renderPlist() {
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

function bootstrapAgent() {
  sh('launchctl', ['bootout', `gui/${UID}`, PLIST], { ignore: true });
  step('bootstrapping agent');
  sh('launchctl', ['bootstrap', `gui/${UID}`, PLIST]);
}

function fullNuke() {
  step('booting out agent');
  sh('launchctl', ['bootout', `gui/${UID}`, PLIST], { ignore: true });
  if (fs.existsSync(PLIST)) { step('removing plist'); fs.rmSync(PLIST, { force: true }); }
  step('removing /etc/hosts entry (sudo)');
  sh('sudo', ['sed', '-i', '', '/^127\\.0\\.0\\.1[[:space:]]\\+atelier$/d', '/etc/hosts']);
  if (fs.existsSync(INSTALL)) { step('removing ~/.atelier/'); fs.rmSync(INSTALL, { recursive: true, force: true }); }
}

function rmModule(name) {
  const abs = path.join(INSTALL, name);
  if (!fs.existsSync(abs)) { warn(`not installed: ${name}`); return; }
  fs.rmSync(abs, { recursive: true, force: true });
  log('  - ' + name);
}

/* ----- commands ----- */

async function cmdInstall(mods) {
  buildAtelier();
  wireHosts();
  writePlist();
  bootstrapAgent();
  const targets = mods.length ? mods : discoverSiblings();
  deployModules(targets);
  ok(URL);
}

async function cmdUpdate(mods) {
  step('git pull in ' + HERE);
  sh('git', ['-C', HERE, 'pull', '--ff-only']);
  buildAtelier();
  const targets = mods.length ? mods : installedModules();
  deployModules(targets);
  step('kickstarting agent');
  sh('launchctl', ['kickstart', '-k', `gui/${UID}/${AGENT}`]);
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
