/* =================================================================
   admission-test.js — what a redeploy is allowed to cost
   -----------------------------------------------------------------
   Both cases here were found in production on one deployment, and
   together they took a live site down and kept it down:

     [worker] dep_afd2ae... -> RUNNING https://app-afd2ae9650a3.souqi.site
     [worker] dep_afd2ae... -> FAILED  ... at its container limit (10)

   The redeploy was refused for being over the limit — a refusal to do
   anything at all — and the refusal removed the container that was
   serving the site, because the cleanup in fail() keyed on a name a
   redeploy shares with the revision it replaces.

   Run: node deploy/test/admission-test.js
   ================================================================= */
"use strict";
const assert = require("assert");
const path = require("path");

let passed = 0;
function ok(name, fn) {
  try { fn(); console.log("  ok  " + name); passed++; }
  catch (e) { console.error("  FAIL " + name + "\n       " + e.message); process.exitCode = 1; }
}
async function okAsync(name, fn) {
  try { await fn(); console.log("  ok  " + name); passed++; }
  catch (e) { console.error("  FAIL " + name + "\n       " + e.message); process.exitCode = 1; }
}

/* Stub the engine before capacity.js requires it, so nothing here needs a
   Docker socket or a database. */
const enginePath = require.resolve(path.join(__dirname, "..", "src", "docker", "engine.js"));
const realEngine = require(enginePath);
let managed = [];
require.cache[enginePath].exports = Object.assign({}, realEngine, {
  listManaged: async () => managed
});

/* And the database, for the same reason: the committed-memory query is not
   what these cases are about, and requiring Postgres to test arithmetic
   about container names would mean nobody runs this. */
const dbPath = require.resolve(path.join(__dirname, "..", "src", "db.js"));
const realDb = require(dbPath);
require.cache[dbPath].exports = Object.assign({}, realDb, {
  one: async () => ({ mb: 0 }),
  many: async () => []
});

/* config exports { cfg }, so the override has to go INSIDE that key —
   replacing the module's own top level leaves capacity.js destructuring the
   real one and every limit here comes from whatever .env is on the machine. */
const cfgPath = require.resolve(path.join(__dirname, "..", "src", "config.js"));
const realCfgMod = require(cfgPath);
require.cache[cfgPath].exports = Object.assign({}, realCfgMod, {
  cfg: Object.assign({}, realCfgMod.cfg, {
    hostId: "test-host",
    buildRoot: require("os").tmpdir(),
    defaults: Object.assign({}, realCfgMod.cfg.defaults, { memoryMb: 256 }),
    admission: Object.assign({}, realCfgMod.cfg.admission, {
      maxContainers: 10, maxMemoryPct: 200, maxDiskPct: 200
    })
  })
});

const capacity = require(path.join(__dirname, "..", "src", "monitor", "capacity.js"));
const name = (id) => realEngine.containerName(id);

function fill(n) {
  managed = [];
  for (let i = 0; i < n; i++) managed.push({ name: name("dep_full" + i), state: "running", image: "img" });
}

/* Exactly at the limit deployments actually have, which is maxContainers
   minus the sandbox reserve. The cases below used to fill a hardcoded 10;
   once slots were reserved that became an OVERSHOOT, and a host two over
   its limit answers "is it full" without anyone testing the edge. */
const fillToLimit = () => fill(capacity.deploymentLimit());

(async () => {
  console.log("\nadmission counts a redeploy as the replacement it is");

  await okAsync("a full host still refuses a NEW app", async () => {
    fillToLimit();
    const r = await capacity.canAdmit({ memoryMb: 256 });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reasons.join(" ").indexOf("container limit") !== -1, r.reasons.join("; "));
  });

  await okAsync("a full host admits a redeploy of an app already on it", async () => {
    /* The bug: the app that was already running was itself the reason its
       own redeploy was refused, so the only way to update anything on a full
       host was to delete something else first. */
    fillToLimit();
    const existing = managed[Math.min(3, managed.length - 1)].name.replace(/^app-/, "");
    const r = await capacity.canAdmit({ memoryMb: 256, replacingDeploymentId: existing });
    assert.strictEqual(r.ok, true, "refused a redeploy that nets zero containers: " + (r.reasons || []).join("; "));
  });

  await okAsync("a full host still refuses an id that has no container here", async () => {
    // Naming an id is not a password. If nothing of that name is running,
    // the deploy really is an addition and the limit really does apply.
    fillToLimit();
    const r = await capacity.canAdmit({ memoryMb: 256, replacingDeploymentId: "dep_neverseen" });
    assert.strictEqual(r.ok, false);
  });

  await okAsync("a host with room admits either kind", async () => {
    fill(3);
    const a = await capacity.canAdmit({ memoryMb: 256 });
    assert.strictEqual(a.ok, true, (a.reasons || []).join("; "));
    const existing = managed[0].name.replace(/^app-/, "");
    const b = await capacity.canAdmit({ memoryMb: 256, replacingDeploymentId: existing });
    assert.strictEqual(b.ok, true, (b.reasons || []).join("; "));
  });

  console.log("\nslots held back for the agent are not available to deployments");

  await okAsync("deployments admit against maxContainers minus the reserve", async () => {
    assert.strictEqual(capacity.reservedSandboxes(), 2, "expected 2 reserved for this stub");
    assert.strictEqual(capacity.deploymentLimit(), 8, "10 - 2 should leave 8");
  });

  await okAsync("one below the deployment limit still admits", async () => {
    fill(capacity.deploymentLimit() - 1);
    const r = await capacity.canAdmit({ memoryMb: 256 });
    assert.strictEqual(r.ok, true, (r.reasons || []).join("; "));
  });

  /* The whole point: the host has two free container slots by the raw
     count, and a deployment still cannot have them. */
  await okAsync("at the deployment limit it refuses, with the host not actually full", async () => {
    fill(capacity.deploymentLimit());
    const r = await capacity.canAdmit({ memoryMb: 256 });
    assert.strictEqual(r.ok, false);
    const why = r.reasons.join("; ");
    assert.ok(why.indexOf("container limit") !== -1, why);
    assert.ok(why.indexOf("reserved for build sandboxes") !== -1,
      "the refusal does not say the slots are reserved: " + why);
    assert.ok(managed.length < realCfgMod.cfg.admission.maxContainers,
      "this case is meant to refuse while raw slots remain");
  });

  /* A redeploy nets zero containers, so the reserve is irrelevant to it —
     the same reasoning the original bug above was fixed for. */
  await okAsync("a redeploy is still admitted at the reserved limit", async () => {
    fill(capacity.deploymentLimit());
    const existing = managed[0].name.replace(/^app-/, "");
    const r = await capacity.canAdmit({ memoryMb: 256, replacingDeploymentId: existing });
    assert.strictEqual(r.ok, true, (r.reasons || []).join("; "));
  });

  await okAsync("setting the reserve to zero restores the old arithmetic exactly", async () => {
    const admission = require(cfgPath).cfg.admission;
    const was = admission.agentSandboxes;
    admission.agentSandboxes = 0;
    try {
      assert.strictEqual(capacity.reservedSandboxes(), 0);
      assert.strictEqual(capacity.deploymentLimit(), realCfgMod.cfg.admission.maxContainers);
      fill(realCfgMod.cfg.admission.maxContainers - 1);
      const r = await capacity.canAdmit({ memoryMb: 256 });
      assert.strictEqual(r.ok, true, (r.reasons || []).join("; "));
    } finally { admission.agentSandboxes = was; }
  });

  /* Holding a slot and then letting deployments commit the memory that
     slot would need reserves nothing: the slot is free and the box is full. */
  await okAsync("the reserve comes off the memory ceiling, not off what a deploy commits", async () => {
    const admission = require(cfgPath).cfg.admission;
    const was = admission.agentSandboxMemoryMb;
    try {
      fill(1);
      admission.agentSandboxMemoryMb = 1024;
      const withReserve = await capacity.canAdmit({ memoryMb: 256 });
      admission.agentSandboxMemoryMb = 0;
      const without = await capacity.canAdmit({ memoryMb: 256 });
      assert.strictEqual(withReserve.committedMb, without.committedMb,
        "the reserve should move the ceiling, not what a deploy commits");
    } finally { admission.agentSandboxMemoryMb = was; }
  });

  /* A misconfiguration must not be able to refuse every deployment. */
  await okAsync("an absurd reserve cannot close the host", async () => {
    const admission = require(cfgPath).cfg.admission;
    const was = admission.agentSandboxes;
    admission.agentSandboxes = 9999;
    try {
      assert.ok(capacity.deploymentLimit() >= 1, "the host stopped admitting anything at all");
      assert.ok(capacity.reservedSandboxes() < realCfgMod.cfg.admission.maxContainers);
    } finally { admission.agentSandboxes = was; }
  });

  console.log("\nfailing must not be more destructive than succeeding");

  ok("fail() only removes a container once the attempt owns the name", () => {
    /* Read from source rather than executed: pipeline.js pulls in the
       database, the docker engine and the whole worker at require time, and
       the property worth pinning is structural — that the cleanup is behind
       the flag, and that no failure before the swap passes it. */
    const fs = require("fs");
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "worker", "pipeline.js"), "utf8");

    const body = src.slice(src.indexOf("async function fail("), src.indexOf("/* ---------- env ---------- */"));
    assert.match(body, /if \(ownsContainer\) \{/,
      "fail() removes the container unconditionally again — a refused deploy would delete the live app");

    const deployBody = src.slice(src.indexOf("async function deploy(dep, sourceDir)"));
    const swapAt = deployBody.indexOf("ownsContainer = true");
    assert.ok(swapAt > 0, "the swap no longer marks the container as this attempt's");

    // Every fail() before the swap must NOT pass the flag, and the ones
    // after it must.
    const before = deployBody.slice(0, swapAt);
    const after = deployBody.slice(swapAt);
    assert.ok(before.indexOf("ownsContainer)") === -1,
      "a failure BEFORE the swap passes ownsContainer — that is the path that killed the live site");
    const afterFails = (after.match(/return fail\(id,/g) || []).length;
    const afterOwning = (after.match(/ownsContainer\)/g) || []).length;
    assert.strictEqual(afterFails, afterOwning,
      "a failure after the swap leaves this attempt's broken container running");
  });

  console.log("\n" + passed + " passed" + (process.exitCode ? " — WITH FAILURES" : "") + "\n");
})();
