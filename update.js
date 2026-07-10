#!/usr/bin/env node
/* atelier update — bring installed modules up to their collection's latest cut.
 *
 *   npx atelier update                          everything, across all subscriptions
 *   npx atelier update <collection>             one collection's installed modules
 *   npx atelier update <collection>/<module>    one module
 *   … [--merge | --overwrite]                   decide for dirty modules without a prompt
 *   npx atelier update <collection>/<module> --continue | --abort
 *
 * update is the counterpart of add: add only creates, update only upgrades
 * what you already have. It pulls the mirror, then reasons per module from
 * the `.atelier` provenance add wrote at install time (the mirror commit the
 * module came from — the merge base):
 *
 *   no local edits      → take the new cut (build-gated, atomically swapped)
 *   local edits         → the merge is STAGED FIRST, so the prompt reports
 *                         facts, not predictions: merge verified clean →
 *                         [M]erge / [o]verwrite / [s]kip / [d] show my edits;
 *                         real conflicts → the merge option disappears and
 *                         [a] stages the half-merged tree in
 *                         <module>/.update-merge/ for your agent to resolve
 *                         (then --continue gates + lands it, --abort discards)
 *
 * Nothing is ever decided silently: true conflicts are never auto-resolved
 * (picking a side produces wrong code wearing a ✓), markers are never dumped
 * into the live module (it keeps running the old version until a resolved,
 * building merge swaps in), and without a TTY the default is skip + report —
 * an agent must not choose between merging and discarding the operator's
 * edits. Merge output is fully local: the mirror stays pull-pristine, and
 * your surviving edits simply become the new local delta, re-merged on every
 * future update. Live data/ and .env* are preserved on every path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveRoot } from './discovery.js';
import {
  COLLECTIONS_DIR, collectionDir, listCollections, readPkg, readModuleMeta,
  copyModuleFiltered, git, gitErr, gitHead, channelHead, aheadOfChannel, extractTreeAt,
  instanceModuleDirs, CLI_NAME,
} from './collections.js';
import { buildProblems } from './gate.js';

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const fail = (msg) => { console.error(`\natelier update: ${msg}\n`); process.exit(1); };

/* ---- args ---------------------------------------------------------------- */
const USAGE = `usage: atelier update [<collection>[/<module>]] [--merge | --overwrite]
       atelier update <collection>/<module> --continue   land a resolved .update-merge
       atelier update <collection>/<module> --abort      discard a staged merge
  --merge      when you have local edits: take the update with your edits on top
               (real conflicts are staged for resolution, never auto-picked)
  --overwrite  when you have local edits: take the new cut exactly as published,
               discarding your edits
  (no flag, no terminal → dirty modules are skipped and reported)`;
const args = process.argv.slice(2);
let target = null, mode = null, cont = false, abort = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--merge') mode = 'merge';
  else if (a === '--overwrite') mode = 'overwrite';
  else if (a === '--continue') cont = true;
  else if (a === '--abort') abort = true;
  else if (!a.startsWith('-') && target === null) target = a;
  else fail(`unknown option: ${a}\n\n${USAGE}`);
}

const ROOT = resolveRoot({ atelierRoot: process.env.ATELIER_ROOT, pwd: process.env.PWD, hostDir: HOST_DIR });
console.log(`\n  instance: ${ROOT}`);

/* ---- installed modules, by provenance ------------------------------------------
 * Sweeps everything the instance mounts — root folders, $<ws>/ folders, and
 * config path-mounts — so a module installed (or linked) anywhere on disk
 * updates in place. Membership = the .atelier file, wherever the folder is.
 * ---------------------------------------------------------------------------------- */
function installedModules() {
  const out = [];
  for (const m of instanceModuleDirs(ROOT)) {
    try {
      const prov = JSON.parse(fs.readFileSync(path.join(m.dir, '.atelier'), 'utf8'));
      if (prov && prov.collection && prov.commit) out.push({ dir: m.dir, id: m.id, workspace: m.workspace, prov });
    } catch {}
  }
  return out;
}

let wantColl = null, wantMod = null;
if (target) {
  const parts = target.split('/');
  if (parts.length > 2 || !parts.every((p) => /^[a-zA-Z0-9][\w.-]*$/.test(p))) fail(`"${target}" — expected <collection> or <collection>/<module>\n\n${USAGE}`);
  [wantColl, wantMod] = parts;
}
if ((cont || abort) && !(wantColl && wantMod)) fail(`--${cont ? 'continue' : 'abort'} needs <collection>/<module>`);

/* ---- scratch git — where merges happen (never the live module) --------------- */
const sgit = (a, cwd, opts) => git(['-c', 'user.name=atelier', '-c', 'user.email=atelier@instance', ...a], cwd, opts);
const treeExistsAt = (mirror, commit, mod) => {
  try { git(['rev-parse', '-q', '--verify', `${commit}:${mod}`], mirror); return true; } catch { return false; }
};
const commitExists = (mirror, sha) => {
  try { git(['cat-file', '-e', `${sha}^{commit}`], mirror); return true; } catch { return false; }
};
function clearWorkdir(dir) {
  for (const e of fs.readdirSync(dir)) {
    if (e === '.git') continue;
    fs.rmSync(path.join(dir, e), { recursive: true, force: true });
  }
}
const scratchDirs = [];
process.on('exit', () => { for (const d of scratchDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

// Build the three-sided scratch repo. Returns everything a decision needs.
function stageMerge(mirror, m) {
  const { prov } = m;
  const targetSha = channelHead(mirror);   // theirs = the PUBLISHED channel, never local unpublished cuts
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-update-'));
  scratchDirs.push(scratch);
  extractTreeAt(mirror, prov.commit, prov.module, scratch);
  const baseVersion = readPkg(scratch).version || '0.0.0';
  sgit(['init', '-q'], scratch);
  sgit(['add', '-A', '--force'], scratch); sgit(['commit', '-q', '-m', 'base', '--allow-empty'], scratch);
  const baseSha = gitHead(scratch);
  sgit(['checkout', '-q', '-b', 'theirs'], scratch);
  clearWorkdir(scratch);
  extractTreeAt(mirror, targetSha, prov.module, scratch);
  const newVersion = readPkg(scratch).version || '0.0.0';
  sgit(['add', '-A', '--force'], scratch); sgit(['commit', '-q', '-m', 'theirs', '--allow-empty'], scratch);
  sgit(['checkout', '-q', '-b', 'ours', baseSha], scratch);
  clearWorkdir(scratch);
  fs.cpSync(m.dir, scratch, {
    recursive: true,
    filter: (p) => {
      const rel = path.relative(m.dir, p);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      return !['node_modules', 'data', '.git', '.atelier', '.update-merge'].includes(top) && !top.startsWith('.env');
    },
  });
  sgit(['add', '-A', '--force'], scratch); sgit(['commit', '-q', '-m', 'ours', '--allow-empty'], scratch);
  const oursSha = gitHead(scratch);
  const dirty = git(['rev-parse', `${baseSha}^{tree}`], scratch).trim()
             !== git(['rev-parse', `${oursSha}^{tree}`], scratch).trim();
  const editedFiles = dirty ? git(['diff', '--name-only', baseSha, oursSha], scratch).trim().split('\n').filter(Boolean) : [];
  let merged = true, conflicts = [];
  if (dirty) {
    try { sgit(['merge', '-q', 'theirs'], scratch); }
    catch {
      merged = false;
      conflicts = git(['diff', '--name-only', '--diff-filter=U'], scratch).trim().split('\n').filter(Boolean);
    }
  }
  return { scratch, baseSha, oursSha, targetSha, baseVersion, newVersion, dirty, editedFiles, merged, conflicts };
}

/* ---- landing — the staged, atomic swap (add's pattern) ------------------------
 * Copies a result tree into a discovery-invisible staging dir, installs deps
 * THERE (a failure aborts the swap — the working old version is protected),
 * writes advanced provenance, carries the LIVE data/ and .env* over by rename
 * at the last moment, then swaps atomically.
 * -------------------------------------------------------------------------------- */
const pendingStagings = new Set();
process.on('exit', () => { for (const s of pendingStagings) { try { fs.rmSync(s, { recursive: true, force: true }); } catch {} } });

function landModule(srcDir, m, newCommit) {
  const destParent = path.dirname(m.dir);
  const staging = path.join(destParent, `.update-${m.id}-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  pendingStagings.add(staging);
  fs.cpSync(srcDir, staging, {
    recursive: true,
    filter: (p) => {
      const rel = path.relative(srcDir, p);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      return !['node_modules', 'data', '.git', '.atelier', '.update-merge', '.state.json'].includes(top) && !top.startsWith('.env');
    },
  });
  const pkg = readPkg(staging);
  if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
    console.log(`  installing dependencies for ${m.id} (${Object.keys(pkg.dependencies).join(', ')})…`);
    try {
      execFileSync(process.env.npm_execpath ? process.execPath : 'npm',
        process.env.npm_execpath
          ? [process.env.npm_execpath, 'install', '--no-fund', '--no-audit']
          : ['install', '--no-fund', '--no-audit'],
        { cwd: staging, stdio: ['ignore', 'inherit', 'inherit'] });
    } catch {
      fs.rmSync(staging, { recursive: true, force: true });
      pendingStagings.delete(staging);
      console.error(`  ✗ dependency install failed for ${m.id} — NOT updated, the running version is untouched.`);
      return false;
    }
  }
  fs.writeFileSync(path.join(staging, '.atelier'), JSON.stringify({
    collection: m.prov.collection, module: m.prov.module, commit: newCommit,
    installedAt: m.prov.installedAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  // live data/ + .env* survive every update path
  const oldData = path.join(m.dir, 'data');
  if (fs.existsSync(oldData)) fs.renameSync(oldData, path.join(staging, 'data'));
  for (const e of fs.readdirSync(m.dir)) {
    if (e.startsWith('.env')) fs.renameSync(path.join(m.dir, e), path.join(staging, e));
  }
  fs.rmSync(m.dir, { recursive: true, force: true });
  fs.renameSync(staging, m.dir);
  pendingStagings.delete(staging);
  return true;
}

async function gateDir(dir) {
  return buildProblems(dir, { isChrome: !!readModuleMeta(dir).isChrome });
}

/* ---- the conflict hand-off ----------------------------------------------------- */
function stageHandoff(m, st) {
  const stagingDir = path.join(m.dir, '.update-merge');
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.cpSync(st.scratch, stagingDir, {
    recursive: true,
    filter: (p) => path.relative(st.scratch, p).split(path.sep)[0] !== '.git',
  });
  fs.writeFileSync(path.join(stagingDir, '.state.json'), JSON.stringify({
    collection: m.prov.collection, module: m.prov.module, base: m.prov.commit, target: st.targetSha,
  }, null, 2) + '\n');
  const qual = `${m.prov.collection}/${m.prov.module}`;
  console.log(`  → staged: ${path.relative(ROOT, stagingDir)}   (your module is untouched, still running the old version)`);
  if (st.conflicts.length) console.log(`    conflicts in: ${st.conflicts.join(', ')}`);
  console.log(`    have your agent resolve it:`);
  console.log(`      claude "resolve the merge conflicts in ${stagingDir}, then run: ${CLI_NAME} update ${qual} --continue"`);
  console.log(`    or discard it:  ${CLI_NAME} update ${qual} --abort`);
}

/* ---- prompts ----------------------------------------------------------------- */
const interactive = process.stdin.isTTY && process.stdout.isTTY;
async function ask(question, letters, def) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  if (!a) return def;
  return letters.includes(a[0]) ? a[0] : def;
}

/* ---- --continue / --abort ------------------------------------------------------ */
if (cont || abort) {
  const m = installedModules().find((x) => x.prov.collection === wantColl && x.prov.module === wantMod);
  if (!m) fail(`no installed module with provenance ${wantColl}/${wantMod}`);
  const stagingDir = path.join(m.dir, '.update-merge');
  if (!fs.existsSync(stagingDir)) fail(`nothing staged for ${wantColl}/${wantMod} (no ${path.relative(process.cwd(), stagingDir)})`);
  if (abort) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    console.log(`  aborted — ${m.id} left as it was.\n`);
    process.exit(0);
  }
  let state = null;
  try { state = JSON.parse(fs.readFileSync(path.join(stagingDir, '.state.json'), 'utf8')); } catch {}
  if (!state?.target) fail(`${stagingDir}/.state.json is missing or unreadable — re-run: atelier update ${wantColl}/${wantMod}`);
  // leftover conflict markers = not resolved, regardless of whether they'd build
  const markers = [];
  const scanMarkers = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'data') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { scanMarkers(p); continue; }
      try { if (/^<{7} /m.test(fs.readFileSync(p, 'utf8'))) markers.push(path.relative(stagingDir, p)); } catch {}
    }
  };
  scanMarkers(stagingDir);
  if (markers.length) fail(`conflict markers still present in: ${markers.join(', ')} — finish resolving, then --continue`);
  const problems = await gateDir(stagingDir);
  if (problems.length) {
    console.error(`  ✗ the resolved merge doesn't build — NOT landed, the running version is untouched.\n`);
    console.error('  ' + problems.join('\n  ').split('\n').join('\n  ') + '\n');
    process.exit(1);
  }
  if (!landModule(stagingDir, m, state.target)) process.exit(1);
  console.log(`  ✓ ${m.workspace}/${m.id} updated — merge landed.\n`);
  process.exit(0);
}

/* ---- the main loop -------------------------------------------------------------- */
const all = installedModules();
const collections = wantColl ? [wantColl] : [...new Set(all.map((m) => m.prov.collection))].sort();
if (!collections.length) {
  console.log(`  nothing to update — no installed modules carry provenance (installed via atelier add).\n`);
  process.exit(0);
}
let updated = 0, skipped = 0, staged = 0, failed = 0;

for (const coll of collections) {
  const mirror = collectionDir(ROOT, coll);
  if (!fs.existsSync(mirror)) {
    console.log(`  ! not subscribed to "${coll}" (no ${COLLECTIONS_DIR}/${coll}/) — resubscribe to update its modules`);
    if (wantColl) process.exit(1);
    continue;
  }
  const before = channelHead(mirror);
  const hasRemote = (() => { try { git(['remote', 'get-url', 'origin'], mirror); return true; } catch { return false; } })();
  if (hasRemote) {
    try { git(['fetch', '-q'], mirror); }
    catch (e) { console.log(`  ! could not reach ${coll}'s origin — updating from the local mirror\n    (${gitErr(e)})`); }
    try { git(['merge', '-q', '--ff-only', channelHead(mirror)], mirror); } catch {}   // keep the branch riding along when it can
  }
  const head = channelHead(mirror);
  console.log(`  pulled: ${coll}${head !== before ? `   (${before?.slice(0, 7)}..${head.slice(0, 7)})` : '   (already current)'}`);
  const ahead = aheadOfChannel(mirror);
  if (ahead) console.log(`  · ${coll}: ${ahead} unpublished local cut${ahead === 1 ? '' : 's'} on the mirror — receiving from the published channel; ${CLI_NAME} publish ${coll} when ready`);

  let mods = all.filter((m) => m.prov.collection === coll);
  if (wantMod) {
    mods = mods.filter((m) => m.prov.module === wantMod);
    if (!mods.length) fail(`no installed module with provenance ${coll}/${wantMod}`);
  }

  for (const m of mods) {
    const qual = `${m.workspace}/${m.id}`;
    if (fs.existsSync(path.join(m.dir, '.update-merge'))) {
      console.log(`  · ${qual} has a staged merge pending — finish it first: ${CLI_NAME} update ${coll}/${m.prov.module} --continue (or --abort)`);
      staged++;
      continue;
    }
    if (!commitExists(mirror, m.prov.commit)) {
      if (mode === 'overwrite') { /* fall through: overwrite doesn't need the base */ }
      else {
        console.log(`  ! ${qual}: its install commit is gone from the mirror (history rewritten?) — take the current cut with --overwrite, or resubscribe`);
        skipped++;
        continue;
      }
    }
    if (!treeExistsAt(mirror, head, m.prov.module)) {
      console.log(`  · ${qual}: removed upstream — keeping yours`);
      skipped++;
      continue;
    }
    // upstream unchanged since install → just advance provenance quietly
    if (commitExists(mirror, m.prov.commit)) {
      let upChanged = true;
      try { git(['diff', '--quiet', m.prov.commit, head, '--', m.prov.module], mirror); upChanged = false; } catch {}
      if (!upChanged) {
        if (m.prov.commit !== head) {
          const prov = { ...m.prov, commit: head };
          fs.writeFileSync(path.join(m.dir, '.atelier'), JSON.stringify(prov, null, 2) + '\n');
        }
        console.log(`  · ${qual} up to date`);
        continue;
      }
    }

    const st = stageMerge(mirror, m);
    const vline = st.baseVersion === st.newVersion ? st.newVersion : `${st.baseVersion} → ${st.newVersion}`;

    if (!st.dirty) {
      sgit(['checkout', '-q', 'theirs'], st.scratch);   // no local edits → the result IS the new cut
      const problems = await gateDir(st.scratch);
      if (problems.length) {
        console.log(`  ! ${qual} ${vline}: the new cut doesn't build here — skipped\n    ${problems.join('\n    ')}`);
        failed++;
        continue;
      }
      if (landModule(st.scratch, m, st.targetSha)) {
        console.log(`  ✓ ${qual} ${vline}   (no local edits)`);
        updated++;
      } else failed++;
      continue;
    }

    // dirty — the merge already ran in scratch; decide from facts
    const decide = async () => {
      if (mode) return mode === 'merge' ? (st.merged ? 'm' : 'a') : 'o';
      if (!interactive) return 's';
      const head_ = st.merged
        ? `  ${m.id} ${vline} — you've edited ${st.editedFiles.length} file${st.editedFiles.length === 1 ? '' : 's'}. your edits merge cleanly ✓\n      [M] merge — take the update, keep your edits   [o] overwrite   [s] skip   [d] show my edits\n      > `
        : `  ${m.id} ${vline} — you've edited ${st.editedFiles.length} file${st.editedFiles.length === 1 ? '' : 's'}; ${st.conflicts.length} conflict with the update ✗\n      [a] agent — stage the merge for your agent to resolve   [o] overwrite   [s] skip   [d] show my edits\n      > `;
      const letters = st.merged ? ['m', 'o', 's', 'd'] : ['a', 'o', 's', 'd'];
      const def = st.merged ? 'm' : 'a';
      for (;;) {
        const a = await ask(head_, letters, def);
        if (a !== 'd') return a;
        console.log(git(['diff', st.baseSha, st.oursSha], st.scratch));
      }
    };

    let choice = await decide();

    if (choice === 'm') {
      const problems = await gateDir(st.scratch);
      if (problems.length) {
        // textually clean, semantically broken — raise it, never land it
        console.log(`  ! ${qual} ${vline}: your edits merge cleanly but the result doesn't build ✗`);
        choice = mode ? 'a' : (interactive
          ? await ask(`      [a] agent — stage it for your agent to fix   [o] overwrite   [s] skip\n      > `, ['a', 'o', 's'], 'a')
          : 's');
      } else {
        if (landModule(st.scratch, m, st.targetSha)) {
          console.log(`  ✓ ${qual} ${vline}   (your ${st.editedFiles.length} edited file${st.editedFiles.length === 1 ? '' : 's'} kept)`);
          updated++;
        } else failed++;
        continue;
      }
    }
    if (choice === 'o') {
      // take theirs exactly as published — informed consent, no backup confetti
      sgit(['checkout', '-q', '--force', 'theirs'], st.scratch);
      sgit(['clean', '-qfd'], st.scratch);
      if (landModule(st.scratch, m, st.targetSha)) {
        console.log(`  ✓ ${qual} ${vline}   (overwritten — your edits discarded)`);
        updated++;
      } else failed++;
    } else if (choice === 'a') {
      stageHandoff(m, st);
      staged++;
    } else if (choice === 's') {
      console.log(`  · ${qual} skipped — you have local edits (${st.editedFiles.length} file${st.editedFiles.length === 1 ? '' : 's'}); decide with --merge or --overwrite`);
      skipped++;
    }
  }
}

const parts = [];
if (updated) parts.push(`${updated} updated`);
if (skipped) parts.push(`${skipped} skipped`);
if (staged) parts.push(`${staged} staged for resolution`);
if (failed) parts.push(`${failed} failed`);
console.log(`\n  ${parts.length ? parts.join(', ') : 'everything up to date'}.\n`);
process.exit(staged || failed ? 1 : 0);
