// node --test scripts/
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
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

test('counts the issues, leaving out pull requests, not-planned issues and the hardware area', async () => {
  const s = await fixtureSummary()
  // 15 entries: one is a pull request, one is closed as not planned, two are in the hardware area.
  assert.deepEqual(s.overall, { open: 7, closed: 4, total: 11, percent: 36 })
  assert.deepEqual(s.left, { notPlanned: 1, hidden: 2 })
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
  assert.match(html, /1 issue closed as not planned, 2 in the hardware area/u)
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
  assert.ok(!/<script/iu.test(html))
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
})

test('refuses a template with a placeholder it has no value for', async () => {
  const s = await fixtureSummary()
  assert.throws(() => render(s, '<p>{{nothing_like_this}}</p>'), /nothing_like_this/u)
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

test('reads every page of issues, until a short one', async () => {
  const page = n => Array.from({ length: n }, (_, i) => ({ number: i }))
  const fetchImpl = scriptedFetch([[200, page(100)], [200, page(100)], [200, page(5)]])
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
