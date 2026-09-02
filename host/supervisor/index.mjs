// host/supervisor/index.mjs — the app supervisor (DESIGN §4.1 "supervisor/index.mjs", §6.1, §10.3).
//
// One table of instances; per instance TWO slots (D3): `row.dev` — the agent's working tree, hot
// reloaded on every save, one watcher over the folder, never seen by the company — and `row.prod` —
// the released commit's export, what the protocol port (:1845, the shell's road) serves. A save = one
// DEV revision: module.json check → backend bundle + frontend transform + one Tailwind sheet (all
// reads with the app's gid held) → rev dir written beside the old → a NEW dev worker spawned from the
// rev dir while the old serves → on READY the three swap under one rev, the old worker stops 500 ms
// later. Any failure → `report('build', …)` with the `dev:` head; users are never touched. A release
// (`atelier deploy`, supervisor/deploy.mjs) is the only way onto the prod slot: commit → rehearsal on
// a copy of the data → the gate (requests held ≤ 10 s, then the shell's waking bytes) → stop old →
// backup → migrate → start → probe → release. Prod never overlaps (D13); the dev slot keeps the
// load-beside + one mount retry rule. Idle-stop: prod only when its READY `resources` are empty or it
// sent `{t:'suspendable'}`, 60 s without a request; dev after 10 min whatever it holds (D18) — unless the
// computer is `always-on` (API 50 `sleep` via `registrar.sleep`, applied at every scan): then dev stays live;
// resume from the slot's pointer with requests held. Boot resumes prod (`current`) only.
//
// Collaborators are injected (DESIGN §4): `spawn` = worker/spawn.mjs spawnWorker, `proxy` =
// worker/proxy.mjs proxyRequest, `jail` = worker/jail.mjs {jailPlan, applyJail, claimRoundTrip, …},
// `install` = worker/install.mjs installDeps, `hook` = worker/hook.mjs runHook, `report` =
// errors/collector.mjs report, `registrar` = protocol/registrar.mjs, `chrome` = host/chrome/fetch.mjs
// createChromeCache (`dir()` the chrome folder every sheet compiles against — the cache's `current`
// when the host holds a release, else `cfg.chromeDir`; `digest()`/`base()` the held release; absent =
// `cfg.chromeDir` alone, as before). Without `jail`/`install` the supervisor creates the per-instance
// dirs itself and treats an install event as a plain rebuild (local mode / tests). `rebuildAll(label)`
// (step 7 ship C, decision 8) follows a chrome swap: every prod slot gets a NEW rev = its code + a sheet
// compiled against the new chrome (`store.clone`, no gate, no restart — the worker keeps running; `onSwap`
// → modulesChanged → the company's frames), every linked row a dev rebuild.
import nodeFs from 'node:fs'
import path from 'node:path'
import { discover, checkModuleJson } from './discovery.mjs'
import { createWatcher, fingerprint } from './watcher.mjs'
import { bundleBackend, transformFrontend, classifyWorkerFailure, formatHint, sourceMapLookup } from './bundle.mjs'
import { buildSheet } from './tailwind.mjs'
import { createStore, gitInit } from './lastgood.mjs'
import { createServe } from './serve.mjs'
import { mkSlot, sockName, REL, deferred, COMMIT_RE, commit12 } from './slots.mjs'
import { createDeployer, MESSAGES, DEPLOY_TIMING } from './deploy.mjs'
import { createMetrics } from '../metrics.mjs'
import { lockSockDir } from '../worker/jail.mjs'

export const DEFAULT_TIMING = Object.freeze({
  quiesceMs: 100, idleMs: 60_000, devIdleMs: 600_000, keepMs: 600_000, swapStopMs: 500, drainMs: 2000, readyTimeoutMs: 8000,
  gateHoldMs: 10_000,
  backoffMs: [500, 1000, 2000, 4000, 8000, 16000, 30000],
  stableMs: 60_000,          // a resumed worker alive this long resets the crash ladder (a LIVE build resets it at once)
  rlimits: { data: 1024 * 1024 * 1024, core: 0, nproc: 64, nofile: 1024 },
  deploy: DEPLOY_TIMING,
})

/** @typedef {{instance, slug, company, uid, rev:number|null, state:'live'|'stopped'|'loading'|'failed'|'down'|'undeployed'|'unclaimed', pid?:number, sock?:string, dataDir, dir, deployed_rev, prod_rev, dev_rev, prod_state, dev_state}} AppRow */

export function createSupervisor({ os, dirfd, cfg = {}, log = () => {}, report = () => {}, registrar, onSwap = () => {}, onDevSwap = () => {}, onResume = () => {}, spawn, proxy, fs = nodeFs, timing = {}, jail = null, install = null, hook = null, onBroadcast = () => {}, hostVersion = '2.0.0', treeOk = () => true, metrics = createMetrics(), hostEnv = process.env, chrome = null }) {
  const T = { ...DEFAULT_TIMING, ...timing, deploy: { ...DEPLOY_TIMING, ...(timing.deploy ?? {}) } }
  const emit = typeof log === 'function' ? log : (line) => log.write(line)
  const store = createStore({ os, dirfd, fs, log: emit, hostVersion })
  const rows = new Map()   // instance → row
  const appsDir = path.join(cfg.work ?? '/work', 'apps')
  // the chrome every sheet compiles against: the held release (host/chrome/fetch.mjs) first, `cfg.chromeDir` else
  const chromeDirOf = () => chrome?.dir?.() ?? cfg.chromeDir ?? null
  const chromeBaseOf = () => chrome?.base?.() ?? null
  const chromeNameOf = () => chrome?.digest?.() ?? (cfg.chromeDir ? path.basename(cfg.chromeDir) : null)   // revision.json.chrome: the digest, else the folder's name
  const company = () => registrar?.company ?? cfg.company ?? 'local'
  const origin = () => registrar?.origin ?? cfg.origin ?? 'http://127.0.0.1:1844'
  // Paths handed to OTHER processes (the worker's codeDir/dataDir/tmpDir, the watchdog's du as the worker
  // uid) must be real: the host's `at(dirfd, …)` form is `/proc/self/fd/N/…` and names the HOST's fd.
  const atelierReal = (() => { try { return os.readlinkFd(dirfd) } catch { return null } })()
  const dirfdPrefix = `/proc/self/fd/${dirfd}`
  const realPath = (p) => (atelierReal && typeof p === 'string' && (p === dirfdPrefix || p.startsWith(dirfdPrefix + '/')) ? atelierReal + p.slice(dirfdPrefix.length) : p)
  const dot = (r) => os.at(dirfd, r)          // the dirfd form: the host's own writes
  const rel = (r) => realPath(dot(r))         // the real path: what leaves the host
  const timers = new Set()
  const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn() }, ms); t.unref?.(); timers.add(t); return t }

  // --- the app-group rule (§6.2): reads of an app folder run with its gid held; ref-counted so
  // concurrent builds of two apps never drop each other's group.
  const held = new Map()
  const setGroups = () => { try { os.setgroups([...held.keys()]) } catch (e) { emit(`setgroups: ${e.code ?? e.message}`) } }
  async function withGroup(uid, fn) {
    held.set(uid, (held.get(uid) ?? 0) + 1); setGroups()
    try { return await fn() } finally { const n = held.get(uid) - 1; if (n) held.set(uid, n); else held.delete(uid); setGroups() }
  }
  const withGroupSync = (uid, fn) => { held.set(uid, (held.get(uid) ?? 0) + 1); setGroups(); try { return fn() } finally { const n = held.get(uid) - 1; if (n) held.set(uid, n); else held.delete(uid); setGroups() } }
  // discovery reads module.json in every claimed (2750 1000:appgid) folder: hold every known gid for that walk
  // groupFs(uid): the node-fs-shaped object the watcher reads through — every call holds the app's gid
  const groupFs = (uid) => new Proxy(fs, { get: (t, k) => (typeof t[k] === 'function' ? (...a) => withGroupSync(uid, () => t[k](...a)) : t[k]) })
  const withAllGroupsSync = (fn) => { const uids = [...new Set([...rows.values()].map((r) => r.uid).filter((u) => u > 0))]; for (const u of uids) held.set(u, (held.get(u) ?? 0) + 1); setGroups(); try { return fn() } finally { for (const u of uids) { const n = held.get(u) - 1; if (n) held.set(u, n); else held.delete(u) } setGroups() } }

  function mkRow({ instance, slug, uid, company: co, dir }) {
    const row = {
      instance, slug, uid, company: co, dir, meta: null,
      linked: false, claimed: false, seeded: false,
      tmpDir: rel(`tmp/${instance}`), sockDir: path.join(cfg.run ?? '/run/atelier', 'w', instance),
      counter: 0, fingerprint: null, attempted: null,
      building: null, pending: false, broken: null, watcher: null, installing: null, installPending: false, git: Promise.resolve(), gitInit: null, gitReady: false,
      savedAt: null, tailwindWarm: false, deploying: null, configStamp: null, rehearsal: null, releasing: null, spawning: 0,
      configDoc: null, configWhy: null,   // the last-known composed document (§7 appConfig, this host life only) and the door failure last logged
      dev: mkSlot('dev', { appDir: dir, dataDir: rel(REL.devData(instance)) }),
      prod: null,
      armIdle: (slot) => armIdle(row, slot ?? row.prod ?? row.dev),
    }
    rows.set(instance, row)
    return row
  }
  const exportDir = (row, commit) => rel(REL.prodExport(row.instance, commit))
  const prodSlot = (row, { rev = null, commit = null, legacy = false, appDir }) => mkSlot('prod', { appDir: appDir ?? (legacy ? row.dir : exportDir(row, commit)), dataDir: rel(REL.prodData(row.instance)), rev, commit, legacy })
  const appRow = (r) => ({
    instance: r.instance, slug: r.slug, company: r.company, uid: r.uid,
    rev: r.prod?.rev ?? null, state: !r.linked ? 'unclaimed' : r.prod ? r.prod.state : 'undeployed',
    pid: r.prod?.live?.pid, sock: r.prod?.live?.sock ?? undefined, dataDir: r.prod?.dataDir ?? rel(REL.prodData(r.instance)), dir: r.dir,
    deployed_rev: r.prod?.commit ?? null, prod_rev: r.prod?.rev ?? null, dev_rev: r.dev.rev, prod_state: r.prod?.state ?? null, dev_state: r.dev.state,
  })
  const devMsg = (slot, m) => (slot.name === 'prod' ? String(m) : MESSAGES.devBuild.message(m))
  const reportRev = (row) => row.prod?.rev ?? 0   // EVERY dev/rehearsal report carries the PROD rev (the spine keeps one running rev per instance)
  // a PROD worker's report carries the SLOT's rev while it is the slot's live worker — a chrome swap mints a new rev of the
  // same code under the running worker (commitChromeSheet), and a report at the worker's birth rev would be `stale-rev` at
  // the collector and the spine (review 2026-09-02, Grok 2); a retiring worker (another one is the slot's) keeps its own
  const prodRev = (row, slot, live) => (slot.name === 'prod' ? (slot.live === live ? slot.rev : live.rev) : reportRev(row))

  // --- the app config (DESIGN §7 appConfig → {env:{K:V}}; the hold rule of §6.1) -----------------------------
  // readConfig(row) → the composed document {K:V}, fresh from the door and cached as `row.configDoc` for this host life
  // (never to disk); a 404 (no config rows) is the empty document. Throws the transport's error on anything else — a
  // 5xx, API 50's `503 no config key`, a network error, a timeout — and throws on a MASKED document: a 200 whose
  // `sealed_missing` names keys the spine could not unseal (API 50) is no document at all — the partial env never becomes
  // the last-known one; the error names the keys, never a value. The caller decides.
  async function readConfig(row) {
    if (!registrar?.appConfig) return {}
    let r
    try { r = await registrar.appConfig(row.instance) }
    catch (e) { if (e?.status !== 404) throw e; r = { env: {} } }
    const missing = Array.isArray(r?.sealed_missing) ? r.sealed_missing.filter((k) => typeof k === 'string') : []
    if (missing.length) throw new Error(`spine cannot unseal ${missing.join(', ')} (sealed_missing)`)
    row.configDoc = r?.env ?? {}
    if (row.configWhy) { row.configWhy = null; emit(`[${row.slug}] app config: the door answers again`) }
    return row.configDoc
  }
  // configFailed(row, e): one line per row per reason (not one per spawn or per scan), until the door answers again
  function configFailed(row, e) {
    const why = e?.message ?? String(e)
    if (row.configWhy === why) return
    row.configWhy = why
    emit(`[${row.slug}] app config: ${why} — ${row.configDoc ? 'spawning with the last-known document (swapped at the next successful read)' : 'no known document: spawn HELD (retried at each scan)'}`)
  }
  // configRetry(row) → true when the row's spawns may go. A row with a HELD slot (a spawn refused for want of a document) or
  // a STALE prod worker (spawned on the last-known one) reads the door once per scan: held → the spawn is retried only after
  // the door answered (a rebuild against a closed door would mint a rev every 30 s, §6.1); stale → settleStale. Others: no read.
  async function configRetry(row) {
    const held = row.dev.configHeld || !!row.prod?.configHeld
    if (!held && !row.prod?.configStale) return true
    try { await readConfig(row) } catch (e) { configFailed(row, e); return !held }
    settleStale(row)
    return true
  }
  // settleStale(row): the prod worker ran on the last-known document; the door answered — the same document: nothing;
  // a moved one: a config release (D16, the same restart a config stamp brings); idle-stopped: the next resume reads fresh
  function settleStale(row) {
    const slot = row.prod
    if (!slot?.configStale) return
    if (!slot.live || slot.configUsed === JSON.stringify(row.configDoc)) { slot.configStale = false; return }
    if (row.deploying || slot.state === 'down') return   // a release in flight spawns fresh itself; DOWN stays down (S2)
    emit(`[${row.slug}] app config: the document moved while rev ${slot.rev} ran on the last-known one — config release`)
    deployer.configRelease(row).catch((e) => emit(`[${row.slug}] config release crashed: ${e?.stack ?? e}`))
  }

  // --- worker spec (§4.1 WorkerSpec) ----------------------------------------------------------
  // The config door decides whether the spawn goes (§6.1 "config hold"): a fresh document (or a 404) → the spawn; the door
  // failing WITH a last-known document → the spawn on that one, `configStale` for the slot (the scan swaps the fresh
  // document in); failing WITHOUT one → `{error:'config-held'}` — no worker rather than one without its env (2026-09-02:
  // the system host's `home` spawned without SPINE_ADMIN and the portal was dark for every signed-in user).
  // `config:false` (the install specs): no read — an install runs without the document.
  async function workerSpec(row, slot, rev, codeDir, { appDir, dataDir, sockFile, config = true } = {}) {
    let configEnv = {}, configStale = false
    if (config) {
      try { configEnv = await readConfig(row) } catch (e) {
        configFailed(row, e)
        if (!row.configDoc) throw { error: 'config-held', msg: e?.message ?? String(e) }
        configEnv = row.configDoc; configStale = true
      }
    }
    // one socket per slot and rev (D5): load-beside needs the new dev worker bound while the old one still
    // serves, a proxy's keep-alive pool is keyed by socket path, and dev and prod never share a name
    return {
      instance: row.instance, slug: row.slug, name: row.meta?.name, company: row.company, uid: row.uid, rev, codeDir: codeDir ? realPath(codeDir) : null, appDir: appDir ?? slot.appDir,
      dataDir: dataDir ?? slot.dataDir, tmpDir: row.tmpDir, scratchDir: rel(`scratch/${row.instance}`), sockDir: row.sockDir, sock: path.join(row.sockDir, sockFile ?? sockName(slot.name, rev)),
      baseUrl: `${origin()}/api/${row.company}/${row.slug}`, origin: origin(), configEnv, configStale, rlimits: T.rlimits,
    }
  }
  // prepareDirs: a failed mkdir/chown/chmod of data/<inst>, tmp/<inst> or w/<inst> (ENOSPC, a wrong-owner
  // EEXIST, a failed chown) is a host-side `worker` failure, never a spawn into a half-made jail.
  function prepareDirs(row, spec) {
    if (jail) {
      const r = jail.applyJail(os, jail.jailPlan(spec), (l) => emit(`[${row.slug}] ${l}`))
      if (!r.ok) { const f = r.results.at(-1); throw { error: 'jail', msg: `${f.step.op} ${f.step.path ?? ''}: ${f.code}` } }
      return
    }
    for (const d of [spec.dataDir, spec.tmpDir, spec.sockDir]) { try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }) } catch {} }
    try { fs.rmSync(spec.sock, { force: true }) } catch {}
  }

  // startWorker(row, slot, rev, codeDir, opts) → {live, resources, suspendable, teardown} ; throws {error, msg, failed?}
  //   error: 'no-ready' | 'spawn-eagain' | 'load-failed' | 'jail' | 'host-fault' (the .atelier tree moved: no real path may leave the host)
  //          | 'config-held' (the config door failed and the row has no last-known document — workerSpec; no worker was spawned)
  //   opts: {appDir, dataDir, sockFile, lockSocket, ephemeral} — the rehearsal worker (deploy.mjs) is ephemeral: its
  //   exit is nobody's crash; its socket is `0:<uid> 0770` (lockSocket 'shared') so the smoke step dials it as the worker.
  //   The socket dir `w/<inst>` is shared by every worker of the instance (dev, prod, rehearsal): its write bit is opened by
  //   prepareDirs before each bind and dropped (0710) only when the LAST spawn in flight has settled — `row.spawning` counts
  //   them. One worker's READY must never lock the dir under another's `listen` (drill row 9e: a prod resume landing READY
  //   while the rehearsal worker bound → `listen EACCES … w-rehearsal-6.sock`).
  async function startWorker(row, slot, rev, codeDir, opts = {}) {
    if (!treeOk()) throw { error: 'host-fault', msg: '/work/.atelier renamed or removed' }
    row.spawning++
    let spec
    try {
      spec = await workerSpec(row, slot, rev, codeDir, opts)
      return await startPrepared(row, slot, rev, spec, opts)
    } finally {
      if (--row.spawning === 0 && spec) { const r = lockSockDir(os, spec, (l) => emit(`[${row.slug}] ${l}`)); if (!r.ok) emit(`[${row.slug}] socket dir lock: ${r.results.at(-1)?.code ?? '?'}`) }
    }
  }
  async function startPrepared(row, slot, rev, spec, opts) {
    prepareDirs(row, spec)
    const st = { ready: null, failed: null, suspendable: false }
    const live = { rev, sock: spec.sock, pid: null, handle: null, slot: slot.name }
    const onControl = (msg) => {
      switch (msg.t) {
        case 'ready': st.ready = msg; break
        case 'load-failed': st.failed = msg; break
        case 'suspendable': st.suspendable = true; if (slot.live === live) { slot.suspendable = true; armIdle(row, slot) } break
        case 'error': report('backend', row.instance, prodRev(row, slot, live), { message: devMsg(slot, msg.message), stack: msg.stack, file: msg.file, line: msg.line, col: msg.col, sample: msg.sample }); break
        case 'http5xx': report('http', row.instance, prodRev(row, slot, live), { message: devMsg(slot, msg.message), file: msg.file, line: msg.line, col: msg.col, sample: { request: { method: msg.method, path: msg.path, status: msg.status } } }); break
        case 'broadcast': if (slot.name !== 'rehearsal') onBroadcast(appRow(row), msg.event, slot.name); break
      }
    }
    const onExit = (code, signal) => { if (!opts.ephemeral && slot.live === live && !live.stopping) crashed(row, slot, live, code, signal) }
    try {
      const h = await spawn({ os, spec, onControl, onExit, readyTimeoutMs: T.readyTimeoutMs, lockSocket: opts.lockSocket ?? true })
      live.handle = h; live.pid = h.pid; live.sock = h.sock ?? spec.sock
    } catch (e) {
      throw { error: e?.error ?? 'no-ready', msg: e?.msg ?? e?.message ?? String(e), failed: st.failed }
    }
    slot.configAt = row.configStamp
    slot.configUsed = JSON.stringify(spec.configEnv); slot.configStale = !!spec.configStale; slot.configHeld = false   // the document this worker runs on
    return { live, resources: st.ready?.resources ?? null, suspendable: st.suspendable, teardown: !!st.ready?.teardown }
  }
  async function stopLive(row, slot, live, reason) {
    if (!live?.handle || live.stopping) return
    live.stopping = true
    slot?.retiring?.delete(live)
    try { await live.handle.stop(T.drainMs) } catch (e) { emit(`[${row.slug}] rev ${live.rev} stop(${reason}): ${e.message}`) }
  }

  // --- the save clock (PLAN §4.5 save→verdict, alarm 1 s) --------------------------------------
  // The clock starts when the watcher's quiescence fires (a save DETECTED, not a build started — a
  // save that arrives while a build runs waits behind it and that wait is part of the number) and
  // stops at that save's verdict: the swap (LIVE) or the app-error emitted. A save with no verdict
  // — the folder vanished, the host is in fault — is dropped, never carried into the next save.
  const markSave = (row) => { if (row.savedAt == null) row.savedAt = os.now() }
  const takeSave = (row) => { const t = row.savedAt; row.savedAt = null; return t }
  const verdict = (row, savedAt, outcome) => { if (savedAt != null) metrics.save(row.slug, os.now() - savedAt, outcome) }

  // --- the three artefacts of one rev (dev AND prod builds; §6.1) ------------------------------
  // buildArtefacts(row, {appDir, rev}) → {written, backend, map} ; throws {problems} (classified) or the store's error
  async function buildArtefacts(row, { appDir, rev }) {
    const [backend, frontend, sheet] = await withGroup(row.uid, () => Promise.all([
      bundleBackend({ appDir, fs }),
      transformFrontend({ appDir, rev, fs }),
      buildSheet({ chromeDir: chromeDirOf(), appDir, fs, chromeBase: chromeBaseOf() }),
    ]))
    // the §4.5 Tailwind row: buildSheet's own ms, cold = this app's first compiled sheet of this host
    // life (no chrome dir = no compile — the app's own styles.css passed through — and no sample)
    if (sheet.chrome) { metrics.tailwind(row.slug, sheet.ms, { cold: !row.tailwindWarm }); row.tailwindWarm = true }
    const written = store.write(row.instance, rev, row.uid, { backend: backend?.code ?? null, map: backend?.map ?? null, frontend: frontend.files, css: sheet.css })
    return { written, backend, map: backend?.map ? sourceMapLookup(JSON.parse(backend.map)) : null }
  }

  // --- the dev build = one revision (§6.1; D3: the watcher drives row.dev only) ------------------
  async function build(row) {
    const slot = row.dev
    const savedAt = takeSave(row)
    if (!treeOk()) { emit(`[${row.slug}] build refused: /work/.atelier renamed or removed (host fault)`); return null }
    const t0 = os.now()
    // the snapshot store: a failed write (ENOSPC, EIO, EACCES) is a build failure the agent hears about,
    // with last-good serving; the half-written rev-N.tmp is removed
    const snapshotFailed = (e, rev) => {
      const code = e?.code ?? e?.message ?? String(e)
      report('build', row.instance, reportRev(row), { message: MESSAGES.devBuild.message(`snapshot write failed: ${code}`), hint: `the computer cannot write the snapshot (${code}) — free space on the volume (or ask the operator to grow it) and re-save`, file: 'backend.js', line: 1, col: 1 })
      emit(MESSAGES.log.devFail(row.slug, rev ?? '?', `snapshot write failed: ${code}`))
      if (rev != null) { try { store.remove(row.instance, rev) } catch {} }
      if (!slot.live) slot.state = slot.rev != null ? 'stopped' : 'failed'
      verdict(row, savedAt, 'error')
      return null
    }
    let rev
    try { rev = store.nextRev(row.instance) } catch (e) { return snapshotFailed(e, null) }
    row.counter = rev
    slot.state = slot.live ? 'live' : 'loading'
    const fail = (problems, kind = 'build') => {
      const p = problems[0], hint = formatHint(p)
      row.broken = { rev, problems }
      report(kind, row.instance, reportRev(row), { message: MESSAGES.devBuild.message(p.message), hint, file: p.file, line: p.line, col: p.col })
      emit(MESSAGES.log.devFail(row.slug, rev, hint))
      if (!slot.live) slot.state = slot.rev != null ? 'stopped' : 'failed'
      verdict(row, savedAt, 'error')
      return null
    }
    // `row.attempted` = the folder state this build is reading, recorded BEFORE the first failure
    // path (§6.1: the sweep "rebuilds only folders whose fingerprint differs from what was last
    // built"). A build that FAILED is this folder's answer, not work the next sweep owes: the rev
    // counter bumps on LIVE and FAILED alike, so retrying an unchanged folder would mint a rev
    // every 30 s, and a new rev reads downstream as a new SAVE — the app-error fold is per
    // (instance, rev) so the save's verdict is never swallowed (protocol/app-errors). The agent
    // would hear the identical `file:line` again and again for one broken save.
    const fp = withGroupSync(row.uid, () => fingerprint(row.dir, fs).hash)
    row.attempted = fp
    const mj = withGroupSync(row.uid, () => checkModuleJson(row.dir, fs))
    if (!mj.ok) return fail([mj.error])
    if (JSON.stringify(mj.meta) !== JSON.stringify(row.meta)) {
      row.meta = mj.meta
      try { await registrar?.claim?.({ slug: row.slug, meta: mj.json, dir: row.dir }) } catch (e) { emit(`[${row.slug}] meta update: ${e.message}`) }
    }
    let built
    try { built = await buildArtefacts(row, { appDir: row.dir, rev }) } catch (e) { if (e?.problems) return fail(e.problems); if (e?.code) return snapshotFailed(e, rev); throw e }
    const { written, backend, map } = built
    let next = { live: { rev, sock: null, pid: null, handle: null, slot: 'dev' }, resources: {}, suspendable: false }
    if (backend) {
      let retried = false
      for (;;) {
        try { next = await startWorker(row, slot, rev, written.dir); break } catch (e) {
          const mountErr = e.failed?.code === 'MOUNT-ERROR'
          if (mountErr && slot.live && !retried) {   // the sqlite overlap rule (§6.1, dev only — D13): once, after the old worker exited
            retried = true
            emit(`[${row.slug}] rev ${rev} mount failed beside rev ${slot.live.rev} — retrying once after the old worker exits`)
            const old = slot.live; slot.live = null; slot.state = 'loading'
            await stopLive(row, slot, old, 'mount-retry')
            continue
          }
          store.remove(row.instance, rev)
          // the config hold (§6.1): no worker, the slot `loading` unless an old dev worker serves, no report (the door's line is
          // workerSpec's, once per reason), no verdict — the save is dropped; `attempted` cleared: the folder is NOT built (the
          // sweep owes it, needsBuild), and the scan builds it again once the door answers
          if (e.error === 'config-held') { slot.configHeld = true; row.attempted = null; if (!slot.live) slot.state = 'loading'; return null }
          const hostSide = { 'spawn-eagain': 'the host could not spawn the worker (process cap or memory) — not an app bug', jail: 'the host could not prepare the worker\'s directories (disk full or a wrong owner under /work/.atelier) — not an app bug; free space or tell the operator', 'host-fault': 'the computer\'s /work/.atelier was renamed or removed — the operator restores it; nothing is served until then' }[e.error]
          if (hostSide) {
            report('worker', row.instance, reportRev(row), { message: MESSAGES.devBuild.message(`${e.error === 'spawn-eagain' ? 'spawn failed' : e.error}: ${e.msg}`), hint: hostSide })
            emit(MESSAGES.log.devFail(row.slug, rev, `${e.error}: ${e.msg}`))
            if (!slot.live) slot.state = slot.rev != null ? 'stopped' : 'failed'
            verdict(row, savedAt, 'error')
            return null
          }
          const p = classifyWorkerFailure(e.failed ?? { code: e.error, message: e.msg }, { appDir: row.dir, fs, map })
          return fail([p])
        }
      }
    }
    swap(row, next, { sha256: written.sha256, bytes: written.bytes, fingerprint: fp, ms: os.now() - t0 })
    verdict(row, savedAt, 'live')
    return rev
  }

  // swap: the DEV slot only (a prod release is deploy.mjs's `release` step under the gate)
  function swap(row, next, { sha256, bytes, fingerprint: fp, ms }) {
    const slot = row.dev
    const old = slot.live
    const rev = next.live.rev
    slot.live = next.live; slot.rev = rev; slot.state = 'live'; row.broken = null; row.fingerprint = fp
    slot.resources = next.resources; slot.suspendable = next.suspendable; slot.restarts = 0
    store.commit(row.instance, rev, { slug: row.slug, sha256, bytes, fingerprint: fp, chrome: chromeNameOf() })
    if (old) {
      slot.kept.push({ rev: old.rev, until: os.now() + T.keepMs })
      slot.retiring.add(old)
      later(T.swapStopMs, () => stopLive(row, slot, old, 'swap'))
      later(T.keepMs + 50, () => prune(row))
    }
    onDevSwap(row.instance, rev)   // the dev shell's reload frame only — no modulesChanged, no events invalidate (D3)
    emit(MESSAGES.log.devLive(row.slug, rev, Math.round(ms)))
    armIdle(row, slot)
  }
  function prune(row) {
    const now = os.now()
    const keep = new Set()
    for (const slot of [row.dev, row.prod]) {
      if (!slot) continue
      slot.kept = slot.kept.filter((k) => k.until > now)
      for (const r of [slot.rev, ...slot.kept.map((k) => k.rev), slot.live?.rev]) if (r != null) keep.add(r)
    }
    if (row.rehearsal?.rev != null) keep.add(row.rehearsal.rev)
    if (row.releasing != null) keep.add(row.releasing)   // the rev a deploy is carrying through its gate (pinned for the whole verb, B3)
    for (const r of store.list(row.instance)) if (!keep.has(r)) store.remove(row.instance, r)
  }
  const keptRev = (row, slot, rev) => rev === slot.rev || slot.kept.some((k) => k.rev === rev && k.until > os.now())

  function rebuild(row) {
    if (row.building) { row.pending = true; return row.building }
    row.building = build(row).catch((e) => { emit(`[${row.slug}] build crashed: ${e?.stack ?? e}`); return null })
      .finally(() => { row.building = null; if (row.pending) { row.pending = false; rebuild(row) } })
    return row.building
  }

  // --- idle-stop / resume / crash (§6.1 R14; D18 for dev) ------------------------------------
  const isQuiet = (slot) => slot.suspendable || (slot.resources && Object.values(slot.resources).every((n) => !n))
  const clearIdle = (slot) => { if (slot.idleTimer) { clearTimeout(slot.idleTimer); timers.delete(slot.idleTimer); slot.idleTimer = null } }
  // the sleep mode (§6.1; API 50 `sleep` on the register/heartbeat answers → `registrar.sleep`): on an always-on computer
  // the dev slot's idle stop (D18) stands down — no timer, a dev worker stays live; prod keeps R14. `alwaysOn` is the mode
  // the slots run under, read at every scan (syncSleep) so a flip at a later beat takes effect at the next scan
  let alwaysOn = false
  function syncSleep() {
    const on = registrar?.sleep === 'always-on'
    if (on === alwaysOn) return
    alwaysOn = on
    emit(`sleep mode: ${on ? 'always-on — dev workers stay live (no idle stop)' : '24h — dev workers idle-stop again'}`)
    for (const row of rows.values()) { if (on) clearIdle(row.dev); else if (row.dev.live && !row.dev.idleTimer) armIdle(row, row.dev) }
  }
  function armIdle(row, slot) {
    if (!slot) return
    clearIdle(slot)
    if (!slot.live?.handle) return
    if (slot.name === 'prod' && !isQuiet(slot)) return
    if (slot.name === 'dev' && alwaysOn) return
    const ms = slot.name === 'dev' ? T.devIdleMs : T.idleMs
    slot.idleTimer = later(ms, () => {
      slot.idleTimer = null
      if (!slot.live?.handle || slot.inflight > 0 || os.now() - slot.lastServedAt < ms) { armIdle(row, slot); return }
      idleStop(row, slot)
    })
  }
  async function idleStop(row, slot) {
    const live = slot?.live
    if (!live?.handle) return
    slot.live = null; slot.state = 'stopped'
    await stopLive(row, slot, live, 'idle')
    emit(`[${row.slug}] rev ${live.rev} STOPPED${slot.name === 'dev' ? ' (dev)' : ''}`)
  }
  function resume(row, slot) {
    if (slot.resuming) return slot.resuming
    if (slot.live) return Promise.resolve(slot.live)
    const cur = slot.name === 'prod' ? store.current(row.instance) : store.currentDev(row.instance)
    if (!cur) return Promise.resolve(null)
    const t0 = os.now()
    slot.resuming = (async () => {
      try {
        const next = await startWorker(row, slot, cur.rev, cur.dir)
        if (slot.live) { await stopLive(row, slot, next.live, 'superseded'); return slot.live }
        slot.live = next.live; slot.rev = cur.rev; slot.state = 'live'; slot.resources = next.resources; slot.suspendable = next.suspendable
        // the crash ladder resets only once the resumed worker has stayed up for stableMs — a worker that
        // dies right after READY climbs it (0.5 → 30 s), never relaunches every 500 ms
        later(T.stableMs, () => { if (slot.live === next.live) slot.restarts = 0 })
        if (slot.name === 'prod') onResume(row.instance, cur.rev)   // the running rev is a registration fact for the collector too (a resumed snapshot never swaps)
        const ms = os.now() - t0
        metrics.resume(row.slug, ms)          // §4.5 resume row: snapshot → READY (the wake and the ladder's respawn, one series — the HELP says so)
        emit(`[${row.slug}] rev ${cur.rev} RESUMED ${Math.round(ms)} ms${slot.name === 'dev' ? ' (dev)' : ''}`)
        armIdle(row, slot)
        return slot.live
      } catch (e) {
        if (e?.error === 'config-held') { slot.configHeld = true; slot.state = 'loading'; return null }   // §6.1 config hold: no report, the scan retries (the crash ladder stops here — `failed` is not the state)
        slot.state = 'failed'
        report('worker', row.instance, slot.name === 'prod' ? cur.rev : reportRev(row), { message: devMsg(slot, `resume failed: ${e.msg ?? e.message}`) })
        emit(`[${row.slug}] rev ${cur.rev} RESUME FAILED ${e.msg ?? e.message}`)
        return null
      } finally { slot.resuming = null }
    })()
    return slot.resuming
  }
  function crashed(row, slot, live, code, signal) {
    if (row.installing) { slot.live = null; slot.state = 'stopped'; emit(`[${row.slug}] rev ${live.rev} stopped by the install's freeze`); return }   // freeze.py SIGKILLs the worker uid
    const rev = prodRev(row, slot, live)
    slot.live = null; slot.state = 'failed'
    const why = signal ? `signal ${signal}` : `exit ${code}`
    report('worker', row.instance, rev, { message: devMsg(slot, `worker died: ${why}`) })
    emit(`[${row.slug}] rev ${live.rev} KILLED ${why}${slot.name === 'dev' ? ' (dev)' : ''}`)
    if (slot.name === 'prod') restartLater(row, slot)   // dev is resumed on demand (D18), never respawned on a ladder
  }
  function restartLater(row, slot) {
    const ms = T.backoffMs[Math.min(slot.restarts, T.backoffMs.length - 1)]
    slot.restarts++
    metrics.restart(row.slug)
    later(ms, () => { if (!slot.live && slot.state === 'failed' && rows.has(row.instance)) resume(row, slot) })
  }

  // --- the install hold (the freeze SIGKILLs every process of the worker uid — BOTH slots run as it) ---
  // dev: stopped (resumed on the next dev request); prod: held under its gate and stopped, the gate released
  // when the install settles — requests wait for the freeze (kill + chown walk + rename) and a cold resume of the
  // prod worker; past the 10 s hold they get the waking 503 (DESIGN §10.3 "The install hold"; drill row 9e measures it).
  async function holdProd(row, until) {
    const slot = row.prod
    if (!slot) return
    const mine = !slot.gate
    const g = mine ? deferred() : null
    if (mine) slot.gate = g.promise
    if (slot.live) { const l = slot.live; slot.live = null; if (slot.state !== 'down') slot.state = 'stopped'; await stopLive(row, slot, l, 'install') }
    if (mine) Promise.resolve(until).catch(() => {}).finally(() => { if (slot.gate === g.promise) slot.gate = null; g.resolve() })
  }
  async function holdForInstall(row) {
    await Promise.all([idleStop(row, row.dev), holdProd(row, row.installing ?? row.deploying ?? Promise.resolve())])
  }
  // withInstalling(row, fn): `row.installing` holds requests that would resume a worker while an install runs
  // (serve.mjs, holdForInstall); a dev install that arrives meanwhile runs after (installPending).
  async function withInstalling(row, fn) {
    if (row.installing) { await row.installing.catch(() => {}) }
    const p = (async () => fn())()
    row.installing = p
    try { return await p } finally { if (row.installing === p) row.installing = null; if (row.installPending) { row.installPending = false; installThenRebuild(row) } }
  }

  // --- discovery / claim / watch ------------------------------------------------------------
  const rowBySlug = (slug) => [...rows.values()].find((r) => r.slug === slug && r.linked)
  // needsBuild(row) — the question the 30 s sweep asks (§6.1, index.mjs RESCAN_MS): has the folder
  // changed since the last state this supervisor built? That state is `row.attempted` — set by
  // build() whatever the outcome was — falling back to the live rev's `fingerprint` from
  // revision.json for a boot row that has not built in this host life. `null` = never built.
  // The sweep is a NET under the per-app watcher (an inotify overflow, a watch that died), not a
  // retry loop: a folder whose fingerprint is unchanged has already had its answer, LIVE or FAILED.
  const needsBuild = (row) => {
    const built = row.attempted ?? row.fingerprint
    if (built == null) return true
    return withGroupSync(row.uid, () => fingerprint(row.dir, fs).hash) !== built
  }
  // claimFolder(app, existing) — registrar.claim for a new folder, or the re-claim (adopt) of a boot row
  // on the first scan; a refusal leaves no row (the registrar wrote CLAIM-REFUSED.txt as uid 1000).
  async function claimFolder(app, existing = null) {
    let res
    try { res = await registrar.claim({ slug: app.slug, meta: app.meta ?? {}, dir: app.dir }) } catch (e) { emit(`[${app.slug}] claim: ${e.message}`); return existing }
    if (!res || res.refused) { emit(`[${app.slug}] claim refused: ${res?.refused?.code ?? '?'} ${res?.refused?.error ?? ''}`); return null }
    if (existing && res.instance !== existing.instance) emit(`[${app.slug}] re-claim returned ${res.instance}, snapshot row is ${existing.instance} — following the registrar`)
    const row = rows.get(res.instance) ?? mkRow({ instance: res.instance, slug: app.slug, uid: res.uid, company: company(), dir: app.dir })
    row.claimed = true; row.linked = true
    row.slug = app.slug; row.uid = res.uid; row.dir = app.dir; row.dev.appDir = app.dir; row.meta = app.meta ?? {}
    // discovery's SEEDED_MARKER names the folder as a release (deployer.seeded: no watcher, no dev slot, no git) ONLY on a host
    // configured for it (cfg.seededApps ← ATELIER_SEEDED_APPS=1, the portal-host image alone): the marker sits in a folder the
    // agent owns, so on any other host it is inert and the folder takes the new-folder road (review 2026-09-02 B2)
    row.seeded = cfg.seededApps === true && !!app.seeded
    if (!row.dev.live) row.dev.state = row.dev.rev != null ? 'stopped' : 'loading'
    store.ensure(row.instance, row.uid)
    store.writeMarker(row.instance, 'slug', row.slug)
    if (jail?.claimRoundTrip) { try { jail.claimRoundTrip(os, row.dir, row.uid) } catch (e) { emit(`[${row.slug}] claim round trip: ${e.code ?? e.message}`) } }
    // D7: the repo + .gitignore, once, as uid 1000 (a no-op on a repo; the agent's own .gitignore stays) — kicked off here,
    // awaited by whoever needs the repo first (ensureGit: the deploy's commit step, the adopt)
    if (cfg.gitCommit !== false && !row.seeded) ensureGit(row).catch(() => {})
    return row
  }
  // ensureGit(row) → {ok, step?, error?}: ONE `git init` in flight per row — the claim starts it, the deploy's commit step and
  // the adopt await the SAME promise (two inits on one dir overlapped under load: `could not lock config file`, 2026-09-02);
  // `gitReady` is set from that promise alone; a failed init clears it so the next caller tries again (never throws).
  function ensureGit(row) {
    if (row.gitReady) return Promise.resolve({ ok: true })
    if (!row.gitInit) {
      row.gitInit = gitInit({ os, appDir: row.dir, log: emit, home: cfg.gitHome })
        .then((r) => { if (r?.ok) row.gitReady = true; else row.gitInit = null; return r }, (e) => { row.gitInit = null; return { ok: false, step: 'init', error: e?.message ?? String(e) } })
    }
    return row.gitInit
  }
  function watchRow(row) {
    if (row.watcher) return
    row.watcher = createWatcher({
      dir: row.dir, fs: groupFs(row.uid), quiesceMs: T.quiesceMs, log: (l) => emit(`[${row.slug}] ${l}`),
      onChange: () => { markSave(row); rebuild(row) },
      onInstall: () => { markSave(row); installThenRebuild(row) },
      onGone: () => gone(row),
      isBroken: () => !!row.broken,
    })
    withGroupSync(row.uid, () => row.watcher.start())
  }
  // installThenRebuild: the dev install; `row.installing` holds requests that would resume a worker while it
  // runs (serve.mjs) — the freeze SIGKILLs every process of the worker uid, so a resume into that window
  // would die as a spurious `worker died` report; the live workers are stopped at beforeFreeze (holdForInstall).
  async function installThenRebuild(row) {
    if (row.installing) { row.installPending = true; return row.installing }
    return withInstalling(row, async () => {
      if (install) {
        const r = await install({ os, dirfd, spec: await workerSpec(row, row.dev, row.counter, null, { config: false }), log: emit }).catch((e) => ({ ok: false, class: 'install', message: e.message }))
        if (!r?.ok) { report('build', row.instance, reportRev(row), { message: MESSAGES.devBuild.message(`install failed: ${r?.message ?? '?'}`), hint: `package.json:1:1 ${r?.class ?? 'install'}: ${r?.message ?? '?'} — fix package.json and re-save`, file: 'package.json', line: 1, col: 1 }); emit(`[${row.slug}] install FAILED ${r?.message ?? ''}`); verdict(row, takeSave(row), 'error'); return }
        emit(`[${row.slug}] install ok ${r.ms ?? ''} ms`)
      }
      rebuild(row)
    })
  }
  // gone(row, {unlink}): the folder is not there — the row leaves resolve()/handle() (snapshot kept);
  // `unlink:false` when the registrar's reconcile already tombstoned it.
  async function gone(row, { unlink = true } = {}) {
    takeSave(row)
    if (row.watcher) { row.watcher.stop(); row.watcher = null }
    row.linked = false; row.claimed = false; row.attempted = null   // a folder that leaves and comes back is built again, whatever its mtimes say
    for (const slot of [row.dev, row.prod]) {
      if (!slot?.live) continue
      const live = slot.live
      slot.live = null; slot.state = 'stopped'
      await stopLive(row, slot, live, 'folder-gone')
    }
    emit(`[${row.slug}] folder removed — unlinked (snapshot kept ${row.prod?.rev != null ? `at rev ${row.prod.rev}` : row.dev.rev != null ? `at dev rev ${row.dev.rev}` : ''})`)
    if (unlink) { try { await registrar?.unlink?.(row.instance) } catch (e) { emit(`[${row.slug}] unlink: ${e.message}`) } }
    metrics.forget(row.slug)   // the slug's series leave with the folder: a first-come cap that is never freed latches shut
  }

  // --- releases (supervisor/deploy.mjs) --------------------------------------------------------
  const deployer = createDeployer({
    os, dirfd, fs, cfg, T, emit, report, registrar, store, metrics, hostEnv, jail, install, hook, treeOk, company, origin,
    rel, dot, realPath, workerSpec, startWorker, stopLive, buildArtefacts, prune, prodSlot, exportDir, withInstalling, later,
    onSwap, armIdle: (row, slot) => armIdle(row, slot), withGroupSync, checkModuleJson: (dir) => checkModuleJson(dir, fs), chromeNameOf, ensureGit,
  })
  // --- the chrome swap (step 7 ship C, decision 8; review 2026-09-02, S2) ------------------------------------------
  // A prod slot is DEPLOYED when it has a rev, is adopted and is not down; its sheet is BUILT against the held chrome when
  // `revision.json.prod.chrome` names it (stamped by a deploy, a rollback and a chrome commit; an adopt names none). The
  // heartbeat reports the digest every deployed prod sheet is built with (chrome.built()), never the one merely held —
  // so the rebuild is all or nothing: phase 1 compiles every sheet that is behind (nothing moves); one sheet refused (a
  // css failure, a row mid-deploy, the host in fault) and NOTHING commits — the computer keeps reporting the previous
  // digest and the next beat tries again (`onHold`); every sheet compiled and phase 2 commits each as a NEW rev of the
  // SAME code (store.clone — the worker keeps running, its code did not change, the next resume starts from the new
  // rev; `current` moves, the previous rev stays for the window, one `onSwap` → modulesChanged per row). `row.deploying`
  // is held for the commit alone (milliseconds): a deploy landing inside it answers 409 `deploy in progress`.
  const deployed = (slot) => !!slot && slot.rev != null && !slot.adoptPending && slot.state !== 'down'
  const prodChromeOf = (row) => store.revision(row.instance)?.prod?.chrome ?? null
  async function compileChromeSheet(row, slot, label, held) {
    try { return await withGroup(row.uid, () => buildSheet({ chromeDir: chromeDirOf(), appDir: slot.appDir, fs, chromeBase: chromeBaseOf() })) } catch (e) {
      const hint = e?.problems ? formatHint(e.problems[0]) : (e?.code ?? e?.message ?? String(e))
      const key = `${held}\0${hint}`
      if (row.chromeSkip !== key) { row.chromeSkip = key; emit(`[${row.slug}] chrome ${label}: prod sheet NOT rebuilt (${hint}) — rev ${slot.rev} keeps its sheet; retried at each beat`) }   // once per (chrome, reason), not once per beat
      return { error: `css: ${hint}` }
    }
  }
  async function commitChromeSheet(row, slot, sheet, label, held) {
    if (row.deploying) return { skipped: 'deploying' }
    if (!deployed(slot)) return { skipped: 'undeployed' }
    if (prodChromeOf(row) === held) return { built: true }   // a deploy landed between the phases, against this chrome
    const cur = store.current(row.instance)
    if (!cur) return { skipped: 'no current rev' }
    const p = (async () => {
      let rev
      try { rev = store.nextRev(row.instance) } catch (e) { emit(`[${row.slug}] chrome ${label}: ${e.code ?? e.message}`); return { skipped: `write: ${e.code ?? e.message}` } }
      row.counter = rev
      try { store.clone(row.instance, cur.rev, rev, row.uid, { css: sheet.css }) } catch (e) { emit(`[${row.slug}] chrome ${label}: snapshot write failed (${e.code ?? e.message})`); try { store.remove(row.instance, rev) } catch {} return { skipped: `write: ${e.code ?? e.message}` } }
      const prev = slot.rev
      store.commitProd(row.instance, rev, { commit: slot.commit, message: `chrome ${label}`, legacy: !!slot.legacy, chrome: held })
      slot.rev = rev
      if (prev != null && prev !== rev) { slot.kept.push({ rev: prev, until: os.now() + T.keepMs }); later(T.keepMs + 50, () => prune(row)) }
      if (sheet.chrome) { metrics.tailwind(row.slug, sheet.ms, { cold: !row.tailwindWarm }); row.tailwindWarm = true }
      try { onSwap(row.instance, rev) } catch {}
      emit(`[${row.slug}] rev ${rev} chrome ${label} (prod sheet rebuilt from rev ${prev})`)
      return { rev }
    })()
    row.deploying = p
    try { return await p } finally { if (row.deploying === p) row.deploying = null }
  }

  function onConfigStamp(instance, updated) {
    const row = rows.get(instance)
    if (!row) return
    row.configStamp = updated
    const slot = row.prod
    if (!slot || row.deploying) return
    if (slot.state === 'down') { emit(`[${row.slug}] config stamp ${updated} noted — the app is DOWN after a failed release; no restart (restore or deploy first)`); return }   // S2: a config PUT never resurrects a failed release
    if (!slot.live) return      // idle: the next resume fetches the config at spawn
    if (slot.configAt === updated) return
    deployer.configRelease(row).catch((e) => emit(`[${row.slug}] config release crashed: ${e?.stack ?? e}`))
  }

  // --- the public surface (§4.1) --------------------------------------------------------------
  const sup = {
    store, rows, timing: T,

    async boot() {
      for (const inst of store.instances()) {
        const slug = store.readMarker(inst, 'slug')?.trim()
        const uid = Number(store.readMarker(inst, 'uid'))
        const cur = store.current(inst)
        const curDev = store.currentDev(inst)
        if (!slug || (!cur && !curDev)) { emit(`boot: ${inst} has no ${!slug ? 'slug marker' : 'current rev'} — skipped`); continue }
        let registered = null
        try { registered = JSON.parse(store.readMarker(inst, 'registered.json')) } catch {}
        const revision = store.revision(inst)
        const row = mkRow({ instance: inst, slug, uid: Number.isFinite(uid) ? uid : 0, company: registered?.company ?? company(), dir: path.join(appsDir, slug) })
        row.linked = true
        row.counter = revision?.rev ?? Math.max(cur?.rev ?? 0, curDev?.rev ?? 0); row.fingerprint = revision?.fingerprint ?? null
        row.meta = null
        if (cur) {
          const p = revision?.prod
          if (p && p.rev === cur.rev) row.prod = prodSlot(row, { rev: cur.rev, commit: p.commit, legacy: !!p.legacy })
          else if (p && COMMIT_RE.test(p.commit ?? '') && fs.existsSync(store.revDir(inst, p.rev))) {
            // S10: a torn commitProd — revision.json named the release, the host died before `current` moved; the recorded
            // release wins (never the agent's working tree through an adopt)
            store.link(inst, 'current', p.rev)
            row.prod = prodSlot(row, { rev: p.rev, commit: p.commit, legacy: !!p.legacy })
            emit(`boot: ${slug} current re-linked to rev ${p.rev} (revision.json.prod named it; the previous host life died between the two writes)`)
          }
          else { row.prod = prodSlot(row, { rev: cur.rev, commit: null, legacy: true }); row.prod.adoptPending = true }   // D14: the pre-release layout, adopted on the first scan
          // S1: a DOWN app stays down across a host restart — the marker on disk (a failed release), or the in-flight marker
          // of a release the previous host life died inside (its migration may have run: the old rev must not serve that data)
          const d = p?.down ?? (p?.releasing ? { step: 'migrate', error: 'the host died during the release (after the backup, before the record)', backup: p.releasing.backup ?? null, commit: p.releasing.commit ?? null, rev: p.releasing.rev ?? null, at: p.releasing.at ?? null } : null)
          if (d) {
            row.prod.state = 'down'; row.prod.down = d
            if (!p.down) { try { store.prodPatch(inst, { down: d, releasing: undefined }) } catch (e) { emit(`boot: ${slug} down marker: ${e?.code ?? e?.message ?? e}`) } }
            emit(MESSAGES.log.bootDown(slug, row.prod.rev, d.commit ? commit12(d.commit) : 'none', d.step, d.backup))
          }
          // a restore the previous host life died inside: the old tree comes back (its `.old`), the staged copy goes
          const data = rel(REL.prodData(inst)), old = `${data}.old`, staging = `${data}.restore`
          try { if (!fs.existsSync(data) && fs.existsSync(old)) { fs.renameSync(old, data); emit(`boot: ${slug} prod data restored from its .old (a restore died mid-swap)`) } } catch (e) { emit(`boot: ${slug} data .old: ${e?.code ?? e?.message ?? e}`) }
          for (const leftover of [old, staging]) { try { if (fs.existsSync(leftover)) { fs.rmSync(leftover, { recursive: true, force: true }); emit(`boot: ${slug} swept ${path.basename(leftover)}`) } } catch {} }
        }
        const dv = curDev ?? cur
        if (dv) { row.dev.rev = dv.rev; row.dev.state = 'stopped' }
        const swept = store.sweepTmp(inst)
        if (swept.length) emit(`boot: ${slug} swept ${swept.join(', ')} (a previous host life died mid-write)`)
        prune(row)
      }
    },

    // scan() → the discovery result (index.mjs watches the `no-module-json` folders it names)
    async scan() {
      syncSleep()
      const d = withAllGroupsSync(() => discover(appsDir, fs, { links: cfg.appsLinks === true }))
      if (d.unreadable) {
        emit(`scan: ${appsDir} unreadable — nothing claimed, nothing tombstoned`)
        try { await registrar?.reconcile?.(null) } catch (e) { emit(`reconcile: ${e.message}`) }
        return d
      }
      for (const p of d.problems) {
        const row = rowBySlug(p.slug)
        if (!row) { emit(`[${p.slug}] ${formatHint(p.error)}`); continue }
        if (needsBuild(row)) rebuild(row)   // a module.json that still does not parse is the same folder: one report, not one per sweep
      }
      for (const r of d.refused) {
        try { await registrar.claim({ slug: r.slug, meta: {}, dir: r.dir }) } catch {}
        emit(`[${r.slug}] refused: ${r.error}`)
      }
      const seededBuilds = []   // the seeded rows build side by side; the scan settles when every one has (host-ready waits for it on a seeded host)
      for (const app of d.apps) {
        let row = rowBySlug(app.slug)
        if (!row?.claimed) {
          row = await claimFolder(app, row)
          if (!row) continue
        }
        // the config hold's retry clock (§6.1): a held row's spawn goes again only once the door answered (configRetry — one
        // read, never a rebuild against a closed door); a stale prod worker gets the fresh document there too. `prodHeld` is
        // read BEFORE this scan's own attempts: a prod spawn held just now (a seeded build) is the next scan's to retry
        const prodHeld = !!row.prod?.configHeld
        const heldResume = () => { if (prodHeld && row.prod?.configHeld) { row.prod.configHeld = false; resume(row, row.prod) } }   // a held prod resume (a boot row, the crash ladder, a request while the door was closed) goes again
        if (row.seeded) {   // the folder is the release (DESIGN §10.3 "seeded rows"): prod built from it, never a dev slot, no watcher
          if (!(await configRetry(row))) continue
          seededBuilds.push(deployer.seeded(row).then(heldResume))   // side by side; the held resume once its build (or boot announce) settled
          continue
        }
        watchRow(row)
        if (row.prod?.adoptPending) await deployer.adopt(row)
        else if (row.prod?.commit && !row.prod.announced) await deployer.announce(row)   // the boot announce (DESIGN §10.3): the spine learns the prod commit this host holds
        if (!(await configRetry(row))) continue
        row.dev.configHeld = false   // a held dev build is the sweep's (needsBuild: `attempted` was cleared); a held dev resume is the next request's (D18: dev on demand)
        if (needsBuild(row)) rebuild(row)
        heldResume()
      }
      await Promise.all(seededBuilds)
      // boot reconcile (PLAN §4.3): the registrar tombstones rows with no folder on disk — the DISCOVERED
      // folders are its input (a boot row restored from last-good is not a folder); every row it
      // unlinked leaves the table (snapshot kept, served no more)
      try {
        const r = await registrar?.reconcile?.(d.apps)
        for (const inst of r?.unlinked ?? []) { const row = rows.get(inst); if (row && row.linked) await gone(row, { unlink: false }) }
      } catch (e) { emit(`reconcile: ${e.message}`) }
      return d
    },

    // rebuildAll(label) → {prod:[[instance, rev]], dev:[instance], skipped:[[instance, why]], complete}: every deployed prod
    // sheet not built against the held chrome, all or nothing (above) — `complete` = every deployed prod sheet is now built
    // against it (the digest the heartbeat may report); idempotent, cheap when nothing is behind (one revision.json read
    // per row), called at a swap AND at every beat that names the held digest (host/chrome/fetch.mjs onSwap/onHold), so a
    // row that falls behind later — adopted, rolled back, its deploy over — is caught within a beat. The dev slot follows
    // once per chrome (`revision.json.chrome` is the last dev build's): rebuilt when claimed, else the first scan builds it.
    async rebuildAll(label = 'swap') {
      const held = chromeNameOf()
      const out = { prod: [], dev: [], skipped: [], complete: true }
      if (!treeOk()) { out.skipped.push(['host', 'host-fault']); out.complete = false; return out }
      const plan = []
      for (const row of [...rows.values()]) {
        if (!row.linked || !deployed(row.prod) || prodChromeOf(row) === held) continue
        if (row.deploying) { out.skipped.push([row.instance, 'deploying']); continue }
        const sheet = await compileChromeSheet(row, row.prod, label, held)
        if (sheet.error) out.skipped.push([row.instance, sheet.error]); else plan.push({ row, slot: row.prod, sheet })
      }
      if (!out.skipped.length) {
        for (const { row, slot, sheet } of plan) {
          const r = await commitChromeSheet(row, slot, sheet, label, held).catch((e) => { emit(`[${row.slug}] chrome ${label}: ${e?.stack ?? e}`); return { skipped: 'crashed' } })
          if (r.rev != null) out.prod.push([row.instance, r.rev]); else if (r.skipped) out.skipped.push([row.instance, r.skipped])
        }
      }
      if (out.skipped.length) out.complete = false
      for (const row of [...rows.values()]) {
        if (!row.linked || row.seeded || row.devChrome === held || (store.revision(row.instance)?.chrome ?? null) === held) continue   // a seeded row has no dev slot to rebuild
        row.devChrome = held   // one dev rebuild per chrome: a failed one is the next save's to retry, not the next beat's
        if (row.dir && row.claimed) { out.dev.push(row.instance); rebuild(row) }
        else { row.attempted = null; row.fingerprint = null }   // a boot row not yet claimed: the first scan rebuilds it (needsBuild reads null as never built)
      }
      return out
    },
    apps: () => [...rows.values()].map(appRow),
    // workers(): every live worker of every slot (the watchdog's input; `key` tells two workers of one instance apart)
    workers: () => {
      const out = []
      for (const r of rows.values()) {
        for (const s of [r.prod, r.dev]) if (s?.live?.pid) out.push({ instance: r.instance, key: `${r.instance}/${s.name}`, slot: s.name, slug: r.slug, pid: s.live.pid, uid: r.uid, dataDir: s.dataDir, sock: s.live.sock, rev: s.live.rev, rlimits: T.rlimits })
        if (r.rehearsal?.live?.pid) out.push({ instance: r.instance, key: `${r.instance}/rehearsal`, slot: 'rehearsal', slug: r.slug, pid: r.rehearsal.live.pid, uid: r.uid, dataDir: r.rehearsal.dataDir, sock: r.rehearsal.live.sock, rev: r.rehearsal.live.rev, rlimits: T.rlimits })
      }
      return out
    },
    resolve: (co, slug) => { const r = [...rows.values()].find((x) => x.company === co && x.slug === slug && x.linked); return r ? appRow(r) : null },
    rebuild: (instance) => { const r = rows.get(instance); return r ? rebuild(r) : Promise.resolve(null) },
    prune: (instance) => { const r = rows.get(instance); if (r) prune(r) },   // the rev-dir sweep the timers run (a test fires it mid-deploy)
    // stop(instance): the install's beforeFreeze — dev stopped, prod held under its gate (see holdForInstall)
    stop: async (instance) => { const r = rows.get(instance); if (r) await holdForInstall(r) },
    kill: (instance, reason, slotName) => {
      const row = rows.get(instance)
      if (!row) return
      const slot = slotName === 'rehearsal' ? row.rehearsal : slotName ? row[slotName] : (row.prod?.live ? row.prod : row.dev)
      if (!slot?.live) return
      const live = slot.live
      const rev = prodRev(row, slot, live)
      live.stopping = true
      try { live.handle.kill('SIGKILL') } catch {}
      slot.live = null; slot.state = 'failed'
      // a rehearsal worker's kill is not its own report: the rehearsal step it was serving goes red and THAT is the chat's one message (N4)
      if (slot.name !== 'rehearsal') report('worker', row.instance, rev, { message: devMsg(slot, reason) })
      emit(`[${row.slug}] rev ${live.rev} KILLED ${reason}${slot.name !== 'prod' ? ` (${slot.name})` : ''}`)
      if (slot.name === 'prod') restartLater(row, slot)
    },
    async teardown() {
      for (const t of timers) clearTimeout(t)
      timers.clear()
      for (const row of rows.values()) { if (row.watcher) { row.watcher.stop(); row.watcher = null } }
      await Promise.all([...rows.values()].map(async (row) => {
        const all = []
        for (const slot of [row.dev, row.prod, row.rehearsal]) {
          if (!slot) continue
          all.push(...(slot.retiring ?? []), slot.live)
          if (slot.live) { slot.live = null; if (slot.state === 'live') slot.state = 'stopped' }
        }
        await Promise.all(all.filter(Boolean).map((live) => stopLive(row, null, live, 'teardown')))
      }))
    },

    // --- releases (D6–D16): the dev shell's verbs
    deploy: (instance, opts) => { const r = rows.get(instance); if (!r?.linked) throw Object.assign(new Error('unknown app'), { status: 404 }); return deployer.deploy(r, opts) },
    restore: (instance, backup, opts) => { const r = rows.get(instance); if (!r?.linked) throw Object.assign(new Error('unknown app'), { status: 404 }); return deployer.restore(r, backup, opts) },   // opts.yes: the confirmation a LIVE app's restore needs
    releases: (instance) => { const r = rows.get(instance); return r ? deployer.releases(r) : [] },
    backups: (instance) => { const r = rows.get(instance); return r ? deployer.backups(r) : [] },
    onConfigStamp,
  }
  const serve = createServe({
    row: (inst) => rows.get(inst), store, proxy, resume, keptRev, timing: T,
    awaitBuild: (row) => row.building ?? Promise.resolve(),
    served: (inst) => registrar?.served?.(inst),
    readStatic: (row, slot, name) => withGroupSync(row.uid, () => {
      const root = path.resolve(slot.appDir), abs = path.resolve(root, name)
      if (!abs.startsWith(root + path.sep)) return null
      let real, realRoot
      try { real = fs.realpathSync(abs); realRoot = fs.realpathSync(root) } catch { return null }
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null
      try { return fs.statSync(real).isFile() ? fs.readFileSync(real) : null } catch { return null }
    }),
  })
  sup.handle = serve.handle
  sup.asset = serve.asset
  return sup
}
