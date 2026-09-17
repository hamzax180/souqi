/* =================================================================
   api/server.js — the deployment control plane
   -----------------------------------------------------------------
   Every route here is thin on purpose. Nothing in this file runs a
   Docker command: an HTTP handler that shells out to docker build
   would hold the request open for minutes, time out at the proxy,
   and leave a deployment whose real state nobody can query. Handlers
   write a row and return; the worker does the work.

   The one exception is reading logs and status, which are cheap and
   must be answerable while a build is still going.
   ================================================================= */
"use strict";

const express = require("express");
const crypto = require("crypto");
const dns = require("dns");
const fsp = require("fs/promises");
const path = require("path");

const { cfg, assertProductionReady } = require("../config");
const { query, one, many } = require("../db");
// NOTE: docker/engine is deliberately NOT imported here. This process has no
// Docker socket, so every call it could make fails silently and gets reported
// as a fact about the user's app rather than a limit of this service. Work
// that needs the daemon is queued for the worker (lifecycle) or asked of the
// worker's internal API (runtime logs).
const caddy = require("../proxy/caddy");
const domains = require("../domains");
const capacity = require("../monitor/capacity");
const pipeline = require("../worker/pipeline");
const secrets = require("../secrets");
const auth = require("./auth");
const detect = require("../framework/detect");
const objects = require("../storage/objects");
// ONLY the external provider, and only for its validator. dbproviders/index
// would pull in dbproviders/builtin, whose every method shells out to
// `docker exec` against a socket this container deliberately does not have.
// The external one needs nothing but a Postgres client and the egress this
// container already has on souqi_platform — which is exactly why validating
// a customer's URL is answerable here and provisioning is not.
const externalDb = require("../dbproviders/external");

const app = express();
app.disable("x-powered-by");

// Caddy is the only thing in front of this, and it is the only thing that
// can reach it, so its X-Forwarded-* headers are the truth about the client.
// Without this req.hostname reads the upstream Host rather than the one the
// browser asked for, and the control-plane gate below would never match.
app.set("trust proxy", 1);

app.use(express.json({ limit: "2mb" }));

// BEFORE every route, and before the body is even needed: anything arriving
// on the control-plane hostname must prove it is the platform. Mounted here
// rather than per-route so that adding a route can never accidentally
// publish it — the gate is a property of how the request arrived.
app.use(auth.requirePlatformToken);

/* ---------- ids ----------
   Prefixed and random. A guessable deployment id is a way to enumerate
   other tenants, and these appear in container names and hostnames. */
const newId = (prefix) => prefix + "_" + crypto.randomBytes(9).toString("hex");

/* ---------- auth ----------
   Real sessions now — see api/auth.js. The placeholder that trusted an
   x-user-id header is gone rather than kept as a fallback: a route that
   accepts either is a route that accepts the weaker one.

   requireUser sets req.user (id, email, wsId) and req.userId. Every route
   below already went through one function, which is what made swapping the
   implementation a single edit instead of an audit of nine handlers. */
const requireUser = auth.requireUser;

/**
 * Ensures the signed-in user exists in THIS database.
 *
 * Identity lives in the main app; the deploy plane only needs a row to hang
 * foreign keys off. Upserting on first use means a new user can deploy
 * immediately without a provisioning step that could fail separately.
 */
async function ensureUser(user) {
  await query(
    "INSERT INTO users (id, email) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email",
    [user.id, user.email || user.id + "@unknown"]
  );
}

/** Loads a deployment and proves it belongs to the caller. */
async function ownedDeployment(req, res) {
  const dep = await one("SELECT * FROM deployments WHERE id=$1", [req.params.id]);
  if (!dep) { res.status(404).json({ error: "deployment not found" }); return null; }
  if (dep.user_id !== req.userId) {
    // 404, not 403: a 403 confirms the id exists, which is an enumeration
    // oracle across tenants.
    res.status(404).json({ error: "deployment not found" });
    return null;
  }
  return dep;
}

const publicView = (d) => ({
  deploymentId: d.id,
  projectId: d.project_id,
  status: d.status,
  framework: d.framework,
  url: d.domain ? "https://" + d.domain : null,
  domain: d.domain,
  limits: { cpu: Number(d.cpu_limit), memoryMb: d.memory_mb, pids: d.pids_limit },
  error: d.error || null,
  createdAt: d.created_at,
  updatedAt: d.updated_at
});

/* ---------- health & capacity ---------- */

/**
 * Docker facts come from the hosts row, not from a docker command.
 *
 * This process has no Docker socket on purpose, so it cannot ask the daemon
 * anything; calling out to it here only ever produced a silent failure
 * reported as `"docker": null`, which reads as "no Docker" rather than "this
 * service cannot see Docker". The worker writes what it observes and the
 * heartbeat age is reported alongside, so a dead worker is now visible
 * instead of being indistinguishable from a healthy one.
 */
const WORKER_STALE_MS = 5 * 60 * 1000;

app.get("/health", async (req, res, next) => {
  try {
    const host = await one("SELECT docker_version, worker_seen_at FROM hosts WHERE id=$1", [cfg.hostId]);
    const seenAt = host && host.worker_seen_at ? new Date(host.worker_seen_at) : null;
    const ageMs = seenAt ? Date.now() - seenAt.getTime() : null;
    const workerOk = ageMs !== null && ageMs < WORKER_STALE_MS;
    res.json({
      ok: workerOk,
      host: cfg.hostId,
      caddy: await caddy.health(),
      worker: {
        ok: workerOk,
        docker: (host && host.docker_version) || null,
        lastSeen: seenAt ? seenAt.toISOString() : null,
        staleSeconds: ageMs === null ? null : Math.round(ageMs / 1000)
      }
    });
  } catch (e) { next(e); }
});

app.get("/capacity", requireUser, async (req, res, next) => {
  try { res.json(await capacity.snapshot()); } catch (e) { next(e); }
});

/**
 * Caddy asks here before issuing a certificate for a hostname.
 *
 * Without this gate anyone could point DNS at this server and make it
 * request certificates on their behalf — an abuse vector, and the fastest
 * possible route to a Let-s-Encrypt rate limit that would then block real
 * customers. 200 means issue; anything else means refuse.
 */
/* ── the code agent's build verifier, proxied ─────────────────────
   The verifier itself lives in the WORKER, because the worker is the
   only thing on the platform with a Docker socket. But the worker's
   internal server is not published — nothing outside the platform
   network can reach it — and the agent that wants a build checked runs
   on Vercel, which is very much outside.

   So the api forwards, exactly as it already does for runtime logs and
   the database tools. Internal token on both hops; the caller's is
   checked here, and the api presents its own going on.
   ------------------------------------------------------------------ */
async function toWorker(path, init) {
  return fetch(cfg.workerUrl + path, Object.assign({
    headers: { "x-internal-token": cfg.internalToken, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(200000)
  }, init || {}));
}

app.get("/internal/agent/health", auth.requireInternal, async (req, res) => {
  try {
    const r = await toWorker("/internal/agent/health", { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.json({ ok: false, reason: "the worker refused the request (HTTP " + r.status + ")" });
    res.json(await r.json());
  } catch (e) {
    /* "Cannot reach the worker" and "the worker says Docker is down"
       have completely different fixes, so they are never collapsed into
       one answer here. */
    res.json({ ok: false, reason: "the worker is not reachable — " + (e && e.message) });
  }
});

app.post("/internal/agent/check", auth.requireInternal, express.json({ limit: "24mb" }), async (req, res) => {
  try {
    /* A build is minutes, not milliseconds, and the timeout has to be
       longer than the sandbox's own or the api gives up on a check that
       is still running and the caller retries it into a second slot. */
    const r = await toWorker("/internal/agent/check", {
      method: "POST", body: JSON.stringify(req.body || {})
    });
    const text = await r.text();
    res.status(r.status).type("application/json").send(text);
  } catch (e) {
    res.status(503).json({
      ok: false, infra: true, attested: false,
      reason: "the build service is not reachable — " + (e && e.message)
    });
  }
});

app.get("/internal/tls-ask", auth.requireInternal, async (req, res) => {
  const domain = String(req.query.domain || "").toLowerCase();
  if (!domain) return res.status(400).end();
  // The control plane has no deployments row — it is this service, not an
  // app — so it has to be allowed explicitly or Caddy can never obtain a
  // certificate for the one hostname the platform itself talks to.
  if (cfg.controlDomain && domain === cfg.controlDomain) return res.status(200).end();

  // custom_domain_verified is not optional here. Without it, attaching a
  // domain — which anyone with an account can do, for a name they do not own
  // — would be enough to make Souqi request a certificate for it on its own
  // Let's Encrypt account. That is the abuse the comment above describes, and
  // the fast route to a rate limit that would block real customers.
  const row = await one(
    `SELECT 1 FROM deployments
      WHERE status <> 'DELETED'
        AND (domain=$1 OR (custom_domain=$1 AND custom_domain_verified))`,
    [domain]
  );
  return row ? res.status(200).end() : res.status(404).end();
});

/* ---------- deployments ---------- */

/**
 * POST /deployments
 * Creates the record and queues it. Returns immediately — the build has
 * not started and will not have started when this responds.
 */
app.post("/deployments", requireUser, async (req, res, next) => {
  try {
    const projectId = String((req.body && req.body.projectId) || "");
    if (!projectId) return res.status(400).json({ error: "projectId is required" });

    const project = await one("SELECT * FROM projects WHERE id=$1 AND user_id=$2", [projectId, req.userId]);
    if (!project) return res.status(404).json({ error: "project not found" });

    // Admission is checked here as well as in the worker. Here it gives the
    // user an immediate, honest "not now" instead of a queued deployment
    // that fails minutes later.
    const admit = await capacity.canAdmit({ memoryMb: cfg.defaults.memoryMb });
    if (!admit.ok) {
      return res.status(503).json({ error: "no capacity right now — " + admit.reasons.join("; "), retryAfter: 300 });
    }

    const id = newId("dep");

    // The hostname is either generated or chosen. Generated derives from the
    // id, so it inherits the id's character set and can never contain
    // anything a DNS label disallows — that was the whole guarantee, and it
    // stops being free the moment a person types the label instead. Chosen
    // labels go through domains.validateSubdomain, which re-establishes it
    // and additionally refuses the names this platform needs for itself.
    let domain;
    const wanted = req.body && req.body.subdomain;
    if (wanted) {
      const v = domains.validateSubdomain(wanted, cfg.appDomain, cfg.controlDomain);
      if (!v.ok) return res.status(400).json({ error: v.error });
      domain = domains.hostnameFor(v.label, cfg.appDomain);
    } else {
      domain = domains.generatedHostname(id, cfg.appDomain);
    }

    // deployments.domain is UNIQUE, which is the real guard against two
    // tenants claiming one hostname — a check-then-insert would race.
    // 23505 is unique_violation; anything else is a genuine fault.
    try {
      await one(
        `INSERT INTO deployments
           (id, project_id, user_id, status, framework, domain, host_id, cpu_limit, memory_mb, pids_limit)
         VALUES ($1,$2,$3,'QUEUED',$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [id, projectId, req.userId, project.framework || "unknown", domain, cfg.hostId,
         cfg.defaults.cpu, cfg.defaults.memoryMb, cfg.defaults.pids]
      );
    } catch (e) {
      if (e && e.code === "23505") {
        return res.status(409).json({ error: "that name is already taken — try another" });
      }
      throw e;
    }
    await query("INSERT INTO domains (domain, deployment_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [domain, id]);
    await pipeline.log(id, "system", "Queued");

    res.status(201).json({ deploymentId: id, status: "QUEUED", url: "https://" + domain });
  } catch (e) { next(e); }
});

/**
 * GET /name-available?name=my-shop
 *
 * Answers the Configure screen while someone is typing. Deliberately NOT
 * mounted under /deployments/... — that path already has a :id route, and a
 * literal segment beside a parameter is the kind of ordering dependency that
 * works until somebody reorders the file.
 *
 * This is advisory. The authority is the partial unique index on
 * deployments(domain), enforced at INSERT, because anything checked here can
 * be taken between the check and the create.
 */
app.get("/name-available", requireUser, async (req, res, next) => {
  try {
    const v = domains.validateSubdomain(req.query.name, cfg.appDomain, cfg.controlDomain);
    if (!v.ok) return res.json({ available: false, reason: v.error });

    const host = domains.hostnameFor(v.label, cfg.appDomain);
    // Matches the live-only index: a deleted deployment does not hold a name.
    const taken = await one(
      "SELECT 1 FROM deployments WHERE domain=$1 AND status <> 'DELETED'", [host]
    );
    res.json({
      available: !taken,
      hostname: host,
      reason: taken ? "that name is already taken" : null
    });
  } catch (e) { next(e); }
});

/**
 * POST /deployments/:id/source
 * Receives the source as a flat {path: content} map and stages it where the
 * worker expects to find it. Kept separate from create so a redeploy can
 * replace the source without allocating a new hostname.
 */
app.post("/deployments/:id/source", requireUser, express.json({ limit: "24mb" }), async (req, res, next) => {
  try {
    const dep = await ownedDeployment(req, res); if (!dep) return;
    const files = (req.body && req.body.files) || null;
    if (!files || typeof files !== "object") return res.status(400).json({ error: "files is required" });

    const dir = path.join(cfg.buildRoot, "src", dep.id);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });

    for (const rel of Object.keys(files)) {
      // Path traversal check. Without it a file named ../../etc/cron.d/x
      // would be written outside the staging directory as the worker user.
      const clean = String(rel).replace(/\\/g, "/");
      if (clean.startsWith("/") || clean.split("/").includes("..")) {
        return res.status(400).json({ error: "unsafe path in upload: " + clean });
      }
      const dest = path.join(dir, clean);
      if (!dest.startsWith(dir + path.sep)) {
        return res.status(400).json({ error: "unsafe path in upload: " + clean });
      }
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, String(files[rel]), "utf8");
    }

    const spec = detect.detect(dir);
    if (spec) {
      await query("UPDATE deployments SET framework=$2 WHERE id=$1", [dep.id, spec.framework]);
      await query("UPDATE projects SET framework=$2, updated_at=now() WHERE id=$1", [dep.project_id, spec.framework]);
    }

    /* The build directory is scratch — cleanup wipes it after every
       deploy, and it only exists on one VM. Archiving here is what makes
       the source survive losing the box, and what lets a redeploy work
       on a host that has never seen this project.

       A storage failure does NOT fail the upload: the source is already
       staged locally and the deploy can proceed from it. It is reported
       instead, so "this is only on the VM" is visible rather than
       assumed. */
    let archived = null;
    /* available(), not isConfigured(). The archive no longer needs a bucket
       — with none configured it goes into Postgres, where the backup that
       already runs covers it. Gating on isConfigured() here would leave the
       Postgres path unreachable and the source on one disk, which is the
       exact thing this step exists to prevent. */
    if (objects.available()) {
      const put = await objects.putSource(dep.id, files);
      if (put.ok) {
        await query("UPDATE deployments SET source_key=$2 WHERE id=$1", [dep.id, put.key]);
        archived = { key: put.key, bytes: put.bytes };
      } else {
        archived = { error: put.error };
        console.warn("[api] source archive failed for " + dep.id + ": " + put.error);
      }
    }

    res.json({
      ok: true,
      files: Object.keys(files).length,
      detected: spec ? spec.framework : null,
      archived: archived
    });
  } catch (e) { next(e); }
});

app.get("/deployments/:id", requireUser, async (req, res, next) => {
  try {
    const dep = await ownedDeployment(req, res); if (!dep) return;
    res.json(publicView(dep));
  } catch (e) { next(e); }
});

/** Live state, cheap enough to poll while a build runs. */
app.get("/deployments/:id/status", requireUser, async (req, res, next) => {
  try {
    const dep = await ownedDeployment(req, res); if (!dep) return;
    // Read the worker's last observation rather than inspecting Docker, which
    // this container cannot do. seenAt is included so a caller can tell a
    // current answer from one the worker recorded before it died.
    const seen = dep.container_seen_at ? new Date(dep.container_seen_at) : null;
    const present = dep.container_state && dep.container_state !== "absent";
    res.json({
      status: dep.status,
      url: dep.domain ? "https://" + dep.domain : null,
      error: dep.error || null,
      container: present
        ? {
            state: dep.container_state,
            exitCode: dep.container_exit_code,
            restarts: dep.container_restarts,
            seenAt: seen ? seen.toISOString() : null,
            ageSeconds: seen ? Math.round((Date.now() - seen.getTime()) / 1000) : null
          }
        : null,
      // Advisory, every one of them. Ordered so the reader meets them in the
      // same sequence each time rather than in whatever order they finished.
      checks: (await many(
        `SELECT check_id, status, summary, detail
           FROM deployment_checks WHERE deployment_id=$1 ORDER BY check_id`,
        [dep.id]
      )).map((c) => ({
        id: c.check_id, status: c.status, summary: c.summary, detail: c.detail
      })),
      customDomain: dep.custom_domain
        ? { domain: dep.custom_domain, verified: dep.custom_domain_verified,
            target: dep.domain }
        : null,
      // Distinguishes "no container" from "nobody has looked yet".
      observed: Boolean(seen)
    });
  } catch (e) { next(e); }
});

/* ---------- custom domains ---------- */

/* The record a customer creates at their DNS provider points at the app's
   generated hostname, which already resolves here. That keeps the platform
   from handing out a bare IP it would then be unable to change. */
const cnameTarget = (dep) => dep.domain;

/**
 * Does `domain` actually resolve to `target`?
 *
 * CNAME first. Providers that flatten a CNAME at the apex into A records are
 * common enough that comparing resolved addresses is the difference between
 * "works" and "correctly configured but reads as broken" — the same fallback
 * the published-sites check uses.
 */
async function pointsAt(domain, target) {
  const t = String(target || "").toLowerCase().replace(/\.$/, "");
  if (!t) return false;
  try {
    const cnames = await dns.promises.resolveCname(domain).catch(() => []);
    if (cnames.some((r) => String(r).toLowerCase().replace(/\.$/, "") === t)) return true;
    const [mine, theirs] = await Promise.all([
      dns.promises.resolve4(domain).catch(() => []),
      dns.promises.resolve4(t).catch(() => [])
    ]);
    return mine.length > 0 && theirs.some((ip) => mine.includes(ip));
  } catch (e) { return false; }
}

/**
 * PUT /deployments/:id/domain   { domain }
 *
 * Attaches a custom domain, ALWAYS unverified. Nothing in this request proves
 * the caller owns the name, so nothing here may grant routing or a
 * certificate. It records the intent and returns the record to create.
 */
app.put("/deployments/:id/domain", requireUser, async (req, res, next) => {
  try {
    const dep = await ownedDeployment(req, res); if (!dep) return;
    const v = domains.validateCustomDomain(req.body && req.body.domain, cfg.appDomain);
    if (!v.ok) return res.status(400).json({ error: v.error });

    // Re-submitting the domain already attached must not reset verification,
    // or a stray save would take a working app off the air.
    if (dep.custom_domain === v.domain) {
      return res.json({
        domain: v.domain, verified: dep.custom_domain_verified, target: cnameTarget(dep)
      });
    }

    try {
      await query(
        `UPDATE deployments
            SET custom_domain=$2, custom_domain_verified=false, custom_domain_seen_at=NULL
          WHERE id=$1`,
        [dep.id, v.domain]
      );
    } catch (e) {
      // The partial unique index over live rows; another app holds this name.
      if (e && e.code === "23505") {
        return res.status(409).json({ error: "that domain is already connected to another app" });
      }
      throw e;
    }

    // Whatever was attached before stops being served now: it is no longer a
    // hostname this deployment answers on.
    if (dep.custom_domain && dep.custom_domain_verified) {
      await caddy.removeRoute(dep.custom_domain);
    }
    res.json({ domain: v.domain, verified: false, target: cnameTarget(dep) });
  } catch (e) { next(e); }
});

/**
 * POST /deployments/:id/domain/verify
 *
 * The only thing that can set custom_domain_verified, and therefore the only
 * thing that can make tls-ask accept the name. Verification is a live DNS
 * lookup against the record we asked for; until it passes, Caddy will not ask
 * Let's Encrypt for a certificate and the hostname is not routed.
 *
 * Routing is left to the worker's reconcile loop (within a minute) rather than
 * done here: adding a route needs the container name, and this process has no
 * Docker socket by design — see the note beside the imports.
 */
app.post("/deployments/:id/domain/verify", requireUser, async (req, res, next) => {
  try {
    const dep = await ownedDeployment(req, res); if (!dep) return;
    if (!dep.custom_domain) return res.status(400).json({ error: "no domain is attached" });

    const target = cnameTarget(dep);
    if (!(await pointsAt(dep.custom_domain, target))) {
      return res.json({
        domain: dep.custom_domain, verified: false, target,
        reason: "DNS does not point here yet — a new record can take a few minutes"
      });
    }

    await query(
      `UPDATE deployments SET custom_domain_verified=true, custom_domain_seen_at=now()
        WHERE id=$1`,
      [dep.id]
    );
    res.json({ domain: dep.custom_domain, verified: true, target });
  } catch (e) { next(e); }
});

/** DELETE /deployments/:id/domain — detach, and stop serving it immediately. */
app.delete("/deployments/:id/domain", requireUser, async (req, res, next) => {
  try {
    const dep = await ownedDeployment(req, res); if (!dep) return;
    if (dep.custom_domain && dep.custom_domain_verified) {
      await caddy.removeRoute(dep.custom_domain);
    }
    await query(
      `UPDATE deployments
          SET custom_domain=NULL, custom_domain_verified=false, custom_domain_seen_at=NULL
        WHERE id=$1`,
      [dep.id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** Queue a (re)deploy of whatever source is currently staged. */
async function enqueue(req, res) {
  const dep = await ownedDeployment(req, res); if (!dep) return;
  if (dep.status === "QUEUED" || dep.status === "BUILDING") {
    return res.status(409).json({ error: "this deployment is already in progress" });
  }
  await query("UPDATE deployments SET status='QUEUED', error=NULL, updated_at=now() WHERE id=$1", [dep.id]);
  await pipeline.log(dep.id, "system", "Queued");
  res.json({ deploymentId: dep.id, status: "QUEUED" });
}
app.post("/deployments/:id/deploy", requireUser, enqueue);
app.post("/deployments/:id/redeploy", requireUser, enqueue);

/* Lifecycle actions are QUEUED for the worker, not run here.
   They used to run inline, on the reasoning that stop/start/restart take
   seconds. The reasoning was sound and the code still could not work: every
   one of them ends in a docker command, and this container has no Docker
   socket by design. The docker CLI failed, the failure was not surfaced, and
   the caller got {"ok":true,"status":"STOPPED"} for a container that was
   still running — and, on delete, a row marked DELETED with the container,
   image, network and build directory all left behind for good.
   The worker holds the socket, so the worker does the work. */
async function queueAction(req, res, action) {
  const dep = await ownedDeployment(req, res); if (!dep) return;
  await query("UPDATE deployments SET pending_action=$2, updated_at=now() WHERE id=$1", [dep.id, action]);
  await pipeline.log(dep.id, "system", "Queued: " + action);
  // 202: accepted, not done. Clients poll /status for the result.
  res.status(202).json({ ok: true, action, status: dep.status, pending: true });
}

app.post("/deployments/:id/stop", requireUser, (req, res, next) =>
  queueAction(req, res, "stop").catch(next));

app.post("/deployments/:id/start", requireUser, (req, res, next) =>
  queueAction(req, res, "start").catch(next));

app.post("/deployments/:id/restart", requireUser, (req, res, next) =>
  queueAction(req, res, "restart").catch(next));

app.delete("/deployments/:id", requireUser, (req, res, next) =>
  queueAction(req, res, "destroy").catch(next));

/**
 * GET /deployments/:id/logs
 * Build logs come from the database (the build container is long gone);
 * runtime logs come from Docker. Users never run a docker command — this
 * handler picks the source and the flags.
 */
app.get("/deployments/:id/logs", requireUser, async (req, res, next) => {
  try {
    const dep = await ownedDeployment(req, res); if (!dep) return;
    const phase = String(req.query.phase || "build");
    const tail = Math.min(Number(req.query.tail) || 500, 2000);

    if (phase === "runtime") {
      // Asked of the worker, which holds the Docker socket. Doing it here
      // cannot work and previously reported the failure as "the container is
      // not running", which was frequently untrue.
      let l = null, why = null;
      try {
        const r = await fetch(cfg.workerUrl + "/internal/logs/" + encodeURIComponent(dep.id) + "?tail=" + tail, {
          headers: { "x-internal-token": cfg.internalToken },
          signal: AbortSignal.timeout(10000)
        });
        if (r.ok) l = await r.json();
        // Distinguish "cannot reach the worker" from "the worker said no" —
        // the two have completely different fixes.
        else why = "the worker refused the request (HTTP " + r.status + ")";
      } catch (e) { why = "the worker is not reachable — " + e.message; }

      if (!l) {
        return res.status(503).json({ phase: "runtime", lines: [], note: "runtime logs are unavailable — " + why });
      }
      return res.json({
        phase: "runtime",
        lines: l.ok ? String(l.out || "").split("\n").filter(Boolean) : [],
        note: l.ok ? null : l.error
      });
    }

    const rows = await many(
      "SELECT phase, stream, line, at FROM deployment_logs WHERE deployment_id=$1 ORDER BY id DESC LIMIT $2",
      [dep.id, tail]
    );
    res.json({ phase: "build", lines: rows.reverse() });
  } catch (e) { next(e); }
});

/* ---------- project env ----------
   Values go in and are never selected back out. GET returns keys and a
   masked tail only, so a compromised session cannot read the secrets it
   can overwrite. */
app.get("/projects/:id/env", requireUser, async (req, res, next) => {
  try {
    const project = await one("SELECT * FROM projects WHERE id=$1 AND user_id=$2", [req.params.id, req.userId]);
    if (!project) return res.status(404).json({ error: "project not found" });
    const rows = await many("SELECT key, value_enc, updated_at FROM project_env WHERE project_id=$1 ORDER BY key", [project.id]);
    res.json({
      env: rows.map((r) => {
        let masked = "••••";
        try { masked = secrets.mask(secrets.decrypt(r.value_enc)); } catch (e) { /* unreadable stays masked */ }
        return { key: r.key, masked: masked, updatedAt: r.updated_at };
      })
    });
  } catch (e) { next(e); }
});

app.put("/projects/:id/env", requireUser, async (req, res, next) => {
  try {
    const project = await one("SELECT * FROM projects WHERE id=$1 AND user_id=$2", [req.params.id, req.userId]);
    if (!project) return res.status(404).json({ error: "project not found" });

    const entries = Object.entries((req.body && req.body.env) || {});
    if (!entries.length) return res.status(400).json({ error: "env is required" });

    for (const [k, v] of entries) {
      const ke = secrets.validateKey(k);
      if (ke) return res.status(400).json({ error: k + ": " + ke });
      const ve = secrets.validateValue(v);
      if (ve) return res.status(400).json({ error: k + ": " + ve });
    }
    for (const [k, v] of entries) {
      await query(
        `INSERT INTO project_env (project_id, key, value_enc) VALUES ($1,$2,$3)
         ON CONFLICT (project_id, key) DO UPDATE SET value_enc=EXCLUDED.value_enc, updated_at=now()`,
        [project.id, k, secrets.encrypt(v)]
      );
    }
    res.json({ ok: true, saved: entries.length, note: "redeploy for these to take effect" });
  } catch (e) { next(e); }
});

app.delete("/projects/:id/env/:key", requireUser, async (req, res, next) => {
  try {
    const project = await one("SELECT * FROM projects WHERE id=$1 AND user_id=$2", [req.params.id, req.userId]);
    if (!project) return res.status(404).json({ error: "project not found" });
    await query("DELETE FROM project_env WHERE project_id=$1 AND key=$2", [project.id, req.params.key]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------- project database ----------
   Every deployed app gets a Postgres database, created on its first deploy
   and injected as SOUQI_DATABASE_URL. These routes let someone see it,
   point the project at their own database instead, or remove one.

   Nothing here provisions anything. Creating a database means
   `docker exec souqi-userdb psql`, and this container has no socket — the
   same rule that sends stop/start/restart/destroy to the worker sends
   these there too. */

/** The row, in a shape the browser can render, with nothing secret in it. */
function databaseView(row) {
  if (!row) {
    return {
      configured: false,
      mode: "builtin",
      // Not an error state. Every project gets one; this one has simply not
      // deployed yet, and saying so beats an empty panel.
      note: "a database will be created for this project on its first deploy"
    };
  }
  let masked = "••••";
  if (row.secret_enc) {
    try { masked = secrets.mask(secrets.decrypt(row.secret_enc)); }
    catch (e) { masked = "••••"; }
  }
  return {
    configured: true,
    mode: row.mode,
    name: row.db_name,
    role: row.db_role,
    // A connection string carries a password, so the full value never comes
    // back to a browser — not once, not on a "reveal". The app is handed it
    // through the environment; a human never needs to read it.
    masked: masked,
    builtinKept: row.builtin_kept,
    sizeBytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
    sizeSeenAt: row.size_seen_at,
    // Postgres has no per-database quota, so this number is observation and
    // not a limit. Saying so here keeps the UI from implying an enforcement
    // the storage layer cannot provide.
    sizeIsAdvisory: true,
    updatedAt: row.updated_at
  };
}

async function ownedProject(req, res) {
  const project = await one("SELECT * FROM projects WHERE id=$1 AND user_id=$2", [req.params.id, req.userId]);
  if (!project) { res.status(404).json({ error: "project not found" }); return null; }
  return project;
}

app.get("/projects/:id/database", requireUser, async (req, res, next) => {
  try {
    const project = await ownedProject(req, res); if (!project) return;
    const row = await one("SELECT * FROM project_databases WHERE project_id=$1", [project.id]);
    res.json({ database: databaseView(row) });
  } catch (e) { next(e); }
});

/**
 * PUT /projects/:id/database  { mode: "builtin" | "external", url? }
 *
 * Switching to external VALIDATES FIRST: one connection and a SELECT 1,
 * from this container, which sits on the platform network and has egress.
 * A URL that does not work is refused here with the reason, instead of
 * being stored and discovered as a crash loop three minutes into a deploy.
 */
app.put("/projects/:id/database", requireUser, async (req, res, next) => {
  try {
    const project = await ownedProject(req, res); if (!project) return;
    const mode = String((req.body && req.body.mode) || "").trim();
    if (mode !== "builtin" && mode !== "external") {
      return res.status(400).json({ error: "mode must be builtin or external" });
    }

    const existing = await one("SELECT * FROM project_databases WHERE project_id=$1", [project.id]);

    if (mode === "external") {
      const url = String((req.body && req.body.url) || "").trim();
      if (!url) return res.status(400).json({ error: "url is required to connect an external database" });

      const shape = externalDb.parse(url);
      if (!shape.ok) return res.status(400).json({ error: shape.error });
      const reachable = await externalDb.test(url);
      if (!reachable.ok) return res.status(400).json({ error: reachable.error });

      /* The built-in database is KEPT, not dropped. Changing a setting must
         never be the thing that destroys someone's data, and a customer who
         switches and then changes their mind would have no way back.
         Removing it is the DELETE below, which they have to ask for. */
      const keep = Boolean(existing && (existing.mode === "builtin" || existing.builtin_kept));
      await query(
        `INSERT INTO project_databases (project_id, mode, db_name, db_role, secret_enc, builtin_kept, updated_at)
              VALUES ($1,'external',$2,$3,$4,$5, now())
         ON CONFLICT (project_id) DO UPDATE
              SET mode='external', db_name=$2, db_role=$3,
                  secret_enc=$4, builtin_kept=$5, updated_at=now()`,
        [project.id, shape.url.pathname.slice(1), shape.url.username || null, secrets.encrypt(url), keep]
      );
      /* db_name and db_role now describe the EXTERNAL database, because
         that is what the panel shows and what the customer would recognise.
         Nothing depends on them to find the built-in one: its names are
         derived from the project id every time (dbproviders/builtin), which
         is why they can be overwritten here without stranding it. */
      return res.json({
        ok: true,
        mode: "external",
        builtinKept: keep,
        note: keep
          ? "connected — your built-in database is kept and unchanged; redeploy for this to take effect"
          : "connected — redeploy for this to take effect"
      });
    }

    /* Back to built-in. The stored external URL goes with it: it is the
       customer's credential for someone else's system, and once it is not
       in use there is no reason for us to still be holding it. */
    if (existing && existing.mode === "external") {
      /* Clearing secret_enc means the next deploy reissues the password and
         writes a new one. That is safe: provision() re-sets the password on
         the role that already exists, so the database and everything in it
         is still there — only the credential changes. */
      await query(
        `UPDATE project_databases
            SET mode='builtin', db_name=NULL, db_role=NULL,
                secret_enc=NULL, builtin_kept=false, updated_at=now()
          WHERE project_id=$1`,
        [project.id]
      );
      /* Coming back cancels any queued removal of this very database.
         Asking to delete it and then changing your mind must not leave a
         worker holding an instruction to delete the database the project
         is now using — the worker re-checks for exactly this reason, and
         withdrawing the request here means it never has to. */
      await query(
        "UPDATE projects SET pending_action=NULL WHERE id=$1 AND pending_action='drop-db'",
        [project.id]
      );
      return res.json({ ok: true, mode: "builtin", note: "switched back — redeploy for this to take effect" });
    }
    res.json({ ok: true, mode: "builtin", note: "already using the built-in database" });
  } catch (e) { next(e); }
});

/**
 * Refresh the recorded size. Reading it means running psql inside the
 * userdb container, so the worker is asked — the same route runtime logs
 * take, for the same reason.
 */
app.post("/projects/:id/database/measure", requireUser, async (req, res, next) => {
  try {
    const project = await ownedProject(req, res); if (!project) return;
    const row = await one("SELECT * FROM project_databases WHERE project_id=$1", [project.id]);
    if (!row) return res.status(404).json({ error: "this project has no database yet" });

    try {
      const r = await fetch(cfg.workerUrl + "/internal/db/measure/" + encodeURIComponent(project.id), {
        method: "POST",
        headers: { "x-internal-token": cfg.internalToken },
        signal: AbortSignal.timeout(15000)
      });
      if (!r.ok) return res.status(503).json({ error: "the worker refused the request (HTTP " + r.status + ")" });
      const out = await r.json();
      if (!out.ok) return res.status(503).json({ error: out.error || "the database could not be reached" });
      const fresh = await one("SELECT * FROM project_databases WHERE project_id=$1", [project.id]);
      return res.json({ database: databaseView(fresh) });
    } catch (e) {
      return res.status(503).json({ error: "the worker is not reachable — " + e.message });
    }
  } catch (e) { next(e); }
});

/**
 * GET /projects/:id/database/browse         — the tables
 * GET /projects/:id/database/browse?table=x — one page of one table
 *
 * Read-only, and read-only because of what it CANNOT express rather than
 * a rule it follows: the client names a table and a page. There is no
 * parameter here that carries SQL, and the table name is checked against
 * the database's own catalogue before it is used, so the string that
 * reaches a query is one Postgres produced.
 *
 * Asked of the worker, like every other read that needs the socket.
 */
app.get("/projects/:id/database/browse", requireUser, async (req, res, next) => {
  try {
    const project = await ownedProject(req, res); if (!project) return;

    const qs = new URLSearchParams();
    if (req.query.table) qs.set("table", String(req.query.table));
    if (req.query.limit) qs.set("limit", String(req.query.limit));
    if (req.query.offset) qs.set("offset", String(req.query.offset));

    try {
      const r = await fetch(cfg.workerUrl + "/internal/db/browse/" + encodeURIComponent(project.id) +
        (qs.toString() ? "?" + qs.toString() : ""), {
        headers: { "x-internal-token": cfg.internalToken },
        signal: AbortSignal.timeout(20000)
      });
      if (!r.ok) return res.status(503).json({ error: "the worker refused the request (HTTP " + r.status + ")" });
      const out = await r.json();
      // A table that is not there is the caller's mistake, not an outage.
      if (!out.ok) return res.status(out.notFound ? 404 : 503).json({ error: out.error || "could not read the database" });
      return res.json(out);
    } catch (e) {
      return res.status(503).json({ error: "the worker is not reachable — " + e.message });
    }
  } catch (e) { next(e); }
});

/**
 * DELETE /projects/:id/database — remove the built-in database for good.
 *
 * Refused while it is the one the project is actually using. There is no
 * undo and no fallback: the next deploy would create an empty database of
 * the same name, so the only visible result would be that the data is
 * gone. Connect an external database first, then remove this one — which
 * makes the destructive step a deliberate second action rather than a
 * surprise.
 */
app.delete("/projects/:id/database", requireUser, async (req, res, next) => {
  try {
    const project = await ownedProject(req, res); if (!project) return;
    const row = await one("SELECT * FROM project_databases WHERE project_id=$1", [project.id]);
    if (!row) return res.status(404).json({ error: "this project has no database" });
    if (row.mode === "builtin") {
      return res.status(409).json({
        error: "this is the database your app is using — connect an external one first, then remove it"
      });
    }
    if (!row.builtin_kept) {
      return res.status(409).json({ error: "there is no built-in database to remove for this project" });
    }
    await query("UPDATE projects SET pending_action='drop-db', updated_at=now() WHERE id=$1", [project.id]);
    res.status(202).json({ ok: true, pending: true, note: "removing your built-in database" });
  } catch (e) { next(e); }
});

/* ---------- projects ---------- */

/**
 * DELETE /projects/:id — the whole project.
 *
 * Queued, and the row is deliberately left in place for the worker to
 * remove last. Deleting it here would cascade the deployments away in the
 * same statement, and their containers, images, networks and source
 * archives would keep running on the host with nothing left to say they
 * ever existed.
 */
app.delete("/projects/:id", requireUser, async (req, res, next) => {
  try {
    const project = await ownedProject(req, res); if (!project) return;
    await query("UPDATE projects SET pending_action='delete', updated_at=now() WHERE id=$1", [project.id]);
    res.status(202).json({ ok: true, pending: true, note: "deleting this project and everything in it" });
  } catch (e) { next(e); }
});

app.post("/projects", requireUser, async (req, res, next) => {
  try {
    const name = String((req.body && req.body.name) || "").trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: "name is required" });
    await ensureUser(req.user);
    const id = newId("prj");
    const p = await one("INSERT INTO projects (id, user_id, name) VALUES ($1,$2,$3) RETURNING *",
      [id, req.userId, name]);
    res.status(201).json({ projectId: p.id, name: p.name });
  } catch (e) { next(e); }
});

app.get("/projects", requireUser, async (req, res, next) => {
  try {
    const rows = await many(
      `SELECT p.*, (
         SELECT row_to_json(d) FROM (
           SELECT id, status, domain FROM deployments
            WHERE project_id = p.id AND status <> 'DELETED'
            ORDER BY created_at DESC LIMIT 1
         ) d
       ) AS latest
       FROM projects p WHERE p.user_id=$1 ORDER BY p.updated_at DESC`,
      [req.userId]
    );
    res.json({ projects: rows });
  } catch (e) { next(e); }
});

/* ---------- errors ----------
   One handler, so no route can leak a stack trace or a query string that
   might carry a secret. */
app.use((err, req, res, next) => {
  console.error("[api]", req.method, req.path, err.message);
  res.status(500).json({ error: "something went wrong on our side" });
});

async function start() {
  // Auth problems are fatal, not advisory. A forgeable session secret or a
  // dev-auth header left on in production is not a configuration smell — it
  // is anyone being able to deploy as anyone, and the only safe response is
  // to refuse to start rather than serve while broken.
  const authCfg = auth.assertAuthConfig();
  for (const w of authCfg.warn) console.warn("[api] " + w);
  if (authCfg.fatal.length) {
    console.error("[api] FATAL — refusing to start:");
    for (const f of authCfg.fatal) console.error("  - " + f);
    process.exit(1);
  }

  const problems = assertProductionReady();
  if (problems.length) {
    console.warn("[api] not production-ready:");
    for (const p of problems) console.warn("  - " + p);
  }
  await fsp.mkdir(path.join(cfg.buildRoot, "src"), { recursive: true }).catch(() => {});

  // Caddy calls this before issuing any certificate, so the URL carries the
  // shared secret as a query parameter — Caddy on-demand ask cannot set a
  // header. It travels only on the internal platform network.
  const askUrl = "http://api:" + cfg.apiPort + "/internal/tls-ask"
    + (cfg.internalToken ? "?token=" + encodeURIComponent(cfg.internalToken) : "");
  const applied = await caddy.applyBaseConfig(askUrl);
  console.log("[api] caddy base config:", applied.ok ? "applied" : "unavailable (" + (applied.error || "") + ")");

  app.listen(cfg.apiPort, () => console.log("[api] listening on :" + cfg.apiPort));
}

if (require.main === module) start();

module.exports = { app, start };
