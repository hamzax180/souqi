"use strict";

import * as path from "path";
// Side-effecting, and it must run before anything reads process.env.
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

import * as crypto from "crypto";
import * as db from "../db";
import * as store from "../lib/codeagent/run-store";
import * as runner from "../lib/codeagent/agent-runner";
import { createVerifier, executeClaim } from "../lib/codeagent/worker-service";
/* The worker has to make an uploaded photo permanent, same as the route
   does. Both modules are wired exactly as index.js wires them, so the
   two executors clear the expiry through one code path rather than two
   that can drift. */
import * as uploads from "../lib/uploads";
import * as blobs from "../lib/storage/blobs";

export async function main(): Promise<void> {
  const verifier = createVerifier({ url: process.env.AGENT_VERIFIER_URL, token: process.env.AGENT_VERIFIER_TOKEN });
  await db.connect();
  store.init({ getMasterDb: db.getMasterDb });
  blobs.init({ getMasterDb: db.getMasterDb, getBlobDb: () => db.getSiblingDb("blobs") });
  uploads.init({ getMasterDb: db.getMasterDb, onPersist: (keys: any) => blobs.persist(keys) });
  await store.ensureIndexes();
  /* The blob store's indexes were created on one path only — the legacy
     in-process SSE build — which this worker replaced, so in production
     neither existed: no unique key to make a retried part overwrite
     itself, and no TTL, so every abandoned upload's bytes stayed forever. */
  await blobs.ensureIndexes();
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
        try {
          await executeClaim({
            run, workerId, store, runner, verifier,
            withTransaction: db.withTransaction, signal: shutdown.signal,
            /* Called after the finalizer commits. attachToProject clears the
               24h expiry on the row for ever and fires onPersist, which does
               the same for the bytes — the one thing standing between a
               published site and a 404 the day after it was built. */
            onAttach: async (finished: any) => {
              const imgs = (finished.context && finished.context.attachedImages) || [];
              const ids = imgs.map((i: any) => i && i.id).filter(Boolean);
              if (ids.length && finished.projectId) await uploads.attachToProject(ids, finished.projectId);
            }
          });
        }
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

