/* =================================================================
   monitor/capacity.js — admission control and host health
   -----------------------------------------------------------------
   The spec rule this implements: "the platform should refuse new
   deployments if the server does not have sufficient resources", and
   "do not claim that 10 applications can always run on one VM".

   Refusing a deploy with a clear reason is a far better failure than
   accepting it and having the OOM killer pick a victim at random —
   which, on a shared box, is usually somebody else app.
   ================================================================= */
"use strict";

const os = require("os");
const fs = require("fs");
const { execFile } = require("child_process");
const { cfg } = require("../config");
const engine = require("../docker/engine");
const { one } = require("../db");

function memory() {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    totalMb: Math.round(total / 1048576),
    usedMb: Math.round((total - free) / 1048576),
    pct: Math.round((total - free) / total * 100)
  };
}

function loadPct() {
  // 1-minute load average against core count. Not the same as CPU% but it is
  // the number that actually predicts contention on a shared box.
  const cores = os.cpus().length || 1;
  return Math.round(os.loadavg()[0] / cores * 100);
}

function disk(pathToCheck) {
  return new Promise((resolve) => {
    if (process.platform === "win32") return resolve(null);   // local dev only
    execFile("df", ["-Pk", pathToCheck || "/"], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const line = String(stdout).trim().split("\n").pop() || "";
      const cols = line.split(/\s+/);
      const totalKb = Number(cols[1]), usedKb = Number(cols[2]);
      if (!Number.isFinite(totalKb) || !totalKb) return resolve(null);
      resolve({ totalGb: +(totalKb / 1048576).toFixed(1), usedGb: +(usedKb / 1048576).toFixed(1), pct: Math.round(usedKb / totalKb * 100) });
    });
  });
}

async function snapshot() {
  const [containers, d] = await Promise.all([engine.listManaged(), disk(cfg.buildRoot)]);

  /* listManaged() returns null when the daemon could not be reached, which
     is the normal case in the api — it has no Docker socket on purpose.
     Treating that as "zero containers" reported an empty host while apps
     were running, and quietly made the MAX_CONTAINERS admission check
     below pass no matter what. The database knows what this host is meant
     to be running, so it answers instead, and the caller is told which
     source it got. */
  let counts, from;
  if (containers) {
    from = "docker";
    counts = {
      total: containers.length,
      running: containers.filter((c) => /running/i.test(c.state)).length,
      // The names, so canAdmit can tell a REPLACEMENT from an addition.
      names: containers.map((c) => c.name)
    };
  } else {
    from = "database";
    /* NOT the same thing as "not deleted".

       This counted `status <> 'DELETED'`, which is every row the host has
       ever half-finished. A FAILED deployment holds no container — it
       never got one, or its one was cleaned up — and a redeploy is a new
       deployment id, so that row will never acquire one either. It is a
       tombstone, and it was taking a slot.

       Measured on the live host when this was found: docker reported 9 app
       containers, this query reported 13, and MAX_CONTAINERS was 10. So
       admission refused every new deployment while the host had a free
       slot, and deleting a container could not fix it — the four phantoms
       were FAILED rows, and deleting something else does not remove those.
       The api is where this always bites: it has no Docker socket on
       purpose, so it ALWAYS takes this branch and never sees the real
       count that would have contradicted it.

       Stated negatively on purpose, against the usual rule. The question
       is "does this row hold a slot", and for admission the safe answer to
       an unrecognised status is yes — a status added later should count
       until someone decides it should not, rather than silently opening
       the gate. FAILED and DELETED are the only two that provably hold
       nothing.

       This is now the same definition the committed-memory query below
       already uses; the two were measuring different sets in one
       function. */
    const row = await one(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'RUNNING')::int AS running
         FROM deployments
        WHERE host_id = $1 AND status NOT IN ('FAILED','DELETED')`,
      [cfg.hostId]
    );
    counts = { total: row ? row.total : 0, running: row ? row.running : 0 };
  }

  return {
    hostId: cfg.hostId,
    memory: memory(),
    cpuPct: loadPct(),
    disk: d,
    containers: counts,
    containersFrom: from,
    at: new Date().toISOString()
  };
}

/**
 * Would one more container of this size fit?
 *
 * Checks committed memory, not just free memory: a box with 6GB free and
 * 10 containers each allowed 512MB is already oversubscribed by 5GB, and
 * free memory tells you nothing until they all get busy at once.
 */
async function canAdmit({ memoryMb, replacingDeploymentId }) {
  const snap = await snapshot();
  const reasons = [];

  /* A REDEPLOY IS NOT AN EXTRA APP.
     It removes the old container and starts a new one under the same name,
     so the host ends with exactly the containers it began with. Counted as
     an addition, a full host could never redeploy anything — the app that
     was already running was itself the reason it was refused, and the only
     way out was to delete something. */
  const replacingName = replacingDeploymentId ? engine.containerName(replacingDeploymentId) : null;
  const replacing = !!(replacingName && (snap.containers.names || []).indexOf(replacingName) !== -1);

  /* Deployments do not get the whole host. A few slots are held back so
     the code agent always has somewhere to build and verify — otherwise
     a full host silently downgrades every agent run to "we could not
     check this", which is the failure people notice least and trust
     most. See cfg.admission.agentSandboxes for why it is subtracted
     rather than counted. */
  const deployLimit = deploymentLimit();

  if (!replacing && snap.containers.total >= deployLimit) {
    reasons.push("this server is at its container limit (" + deployLimit +
      " of " + cfg.admission.maxContainers + "; " + reservedSandboxes() +
      " are reserved for build sandboxes)");
  }
  if (snap.memory.pct >= cfg.admission.maxMemoryPct) {
    reasons.push("memory is at " + snap.memory.pct + "% (limit " + cfg.admission.maxMemoryPct + "%)");
  }
  if (snap.disk && snap.disk.pct >= cfg.admission.maxDiskPct) {
    reasons.push("disk is at " + snap.disk.pct + "% (limit " + cfg.admission.maxDiskPct + "%)");
  }

  const committed = await one(
    "SELECT COALESCE(SUM(memory_mb),0)::int AS mb FROM deployments WHERE host_id=$1 AND status IN ('RUNNING','STARTING','BUILDING')",
    [cfg.hostId]
  );
  const wouldCommit = (committed ? committed.mb : 0) + Number(memoryMb || cfg.defaults.memoryMb);
  // Allow deliberate oversubscription up to 1.5x physical — apps are idle
  // most of the time — but not unbounded.
  //
  // The reserved sandboxes come off the ceiling too. Holding a container
  // slot for the agent and then letting deployments commit the memory it
  // would need reserves nothing: the slot is free and the box is full.
  const reservedMb = reservedSandboxes() * (Number(cfg.admission.agentSandboxMemoryMb) || 0);
  const ceiling = Math.max(0, Math.round(snap.memory.totalMb * 1.5) - reservedMb);
  if (wouldCommit > ceiling) {
    reasons.push("committed memory would reach " + wouldCommit + "MB of a " + ceiling + "MB ceiling");
  }

  return { ok: reasons.length === 0, reasons, snapshot: snap, committedMb: wouldCommit };
}

/** How many slots are held back. Clamped so a misconfiguration cannot
    reserve the entire host and refuse every deployment. */
function reservedSandboxes() {
  const want = Number(cfg.admission.agentSandboxes) || 0;
  if (want <= 0) return 0;
  return Math.min(want, Math.max(0, cfg.admission.maxContainers - 1));
}

/** What deployments may actually use. Always at least 1: a host that
    admits nothing is worse than one that runs the agent a little thin. */
function deploymentLimit() {
  return Math.max(1, cfg.admission.maxContainers - reservedSandboxes());
}

/** Threshold breaches worth alerting on. */
async function alerts() {
  const snap = await snapshot();
  const out = [];
  if (snap.memory.pct > 80) out.push({ level: "warn", metric: "memory", value: snap.memory.pct, message: "memory above 80%" });
  if (snap.cpuPct > 80) out.push({ level: "warn", metric: "cpu", value: snap.cpuPct, message: "sustained load above 80%" });
  if (snap.disk && snap.disk.pct > 80) out.push({ level: "warn", metric: "disk", value: snap.disk.pct, message: "disk above 80%" });
  if (snap.containers.total > deploymentLimit() * 0.9) {
    out.push({ level: "warn", metric: "containers", value: snap.containers.total, message: "near the container limit" });
  }
  // Crash loops: a container Docker keeps restarting is failing, and the
  // restart policy hides it from every other signal.
  // null = no socket here, so there is nothing to inspect. Only the worker
  // can answer this one.
  const managed = await engine.listManaged();
  for (const c of managed || []) {
    const id = c.name.replace(/^app-/, "");
    const st = await engine.inspectState(id);
    if (st.exists && st.restarts >= 5) {
      out.push({ level: "error", metric: "crashloop", value: st.restarts, message: c.name + " has restarted " + st.restarts + " times" });
    }
  }
  return { alerts: out, snapshot: snap };
}

module.exports = { snapshot, canAdmit, alerts, memory, disk, loadPct, reservedSandboxes, deploymentLimit };
