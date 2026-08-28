// Test doubles for the client's pure modules: a virtual clock with timers, a scriptable
// WebSocket, a scriptable fetch and a tiny DOM. No real I/O.

export function fakeClock(start = 1_000_000) {
  let t = start, id = 0
  const timers = new Map()
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)) }
  return {
    now: () => t,
    setTimeout(fn, ms) { const i = ++id; timers.set(i, { at: t + Math.max(0, ms | 0), fn, every: null }); return i },
    clearTimeout(i) { timers.delete(i) },
    setInterval(fn, ms) { const i = ++id; timers.set(i, { at: t + ms, fn, every: ms }); return i },
    clearInterval(i) { timers.delete(i) },
    flush,
    async advance(ms) {
      const end = t + ms
      for (;;) {
        let next = null
        for (const [i, tm] of timers) if (tm.at <= end && (!next || tm.at < next[1].at)) next = [i, tm]
        if (!next) break
        t = next[1].at
        if (next[1].every) next[1].at += next[1].every; else timers.delete(next[0])
        next[1].fn()
        await flush()
      }
      t = end
      await flush()
    },
    pending: () => timers.size,
  }
}

export class FakeWebSocket {
  static instances = []
  constructor(url) {
    this.url = url; this.readyState = 0; this.sent = []
    this.onopen = this.onmessage = this.onclose = this.onerror = null
    this.closedByClient = false
    FakeWebSocket.instances.push(this)
  }
  static reset() { FakeWebSocket.instances = [] }
  static last() { return FakeWebSocket.instances[FakeWebSocket.instances.length - 1] }
  send(data) { if (this.readyState !== 1) throw new Error('not open'); this.sent.push(JSON.parse(data)) }
  close() { this.readyState = 3; this.closedByClient = true }
  open() { this.readyState = 1; this.onopen && this.onopen({}) }
  receive(frame) { this.onmessage && this.onmessage({ data: JSON.stringify(frame) }) }
  serverClose(code = 1006) { this.readyState = 3; this.onclose && this.onclose({ code }) }
  ops(op) { return this.sent.filter((m) => m.op === op) }
}

// fakeFetch(routes): routes = [{ match: (url) => bool, respond: (url, opts) => {status, body, headers?} }]
export function fakeFetch(routes = []) {
  const calls = []
  const f = async (url, opts = {}) => {
    calls.push({ url, opts })
    const r = routes.find((x) => x.match(url))
    if (!r) return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) }
    const out = await r.respond(url, opts)
    const headers = out.headers || {}
    return { ok: out.status >= 200 && out.status < 300, status: out.status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => out.body }
  }
  f.calls = calls
  return f
}

// A minimal DOM: elements with attributes, children, events; enough for sheet.js and picker.js.
export class FakeElement {
  constructor(doc, tag) { this.doc = doc; this.tagName = tag; this.attrs = new Map(); this.children = []; this.parentNode = null; this.listeners = new Map() }
  get id() { return this.attrs.get('id') || '' }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null }
  setAttribute(k, v) { this.attrs.set(k, String(v)) }
  removeAttribute(k) { this.attrs.delete(k) }
  get href() { return this.getAttribute('href') }
  cloneNode() { const e = new FakeElement(this.doc, this.tagName); for (const [k, v] of this.attrs) e.attrs.set(k, v); return e }
  addEventListener(ev, fn) { const l = this.listeners.get(ev) || []; l.push(fn); this.listeners.set(ev, l) }
  fire(ev) { for (const fn of this.listeners.get(ev) || []) fn({ type: ev, target: this }) }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c }
  insertBefore(c, ref) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c }
  get nextSibling() { const p = this.parentNode; if (!p) return null; const i = p.children.indexOf(this); return p.children[i + 1] || null }
  remove() { const p = this.parentNode; if (!p) return; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null }
  submit() { this.doc.submitted.push(this) }
  find(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.find(pred, out) } return out }
}
export function fakeDocument() {
  const doc = { submitted: [], assigned: [] }
  doc.head = new FakeElement(doc, 'head'); doc.body = new FakeElement(doc, 'body')
  doc.createElement = (tag) => new FakeElement(doc, tag)
  doc.getElementById = (id) => [...doc.head.find((e) => e.id === id), ...doc.body.find((e) => e.id === id)][0] || null
  doc.links = () => doc.head.find((e) => e.tagName === 'link')
  doc.defaultView = { location: { assign: (h) => doc.assigned.push(h) } }
  return doc
}
