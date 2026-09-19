# Souqi — actual architecture and trust boundaries

Status of this document: **partial.** It records what was read in the
source and, where marked *measured*, what was observed against the running
system. Sections marked **NOT AUDITED** were not reached in this pass and
should not be read as endorsements.

Companion docs already in the repo — `docs/ARCHITECTURE.md`,
`docs/HOW-IT-WORKS.md`, `docs/DEPLOYING.md` — describe intent. This one
records what the code does.

---

## 1. Two deployment targets, not one

This is the single most load-bearing fact about the system, and the
`CLAUDE.md` at the repo root leads with it: **`git push` deploys nothing.**

| Target | What runs there | How it ships |
| --- | --- | --- |
| **Vercel** (`souqi.site`) | the control plane — Express app as one serverless function | `npx vercel --prod --yes` |
| **VPS** (`148.113.174.192`) | the data plane — build workers and customer containers | `SSH_USER=ubuntu bash infra/deploy/scripts/ship.sh 148.113.174.192` |

Neither is wired to git. A change to `backend/` and a change to
`infra/deploy/` are two different deploys, and a fix that spans both is
not live until both have run. *Measured this session:* a fix to
`infra/deploy/src/framework/detect.js` was deployed to Vercel and had no
effect at all until `ship.sh` ran, because the file only ever executes on
the VPS.

### Vercel edge routing

`vercel.json` sends only three prefixes to Express:

- `/api/*`
- `/auth/*`
- `/s/*`

Everything else is a static file or a 404 **at the edge**. Routes exist in
`backend/index.js` that can never run on `souqi.site`. A 404 from
production therefore means "not routed here", not "refused" — any probe
must be calibrated against a route that is known to reach Express.

`functions: { "api/index.js": { maxDuration: 300, memory: 1024 } }`. The
300s cap is the hard ceiling on a single agent run; see §4.

`api/` cannot move — Vercel discovers functions only at `<root>/api/`.

---

## 2. Stack, as declared in `backend/package.json`

Runtime dependencies, in full: `@anthropic-ai/sdk`, `bcryptjs`, `cors`,
`cross-spawn`, `dotenv`, `express`, `jsonwebtoken`, `mongodb`, `pg`.

- **Control-plane database: MongoDB.** Projects, turns, runs, usage
  meters, rate-limit counters and (new this pass) AI spend all live here.
- **`pg` is for customer databases**, provisioned per project on the VPS —
  not for platform state.
- **No ORM, no migration framework.** Collections are created on demand
  and indexes are ensured at boot (`runStore.ensureIndexes()`,
  `ratesCollection()`, `aiSpendStore`).
- **Frontend is vanilla HTML/CSS/JS.** No React, no bundler, no build
  step. Cache-busting is a hand-maintained `?v=` query on each
  `<link>`/`<script>`; a stale one is a real and recurring failure mode
  (see BUG_REPORT.md).
- **The agent is TypeScript.** `backend/agent-src/` compiles to
  `backend/lib/codeagent/` and `backend/worker/`. Every generated `.js`
  carries a banner. Editing the `.js` loses the change on next build.

---

## 3. The VPS data plane

`infra/deploy/docker-compose.yml` services: `postgres`, `userdb`, `caddy`,
`api`, `worker`.

Networks: `platform` and `apps`. Caddy is **the only service with
published ports** (80/443) and bridges the two networks. Customer
containers sit on `apps`, which is `--internal`.

Volumes: `userdbhome`, `pgdata`, `userdbdata` (annotated in the compose
file as "customer data — the one volume here that holds their work"),
`builds`, `caddy_data`, `caddy_config`.

---

## 4. How a prompt becomes a deployed application

```
 ┌────────┐   HTTPS    ┌──────────────────┐
 │ Browser│───────────▶│ Vercel edge      │  static files, or
 │code.html│           │ (vercel.json)    │  /api /auth /s → Express
 └────────┘            └────────┬─────────┘
      │                         │
      │  POST /api/codeagent/runs
      ▼                         ▼
 ┌─────────────────────────────────────────┐
 │ Express (api/index.js, maxDuration 300) │
 │  • appOwnerOf()  → userId | anonId      │
 │  • resolveProject + projects.owns()     │
 │  • entitlement gate      ← ADDED 72df365│
 │  • spendGate             ← ADDED 72df365│
 │  • rate limit per client IP ← c1fe69f   │
 └──────────────┬──────────────────────────┘
                │ createRun() → Mongo "agent_runs"
                ▼
      ┌───────────────────────┐        ┌──────────────────────┐
      │ in-process runner     │   or   │ VPS worker           │
      │ agentRunner.executeRun│ handoff│ worker-service.js    │
      └──────────┬────────────┘        └──────────┬───────────┘
                 │  DeepSeek via lib/ai/client.js │
                 │  budget: Mongo "aispend" ← ea5950e
                 ▼                                ▼
          Mongo: turns, revisions, run events, usage
                 │
                 │ user presses Deploy
                 ▼
      ┌──────────────────────────────────────────┐
      │ VPS worker                               │
      │  detect.js  → framework + build command  │
      │  dockerfiles.js → multi-stage Dockerfile │
      │  docker build (argv array, never a shell)│
      │  run on `apps` network, caps dropped     │
      └──────────────┬───────────────────────────┘
                     ▼
               Caddy → https://app-xxxx.souqi.site
```

**Preview is a separate path from deploy.** In the browser the preview is
either WebContainer or a CDN/`srcdoc` fallback. *Measured on souqi.site:*
WebContainer never becomes ready — `prepare()` was still pending at
25,014 ms with `isBooted:true`, `isReady:false` and an empty
`installError()`. StackBlitz requires a licence for non-localhost origins.
So every preview waits out `WC_PREPARE_TIMEOUT_MS = 20000` and then
renders through the fallback. See REMAINING_RISKS.md.

---

## 5. Trust boundaries

| # | Boundary | Enforced by | Status |
| --- | --- | --- | --- |
| B1 | Browser → control plane | JWT session cookie / anon token, `appOwnerOf()` | verified present on the runs path |
| B2 | Tenant → tenant (projects) | `projects.owns()`, `listFilter()` | verified on `/runs`; **not swept across all routes** |
| B3 | Control plane → agent | prompt + tool registry | partially audited |
| B4 | Agent → customer files | tool registry allow-list | **NOT AUDITED this pass** |
| B5 | Build container → host | Docker, caps dropped, no socket | audited earlier in session; 122 checks pass |
| B6 | Customer app → platform network | `apps` network is `--internal`; Caddy bridges | audited earlier in session |
| B7 | Customer app → other customer app | per-project Postgres role, no cross-`CONNECT` | audited earlier in session |
| B8 | Published site → souqi.site origin | CSP `sandbox` on `/s/*` → opaque origin | verified by `test/csp-test.js` |
| B9 | Platform secrets → generated app | separate credential sets | **NOT AUDITED this pass** |

The boundary that failed in this pass was **none of these** — it was the
economic boundary. See SECURITY_AUDIT.md, findings S-1 and S-2.

---

## 6. What this document does not cover

Not inspected in this pass, and therefore unknown rather than safe:

- The agent tool registry's permission model end to end (B4).
- WebSocket/SSE authorization beyond the run-event stream.
- The GitHub OAuth and Stripe flows beyond noting that state is
  HMAC-bound and webhooks are timestamp-toleranced.
- Password reset.
- Admin endpoints as a group.
- Object storage lifecycle, retention, and backup verification.
