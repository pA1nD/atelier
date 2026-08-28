// host/supervisor/index.mjs — the app supervisor (DESIGN §4.1 "supervisor/index.mjs", §6.1).
//
// One table of instances; per instance one live worker (or none, lazily resumed from the
// last-good snapshot), one revision counter, one watcher over the app folder. A save = one
// revision: module.json check → backend bundle + frontend transform + one Tailwind sheet (all
// reads with the app's gid held) → rev dir written beside the old → a NEW worker spawned from the
// rev dir while the old serves → on READY the three swap under one rev, the old worker stops
// 500 ms later. Any failure → `report('build', …)` with the classification hint; users stay on
// the old rev. Idle-stop only for a worker whose READY `resources` are empty or that sent
// `{t:'suspendable'}`, after 60 s without a request; resume from `current` with requests held.
//
// Collaborators are injected (DESIGN §4): `spawn` = worker/spawn.mjs spawnWorker, `proxy` =
// worker/proxy.mjs proxyRequest, `jail` = worker/jail.mjs {jailPlan, applyJail, claimRoundTrip},
// `install` = worker/install.mjs installDeps, `report` = errors/collector.mjs report, `registrar`
// = protocol/registrar.mjs. Without `jail`/`install` the supervisor creates the per-instance dirs
// itself and treats an install event as a plain rebuild (local mode / tests).
import nodeFs from 'node:fs'
import path from 'node:path'
import { discover, checkModuleJson } from './discovery.mjs'
import { createWatcher, fingerprint } from './watcher.mjs'
import { bundleBackend, transformFrontend, classifyWorkerFailure, formatHint, sourceMapLookup } from './bundle.mjs'
import { buildSheet } from './tailwind.mjs'
import { createStore, commitGit } from './lastgood.mjs'
import { createServe } from './serve.mjs'

export const DEFAULT_TIMING = Object.freeze({
  quiesceMs: 100, idleMs: 60_000, keepMs: 600_000, swapStopMs: 500, drainMs: 2000, readyTimeoutMs: 8000,
  backoffMs: [500, 1000, 2000, 4000, 8000, 16000, 30000],
  rlimits: { data: 1024 * 1024 * 1024, core: 0, nproc: 64, nofile: 1024 },
})

/** @typedef {{instance, slug, company, uid, rev:number|null, state:'live'|'stopped'|'loading'|'failed'|'unclaimed', pid?:number, sock?:string, dataDir, dir}} AppRow */

export function createSupervisor({ os, dirfd, cfg = {}, log = () => {}, report = () => {}, registrar, onSwap = () => {}, spawn, proxy, fs = nodeFs, timing = {}, jail = null, install = null, onBroadcast = () => {}, hostVersion = '2.0.0' }) {
  const T = { ...DEFAULT_TIMING, ...timing }
  const emit = typeof log === 'function' ? log : (line) => log.write(line)
  const store = createStore({ os, dirfd, fs, log: emit, hostVersion })
  const rows = new Map()   // instance → row
  const appsDir = path.join(cfg.work ?? '/work', 'apps')
  const chromeName = cfg.chromeDir ? path.basename(cfg.chromeDir) : null
  const company = () => registrar?.company ?? cfg.company ?? 'local'
  const origin = () => registrar?.origin ?? cfg.origin ?? 'http://127.0.0.1:1844'
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
      dataDir: os.at(dirfd, `data/${instance}`), tmpDir: os.at(dirfd, `tmp/${instance}`),
      sockDir: path.join(cfg.run ?? '/run/atelier', 'w', instance),
      state: 'unclaimed', claimed: false, rev: null, live: null, retiring: new Set(), kept: [], counter: 0, fingerprint: null,
      building: null, pending: false, broken: null, watcher: null,
      resources: null, suspendable: false, lastServedAt: 0, inflight: 0, idleTimer: null, restarts: 0, resuming: null,
      armIdle: () => armIdle(row),
    }
    rows.set(instance, row)
    return row
  }
  const appRow = (r) => ({ instance: r.instance, slug: r.slug, company: r.company, uid: r.uid, rev: r.rev, state: r.state, pid: r.live?.pid, sock: r.live?.sock ?? undefined, dataDir: r.dataDir, dir: r.dir })
  const usersLine = (row) => row.rev != null ? `still on rev ${row.rev}` : 'see nothing — never live'

  // --- worker spec (§4.1 WorkerSpec) ----------------------------------------------------------
  async function workerSpec(row, rev, codeDir) {
    let configEnv = {}
    try { configEnv = (await registrar?.appConfig?.(row.instance)) ?? {} } catch (e) { emit(`[${row.slug}] app config: ${e.message} (spawning without)`) }
    // one socket per rev: load-beside needs the new worker bound while the old one still serves, and a
    // proxy's keep-alive pool is keyed by socket path — the same name would keep feeding the old worker
    return {
      instance: row.instance, slug: row.slug, company: row.company, uid: row.uid, rev, codeDir, appDir: row.dir,
      dataDir: row.dataDir, tmpDir: row.tmpDir, sockDir: row.sockDir, sock: path.join(row.sockDir, `w-${rev}.sock`),
      baseUrl: `${origin()}/api/${row.company}/${row.slug}`, origin: origin(), configEnv, rlimits: T.rlimits,
    }
  }
  function prepareDirs(row, spec) {
    if (jail) { jail.applyJail(os, jail.jailPlan(spec)); return }
    for (const d of [row.dataDir, row.tmpDir, row.sockDir]) { try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }) } catch {} }
    try { fs.rmSync(spec.sock, { force: true }) } catch {}
  }

  // startWorker(row, rev, codeDir) → {pid, sock, handle, rev, resources, suspendable} ; throws {error, msg, failed?}
  async function startWorker(row, rev, codeDir) {
    const spec = await workerSpec(row, rev, codeDir)
    prepareDirs(row, spec)
    const st = { ready: null, failed: null, suspendable: false }
    const live = { rev, sock: spec.sock, pid: null, handle: null }
    const onControl = (msg) => {
      switch (msg.t) {
        case 'ready': st.ready = msg; break
        case 'load-failed': st.failed = msg; break
        case 'suspendable': st.suspendable = true; if (row.live === live) { row.suspendable = true; armIdle(row) } break
        case 'error': report('backend', row.instance, rev, { message: msg.message, stack: msg.stack, file: msg.file, line: msg.line, col: msg.col, sample: msg.sample }); break
        case 'http5xx': report('http', row.instance, rev, { message: msg.message, file: msg.file, line: msg.line, col: msg.col, sample: { request: { method: msg.method, path: msg.path, status: msg.status } } }); break
        case 'broadcast': onBroadcast(appRow(row), msg.event); break
      }
    }
    const onExit = (code, signal) => { if (row.live === live && !live.stopping) crashed(row, live, code, signal) }
    try {
      const h = await spawn({ os, spec, onControl, onExit, readyTimeoutMs: T.readyTimeoutMs })
      live.handle = h; live.pid = h.pid; live.sock = h.sock ?? spec.sock
    } catch (e) {
      throw { error: e?.error ?? 'no-ready', msg: e?.msg ?? e?.message ?? String(e), failed: st.failed }
    }
    return { live, resources: st.ready?.resources ?? null, suspendable: st.suspendable, teardown: !!st.ready?.teardown }
  }
  async function stopLive(row, live, reason) {
    if (!live?.handle || live.stopping) return
    live.stopping = true
    row.retiring.delete(live)
    try { await live.handle.stop(T.drainMs) } catch (e) { emit(`[${row.slug}] rev ${live.rev} stop(${reason}): ${e.message}`) }
  }

  // --- build = one revision (§6.1) -------------------------------------------------------------
  async function build(row) {
    const t0 = os.now()
    const rev = store.nextRev(row.instance)
    row.counter = rev
    row.state = row.live ? 'live' : 'loading'
    const fail = (problems, kind = 'build') => {
      const p = problems[0], hint = formatHint(p)
      row.broken = { rev, problems }
      report(kind, row.instance, rev, { message: p.message, hint, file: p.file, line: p.line, col: p.col })
      emit(`[${row.slug}] rev ${rev} FAILED (users ${usersLine(row)}) ${hint}`)
      if (!row.live) row.state = row.rev != null ? 'stopped' : 'failed'
      return null
    }
    const mj = withGroupSync(row.uid, () => checkModuleJson(row.dir, fs))
    if (!mj.ok) return fail([mj.error])
    if (JSON.stringify(mj.meta) !== JSON.stringify(row.meta)) {
      row.meta = mj.meta
      try { await registrar?.claim?.({ slug: row.slug, meta: mj.json, dir: row.dir }) } catch (e) { emit(`[${row.slug}] meta update: ${e.message}`) }
    }
    const fp = withGroupSync(row.uid, () => fingerprint(row.dir, fs).hash)
    let backend, frontend, sheet
    try {
      ;[backend, frontend, sheet] = await withGroup(row.uid, () => Promise.all([
        bundleBackend({ appDir: row.dir, fs }),
        transformFrontend({ appDir: row.dir, rev, fs }),
        buildSheet({ chromeDir: cfg.chromeDir, appDir: row.dir, fs }),
      ]))
    } catch (e) { if (e?.problems) return fail(e.problems); throw e }
    const written = store.write(row.instance, rev, row.uid, { backend: backend?.code ?? null, map: backend?.map ?? null, frontend: frontend.files, css: sheet.css })
    let next = { live: { rev, sock: null, pid: null, handle: null }, resources: {}, suspendable: false }
    if (backend) {
      const map = backend.map ? sourceMapLookup(JSON.parse(backend.map)) : null
      let retried = false
      for (;;) {
        try { next = await startWorker(row, rev, written.dir); break } catch (e) {
          const mountErr = e.failed?.code === 'MOUNT-ERROR'
          if (mountErr && row.live && !retried) {   // the sqlite overlap rule (§6.1): once, after the old worker exited
            retried = true
            emit(`[${row.slug}] rev ${rev} mount failed beside rev ${row.live.rev} — retrying once after the old worker exits`)
            const old = row.live; row.live = null; row.state = 'loading'
            await stopLive(row, old, 'mount-retry')
            continue
          }
          store.remove(row.instance, rev)
          if (e.error === 'spawn-eagain') {
            report('worker', row.instance, rev, { message: `spawn failed: ${e.msg}`, hint: 'the host could not spawn the worker (process cap or memory) — not an app bug' })
            emit(`[${row.slug}] rev ${rev} FAILED (users ${usersLine(row)}) spawn: ${e.msg}`)
            if (!row.live) row.state = row.rev != null ? 'stopped' : 'failed'
            return null
          }
          const p = classifyWorkerFailure(e.failed ?? { code: e.error, message: e.msg }, { appDir: row.dir, fs, map })
          return fail([p])
        }
      }
    }
    swap(row, next, { sha256: written.sha256, bytes: written.bytes, fingerprint: fp, ms: os.now() - t0 })
    return rev
  }

  function swap(row, next, { sha256, bytes, fingerprint: fp, ms }) {
    const old = row.live
    const rev = next.live.rev
    row.live = next.live; row.rev = rev; row.state = 'live'; row.broken = null; row.fingerprint = fp
    row.resources = next.resources; row.suspendable = next.suspendable; row.restarts = 0
    store.commit(row.instance, rev, { slug: row.slug, sha256, bytes, fingerprint: fp, chrome: chromeName })
    if (old) {
      row.kept.push({ rev: old.rev, until: os.now() + T.keepMs })
      row.retiring.add(old)
      later(T.swapStopMs, () => stopLive(row, old, 'swap'))
      later(T.keepMs + 50, () => prune(row))
    }
    onSwap(row.instance, rev)
    emit(`[${row.slug}] rev ${rev} LIVE in ${Math.round(ms)} ms`)
    armIdle(row)
    if (cfg.gitCommit !== false) commitGit({ os, appDir: row.dir, rev, log: emit }).catch(() => {})
  }
  function prune(row) {
    const now = os.now()
    row.kept = row.kept.filter((k) => k.until > now)
    const keep = new Set([row.rev, ...row.kept.map((k) => k.rev), row.live?.rev].filter((x) => x != null))
    for (const r of store.list(row.instance)) if (!keep.has(r)) store.remove(row.instance, r)
  }
  const keptRev = (row, rev) => rev === row.rev || row.kept.some((k) => k.rev === rev && k.until > os.now())

  function rebuild(row) {
    if (row.building) { row.pending = true; return row.building }
    row.building = build(row).catch((e) => { emit(`[${row.slug}] build crashed: ${e?.stack ?? e}`); return null })
      .finally(() => { row.building = null; if (row.pending) { row.pending = false; rebuild(row) } })
    return row.building
  }

  // --- idle-stop / resume / crash (§6.1 R14) -------------------------------------------------
  const isQuiet = (row) => row.suspendable || (row.resources && Object.values(row.resources).every((n) => !n))
  function armIdle(row) {
    if (row.idleTimer) { clearTimeout(row.idleTimer); timers.delete(row.idleTimer); row.idleTimer = null }
    if (!row.live?.handle || !isQuiet(row)) return
    row.idleTimer = later(T.idleMs, () => {
      row.idleTimer = null
      if (!row.live?.handle || row.inflight > 0 || os.now() - row.lastServedAt < T.idleMs) { armIdle(row); return }
      idleStop(row)
    })
  }
  async function idleStop(row) {
    const live = row.live
    if (!live?.handle) return
    row.live = null; row.state = 'stopped'
    await stopLive(row, live, 'idle')
    emit(`[${row.slug}] rev ${live.rev} STOPPED`)
  }
  function resume(row) {
    if (row.resuming) return row.resuming
    if (row.live) return Promise.resolve(row.live)
    const cur = store.current(row.instance)
    if (!cur) return Promise.resolve(null)
    const t0 = os.now()
    row.resuming = (async () => {
      try {
        const next = await startWorker(row, cur.rev, cur.dir)
        if (row.live) { await stopLive(row, next.live, 'superseded'); return row.live }
        row.live = next.live; row.rev = cur.rev; row.state = 'live'; row.resources = next.resources; row.suspendable = next.suspendable; row.restarts = 0
        emit(`[${row.slug}] rev ${cur.rev} RESUMED ${Math.round(os.now() - t0)} ms`)
        armIdle(row)
        return row.live
      } catch (e) {
        row.state = 'failed'
        report('worker', row.instance, cur.rev, { message: `resume failed: ${e.msg ?? e.message}` })
        emit(`[${row.slug}] rev ${cur.rev} RESUME FAILED ${e.msg ?? e.message}`)
        return null
      } finally { row.resuming = null }
    })()
    return row.resuming
  }
  function crashed(row, live, code, signal) {
    row.live = null; row.state = 'failed'
    const why = signal ? `signal ${signal}` : `exit ${code}`
    report('worker', row.instance, live.rev, { message: `worker died: ${why}` })
    emit(`[${row.slug}] rev ${live.rev} KILLED ${why}`)
    restartLater(row)
  }
  function restartLater(row) {
    const ms = T.backoffMs[Math.min(row.restarts, T.backoffMs.length - 1)]
    row.restarts++
    later(ms, () => { if (!row.live && row.state === 'failed' && rows.has(row.instance)) resume(row) })
  }

  // --- discovery / claim / watch ------------------------------------------------------------
  const rowBySlug = (slug) => [...rows.values()].find((r) => r.slug === slug && r.state !== 'unclaimed')
  // claimFolder(app, existing) — registrar.claim for a new folder, or the re-claim (adopt) of a boot row
  // on the first scan; a refusal leaves no row (the registrar wrote CLAIM-REFUSED.txt as uid 1000).
  async function claimFolder(app, existing = null) {
    let res
    try { res = await registrar.claim({ slug: app.slug, meta: app.meta ?? {}, dir: app.dir }) } catch (e) { emit(`[${app.slug}] claim: ${e.message}`); return existing }
    if (!res || res.refused) { emit(`[${app.slug}] claim refused: ${res?.refused?.code ?? '?'} ${res?.refused?.error ?? ''}`); return null }
    if (existing && res.instance !== existing.instance) emit(`[${app.slug}] re-claim returned ${res.instance}, snapshot row is ${existing.instance} — following the registrar`)
    const row = rows.get(res.instance) ?? mkRow({ instance: res.instance, slug: app.slug, uid: res.uid, company: company(), dir: app.dir })
    row.claimed = true
    row.slug = app.slug; row.uid = res.uid; row.dir = app.dir; if (!row.live) row.state = row.rev != null ? 'stopped' : 'loading'; row.meta = app.meta ?? {}
    store.ensure(row.instance, row.uid)
    store.writeMarker(row.instance, 'slug', row.slug)
    if (jail?.claimRoundTrip) { try { jail.claimRoundTrip(os, row.dir, row.uid) } catch (e) { emit(`[${row.slug}] claim round trip: ${e.code ?? e.message}`) } }
    return row
  }
  function watchRow(row) {
    if (row.watcher) return
    row.watcher = createWatcher({
      dir: row.dir, fs: groupFs(row.uid), quiesceMs: T.quiesceMs, log: (l) => emit(`[${row.slug}] ${l}`),
      onChange: () => rebuild(row),
      onInstall: () => installThenRebuild(row),
      onGone: () => gone(row),
      isBroken: () => !!row.broken,
    })
    withGroupSync(row.uid, () => row.watcher.start())
  }
  async function installThenRebuild(row) {
    if (install) {
      const r = await install({ os, dirfd, spec: await workerSpec(row, row.counter, null), log: emit }).catch((e) => ({ ok: false, class: 'install', message: e.message }))
      if (!r?.ok) { report('build', row.instance, row.counter, { message: `install failed: ${r?.message ?? '?'}`, hint: `package.json:1:1 ${r?.class ?? 'install'}: ${r?.message ?? '?'} — fix package.json and re-save`, file: 'package.json', line: 1, col: 1 }); emit(`[${row.slug}] install FAILED ${r?.message ?? ''}`); return }
      emit(`[${row.slug}] install ok ${r.ms ?? ''} ms`)
    }
    rebuild(row)
  }
  async function gone(row) {
    if (row.watcher) { row.watcher.stop(); row.watcher = null }
    const live = row.live
    row.live = null; row.state = 'unclaimed'
    if (live) await stopLive(row, live, 'folder-gone')
    emit(`[${row.slug}] folder removed — unlinked (snapshot kept ${row.rev != null ? `at rev ${row.rev}` : ''})`)
    try { await registrar?.unlink?.(row.instance) } catch (e) { emit(`[${row.slug}] unlink: ${e.message}`) }
  }

  // --- the public surface (§4.1) --------------------------------------------------------------
  const sup = {
    store, rows, timing: T,

    async boot() {
      for (const inst of store.instances()) {
        const slug = store.readMarker(inst, 'slug')?.trim()
        const uid = Number(store.readMarker(inst, 'uid'))
        const cur = store.current(inst)
        if (!slug || !cur) { emit(`boot: ${inst} has no ${!slug ? 'slug marker' : 'current rev'} — skipped`); continue }
        let registered = null
        try { registered = JSON.parse(store.readMarker(inst, 'registered.json')) } catch {}
        const revision = store.revision(inst)
        const row = mkRow({ instance: inst, slug, uid: Number.isFinite(uid) ? uid : 0, company: registered?.company ?? company(), dir: path.join(appsDir, slug) })
        row.rev = cur.rev; row.state = 'stopped'; row.counter = revision?.rev ?? cur.rev; row.fingerprint = revision?.fingerprint ?? null
        row.meta = null
        prune(row)
      }
    },

    async scan() {
      const d = withAllGroupsSync(() => discover(appsDir, fs))
      for (const p of d.problems) {
        const row = rowBySlug(p.slug)
        if (row) rebuild(row)
        else emit(`[${p.slug}] ${formatHint(p.error)}`)
      }
      for (const r of d.refused) {
        try { await registrar.claim({ slug: r.slug, meta: {}, dir: r.dir }) } catch {}
        emit(`[${r.slug}] refused: ${r.error}`)
      }
      for (const app of d.apps) {
        let row = rowBySlug(app.slug)
        if (!row?.claimed) {
          row = await claimFolder(app, row)
          if (!row) continue
        }
        watchRow(row)
        const fp = withGroupSync(row.uid, () => fingerprint(row.dir, fs).hash)
        if (row.rev == null || fp !== row.fingerprint) rebuild(row)
      }
      try { await registrar?.reconcile?.(sup.apps()) } catch (e) { emit(`reconcile: ${e.message}`) }
    },

    apps: () => [...rows.values()].map(appRow),
    workers: () => [...rows.values()].filter((r) => r.live?.pid).map((r) => ({ instance: r.instance, pid: r.live.pid, uid: r.uid, dataDir: r.dataDir, sock: r.live.sock })),
    resolve: (co, slug) => { const r = [...rows.values()].find((x) => x.company === co && x.slug === slug && x.state !== 'unclaimed'); return r ? appRow(r) : null },
    rebuild: (instance) => { const r = rows.get(instance); return r ? rebuild(r) : Promise.resolve(null) },
    stop: async (instance) => { const r = rows.get(instance); if (r) await idleStop(r) },
    kill: (instance, reason) => {
      const row = rows.get(instance)
      if (!row?.live) return
      const live = row.live
      live.stopping = true
      try { live.handle.kill('SIGKILL') } catch {}
      row.live = null; row.state = 'failed'
      report('worker', row.instance, live.rev, { message: reason })
      emit(`[${row.slug}] rev ${live.rev} KILLED ${reason}`)
      restartLater(row)
    },
    async teardown() {
      for (const t of timers) clearTimeout(t)
      timers.clear()
      for (const row of rows.values()) { if (row.watcher) { row.watcher.stop(); row.watcher = null } }
      await Promise.all([...rows.values()].map(async (row) => {
        const all = [...row.retiring, row.live].filter(Boolean)
        if (row.live) { row.live = null; row.state = 'stopped' }
        await Promise.all(all.map((live) => stopLive(row, live, 'teardown')))
      }))
    },
  }
  const serve = createServe({
    row: (inst) => rows.get(inst), store, proxy, resume, keptRev, timing: T,
    awaitBuild: (row) => row.building ?? Promise.resolve(),
    served: (inst) => registrar?.served?.(inst),
    readStatic: (row, name) => withGroupSync(row.uid, () => {
      const root = path.resolve(row.dir), abs = path.resolve(root, name)
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
