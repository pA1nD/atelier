// host/hygiene.mjs — the launcher's policy as DATA (DESIGN §2.1 steps 1–3b, §2.2 rows H/S/X, §3):
// group constants every lane imports, the env scrub, and the ordered boot plan the launcher's
// runner executes step by step. Nothing here touches the disk; `launcher.mjs` runs the plan
// through the adapter, `test/launcher.test.js` asserts the plan byte-exact.

export const AGENT = Object.freeze({ uid: 1000, gid: 1000 })
export const AGENT_DATA_GID = 19999          // one fixed per-computer group on every dataDir (§3)
export const WORKER_UID_BASE = 20000
export const WORKER_UID_MAX = 65535
export const appgid = (uid) => uid           // an app's group id is its worker uid
export const INSTANCE_RE = /^i-[0-9a-f]{16}$/

// Never at all: `scrub` copies these under no key list. The bootstrap secret leaves the launcher only
// as /run/atelier/bootstrap.token; the pod-env leaf PEMs (ATELIER_HOST_TLS_{CERT,KEY,CA}) only as the
// image wrapper's /run/atelier/tls/*.pem behind `ATELIER_HOST_TLS` — dropped here even if a wrapper
// forgot the unset (`ATELIER_*` in HOST_KEEP would otherwise admit them to row H).
export const NEVER_BELOW = Object.freeze(['ATELIER_BOOTSTRAP', 'ATELIER_HOST_TLS_CERT', 'ATELIER_HOST_TLS_KEY', 'ATELIER_HOST_TLS_CA'])
// Never below the launcher in row H (S keeps the channel/anthropic ones — the supervisor's contract).
export const SECRETS = Object.freeze([...NEVER_BELOW, 'CHANNEL_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'])

/** A NEW env object from an explicit key list; an entry ending in `*` is a prefix. */
export function scrub(env, keep) {
  const out = {}
  for (const k of Object.keys(env)) {
    if (NEVER_BELOW.includes(k) || env[k] === undefined) continue
    if (keep.some((p) => (p.endsWith('*') ? k.startsWith(p.slice(0, -1)) : k === p))) out[k] = env[k]
  }
  return out
}

// Row H — the host: the pod's locale/PATH and every ATELIER_* knob (minus the bootstrap secret), no
// CHANNEL_*, no persona text, no credential of any kind; the launcher-set keys win.
export const HOST_KEEP = Object.freeze(['PATH', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'ATELIER_*'])
export function hostEnv(podEnv, cfg) {
  return {
    ...scrub(podEnv, HOST_KEEP),
    ATELIER_DIRFD: '3', ATELIER_RUN: cfg.run, ATELIER_WORK: cfg.work, ATELIER_CONTROL: cfg.control,
    ...(podEnv.CHANNEL_URL ? { ATELIER_SPINE_URL: podEnv.CHANNEL_URL } : {}),
    HOME: '/root', NODE_ENV: 'production',
  }
}

// Row S — the image's session supervisor, its production env contract unchanged: everything the
// spine (k8s.ts buildSessionPod) and the Containerfile set, minus ATELIER_* (the bootstrap secret
// and the host's knobs), HOME pinned to /work. CLAUDE_MODEL is the supervisor's model pick
// (session-supervisor.mjs reads it at claude launch); OPENAI_VOICE_TOKEN is the pod's `voice`
// secret (envFrom) that speak/draw need. The CHANNEL_ family is kept by PREFIX: the spine adds members
// (CHANNEL_CHAT_KIND=group|direct, 2026-09-02 — the door plugin's send-path guard fails closed in every 1:1
// without it), and a name list here silently dropped each new one before it reached claude and the plugin.
export const SESSION_KEEP = Object.freeze([
  'PATH', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'CHAT_ID', 'PERSONA*', 'STORY_TEXT',
  'CHANNEL_*', 'ANTHROPIC_*', 'CLAUDE_MODEL', 'DISABLE_AUTOUPDATER',
  'OPENAI_VOICE_TOKEN', 'HORSE_BROWSER_*', 'FLEET_EGRESS*', 'PIP_USER', 'NPM_CONFIG_PREFIX',
])
export function sessionEnv(podEnv) { return { ...scrub(podEnv, SESSION_KEEP), HOME: '/work' } }

// Row X — the uid-1000 helper that appends to /control/.host-crash: PATH and nothing else.
export function helperEnv(podEnv) { return scrub(podEnv, ['PATH']) }

/**
 * The boot plan (DESIGN §2.1 steps 1–3b), executed in array order by `runPlan` in launcher.mjs.
 * Ops: umask · mkdir (mode at creation; EEXIST tolerated and audited; `reclaim` chowns an existing
 * dir back to 0:0 so root can populate it again) · openDir (kept for life) · unlink (ENOENT fine) ·
 * chownIf (only when the inode is owned `ifOwner`; `missingOk` skips ENOENT) · mkdirIfMissing
 * (mkdir + chown, nothing when present) · chown · write (`wx`, mode at creation) ·
 * chmodIfRootOwned (the one chmod: an EXISTING `0:0` directory with another mode — the `/run/atelier`
 * tmpfs mount root arrives `1777` — is chmodded while root owns it; a non-root owner is logged and
 * left). Every other mode is set at creation and nothing is chmod'ed after its chown.
 * Container-restart semantics (restartPolicy Always, `/run/atelier` and `/work` outlive the container):
 * every marker may already exist — the sentinel of the previous life is unlinked, the tokens are
 * re-minted (unlink, then exclusive create), the agent-owned session dir is reclaimed first.
 * @param {{work:string, run:string, tmp?:string}} cfg
 * @param {{bootstrap?:string, devToken:string}} tokens
 */
export function bootPlan(cfg, { bootstrap, devToken }) {
  const W = cfg.work, R = cfg.run, T = cfg.tmp ?? '/tmp'
  return [
    { op: 'umask', mode: 0o000 },                                   // modes below are exact, not masked
    // 0. /work is root's while root creates the markers (review 2026-08-30): a MIGRATED volume arrives
    //    1000:1000 (the per-conversation recipe chowns it whole) and root without CAP_DAC_OVERRIDE is
    //    "other" there — the first mkdir below was EACCES on every such boot (D0 row c measured the
    //    syscall), exit 2, a crashloop for every chat but a brand-new one. CAP_CHOWN is one of the four:
    //    take /work back here, hand it to the agent in step 2 (a chown round trip, the R1 pattern; no
    //    uid-1000 process exists yet). A fresh 0:0 volume passes through untouched.
    { op: 'chownIf', path: W, ifOwner: [AGENT.uid, AGENT.gid], uid: 0, gid: 0 },
    // 1. root-owned markers, before anything else
    { op: 'mkdir', path: `${W}/.atelier`, mode: 0o711, owner: [0, 0] },
    { op: 'mkdir', path: `${W}/.atelier/data`, mode: 0o711, owner: [0, 0] },
    { op: 'mkdir', path: `${W}/.atelier/last-good`, mode: 0o711, owner: [0, 0] },
    { op: 'mkdir', path: `${W}/.atelier/scratch`, mode: 0o711, owner: [0, 0] },
    { op: 'mkdir', path: R, mode: 0o711, owner: [0, 0] },
    { op: 'chmodIfRootOwned', path: R, mode: 0o711 },                // the tmpfs mount arrives 0:0 1777: closed before any uid-1000 process exists
    { op: 'mkdir', path: `${R}/dev`, mode: 0o710, owner: [0, AGENT.gid] },
    { op: 'chown', path: `${R}/dev`, uid: 0, gid: AGENT.gid },
    { op: 'mkdir', path: `${R}/session`, mode: 0o700, owner: [AGENT.uid, AGENT.gid], reclaim: true },   // chowned in 3b, once populated
    { op: 'openDir', path: `${W}/.atelier`, as: 'dirfd' },
    { op: 'unlink', path: `${R}/host-ready` },                     // the previous life's sentinel never lies at birth
    // 1b. lost+found while root still owns /work
    { op: 'chownIf', path: `${W}/lost+found`, ifOwner: [0, 0], uid: AGENT.uid, gid: AGENT.gid, missingOk: true },
    // 2. /work/apps while root can still create in /work; then /work itself to the agent — always
    //    (fresh 0:0, or taken back in step 0; chown touches no mode: a migrated 2775 stays 2775)
    { op: 'mkdirIfMissing', path: `${W}/apps`, mode: 0o755, uid: AGENT.uid, gid: AGENT.gid },
    { op: 'chown', path: W, uid: AGENT.uid, gid: AGENT.gid },
    // 3. tmux socket dir (mode first, then owner — never chmod after chown); X11 socket dir root 1777
    { op: 'mkdir', path: `${T}/tmux-1000`, mode: 0o700, owner: [AGENT.uid, AGENT.gid] },
    { op: 'chown', path: `${T}/tmux-1000`, uid: AGENT.uid, gid: AGENT.gid },
    { op: 'mkdir', path: `${T}/.X11-unix`, mode: 0o1777, owner: [0, 0] },
    // 3b. tokens: bootstrap (when the pod carries one), the dev token for the host and for the agent
    { op: 'unlink', path: `${R}/bootstrap.token` },
    ...(bootstrap ? [{ op: 'write', path: `${R}/bootstrap.token`, data: bootstrap, mode: 0o400 }] : []),
    { op: 'unlink', path: `${R}/dev.token` },
    { op: 'write', path: `${R}/dev.token`, data: devToken, mode: 0o400 },
    { op: 'unlink', path: `${R}/session/dev.token` },
    { op: 'write', path: `${R}/session/dev.token`, data: devToken, mode: 0o400 },
    { op: 'chown', path: `${R}/session/dev.token`, uid: AGENT.uid, gid: AGENT.gid },
    { op: 'chown', path: `${R}/session`, uid: AGENT.uid, gid: AGENT.gid },
    { op: 'umask', mode: 0o077 },                                   // the launcher's own writes from here on
  ]
}
