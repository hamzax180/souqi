"use strict";
/* Durable agent runs, ordered replay events, and immutable checkpoints. */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.init = init;
exports.ensureIndexes = ensureIndexes;
exports.owns = owns;
exports.getRunByIdempotency = getRunByIdempotency;
exports.createRun = createRun;
exports.getRun = getRun;
exports.updateRun = updateRun;
exports.claimRun = claimRun;
exports.claimNext = claimNext;
exports.renewLease = renewLease;
exports.cancelRun = cancelRun;
exports.appendEvent = appendEvent;
exports.getEvents = getEvents;
exports.saveCheckpoint = saveCheckpoint;
exports.askQuestion = askQuestion;
exports.answerQuestion = answerQuestion;
exports.getLatestCheckpoint = getLatestCheckpoint;
exports.recordStep = recordStep;
exports.getSteps = getSteps;
exports.recoverToolResult = recoverToolResult;
exports.workerHeartbeat = workerHeartbeat;
exports.getWorkerHealth = getWorkerHealth;
exports.recoverStaleRuns = recoverStaleRuns;
exports.touchRun = touchRun;
exports.recoverExpiredRuns = recoverExpiredRuns;
const crypto = __importStar(require("crypto"));
/* awaiting_answer is ACTIVE, not terminal. The run is alive and holding:
   its lease keeps renewing, its checkpoint stands, and it resumes on the
   same transcript when the answer arrives. Listing it as terminal would
   release the single-active-run slot and let a second run start on the
   same project while the first still owns its files. */
const ACTIVE = ["queued", "running", "waiting_for_check", "awaiting_answer", "finalizing"];
const TERMINAL = ["succeeded", "failed", "cancelled", "partial"];
let getMasterDb = () => null;
let indexPromises = new WeakMap();
const eventQueues = new Map();
const id = (prefix) => prefix + "_" + crypto.randomBytes(10).toString("base64url");
const now = () => new Date().toISOString();
const copy = (value) => structuredClone(value);
function error(code, message, statusCode = 503) {
    return Object.assign(new Error(message), { code, statusCode });
}
function init(deps) {
    if (deps && typeof deps.getMasterDb === "function") {
        getMasterDb = deps.getMasterDb;
        indexPromises = new WeakMap();
    }
}
function dbRequired() {
    const db = getMasterDb();
    if (!db)
        throw error("AGENT_STORE_UNAVAILABLE", "Agent storage is unavailable. Please try again shortly.");
    return db;
}
async function ensureIndexes() {
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
            /* `turn`, not `stepIndex` — recordStep has never written a field by
               that name, so this index has been sorting on something no
               document has. The second one is what recoverToolResult looks up
               by, and without it that is a collection scan per recovery. */
            await db.collection("agent_steps").createIndex({ runId: 1, turn: 1 });
            await db.collection("agent_steps").createIndex({ runId: 1, "toolResults.tool_call_id": 1 });
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
function owns(run, owner) {
    if (!run || !owner)
        return false;
    if (run.ownerUserId)
        return !!owner.userId && String(run.ownerUserId) === String(owner.userId);
    return !!owner.anonId && run.ownerAnonId === owner.anonId;
}
function ownerKey(owner) {
    if (owner && owner.userId)
        return "user:" + String(owner.userId);
    if (owner && owner.anonId)
        return "anon:" + String(owner.anonId);
    throw error("AGENT_OWNER_REQUIRED", "An agent run must have an owner.", 400);
}
function fenceQuery(fence) {
    if (!fence)
        return {};
    return { leaseOwner: fence.workerId, leaseGeneration: fence.generation, leaseExpiresAt: { $gt: now() } };
}
function asDocument(result) {
    return result && Object.prototype.hasOwnProperty.call(result, "value") ? result.value : result;
}
function leaseDuration(value) {
    return Math.max(1000, Math.min(600000, Number(value) || 60000));
}
async function getRunByIdempotency(owner, key, requestHash) {
    if (!key)
        return null;
    const existing = await dbRequired().collection("agent_runs").findOne({ ownerKey: ownerKey(owner), idempotencyKey: key }, { projection: { _id: 0 } });
    if (existing && existing.requestHash !== (requestHash || null)) {
        throw error("IDEMPOTENCY_CONFLICT", "This request key has already been used for a different request.", 409);
    }
    return existing;
}
async function createRun({ projectId, owner, prompt, mode, effort, baseFiles, chatId, context, idempotencyKey, requestHash, baseRevisionId, meta }) {
    const db = await ensureIndexes();
    const scope = ownerKey(owner);
    const c = db.collection("agent_runs");
    const existing = await getRunByIdempotency(owner, idempotencyKey, requestHash);
    if (existing)
        return existing;
    const at = now();
    const runDoc = {
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
    if (idempotencyKey)
        runDoc.idempotencyKey = idempotencyKey;
    if (projectId)
        runDoc.activeProjectId = projectId;
    // A worker can claim immediately after insertion. Its baseline must already exist.
    let baseline;
    if (baseFiles && Object.keys(baseFiles).length) {
        baseline = checkpointDoc(runDoc.id, baseFiles, "Initial project baseline");
        await db.collection("agent_checkpoints").insertOne(copy(baseline));
        runDoc.latestCheckpointId = baseline.id;
    }
    try {
        await c.insertOne(copy(runDoc));
    }
    catch (cause) {
        if (baseline)
            await db.collection("agent_checkpoints").deleteOne({ id: baseline.id });
        if (cause.code === 11000) {
            const retried = await getRunByIdempotency(owner, idempotencyKey, requestHash);
            if (retried)
                return retried;
            throw error("RUN_ALREADY_ACTIVE", "You already have an active agent run. Wait for it to finish or stop it before starting another.", 409);
        }
        throw cause;
    }
    await appendEvent(runDoc.id, "run_created", { runId: runDoc.id, status: "queued", prompt: runDoc.prompt });
    return runDoc;
}
async function getRun(runId, owner) {
    const run = await dbRequired().collection("agent_runs").findOne({ id: runId }, { projection: { _id: 0 } });
    return run && (!owner || owns(run, owner)) ? run : null;
}
async function updateRun(runId, updates, fence) {
    const patch = copy(updates || {});
    for (const key of ["id", "_id", "ownerKey", "ownerAnonId", "ownerUserId", "projectId", "createdAt",
        "idempotencyKey", "requestHash", "activeProjectId", "activeOwnerKey", "latestCheckpointId", "leaseOwner", "leaseGeneration", "leaseExpiresAt", "cancelled"]) {
        delete patch[key];
    }
    if (patch.status && !ACTIVE.includes(patch.status) && !TERMINAL.includes(patch.status)) {
        throw error("INVALID_RUN_STATUS", "Unknown agent run status.", 400);
    }
    patch.updatedAt = now();
    const update = { $set: patch };
    if (TERMINAL.includes(patch.status))
        update.$unset = { activeProjectId: "", activeOwnerKey: "", leaseExpiresAt: "" };
    const result = await dbRequired().collection("agent_runs").updateOne(Object.assign({ id: runId, status: { $in: ACTIVE } }, fenceQuery(fence)), update);
    return result.modifiedCount > 0;
}
async function claimRun(runId, updates = {}) {
    const db = await ensureIndexes();
    const at = now();
    const result = await db.collection("agent_runs").updateOne({ id: runId, status: "queued", cancelled: false }, { $set: { status: "running", phase: updates.phase || "planning", updatedAt: at, claimedAt: at } });
    return result.modifiedCount > 0;
}
async function claimNext(workerId, leaseMs = 60000) {
    if (!workerId)
        throw error("WORKER_ID_REQUIRED", "Worker identity is required.", 400);
    const db = await ensureIndexes();
    const at = now();
    return asDocument(await db.collection("agent_runs").findOneAndUpdate({ status: "queued", cancelled: false }, { $set: { status: "running", phase: "planning", leaseOwner: workerId,
            leaseExpiresAt: new Date(Date.now() + leaseDuration(leaseMs)).toISOString(), claimedAt: at, updatedAt: at },
        $inc: { leaseGeneration: 1 } }, { sort: { createdAt: 1, id: 1 }, returnDocument: "after", includeResultMetadata: false, projection: { _id: 0 } }));
}
async function renewLease(runId, workerId, generation, leaseMs = 60000) {
    const result = await dbRequired().collection("agent_runs").updateOne(Object.assign({ id: runId, status: { $in: ACTIVE } }, fenceQuery({ workerId, generation })), { $set: { leaseExpiresAt: new Date(Date.now() + leaseDuration(leaseMs)).toISOString(), updatedAt: now() } });
    return result.modifiedCount > 0;
}
async function cancelRun(runId, owner, reason) {
    const run = await getRun(runId, owner);
    if (!run || !owner)
        return false;
    const cancelReason = String(reason || "Cancelled by user").slice(0, 1000);
    const result = await dbRequired().collection("agent_runs").updateOne({ id: runId, status: { $in: ACTIVE } }, { $set: { cancelled: true, cancelReason, status: "cancelled", updatedAt: now(),
            result: { ok: false, cancelled: true, status: "cancelled", reason: cancelReason } },
        $unset: { activeProjectId: "", activeOwnerKey: "", leaseExpiresAt: "" } });
    if (!result.modifiedCount)
        return false;
    await appendEvent(runId, "run_cancelled", { runId, reason: cancelReason });
    return true;
}
async function appendEvent(runId, type, payload) {
    const db = await ensureIndexes();
    const previous = eventQueues.get(runId) || Promise.resolve();
    const pending = previous.catch(() => { }).then(async () => {
        const c = db.collection("agent_events");
        // Increment-and-insert counters left gaps, allowing reconnect cursors to skip
        // a late insert forever. Allocate only by inserting after the committed tail.
        for (let retry = 0; retry < 64; retry++) {
            const last = await c.findOne({ runId }, { sort: { seq: -1 }, projection: { seq: 1, _id: 0 } });
            const event = { runId, seq: last ? last.seq + 1 : 1, type, payload: copy(payload || {}), at: now() };
            try {
                await c.insertOne(copy(event));
                return event;
            }
            catch (cause) {
                if (cause.code !== 11000)
                    throw cause;
            }
        }
        throw error("AGENT_EVENT_CONTENTION", "Could not append an agent event after concurrent updates.");
    });
    eventQueues.set(runId, pending);
    try {
        return await pending;
    }
    finally {
        if (eventQueues.get(runId) === pending)
            eventQueues.delete(runId);
    }
}
async function getEvents(runId, afterSeq = 0) {
    const seq = Number(afterSeq);
    return dbRequired().collection("agent_events").find({ runId, seq: { $gt: Number.isSafeInteger(seq) && seq >= 0 ? seq : 0 } }, { sort: { seq: 1 }, projection: { _id: 0 } }).toArray();
}
function checkpointDoc(runId, files, summary) {
    return { id: id("chk"), runId, files: copy(files || {}), fileCount: Object.keys(files || {}).length,
        summary: summary || "", at: now() };
}
async function saveCheckpoint(runId, files, summary, fence) {
    const db = await ensureIndexes();
    const run = await getRun(runId);
    if (!run || !ACTIVE.includes(run.status))
        return null;
    const doc = checkpointDoc(runId, files, summary);
    await db.collection("agent_checkpoints").insertOne(copy(doc));
    const result = await db.collection("agent_runs").updateOne(Object.assign({ id: runId, status: { $in: ACTIVE }, latestCheckpointId: run.latestCheckpointId }, fenceQuery(fence)), { $set: { latestCheckpointId: doc.id, updatedAt: doc.at } });
    if (!result.modifiedCount) {
        await db.collection("agent_checkpoints").deleteOne({ id: doc.id });
        return null;
    }
    return doc;
}
/**
 * Park the run on a question and record what was asked.
 *
 * The question lives on the run document rather than in memory because
 * the whole point is that it survives the process: a Vercel function
 * that asked a question and died has still asked it, and the answer
 * arrives at whichever instance happens to take the next request.
 */
async function askQuestion(runId, question) {
    const result = await dbRequired().collection("agent_runs").updateOne({ id: runId, status: { $in: ACTIVE }, "meta.pendingQuestion": { $exists: false } }, { $set: { status: "awaiting_answer", phase: "awaiting_answer",
            "meta.pendingQuestion": copy(question), updatedAt: now() } });
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
async function answerQuestion(runId, owner, questionId, answers) {
    const scope = ownerKey(owner);
    const result = await dbRequired().collection("agent_runs").updateOne({ id: runId, ownerKey: scope, status: "awaiting_answer", "meta.pendingQuestion.id": questionId }, {
        $set: {
            status: "running", phase: "resuming", updatedAt: now(),
            "meta.answeredQuestion": { id: questionId, answers: copy(answers || {}), at: now() }
        },
        $unset: { "meta.pendingQuestion": "" }
    });
    return !!result.matchedCount;
}
async function getLatestCheckpoint(runId) {
    const run = await getRun(runId);
    if (!run || !run.latestCheckpointId)
        return null;
    return dbRequired().collection("agent_checkpoints").findOne({ id: run.latestCheckpointId, runId }, { projection: { _id: 0 } });
}
async function recordStep(runId, stepData) {
    const doc = Object.assign({}, copy(stepData), { runId, at: now() });
    await dbRequired().collection("agent_steps").insertOne(copy(doc));
    return doc;
}
/* The other half of micro-compaction.
   -----------------------------------------------------------------
   Clearing an old tool result out of the request leaves a line saying
   "recoverable from agent_steps: run X, call Y". That was written
   before anything could read agent_steps: recordStep inserted rows, an
   index was declared over them, four comments called them recoverable,
   and there was no reader anywhere in the codebase. The line the model
   was shown was a promise nothing could keep.

   Ownership is checked the way getRun checks it, because a step holds
   whole file contents — it is the most sensitive thing this collection
   stores, and "recover by id" is exactly the shape of call that leaks
   across tenants when nobody scopes it. */
async function getSteps(runId, owner) {
    if (!(await getRun(runId, owner)))
        return [];
    return dbRequired().collection("agent_steps").find({ runId }, { sort: { turn: 1 }, projection: { _id: 0 } }).toArray();
}
/**
 * The exact tool result a compacted pointer refers to, or null.
 *
 * Returns the untrimmed text as it was before the turn budget touched
 * it — that is the whole point of keeping the row.
 */
async function recoverToolResult(runId, toolCallId, owner) {
    if (!runId || !toolCallId)
        return null;
    if (!(await getRun(runId, owner)))
        return null;
    const step = await dbRequired().collection("agent_steps").findOne({ runId, "toolResults.tool_call_id": toolCallId }, { projection: { _id: 0 } });
    if (!step)
        return null;
    const result = (step.toolResults || []).find((r) => r && r.tool_call_id === toolCallId);
    if (!result)
        return null;
    /* The call is returned beside the result because a recovered result on
       its own does not say what was asked — "the first ten matches" is not
       useful without the query that produced them. */
    const call = (step.toolCalls || []).find((c) => c && c.id === toolCallId) || null;
    return {
        runId, toolCallId, turn: step.turn, at: step.at,
        tool: (call && call.function && call.function.name) || null,
        args: (call && call.function && call.function.arguments) || null,
        content: typeof result.content === "string" ? result.content : ""
    };
}
async function workerHeartbeat(workerId, details = {}) {
    const db = await ensureIndexes();
    if (!workerId)
        throw error("WORKER_ID_REQUIRED", "Worker identity is required.", 400);
    const doc = Object.assign({}, copy(details), { workerId, at: now() });
    await db.collection("agent_workers").updateOne({ workerId }, { $set: doc }, { upsert: true });
    return doc;
}
async function getWorkerHealth(maxAgeMs = 45000) {
    const workers = await dbRequired().collection("agent_workers").find({ ready: true, at: { $gt: new Date(Date.now() - maxAgeMs).toISOString() } }, { sort: { at: -1 }, projection: { _id: 0 } }).toArray();
    return { healthy: workers.length > 0, workers, lastHeartbeatAt: workers.length ? workers[0].at : null };
}
/**
 * Reap runs that were executing IN PROCESS and whose process is gone.
 *
 * recoverExpiredRuns() below cannot find these. It matches on
 * `leaseExpiresAt: {$lte: now}`, and createRun takes no lease — only a
 * worker claiming a run does. An in-process run therefore has no lease
 * at all, and Mongo does not match a missing field against $lte. So the
 * sweep that existed swept exactly the runs that could not strand, and
 * none of the ones that could.
 *
 * Staleness is measured on `updatedAt`, which the loop now touches every
 * turn. A run still working is never idle for long; one whose function
 * was terminated stops touching it entirely.
 *
 * Keeps whatever was checkpointed. A partial result the user can
 * continue from is a different thing from a run that vanished.
 */
async function recoverStaleRuns(maxIdleMs = 600000) {
    const db = await ensureIndexes();
    const cutoff = new Date(Date.now() - Math.max(60000, Number(maxIdleMs) || 0)).toISOString();
    const stale = await db.collection("agent_runs").find({
        status: { $in: ["running", "waiting_for_check", "finalizing"] },
        leaseExpiresAt: { $exists: false },
        updatedAt: { $lte: cutoff }
    }).toArray();
    const recovered = [];
    for (const run of stale) {
        const checkpoint = await getLatestCheckpoint(run.id);
        const status = checkpoint && checkpoint.fileCount ? "partial" : "failed";
        const reason = "This run stopped before finishing — its server was shut down mid-build. " +
            (status === "partial"
                ? "What it had written is saved; start a new turn to continue."
                : "Nothing had been written yet.");
        const result = { ok: false, partial: status === "partial", interrupted: true, status, reason,
            summary: reason, files: (checkpoint && checkpoint.files) || {}, costUsd: run.costUsd || 0 };
        /* Conditioned on updatedAt as well, so a run that woke up between the
           find and the update is not finalised out from under itself. */
        const updated = await db.collection("agent_runs").updateOne({ id: run.id, status: run.status, updatedAt: run.updatedAt, leaseExpiresAt: { $exists: false } }, { $set: { status, phase: "interrupted", latestError: reason, result, updatedAt: now() },
            $unset: { activeProjectId: "", activeOwnerKey: "" } });
        if (updated.matchedCount) {
            await appendEvent(run.id, "result", result);
            recovered.push(await getRun(run.id));
        }
    }
    return recovered;
}
/** Heartbeat, so `recoverStaleRuns` can tell working from abandoned. */
async function touchRun(runId) {
    await dbRequired().collection("agent_runs").updateOne({ id: runId, status: { $in: ACTIVE } }, { $set: { updatedAt: now() } });
}
async function recoverExpiredRuns() {
    const db = await ensureIndexes();
    const expired = await db.collection("agent_runs").find({ status: { $in: ["running", "waiting_for_check", "finalizing"] }, leaseExpiresAt: { $lte: now() } }).toArray();
    const recovered = [];
    for (const run of expired) {
        const checkpoint = await getLatestCheckpoint(run.id);
        const status = checkpoint && checkpoint.fileCount ? "partial" : "failed";
        const reason = "The agent worker stopped before finishing. Saved files are available; start a new turn to continue.";
        const result = { ok: false, partial: status === "partial", interrupted: true, status, reason,
            summary: reason, files: (checkpoint && checkpoint.files) || {}, costUsd: run.costUsd || 0 };
        const updated = await db.collection("agent_runs").updateOne({ id: run.id, status: run.status, leaseOwner: run.leaseOwner, leaseGeneration: run.leaseGeneration,
            leaseExpiresAt: { $lte: now() } }, { $set: { status, phase: "interrupted", latestError: reason, result, updatedAt: now() },
            $unset: { activeProjectId: "", activeOwnerKey: "", leaseExpiresAt: "" } });
        if (updated.modifiedCount) {
            await appendEvent(run.id, "result", result);
            recovered.push(await getRun(run.id));
        }
    }
    return recovered;
}
