# Deploying

> **`git push` deploys nothing.** Neither target has git integration. Pushing
> updates GitHub and leaves both running systems exactly as they were.

There are two targets and they are shipped by two different commands.

| Target | What it runs | Command |
|---|---|---|
| souqi.site | `frontend/` and the `api/index.js` function | `npx vercel --prod --yes` from the repo root |
| 148.113.174.192 | the container plane | `SSH_USER=ubuntu bash infra/deploy/scripts/ship.sh 148.113.174.192` |

## Vercel

Run it from the repo root. `.vercel/project.json` links this checkout to the
project `sapone`; `vercel.json` supplies `outputDirectory`, the rewrites, the
headers and the function's memory and timeout.

One thing to check before relying on `vercel.json`: `vercel pull` overwrites
`.vercel/project.json` from the dashboard, so a dashboard-level
`outputDirectory` would win over the file. It should be `null`.

```bash
npx vercel pull --yes --environment=production
```

### Verify it actually landed

Use a marker that exists **only** in the new code. This is the failure that has
already happened once: a route answering 401 was read as proof a deploy had
landed, when that route had been live since an earlier deploy and the new one
had never shipped. The marker did not distinguish the two.

A stylesheet added by the change is a good marker, because a 404 is unambiguous:

```bash
curl -sI https://souqi.site/styles/tokens.css | head -1
```

Comparing the served byte count of a page against the local file works too.
Checking that a page merely loads does not.

## The container plane

```bash
SSH_USER=ubuntu bash infra/deploy/scripts/ship.sh 148.113.174.192
```

`SSH_USER` matters. The script defaults to `root`, which is wrong for this
host. It tars the stack, copies it to `/opt/platform/stack` and brings compose
up there — so the compose project name on the server is `stack`, regardless of
where the directory sits in this repo.

### Schema changes need a separate step

`infra/deploy/db/schema.sql` is applied by `docker-entrypoint-initdb.d`, which
only runs against a **fresh** Postgres volume. An existing host will never pick
up a schema change from a ship alone:

```bash
docker compose exec -T api node scripts/migrate.js
```

### Before and after

```bash
cd infra/deploy && npm run preflight
```

```bash
cd infra/deploy && npm test
```

`npm test` runs both verification suites — 113 checks in `verify.js` and 32 in
`verify-auth.js`. Read the counts they print rather than any number written in
a document, including this one. `ship.sh` was changed to print the suites' own
output for exactly this reason: the count used to be maintained by hand, and it
was wrong the first time a check was added.

## What CI does and does not do

`.github/workflows/` runs lint and the backend suites, all with
`working-directory: backend`. **No workflow touches `infra/deploy/`** — its 145
verification checks have never run in CI. And `ci.yml` marks the lint step
`continue-on-error`, so a green tick does not mean lint passed.

Two known gaps, neither caused by the restructure:

- `npm run lint` exits 1. There are 0 errors and 55 warnings against a
  `--max-warnings 50` budget.
- `npm run ci` used to die at step one on a generator whose inputs were
  deleted. That step is gone, so the chain runs now — expect to find failures
  it had been hiding.


## The agent's build sandbox

The code agent verifies its own work in a disposable container on the
container plane. Two of `MAX_CONTAINERS` are held back for it
(`AGENT_SANDBOX_CONTAINERS`, default 2), so with the host's current
`MAX_CONTAINERS=10` that is eight deployments and two sandboxes.

It lives in the **worker**, because the worker is the only thing holding
a Docker socket. The worker's internal server is not published, so the
api forwards to it — the same way it already forwards runtime logs.

Reaching it from Vercel therefore needs **three** variables on the app,
and two tokens on every request, because there are two gates guarding
different things:

| Variable | Value | Gate it passes |
|---|---|---|
| `AGENT_VERIFIER_URL` | `https://<control-domain>/internal/agent/` | — |
| `AGENT_VERIFIER_TOKEN` | the plane's `INTERNAL_TOKEN` | the route |
| `DEPLOY_PLATFORM_TOKEN` | the plane's `DEPLOY_PLATFORM_TOKEN` | the control **hostname**, app-wide, before any route |

Sending only the internal token gets a 401 from the hostname gate and
never reaches the route at all. The trailing slash on the URL matters:
paths are joined relative to it, and `new URL("/health", base)` would
discard the path and hit the plane's own public `/health` instead —
reading a healthy plane as a healthy verifier.

Until these are set, `run_command` and server-side `check_project` reply
"no build sandbox is configured for this run" rather than pretending a
command ran and printed nothing. That is the honest degraded mode, and
the browser's WebContainer check still works as it did.

Confirm it end to end without deploying anything:

```bash
ssh ubuntu@148.113.174.192 'cd /opt/platform/stack   && TOK=$(grep -E "^INTERNAL_TOKEN=" .env | cut -d= -f2)   && PT=$(grep -E "^DEPLOY_PLATFORM_TOKEN=" .env | cut -d= -f2)   && CD=$(grep -E "^CONTROL_DOMAIN=" .env | cut -d= -f2)   && curl -s -H "x-internal-token: $TOK" -H "x-platform-token: $PT"        "https://${CD}/internal/agent/health"'
```

`{"ok":true,...,"slots":2}` means a check can run. `ok:false` carries the
reason, and "the worker is not reachable" and "Docker is down" are kept
apart on purpose — they have completely different fixes.
