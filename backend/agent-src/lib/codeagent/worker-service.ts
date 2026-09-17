"use strict";

import { decryptSecret } from "../crypto";
import { monthKey, ownerKey } from "./usage";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const TERMINAL = new Set(["succeeded", "partial", "failed", "cancelled", "blocked"]);

export function publicRun(run: any): any {
  if (!run) return null;
  const fields = ["id", "projectId", "chatId", "status", "phase", "createdAt", "updatedAt",
    "latestError", "costUsd", "result", "latestCheckpointId", "cancelled", "cancelReason"];
  return Object.fromEntries(fields.filter(k => run[k] !== undefined).map(k => [k, run[k]]));
}

export function createVerifier({ url, token, fetchImpl = globalThis.fetch }: any): any {
  if (!url || !token || token.length < 32) throw new Error("Configure AGENT_VERIFIER_URL and a 32+ character AGENT_VERIFIER_TOKEN");
  const endpoint = new URL(url);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error("Invalid verifier URL");
  /* The deploy plane's convention, not a second one invented here: its
     internal surface authenticates with x-internal-token and compares
     it in constant time (infra/deploy/src/api/auth.js). AGENT_VERIFIER_TOKEN
     and the plane's INTERNAL_TOKEN are the same secret.

     Paths are joined RELATIVE to the configured base. `new URL("/health",
     base)` discards the base's path and asks the origin, which would have
     hit the plane's own public /health and read a healthy plane as a
     healthy verifier. */
  async function request(path: any, body: any, signal: any) {
    const base = endpoint.href.endsWith("/") ? endpoint.href : endpoint.href + "/";
    const response = await fetchImpl(new URL(String(path).replace(/^\//, ""), base), {
      method: body ? "POST" : "GET", redirect: "error", signal,
      /* TWO tokens, because there are two gates guarding different
         things. The deploy plane's control hostname is fenced app-wide
         by x-platform-token (auth.js requirePlatformToken) before any
         route is reached; the verifier route is then fenced by
         x-internal-token. Sending only the second gets a 401 from the
         hostname gate and never reaches the route — which is exactly
         what happened the first time this was pointed at production.

         DEPLOY_PLATFORM_TOKEN is the variable lib/deployplane.js
         already uses for the same hop, so there is one name for it. */
      headers: Object.assign(
        { "x-internal-token": token, "Content-Type": "application/json" },
        process.env.DEPLOY_PLATFORM_TOKEN ? { "x-platform-token": process.env.DEPLOY_PLATFORM_TOKEN } : {}
      ),
      body: body ? JSON.stringify(body) : undefined
    });
    if (!response.ok) throw new Error("Build service returned HTTP " + response.status);
    return response.json();
  }
  return {
    health: () => request("health", null, AbortSignal.timeout(5000)),
    check: (files: any, context: any) => request("check", {
      runId: context.runId, checkId: context.checkId, sourceHash: context.sourceHash, files
    }, context.signal)
  };
}

/* The run and the project must agree even if the worker dies just after commit.
   Full source snapshots also survive pruning an earlier revision's delta. */
export function createFinalizer({ withTransaction, run, workerId, generation }: any): any {
  return async function finalize(outcome: any, status: any) {
    if (!TERMINAL.has(status)) throw new Error("Invalid terminal run state");
    return withTransaction(async (db: any, session: any) => {
      const runs = db.collection("agent_runs");
      const current = await runs.findOne({ id: run.id }, { session });
      if (!current || TERMINAL.has(current.status) || current.cancelled && status !== "cancelled" ||
          current.leaseOwner !== workerId || current.leaseGeneration !== generation ||
          current.leaseExpiresAt <= new Date().toISOString()) return false;

      const result = Object.assign({}, outcome, { status, projectId: run.projectId });
      const now = new Date().toISOString();
      const project = await db.collection("projects").findOne({ id: run.projectId }, { session });
      if (!project || (run.ownerUserId ? project.ownerUserId !== run.ownerUserId : project.ownerAnonId !== run.ownerAnonId)) {
        throw new Error("Project was deleted or its owner changed while the agent was working");
      }
      result.slug = project.slug;
      if (status === "succeeded" && outcome.files && Object.keys(outcome.files).length && outcome.fileStats && outcome.fileStats.some((f: any) => f.isNew || f.added || f.removed)) {
        const revisionId = "rv_" + run.id;
        const changed = await db.collection("projects").updateOne({
          id: project.id, headRevision: run.baseRevisionId || null
        }, { $set: { headRevision: revisionId, updatedAt: now } }, { session });
        if (!changed.matchedCount) throw new Error("Project changed during this run; candidate files are saved, but were not applied");
        await db.collection("revisions").updateOne({ id: revisionId }, { $setOnInsert: {
          id: revisionId, projectId: project.id, parentId: null,
          config: { files: outcome.files }, label: String(outcome.summary || "Agent result").slice(0, 60), at: now
        } }, { upsert: true, session });
        result.revisionId = revisionId;
      }
      const lastTurn = await db.collection("turns").findOne({ projectId: project.id }, { sort: { seq: -1 }, session });
      await db.collection("turns").updateOne({ id: "turn_" + run.id }, { $setOnInsert: {
        id: "turn_" + run.id, projectId: project.id, seq: ((lastTurn && lastTurn.seq) || 0) + 1,
        chatId: run.chatId || "", role: "agent", kind: status === "succeeded" ? "result" : "text",
        body: String(outcome.summary || outcome.reason || status).slice(0, 4000),
        revisionId: result.revisionId || null, fileStats: outcome.fileStats || [], at: now
      } }, { upsert: true, session });
      const usd = Number(outcome.costUsd) || 0;
      if (usd > 0 && !(run.context && run.context.byokEncrypted)) {
        const owner = ownerKey({ userId: run.ownerUserId, anonId: run.ownerAnonId });
        await db.collection("codeagent_usage").updateOne({ owner, month: monthKey() }, {
          $inc: { costUsd: usd, builds: 1 }, $set: { updatedAt: now }
        }, { upsert: true, session });
        await db.collection("codeagent_usage_events").insertOne({ owner, at: new Date(), usd, runId: run.id }, { session });
      }
      await runs.updateOne({ id: run.id }, { $set: {
        status, phase: status, result, costUsd: usd, updatedAt: now,
        /* Persisted, not just returned. The brief asks for explicit stop
           reasons and the first worker run ended with none on the row:
           the runner produced one, handed it back, and the only writer
           of the document never wrote it down. */
        stopReason: outcome.stopReason || null,
        latestError: status === "succeeded" ? null : outcome.reason || outcome.summary || status
      }, $unset: {
        "context.byokEncrypted": "",
        /* The same three run-store.updateRun releases on a terminal
           status, and for the same reason: activeOwnerKey carries a
           unique partial index, so a finished run that keeps it refuses
           the owner's next build with RUN_ALREADY_ACTIVE for ever.

           It never mattered while nothing called this finalizer —
           updateRun was doing the release. Making this the one writer
           moved that duty here, and the first live run after the change
           came back terminal with all three still set. */
        activeProjectId: "", activeOwnerKey: "", leaseExpiresAt: ""
      } }, { session });
      return true;
    });
  };
}

export async function executeClaim({ run, workerId, store, runner, verifier, withTransaction, signal }: any): Promise<any> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal && signal.reason);
  if (signal) signal.addEventListener("abort", abort, { once: true });
  if (signal && signal.aborted) abort();
  const generation = run.leaseGeneration;
  let renewing = false;
  const timer = setInterval(async () => {
    if (renewing) return;
    renewing = true;
    try {
      if (!await store.renewLease(run.id, workerId, generation)) controller.abort(new Error("Worker lease lost"));
    } catch (error: any) { controller.abort(error); }
    finally { renewing = false; }
  }, 10000);
  try {
    const context = run.context || {};
    const byok = context.byokEncrypted ? JSON.parse(decryptSecret(context.byokEncrypted)) : undefined;
    return await runner.executeRun(run.id, Object.assign({}, context, {
      byok, signal: controller.signal, claimed: { workerId, generation },
      checkProject: verifier.check,
      finalize: createFinalizer({ withTransaction, run, workerId, generation })
    }));
  } finally {
    clearInterval(timer);
    if (signal) signal.removeEventListener("abort", abort);
  }
}


