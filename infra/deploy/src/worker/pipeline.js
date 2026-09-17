/* =================================================================
   worker/pipeline.js — QUEUED -> BUILDING -> STARTING -> RUNNING
   -----------------------------------------------------------------
   The whole deployment in one place, so the state machine is
   readable rather than scattered across request handlers.

   Nothing here runs inside an HTTP request. A build takes minutes;
   holding a request open for it means a proxy timeout mid-build and
   a deployment whose real state nobody knows.

   Every failure path must leave the row in a terminal state with a
   reason attached. A deployment stuck in BUILDING forever is worse
   than one marked FAILED, because the user cannot retry it.
   ================================================================= */
"use strict";

const dns = require("dns");
const https = require("https");
const fsp = require("fs/promises");
const path = require("path");
const { cfg } = require("../config");
const { query, one } = require("../db");
const engine = require("../docker/engine");
const caddy = require("../proxy/caddy");
const domains = require("../domains");
const capacity = require("../monitor/capacity");
const detect = require("../framework/detect");
const dockerfiles = require("../framework/dockerfiles");
const secrets = require("../secrets");
const objects = require("../storage/objects");
const dbproviders = require("../dbproviders");

/* ---------- logging ----------
   Build output goes to the database, not only to the container, because the
   build container is gone by the time anyone asks what went wrong. */
async function log(deploymentId, phase, line, stream) {
  const text = String(line).slice(0, 4000);
  try {
    await query(
      "INSERT INTO deployment_logs (deployment_id, phase, stream, line) VALUES ($1,$2,$3,$4)",
      [deploymentId, phase, stream || "stdout", text]
    );
  } catch (e) {
    // Losing a log line must never abort a deploy.
    console.error("[worker] log write failed:", e.message);
  }
}

async function setStatus(deploymentId, status, extra) {
  const fields = Object.assign({ status }, extra || {});
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => k + "=$" + (i + 2)).join(", ");
  await query(
    "UPDATE deployments SET " + sets + ", updated_at=now() WHERE id=$1",
    [deploymentId].concat(keys.map((k) => fields[k]))
  );
}

/**
 * @param {boolean} [ownsContainer]  has THIS attempt reached the point where
 *   a container under this name would be its own? Default false, and the
 *   default is the whole point.
 *
 * A redeploy reuses the deployment id, so the container name is the same one
 * the LIVE revision is running under. This used to remove it unconditionally
 * "so a half-built container from this attempt must not linger" — but an
 * attempt that fails before it starts anything has no container to linger,
 * and the one it force-removed was the working app.
 *
 * Seen in production: a redeploy refused at admission for being over the
 * container limit, which is a refusal to do anything at all, and the refusal
 * took the site down. The route stayed, the container did not, and every
 * request to it answered 502 from then on. Refusing to act must not be more
 * destructive than acting.
 */
async function fail(deploymentId, reason, ownsContainer) {
  await log(deploymentId, "system", "FAILED: " + reason, "stderr");
  await setStatus(deploymentId, "FAILED", { error: String(reason).slice(0, 1000) });
  if (ownsContainer) {
    try { await engine.removeContainer(deploymentId); } catch (e) { /* nothing to remove */ }
  }
  return { ok: false, error: reason };
}

/* ---------- env ---------- */
async function projectEnv(projectId) {
  const { rows } = await query("SELECT key, value_enc FROM project_env WHERE project_id=$1", [projectId]);
  const out = {};
  for (const r of rows) {
    // An unreadable secret is skipped and never logged — the value is the
    // thing being protected, and a decrypt error message can leak its shape.
    try { out[r.key] = secrets.decrypt(r.value_enc); } catch (e) { /* skip */ }
  }
  return out;
}

/* ---------- build context ----------
   Source is staged into a directory the platform owns, the generated
   Dockerfile is written beside it, and docker build takes it from there.
   Nothing in the staged source is ever executed by the host. */
async function stageBuildContext(deploymentId, sourceDir) {
  const dest = path.join(cfg.buildRoot, String(deploymentId));
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.mkdir(dest, { recursive: true });
  await fsp.cp(sourceDir, dest, { recursive: true, dereference: false, force: true });
  return dest;
}

async function cleanupBuildContext(deploymentId) {
  const dir = path.join(cfg.buildRoot, String(deploymentId));
  try { await fsp.rm(dir, { recursive: true, force: true }); }
  catch (e) { console.error("[worker] could not clean", dir, e.message); }
}

/**
 * Make sure the source is on disk before the build looks for it.
 *
 * Present already: nothing to do — the common case, straight after an
 * upload. Missing with an archive: restore it. Missing with no archive:
 * say so plainly, because "could not work out how to build this" would
 * blame the user's project for a file that was never there.
 */
async function ensureSource(dep, sourceDir) {
  let present = false;
  try { present = (await fsp.readdir(sourceDir)).length > 0; } catch (e) { present = false; }
  if (present) return { ok: true, fromArchive: false };

  if (!dep.source_key) {
    /* One message now, because the old second branch became false: with no
       bucket the archive goes to Postgres, so "object storage is not
       configured, so it cannot be restored" would send someone to check S3
       credentials over a deployment that either predates archiving or had
       its archive step fail — neither of which S3 has anything to do with. */
    return {
      ok: false,
      error: "the source for this deployment is gone — no archive was recorded for it, so there is nothing to restore"
    };
  }

  const got = await objects.getSource(dep.source_key);
  if (!got.ok) return { ok: false, error: "could not restore the source — " + (got.error || "unknown") };

  await fsp.mkdir(sourceDir, { recursive: true });
  for (const rel of Object.keys(got.files)) {
    // Same traversal check the upload does. The archive is our own, but a
    // path that escapes the staging directory must not be writable just
    // because it took a different route in.
    const clean = String(rel).replace(/\\/g, "/");
    if (clean.startsWith("/") || clean.split("/").includes("..")) continue;
    const dest = path.join(sourceDir, clean);
    if (!dest.startsWith(sourceDir + path.sep)) continue;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, String(got.files[rel]), "utf8");
  }
  return { ok: true, fromArchive: true };
}

/**
 * Make sure this project has a database, and that this deployment can
 * reach it.
 *
 * Keyed to the PROJECT, not the deployment: a redeploy mints a new
 * deployment id and a fresh network, but the data has to survive that.
 * So the row is created once and the container is re-attached to whatever
 * network is current — the same shape as connectProxy.
 *
 * NEVER FATAL. A database that cannot be provisioned is logged and the
 * deploy continues without one. An app that does not use a database
 * should not fail to ship because a sidecar was unhappy, and an app that
 * does will say so far more clearly in its own logs than a deploy failure
 * would.
 */
async function ensureDatabase(dep, id) {
  const projectId = dep.project_id;

  const row = await one("SELECT * FROM project_databases WHERE project_id=$1", [projectId]);
  const mode = (row && row.mode) || dbproviders.DEFAULT_MODE;
  const provider = dbproviders.get(mode);

  let secret = null;
  if (row && row.secret_enc) {
    // An unreadable credential is treated as absent rather than thrown:
    // for builtin that means it is reissued, which is recoverable. Same
    // discipline as projectEnv above.
    try { secret = secrets.decrypt(row.secret_enc); } catch (e) { secret = null; }
  }

  if (mode === "builtin" && !(await provider.ready())) {
    await log(id, "system", "WARNING: the database service is not responding — starting without one", "stderr");
    return {};
  }

  const got = await provider.provision(projectId, { secret });
  if (!got.ok) {
    await log(id, "system", "WARNING: could not prepare the database — " + got.error, "stderr");
    return {};
  }

  // Only write when something changed: a redeploy must not rewrite the
  // credential of a database an older container is still connected to.
  if (got.secret) {
    await query(
      `INSERT INTO project_databases (project_id, mode, db_name, db_role, secret_enc, updated_at)
            VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (project_id) DO UPDATE
            SET mode=$2, db_name=$3, db_role=$4, secret_enc=$5, updated_at=now()`,
      [projectId, mode, got.dbName || null, got.role || null, secrets.encrypt(got.secret)]
    );
  } else if (!row) {
    await query(
      `INSERT INTO project_databases (project_id, mode, db_name, db_role, updated_at)
            VALUES ($1,$2,$3,$4, now()) ON CONFLICT (project_id) DO NOTHING`,
      [projectId, mode, got.dbName || null, got.role || null]
    );
  }

  /* The built-in cluster joins the app's network directly. An external one
     cannot: it is out on the internet and the app's network is --internal.
     It gets a one-target forwarder instead, below. */
  if (mode === "builtin") {
    const attached = await engine.connectUserDb(id);
    if (!attached.ok) {
      await log(id, "system", "WARNING: could not attach the database to this app's network — " +
        (attached.error || ""), "stderr");
      return {};
    }
    await log(id, "system", got.existed ? "Connected to your database" : "Created your database");
  } else {
    /* An external database is out on the internet, and this app's network is
       --internal, so on its own the app cannot reach it — a deploy would
       succeed and then fail on the first query. Rather than drop --internal,
       which would give every app on the box unrestricted egress, the app
       gets a forwarder that can reach exactly one address.

       The forwarder answers to the database's own hostname, so the
       connection string is injected UNCHANGED and TLS still verifies
       against the real certificate. */
    const fwd = await ensureDbForwarder(id, got.url);
    if (!fwd.ok) {
      await log(id, "system", "WARNING: " + fwd.error +
        " — your app will not be able to reach your database", "stderr");
    } else {
      await log(id, "system", "Using your external database at " + fwd.host + ":" + fwd.port +
        ", reachable through a forwarder that can dial nothing else");
    }
  }

  return { url: got.url, mode: mode };
}

/**
 * Point this deployment's forwarder at the host in `url`.
 *
 * The address is resolved HERE, in the worker, and socat is given the literal.
 * Handing socat the hostname instead would make it ask Docker's embedded DNS,
 * which on the app network answers with the forwarder's own alias — it would
 * dial itself. Resolving once per deploy also means a moved database is
 * noticed by the reconcile loop rather than failing quietly forever.
 */
async function ensureDbForwarder(deploymentId, url) {
  const parsed = dbproviders.get("external").parse(url);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const host = parsed.url.hostname;
  const port = Number(parsed.url.port || 5432);

  let addr = null;
  try { addr = (await dns.promises.lookup(host, { family: 4 })).address; }
  catch (e) { addr = null; }
  if (!addr) return { ok: false, error: "could not resolve " + host, host: host, port: port };

  const run = await engine.runDbProxy({
    deploymentId: deploymentId, host: host, targetIp: addr, port: port
  });
  if (!run.ok) return { ok: false, error: run.error || "the forwarder did not start", host: host, port: port };
  return { ok: true, host: host, port: port, ip: addr };
}

/* ---------- checks ----------
   Advisory, all of them. The only check that can stop a deploy is the secret
   scan, and it runs in the main app before any source is uploaded — so it
   never reaches this file. Everything here reports on something that already
   shipped, which is exactly why none of it may fail a deployment: a probe
   that cannot reach the app must not mark a working app broken. */

async function recordCheck(deploymentId, checkId, status, summary, detail) {
  try {
    await query(
      `INSERT INTO deployment_checks (deployment_id, check_id, status, summary, detail, at)
            VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (deployment_id, check_id) DO UPDATE
            SET status=EXCLUDED.status, summary=EXCLUDED.summary,
                detail=EXCLUDED.detail, at=now()`,
      [deploymentId, checkId, status, summary || null, detail ? JSON.stringify(detail) : null]
    );
  } catch (e) {
    // A check that cannot be recorded is not a deploy that should fail.
    console.warn("[checks] could not record " + checkId + ": " + e.message);
  }
}

/**
 * What npm knows about the dependency tree that was actually built.
 *
 * Reported, never blocking, and "fail" here means the row says fail — the app
 * still deploys. Refusing on a transitive advisory in a generated app would
 * stop almost every deploy, and the person who asked for a football calendar
 * cannot act on it anyway.
 */
async function auditDependencies(id, contextDir) {
  const r = await engine.runNpmAudit(contextDir);
  if (!r.ok) {
    await recordCheck(id, "dependencies", "skipped", r.error);
    await log(id, "system", "Dependency audit skipped — " + r.error, "stderr");
    return;
  }
  const c = r.counts;
  const status = c.critical > 0 ? "fail" : (c.high > 0 ? "warn" : "pass");
  const summary = c.total === 0
    ? "no known vulnerabilities in " + "the dependency tree"
    : c.critical + " critical, " + c.high + " high, " + c.moderate + " moderate, " + c.low + " low";
  await recordCheck(id, "dependencies", status, summary, c);
  await log(id, "system", "Dependency audit: " + summary);
}

/**
 * What a browser is actually told when it loads the app.
 *
 * Fetched over the public hostname rather than the container, because the
 * question is what a visitor receives — which includes whatever Caddy adds on
 * the way out. Missing headers are a warn, never a failure: most working
 * software does not set a CSP, and a check that cries wolf on every deploy is
 * one nobody reads by the third.
 */
function probeHeaders(url) {
  const RECOMMENDED = {
    "strict-transport-security": "HSTS",
    "x-content-type-options": "nosniff",
    "content-security-policy": "content security policy",
    "referrer-policy": "referrer policy"
  };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = https.get(url, { timeout: 12000 }, (res) => {
        res.resume();
        const h = res.headers || {};
        const present = [], missing = [];
        for (const k of Object.keys(RECOMMENDED)) (h[k] ? present : missing).push(RECOMMENDED[k]);
        finish({
          ok: true,
          code: res.statusCode,
          // authorized is false only when the certificate did not verify.
          tls: !(res.socket && res.socket.authorized === false),
          present: present, missing: missing
        });
      });
    } catch (e) { return finish({ ok: false, error: e.message }); }
    req.on("timeout", () => { req.destroy(); finish({ ok: false, error: "no answer within 12s" }); });
    req.on("error", (e) => finish({ ok: false, error: e.message }));
  });
}

async function checkResponse(id, url) {
  const r = await probeHeaders(url);
  if (!r.ok) {
    await recordCheck(id, "response", "skipped", "could not be reached from here — " + r.error);
    return;
  }
  if (!r.tls) {
    await recordCheck(id, "response", "fail", "the certificate did not verify", { code: r.code });
    return;
  }
  const status = r.missing.length ? "warn" : "pass";
  const summary = "served over HTTPS with a valid certificate" +
    (r.missing.length ? "; not setting " + r.missing.join(", ") : "; all recommended headers set");
  await recordCheck(id, "response", status, summary,
    { code: r.code, present: r.present, missing: r.missing });
}

/* ---------- the pipeline ---------- */

/**
 * @param {object} dep        the deployments row
 * @param {string} sourceDir  where the source currently sits on disk
 */
async function deploy(dep, sourceDir) {
  const id = dep.id;
  /* False until this attempt takes the name over — see fail(). Everything
     before the swap can fail without touching what is already serving. */
  let ownsContainer = false;

  try {
    // --- 1. admission -------------------------------------------------
    // The id, so a redeploy is measured as the replacement it is rather
    // than as one more app the host has to find room for.
    const admit = await capacity.canAdmit({ memoryMb: dep.memory_mb, replacingDeploymentId: id });
    if (!admit.ok) {
      return fail(id, "this server cannot take another app right now — " + admit.reasons.join("; "));
    }

    // --- 2. detect ----------------------------------------------------
    await setStatus(id, "BUILDING");
    await log(id, "system", "Inspecting the project");

    /* The build directory is scratch: cleanup wipes it after a deploy,
       and on a second VM it never existed. When it is not there and the
       source was archived, restore it — this is what makes a redeploy
       weeks later, or on a different host, work at all. */
    const restored = await ensureSource(dep, sourceDir);
    if (!restored.ok) return fail(id, restored.error);
    if (restored.fromArchive) await log(id, "system", "Restored the source from object storage");

    const spec = detect.detect(sourceDir);
    if (!spec) {
      return fail(id, "could not work out how to build this project — add a deploy.json declaring framework, buildCommand, startCommand and port");
    }
    await log(id, "system", "Detected " + spec.framework + (spec.declared ? " (declared)" : " (auto)"));

    // --- 3. generate the recipe ---------------------------------------
    let recipe;
    try { recipe = dockerfiles.generate(spec); }
    catch (e) { return fail(id, e.message); }

    const ctx = await stageBuildContext(id, sourceDir);
    await fsp.writeFile(path.join(ctx, "Dockerfile"), recipe.dockerfile, "utf8");
    await fsp.writeFile(path.join(ctx, ".dockerignore"), dockerfiles.dockerignore(), "utf8");
    for (const name of Object.keys(recipe.extraFiles)) {
      await fsp.writeFile(path.join(ctx, name), recipe.extraFiles[name], "utf8");
    }

    // --- 4. build (inside a container, never on the host) --------------
    await log(id, "system", "Building the image");
    const built = await engine.buildImage({
      deploymentId: id,
      contextDir: ctx,
      onLine: (line, stream) => log(id, "build", line, stream)
    });
    if (!built.ok) {
      await cleanupBuildContext(id);
      const tail = (built.stderr || built.stdout || "").trim().split("\n").slice(-3).join(" | ");
      return fail(id, built.timedOut ? "the build timed out" : ("the build failed — " + (tail || "see build logs")));
    }

    /* Between build and run, while the context is still on disk. It is not
       allowed to affect either: a slow registry must not delay someone's
       deploy into a timeout, and a vulnerable transitive dependency is a
       thing to tell them, not a reason to refuse. */
    await auditDependencies(id, ctx).catch(() => { });

    // --- 5. run -------------------------------------------------------
    await setStatus(id, "STARTING", { image_name: engine.imageName(id), internal_port: spec.port });
    await log(id, "system", "Starting the container");

    // This deployment's own isolated network, so it shares one with no other
    // user container.
    const net = await engine.ensureDeploymentNetwork(id);
    if (!net.ok) {
      await cleanupBuildContext(id);
      return fail(id, "could not create the app network — " + (net.error || "unknown error"));
    }
    /* From HERE the container under this name is ours: the previous
       revision has been removed on purpose, so a later failure cleaning up
       is cleaning up after this attempt rather than after the live app. */
    await engine.removeContainer(id);
    ownsContainer = true;

    /* The database, before the app starts.
       Order matters twice over: the network has to exist because the
       database container joins it, and the database has to be reachable
       before the container boots, or the app's first connection fails and
       waitForRunning marks a working deploy FAILED. */
    const database = await ensureDatabase(dep, id);

    const env = await projectEnv(dep.project_id);

    /* Merged AFTER projectEnv, so the platform value is not something the
       user can accidentally clobber — but DATABASE_URL is only filled in
       when they have not set their own. Someone pointing at an external
       database deliberately keeps it; silently overriding their value
       would be worse than the convenience is worth.

       SOUQI_DATABASE_URL is always set and cannot be shadowed, so an app
       has one name that always means "the database this platform gave
       you", whatever else is in the environment. */
    if (database.url) {
      env.SOUQI_DATABASE_URL = database.url;
      if (!env.DATABASE_URL) env.DATABASE_URL = database.url;
    }

    const run = await engine.runApp({
      deploymentId: id,
      port: spec.port,
      cpu: dep.cpu_limit,
      memoryMb: dep.memory_mb,
      pids: dep.pids_limit,
      env: env,
      // A read-only root breaks anything that writes beside its own files.
      // Next caches into .next at runtime, so it gets a writable root; the
      // other three do not need one.
      readOnly: spec.framework !== "nextjs"
    });
    if (!run.ok) {
      await cleanupBuildContext(id);
      return fail(id, "the container did not start — " + (run.error || "unknown error"), ownsContainer);
    }

    // --- 6. route -----------------------------------------------------
    // Caddy has to join this app's network before it can dial the container;
    // on its own network the app is reachable by nothing at all.
    const attached = await engine.connectProxy(id);
    if (!attached.ok) {
      await log(id, "system", "WARNING: could not attach the proxy to the app network — " +
        (attached.error || ""), "stderr");
    }

    let routed = { ok: true };
    for (const host of domains.hostnamesFor(dep)) {
      const r = await caddy.addRoute(host, run.name, spec.port);
      if (!r.ok) routed = r;                  // report the first that failed
    }
    if (!routed.ok) {
      // Not fatal. The container is healthy and the route can be reconciled;
      // failing here would mark a working app as broken.
      await log(id, "system", "WARNING: could not add the proxy route — " + (routed.error || ""), "stderr");
    }

    // --- 7. settle ----------------------------------------------------
    const healthy = await waitForRunning(id, 30000);
    if (!healthy.ok) {
      await cleanupBuildContext(id);
      return fail(id, healthy.reason, ownsContainer);
    }

    await setStatus(id, "RUNNING", { container_name: run.name, error: null });
    await log(id, "system", "Live at https://" + dep.domain);

    // Only now, because until this point there was nothing to ask.
    await checkResponse(id, "https://" + dep.domain).catch(() => { });

    await cleanupBuildContext(id);
    return { ok: true, domain: dep.domain, url: "https://" + dep.domain };

  } catch (e) {
    await cleanupBuildContext(id).catch(() => {});
    return fail(id, e.message || String(e), ownsContainer);
  }
}

/**
 * A container that starts and immediately exits is the most common
 * deployment failure there is — a wrong start command, a missing env var, a
 * port mismatch. Watching for a few seconds turns that into a clear FAILED
 * with the exit code, instead of a RUNNING row pointing at a dead container.
 */
async function waitForRunning(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const st = await engine.inspectState(id);
    last = st;
    if (!st.exists) return { ok: false, reason: "the container disappeared right after starting" };
    if (st.status === "running" && st.restarts === 0) {
      // Hold briefly: a process that crashes on its first request still
      // reports running for a moment.
      await new Promise((r) => setTimeout(r, 2000));
      const again = await engine.inspectState(id);
      if (again.status === "running") return { ok: true };
      last = again;
      continue;
    }
    if (st.status === "exited") {
      const l = await engine.logs(id, { tail: 20 });
      const tail = (l.out || "").trim().split("\n").slice(-3).join(" | ");
      return { ok: false, reason: "the app exited immediately with code " + st.exitCode + (tail ? " — " + tail : "") };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: false, reason: "the app did not become healthy within 30s (last state: " + (last && last.status) + ")" };
}

/* ---------- lifecycle actions ---------- */

async function stop(dep) {
  await engine.stop(dep.id);
  for (const host of domains.hostnamesFor(dep)) await caddy.removeRoute(host);
  await setStatus(dep.id, "STOPPED");
  await log(dep.id, "system", "Stopped");
  return { ok: true };
}

async function start(dep) {
  await setStatus(dep.id, "STARTING");
  const r = await engine.start(dep.id);
  if (!r.ok) return fail(dep.id, "could not start the container — " + r.stderr.trim());
  const healthy = await waitForRunning(dep.id, 30000);
  if (!healthy.ok) return fail(dep.id, healthy.reason);
  for (const host of domains.hostnamesFor(dep)) {
    await caddy.addRoute(host, engine.containerName(dep.id), dep.internal_port || 3000);
  }
  await setStatus(dep.id, "RUNNING", { error: null });
  await log(dep.id, "system", "Started");
  return { ok: true };
}

async function restart(dep) {
  await setStatus(dep.id, "STARTING");
  const r = await engine.restart(dep.id);
  if (!r.ok) return fail(dep.id, "could not restart the container — " + r.stderr.trim());
  const healthy = await waitForRunning(dep.id, 30000);
  if (!healthy.ok) return fail(dep.id, healthy.reason);
  await setStatus(dep.id, "RUNNING", { error: null });
  await log(dep.id, "system", "Restarted");
  return { ok: true };
}

/** Full teardown, in the order the spec lays out. */
async function destroy(dep) {
  for (const host of domains.hostnamesFor(dep)) await caddy.removeRoute(host);

  /* DID THE SLOT ACTUALLY COME FREE?

     This line used to be `await engine.removeContainer(dep.id);` with the
     result dropped, and both halves of that were a decision.

     When the rm genuinely failed, the row was still marked DELETED below and
     the container stayed on the host, which splits the two capacity counts in
     opposite directions: Docker counts it, the database no longer does. The
     mirror image of the phantom-slot bug, and just as silent — no log line
     anywhere said a container had been left behind.

     The obvious worry about reading the result is a false alarm on
     deployments that never had a container, and it turns out not to exist:
     `docker rm --force` exits ZERO when there is no such container, with
     empty stderr (checked on the host, Docker 29.7.2). --force makes "not
     there" the success it ought to be, so every FAILED row passes straight
     through and this needs no special case for them.

     Which also means a non-zero exit is never routine — it is a real failure
     or an unreachable daemon, and both deserve the same line: this host is
     still holding something the database has stopped counting.

     Deliberately NO inspectState() second opinion to confirm the container is
     still there. It reports exists:false both when the container is gone and
     when nobody could look, so using it to suppress this warning would mute
     exactly the daemon-down case that most needs saying. That is the trap
     listManaged() documents at the top of engine.js, and it is not worth
     walking into for a tidier message.

     The row is still marked DELETED afterwards, deliberately. The janitor
     reaps a managed container whose row is gone or DELETED
     (sweepOrphanContainers), so the host converges on its own; refusing to
     delete the row would instead strand a deployment the UI can no longer
     clear. What was missing was never the cleanup — it was anyone knowing. */
  const leftBehind = [];
  const rm = await engine.removeContainer(dep.id);
  if (!rm.ok) {
    leftBehind.push("container app-" + dep.id + " (" + (String(rm.stderr || "").trim() || "no reason given") + ")");
  }
  await engine.removeImage(dep.id);
  /* The database container leaves this network, and NOTHING is dropped.
     Deleting one deployment is not deleting the project: a redeploy is a
     new deployment id, so dropping data here would mean every redeploy
     started from empty. Only deleteProjectDatabase() below removes data,
     and only the project delete path calls it.

     This has to happen before the network is removed. `network rm` is
     refused while any member is still attached, and the failure is silent
     from here — one dead network leaked per deleted deployment, against a
     default address pool of about thirty. */
  await engine.disconnectUserDb(dep.id);
  // The forwarder is a member of this network too, and takes its own egress
  // network with it. Same reason as the line above: an attached member is
  // enough to make the rm fail.
  await engine.removeDbProxy(dep.id);
  // After the container is gone, or the network still has a member and the
  // rm is refused — leaking one dead network per deleted deployment.
  await engine.removeDeploymentNetwork(dep.id);
  // The archive goes with it. Keeping a deleted customer's source in
  // object storage is the kind of thing you only discover during an audit.
  if (dep.source_key) {
    const gone = await objects.deleteSource(dep.source_key);
    if (!gone.ok && !gone.skipped) {
      await log(dep.id, "system", "WARNING: the source archive could not be removed from storage", "stderr");
    }
  }
  await cleanupBuildContext(dep.id);
  await setStatus(dep.id, "DELETED", { container_name: null, image_name: null });

  /* Said twice, because the two readers are different people with different
     problems. The deployment log is what the customer sees and explains why
     their host still looks busy; the console is where an operator finds out
     that a slot is being held by something the database has already
     forgotten. The source-archive step above reports itself the same way. */
  if (leftBehind.length) {
    await log(dep.id, "system",
      "WARNING: deleted, but this could not be removed from the host: " +
      leftBehind.join("; ") + ". It should be cleaned up automatically within the hour.", "stderr");
    console.error("[worker] destroy", dep.id, "left behind:", leftBehind.join("; "));
  }

  await log(dep.id, "system", "Deleted");
  // ok:true because the deletion DID happen — the row is gone and the janitor
  // finishes the host. leftBehind carries what the host still holds, for a
  // caller that wants to know rather than one that has to.
  return { ok: true, leftBehind };
}

/* ---------- project-level database actions ----------
   Deployments come and go; a database belongs to the project and outlives
   them. These two run only when the project itself is being changed, and
   they are the only paths that can destroy customer data. */

/**
 * Drop a project's built-in database and role.
 *
 * The row is deleted whatever the drop reports, and that is deliberate. A
 * project that is being deleted has its `project_databases` row cascade
 * away anyway (FK ON DELETE CASCADE); leaving a stale credential behind
 * for a database we failed to drop would be worse than an orphaned
 * database, because a later project could not be told the difference.
 * The error is returned so the caller can say what is left over.
 */
async function deleteProjectDatabase(projectId, opts) {
  const row = await one("SELECT * FROM project_databases WHERE project_id=$1", [projectId]);
  if (!row) return { ok: true, skipped: true, reason: "this project has no database" };

  /* Which provider drops it is decided by which one MADE it, not by the
     mode the project is on now. A project that switched to external still
     has a built-in database sitting there (builtin_kept), and asking the
     external provider to destroy would return its polite no-op while our
     disk kept the data for ever. */
  const madeBuiltin = row.mode === "builtin" || row.builtin_kept;
  let result = { ok: true, skipped: true };
  if (madeBuiltin) {
    result = await dbproviders.get("builtin").destroy(projectId);
  }

  if (!(opts && opts.keepRow)) {
    await query("DELETE FROM project_databases WHERE project_id=$1", [projectId]);
  }
  return result;
}

/**
 * Refresh the recorded size of a project's database.
 *
 * Postgres has no per-database quota, so this is observation and not
 * enforcement — it is what lets the dashboard and the alerts tell someone
 * a volume is filling up, which is an honest soft limit rather than a
 * promise the storage layer cannot keep.
 */
async function measureProjectDatabase(projectId) {
  const row = await one("SELECT * FROM project_databases WHERE project_id=$1", [projectId]);
  if (!row) return { ok: false, error: "this project has no database" };

  let secret = null;
  if (row.secret_enc) { try { secret = secrets.decrypt(row.secret_enc); } catch (e) { secret = null; } }

  const got = await dbproviders.get(row.mode).inspect(projectId, { secret });
  if (!got.ok) return { ok: false, error: got.error };

  await query(
    "UPDATE project_databases SET size_bytes=$2, size_seen_at=now(), updated_at=now() WHERE project_id=$1",
    [projectId, got.sizeBytes === undefined ? null : got.sizeBytes]
  );
  return { ok: true, sizeBytes: got.sizeBytes ?? null, reachable: got.reachable };
}


/**
 * Read a project's own data, for the dashboard's browser.
 *
 * Read-only by construction rather than by promise: `what` names a table
 * and a page, never a statement. No SQL crosses the wire from a browser,
 * and the table name is re-read out of the catalogue before it is used —
 * see dbproviders/builtin.js, where that is the whole security boundary.
 *
 * External databases are not browsable, and this says so rather than
 * returning an empty table list that looks like an empty database. The
 * built-in cluster is reachable over the Docker socket the worker already
 * holds; someone else's Neon is an outbound connection with credentials
 * they gave us, which is a different decision about what we open and how
 * long we hold it.
 */
async function browseProjectDatabase(projectId, what) {
  const row = await one("SELECT * FROM project_databases WHERE project_id=$1", [projectId]);
  if (!row) return { ok: false, error: "this project has no database yet" };
  if (row.mode !== "builtin") {
    return { ok: false, error: "browsing is only available for the built-in database" };
  }

  const builtin = dbproviders.get("builtin");
  if (!(await builtin.ready())) return { ok: false, error: "the database service is not responding" };

  const w = what || {};
  if (w.table) return builtin.readRows(projectId, w.table, { limit: w.limit, offset: w.offset });

  const listed = await builtin.listTables(projectId);
  if (!listed.ok) return { ok: false, error: listed.error };
  return {
    ok: true,
    tables: listed.value.map((t) => ({
      name: t.name,
      approxRows: t.approx_rows == null ? null : Number(t.approx_rows),
      bytes: Number(t.bytes) || 0
    }))
  };
}

module.exports = {
  deploy, stop, start, restart, destroy,
  ensureDatabase, deleteProjectDatabase, measureProjectDatabase, browseProjectDatabase,
  setStatus, log, waitForRunning, cleanupBuildContext, projectEnv,
  recordCheck, auditDependencies, checkResponse, probeHeaders
};
