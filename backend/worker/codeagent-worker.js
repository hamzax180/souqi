"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const crypto = require("crypto");
const db = require("../db");
const store = require("../lib/codeagent/run-store");
const runner = require("../lib/codeagent/agent-runner");
const { createVerifier, executeClaim } = require("../lib/codeagent/worker-service");

async function main() {
  const verifier = createVerifier({ url: process.env.AGENT_VERIFIER_URL, token: process.env.AGENT_VERIFIER_TOKEN });
  await db.connect();
  store.init({ getMasterDb: db.getMasterDb });
  await store.ensureIndexes();
  const workerId = "agent_" + crypto.randomUUID();
  const shutdown = new AbortController();
  process.once("SIGTERM", () => shutdown.abort());
  process.once("SIGINT", () => shutdown.abort());
  let healthBusy = false;
  async function heartbeat() {
    if (healthBusy) return;
    healthBusy = true;
    try {
      const health = await verifier.health();
      await store.workerHeartbeat(workerId, { ready: health.ok === true, version: 1 });
    } catch (error) {
      await store.workerHeartbeat(workerId, { ready: false, version: 1 });
    } finally { healthBusy = false; }
  }
  await heartbeat();
  const healthTimer = setInterval(() => heartbeat().catch(e => console.error("[agent-worker] heartbeat:", e.message)), 10000);
  try {
    while (!shutdown.signal.aborted) {
      await store.recoverExpiredRuns();
      const health = await store.getWorkerHealth();
      const run = health.healthy ? await store.claimNext(workerId) : null;
      if (run) {
        try { await executeClaim({ run, workerId, store, runner, verifier, withTransaction: db.withTransaction, signal: shutdown.signal }); }
        catch (error) { console.error("[agent-worker] run", run.id, error.message); }
      } else {
        await new Promise(resolve => { const timer = setTimeout(resolve, 1000); if (shutdown.signal.aborted) { clearTimeout(timer); resolve(); } });
      }
    }
  } finally {
    clearInterval(healthTimer);
    await store.workerHeartbeat(workerId, { ready: false, version: 1 });
    await db.close();
  }
}

if (require.main === module) main().catch(error => { console.error("[agent-worker]", error.message); process.exitCode = 1; });
module.exports = { main };
