# Souqi — security audit

Every entry states how it was established. Nothing here is marked fixed
unless the code changed **and** a test covers it.

**Legend**
`CONFIRMED` — reproduced or read directly in the source.
`VERIFIED-OK` — checked this pass and found sound.
`UNVERIFIED` — plausible, not yet established.
`NOT AUDITED` — not reached in this pass.

---

## Findings

### S-1 · P0 · CONFIRMED · FIXED — the metered route was not the route being used

**Files:** `backend/index.js` — `/api/codeagent/runs` vs `/api/codeagent/build`
**Commit:** `72df365` · **Test:** `backend/test/runs-entitlement-test.js` (14 checks)

`/api/codeagent/build` carries the whole entitlement story:
`CODEAGENT_ANON_BUILDS`, `CODEAGENT_FREE_BUILDS`, `CODEAGENT_FREE_EDITS`,
`spendGate()`, `recordAction()`, `recordSpend()`.

`/api/codeagent/runs` carried **none** of it. Counted mechanically over
the route's line range before the fix:

```
requireAuth 0 · planOfRequest 0 · isPaidPlan 0 · CODEAGENT_FREE_BUILDS 0
CODEAGENT_FREE_EDITS 0 · recordAction 0 · recordSpend 0 · spendGate 0
monthCounts 0 · maxCostUsd 0        (resolveProject 1 · owns 1)
```

`/runs` is the route `code.html` posts to. `/build` is only reached as a
fallback. So every limit advertised on the pricing page was written,
documented, tested against `/build`, and **unenforced in production**.

**Impact.** An anonymous caller could spawn agent runs until the rate
limiter noticed, each one a DeepSeek bill. Free-build limits did not
apply. `spendGate` could never fire on this path because nothing on this
path had ever recorded a cent of spend against an owner, so it read $0 for
everyone, forever, and `CODEAGENT_PLAN_BUDGET_USD` was decoration.

**Fix.** The same counters and the same constants, so the two paths cannot
drift on whether someone may build. A refusal returns **no `runId`**,
which needed no frontend change: `code.html` already treats a spawn with
no `runId` as a reason to fall through to `/build`, which re-checks and
emits the `authRequired`/`subscribeRequired` frame the UI draws at
`code.html:5494`.

Spend is now booked in `persistRunOutcome()` — above the `if (!project)
return` guard, because a run that built nothing still spent the money, and
keyed off `ownerUserId`/`ownerAnonId`, which is what the run document
actually holds. The first attempt used `run.owner`, which does not exist;
it recorded nothing and threw nothing. That is covered by a test.

---

### S-2 · P0 · CONFIRMED · FIXED — the platform AI budget was per-process

**Files:** `backend/lib/ai/client.js`, new `backend/lib/ai/spend-store.js`
**Commit:** `ea5950e` · **Test:** `backend/test/ai-spend-store-test.js` (7 checks)

`AI_MONTHLY_BUDGET_USD` was enforced by `budgetExceeded()` summing a
module-scope object. The hook meant to persist it was never supplied —
`init()`'s own docstring still read *"plug in the audit collection later;
defaults to in-memory"*. Confirmed: `recordSpend:` appears exactly once in
the backend and it belongs to the **uploads** module, not the AI client.

**Impact.** Production is Vercel. Many lambdas run concurrently and are
recycled constantly, so each counted its own spend from zero. The
platform-wide cost ceiling was a number in the environment and nothing
else. This is precisely the failure `backend/middleware/rateLimit.js`
documents at length for request limits.

**Fix.** A Mongo-backed shared store (one document per month, `$inc` per
call, read behind a 10s cache). Two non-obvious properties, both tested:
a write also advances the cached total, so a burst inside one cache window
cannot sail past together; and a store that throws falls back to *this
process's* total rather than to zero, because a breaker that opens the
floodgates when its database blinks is worse than one that is briefly too
strict.

---

### S-3 · P1 · CONFIRMED · FIXED — every rate limit was one global bucket

**Files:** `backend/middleware/rateLimit.js`, `backend/index.js`
**Commit:** `c1fe69f` · **Test:** `backend/test/client-ip-test.js` (9 checks)

All thirteen limiters keyed on `req.ip`. Express only fills that from
`X-Forwarded-For` when `trust proxy` is set, and it is set **nowhere** —
so behind Vercel's edge and behind the VPS's Caddy, `req.ip` was the
proxy and every visitor shared one counter.

**Measured on the dev server**, three POSTs carrying three different
client addresses:

```
X-RateLimit-Remaining: 119 → 118 → 117      one shared bucket
```

**Impact.** 20 project creations per 15 minutes *for the entire site*, 40
agent runs for the entire site, and a login limit a stranger could spend
on your behalf — both a denial-of-service lever and a brute-force
loosener.

**Fix.** `clientIp()` prefers Vercel's own `x-vercel-forwarded-for` (the
edge overwrites any client copy), else the **last** entry of
`X-Forwarded-For` — both proxies *append* the peer they saw, so a forged
value lands to the left and is ignored. Reading the first entry, the usual
way this gets written, would have handed every caller unlimited buckets.
`TRUST_PROXY_HOPS=0` disables header trust for a directly-exposed
deployment.

Verified after the fix: two distinct clients hold separate buckets
(119/119 → 118/118), and a forged leading entry does not open a new one.
Confirmed on production that a forged `X-Forwarded-For` is ignored.

Deliberately **not** `app.set("trust proxy")`, which would also rewrite
`req.protocol` and `req.secure` for every route and cookie in the app.

---

### S-4 · P1 · CONFIRMED · FIXED — agent ran with no conversation history

**File:** `backend/index.js` · **Commit:** `5d421ed`

History reaching the model came only from `req.body.conversation`, and the
browser only keeps `convo` — a page-session array whose own comment calls
it *"the conversation before a project exists"*, cleared when a build
lands. Every turn after the first build, and after any reload, ran with an
empty history.

Security-relevant rather than merely a bug: `/build` reads turns from
Mongo scoped to `(projectId, chatId)`; `/runs` accepted whatever the
client sent. A client could therefore **supply arbitrary conversation
history** to the model. The fix reads the thread server-side from Mongo
when a project exists, scoped to the chat, and keeps the client buffer
only for the pre-project case it was written for.

---

### S-5 · VERIFIED-OK — project ownership on the run path

`resolveProject(existingKey, owner)` followed by an explicit
`projects.owns(project, owner)` with a 403. Both present and ordered
correctly; `resolveProject` returning null yields 404 before the
ownership test, so existence is not leaked differently from ownership in
a way that matters here.

**Not** a statement about every route. A full IDOR sweep across all
project/deployment/upload endpoints was **NOT AUDITED** in this pass.

---

### S-6 · VERIFIED-OK — container and network isolation (data plane)

Audited earlier in this session against `infra/deploy`; the suite is
`infra/deploy/scripts/verify.js`, now **122 checks, all passing**.
Confirmed: no privileged containers, no docker socket in customer
containers, no host network, no host filesystem mounts, capabilities
dropped, `no-new-privileges`, cpu/memory/swap/pids limits, customer
containers on an `--internal` network, docker invoked as an argv array
rather than a shell string, per-project Postgres database and role with no
cross-`CONNECT`, static images served by nginx as a non-root user on 8080.

Caveats: this is ordinary Docker, not gVisor or a microVM. See
REMAINING_RISKS.md R-3 for the trade-off.

---

### S-7 · VERIFIED-OK — published sites cannot touch the control-plane origin

`/s/*` is served under a CSP `sandbox` directive that places published
apps in an **opaque origin**, so a generated app shares no cookies,
`localStorage` or origin privileges with `souqi.site`. Asserted by
`backend/test/csp-test.js`, which also checks that the middleware policy
and `vercel.json` agree directive-for-directive (14 assertions).

---

### S-8 · P2 · CONFIRMED · NOT FIXED — spend is not booked on the worker path

`persistRunOutcome()` runs only for the in-process executor. When a run is
handed off to the VPS worker, completion goes through
`lib/codeagent/worker-service.js`'s finalizer, which does **not** record
per-owner spend. So `spendGate` under-counts for handed-off runs.

Not fixed in this pass because that file is generated from
`agent-src/lib/codeagent/worker-service.ts` and the change needs a
`build:agent` plus worker redeploy. The entrance gate (S-1) limits
exposure in the meantime because build/edit **counts** are enforced
regardless of spend. Tracked in REMAINING_RISKS.md R-1.

---

### S-9 · UNVERIFIED — prompt injection through repository files

The agent reads project files and tool output into its context. Whether
those are treated as data or as instructions was **not** established this
pass. `redact()` is applied to narration and now to the reasoning trace,
which addresses secret leakage into events but not instruction-following.

---

## Not audited in this pass

Listed so they are not mistaken for clean: CSRF beyond cookie flags;
password reset; admin endpoints as a group; the agent tool registry's
permission model; SSRF from agent-initiated fetches; prototype pollution;
unsafe deserialization; dependency/supply-chain scanning; object-storage
ACLs and presigned URLs; WebSocket/SSE authorization beyond the run-event
stream; cloud metadata endpoint reachability from customer containers.
