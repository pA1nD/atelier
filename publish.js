#!/usr/bin/env node
/* atelier publish — move a collection somewhere others can `atelier add` from.
 *
 *   npx atelier publish <collection> --to <git-url | github:owner/repo>
 *   npx atelier publish <collection> --serve [--port <n>]
 *   npx atelier publish <collection> --bundle [<out.bundle>]
 *
 * Publish never reads working trees — it moves what `atelier package` cut
 * into `_collections/<collection>/` (a git repo). Three transports:
 *
 *   --to      git push. `github:owner/repo` pushes over ssh; consumers then
 *             `atelier add github:owner/repo` anonymously.
 *   --serve   host the collection's git repo over plain http (git's dumb
 *             protocol: `git update-server-info` + static files) — the
 *             zero-infrastructure LAN share. Read-only; serves only committed
 *             cuts, never the working tree. Runs until Ctrl-C.
 *   --bundle  a single file (git bundle) for AirDrop / USB / chat. Cloning
 *             from it keeps full history, so it's still a channel.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveRoot } from './discovery.js';
import { COLLECTIONS_DIR, CLI_NAME, collectionDir, listCollections, isGitRepo, git, gitErr } from './collections.js';

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const fail = (msg) => { console.error(`\natelier publish: ${msg}\n`); process.exit(1); };

/* ---- args ---------------------------------------------------------------- */
const USAGE = `usage: atelier publish <collection> --to <git-url | github:owner/repo>
       atelier publish <collection> --serve [--port <n>]
       atelier publish <collection> --bundle [<out.bundle>]
  (with no flags: pushes to the collection's existing git origin)`;
const args = process.argv.slice(2);
let name = null, to = null, serve = false, port = 8787, bundle = false, bundleOut = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--to') to = args[++i] || fail('--to needs a git url');
  else if (a === '--serve') serve = true;
  else if (a === '--port') port = parseInt(args[++i], 10) || fail('--port needs a number');
  else if (a === '--bundle') { bundle = true; if (args[i + 1] && !args[i + 1].startsWith('-')) bundleOut = args[++i]; }
  else if (!a.startsWith('-') && name === null) name = a;
  else fail(`unknown option: ${a}\n\n${USAGE}`);
}
if (!name) fail(USAGE);

const ROOT = resolveRoot({ atelierRoot: process.env.ATELIER_ROOT, pwd: process.env.PWD, hostDir: HOST_DIR });
const dir = collectionDir(ROOT, name);
if (!fs.existsSync(dir)) {
  const have = listCollections(ROOT);
  fail(`no collection "${name}" in ${COLLECTIONS_DIR}/${have.length ? ` — you have: ${have.join(', ')}` : ' (nothing packaged yet — start with: ${CLI_NAME} package <module>)'}`);
}
if (!isGitRepo(dir)) fail(`${COLLECTIONS_DIR}/${name} isn't a git repo — cut into it first with: ${CLI_NAME} package <module> --to ${name}`);

/* ---- --bundle ------------------------------------------------------------- */
if (bundle) {
  const out = path.resolve(process.cwd(), bundleOut || `${name}.bundle`);
  try { git(['bundle', 'create', out, '--all'], dir); }
  catch (e) { fail(`git bundle failed:\n  ${gitErr(e)}`); }
  console.log(`\n  ✓ ${COLLECTIONS_DIR}/${name}  →  ${out}`);
  console.log(`    send the file any way you like; the receiver runs:  npx atelier add ${out.replace(os.homedir(), '~')}\n`);
  process.exit(0);
}

/* ---- --serve — git's dumb-http protocol over the collection's .git ---------- */
if (serve) {
  const gitDir = path.join(dir, '.git');
  const refresh = () => { try { git(['update-server-info'], dir); } catch {} };
  refresh();
  const server = http.createServer((req, res) => {
    const sub = decodeURIComponent((req.url || '/').split('?')[0]);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    if (sub === '/' || sub === `/${name}` || sub === `/${name}/`) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`atelier collection "${name}" — install with:\n  npx atelier add http://<this-host>:${port}/${name}\n`);
      return;
    }
    if (!sub.startsWith(`/${name}/`)) { res.writeHead(404).end(); return; }
    const rel = sub.slice(name.length + 2);
    if (rel === 'info/refs') refresh();   // a fresh cut mid-serve stays cloneable
    const file = path.normalize(path.join(gitDir, rel));
    if (!file.startsWith(gitDir + path.sep)) { res.writeHead(403).end(); return; }
    let stat;
    try { stat = fs.statSync(file); } catch { res.writeHead(404).end(); return; }
    if (!stat.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': stat.size });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
  // The mDNS (Bonjour) name — what OTHER machines can actually resolve.
  // os.hostname() often carries a DHCP search-domain suffix (.localdomain)
  // that doesn't resolve across the LAN; on macOS the authoritative name is
  // scutil's LocalHostName.
  const mdnsName = () => {
    if (process.platform === 'darwin') {
      try { return execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim() + '.local'; } catch {}
    }
    const h = os.hostname().split('.')[0];
    return h ? `${h}.local` : null;
  };
  // Virtual interfaces (VM bridges, tunnels, AirDrop) are never the address a
  // coworker reaches you on — only real NICs make the list.
  const VIRTUAL_IF = /^(bridge|utun|vmnet|awdl|llw|anpi|gif|stf|ap)\d*$/;
  server.listen(port, '0.0.0.0', () => {
    const ips = Object.entries(os.networkInterfaces())
      .filter(([ifname]) => !VIRTUAL_IF.test(ifname))
      .flatMap(([, addrs]) => addrs || [])
      .filter((i) => i.family === 'IPv4' && !i.internal)
      .map((i) => i.address);
    console.log(`\n  serving ${COLLECTIONS_DIR}/${name}/ read-only (committed cuts only) — ctrl-c to stop`);
    for (const h of [...new Set([mdnsName(), ...ips].filter(Boolean))]) {
      console.log(`    npx atelier add http://${h}:${port}/${name}`);
    }
    console.log('');
  });
  server.on('error', (e) => fail(`could not listen on :${port} — ${e.message}`));
} else {
  /* ---- --to / bare: git push ------------------------------------------------ */
  // github:owner/repo → push over ssh (your keys); consumers add the same
  // spec and clone anonymously over https.
  const pushUrl = to && /^github:[\w.-]+\/[\w.-]+$/.test(to)
    ? `git@github.com:${to.slice(7)}.git`
    : to ? to.replace(/^git\+/, '') : null;
  const origin = (() => { try { return git(['remote', 'get-url', 'origin'], dir).trim(); } catch { return null; } })();
  if (!pushUrl && !origin) fail(`collection "${name}" has no git origin yet — tell publish where to put it:\n  ${CLI_NAME} publish ${name} --to github:owner/repo   (or any git url, --serve, --bundle)`);
  const target = pushUrl || origin;
  try {
    git(['push', '-u', target, 'HEAD'], dir, { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (e) {
    fail(`git push to ${target} failed — check the repo exists and you can push to it\n  ${gitErr(e)}`);
  }
  if (pushUrl && !origin) { try { git(['remote', 'add', 'origin', pushUrl], dir); } catch {} }
  console.log(`\n  ✓ pushed ${COLLECTIONS_DIR}/${name}  →  ${target}`);
  if (to && to.startsWith('github:')) console.log(`    others install it with:  npx atelier add ${to}\n`);
  else console.log('');
}
