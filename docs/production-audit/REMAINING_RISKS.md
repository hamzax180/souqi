# Remaining risks, unverified assumptions, and blocked work

The point of this file is that the other documents can be read as
finished. Anything not resolved is here.

---

## R-1 · P2 · Spend is not booked on the worker path

`persistRunOutcome()` books per-owner spend only for the **in-process**
executor. A run handed off to the VPS worker finishes through
`lib/codeagent/worker-service.js`'s finalizer, which records none, so
`spendGate` under-counts those runs.

Not fixed because that file is generated from
`agent-src/lib/codeagent/worker-service.ts`; the change needs
`npm run build:agent` plus a worker redeploy, which is a second deploy
target and wanted its own verification pass.

**Exposure is bounded** by the entrance gate (`72df365`): build and edit
*counts* are enforced regardless of spend, so the per-action limits hold.
Only the dollar ceiling under-counts.

---

## R-2 · P1 · WebContainer cannot boot on souqi.site — every preview pays 20s for nothing

*Measured on production:*

```
isBooted: true · isReady: false · installError: (empty)
prepare(): STILL PENDING after 25,014 ms
```

Not slow — pending. It neither resolves nor rejects. StackBlitz's
WebContainer requires a commercial licence for any non-localhost origin,
and a comment in `code.html` already records the same measurement.

Consequence: every preview waits out `WC_PREPARE_TIMEOUT_MS = 20000` and
then renders through the CDN/`srcdoc` fallback. The blank-preview reports
are consistent with this.

**Two ways out, and it is a product decision, not an engineering one:**
buy the licence, or make the fallback renderer primary on production and
skip the dead wait. Not actioned — awaiting a decision.

Note that the mobile user-agent check currently *helps*: phones skip
straight to the fallback. Removing it, as was once requested, would make
every phone preview wait 20s and then fall back anyway.

---

## R-3 · Accepted risk · Ordinary Docker, not gVisor or a microVM

Customer code is built and run in ordinary Docker containers, hardened as
recorded in SECURITY_AUDIT.md S-6 — unprivileged, no socket, caps
dropped, `no-new-privileges`, internal network, resource-limited.

That is a real boundary and it is correctly configured, but it is a
**shared-kernel** boundary. A Linux kernel LPE is a container escape. For
a platform whose entire premise is executing code written by a language
model on behalf of strangers, the stronger options are gVisor (syscall
interception; a modest performance cost, mostly on syscall-heavy I/O) or
Firecracker/Kata microVMs (a separate kernel per tenant; higher memory
floor and slower cold start).

Not changed in this pass: it is an infrastructure migration with real
operational cost and it should be a deliberate decision, not a side
effect of an audit. Recorded so the choice is explicit rather than
accidental.

---

## R-4 · The single agent run ceiling is Vercel's, and it is already binding

`AGENT_WALL_MS` defaults to 300000 and `vercel.json` sets
`maxDuration: 300`. They are the same number because one is the other's
ceiling. A run observed this session spent 212,866 ms inside a single
model call and was cut off; total 4m34s against a 5-minute wall.

300s is Vercel's hard maximum, so the ceiling cannot be raised where the
control plane runs. Either the agent emits in smaller batches, or long
runs move to the VPS worker, which has no such cap. Not actioned.

---

## R-5 · Unverified: prompt injection through repository and tool content

The agent reads project files, tool output and build logs into its
context. Whether those are treated as data or as instructions was not
established. No test covers it.

---

## R-6 · Not audited, therefore unknown

Each of these was out of reach in this pass and must not be read as
clean:

- CSRF beyond cookie flags; password reset; admin endpoints as a group.
- A full IDOR sweep across project, deployment, upload and billing
  endpoints. Ownership was verified **only** on the run path.
- The agent tool registry's permission model end to end.
- SSRF from agent-initiated fetches; access to cloud metadata endpoints
  from inside customer containers.
- Dependency and supply-chain scanning (`npm audit` was not run).
- Object storage ACLs, presigned URLs, retention, lifecycle.
- Backup **restoration** — no restore test was performed, so no backup in
  this system is currently verified. See BACKUP_RECOVERY.md.
- Load and capacity measurement. No benchmark was run, so SCALABILITY.md
  contains no claimed user numbers.

---

## R-7 · Blocked on access or authorisation

- **Live exploitation testing** against production was not attempted.
  Findings are from source and from non-destructive probes.
- **Credential rotation.** If any key in `.env` has been exposed, this
  pass neither determined that nor rotated anything.
- **Restore drills** need a throwaway environment and explicit approval;
  they were not run against live data.
- **Staging environment** does not exist. Every change in this pass was
  verified locally and then deployed to production directly, because
  there is nowhere else to put it.

---

## R-8 · Process risk worth naming

Two deploy targets that `git push` does not trigger, plus hand-maintained
`?v=` cache-busting on every stylesheet, is a configuration where "fixed"
and "live" can differ silently. It has already happened more than once in
this repo's history, and once during this session — a fix deployed to
Vercel that only ever executes on the VPS did nothing until `ship.sh`
ran. Any release checklist has to verify *served bytes*, not just that a
deploy reported success.
