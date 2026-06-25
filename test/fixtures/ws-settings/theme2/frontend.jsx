export const meta = { isChrome: true, hidden: true, name: 'theme2' }
export function chrome({ active }) {
  return active?.element ?? null
}
