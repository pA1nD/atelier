// Fixture: a COMPUTED meta — template literal + module-scope constants — plus
// the standard top-level patterns that kill naive evaluation (window.__atelier
// at module scope, a bare @atelier/kit import). The static parser can't read
// this; the sandboxed fallback must.
import { Button } from '@atelier/kit'

const CHAPTERS = [{ slug: 'one' }, { slug: 'two' }, { slug: 'three' }]
const IQ = CHAPTERS.length

export const meta = { name: `Epsilon ${IQ}IQ`, icon: 'sparkles', group: 'demo', chrome: 'pinned-chrome' }

const self = window.__atelier.self(import.meta.url)

export default function Module() {
  return <div className="p-8"><Button>epsilon</Button></div>
}
