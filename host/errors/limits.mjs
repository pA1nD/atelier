// host/errors/limits.mjs — the per-worker rlimit numbers (PLAN §4.3 "Memory = RLIMIT_DATA per
// worker", R2; DESIGN §2.2) and the two derived caps every other module reads from here.
//
//   RLIMIT_DATA   1 GiB default and FLOOR. It caps VIRTUAL data (V8's CodeRange is reserved at
//                 boot): 512M aborts node at boot ("Failed to reserve virtual memory for
//                 CodeRange"), ≥ 1024M boots; a leak or a burst then ends as an in-worker
//                 RangeError at ≈ data − 576 MB, never a kernel OOM [S:scale-perf-1].
//   RLIMIT_CORE   0 — a V8 abort must not write a core into the app folder.
//   RLIMIT_NPROC  64 — per uid; every worker has its own uid, so this is a per-worker fork cap
//                 (fork 200 → EAGAIN at the cap) [S:g6].
//   RLIMIT_NOFILE 1024.
//   Never RLIMIT_AS (512 MB kills node at boot) [S:B3].
//
//   --max-old-space-size = (data − 576 MB) × 0.85 in MB, min 256 — the JS heap gets what is left
//   after the CodeRange reserve, with a margin so the heap limit fires (a graceful
//   "heap out of memory") before the rlimit does (a RangeError in arbitrary code).
//   RSS cap (the watchdog's SIGKILL line) = data − 640 MB, min 256 MB.

export const MB = 1024 * 1024
export const RLIMIT_DATA_DEFAULT = 1024 * MB
export const RLIMIT_DATA_FLOOR = 1024 * MB
export const RLIMIT_CORE = 0
export const RLIMIT_NPROC = 64
export const RLIMIT_NOFILE = 1024
export const NODE_DATA_RESERVE = 576 * MB
export const OLD_SPACE_FACTOR = 0.85
export const OLD_SPACE_MIN_MB = 256
export const RSS_CAP_RESERVE = 640 * MB
export const RSS_CAP_MIN = 256 * MB

/** rlimitsFor(instance, {data?}) → {data, core, nproc, nofile}. `data` below the floor is a
 *  RangeError — a host bug or a bad config value, never something to run with. */
export function rlimitsFor(instance, { data } = {}) {
  if (data === undefined) data = RLIMIT_DATA_DEFAULT
  if (!Number.isInteger(data) || data < RLIMIT_DATA_FLOOR) {
    throw new RangeError(`RLIMIT_DATA ${fmtMb(data)} for ${instance} is below the ${fmtMb(RLIMIT_DATA_FLOOR)} floor (512M aborts node at boot: the limit counts V8's CodeRange)`)
  }
  return { data, core: RLIMIT_CORE, nproc: RLIMIT_NPROC, nofile: RLIMIT_NOFILE }
}

/** maxOldSpaceMb(data) → the --max-old-space-size value for a worker under RLIMIT_DATA=data. */
export function maxOldSpaceMb(data = RLIMIT_DATA_DEFAULT) {
  return Math.max(OLD_SPACE_MIN_MB, Math.floor(((data - NODE_DATA_RESERVE) * OLD_SPACE_FACTOR) / MB))
}

/** nodeArgv(rlimits) → the node flags row W puts before the runtime path. */
export function nodeArgv(rlimits = rlimitsFor('default')) {
  return [`--max-old-space-size=${maxOldSpaceMb(rlimits.data)}`]
}

/** rssCapKb(data) → the watchdog's SIGKILL line in KB (what /proc VmRSS reports). */
export function rssCapKb(data = RLIMIT_DATA_DEFAULT) {
  return Math.max(RSS_CAP_MIN, data - RSS_CAP_RESERVE) / 1024
}

export const fmtMb = (bytes) => (Number.isFinite(bytes) ? `${Math.round(bytes / MB)}M` : String(bytes))
