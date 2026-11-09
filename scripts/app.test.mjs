// The page script (site/app.js), without a browser: a fake fetch, a fake storage and a fake document.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CACHE_KEY,
  LISTS,
  MAX_ITEMS,
  PartialResultError,
  REFRESH_MS,
  TTL_MS,
  cleanItem,
  countOf,
  itemsOf,
  readCache,
  refresh,
  renderItems,
  searchPath,
  searchResult,
  start,
  storageOf,
  updatedText,
  writeCache,
} from '../site/app.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0)

const fixture = async name => JSON.parse(await readFile(join(HERE, 'fixtures', `search-${name}.json`), 'utf8'))

/** A fetch answering each label's search from the fixtures (or with what `override` says), counting calls. */
function searchFetch(fixtures, override = {}) {
  const fetchImpl = async url => {
    fetchImpl.calls += 1
    const query = decodeURIComponent(url)
    const label = LISTS.map(l => l.label).find(l => query.includes(`label:"${l}"`))
    const [status, body, headers = {}] = override[label] ?? [200, fixtures[label]]
    return { ok: status >= 200 && status < 300, status, headers: { get: name => headers[name] ?? null }, json: async () => body }
  }
  fetchImpl.calls = 0
  return fetchImpl
}

const allFixtures = async () => ({
  'in progress': await fixture('in-progress'),
  'in review': await fixture('in-review'),
  'testing': await fixture('testing'),
})

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    data,
  }
}

const item = (n, title = `Issue ${n}`) => ({ repo: 'padcom/pico-lang', number: n, title, url: `https://github.com/padcom/pico-lang/issues/${n}` })

test('searches the five repositories for open issues with a label, newest activity first', () => {
  const path = decodeURIComponent(searchPath('in progress'))
  assert.match(path, /^\/search\/issues\?q=repo:padcom\/pico-lang repo:padcom\/pico-desktop repo:padcom\/pico-serialport repo:padcom\/pico-mavlink repo:padcom\/drone-configurator is:issue is:open label:"in progress"&sort=updated&order=desc&per_page=50$/u)
})

test('keeps repository, number, title and link of a search result; drops pull requests and malformed entries', async () => {
  const items = itemsOf(await fixture('in-progress'))
  // #9 has a javascript: link and is dropped; the other two are kept.
  assert.deepEqual(items.map(i => [i.repo, i.number]), [['padcom/pico-desktop', 52], ['padcom/pico-mavlink', 7]])
  const messy = { items: [null, 5, { number: 'x' }, { number: 1, title: 't', html_url: 'https://github.com/a/b/issues/1', repository_url: 'https://evil.example/repos/a/b' }, { number: 2, title: 'pr', html_url: 'https://github.com/a/b/pull/2', repository_url: 'https://api.github.com/repos/a/b', pull_request: {} }] }
  assert.deepEqual(itemsOf(messy), [])
  assert.deepEqual(itemsOf(undefined), [])
  assert.deepEqual(itemsOf({ items: 'nope' }), [])
})

test('renders repository, number as a link and title, with everything escaped', () => {
  const html = renderItems([item(3, '<script>alert(1)</script> & "quotes"')])
  assert.equal(
    html,
    '<ul class="work"><li><span class="repo">padcom/pico-lang</span> <a href="https://github.com/padcom/pico-lang/issues/3">#3</a> &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;</li></ul>',
  )
  assert.ok(!html.includes('<script'))
  assert.match(renderItems([]), /Nothing here/u)
  assert.match(renderItems(undefined), /Nothing here/u)
})

test('accepts only https://github.com/ links, and only plain repository names', () => {
  assert.equal(cleanItem({ ...item(1), url: 'javascript:alert(1)' }), null)
  assert.equal(cleanItem({ ...item(1), url: 'http://github.com/a/b/issues/1' }), null)
  assert.equal(cleanItem({ ...item(1), url: 'https://github.com.evil.example/a' }), null)
  assert.equal(cleanItem({ ...item(1), repo: '"><img src=x>' }), null)
  assert.equal(cleanItem({ ...item(1), number: 1.5 }), null)
  assert.equal(cleanItem({ ...item(1), title: 42 }), null)
  assert.deepEqual(cleanItem(item(1)), item(1))
  // A rendered entry from a hostile cache is not rendered at all.
  assert.ok(!renderItems([{ ...item(1), url: 'javascript:alert(1)' }]).includes('javascript'))
})

test('fetches the three lists, and caches them', async () => {
  const storage = memoryStorage()
  const fetchImpl = searchFetch(await allFixtures())
  const result = await refresh({ fetchImpl, storage, now: NOW })
  assert.equal(fetchImpl.calls, 3)
  assert.equal(result.notice, null)
  assert.equal(result.at, NOW)
  assert.deepEqual(Object.keys(result.lists), ['in progress', 'in review', 'testing'])
  assert.equal(result.lists['in review'][0].number, 11)
  const cached = readCache(storage, NOW + 5000)
  assert.equal(cached.at, NOW)
  assert.deepEqual(cached.lists, result.lists)
})

test('the cache key is versioned', () => {
  assert.match(CACHE_KEY, /:v\d+$/u)
})

test('says the search limit was reached, and keeps the last result', async () => {
  const last = { 'in progress': [item(1)], 'in review': [item(2)], 'testing': [] }
  const storage = memoryStorage()
  for (const limit of [[403, { message: 'rate limit' }, { 'x-ratelimit-remaining': '0' }], [429, {}], [403, {}]]) {
    const fetchImpl = searchFetch(await allFixtures(), { 'in review': limit })
    const result = await refresh({ fetchImpl, storage, now: NOW + 1000, lists: last, at: NOW })
    assert.match(result.notice, /search limit/u)
    // What could not be fetched keeps its last value; the rest is new; the time is still the last good one.
    assert.deepEqual(result.lists['in review'], [item(2)])
    assert.equal(result.lists['in progress'].length, 2)
    assert.equal(result.at, NOW)
  }
  // An incomplete result is not cached.
  assert.equal(storage.data.size, 0)
})

test('says GitHub could not be reached on a network error or a server error, and keeps the last result', async () => {
  const last = { 'in progress': [item(1)] }
  const down = async () => {
    throw new TypeError('Failed to fetch')
  }
  const offline = await refresh({ fetchImpl: down, storage: memoryStorage(), now: NOW, lists: last, at: NOW - 1000 })
  assert.match(offline.notice, /could not be reached/u)
  assert.deepEqual(offline.lists, last)
  assert.equal(offline.at, NOW - 1000)

  const broken = searchFetch(await allFixtures(), { testing: [500, {}] })
  assert.match((await refresh({ fetchImpl: broken, storage: null, now: NOW })).notice, /could not be reached/u)
})

test('reads a missing, broken or hostile cache as no cache', () => {
  assert.equal(readCache(memoryStorage(), NOW), null)
  for (const text of ['not json', '{"at":"x","lists":{}}', '{"at":1}', 'null', '[]', '{"at":1,"lists":null}']) {
    assert.equal(readCache(memoryStorage({ [CACHE_KEY]: text }), NOW), null, text)
  }
  // Entries are checked when read, not trusted because we wrote them.
  const stored = JSON.stringify({ at: NOW, lists: { 'in progress': [item(1), { ...item(2), url: 'javascript:alert(1)' }, 'x'], 'other': [item(3)] } })
  const cached = readCache(memoryStorage({ [CACHE_KEY]: stored }), NOW)
  assert.deepEqual(cached.lists, { 'in progress': [item(1)] })
})

test('treats a partial search result (incomplete_results) as a failed search: the last result stays, nothing is cached', async () => {
  const last = { 'in progress': [item(1)], 'in review': [item(2)], 'testing': [] }
  const partial = { total_count: 9, incomplete_results: true, items: [] }
  const storage = memoryStorage()
  const fetchImpl = searchFetch(await allFixtures(), { 'in review': [200, partial] })
  const result = await refresh({ fetchImpl, storage, now: NOW + 1000, lists: last, at: NOW })
  assert.match(result.notice, /could not be reached/u)
  assert.deepEqual(result.lists['in review'], [item(2)])
  assert.equal(result.at, NOW)
  assert.equal(storage.data.size, 0)
})

test('accepts an entry only for a team repository, linking to exactly that issue', () => {
  assert.equal(cleanItem({ ...item(1), repo: 'padcom/other-project', url: 'https://github.com/padcom/other-project/issues/1' }), null)
  // Right repository and number in the name, a link somewhere else on github.com.
  assert.equal(cleanItem({ ...item(1), url: 'https://github.com/evil/phish' }), null)
  assert.equal(cleanItem({ ...item(1), url: 'https://github.com/padcom/pico-desktop/issues/1' }), null)
  assert.equal(cleanItem({ ...item(1), url: 'https://github.com/padcom/pico-lang/issues/2' }), null)
  assert.equal(cleanItem({ ...item(1), url: 'https://github.com/padcom/pico-lang/pull/1' }), null)
  assert.equal(cleanItem({ ...item(1), url: 'https://github.com/padcom/pico-lang/issues/1#x' }), null)
  assert.deepEqual(cleanItem(item(1)), item(1))
  // The same holds for what a search returns and for what a cache holds.
  const search = { items: [{ number: 1, title: 't', html_url: 'https://github.com/evil/phish', repository_url: 'https://api.github.com/repos/padcom/pico-lang' }] }
  assert.deepEqual(itemsOf(search), [])
  const stored = JSON.stringify({ at: NOW, lists: { 'in progress': [{ ...item(1), url: 'https://github.com/evil/phish' }] } })
  assert.deepEqual(readCache(memoryStorage({ [CACHE_KEY]: stored }), NOW).lists, { 'in progress': [] })
})

test('lists at most MAX_ITEMS entries and says how many more there are', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    number: i + 1,
    title: `Issue ${i + 1}`,
    html_url: `https://github.com/padcom/pico-lang/issues/${i + 1}`,
    repository_url: 'https://api.github.com/repos/padcom/pico-lang',
  }))
  const result = searchResult({ total_count: 130, incomplete_results: false, items: many })
  assert.equal(result.items.length, MAX_ITEMS)
  assert.equal(result.more, 80)
  const html = renderItems(result.items, result.more)
  assert.equal(html.match(/<li>/gu).length, MAX_ITEMS)
  assert.match(html, /<p class="more">and 80 more<\/p>/u)
  // Nothing is added when everything is shown, or the count is not a number.
  assert.equal(searchResult({ total_count: 2, items: many.slice(0, 2) }).more, 0)
  assert.equal(searchResult({ total_count: 'lots', items: many.slice(0, 2) }).more, 0)
  assert.ok(!renderItems([item(1)], 0).includes('more'))
  assert.ok(!renderItems([item(1)], -3).includes('more'))
  assert.ok(!renderItems([item(1)], '<b>').includes('<b>'))
  // A hostile cache can neither list more than MAX_ITEMS nor show a count that is not a number.
  const stored = JSON.stringify({
    at: NOW,
    lists: { 'in progress': Array.from({ length: 80 }, (_, i) => item(i + 1)) },
    more: { 'in progress': '<img src=x>' },
  })
  const cached = readCache(memoryStorage({ [CACHE_KEY]: stored }), NOW)
  assert.equal(cached.lists['in progress'].length, MAX_ITEMS)
  assert.equal(cached.more['in progress'], 0)
})

test('counts as "more" only what is not shown and could be found on GitHub, not what was rejected', async () => {
  // The fixture has 3 results, one with a javascript: link: 2 are listed, nothing is hidden or "more".
  const found = searchResult(await fixture('in-progress'))
  assert.equal(found.items.length, 2)
  assert.equal(found.more, 0)
  assert.ok(!renderItems(found.items, found.more).includes('more'))
  // 5 matches, 3 returned (one rejected): 2 were not returned, so "and 2 more".
  const some = await fixture('in-progress')
  assert.equal(searchResult({ ...some, total_count: 5 }).more, 2)
  // The API's own limit: never more than 1000.
  assert.equal(searchResult({ ...some, total_count: 50_000 }).more, 997)
  assert.equal(countOf(50_000), 1000)
  assert.equal(countOf(-1), 0)
})

test('does not say "Nothing here" when entries exist that are not listed', () => {
  assert.match(renderItems([], 4), /and 4 more/u)
  assert.ok(!renderItems([], 4).includes('Nothing here'))
  assert.ok(!renderItems([{ ...item(1), url: 'javascript:alert(1)' }], 2).includes('Nothing here'))
  assert.match(renderItems([], 0), /Nothing here/u)
})

test('a partial search result is a PartialResultError, not a message to match on', () => {
  assert.throws(() => searchResult({ incomplete_results: true, total_count: 1, items: [] }), PartialResultError)
  assert.throws(() => searchResult({ incomplete_results: true, total_count: 1, items: [] }), { name: 'PartialResultError' })
})

test('keeps how many more there are in the cache, and shows it on the page', async () => {
  const storage = memoryStorage()
  const fixtures = await allFixtures()
  fixtures['in review'] = { ...fixtures['in review'], total_count: 40 }
  const result = await refresh({ fetchImpl: searchFetch(fixtures), storage, now: NOW })
  assert.equal(result.more['in review'], 39)
  assert.equal(readCache(storage, NOW).more['in review'], 39)
  const page = harness({ fetchImpl: searchFetch(fixtures), storage: null })
  await page.settle()
  assert.match(page.document.lists[1].innerHTML, /and 39 more/u)
})

test('a cache from the future is treated as just fetched', () => {
  const stored = JSON.stringify({ at: NOW + 3_600_000, lists: {} })
  assert.equal(readCache(memoryStorage({ [CACHE_KEY]: stored }), NOW).at, NOW)
})

test('works without storage: missing, throwing on read, throwing on write, or throwing even to be asked for', async () => {
  const throwing = {
    getItem() {
      throw new Error('SecurityError')
    },
    setItem() {
      throw new Error('QuotaExceededError')
    },
  }
  assert.equal(readCache(throwing, NOW), null)
  assert.equal(readCache(null, NOW), null)
  assert.equal(writeCache(throwing, {}, NOW), false)
  assert.equal(writeCache(null, {}, NOW), false)
  assert.equal(storageOf({ get localStorage() {
    throw new Error('SecurityError')
  } }), null)
  assert.equal(storageOf({}), null)
  const result = await refresh({ fetchImpl: searchFetch(await allFixtures()), storage: throwing, now: NOW })
  assert.equal(result.notice, null)
  assert.equal(result.lists['in progress'].length, 2)
})

test('says how long ago the lists were updated', () => {
  assert.equal(updatedText(NOW - 12_000, NOW), 'updated 12 s ago')
  assert.equal(updatedText(NOW - 150_000, NOW), 'updated 2 min ago')
  assert.equal(updatedText(NOW + 5000, NOW), 'updated 0 s ago')
  assert.equal(updatedText(null, NOW), '')
})

/** The few things of the DOM the script uses. */
function fakeDocument() {
  const lists = LISTS.map(({ label }) => ({
    label,
    innerHTML: `snapshot of ${label}`,
    getAttribute: () => label,
  }))
  const updated = { textContent: 'snapshot note' }
  const notice = { textContent: '', hidden: true }
  return {
    lists,
    updated,
    notice,
    querySelectorAll: () => lists,
    getElementById: id => ({ 'work-updated': updated, 'work-notice': notice })[id] ?? null,
  }
}

/** Drives `start` with a clock and timers the test controls. */
function harness({ fetchImpl, storage, at = NOW }) {
  const clock = { now: at }
  const timers = []
  const document = fakeDocument()
  start({ document, fetchImpl, storage, now: () => clock.now, setTimer: (fn, ms) => timers.push({ fn, ms }) })
  return { document, clock, timers, settle: () => new Promise(done => setImmediate(done)) }
}

test('shows the cache at once, and fetches in the background when it is older than the TTL', async () => {
  const storage = memoryStorage()
  writeCache(storage, { 'in progress': [item(1)], 'in review': [], 'testing': [] }, NOW - 2 * TTL_MS)
  const fetchImpl = searchFetch(await allFixtures())
  const page = harness({ fetchImpl, storage })
  // Before any answer: the cached list is drawn, the stale-but-better data replaces the snapshot.
  assert.match(page.document.lists[0].innerHTML, /#1<\/a> Issue 1/u)
  assert.match(page.document.updated.textContent, /updated 120 s ago|updated 2 min ago/u)
  await page.settle()
  assert.equal(fetchImpl.calls, 3)
  assert.match(page.document.lists[0].innerHTML, /#52<\/a> A Vue 3 template/u)
  assert.equal(page.document.notice.hidden, true)
  assert.equal(readCache(storage, NOW).at, NOW)
})

test('does not fetch while the cache is younger than the TTL', async () => {
  const storage = memoryStorage()
  writeCache(storage, { 'in progress': [item(1)], 'in review': [item(2)], 'testing': [] }, NOW - 10_000)
  const fetchImpl = searchFetch(await allFixtures())
  const page = harness({ fetchImpl, storage })
  await page.settle()
  assert.equal(fetchImpl.calls, 0)
  assert.match(page.document.lists[1].innerHTML, /#2<\/a> Issue 2/u)
  assert.equal(page.document.updated.textContent, 'updated 10 s ago')
})

test('refreshes every minute, takes what another tab cached, and uses 3 searches a minute at most', async () => {
  const storage = memoryStorage()
  const fetchImpl = searchFetch(await allFixtures())
  const page = harness({ fetchImpl, storage })
  await page.settle()
  assert.equal(fetchImpl.calls, 3)
  assert.equal(page.timers[0].ms, REFRESH_MS)

  // 30 s later nothing is fetched; the cache is fresh.
  page.clock.now = NOW + 30_000
  page.timers[0].fn()
  await page.settle()
  assert.equal(fetchImpl.calls, 3)

  // Another tab fetched meanwhile: its result is shown, and nothing is fetched here.
  writeCache(storage, { 'in progress': [item(9)], 'in review': [], 'testing': [] }, NOW + 50_000)
  page.clock.now = NOW + 61_000
  page.timers[0].fn()
  await page.settle()
  assert.equal(fetchImpl.calls, 3)
  assert.match(page.document.lists[0].innerHTML, /#9<\/a>/u)

  // Once it is old, the page fetches again.
  page.clock.now = NOW + 130_000
  page.timers[0].fn()
  await page.settle()
  assert.equal(fetchImpl.calls, 6)
})

test('keeps the snapshot and shows a notice when the first fetch fails; keeps the last result when a later one does', async () => {
  const limited = [403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' }]
  const fetchImpl = searchFetch(await allFixtures(), { 'in progress': limited, 'in review': limited, 'testing': limited })
  const page = harness({ fetchImpl, storage: null })
  await page.settle()
  assert.equal(page.document.lists[0].innerHTML, 'snapshot of in progress')
  assert.equal(page.document.updated.textContent, 'snapshot note')
  assert.equal(page.document.notice.hidden, false)
  assert.match(page.document.notice.textContent, /search limit/u)

  // The limit lifts: the lists appear and the notice goes away.
  const good = searchFetch(await allFixtures())
  const later = harness({ fetchImpl: good, storage: null })
  await later.settle()
  later.clock.now = NOW + 2 * TTL_MS
  const failing = async () => {
    throw new TypeError('Failed to fetch')
  }
  const again = harness({ fetchImpl: failing, storage: memoryStorage() })
  await again.settle()
  assert.match(again.document.notice.textContent, /could not be reached/u)
  assert.equal(again.document.lists[2].innerHTML, 'snapshot of testing')
  assert.match(later.document.lists[0].innerHTML, /#52/u)
  assert.equal(later.document.notice.hidden, true)
})

test('the script has no token, no eval and no way to write HTML except through escaping', async () => {
  const script = await readFile(join(HERE, '..', 'site', 'app.js'), 'utf8')
  assert.ok(!/authorization|bearer|\bghp_|github_pat_|GITHUB_TOKEN/iu.test(script))
  assert.ok(!/\beval\s*\(|new Function|document\.write|insertAdjacentHTML|outerHTML/u.test(script))
  // innerHTML is assigned in one place, from renderItems.
  assert.equal(script.match(/\.innerHTML\s*=/gu).length, 1)
  assert.match(script, /el\.innerHTML = renderItems\(/u)
})
