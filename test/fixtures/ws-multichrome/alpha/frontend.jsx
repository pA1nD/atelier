// Default chrome (alphabetically first → wins the default election).
export const meta = { isChrome: true, hidden: true, name: 'alpha' }
export function chrome({ active }) {
  return active?.element ?? null
}
