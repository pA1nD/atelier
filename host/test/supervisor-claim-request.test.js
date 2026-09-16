// A folder's FIRST claim carries its module.json REQUEST (`primary`, protocol/registry META_REQUEST) next to the
// allowed meta. The supervisor used to send discovery's whitelisted meta alone — `primary` lives in `requested`,
// so the registry never saw requested_primary and no app was ever a company's primary (F20, 2026-09-16).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { world, waitFor, BACKEND, FRONTEND, CARD } from './supervisor-harness.test.js'

test('claimFolder: module.json `primary: true` reaches the registrar claim as meta.primary (the request rides with the meta)', async () => {
  const w = world()
  const seen = []
  const claim = w.registrar.claim.bind(w.registrar)
  w.registrar.claim = async (arg) => { seen.push(arg); return claim(arg) }
  const dir = w.app('home', { 'module.json': JSON.stringify({ name: 'Home', icon: 'house', primary: true, bogus: 1 }), 'backend.js': BACKEND(1), 'frontend.jsx': FRONTEND(1), 'card.jsx': CARD })
  w.app('other', { 'module.json': JSON.stringify({ name: 'Other' }), 'backend.js': BACKEND(1), 'frontend.jsx': FRONTEND(1), 'card.jsx': CARD })
  const sup = w.make()
  try {
    await sup.scan()
    await waitFor(() => seen.some((c) => c.slug === 'home') && seen.some((c) => c.slug === 'other'))
    const home = seen.find((c) => c.slug === 'home')
    assert.equal(home.meta.primary, true, 'the primary request rides on the first claim')
    assert.equal(home.meta.name, 'Home'); assert.equal(home.meta.icon, 'house')
    assert.equal('bogus' in home.meta, false, 'unknown keys stay dropped')
    const other = seen.find((c) => c.slug === 'other')
    assert.equal('primary' in other.meta, false, 'no request → no key')
    // a change of the REQUEST alone (the whitelisted meta untouched) re-claims — the registry follows the folder
    await waitFor(() => sup.resolve('acme', 'home')?.dev_state === 'live', { ms: 15000 })   // the first build settled before the save
    fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify({ name: 'Home', icon: 'house', primary: false }))
    await waitFor(() => seen.filter((c) => c.slug === 'home').length >= 2, { ms: 8000 })
    assert.equal(seen.filter((c) => c.slug === 'home').pop().meta.primary, false, 'primary: false reaches the registrar on its own')
    await waitFor(() => sup.resolve('acme', 'home')?.dev_rev === 2, { ms: 15000 })          // and the second, before teardown
  } finally { await w.done(sup) }
})
