# Changes made in this audit pass

Every entry is a commit that is on `main`. Deploy target matters: see
ARCHITECTURE.md §1 — Vercel and the VPS ship separately and `git push`
ships neither.

## Security and correctness

| Commit | Change | Files | Target | Tests |
| --- | --- | --- | --- | --- |
| `72df365` | `/api/codeagent/runs` now applies the anonymous-build, free-build, free-edit and spend gates, records the build/edit action, and books spend on completion | `backend/index.js` | Vercel | `test/runs-entitlement-test.js` — 14 |
| `ea5950e` | `AI_MONTHLY_BUDGET_USD` counted in Mongo instead of per-process memory | `backend/lib/ai/client.js`, new `backend/lib/ai/spend-store.js`, `backend/index.js` | Vercel | `test/ai-spend-store-test.js` — 7 |
| `c1fe69f` | Rate limits keyed to the real client IP instead of the proxy | `backend/middleware/rateLimit.js`, `backend/index.js` | Vercel | `test/client-ip-test.js` — 9 |
| `5d421ed` | Agent reads its conversation from Mongo rather than trusting the client's copy | `backend/index.js` | Vercel | covered by existing turn-history suite |

**Why `72df365` needed no frontend change.** A refusal returns no
`runId`, and `code.html` already treats that as a reason to fall through
to `/api/codeagent/build`, which re-checks the identical gate and emits
the `authRequired` / `subscribeRequired` SSE frame the UI renders at
`code.html:5494`.

## Deployment engine

| Commit | Change | Files | Target |
| --- | --- | --- | --- |
| `7be64f9` | Scaffold gains `build:deploy`; the deploy prefers it, so a type error no longer refuses the image of a working app | `backend/lib/codeagent/scaffold/package.json`, `infra/deploy/src/framework/detect.js` | both |
| `2634d27` | Existing projects too: a build of the shape `tsc … && <rest>` runs `<rest>` | `infra/deploy/src/framework/detect.js` | VPS |

`infra/deploy/scripts/verify.js` went from 119 to **122 checks**. Verified
inside the running container after `ship.sh`:

```
existing project -> npx --no-install vite build
new scaffold     -> npm run build:deploy
```

## Agent observability

| Commit | Change | Files |
| --- | --- | --- |
| `4144cf3` | Reasoning tokens are reported as they stream (`reasoningDelta` → `reasoning_delta` event → live status line), instead of being collected and withheld | `backend/lib/ai/client.js`, `backend/agent-src/lib/codeagent/agent-runner.ts`, `frontend/code.html` |

Capped at 20k chars per turn on a 1s flush, and passed through `redact()`
like the narration — a trace is the least curated text a run produces.

## Frontend

| Commit | Change |
| --- | --- |
| `3af67dd` | Removed the 52px opaque top band and its reserved row; a gradient handles the collision instead |
| `044cf4e` | Long prompts stop scrolling back to line one while typing |
| `04371d8` | Preview toggle is bare at rest, chrome on hover; hover colour moved off a hardcoded light-theme slate |
| `6213043` | Rail chat dots start 27px higher; loading skeleton matches the real row in both width regimes |
| `a87ab8b` | Usage ring moved beside the effort/model pills |
| `62647d2` | Effort pill never truncates |
| `4cfa816` | Send button stops falling under the mic on a phone |

## Test suites added, and wired into `npm run ci`

- `test:ai-spend` — 7 checks
- `test:entitlements` — 14 checks
- `test:client-ip` — 9 checks

## Pre-existing failures, untouched and not mine

- `npm run lint` exits 1 at **64 warnings** against a budget of 50.
  `CLAUDE.md` records 55, so that line has drifted. Not changed in this
  pass; changing it would be fixing a budget rather than a problem.
- Parts of `npm run ci` were already unreachable behind a throwing step.
