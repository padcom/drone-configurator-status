// Builds the status page of padcom/drone-configurator from its public REST data.
//
//   node scripts/build.mjs                       real data (GITHUB_TOKEN raises the rate limit)
//   node scripts/build.mjs --fixtures DIR        no network: the data from DIR (see scripts/fixtures)
//   node scripts/build.mjs --out DIR             where to write (default: dist)
//
// Node >= 22, built-ins only. The page is written only when everything was fetched and rendered: a failed
// fetch exits non-zero before anything is written, so the deploy step is skipped and the last good page stays up.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LISTS, REPOS, escapeHtml, itemsOf, renderItems, safeUrl, searchPath } from '../site/app.js'

// The escaping and the lists are the page script's own (site/app.js), so the snapshot in the HTML and what the script
// draws later are made by the same code.
export { escapeHtml, safeUrl }

/** How long a request to GitHub may take before it is given up on. */
export const REQUEST_TIMEOUT_MS = 30_000

const API = 'https://api.github.com'
const REPO = 'padcom/drone-configurator'
const STATUS_REPO = 'padcom/drone-configurator-status'

/** Fewer issues than this means the fetch was incomplete (the repo has far more): a failed fetch, not a page. */
export const MIN_ISSUES = 100

/** The order the areas are shown in; other areas come after, alphabetically, then issues with no area. */
export const AREA_ORDER = [
  'foundation',
  'link',
  'params',
  'flight-data',
  'planner',
  'setup',
  'hardware-setup',
  'tuning',
  'vehicles',
  'logs',
  'simulation',
  'scripting',
  'localization',
  'video',
]

/** Issues with this area label are left out of the progress altogether: they cannot move without hardware. */
export const HIDDEN_AREAS = ['hardware']

export const NO_AREA = '(no area)'

const HERE = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------------------------------------
// Pure functions: data in, data or HTML out.
// ---------------------------------------------------------------------------------------------------------

/** Markup that is already safe: the only kind `render` inserts without escaping. */
export class Raw {
  constructor(html) {
    this.html = html
  }
}

/** Rounded, but never 100 until everything is closed (264 of 265 is 99%, not 100%). */
function percent(closed, total) {
  if (total === 0) {
    return 0
  }
  return closed === total ? 100 : Math.min(99, Math.round((100 * closed) / total))
}

function labelNames(issue) {
  return (issue.labels ?? []).map(l => (typeof l === 'string' ? l : l.name)).filter(Boolean)
}

function areasOf(issue) {
  const areas = labelNames(issue)
    .filter(n => n.startsWith('area: '))
    .map(n => n.slice('area: '.length).trim())
  return areas.length > 0 ? areas : [NO_AREA]
}

function areaRank(name) {
  if (name === NO_AREA) {
    return AREA_ORDER.length + 1
  }
  const at = AREA_ORDER.indexOf(name)
  return at === -1 ? AREA_ORDER.length : at
}

/**
 * What a pull request's checks add up to.
 *
 * @param checkRuns the response of `/commits/{sha}/check-runs`, or null
 * @param status the response of `/commits/{sha}/status`, or null (looked at only when there are no check runs)
 * @returns `'failure'`, `'pending'`, `'success'` or `'none'`
 */
export function reduceChecks(checkRuns, status = null) {
  const runs = checkRuns?.check_runs ?? []
  if (runs.length > 0) {
    if (runs.some(r => r.status === 'completed' && ['failure', 'cancelled', 'timed_out', 'startup_failure'].includes(r.conclusion))) {
      return 'failure'
    }
    if (runs.some(r => r.status !== 'completed')) {
      return 'pending'
    }
    return runs.every(r => ['success', 'neutral', 'skipped'].includes(r.conclusion)) ? 'success' : 'failure'
  }
  if (status && (status.total_count ?? status.statuses?.length ?? 0) > 0) {
    if (status.state === 'success') {
      return 'success'
    }
    return status.state === 'pending' ? 'pending' : 'failure'
  }
  return 'none'
}

function ageText(from, now) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(from)) / 60_000))
  if (minutes < 60) {
    return `${minutes} min`
  }
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d`
}

/**
 * The numbers on the page.
 *
 * @param issues every issue as the REST API lists them, pull requests included (they are dropped here)
 * @param pulls `{ open, closed }`: the open pull requests and the recently closed ones
 * @param checks `{ [sha]: { checkRuns, status } }` for the open pull requests
 * @param now the time the page is made, as a Date
 * @param work `{ [label]: entries }`: the snapshot of the lists of work in flight (see `LISTS`)
 */
export function summarize(issues, pulls, checks, now, work = {}) {
  const real = issues.filter(i => !i.pull_request)
  const counted = []
  let notPlanned = 0
  let duplicate = 0
  let hidden = 0
  for (const issue of real) {
    if (issue.state === 'closed' && issue.state_reason === 'not_planned') {
      notPlanned += 1
    } else if (issue.state === 'closed' && issue.state_reason === 'duplicate') {
      duplicate += 1
    } else if (areasOf(issue).some(a => HIDDEN_AREAS.includes(a))) {
      hidden += 1
    } else {
      counted.push(issue)
    }
  }

  const byArea = new Map()
  for (const issue of counted) {
    for (const area of areasOf(issue)) {
      const row = byArea.get(area) ?? { name: area, open: 0, closed: 0, needsHardware: 0, needsHardwareVerification: 0 }
      byArea.set(area, row)
      if (issue.state === 'closed') {
        row.closed += 1
      } else {
        row.open += 1
        const names = labelNames(issue)
        row.needsHardware += names.includes('needs-hardware') ? 1 : 0
        row.needsHardwareVerification += names.includes('needs-hardware-verification') ? 1 : 0
      }
    }
  }
  const areas = [...byArea.values()]
    .map(r => ({ ...r, total: r.open + r.closed, percent: percent(r.closed, r.open + r.closed) }))
    .sort((a, b) => areaRank(a.name) - areaRank(b.name) || a.name.localeCompare(b.name))

  const closed = counted.filter(i => i.state === 'closed').length
  const overall = { open: counted.length - closed, closed, total: counted.length, percent: percent(closed, counted.length) }

  const nowMs = now.getTime()
  const openPulls = pulls.open.map(p => ({
    number: p.number,
    title: p.title,
    author: p.user?.login ?? 'unknown',
    draft: Boolean(p.draft),
    age: ageText(p.created_at, nowMs),
    ci: reduceChecks(checks[p.head?.sha]?.checkRuns ?? null, checks[p.head?.sha]?.status ?? null),
    url: p.html_url,
  }))
  const merges = pulls.closed
    .filter(p => p.merged_at)
    .sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at))
    .slice(0, 20)
    .map(p => ({ number: p.number, title: p.title, mergedAt: p.merged_at.slice(0, 10), url: p.html_url }))

  const snapshot = Object.fromEntries(LISTS.map(({ label }) => [label, work[label] ?? []]))

  return { generatedAt: now.toISOString(), overall, areas, pulls: openPulls, merges, work: snapshot, left: { notPlanned, duplicate, hidden } }
}

function link(url, text) {
  const safe = safeUrl(url)
  return safe ? `<a href="${escapeHtml(safe)}">${escapeHtml(text)}</a>` : escapeHtml(text)
}

function bar(done, total) {
  return `<progress max="${Math.max(total, 1)}" value="${done}">${percent(done, total)}%</progress>`
}

function table(head, rows, empty) {
  if (rows.length === 0) {
    return `<p class="empty">${escapeHtml(empty)}</p>`
  }
  const th = head.map(h => `<th>${escapeHtml(h)}</th>`).join('')
  const tr = rows.map(cells => `<tr>${cells.map(c => `<td>${c instanceof Raw ? c.html : escapeHtml(c)}</td>`).join('')}</tr>`).join('')
  return `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`
}

/**
 * The page.
 *
 * @param summary what `summarize` returned
 * @param template the HTML with `{{placeholders}}`
 * @param meta `{ commit }`: the commit of the status repo that made the page
 * @throws Error if the template has a placeholder the page has no value for
 */
export function render(summary, template, meta = {}) {
  const o = summary.overall
  const overall = new Raw(
    `<p class="big">${o.percent}%</p>${bar(o.closed, o.total)}<p>${o.closed} of ${o.total} issues closed, ${o.open} open.</p>`,
  )
  const areas = new Raw(
    table(
      ['Area', 'Open', 'Closed', 'Progress', '%', 'Needs hardware'],
      summary.areas.map(a => [
        a.name,
        String(a.open),
        String(a.closed),
        new Raw(bar(a.closed, a.total)),
        `${a.percent}%`,
        new Raw(
          a.needsHardware + a.needsHardwareVerification === 0
            ? ''
            : `<small>${a.needsHardware} need hardware, ${a.needsHardwareVerification} need verification</small>`,
        ),
      ]),
      'No issues.',
    ),
  )
  const ciLabel = { success: 'passing', failure: 'failing', pending: 'running', none: 'no checks' }
  const pulls = new Raw(
    table(
      ['#', 'Title', 'Author', 'State', 'Age', 'CI'],
      summary.pulls.map(p => [
        new Raw(link(p.url, `#${p.number}`)),
        p.title,
        p.author,
        p.draft ? 'draft' : 'ready',
        p.age,
        new Raw(`<span class="ci ci-${escapeHtml(p.ci)}">${escapeHtml(ciLabel[p.ci] ?? p.ci)}</span>`),
      ]),
      'No open pull requests.',
    ),
  )
  const merges = new Raw(
    table(
      ['#', 'Title', 'Merged'],
      summary.merges.map(m => [new Raw(link(m.url, `#${m.number}`)), m.title, m.mergedAt]),
      'Nothing merged yet.',
    ),
  )
  const left = summary.left
  const notes = `Not counted: ${left.notPlanned} issue${left.notPlanned === 1 ? '' : 's'} closed as not planned, `
    + `${left.duplicate ?? 0} closed as duplicate, ${left.hidden} in the hardware area.`
  const commit = meta.commit ?? 'unknown'
  const work = Object.fromEntries(
    LISTS.map(({ label, placeholder }) => [placeholder, new Raw(renderItems(summary.work?.[label]))]),
  )
  const values = {
    ...work,
    work_repos: new Raw(REPOS.map(r => link(`https://github.com/${r}`, r)).join(', ')),
    work_note: `Showing the state at ${summary.generatedAt.replace('T', ' ').replace(/\.\d+Z$/u, '')} UTC until the live lists load.`,
    overall,
    areas,
    pulls,
    merges,
    notes,
    generated_at: summary.generatedAt.replace('T', ' ').replace(/\.\d+Z$/u, ''),
    commit: commit.slice(0, 7),
    repo_url: `https://github.com/${REPO}`,
    status_repo_url: `https://github.com/${STATUS_REPO}`,
  }
  return template.replace(/\{\{(\w+)\}\}/gu, (_, name) => {
    if (!(name in values)) {
      throw new Error(`the template has a placeholder {{${name}}} that the page has no value for`)
    }
    const v = values[name]
    return v instanceof Raw ? v.html : escapeHtml(v)
  })
}

// ---------------------------------------------------------------------------------------------------------
// The data: the GitHub API, or fixtures.
// ---------------------------------------------------------------------------------------------------------

const sleep = ms => new Promise(done => setTimeout(done, ms))

/**
 * A client for the REST API. Every request is given up on after `REQUEST_TIMEOUT_MS`. Retries once after 5 s on a
 * network error or timeout, a 5xx, or a 403 that says to retry later; any other non-2xx, or a body that is not JSON,
 * is an error.
 */
export function githubClient({ token, fetchImpl = fetch, pause = sleep, log = () => {} } = {}) {
  async function get(path) {
    const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'drone-configurator-status' }
    if (token) {
      headers.authorization = `Bearer ${token}`
    }
    for (let attempt = 0; ; attempt += 1) {
      let response
      try {
        response = await fetchImpl(`${API}${path}`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      } catch (error) {
        if (attempt === 0) {
          await pause(5000)
          continue
        }
        throw new Error(`GET ${path} failed: ${error.message}`)
      }
      const remaining = response.headers?.get?.('x-ratelimit-remaining')
      if (remaining !== null && remaining !== undefined) {
        log(`GET ${path}: ${response.status}, rate limit remaining ${remaining}`)
      }
      const retryable = response.status >= 500 || (response.status === 403 && response.headers?.get?.('retry-after'))
      if (retryable && attempt === 0) {
        await pause(5000)
        continue
      }
      if (!response.ok) {
        throw new Error(`GET ${path} failed: ${response.status}`)
      }
      try {
        return await response.json()
      } catch {
        throw new Error(`GET ${path} did not return JSON`)
      }
    }
  }

  return {
    async issues() {
      const all = []
      for (let page = 1; page <= 50; page += 1) {
        const items = await get(`/repos/${REPO}/issues?state=all&per_page=100&page=${page}`)
        if (!Array.isArray(items)) {
          throw new Error('the issues response is not a list')
        }
        all.push(...items)
        if (items.length < 100) {
          // Listed by creation, so an issue created while this runs can shift a page and appear twice.
          return [...new Map(all.map(i => [i.number, i])).values()]
        }
      }
      throw new Error('more than 50 pages of issues: refusing to go on')
    },
    /** The snapshot of one list of work in flight: the same search the page makes, as the page's script would. */
    async labelled(label) {
      return itemsOf(await get(searchPath(label)))
    },
    openPulls: () => get(`/repos/${REPO}/pulls?state=open&per_page=100`),
    closedPulls: () => get(`/repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=50`),
    checkRuns: sha => get(`/repos/${REPO}/commits/${sha}/check-runs?per_page=100`),
    status: sha => get(`/repos/${REPO}/commits/${sha}/status`),
  }
}

/** The same interface over a directory of JSON files (see scripts/fixtures). */
export function fixtureSource(dir) {
  const read = async name => JSON.parse(await readFile(join(dir, name), 'utf8'))
  const readSearch = async label => {
    try {
      return await read(`search-${label.replaceAll(' ', '-')}.json`)
    } catch (error) {
      // A fixture set with no file for a label has nothing in that list.
      if (error.code === 'ENOENT') {
        return { items: [] }
      }
      throw error
    }
  }
  return {
    labelled: async label => itemsOf(await readSearch(label)),
    issues: () => read('issues.json'),
    openPulls: () => read('pulls-open.json'),
    closedPulls: () => read('pulls-closed.json'),
    checkRuns: async sha => (await read('check-runs.json'))[sha] ?? { total_count: 0, check_runs: [] },
    status: async sha => (await read('status.json'))[sha] ?? { state: 'pending', total_count: 0, statuses: [] },
  }
}

/**
 * Everything the page needs. Throws if any of it could not be fetched, or looks incomplete.
 *
 * @param source `githubClient(...)` or `fixtureSource(...)`
 * @param options `minIssues`: the fewest issues that make a believable page (default `MIN_ISSUES`)
 */
export async function collect(source, { minIssues = MIN_ISSUES } = {}) {
  const issues = await source.issues()
  const realCount = issues.filter(i => !i.pull_request).length
  if (realCount < minIssues) {
    throw new Error(`only ${realCount} issues came back (fewer than ${minIssues}): treating the fetch as failed`)
  }
  const open = await source.openPulls()
  const closed = await source.closedPulls()
  if (!Array.isArray(open) || !Array.isArray(closed)) {
    throw new Error('the pull request responses are not lists')
  }
  const checks = {}
  for (const pull of open) {
    const sha = pull.head?.sha
    if (!sha) {
      continue
    }
    const checkRuns = await source.checkRuns(sha)
    const status = (checkRuns?.check_runs ?? []).length === 0 ? await source.status(sha) : null
    checks[sha] = { checkRuns, status }
  }
  const work = {}
  for (const { label } of LISTS) {
    work[label] = await source.labelled(label)
  }
  return { issues, pulls: { open, closed }, checks, work }
}

/**
 * Makes the page and writes it. Nothing is written unless all of it worked.
 *
 * @returns the summary
 */
export async function build({ source, out, minIssues, now = new Date(), commit = 'unknown' }) {
  const data = await collect(source, { minIssues })
  const summary = summarize(data.issues, data.pulls, data.checks, now, data.work)
  const template = await readFile(join(HERE, '..', 'site', 'index.html'), 'utf8')
  const style = await readFile(join(HERE, '..', 'site', 'style.css'), 'utf8')
  const script = await readFile(join(HERE, '..', 'site', 'app.js'), 'utf8')
  const html = render(summary, template, { commit })
  // Only now, with every step behind us, is anything written.
  await mkdir(out, { recursive: true })
  await writeFile(join(out, 'index.html'), html)
  await writeFile(join(out, 'style.css'), style)
  await writeFile(join(out, 'app.js'), script)
  await writeFile(join(out, 'data.json'), `${JSON.stringify(summary, null, 2)}\n`)
  return summary
}

function option(args, name) {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

async function main(args) {
  const fixtures = option(args, '--fixtures')
  const out = resolve(option(args, '--out') ?? 'dist')
  const source = fixtures
    ? fixtureSource(resolve(fixtures))
    : githubClient({ token: process.env.GITHUB_TOKEN, log: line => console.log(line) })
  const summary = await build({
    source,
    out,
    minIssues: fixtures ? 1 : MIN_ISSUES,
    commit: process.env.GITHUB_SHA ?? 'unknown',
  })
  console.log(`wrote ${out}: ${summary.overall.closed} of ${summary.overall.total} issues closed, ${summary.pulls.length} open pull requests`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`status page not built: ${error.message}`)
    process.exitCode = 1
  })
}
