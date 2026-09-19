# Scalability and capacity

**No load test was run in this pass.** Therefore this document contains
no claim about how many customers the platform supports. Everything below
is either a limit read out of the code, a number measured incidentally
while doing other work, or an explicitly labelled assumption.

The brief asked for 10 / 100 / 1,000-customer estimates "using explicit
assumptions and benchmark evidence where available". There is no
benchmark evidence available, so the estimates are given as *what must be
measured*, not as answers.

---

## 1 · Limits that exist, as configured

| Limit | Value | Where | Scope |
| --- | --- | --- | --- |
| Agent run wall clock | 300s | `AGENT_WALL_MS`, `vercel.json maxDuration` | per run |
| Finish reserve | 30s | `CODEAGENT_FINISH_RESERVE_MS` | per run |
| Anonymous builds | 1 | `CODEAGENT_ANON_BUILDS` | per owner/month |
| Free builds | 3 | `CODEAGENT_FREE_BUILDS` | per owner/month |
| Free edits | 10 | `CODEAGENT_FREE_EDITS` | per owner/month |
| Live deployments | 0 free / 2 paid | `DEPLOY_FREE_LIMIT`, `DEPLOY_PAID_LIMIT` | concurrent |
| Per-owner spend | `CODEAGENT_PLAN_BUDGET_USD`, `..._WINDOW_USD` | `spendGate()` | month + rolling window |
| Platform AI spend | `AI_MONTHLY_BUDGET_USD` | `lib/ai/client.js` | whole platform |
| Agent runs | 40 / 15 min | `codeAgentLimiter` | per client IP |
| Project creation | 20 / 15 min | `projectLimiter` | per client IP |
| Deploys | 20 / 15 min | `deployLimiter` | per client IP |
| Uploads | 120 / 15 min | `uploadLimiter` | per client IP |
| Container cpu / memory / swap / pids | set | deploy engine | per container |

**Three of these only started working during this audit**, which matters
for any capacity reasoning based on them:

- the per-IP scope of every rate limit (`c1fe69f`) — previously one
  global bucket, so the "per IP" column above was fiction;
- the build/edit/spend gates on the route the browser uses (`72df365`);
- the platform AI budget (`ea5950e`) — previously per-process.

---

## 2 · Structural bottlenecks, by inspection

**B-1 · The control plane is one serverless function.** Vercel scales
instances horizontally, so request concurrency is not the constraint.
Anything held in process memory is: that is exactly how the rate limiter
and the AI budget both failed. **Any future counter must go to Mongo.**

**B-2 · One VPS is the entire data plane.** Every build and every
customer container runs on `148.113.174.192`. Disk at time of audit:
`72G total, 5.0G used (7%)`. This is the hard scaling limit — vertical
until the worker becomes horizontally schedulable. Concurrent builds are
bounded by the box, and nothing in the code caps *concurrent* builds
platform-wide (only per-IP request rate).

**B-3 · No queue.** Runs are claimed with `claimInProcess()` or handed to
the worker. There is no durable backlog with fair scheduling, so under
contention the behaviour is first-come rather than per-tenant-fair. One
customer's burst can occupy the build host within their rate limit.

**B-4 · Mongo connection handling** was **NOT AUDITED**. Connection reuse
across serverless invocations is a classic failure at scale and should be
checked before any traffic growth.

**B-5 · One model call can consume an entire run.** Observed: 212,866 ms
in a single call against a 300s wall (REMAINING_RISKS.md R-4).

---

## 3 · Measurements actually taken

Small, and taken while investigating other things. Recorded because they
are real, and labelled because they are not a benchmark.

| Observation | Value |
| --- | --- |
| VPS root disk | 72G, 5.0G used (7%) |
| Worker heartbeat staleness after ship | 2s |
| One agent turn | 21.9k tokens in 4m34s |
| One truncated run's single model call | 212,866 ms |
| Platform DB dump | 56K gzipped |
| Customer cluster dump | 5.8K gzipped |

The dump sizes say the platform currently holds very little real data.
Any capacity claim extrapolated from today's box would be extrapolating
from an almost-empty system.

---

## 4 · What must be measured before a capacity claim

Stated as a test plan, because these numbers do not exist yet.

1. **Cost and duration per build.** Mean and p95 USD and seconds. Without
   it, `AI_MONTHLY_BUDGET_USD` cannot be set rationally and no
   per-customer cost model exists. Now obtainable: `aispend` records
   month and route, and `codeAgentUsage` records per-owner spend.
2. **Concurrent builds the VPS sustains** before build latency degrades —
   raise concurrency until p95 build time doubles.
3. **Mongo connections per lambda** under concurrency, and whether they
   are reused.
4. **Container memory footprint** of a typical deployed app, which sets
   how many live apps the box holds.
5. **Caddy throughput** at the shared ingress.

With (1), (2) and (4), the 10 / 100 / 1,000 question becomes arithmetic.
Without them it is a guess, and this document will not make one.

---

## 5 · Recommendations, in priority order

1. **Cap concurrent builds platform-wide**, not just request rate. The
   rate limiter bounds how often someone asks, not how much of the box
   they hold.
2. **Collect the per-build cost distribution** from `aispend` before
   setting any pricing or budget number.
3. **Decide the worker's horizontal story** before the single VPS is the
   binding constraint. It will be the first thing to break.
4. **Add per-tenant fair scheduling** to the run queue (B-3) once more
   than a handful of customers build concurrently.
5. **Audit Mongo connection reuse** (B-4).

No new infrastructure is recommended yet. Redis would be the obvious
reach for shared counters, but Mongo already serves that role for rate
limits and now for AI spend, and adding a second datastore for the same
job is cost without benefit at current volume.
