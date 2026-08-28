// doctor/report/daily.mjs — the 18 daily module ids (the seed's list). Used for the `daily` column and
// the row order only (daily first, in this order, then alphabetical); nothing else reads it.

export const DAILY = Object.freeze(['dashboard', 'jobs', 'agent', 'audio-player', 'sites', 'spaces', 'shipmate', 'forms', 'pipeline', 'artifacts', 'mining', 'news', 'signal', 'channels', 'flights', 'requests', 'bookmarks', 'accounts'])

export const isDaily = (id) => DAILY.includes(id)

/** The seed's sort: daily modules first in DAILY order, then everything else alphabetically. */
export function dailySort(a, b) {
  const da = isDaily(a), db = isDaily(b)
  if (da !== db) return da ? -1 : 1
  if (da) return DAILY.indexOf(a) - DAILY.indexOf(b)
  return a.localeCompare(b)
}
