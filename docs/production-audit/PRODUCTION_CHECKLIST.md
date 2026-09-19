# Production readiness checklist

`[x]` done and verified · `[~]` partly done · `[ ]` not done · `[!]` blocked

---

## Release gates — must be green before taking real customers

- [x] **Cross-tenant project access** — `resolveProject` + `projects.owns()` on the run path
- [ ] **Cross-tenant sweep across all routes** — verified only on the run path
- [x] **Customer DB isolation** — database + role per project, no cross-`CONNECT`
- [x] **Customer containers cannot reach the platform network** — `apps` is `--internal`, Caddy bridges
- [x] **Container hardening** — unprivileged, no docker socket, caps dropped, `no-new-privileges`, resource limits (122 checks)
- [x] **Published sites cannot touch the control-plane origin** — CSP `sandbox`, opaque origin
- [x] **Rate limits are per caller** — `c1fe69f`
- [x] **Build/edit limits enforced on the route the UI uses** — `72df365`
- [x] **Platform AI budget is a real cap** — `ea5950e`
- [x] **Nightly backups actually run** — `abf19a2`
- [ ] **MongoDB is backed up** — see BACKUP_RECOVERY.md B-2. **Blocks sign-off.**
- [ ] **A restore has succeeded once** — no drill has been run. **Blocks sign-off.**
- [ ] **Backups exist off the host** — B-3
- [!] **Secrets reviewed and rotated if exposed** — not determined

---

## Configuration

- [x] HTTPS everywhere; Caddy issues certificates automatically
- [x] Customer apps on `*.souqi.site`, isolated subdomains
- [x] Only `/api`, `/auth`, `/s` reach Express at the edge
- [x] Base images pinned by tag
- [ ] Base images pinned by **digest** — a tag is mutable
- [ ] `trust proxy` reviewed app-wide — deliberately not set; `clientIp()` handles limits only
- [ ] Env var inventory — which are required, which are secret, which differ per environment

## Data

- [x] Platform Postgres dumped nightly, 14-day retention, mode 0600
- [x] Customer cluster dumped with **roles** (`pg_dumpall`) — roles are the isolation
- [ ] Mongo backup — **unknown whether any exists**
- [ ] Off-host copies
- [ ] Backup encryption beyond file mode
- [ ] Backup freshness alert — B-1 ran undetected for 15 days
- [ ] Migration procedure for Mongo — no tool, no documented path

## Reliability

- [x] Per-owner spend gate (month + rolling window)
- [x] Platform-wide AI budget shared across instances
- [ ] Concurrent build cap platform-wide
- [ ] Per-tenant fair scheduling
- [ ] Mongo connection reuse audited
- [ ] Deployment state machine reviewed end to end (QUEUED → … → READY, FAILED, CANCELLED)
- [ ] Orphaned-infrastructure sweep after failed deploys

## Observability

- [ ] Structured logs with correlation IDs
- [ ] Error tracking
- [ ] Alerting of any kind — **nothing currently alerts on anything**
- [x] Per-owner spend recorded (in-process path)
- [~] Per-owner spend on the worker path — REMAINING_RISKS.md R-1
- [x] Platform spend recorded per month and route (`aispend`)

## CI / release

- [x] `node test/csp-test.js` — 14 assertions, canary for routes/CSP
- [x] `infra/deploy/scripts/verify.js` — 122 checks
- [x] New suites wired into `npm run ci`: `test:ai-spend`, `test:entitlements`, `test:client-ip`
- [ ] `npm run lint` — fails at **64 warnings** against a budget of 50 (pre-existing; `CLAUDE.md` says 55, so the doc has drifted)
- [ ] Parts of `npm run ci` unreachable behind a throwing step (pre-existing)
- [ ] Dependency scanning — `npm audit` not run
- [ ] **Staging environment — does not exist.** Everything in this pass went local → production.
- [ ] Automated rollback procedure

---

## The deploy procedure itself

This repo's most reliable source of "fixed but not live" incidents.

1. `git push` — **deploys nothing.**
2. Control plane: `npx vercel --prod --yes`
3. Data plane: `SSH_USER=ubuntu bash infra/deploy/scripts/ship.sh 148.113.174.192`
   *(bash, not PowerShell — `SSH_USER=x cmd` is a bash env prefix)*
4. If any file under `frontend/styles/` or `frontend/js/` changed, **bump
   its `?v=` in every HTML that links it.** A frozen version means the
   fix deploys and the CDN keeps serving the old bytes.
5. **Verify served bytes, not that the deploy succeeded.** Fetch the
   asset from production and diff its length against local; grep for a
   marker that exists only in the new code.
6. For VPS changes, verify **inside the running container**, not just on
   the host — `docker exec stack-worker-1 …`.

Steps 4–6 are not ceremony. Each one corresponds to an incident in this
repo's history, and step 3 to one in this session.
