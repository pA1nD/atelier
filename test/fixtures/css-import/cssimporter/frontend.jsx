// A chrome that imports CSS from JS — atelier doesn't bundle CSS (styles ship
// via styles.css + <link>), so this must fail LOUD, not drop silently.
import './tokens.css'
export const meta = { isChrome: true, hidden: true, name: 'cssimporter' }
export function chrome({ active }) { return active?.element ?? null }
