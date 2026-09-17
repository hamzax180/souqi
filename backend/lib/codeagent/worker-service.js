"use strict";

const { decryptSecret } = require("../crypto");
const { monthKey, ownerKey } = require("./usage");

const TERMINAL = new Set(["succeeded", "partial", "failed", "cancelled", "blocked"]);

function publicRun(run) {
  if (!run) return null;
  const fields = ["id", "projectId", "chatId", "status", "phase", "createdAt", "updatedAt",
    "latestError", "costUsd", "result", "latestCheckpointId", "cancelled", "cancelReason"];
  return Object.fromEntries(fields.filter(k => run[k] !== undefined).map(k => [k, run[k]]));
}

function createVerifier({ url, token, fetchImpl = globalThis.fetch }) {
  if (!url || !token || token.length < 32) throw new Error("Configure AGENT_VERIFIER_URL and a 32+ character AGENT_VERIFIER_TOKEN");
  const endpoint = new URL(url);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error("Invalid verifier URL");
  async function request(path, body, signal) {
    const response = await fetchImpl(new URL(path, endpoint), {
      method: body ? "POST" : "GET", redirect: "error", signal,
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!response.ok) throw new Error("Build service returned HTTP " + response.status);
    return response.json();
  }
  return {
    health: () => request("/health", null, AbortSignal.timeout(5000)),
    check: (files, context) => request("/check", {
      runId: context.runId, checkId: context.checkId, sourceHash: context.sourceHash, files
    }, context.signal)
  };
}

/* The run and the project must agree even if the worker dies just after commit.
   Full source snapshots also survive pruning an earlier revision's delta. */
function createFinalizer({ withTransaction, run, workerId, generation }) {
  return async function finalize(outcome, status) {
    if (!TERMINAL.has(status)) throw new Error("Invalid terminal run state");
    return withTransaction(async (db, session) => {
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
      if (status === "succeeded" && outcome.files && Object.keys(outcome.files).length && outcome.fileStats && outcome.fileStats.some(f => f.isNew || f.added || f.removed)) {
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
        latestError: status === "succeeded" ? null : outcome.reason || outcome.summary || status
      }, $unset: { "context.byokEncrypted": "" } }, { session });
      return true;
    });
  };
}

async function executeClaim({ run, workerId, store, runner, verifier, withTransaction, signal }) {
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
    } catch (error) { controller.abort(error); }
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

module.exports = { TERMINAL, publicRun, createVerifier, createFinalizer, executeClaim };
