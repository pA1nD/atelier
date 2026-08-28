// Shared fakes for host/test/errors-*.test.js: a fake clock whose timers fire on advance(),
// an integer-ms `now`, and a microtask drain for promise-driven code (push).
export function fakeClock(start = 1_700_000_000_000) {
  let now = start
  let seq = 0
  const pending = new Map()
  const timers = {
    setTimeout(fn, ms) { const id = ++seq; pending.set(id, { at: now + Math.max(0, ms), fn, id }); return id },
    clearTimeout(id) { pending.delete(id) },
  }
  return {
    timers,
    now: () => now,
    set(ms) { now = ms },
    pending: () => pending.size,
    advance(ms) {
      const end = now + ms
      for (;;) {
        const due = [...pending.values()].filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0]
        if (!due) break
        pending.delete(due.id)
        now = Math.max(now, due.at)
        due.fn()
      }
      now = end
    },
  }
}
export const drain = () => new Promise((r) => setImmediate(r))
export const lines = () => { const out = []; const log = (t) => out.push(t); log.out = out; return log }
