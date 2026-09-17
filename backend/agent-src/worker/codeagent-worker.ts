"use strict";

import * as path from "path";
// Side-effecting, and it must run before anything reads process.env.
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

import * as crypto from "crypto";
import * as db from "../db";
import * as store from "../lib/codeagent/run-store";
import * as runner from "../lib/codeagent/agent-runner";
import { createVerifier, executeClaim } from "../lib/codeagent/worker-service";

export async function main(): Promise<void> {
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
    } catch {
      await store.workerHeartbeat(workerId, { ready: false, version: 1 });
    } finally { healthBusy = false; }
  }
  await heartbeat();

  /* Say so. The worker used to start completely silently — it connected
     to Mongo, began claiming, and printed nothing ever again unless a
     run failed. That is indistinguishable from a process that hung, and
     it is what made ship.sh unable to tell a healthy deploy from a dead
     one on the first attempt. */
  const health = await store.getWorkerHealth().catch(() => null);
  console.log("[agent-worker] ready — id " + workerId +
    ", verifier " + ((health && health.healthy) ? "reachable" : "UNREACHABLE") +
    ", claiming from agent_runs");
  const healthTimer = setInterval(() => heartbeat().catch((e: Error) => console.error("[agent-worker] heartbeat:", e.message)), 10000);
  try {
    while (!shutdown.signal.aborted) {
      await store.recoverExpiredRuns();
      const health = await store.getWorkerHealth();
      const run = health.healthy ? await store.claimNext(workerId) : null;
      if (run) {
        try { await executeClaim({ run, workerId, store, runner, verifier, withTransaction: db.withTransaction, signal: shutdown.signal }); }
        catch (error: any) { console.error("[agent-worker] run", run.id, (error as Error).message); }
      } else {
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, 1000); if (shutdown.signal.aborted) { clearTimeout(timer); resolve(); } });
      }
    }
  } finally {
    clearInterval(healthTimer);
    await store.workerHeartbeat(workerId, { ready: false, version: 1 });
    await db.close();
  }
}

if (require.main === module) main().catch((error: Error) => { console.error("[agent-worker]", error.message); process.exitCode = 1; });

