# drone-configurator-status

A status page for [padcom/drone-configurator](https://github.com/padcom/drone-configurator), built from its public
issues and pull requests and published with GitHub Pages every 15 minutes.

It shows:

- overall progress: closed issues out of all, as a percentage and a bar;
- progress by area, one row per `area: *` label (issues with none are under "(no area)"), with how many open
  issues need hardware or hardware verification;
- **In progress**, **In review** and **Testing**: the open issues labelled `in progress`, `in review` or `testing` in
  pico-lang, pico-desktop, pico-serialport, pico-mavlink and drone-configurator, each with its repository, number, title
  and link (see "The live lists" below);
- the open pull requests: title, author, draft or not, age and the state of their checks;
- the last 20 merged pull requests;
- when it was made, and by which commit of this repository.

## What is counted

- Pull requests are not issues. They are shown in their own tables only.
- Issues closed as **not planned** or as a **duplicate** are left out of the progress altogether: they are neither
  work done nor work left. The page says how many of each.
- The percentage is rounded, but it shows 100% only when every counted issue is closed (264 of 265 is 99%).
- Issues in the **`area: hardware`** area are left out too: they cannot move without hardware. The page says
  how many.
- An issue with several `area:` labels is counted in each of its areas, and once in the overall figure.
- The order of the areas is the list `AREA_ORDER` in `scripts/build.mjs`; a new `area:` label shows up by itself, after
  those, alphabetically.

## How it works

`scripts/build.mjs` is one dependency-free Node script (Node 22 or later, built-ins only, `fetch` included). It reads the
public REST API of the repository (about 4 requests, plus one or two per open pull request, plus 3 searches for the
lists of work in flight), turns the answers into numbers (`summarize`), fills `site/index.html` with them (`render`,
which escapes everything that comes from GitHub) and writes `dist/index.html`, `dist/style.css`, `dist/app.js` and
`dist/data.json` (the numbers). Every request has a 30 s timeout and is tried once more after a network error. A
`<meta http-equiv="refresh">` reloads the page every 15 minutes.

### The live lists

The three lists of work in flight are in the HTML as a snapshot from the build, so the page is complete without
JavaScript. `site/app.js` (one external module script; the page has no inline script) replaces them with something
newer:

- It asks the **unauthenticated** GitHub Search API from the browser: 3 queries, one per label, with a `repo:` qualifier
  for each of the five repositories and `is:issue is:open`. It does so on load and then every 60 s. Search allows 10
  requests a minute per address, so one open page uses 3 of them. There is no token anywhere in the page.
- The result is cached in `localStorage` (key `drone-configurator-status:work:v1`), shown at once on the next load,
  and fetched again in the background when it is older than 60 s. Several tabs share it. Every access to storage is
  guarded: where it is unavailable the page works without a cache. The page says how long ago the lists were updated.
- When GitHub says the limit is reached (403 or 429), or cannot be reached, the page shows a notice and keeps the last
  result for the lists that could not be fetched.
- Everything from GitHub is escaped when it is drawn, a link is used only if it is `https://github.com/...`, and cached
  data is checked again when it is read.
- The labels (`in progress`, `in review`, `testing`) and repositories are the lists `LISTS` and `REPOS` at the top of
  `site/app.js`; a label change in an issue shows up within a minute without a rebuild.

The page's Content-Security-Policy is a `<meta>` tag in `site/index.html`: `default-src 'none'; script-src 'self';
style-src 'self'; img-src 'self'; connect-src https://api.github.com; base-uri 'none'; form-action 'none'`.

**A failed fetch never replaces the last good page.** Any request that fails (after one retry on a 5xx or a rate-limit
`403` with `retry-after`), a response that is not JSON, or fewer than 100 issues (the repository has far more, so that
is an incomplete answer) makes the script exit non-zero *before* it writes anything. The workflow stops there, the
deploy job does not run, and the page that is up stays up.

The workflow, `.github/workflows/status.yml`, runs the tests, builds, and deploys with `actions/deploy-pages`. The build
job can only read the repository; the Pages permissions are on the deploy job alone. Both jobs have a 10 minute
timeout. It runs every 15 minutes (GitHub may delay or skip a run under load), by hand (Actions > status > Run workflow) and on a
push to `main`. It authenticates with the built-in `GITHUB_TOKEN`, which reads public repositories; there is no secret to
create. `.github/workflows/test.yml` runs the tests and an offline build on pull requests.

### Scheduled runs stop after 60 days

GitHub disables scheduled workflows in a public repository after 60 days without activity in it (a commit, say).
This is accepted. If the page stops updating, open Actions, enable the workflow again, or push any commit; "Run workflow"
also works while the schedule is enabled. The footer of the page says when it was last made.

## Setup (once)

1. The repository is public (Pages on a free plan needs that).
2. Settings > Pages > Source: **GitHub Actions**.
3. After the first run, look at Settings > Environments > github-pages (it is created by the first deploy; the default
   branch rule allows `main`).

The page only appears after the first run of the `status` workflow on `main`.

## Run it yourself

```sh
node --test "scripts/*.test.mjs"                      # the tests
node scripts/build.mjs --fixtures scripts/fixtures    # offline, from the fixtures: writes dist/
GITHUB_TOKEN=$(gh auth token) node scripts/build.mjs  # the real repository (without a token it is rate limited to 60 requests an hour)
python3 -m http.server -d dist                        # then open http://localhost:8000
```

`--out DIR` writes somewhere other than `dist/`. `scripts/fixtures/` holds trimmed copies of the API responses: issues
with and without area labels (and a pull request inside the list), a not-planned and a duplicate issue, issues in the
hardware area, open pull requests in each check state, a draft, merged and unmerged closed pull requests, and the search
results for the three labels (`search-*.json`, one with a hostile title and a `javascript:` link). Node 22 or later is
needed for the test glob.

To check the numbers by hand for an area, count with
`gh issue list --repo padcom/drone-configurator --state all --limit 1000 --json state,labels,stateReason` and compare with
`dist/data.json`.

## Not yet

Live team state, usage figures, and charts over time. `data/` is where a daily history would go; nothing uses it yet.
