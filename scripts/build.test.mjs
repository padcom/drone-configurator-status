// node --test scripts/
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { searchResult } from '../site/app.js'
import { build, collect, escapeHtml, fixtureSource, githubClient, reduceChecks, render, safeUrl, summarize } from './build.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')
const NOW = new Date('2026-11-09T12:00:00Z')

async function fixtureSummary() {
  const data = await collect(fixtureSource(FIXTURES), { minIssues: 1 })
  return summarize(data.issues, data.pulls, data.checks, NOW)
}

const exists = path => stat(path).then(() => true, () => false)

/** A fetch that answers from a script of [status, body, headers] and counts its calls. */
function scriptedFetch(script) {
  const fetchImpl = async () => {
    const [status, body, headers = {}] = script[Math.min(fetchImpl.calls, script.length - 1)]
    fetchImpl.calls += 1
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: name => headers[name] ?? null },
      json: async () => {
        if (body === undefined) {
          throw new SyntaxError('not JSON')
        }
        return body
      },
    }
  }
  fetchImpl.calls = 0
  return fetchImpl
}

const noPause = async () => {}

test('counts the issues, leaving out pull requests, not-planned and duplicate issues and the hardware area', async () => {
  const s = await fixtureSummary()
  // 16 entries: one is a pull request, one is closed as not planned, one as a duplicate, two are in the hardware area.
  assert.deepEqual(s.overall, { open: 7, closed: 4, total: 11, percent: 36 })
  assert.deepEqual(s.left, { notPlanned: 1, duplicate: 1, hidden: 2 })
})

test('leaves an issue closed as a duplicate out of the total and out of its area, like one closed as not planned', () => {
  const issue = (number, state, state_reason, area = 'link') => ({ number, state, state_reason, labels: [{ name: `area: ${area}` }] })
  const s = summarize(
    [issue(1, 'closed', 'completed'), issue(2, 'open', null), issue(3, 'closed', 'duplicate'), issue(4, 'closed', 'not_planned')],
    { open: [], closed: [] },
    {},
    NOW,
  )
  assert.deepEqual(s.overall, { open: 1, closed: 1, total: 2, percent: 50 })
  assert.deepEqual(s.areas.map(a => [a.name, a.open, a.closed]), [['link', 1, 1]])
  assert.deepEqual(s.left, { notPlanned: 1, duplicate: 1, hidden: 0 })
  // An open issue is never "closed as a duplicate"; only a closed one is.
  assert.equal(summarize([issue(5, 'open', 'duplicate')], { open: [], closed: [] }, {}, NOW).overall.total, 1)
})

test('rounds the percentage, but shows 100% only when everything is closed', () => {
  const issues = (closed, open) => [
    ...Array.from({ length: closed }, (_, i) => ({ number: i + 1, state: 'closed', state_reason: 'completed', labels: [] })),
    ...Array.from({ length: open }, (_, i) => ({ number: closed + i + 1, state: 'open', state_reason: null, labels: [] })),
  ]
  const percentOf = (closed, open) => summarize(issues(closed, open), { open: [], closed: [] }, {}, NOW).overall.percent
  assert.equal(percentOf(264, 1), 99)
  assert.equal(percentOf(199, 1), 99)
  assert.equal(percentOf(265, 0), 100)
  assert.equal(percentOf(2, 1), 67)
  assert.equal(percentOf(0, 0), 0)
})

test('lists the areas in the set order, new areas after, issues with no area last', async () => {
  const s = await fixtureSummary()
  assert.deepEqual(
    s.areas.map(a => [a.name, a.open, a.closed, a.percent]),
    [
      ['foundation', 1, 2, 67],
      ['link', 2, 1, 33],
      ['planner', 2, 0, 0],
      ['zebra', 1, 0, 0],
      ['(no area)', 1, 1, 50],
    ],
  )
})

test('counts the open issues that need hardware, per area', async () => {
  const s = await fixtureSummary()
  const by = Object.fromEntries(s.areas.map(a => [a.name, a]))
  assert.equal(by.link.needsHardwareVerification, 1)
  assert.equal(by.link.needsHardware, 0)
  assert.equal(by.planner.needsHardware, 1)
  assert.equal(by.foundation.needsHardware + by.foundation.needsHardwareVerification, 0)
})

test('has a percentage of 0, not NaN, when there is nothing to count', () => {
  const s = summarize([], { open: [], closed: [] }, {}, NOW)
  assert.deepEqual(s.overall, { open: 0, closed: 0, total: 0, percent: 0 })
  assert.deepEqual(s.areas, [])
})

test('describes the open pull requests: draft, age and checks', async () => {
  const s = await fixtureSummary()
  assert.deepEqual(
    s.pulls.map(p => [p.number, p.draft, p.age, p.ci, p.author]),
    [
      [101, false, '24 h', 'success', 'dev'],
      [102, true, '3 d', 'failure', 'dev'],
      [103, false, '30 min', 'pending', 'other'],
      [104, false, '1 min', 'none', 'other'],
      [105, false, '3 h', 'success', 'dev'],
    ],
  )
})

test('lists the merged pull requests, newest first, at most 20, not the ones closed unmerged', async () => {
  const s = await fixtureSummary()
  assert.deepEqual(s.merges.map(m => m.number), [92, 90, 93])
  const many = Array.from({ length: 30 }, (_, i) => ({ number: i, title: `PR ${i}`, merged_at: new Date(Date.UTC(2026, 9, 1 + (i % 28))).toISOString(), html_url: '' }))
  assert.equal(summarize([], { open: [], closed: many }, {}, NOW).merges.length, 20)
})

test('adds up checks: any failure fails, anything unfinished is pending, else success, none without checks', () => {
  const run = (status, conclusion = null) => ({ status, conclusion })
  assert.equal(reduceChecks({ check_runs: [run('completed', 'success'), run('completed', 'neutral'), run('completed', 'skipped')] }), 'success')
  assert.equal(reduceChecks({ check_runs: [run('completed', 'success'), run('completed', 'failure')] }), 'failure')
  assert.equal(reduceChecks({ check_runs: [run('completed', 'cancelled')] }), 'failure')
  assert.equal(reduceChecks({ check_runs: [run('completed', 'timed_out'), run('in_progress')] }), 'failure')
  assert.equal(reduceChecks({ check_runs: [run('completed', 'success'), run('queued')] }), 'pending')
  assert.equal(reduceChecks({ check_runs: [] }), 'none')
  assert.equal(reduceChecks(null), 'none')
  // No check runs: the commit status decides, if it has any.
  assert.equal(reduceChecks({ check_runs: [] }, { state: 'success', total_count: 1 }), 'success')
  assert.equal(reduceChecks({ check_runs: [] }, { state: 'failure', total_count: 1 }), 'failure')
  assert.equal(reduceChecks({ check_runs: [] }, { state: 'pending', total_count: 1 }), 'pending')
  assert.equal(reduceChecks({ check_runs: [] }, { state: 'pending', total_count: 0 }), 'none')
})

test('escapes HTML, and takes links only to github.com', () => {
  assert.equal(escapeHtml(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  assert.equal(safeUrl('https://github.com/padcom/drone-configurator/pull/1'), 'https://github.com/padcom/drone-configurator/pull/1')
  assert.equal(safeUrl('javascript:alert(1)'), null)
  assert.equal(safeUrl('https://evil.example/github.com/'), null)
  assert.equal(safeUrl('http://github.com/x'), null)
  assert.equal(safeUrl('https://github.com/"onmouseover="x'), null)
})

test('renders the page with the numbers, and nothing from GitHub unescaped', async () => {
  const template = await readFile(join(HERE, '..', 'site', 'index.html'), 'utf8')
  const s = await fixtureSummary()
  // A pull request title is as untrusted as an issue's.
  s.pulls[0].title = '<img src=x onerror=alert(1)>'
  const html = render(s, template, { commit: 'abcdef1234567' })
  assert.match(html, /4 of 11 issues closed, 7 open/u)
  assert.match(html, /<p class="big">36%<\/p>/u)
  assert.match(html, /commit abcdef1\./u)
  assert.match(html, /Generated at 2026-11-09 12:00:00 UTC/u)
  assert.match(html, /1 issue closed as not planned, 1 closed as duplicate, 2 in the hardware area/u)
  assert.ok(!html.includes('<img src=x'))
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.ok(!/\{\{/u.test(html))
  // The link from the fixture that is not on github.com is plain text, not a link.
  assert.ok(!html.includes('javascript:'))
  assert.match(html, /href="https:\/\/github\.com\/padcom\/drone-configurator\/pull\/101"/u)
})

test('escapes an issue title that is a script tag', async () => {
  // Issue 15 is `<script>alert(1)</script>`; titles are not shown for issues, but the template must not
  // let anything through if they ever are, so check the whole page for a script tag.
  const template = await readFile(join(HERE, '..', 'site', 'index.html'), 'utf8')
  const s = await fixtureSummary()
  s.merges[0].title = '<script>alert(1)</script>'
  const html = render(s, template)
  // The page has one script, the external app.js; no other.
  assert.ok(!/<script/iu.test(html.replace('<script type="module" src="app.js"></script>', '')))
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
})

test('refuses a template with a placeholder it has no value for', async () => {
  const s = await fixtureSummary()
  assert.throws(() => render(s, '<p>{{nothing_like_this}}</p>'), /nothing_like_this/u)
})

test('the page has a snapshot of the lists of work in flight, for readers without JavaScript', async () => {
  const template = await readFile(join(HERE, '..', 'site', 'index.html'), 'utf8')
  const data = await collect(fixtureSource(FIXTURES), { minIssues: 1 })
  const html = render(summarize(data.issues, data.pulls, data.checks, NOW, data.work), template)
  const section = label => new RegExp(`data-work-label="${label}">(.*?)</div>`, 'su').exec(html)[1]
  // Each entry: repository, number as a link, title.
  assert.match(section('in progress'), /<span class="repo">padcom\/pico-desktop<\/span> <a href="https:\/\/github\.com\/padcom\/pico-desktop\/issues\/52">#52<\/a> A Vue 3 template/u)
  assert.match(section('in review'), /padcom\/pico-mavlink.*#11<\/a> Rate manager/su)
  assert.match(section('testing'), /Nothing here\./u)
  // Hostile data is text: the title is escaped and the entry with a javascript: link is dropped.
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.ok(!html.includes('<img src=x'))
  assert.ok(!html.includes('javascript:'))
  assert.ok(!html.includes('A link that must not be followed'))
})

test('the page loads one script from its own origin, has no inline script, and allows only api.github.com to connect to', async () => {
  const out = join(await mkdtemp(join(tmpdir(), 'status-')), 'dist')
  await build({ source: fixtureSource(FIXTURES), out, minIssues: 1, now: NOW, commit: 'abcdef1234' })
  const html = await readFile(join(out, 'index.html'), 'utf8')
  assert.deepEqual([...html.matchAll(/<script([^>]*)>/gu)].map(m => m[1].trim()), ['type="module" src="app.js"'])
  assert.ok(!/<script[^>]*>[^<]/u.test(html))
  // No event handler or style attribute on any tag (escaped text such as `onerror=` in a title is not a tag).
  assert.ok(!/<[a-z][^>]*\s(on[a-z]+|style)\s*=/iu.test(html))
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/u.exec(html)[1]
  assert.match(csp, /(^|; )script-src 'self'(;|$)/u)
  assert.match(csp, /(^|; )connect-src https:\/\/api\.github\.com(;|$)/u)
  assert.match(csp, /(^|; )default-src 'none'(;|$)/u)
  assert.ok(!csp.includes('unsafe'))
  // The script is deployed with the page, and holds no token.
  const script = await readFile(join(out, 'app.js'), 'utf8')
  assert.ok(script.length > 0)
  assert.ok(!/authorization|bearer|ghp_|github_pat_/iu.test(script))
})

test('writes the page, its style and the numbers', async () => {
  const out = join(await mkdtemp(join(tmpdir(), 'status-')), 'dist')
  await build({ source: fixtureSource(FIXTURES), out, minIssues: 1, now: NOW, commit: 'abcdef1234' })
  const html = await readFile(join(out, 'index.html'), 'utf8')
  assert.match(html, /4 of 11 issues closed/u)
  assert.match(await readFile(join(out, 'style.css'), 'utf8'), /progress/u)
  const data = JSON.parse(await readFile(join(out, 'data.json'), 'utf8'))
  assert.equal(data.overall.total, 11)
})

test('writes nothing when a fetch fails, and the failure says why', async () => {
  const out = join(await mkdtemp(join(tmpdir(), 'status-')), 'dist')
  const source = githubClient({ fetchImpl: scriptedFetch([[500, {}]]), pause: noPause })
  await assert.rejects(build({ source, out, now: NOW }), /failed: 500/u)
  assert.equal(await exists(out), false)
})

test('writes nothing when the issues look incomplete', async () => {
  const out = join(await mkdtemp(join(tmpdir(), 'status-')), 'dist')
  const few = Array.from({ length: 3 }, (_, i) => ({ number: i + 1, title: 'x', state: 'open', labels: [] }))
  const source = githubClient({ fetchImpl: scriptedFetch([[200, few]]), pause: noPause })
  await assert.rejects(build({ source, out, now: NOW }), /fewer than 100/u)
  assert.equal(await exists(out), false)
})

test('writes nothing when a response is not JSON', async () => {
  const out = join(await mkdtemp(join(tmpdir(), 'status-')), 'dist')
  const source = githubClient({ fetchImpl: scriptedFetch([[200, undefined]]), pause: noPause })
  await assert.rejects(build({ source, out, now: NOW }), /did not return JSON/u)
  assert.equal(await exists(out), false)
})

test('tries once more after a server error, or a 403 that says to retry, and no more', async () => {
  const waits = []
  const pause = async ms => waits.push(ms)
  const again = scriptedFetch([[502, {}], [200, [{ number: 1 }]]])
  assert.equal((await githubClient({ fetchImpl: again, pause }).openPulls()).length, 1)
  assert.deepEqual(waits, [5000])
  assert.equal(again.calls, 2)

  const limited = scriptedFetch([[403, {}, { 'retry-after': '30' }], [200, []]])
  await githubClient({ fetchImpl: limited, pause }).openPulls()
  assert.equal(limited.calls, 2)

  const stays = scriptedFetch([[500, {}]])
  await assert.rejects(githubClient({ fetchImpl: stays, pause }).openPulls(), /500/u)
  assert.equal(stays.calls, 2)

  // A 404, or a 403 with nothing to wait for, is not retried.
  const missing = scriptedFetch([[404, {}]])
  await assert.rejects(githubClient({ fetchImpl: missing, pause }).openPulls(), /404/u)
  assert.equal(missing.calls, 1)
})

test('tries once more after a network error or a timeout, and gives every request a timeout', async () => {
  const waits = []
  const pause = async ms => waits.push(ms)
  let calls = 0
  const signals = []
  const flaky = async (url, init) => {
    signals.push(init.signal instanceof AbortSignal)
    calls += 1
    if (calls === 1) {
      throw new TypeError('fetch failed')
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => [] }
  }
  await githubClient({ fetchImpl: flaky, pause }).openPulls()
  assert.equal(calls, 2)
  assert.deepEqual(waits, [5000])
  assert.deepEqual(signals, [true, true])

  const down = async () => {
    throw new TypeError('fetch failed')
  }
  await assert.rejects(githubClient({ fetchImpl: down, pause }).openPulls(), /fetch failed/u)
})

test('lists an issue once even if a page shifted while the pages were read', async () => {
  const hundred = from => Array.from({ length: 100 }, (_, i) => ({ number: from + i }))
  // Page 2 starts with #100 again: an issue was created between the two requests.
  const fetchImpl = scriptedFetch([[200, hundred(1)], [200, hundred(100).slice(0, 5)]])
  const issues = await githubClient({ fetchImpl, pause: noPause }).issues()
  assert.equal(issues.length, 104)
  assert.equal(new Set(issues.map(i => i.number)).size, 104)
})

test('searches for the issues in flight with the labels and the repositories, and keeps what the page shows', async () => {
  const urls = []
  const fetchImpl = async url => {
    urls.push(decodeURIComponent(url))
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => JSON.parse(await readFile(join(FIXTURES, 'search-in-review.json'), 'utf8')) }
  }
  const { items, more } = await githubClient({ fetchImpl }).labelled('in review')
  assert.deepEqual(items, [{ repo: 'padcom/pico-mavlink', number: 11, title: 'Rate manager', url: 'https://github.com/padcom/pico-mavlink/issues/11' }])
  assert.equal(more, 0)
  assert.match(urls[0], /^https:\/\/api\.github\.com\/search\/issues\?q=repo:padcom\/pico-lang repo:padcom\/pico-desktop repo:padcom\/pico-serialport repo:padcom\/pico-mavlink repo:padcom\/drone-configurator is:issue is:open label:"in review"&/u)
})

/** The responses of a build whose issues, pull requests and searches come one after the other (searches last). */
const buildScript = (...searches) => {
  const few = Array.from({ length: 3 }, (_, i) => ({ number: i + 1, title: 'x', state: 'open', labels: [] }))

  return scriptedFetch([[200, few], [200, []], [200, []], ...searches])
}
const emptySearch = [200, { total_count: 0, incomplete_results: false, items: [] }]

test('writes nothing, and keeps the last page, when the issues come but a search fails', async () => {
  for (const failure of [[403, {}], [500, {}], [200, undefined]]) {
    const out = join(await mkdtemp(join(tmpdir(), 'status-')), 'dist')
    // The failure is given twice: a 5xx is tried once more.
    const fetchImpl = buildScript(emptySearch, failure, failure, emptySearch)
    const source = githubClient({ fetchImpl, pause: noPause })
    await assert.rejects(build({ source, out, minIssues: 1, now: NOW }), /search\/issues|JSON/u)
    assert.equal(await exists(out), false, `status ${failure[0]}`)
  }
})

test('treats a partial search result as a failed search, after trying once more', async () => {
  const partial = [200, { total_count: 4, incomplete_results: true, items: [] }]
  const waits = []
  const pause = async ms => waits.push(ms)

  // Partial twice: the build fails and writes nothing.
  const out = join(await mkdtemp(join(tmpdir(), 'status-')), 'dist')
  const fetchImpl = buildScript(partial, partial)
  await assert.rejects(build({ source: githubClient({ fetchImpl, pause }), out, minIssues: 1, now: NOW }), /partial/u)
  assert.deepEqual(waits, [5000])
  assert.equal(fetchImpl.calls, 5)
  assert.equal(await exists(out), false)

  // Partial once, then whole: the whole one is used.
  const whole = [200, { total_count: 0, incomplete_results: false, items: [] }]
  const again = githubClient({ fetchImpl: scriptedFetch([partial, whole]), pause })
  assert.deepEqual(await again.labelled('in progress'), { items: [], more: 0 })
})

test('a partial result in the fixtures fails the build too', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'status-fixtures-'))
  await writeFile(join(dir, 'search-testing.json'), JSON.stringify({ total_count: 1, incomplete_results: true, items: [] }))
  await assert.rejects(fixtureSource(dir).labelled('testing'), /partial/u)
})

test('the snapshot says "and N more" when a list is longer than what is shown', async () => {
  const data = await collect(fixtureSource(FIXTURES), { minIssues: 1 })
  const html = render(summarize(data.issues, data.pulls, data.checks, NOW, data.work, { 'in review': 7 }), await readFile(join(HERE, '..', 'site', 'index.html'), 'utf8'))
  assert.match(html, /data-work-label="in review">.*<p class="more">and 7 more<\/p>/su)
  assert.ok(!/and \d+ more/u.test(/data-work-label="testing">(.*?)<\/div>/su.exec(html)[1]))
})

test('the offline build shows 50 of 80 returned entries and "and 30 more"; a rejected entry is not "more"', async () => {
  const entry = n => ({
    number: n,
    title: `Issue ${n}`,
    html_url: `https://github.com/padcom/pico-lang/issues/${n}`,
    repository_url: 'https://api.github.com/repos/padcom/pico-lang',
  })
  const eighty = { total_count: 80, incomplete_results: false, items: Array.from({ length: 80 }, (_, i) => entry(i + 1)) }
  const base = fixtureSource(FIXTURES)
  const source = { ...base, labelled: async label => label === 'testing' ? searchResult(eighty) : base.labelled(label) }
  const out = join(await mkdtemp(join(tmpdir(), 'status-')), 'dist')
  await build({ source, out, minIssues: 1, now: NOW })

  const html = await readFile(join(out, 'index.html'), 'utf8')
  const section = label => new RegExp(`data-work-label="${label}">(.*?)</div>`, 'su').exec(html)[1]
  assert.equal(section('testing').match(/<li>/gu).length, 50)
  assert.match(section('testing'), /<p class="more">and 30 more<\/p>/u)
  // The in-progress fixture returns 3 entries, one with a javascript: link: 2 listed, and no "more".
  assert.equal(section('in progress').match(/<li>/gu).length, 2)
  assert.ok(!section('in progress').includes('more'))
  assert.equal(JSON.parse(await readFile(join(out, 'data.json'), 'utf8')).workMore.testing, 30)
})

test('reads every page of issues, until a short one', async () => {
  const page = (n, from) => Array.from({ length: n }, (_, i) => ({ number: from + i }))
  const fetchImpl = scriptedFetch([[200, page(100, 1)], [200, page(100, 101)], [200, page(5, 201)]])
  const issues = await githubClient({ fetchImpl, pause: noPause }).issues()
  assert.equal(issues.length, 205)
  assert.equal(fetchImpl.calls, 3)
})

test('sends the token, and nothing when there is none', async () => {
  const seen = []
  const spy = async (url, init) => {
    seen.push(init.headers.authorization ?? null)
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => [] }
  }
  await githubClient({ token: 'secret', fetchImpl: spy }).openPulls()
  await githubClient({ fetchImpl: spy }).openPulls()
  assert.deepEqual(seen, ['Bearer secret', null])
})

test('the command line: offline it writes the page; with a failure it exits 1 and writes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'status-'))
  const script = join(HERE, 'build.mjs')
  const ok = spawnSync(process.execPath, [script, '--fixtures', FIXTURES, '--out', join(dir, 'ok')], { encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.equal(await exists(join(dir, 'ok', 'index.html')), true)

  const bad = spawnSync(process.execPath, [script, '--fixtures', join(dir, 'no-such-fixtures'), '--out', join(dir, 'bad')], { encoding: 'utf8' })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /status page not built/u)
  assert.equal(await exists(join(dir, 'bad')), false)
})
