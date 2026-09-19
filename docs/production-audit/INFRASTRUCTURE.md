# Infrastructure, isolation model, and data stores

Status: **partial.** Data-plane isolation was audited; cloud IAM, object
storage policy and firewall rules were not. Read with REMAINING_RISKS.md.

Per instruction, this records the system as it is: **MongoDB for platform
state, no S3 migration.**

---

## 1. Where things run

**Control plane — Vercel.** `backend/index.js` runs as a single
serverless function at `api/index.js`, `maxDuration: 300`, `memory: 1024`.
Only `/api/*`, `/auth/*`, `/s/*` reach it; everything else is static or a
404 at the edge.

**Data plane — one VPS, `148.113.174.192`,** running the compose stack in
`infra/deploy/docker-compose.yml`. Shipped with
`SSH_USER=ubuntu bash infra/deploy/scripts/ship.sh 148.113.174.192`.
Health after the last ship this session:

```json
{"ok":true,"host":"local","caddy":true,
 "worker":{"ok":true,"docker":"29.7.2","staleSeconds":2}}
```

---

## 2. Networks

Two Docker networks:

- **`platform`** — `postgres`, `userdb`, `api`, `worker`, `caddy`.
- **`apps`** — customer containers, created `--internal`.

**Caddy is the only service with published ports** (80/443) and is the
only member of both networks. A customer container therefore has no route
to the platform network and no route out except through the proxy. This
is the main structural defence and it is asserted by the deploy suite.

---

## 3. Customer container hardening

From `infra/deploy/src/framework/dockerfiles.js` and the engine, all
asserted by `infra/deploy/scripts/verify.js` (**122 checks passing**):

- not privileged; **no docker socket** inside customer containers
- no host network, no host filesystem mounts
- all capabilities dropped; `no-new-privileges`
- cpu, memory, swap and pids limits
- docker invoked as an **argv array**, never a shell string — the
  property that makes command injection structurally impossible
- build commands pass `assertSafeCommand`, which refuses newlines (a
  newline would let a value append its own Dockerfile instructions)
- static sites ship on `nginx:1.27-alpine` as a **non-root** user on port
  8080 — an unprivileged process cannot bind below 1024 without
  `CAP_NET_BIND_SERVICE`, which these containers do not get
- multi-stage: the runtime image holds compiled assets only — no source,
  no `node_modules`, no npm

Base images are pinned by tag (`node:20-alpine`, `nginx:1.27-alpine`,
`python:3.12-slim`). Tags, not digests — see PRODUCTION_CHECKLIST.md.

**The limit of this model:** a shared kernel. See REMAINING_RISKS.md R-3.

---

## 4. Databases

### Platform — MongoDB

Collections observed in this pass: `projects`, `turns`, `agent_runs`,
`ratelimits`, and `aispend` (added `ea5950e`). Indexes are ensured at
boot rather than by a migration framework; `ratelimits` uses a TTL index
on `reset` so rows expire themselves.

There is **no migration tool**. Adding a field is safe; renaming or
backfilling one has no supported path and would need a script written for
the occasion. Recorded as a gap, not fixed.

### Customer — PostgreSQL, one database and role per project

Provisioned on the VPS. Verified earlier in this session: each project
gets its own database and its own role, and roles have **no cross-
`CONNECT`** — a customer's application credentials reach that customer's
database and nothing else. A generated application never receives
platform credentials.

The compose file annotates `userdbdata` as *"customer data — the one
volume here that holds their work."* That single volume is the durability
story for customer databases; see BACKUP_RECOVERY.md.

---

## 5. Object storage

No S3. Uploads are stored through `backend/lib/uploads.js` /
`blobs.js` against Mongo (a `blobs` sibling database), and served by a
route that sets immutable caching. Verified earlier in this session:
uploads are **magic-byte verified twice** and `image/svg+xml` is refused,
because the bucket is public-read and an SVG would execute as a document
in the asset origin.

Object ACLs, retention and lifecycle were **NOT AUDITED**.

---

## 6. TLS and domains

Caddy terminates TLS and issues certificates automatically; customer apps
are served at `app-xxxx.souqi.site`, which requires the wildcard
`*.souqi.site A 148.113.174.192`.

Published sites under `/s/*` are served with a CSP `sandbox` directive
placing them in an **opaque origin** — no shared cookies, storage or
origin privileges with `souqi.site`. `backend/test/csp-test.js` asserts
the middleware policy and `vercel.json` agree directive-for-directive.

Custom-domain ownership verification was **NOT AUDITED**.

---

## 7. Configuration drift, as a first-class hazard

Two deploy targets, neither triggered by `git push`, plus hand-maintained
`?v=` cache-busting on stylesheets. Both have produced "fixed but not
live" in this repo's history and once in this session. Any release
procedure must verify **served bytes**. See PRODUCTION_CHECKLIST.md.
