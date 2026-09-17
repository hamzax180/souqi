/* =================================================================
   worker/index.js — the queue loop
   -----------------------------------------------------------------
   Postgres IS the queue. At ten clients, adding Redis or a broker
   would be a second thing to run, monitor and back up in exchange
   for throughput nobody needs. SELECT ... FOR UPDATE SKIP LOCKED is
   a real work queue: two workers polling the same table never hand
   the same row to both, so scaling out later is starting a second
   process, not swapping the queue.

   The loop also reconciles. Docker is the source of truth for what
   is actually running, and the database drifts from it whenever the
   host reboots or a container is killed out of band.
   ================================================================= */
"use strict";

const dns = require("dns");
const path = require("path");
const { cfg } = require("../config");
const { pool, query, many, one } = require("../db");
const engine = require("../docker/engine");
const caddy = require("../proxy/caddy");
const domains = require("../domains");
const capacity = require("../monitor/capacity");
const agentRunner = require("../agent/runner");
const agentSandbox = require("../agent/sandbox");
const pipeline = require("./pipeline");
const cleanup = require("../monitor/cleanup");

const POLL_MS = 2000;
const RECONCILE_MS = 60000;
const CLEANUP_MS = 15 * 60 * 1000;

let running = true;

/**
 * Claim one queued deployment.
 *
 * FOR UPDATE SKIP LOCKED is the whole reason this is safe to run in more
 * than one process: the row is locked for this transaction, and any other
 * worker looking at the same instant skips past it rather than blocking or
 * double-claiming.
 */
async function claimNext() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM deployments
        WHERE status = 'QUEUED' AND host_id = $1
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [cfg.hostId]
    );
    if (!rows.length) { await client.query("COMMIT"); return null; }
    const dep = rows[0];
    // Move it out of QUEUED inside the same transaction, so a crash between
    // claiming and building cannot leave it invisible to every worker.
    await client.query("UPDATE deployments SET status='BUILDING', updated_at=now() WHERE id=$1", [dep.id]);
    await client.query("COMMIT");
    return dep;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (e2) { /* already gone */ }
    console.error("[worker] claim failed:", e.message);
    return null;
  } finally {
    client.release();
  }
}

/**
 * Claim one queued lifecycle action, the same way deployments are claimed.
 *
 * These live in the worker rather than the API because they end in docker
 * commands, and the API has no socket to run them against.
 */
async function claimNextAction() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM deployments
        WHERE pending_action IS NOT NULL AND host_id = $1
        ORDER BY updated_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [cfg.hostId]
    );
    if (!rows.length) { await client.query("COMMIT"); return null; }
    const dep = rows[0];
    // Clear it inside the same transaction: a crash mid-action must not leave
    // the row spinning through the same command forever.
    await client.query("UPDATE deployments SET pending_action=NULL WHERE id=$1", [dep.id]);
    await client.query("COMMIT");
    return dep;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (e2) { /* already gone */ }
    console.error("[worker] action claim failed:", e.message);
    return null;
  } finally {
    client.release();
  }
}

const ACTIONS = {
  stop: (dep) => pipeline.stop(dep),
  start: (dep) => pipeline.start(dep),
  restart: (dep) => pipeline.restart(dep),
  destroy: (dep) => pipeline.destroy(dep)
};

/**
 * Claim one queued PROJECT action, the same way deployments are claimed.
 *
 * Projects have their own queue because deleting one is not a lifecycle
 * action on any single deployment: it tears down every deployment the
 * project has AND drops its database, and the two have to happen in that
 * order on one machine that can see Docker.
 */
async function claimNextProjectAction() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM projects
        WHERE pending_action IS NOT NULL
        ORDER BY updated_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1`
    );
    if (!rows.length) { await client.query("COMMIT"); return null; }
    const project = rows[0];
    await client.query("UPDATE projects SET pending_action=NULL WHERE id=$1", [project.id]);
    await client.query("COMMIT");
    return project;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (e2) { /* already gone */ }
    console.error("[worker] project action claim failed:", e.message);
    return null;
  } finally {
    client.release();
  }
}

/**
 * Delete a project and everything it owns.
 *
 * Order is the whole job. Containers, images, networks and source archives
 * go first, one deployment at a time, because each is a docker command that
 * needs its row to know what to remove. The database goes next. The project
 * row goes LAST, and only then, because deleting it cascades the deployment
 * rows away — do it any earlier and the containers are still on the host
 * with nothing left that knows their names.
 *
 * Deployments are destroyed inline rather than queued back through
 * pending_action. This already IS the worker: queueing would mean the
 * project row had to survive several more ticks in a half-deleted state,
 * with no way to tell that state apart from a stalled delete.
 */
async function deleteProject(project) {
  const deps = await many(
    "SELECT * FROM deployments WHERE project_id=$1 AND status <> 'DELETED'",
    [project.id]
  );
  for (const dep of deps) {
    try { await pipeline.destroy(dep); }
    catch (e) { console.error("[worker] destroy", dep.id, "during project delete:", e.message); }
  }

  // keepRow: the DELETE below cascades project_databases away anyway, and
  // deleting it twice would be two statements saying the same thing.
  const db = await pipeline.deleteProjectDatabase(project.id, { keepRow: true });
  if (!db.ok) console.error("[worker] project", project.id, "database:", db.error);

  await query("DELETE FROM projects WHERE id=$1", [project.id]);
  return { ok: true, deployments: deps.length, database: db };
}

const PROJECT_ACTIONS = {
  delete: (project) => deleteProject(project),
  // The kept built-in database, after a project moved to an external one.
  // The row survives: the project still HAS a database, just not this one.
  "drop-db": async (project) => {
    /* Re-read the mode HERE, not at the request that queued this.
       The api refuses to drop a database the project is using, but that
       check happens seconds or minutes before this runs, and in between
       the customer can switch back to built-in — at which point this is
       queued work to delete the database their app is now pointed at.
       It happened in testing: switch to external, ask to remove the kept
       database, change your mind, and the drop still landed.

       Ownership of the decision belongs to the state at the moment of the
       destructive act, so it is re-read at the moment of the act. */
    const row = await one("SELECT mode, builtin_kept FROM project_databases WHERE project_id=$1", [project.id]);
    if (!row) return { ok: true, skipped: true, reason: "this project has no database" };
    if (row.mode === "builtin") {
      console.log("[worker] project", project.id, "is back on its built-in database — drop cancelled");
      return { ok: true, skipped: true, reason: "the project is using this database again" };
    }
    if (!row.builtin_kept) {
      return { ok: true, skipped: true, reason: "there is no kept built-in database to remove" };
    }

    const r = await pipeline.deleteProjectDatabase(project.id, { keepRow: true });
    if (r.ok) {
      await query(
        "UPDATE project_databases SET builtin_kept=false, size_bytes=NULL, size_seen_at=NULL, updated_at=now() WHERE project_id=$1",
        [project.id]
      );
    }
    return r;
  }
};

async function tickProjectAction() {
  const project = await claimNextProjectAction();
  if (!project) return false;
  const fn = PROJECT_ACTIONS[project.pending_action];
  if (!fn) {
    console.error("[worker] unknown project action", project.pending_action, "on", project.id);
    return true;
  }
  console.log("[worker] project", project.pending_action, project.id);
  try {
    const r = await fn(project);
    console.log("[worker] project", project.id, project.pending_action,
      r && r.ok === false ? "-> FAILED " + r.error : "-> ok");
  } catch (e) {
    console.error("[worker] project", project.id, project.pending_action, "threw:", e.message);
  }
  return true;
}

async function tickAction() {
  const dep = await claimNextAction();
  if (!dep) return false;
  const fn = ACTIONS[dep.pending_action];
  if (!fn) {
    console.error("[worker] unknown action", dep.pending_action, "on", dep.id);
    return true;
  }
  console.log("[worker]", dep.pending_action, dep.id);
  try {
    const r = await fn(dep);
    console.log("[worker]", dep.id, dep.pending_action, r && r.ok === false ? "-> FAILED " + r.error : "-> ok");
  } catch (e) {
    console.error("[worker]", dep.id, dep.pending_action, "threw:", e.message);
    await pipeline.log(dep.id, "system", dep.pending_action + " failed: " + e.message, "stderr");
  }
  return true;
}

function sourceDirFor(dep) {
  // Phase 1: the API writes the upload here. Phase 2 swaps this for a pull
  // from object storage using dep.source_key — the pipeline takes a
  // directory either way, so only this function changes.
  return path.join(cfg.buildRoot, "src", String(dep.id));
}

async function tick() {
  const dep = await claimNext();
  if (!dep) return false;
  console.log("[worker] deploying", dep.id, "for project", dep.project_id);
  const res = await pipeline.deploy(dep, sourceDirFor(dep));
  console.log("[worker]", dep.id, res.ok ? "-> RUNNING " + res.url : "-> FAILED " + res.error);
  return true;
}

/**
 * Bring the database back in line with Docker.
 *
 * Three drifts matter, and all three are invisible without this:
 *   - a row says RUNNING but the container is gone (host rebooted)
 *   - a container is running but has no proxy route (Caddy restarted)
 *   - a row is stuck in BUILDING (the worker died mid-build)
 */
/* A managed database can move. The forwarder dials a literal address, so when
   the provider rotates it the app keeps working right up until the old address
   stops answering — the worst kind of breakage, because nothing changed on our
   side. Re-resolving here turns that into a self-healing minute rather than a
   support ticket. */
async function reconcileDbForwarders() {
  for (const p of await engine.listDbProxies()) {
    const live = await engine.dbProxyTarget(p.deploymentId);
    if (!live) continue;
    let addr = null;
    try { addr = (await dns.promises.lookup(p.host, { family: 4 })).address; }
    catch (e) { continue; }              // a DNS blip must not tear down a working pipe
    if (!addr || addr === live.ip) continue;

    const again = await engine.runDbProxy({
      deploymentId: p.deploymentId, host: p.host, targetIp: addr, port: p.port
    });
    console.log("[worker] " + p.host + " moved " + live.ip + " -> " + addr +
      (again.ok ? ", forwarder repointed" : ", could not repoint: " + again.error));
    if (again.ok) {
      await pipeline.log(p.deploymentId, "system",
        "Your database moved to a new address; the forwarder was repointed at it");
    }
  }
}

async function reconcile() {
  try {
    const rows = await many(
      "SELECT * FROM deployments WHERE host_id=$1 AND status IN ('RUNNING','STARTING','BUILDING')",
      [cfg.hostId]
    );
    const routes = await caddy.listRoutes();
    const routed = new Set(routes.map((r) => (r["@id"] || "").replace(/^route_/, "")));

    for (const dep of rows) {
      // A build that has been going for over 30 minutes is not going to
      // finish — the worker that owned it is gone.
      if (dep.status === "BUILDING" && Date.now() - new Date(dep.updated_at).getTime() > 30 * 60 * 1000) {
        await pipeline.setStatus(dep.id, "FAILED", { error: "the build was interrupted and did not resume" });
        await pipeline.log(dep.id, "system", "FAILED: build interrupted", "stderr");
        continue;
      }
      if (dep.status === "BUILDING") continue;

      const st = await engine.inspectState(dep.id);
      // Record what Docker says, so the API can answer questions about the
      // container without needing a socket it deliberately does not have.
      await query(
        `UPDATE deployments
            SET container_state=$2, container_exit_code=$3, container_restarts=$4, container_seen_at=now()
          WHERE id=$1`,
        [dep.id, st.exists ? st.status : "absent",
         st.exists ? st.exitCode : null, st.exists ? st.restarts : null]
      );
      if (!st.exists) {
        await pipeline.setStatus(dep.id, "STOPPED", { error: "the container is no longer present on this host" });
        for (const host of domains.hostnamesFor(dep)) await caddy.removeRoute(host);
        continue;
      }
      if (st.status === "running" && dep.status !== "RUNNING") {
        await pipeline.setStatus(dep.id, "RUNNING", { error: null });
      }
      if (st.status === "exited" && dep.status === "RUNNING") {
        await pipeline.setStatus(dep.id, "STOPPED", { error: "the app exited with code " + st.exitCode });
      }
      // Re-add a route Caddy has forgotten. Cheap, idempotent, and the
      // difference between a working app and a 502 nobody can explain.
      if (st.status === "running") {
        for (const host of domains.hostnamesFor(dep)) {
          if (routed.has(host)) continue;
          await caddy.addRoute(host, engine.containerName(dep.id), dep.internal_port || 3000);
          console.log("[worker] re-added missing route for", host);
        }
      }
    }

    await reconcileDbForwarders().catch(() => { });

    // Heartbeat. Cheap, and it is what lets /health distinguish "the worker
    // is fine" from "nothing has processed a deployment for an hour".
    const dockerVersion = await engine.version();
    await query(
      "UPDATE hosts SET docker_version=$2, worker_seen_at=now() WHERE id=$1",
      [cfg.hostId, dockerVersion || null]
    );

    const health = await capacity.alerts();
    for (const a of health.alerts) {
      console.warn("[alert]", a.level, a.metric, a.message);
    }
  } catch (e) {
    console.error("[worker] reconcile failed:", e.message);
  }
}

/**
 * The worker's internal read API.
 *
 * Runtime logs are `docker logs`, and only this process can run it. The api
 * used to call engine.logs() itself, which always failed there for want of a
 * socket and was reported to the user as "the container is not running" — a
 * statement about the api's own permissions dressed up as a fact about their
 * app. So the api asks here instead.
 *
 * Not published, platform network only, and the internal token is required.
 */
function startInternalServer() {
  const express = require("express");
  const app = express();

  app.use((req, res, next) => {
    if (!cfg.internalToken) return res.status(503).json({ error: "internal API is not configured" });
    const given = req.header("x-internal-token") || "";
    const a = Buffer.from(given), b = Buffer.from(cfg.internalToken);
    const crypto = require("crypto");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  });

  /* ── the code agent's build verifier ────────────────────────────
     Here rather than on the api for the same reason runtime logs are:
     this process holds the Docker socket and the api does not. A
     verifier that cannot create a container reports every check as a
     defect in the user's code instead of as its own missing
     permission, which is the mistake the note above describes. */

  app.get("/internal/agent/health", async (req, res) => {
    /* Whether a check COULD run, not whether this process is up. The
       agent worker refuses to claim work when this says no, so an
       unreachable daemon has to surface here and not three minutes
       into somebody's build. */
    const v = await engine.version().catch(() => null);
    const st = agentRunner.state();
    res.json({
      ok: !!v, image: agentSandbox.IMAGE,
      slots: st.slots, inFlight: st.inFlight,
      limits: {
        cpu: agentSandbox.DEFAULTS.cpu, memoryMb: agentSandbox.DEFAULTS.memoryMb,
        pids: agentSandbox.DEFAULTS.pids, timeoutMs: agentSandbox.DEFAULTS.timeoutMs
      }
    });
  });

  app.post("/internal/agent/check", express.json({ limit: "24mb" }), async (req, res) => {
    const body = req.body || {};
    const checkId = String(body.checkId || "").replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 64);
    const runId = String(body.runId || "").slice(0, 64);
    if (!checkId) return res.status(400).json({ error: "checkId is required" });

    const files = body.files;
    if (!files || typeof files !== "object" || Array.isArray(files)) {
      return res.status(400).json({ error: "files must be an object of path -> contents" });
    }

    /* Re-validated here, not trusted. The model's own write boundary
       already refuses a traversal, but this is a different process
       reading a payload off a network and it does not get to assume the
       sender was the one that checked it. */
    const safe = {};
    for (const [p, contents] of Object.entries(files)) {
      const rel = agentSandbox.safeRelPath(p);
      if (!rel) return res.status(400).json({ error: "unsafe path in files: " + String(p).slice(0, 80) });
      if (typeof contents !== "string") return res.status(400).json({ error: "contents must be a string: " + rel });
      safe[rel] = contents;
    }
    if (!Object.keys(safe).length) return res.status(400).json({ error: "files is empty" });

    /* Computed here, not taken from the caller. A result carrying the
       caller's idea of the hash proves nothing about what was built. */
    const sourceHash = agentSandbox.hashFiles(safe);
    if (body.sourceHash && body.sourceHash !== sourceHash) {
      return res.status(409).json({
        error: "the files do not hash to the sourceHash given",
        expected: body.sourceHash, actual: sourceHash
      });
    }

    /* An optional command, validated HERE against the plane's own
       allowlist. The tool that asked has its own copy of the rules for
       the model to read; this is the process holding the Docker socket,
       and it does not get to assume the caller checked anything. */
    let argv = null;
    if (body.command) {
      try { argv = agentSandbox.assertAllowed(agentSandbox.tokenize(String(body.command))); }
      catch (e) { return res.status(400).json({ error: String(e.message || e), refused: true }); }
    }

    const result = await agentRunner.check({ checkId, runId, files: safe, sourceHash, argv });
    res.json(Object.assign({ checkId, sourceHash }, result));
  });

  app.get("/internal/logs/:id", async (req, res) => {
    const tail = Math.min(Number(req.query.tail) || 500, 2000);
    // The id comes from the api, which resolved it from a row the caller
    // owns; engine.logs sanitises it into a container name regardless.
    const l = await engine.logs(String(req.params.id), { tail });
    res.json({ ok: l.ok, out: l.ok ? l.out : "", error: l.ok ? null : "the container has no logs on this host" });
  });

  app.get("/internal/state/:id", async (req, res) => {
    res.json(await engine.inspectState(String(req.params.id)));
  });

  /* Measuring a database means running psql inside the userdb container,
     which is a Docker command — so it lives here for the same reason the
     logs endpoint does. The api resolved the project from a row the caller
     owns; the provider sanitises the id into an identifier regardless. */
  app.post("/internal/db/measure/:projectId", async (req, res) => {
    const r = await pipeline.measureProjectDatabase(String(req.params.projectId));
    res.json(r);
  });

  /* The data browser. Same reason as the two above: reading a tenant's
     tables is `docker exec … psql`, and only this process has the socket.

     The api resolved the project from a row the caller owns, and the
     table name is validated against the catalogue inside the provider —
     nothing here concatenates a client string into a query. */
  app.get("/internal/db/browse/:projectId", async (req, res) => {
    const r = await pipeline.browseProjectDatabase(String(req.params.projectId), {
      table: req.query.table ? String(req.query.table) : null,
      limit: req.query.limit,
      offset: req.query.offset
    });
    res.json(r);
  });

  return app.listen(cfg.workerPort, () =>
    console.log("[worker] internal API on :" + cfg.workerPort));
}

async function main() {
  console.log("[worker] host=" + cfg.hostId + " build-root=" + cfg.buildRoot);

  const v = await engine.version();
  if (!v) {
    console.error("[worker] cannot reach the Docker daemon — is the socket mounted?");
    process.exit(1);
  }
  console.log("[worker] docker", v);

  await engine.ensureAppNetwork();

  const internal = startInternalServer();

  const shutdown = () => { running = false; internal.close(); console.log("[worker] draining"); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  setInterval(() => { reconcile().catch(() => {}); }, RECONCILE_MS);
  setInterval(() => { cleanup.run().catch(() => {}); }, CLEANUP_MS);

  /* A sandbox is torn down in its own finally, so this only ever finds
     the ones a worker that DIED mid-check left behind. Nothing else
     would: they carry souqi.role=agent-sandbox rather than
     souqi.deployment, which is what keeps them out of the deployment
     count and also out of the janitor's reach. */
  setInterval(() => { agentRunner.reapOrphans().catch(() => {}); }, CLEANUP_MS);
  reconcile().catch(() => {});

  while (running) {
    let worked = false;
    try {
      // Lifecycle actions first: they are seconds of work, and making a stop
      // wait behind a fifteen-minute build is how a runaway container stays
      // up long after the user asked for it to go away.
      worked = await tickAction();
      // Project actions before builds too. A delete is what a user asked
      // for most recently, and making it wait behind a fifteen-minute build
      // means their containers keep serving long after they said stop.
      if (!worked) worked = await tickProjectAction();
      if (!worked) worked = await tick();
    }
    catch (e) { console.error("[worker] tick failed:", e.message); }
    // Only idle when there was nothing to do, so a backlog drains at full
    // speed instead of one deployment every two seconds.
    if (!worked) await new Promise((r) => setTimeout(r, POLL_MS));
  }

  await pool.end();
  process.exit(0);
}

if (require.main === module) main();

module.exports = { claimNext, tick, reconcile, sourceDirFor, claimNextAction, tickAction, ACTIONS };
