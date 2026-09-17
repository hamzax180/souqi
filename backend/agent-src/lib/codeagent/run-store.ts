/* Durable agent runs, ordered replay events, and immutable checkpoints. */

import * as crypto from "crypto";
import type { GetMasterDb, MongoDb } from "./mongo";

export interface RunOwner {
  userId?: string | null;
  anonId?: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/* The documents are Mongo's shape, not ours: they are read back from the
   driver, handed to callers that pick fields off them, and written to by
   $set patches built at the call site. Naming every field here would be a
   second schema to keep in step with the one the createRun literal below
   already is — and the literal is the one that runs. */
export type RunDoc = any;
export type EventDoc = any;
export type CheckpointDoc = any;
/* awaiting_answer is ACTIVE, not terminal. The run is alive and holding:
   its lease keeps renewing, its checkpoint stands, and it resumes on the
   same transcript when the answer arrives. Listing it as terminal would
   release the single-active-run slot and let a second run start on the
   same project while the first still owns its files. */
const ACTIVE = ["queued", "running", "waiting_for_check", "awaiting_answer", "finalizing"];
const TERMINAL = ["succeeded", "failed", "cancelled", "partial"];
let getMasterDb: GetMasterDb = () => null;
let indexPromises = new WeakMap<object, Promise<MongoDb>>();
const eventQueues = new Map<string, Promise<any>>();
const id = (prefix: string) => prefix + "_" + crypto.randomBytes(10).toString("base64url");
const now = () => new Date().toISOString();
const copy = <T,>(value: T): T => structuredClone(value);

function error(code: string, message: string, statusCode = 503): Error {
  return Object.assign(new Error(message), { code, statusCode });
}
export function init(deps: { getMasterDb: GetMasterDb }): void {
  if (deps && typeof deps.getMasterDb === "function") {
    getMasterDb = deps.getMasterDb;
    indexPromises = new WeakMap();
  }
}
function dbRequired(): MongoDb {
  const db = getMasterDb();
  if (!db) throw error("AGENT_STORE_UNAVAILABLE", "Agent storage is unavailable. Please try again shortly.");
  return db;
}
export async function ensureIndexes(): Promise<MongoDb> {
  const db = dbRequired();
  if (!indexPromises.has(db)) {
    const ready = (async () => {
      await db.collection("agent_runs").createIndex({ id: 1 }, { unique: true });
      await db.collection("agent_runs").createIndex({ ownerAnonId: 1, updatedAt: -1 });
      await db.collection("agent_runs").createIndex({ ownerUserId: 1, updatedAt: -1 });
      await db.collection("agent_runs").createIndex({ projectId: 1, createdAt: -1 });
      await db.collection("agent_runs").createIndex({ ownerKey: 1, idempotencyKey: 1 }, {
        unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } }
      });
      for (const key of ["activeProjectId", "activeOwnerKey"]) {
        await db.collection("agent_runs").createIndex({ [key]: 1 }, {
          unique: true, partialFilterExpression: { [key]: { $type: "string" } }
        });
      }
      await db.collection("agent_runs").createIndex({ status: 1, createdAt: 1 });
      await db.collection("agent_runs").createIndex({ leaseExpiresAt: 1, status: 1 });
      await db.collection("agent_events").createIndex({ runId: 1, seq: 1 }, { unique: true });
      await db.collection("agent_checkpoints").createIndex({ id: 1 }, { unique: true });
      await db.collection("agent_checkpoints").createIndex({ runId: 1, at: -1 });
      await db.collection("agent_steps").createIndex({ runId: 1, stepIndex: 1 });
      await db.collection("agent_workers").createIndex({ workerId: 1 }, { unique: true });
      await db.collection("agent_workers").createIndex({ at: -1 });
    })().catch((cause) => {
      indexPromises.delete(db);
      throw Object.assign(error("AGENT_STORE_UNAVAILABLE", "Agent storage indexes could not be initialized."), { cause });
    });
    indexPromises.set(db, ready.then(() => db));
  }
  await indexPromises.get(db);
  return db;
}
export function owns(run: RunDoc, owner: RunOwner): boolean {
  if (!run || !owner) return false;
  if (run.ownerUserId) return !!owner.userId && String(run.ownerUserId) === String(owner.userId);
  return !!owner.anonId && run.ownerAnonId === owner.anonId;
}
function ownerKey(owner: RunOwner): string {
  if (owner && owner.userId) return "user:" + String(owner.userId);
  if (owner && owner.anonId) return "anon:" + String(owner.anonId);
  throw error("AGENT_OWNER_REQUIRED", "An agent run must have an owner.", 400);
}
function fenceQuery(fence: any): any {
  if (!fence) return {};
  return { leaseOwner: fence.workerId, leaseGeneration: fence.generation, leaseExpiresAt: { $gt: now() } };
}
function asDocument(result: any): any {
  return result && Object.prototype.hasOwnProperty.call(result, "value") ? result.value : result;
}
function leaseDuration(value: any): number {
  return Math.max(1000, Math.min(600000, Number(value) || 60000));
}
export async function getRunByIdempotency(owner: RunOwner, key: string, requestHash: string): Promise<RunDoc> {
  if (!key) return null;
  const existing = await dbRequired().collection("agent_runs").findOne(
    { ownerKey: ownerKey(owner), idempotencyKey: key }, { projection: { _id: 0 } }
  );
  if (existing && existing.requestHash !== (requestHash || null)) {
    throw error("IDEMPOTENCY_CONFLICT", "This request key has already been used for a different request.", 409);
  }
  return existing;
}

export async function createRun({ projectId, owner, prompt, mode, effort, baseFiles, chatId,
  context, idempotencyKey, requestHash, baseRevisionId, meta }: any): Promise<RunDoc> {
  const db = await ensureIndexes();
  const scope = ownerKey(owner);
  const c = db.collection("agent_runs");
  const existing = await getRunByIdempotency(owner, idempotencyKey, requestHash);
  if (existing) return existing;
  const at = now();
  const runDoc: RunDoc = {
    id: id("run"), projectId: projectId || null, ownerKey: scope, activeOwnerKey: scope,
    ownerAnonId: (owner && owner.anonId) || null,
    ownerUserId: (owner && owner.userId && String(owner.userId)) || null,
    chatId: chatId || "", prompt: String(prompt || "").trim(),
    mode: mode || "auto", effort: effort || "balanced", status: "queued", phase: "init",
    createdAt: at, updatedAt: at, cancelled: false, cancelReason: null,
    latestCheckpointId: null, latestError: null, costUsd: 0,
    context: copy(context || {}), meta: copy(meta || {}), baseRevisionId: baseRevisionId || null,
    requestHash: requestHash || null, leaseGeneration: 0
  };
  if (idempotencyKey) runDoc.idempotencyKey = idempotencyKey;
  if (projectId) runDoc.activeProjectId = projectId;
  // A worker can claim immediately after insertion. Its baseline must already exist.
  let baseline;
  if (baseFiles && Object.keys(baseFiles).length) {
    baseline = checkpointDoc(runDoc.id, baseFiles, "Initial project baseline");
    await db.collection("agent_checkpoints").insertOne(copy(baseline));
    runDoc.latestCheckpointId = baseline.id;
  }
  try {
    await c.insertOne(copy(runDoc));
  } catch (cause) {
    if (baseline) await db.collection("agent_checkpoints").deleteOne({ id: baseline.id });
    if ((cause as any).code === 11000) {
      const retried = await getRunByIdempotency(owner, idempotencyKey, requestHash);
      if (retried) return retried;
      throw error("RUN_ALREADY_ACTIVE", "You already have an active agent run. Wait for it to finish or stop it before starting another.", 409);
    }
    throw cause;
  }
  await appendEvent(runDoc.id, "run_created", { runId: runDoc.id, status: "queued", prompt: runDoc.prompt });
  return runDoc;
}
export async function getRun(runId: string, owner?: RunOwner): Promise<RunDoc> {
  const run = await dbRequired().collection("agent_runs").findOne({ id: runId }, { projection: { _id: 0 } });
  return run && (!owner || owns(run, owner)) ? run : null;
}
export async function updateRun(runId: string, updates: any, fence?: any): Promise<any> {
  const patch = copy(updates || {});
  for (const key of ["id", "_id", "ownerKey", "ownerAnonId", "ownerUserId", "projectId", "createdAt",
    "idempotencyKey", "requestHash", "activeProjectId", "activeOwnerKey", "latestCheckpointId", "leaseOwner", "leaseGeneration", "leaseExpiresAt", "cancelled"]) {
    delete patch[key];
  }
  if (patch.status && !ACTIVE.includes(patch.status) && !TERMINAL.includes(patch.status)) {
    throw error("INVALID_RUN_STATUS", "Unknown agent run status.", 400);
  }
  patch.updatedAt = now();
  const update: any = { $set: patch };
  if (TERMINAL.includes(patch.status)) update.$unset = { activeProjectId: "", activeOwnerKey: "", leaseExpiresAt: "" };
  const result = await dbRequired().collection("agent_runs").updateOne(
    Object.assign({ id: runId, status: { $in: ACTIVE } }, fenceQuery(fence)), update
  );
  return result.modifiedCount > 0;
}
export async function claimRun(runId: string, updates: any = {}): Promise<RunDoc> {
  const db = await ensureIndexes();
  const at = now();
  const result = await db.collection("agent_runs").updateOne(
    { id: runId, status: "queued", cancelled: false },
    { $set: { status: "running", phase: updates.phase || "planning", updatedAt: at, claimedAt: at } }
  );
  return result.modifiedCount > 0;
}
export async function claimNext(workerId: string, leaseMs = 60000): Promise<RunDoc> {
  if (!workerId) throw error("WORKER_ID_REQUIRED", "Worker identity is required.", 400);
  const db = await ensureIndexes();
  const at = now();
  return asDocument(await db.collection("agent_runs").findOneAndUpdate(
    { status: "queued", cancelled: false },
    { $set: { status: "running", phase: "planning", leaseOwner: workerId,
      leaseExpiresAt: new Date(Date.now() + leaseDuration(leaseMs)).toISOString(), claimedAt: at, updatedAt: at },
    $inc: { leaseGeneration: 1 } },
    { sort: { createdAt: 1, id: 1 }, returnDocument: "after", includeResultMetadata: false, projection: { _id: 0 } }
  ));
}
export async function renewLease(runId: string, workerId: string, generation: number, leaseMs = 60000): Promise<boolean> {
  const result = await dbRequired().collection("agent_runs").updateOne(
    Object.assign({ id: runId, status: { $in: ACTIVE } }, fenceQuery({ workerId, generation })),
    { $set: { leaseExpiresAt: new Date(Date.now() + leaseDuration(leaseMs)).toISOString(), updatedAt: now() } }
  );
  return result.modifiedCount > 0;
}
export async function cancelRun(runId: string, owner: RunOwner, reason: string): Promise<boolean> {
  const run = await getRun(runId, owner);
  if (!run || !owner) return false;
  const cancelReason = String(reason || "Cancelled by user").slice(0, 1000);
  const result = await dbRequired().collection("agent_runs").updateOne(
    { id: runId, status: { $in: ACTIVE } },
    { $set: { cancelled: true, cancelReason, status: "cancelled", updatedAt: now(),
      result: { ok: false, cancelled: true, status: "cancelled", reason: cancelReason } },
    $unset: { activeProjectId: "", activeOwnerKey: "", leaseExpiresAt: "" } }
  );
  if (!result.modifiedCount) return false;
  await appendEvent(runId, "run_cancelled", { runId, reason: cancelReason });
  return true;
}

export async function appendEvent(runId: string, type: string, payload?: any): Promise<EventDoc> {
  const db = await ensureIndexes();
  const previous = eventQueues.get(runId) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const c = db.collection("agent_events");
    // Increment-and-insert counters left gaps, allowing reconnect cursors to skip
    // a late insert forever. Allocate only by inserting after the committed tail.
    for (let retry = 0; retry < 64; retry++) {
      const last = await c.findOne({ runId }, { sort: { seq: -1 }, projection: { seq: 1, _id: 0 } });
      const event = { runId, seq: last ? last.seq + 1 : 1, type, payload: copy(payload || {}), at: now() };
      try {
        await c.insertOne(copy(event));
        return event;
      } catch (cause) {
        if ((cause as any).code !== 11000) throw cause;
      }
    }
    throw error("AGENT_EVENT_CONTENTION", "Could not append an agent event after concurrent updates.");
  });
  eventQueues.set(runId, pending);
  try { return await pending; }
  finally { if (eventQueues.get(runId) === pending) eventQueues.delete(runId); }
}
export async function getEvents(runId: string, afterSeq = 0): Promise<EventDoc[]> {
  const seq = Number(afterSeq);
  return dbRequired().collection("agent_events").find(
    { runId, seq: { $gt: Number.isSafeInteger(seq) && seq >= 0 ? seq : 0 } },
    { sort: { seq: 1 }, projection: { _id: 0 } }
  ).toArray();
}
function checkpointDoc(runId: string, files: any, summary: string): CheckpointDoc {
  return { id: id("chk"), runId, files: copy(files || {}), fileCount: Object.keys(files || {}).length,
    summary: summary || "", at: now() };
}
export async function saveCheckpoint(runId: string, files: any, summary: string, fence?: any): Promise<CheckpointDoc | null> {
  const db = await ensureIndexes();
  const run = await getRun(runId);
  if (!run || !ACTIVE.includes(run.status)) return null;
  const doc = checkpointDoc(runId, files, summary);
  await db.collection("agent_checkpoints").insertOne(copy(doc));
  const result = await db.collection("agent_runs").updateOne(
    Object.assign({ id: runId, status: { $in: ACTIVE }, latestCheckpointId: run.latestCheckpointId }, fenceQuery(fence)),
    { $set: { latestCheckpointId: doc.id, updatedAt: doc.at } }
  );
  if (!result.modifiedCount) {
    await db.collection("agent_checkpoints").deleteOne({ id: doc.id });
    return null;
  }
  return doc;
}
/* ── the question a run is waiting on ──────────────────────────── */

export interface PendingQuestion {
  id: string;
  questions: any[];
  askedAt: string;
}

/**
 * Park the run on a question and record what was asked.
 *
 * The question lives on the run document rather than in memory because
 * the whole point is that it survives the process: a Vercel function
 * that asked a question and died has still asked it, and the answer
 * arrives at whichever instance happens to take the next request.
 */
export async function askQuestion(runId: string, question: PendingQuestion): Promise<boolean> {
  const result = await dbRequired().collection("agent_runs").updateOne(
    { id: runId, status: { $in: ACTIVE }, "meta.pendingQuestion": { $exists: false } },
    { $set: { status: "awaiting_answer", phase: "awaiting_answer",
              "meta.pendingQuestion": copy(question), updatedAt: now() } }
  );
  return !!result.matchedCount;
}

/**
 * Consume the answer. Exactly once, whatever the client does.
 *
 * The questionId is part of the query rather than checked after
 * reading, so two submissions of the same answer race on the same
 * document and one of them loses: the second sees matchedCount 0 and
 * is told the question is already answered, rather than resuming the
 * run a second time on the same transcript.
 *
 * Ownership is part of the query too. An unguessable run id is not
 * authorization, and this is the one route where a stranger's reply
 * would be indistinguishable from the owner's.
 */
export async function answerQuestion(
  runId: string, owner: RunOwner, questionId: string, answers: Record<string, string>
): Promise<boolean> {
  const scope = ownerKey(owner);
  const result = await dbRequired().collection("agent_runs").updateOne(
    { id: runId, ownerKey: scope, status: "awaiting_answer", "meta.pendingQuestion.id": questionId },
    {
      $set: {
        status: "running", phase: "resuming", updatedAt: now(),
        "meta.answeredQuestion": { id: questionId, answers: copy(answers || {}), at: now() }
      },
      $unset: { "meta.pendingQuestion": "" }
    }
  );
  return !!result.matchedCount;
}

export async function getLatestCheckpoint(runId: string): Promise<CheckpointDoc> {
  const run = await getRun(runId);
  if (!run || !run.latestCheckpointId) return null;
  return dbRequired().collection("agent_checkpoints").findOne(
    { id: run.latestCheckpointId, runId }, { projection: { _id: 0 } }
  );
}
export async function recordStep(runId: string, stepData: any): Promise<void> {
  const doc = Object.assign({}, copy(stepData), { runId, at: now() });
  await dbRequired().collection("agent_steps").insertOne(copy(doc));
  return doc;
}
export async function workerHeartbeat(workerId: string, details: any = {}): Promise<void> {
  const db = await ensureIndexes();
  if (!workerId) throw error("WORKER_ID_REQUIRED", "Worker identity is required.", 400);
  const doc = Object.assign({}, copy(details), { workerId, at: now() });
  await db.collection("agent_workers").updateOne({ workerId }, { $set: doc }, { upsert: true });
  return doc;
}
export async function getWorkerHealth(maxAgeMs = 45000): Promise<{ healthy: boolean; [k: string]: any }> {
  const workers = await dbRequired().collection("agent_workers").find(
    { ready: true, at: { $gt: new Date(Date.now() - maxAgeMs).toISOString() } },
    { sort: { at: -1 }, projection: { _id: 0 } }
  ).toArray();
  return { healthy: workers.length > 0, workers, lastHeartbeatAt: workers.length ? workers[0].at : null };
}
export async function recoverExpiredRuns(): Promise<RunDoc[]> {
  const db = await ensureIndexes();
  const expired = await db.collection("agent_runs").find(
    { status: { $in: ["running", "waiting_for_check", "finalizing"] }, leaseExpiresAt: { $lte: now() } }
  ).toArray();
  const recovered = [];
  for (const run of expired) {
    const checkpoint = await getLatestCheckpoint(run.id);
    const status = checkpoint && checkpoint.fileCount ? "partial" : "failed";
    const reason = "The agent worker stopped before finishing. Saved files are available; start a new turn to continue.";
    const result = { ok: false, partial: status === "partial", interrupted: true, status, reason,
      summary: reason, files: (checkpoint && checkpoint.files) || {}, costUsd: run.costUsd || 0 };
    const updated = await db.collection("agent_runs").updateOne(
      { id: run.id, status: run.status, leaseOwner: run.leaseOwner, leaseGeneration: run.leaseGeneration,
        leaseExpiresAt: { $lte: now() } },
      { $set: { status, phase: "interrupted", latestError: reason, result, updatedAt: now() },
        $unset: { activeProjectId: "", activeOwnerKey: "", leaseExpiresAt: "" } }
    );
    if (updated.modifiedCount) {
      await appendEvent(run.id, "result", result);
      recovered.push(await getRun(run.id));
    }
  }
  return recovered;
}

