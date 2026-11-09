// The live part of the status page: the open issues labelled `in progress`, `in review` or `testing` in the
// team's repositories, from the unauthenticated GitHub Search API, refreshed every minute.
//
// The page works without this file: scripts/build.mjs puts a snapshot of the same lists in the HTML (made with the
// functions below), and this script only replaces it with something newer. There is no token here, and none is needed.
//
// An ES module with no side effects on import in Node (the tests and the build import it); in a browser it starts itself.
// No inline script, no eval, no innerHTML with anything that was not escaped by `escapeHtml`.

export const API = 'https://api.github.com'

/** The repositories whose issues are listed. */
export const REPOS = [
  'padcom/pico-lang',
  'padcom/pico-desktop',
  'padcom/pico-serialport',
  'padcom/pico-mavlink',
  'padcom/drone-configurator',
]

/** The labels that make an issue appear, in the order of the page; `placeholder` is its slot in the template. */
export const LISTS = [
  { label: 'in progress', title: 'In progress', placeholder: 'work_in_progress' },
  { label: 'in review', title: 'In review', placeholder: 'work_in_review' },
  { label: 'testing', title: 'Testing', placeholder: 'work_testing' },
]

/** The cache is versioned: a change in what is stored changes the key, and old entries are simply never read. */
export const CACHE_KEY = 'drone-configurator-status:work:v1'

/** A cached result younger than this is not fetched again. */
export const TTL_MS = 60_000

/** How often the page looks for something newer (3 searches a minute; the limit is 10 a minute per address). */
export const REFRESH_MS = 60_000

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/u
const MAX_TITLE = 300

// ---------------------------------------------------------------------------------------------------------
// Escaping and links.
// ---------------------------------------------------------------------------------------------------------

/** HTML-escapes text. Everything from GitHub (titles, names) is untrusted. */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/gu, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

/** A link target is used only if it is an https URL on github.com. */
export function safeUrl(url) {
  return typeof url === 'string' && /^https:\/\/github\.com\/[\w./#?=&%-]*$/u.test(url) ? url : null
}

// ---------------------------------------------------------------------------------------------------------
// The data: search results, and what is kept of them.
// ---------------------------------------------------------------------------------------------------------

/** The search for one label, as a path on the API. */
export function searchPath(label) {
  const query = `${REPOS.map(r => `repo:${r}`).join(' ')} is:issue is:open label:"${label}"`
  return `/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=50`
}

/**
 * An entry as it is kept (and as it is read back from the cache, which is untrusted too): or null if it is not
 * one. Only what the page shows is kept.
 */
export function cleanItem(item) {
  const repo = item?.repo
  const number = item?.number
  const url = safeUrl(item?.url)
  if (typeof repo !== 'string' || !REPO_NAME.test(repo) || !Number.isInteger(number) || number < 1 || url === null) {
    return null
  }
  if (typeof item.title !== 'string') {
    return null
  }
  return { repo, number, title: item.title.slice(0, MAX_TITLE), url }
}

/** The entries of a search response; pull requests, and anything malformed, are left out. */
export function itemsOf(response) {
  const found = Array.isArray(response?.items) ? response.items : []
  return found
    .filter(i => i && !i.pull_request)
    .map(i => cleanItem({
      repo: /^https:\/\/api\.github\.com\/repos\/([\w.-]+\/[\w.-]+)$/u.exec(i.repository_url ?? '')?.[1],
      number: i.number,
      title: i.title,
      url: i.html_url,
    }))
    .filter(Boolean)
}

/** The HTML of one list: repository, number as a link, title. Everything is escaped. */
export function renderItems(items) {
  if (!items || items.length === 0) {
    return '<p class="empty">Nothing here.</p>'
  }
  const rows = items.map(i => {
    const item = cleanItem(i)
    if (item === null) {
      return ''
    }
    return `<li><span class="repo">${escapeHtml(item.repo)}</span> <a href="${escapeHtml(item.url)}">#${item.number}</a> ${escapeHtml(item.title)}</li>`
  })
  return `<ul class="work">${rows.join('')}</ul>`
}

// ---------------------------------------------------------------------------------------------------------
// The cache. localStorage may be missing, full, or forbidden: every access is guarded, and a failure just means
// there is no cache.
// ---------------------------------------------------------------------------------------------------------

/**
 * The cached lists, or null.
 *
 * @returns `{ at, lists }` where `at` is when they were fetched (ms) and `lists` maps a label to its entries
 */
export function readCache(storage, now) {
  try {
    const parsed = JSON.parse(storage.getItem(CACHE_KEY))
    if (!parsed || !Number.isFinite(parsed.at) || typeof parsed.lists !== 'object' || parsed.lists === null) {
      return null
    }
    const lists = {}
    for (const { label } of LISTS) {
      if (Array.isArray(parsed.lists[label])) {
        lists[label] = parsed.lists[label].map(cleanItem).filter(Boolean)
      }
    }
    return { at: Math.min(parsed.at, now), lists }
  } catch {
    return null
  }
}

/** Keeps the lists; false if it could not. */
export function writeCache(storage, lists, now) {
  try {
    storage.setItem(CACHE_KEY, JSON.stringify({ at: now, lists }))
    return true
  } catch {
    return false
  }
}

/** The storage, or null if even asking for it is an error (some browsers throw on the property). */
export function storageOf(scope) {
  try {
    return scope.localStorage ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------------------
// Refreshing.
// ---------------------------------------------------------------------------------------------------------

const RATE_LIMITED = 'rate'
const UNREACHABLE = 'network'

/** What went wrong, for the notice. */
export const NOTICES = {
  [RATE_LIMITED]: 'GitHub\'s search limit was reached, so these lists may be out of date. They show the last result and are tried again in a minute.',
  [UNREACHABLE]: 'GitHub could not be reached, so these lists may be out of date. They show the last result and are tried again in a minute.',
}

async function search(label, fetchImpl) {
  let response
  try {
    response = await fetchImpl(`${API}${searchPath(label)}`, { headers: { accept: 'application/vnd.github+json' } })
  } catch {
    return { problem: UNREACHABLE }
  }
  const limited = response.status === 403 || response.status === 429 || response.headers?.get?.('x-ratelimit-remaining') === '0'
  if (limited && !response.ok) {
    return { problem: RATE_LIMITED }
  }
  if (!response.ok) {
    return { problem: UNREACHABLE }
  }
  try {
    return { items: itemsOf(await response.json()) }
  } catch {
    return { problem: UNREACHABLE }
  }
}

/**
 * Looks for newer lists. A list that could not be fetched keeps its last value; the cache is written only when all
 * three were fetched.
 *
 * @param options.fetchImpl `fetch`
 * @param options.storage localStorage, or null
 * @param options.now the time in ms
 * @param options.lists the lists shown now (the last result), by label
 * @param options.at when they were fetched, or null
 * @returns `{ lists, at, notice }`: `notice` is a text for the reader, or null
 */
export async function refresh({ fetchImpl, storage, now, lists = {}, at = null }) {
  const results = await Promise.all(LISTS.map(async ({ label }) => [label, await search(label, fetchImpl)]))
  const merged = { ...lists }
  let problem = null
  for (const [label, result] of results) {
    if (result.items) {
      merged[label] = result.items
    } else {
      // A rate limit is the more useful thing to say.
      problem = problem === RATE_LIMITED ? problem : result.problem
    }
  }
  if (problem !== null) {
    return { lists: merged, at, notice: NOTICES[problem] }
  }
  if (storage) {
    writeCache(storage, merged, now)
  }
  return { lists: merged, at: now, notice: null }
}

/** "updated 12 s ago" */
export function updatedText(at, now) {
  if (at === null) {
    return ''
  }
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  return seconds < 60 ? `updated ${seconds} s ago` : `updated ${Math.floor(seconds / 60)} min ago`
}

// ---------------------------------------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------------------------------------

/**
 * Starts the live lists on a page. The elements are the ones in site/index.html: `[data-work-label]` (one per list),
 * `#work-updated` and `#work-notice`.
 */
export function start({ document, fetchImpl, storage, now = Date.now, setTimer = setInterval }) {
  let current = { lists: {}, at: null }
  let notice = null

  function draw() {
    for (const el of document.querySelectorAll('[data-work-label]')) {
      const label = el.getAttribute('data-work-label')
      // A list never fetched keeps the snapshot that is in the page.
      if (current.lists[label]) {
        el.innerHTML = renderItems(current.lists[label])
      }
    }
    const updated = document.getElementById('work-updated')
    if (updated && current.at !== null) {
      updated.textContent = updatedText(current.at, now())
    }
    const box = document.getElementById('work-notice')
    if (box) {
      box.textContent = notice ?? ''
      box.hidden = notice === null
    }
  }

  function fromCache() {
    const cached = storage ? readCache(storage, now()) : null
    if (cached && (current.at === null || cached.at > current.at)) {
      current = { lists: { ...current.lists, ...cached.lists }, at: cached.at }
    }
  }

  async function tick() {
    // Another tab may just have fetched: its result is as good as ours.
    fromCache()
    if (current.at === null || now() - current.at >= TTL_MS) {
      const next = await refresh({ fetchImpl, storage, now: now(), lists: current.lists, at: current.at })
      current = { lists: next.lists, at: next.at }
      notice = next.notice
    } else {
      notice = null
    }
    draw()
  }

  fromCache()
  draw()
  void tick()
  setTimer(() => { void tick() }, REFRESH_MS)
  setTimer(draw, 5000)
}

if (typeof globalThis.document !== 'undefined' && typeof globalThis.fetch === 'function') {
  start({ document: globalThis.document, fetchImpl: globalThis.fetch.bind(globalThis), storage: storageOf(globalThis) })
}
