"use strict";

const assert = require("assert");
const runStore = require("../lib/codeagent/run-store");

/* Dotted paths, because the question a run is parked on lives at
   meta.pendingQuestion and both the query and the update address it that
   way. Without these the mock silently matched nothing and every
   pause/resume assertion passed by not happening. */
/* Every value a dotted path reaches, because Mongo matches a path that
   crosses an ARRAY if ANY element matches — "toolResults.tool_call_id"
   is exactly that shape. Reducing straight through returned undefined
   for those, so a query that works against the real database found
   nothing here and the test would have passed by never matching. */
function dotValues(doc, path) {
  let cur = [doc];
  for (const k of String(path).split(".")) {
    const next = [];
    for (const c of cur) {
      if (c === undefined || c === null) continue;
      if (Array.isArray(c)) {
        for (const el of c) if (el !== null && el !== undefined && el[k] !== undefined) next.push(el[k]);
      } else if (c[k] !== undefined) next.push(c[k]);
    }
    cur = next;
  }
  return cur;
}

function dotGet(doc, path) {
  const values = dotValues(doc, path);
  return values.length ? values[0] : undefined;
}
function dotSet(doc, path, value) {
  const keys = String(path).split(".");
  const last = keys.pop();
  let cur = doc;
  for (const k of keys) { if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {}; cur = cur[k]; }
  cur[last] = value;
}
function dotUnset(doc, path) {
  const keys = String(path).split(".");
  const last = keys.pop();
  let cur = doc;
  for (const k of keys) { if (typeof cur[k] !== "object" || cur[k] === null) return; cur = cur[k]; }
  delete cur[last];
}

/* ONE matcher, used by findOne, find and updateOne alike.

   They each had their own before, understanding different operators —
   updateOne knew $in/$gt/$lte/$exists and find knew only $gt. So a
   sweep whose query used $exists matched nothing through find() and the
   assertions passed by never running. A mock that silently agrees with
   you is worse than no mock. */
function queryMatches(doc, query) {
  for (const [k, v] of Object.entries(query || {})) {
    const values = dotValues(doc, k);
    const some = (fn) => values.some(fn);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (Array.isArray(v.$in)) { if (!some((a) => v.$in.includes(a))) return false; continue; }
      if (v.$gt !== undefined) { if (!some((a) => a > v.$gt)) return false; continue; }
      if (v.$gte !== undefined) { if (!some((a) => a >= v.$gte)) return false; continue; }
      if (v.$lte !== undefined) { if (!some((a) => a <= v.$lte)) return false; continue; }
      if (v.$lt !== undefined) { if (!some((a) => a < v.$lt)) return false; continue; }
      if (v.$exists !== undefined) { if ((values.length > 0) !== !!v.$exists) return false; continue; }
    }
    if (!some((a) => a === v)) return false;
  }
  return true;
}

// Mock in-memory DB for unit testing without live MongoDB
function createMockDb() {
  const collections = {};
  function getCollection(name) {
    if (!collections[name]) {
      const docs = [];
      collections[name] = {
        async insertOne(doc) { docs.push(Object.assign({}, doc)); return { insertedId: doc.id }; },
        async findOne(query, opts) {
          let matches = docs.filter((d) => queryMatches(d, query));
          if (!matches.length) return null;
          if (opts && opts.sort) {
            const [sortKey, sortDir] = Object.entries(opts.sort)[0];
            matches.sort((a, b) => sortDir === -1 ? (b[sortKey] > a[sortKey] ? 1 : -1) : (a[sortKey] > b[sortKey] ? 1 : -1));
          }
          return Object.assign({}, matches[0]);
        },
        async updateOne(query, update) {
          const match = docs.find((d) => queryMatches(d, query));
          if (!match) return { modifiedCount: 0, matchedCount: 0 };
          if (update.$set) { for (const [k, v] of Object.entries(update.$set)) dotSet(match, k, v); }
          if (update.$unset) { for (const k of Object.keys(update.$unset)) dotUnset(match, k); }
          if (update.$inc) { for (const [k, v] of Object.entries(update.$inc)) dotSet(match, k, (dotGet(match, k) || 0) + v); }
          return { modifiedCount: 1, matchedCount: 1 };
        },
        /* claimNext is the only caller, and it is the one that hands a run
           its lease — a double without it cannot exercise anything that
           happens to a leased run. Sort, then apply, then return the doc
           AFTER the update, which is what returnDocument:"after" means. */
        async findOneAndUpdate(query, update, opts) {
          const matches = docs.filter((d) => queryMatches(d, query));
          if (!matches.length) return null;
          if (opts && opts.sort) {
            const [sortKey, sortDir] = Object.entries(opts.sort)[0];
            matches.sort((a, b) => sortDir === -1 ? (b[sortKey] > a[sortKey] ? 1 : -1) : (a[sortKey] > b[sortKey] ? 1 : -1));
          }
          const match = matches[0];
          if (update.$set) { for (const [k, v] of Object.entries(update.$set)) dotSet(match, k, v); }
          if (update.$unset) { for (const k of Object.keys(update.$unset)) dotUnset(match, k); }
          if (update.$inc) { for (const [k, v] of Object.entries(update.$inc)) dotSet(match, k, (dotGet(match, k) || 0) + v); }
          return Object.assign({}, match);
        },
        find(query, opts) {
          let res = docs.filter((d) => queryMatches(d, query));
          if (opts && opts.sort) {
            const [sortKey, sortDir] = Object.entries(opts.sort)[0];
            res.sort((a, b) => sortDir === -1 ? (b[sortKey] > a[sortKey] ? 1 : -1) : (a[sortKey] > b[sortKey] ? 1 : -1));
          }
          return {
            async toArray() { return res.map((d) => Object.assign({}, d)); }
          };
        },
        /* Exposed so a test can age a row the way real time would.
           Reaching past the API is the point: recoverStaleRuns keys on
           updatedAt, and waiting ten real minutes is not a test. */
        _docs: docs,
        async createIndex() { return true; },
        async deleteOne(query) {
          const idx = docs.findIndex((d) => {
            for (const [k, v] of Object.entries(query)) {
              if (d[k] !== v) return false;
            }
            return true;
          });
          if (idx >= 0) { docs.splice(idx, 1); return { deletedCount: 1 }; }
          return { deletedCount: 0 };
        },
        async deleteMany() { docs.length = 0; return { deletedCount: 0 }; }
      };
    }
    return collections[name];
  }
  return { collection: getCollection };
}

let passed = 0, failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    console.log("  ✗ " + name + "\n      " + e.message);
  }
}

(async () => {
  console.log("\n── run-store unit tests ────────────────────────────");

  const mockDb = createMockDb();
  runStore.init({ getMasterDb: () => mockDb });

  const ownerA = { userId: "usr_123", anonId: null };
  const ownerB = { userId: "usr_456", anonId: null };

  let testRunId = null;

  await check("createRun initializes run with queued status", async () => {
    const run = await runStore.createRun({
      projectId: "prj_abc",
      owner: ownerA,
      prompt: "Build an invoice dashboard",
      mode: "auto",
      effort: "smart",
      baseFiles: { "src/App.tsx": "export default function App() {}" }
    });

    assert.ok(run.id && run.id.startsWith("run_"));
    assert.strictEqual(run.status, "queued");
    assert.strictEqual(run.ownerUserId, "usr_123");
    testRunId = run.id;
  });

  await check("getRun enforces ownership scoping", async () => {
    const ownRun = await runStore.getRun(testRunId, ownerA);
    assert.ok(ownRun, "ownerA should be able to view their run");

    const foreignRun = await runStore.getRun(testRunId, ownerB);
    assert.strictEqual(foreignRun, null, "ownerB must not access ownerA's run");
  });

  await check("appendEvent increments sequences strictly", async () => {
    const ev1 = await runStore.appendEvent(testRunId, "tool_call", { tool: "list_files" });
    assert.strictEqual(ev1.seq, 2); // seq 1 was run_created

    const ev2 = await runStore.appendEvent(testRunId, "tool_call", { tool: "write_file", path: "src/types.ts" });
    assert.strictEqual(ev2.seq, 3);
  });

  await check("getEvents replays after a given sequence", async () => {
    const all = await runStore.getEvents(testRunId, 0);
    assert.strictEqual(all.length, 3);

    const tail = await runStore.getEvents(testRunId, 2);
    assert.strictEqual(tail.length, 1);
    assert.strictEqual(tail[0].seq, 3);
  });

  await check("saveCheckpoint records content snapshots", async () => {
    const chk = await runStore.saveCheckpoint(testRunId, {
      "src/App.tsx": "export default function App() { return <h1>Invoices</h1>; }",
      "src/types.ts": "export interface Invoice { id: string; }"
    }, "Added types");

    assert.ok(chk.id && chk.id.startsWith("chk_"));
    assert.strictEqual(chk.fileCount, 2);

    const latest = await runStore.getLatestCheckpoint(testRunId);
    assert.strictEqual(latest.id, chk.id);
    assert.ok(latest.files["src/types.ts"]);
  });

  await check("cancelRun sets status and appends cancellation event", async () => {
    const ok = await runStore.cancelRun(testRunId, ownerA, "User clicked stop");
    assert.strictEqual(ok, true);

    const run = await runStore.getRun(testRunId, ownerA);
    assert.strictEqual(run.status, "cancelled");
    assert.strictEqual(run.cancelled, true);

    const events = await runStore.getEvents(testRunId, 0);
    const lastEv = events[events.length - 1];
    assert.strictEqual(lastEv.type, "run_cancelled");
  });

  console.log("\n── a run that is waiting on an answer ───");

  await check("askQuestion parks the run and records what was asked", async () => {
    const run = await runStore.createRun({
      projectId: "pr_q", owner: { userId: "u1" }, prompt: "build a shop", mode: "act", effort: "balanced"
    });
    const parked = await runStore.askQuestion(run.id, {
      id: "aq_1", askedAt: new Date().toISOString(),
      questions: [{ id: "q1", question: "Which provider?", header: "Payments", options: [] }]
    });
    assert.strictEqual(parked, true);
    const after = await runStore.getRun(run.id);
    assert.strictEqual(after.status, "awaiting_answer");
    assert.strictEqual(after.meta.pendingQuestion.id, "aq_1");
  });

  /* Two submissions of the same answer race on one document. One wins.
     The other must be told it is already answered rather than resuming
     the run a second time on the same transcript. */
  await check("an answer is consumed exactly once", async () => {
    const owner = { userId: "u1" };
    const run = await runStore.createRun({
      projectId: "pr_q2", owner, prompt: "build a shop", mode: "act", effort: "balanced"
    });
    await runStore.askQuestion(run.id, { id: "aq_2", askedAt: "now", questions: [] });

    const first = await runStore.answerQuestion(run.id, owner, "aq_2", { "Which provider?": "Stripe" });
    const second = await runStore.answerQuestion(run.id, owner, "aq_2", { "Which provider?": "Stripe" });
    assert.strictEqual(first, true);
    assert.strictEqual(second, false, "the same answer resumed the run twice");

    const after = await runStore.getRun(run.id);
    assert.strictEqual(after.status, "running");
    assert.strictEqual(after.meta.pendingQuestion, undefined);
    assert.strictEqual(after.meta.answeredQuestion.answers["Which provider?"], "Stripe");
  });

  /* An unguessable run id is not authorization, and this is the one
     route where a stranger's reply looks exactly like the owner's. */
  await check("another owner cannot answer your question", async () => {
    const owner = { userId: "u1" };
    const run = await runStore.createRun({
      projectId: "pr_q3", owner, prompt: "build a shop", mode: "act", effort: "balanced"
    });
    await runStore.askQuestion(run.id, { id: "aq_3", askedAt: "now", questions: [] });

    const stranger = await runStore.answerQuestion(run.id, { userId: "u2" }, "aq_3", { a: "b" });
    assert.strictEqual(stranger, false);
    const after = await runStore.getRun(run.id);
    assert.strictEqual(after.status, "awaiting_answer", "a stranger resumed the run");
  });

  await check("an answer to a question that was never asked does nothing", async () => {
    const owner = { userId: "u1" };
    const run = await runStore.createRun({
      projectId: "pr_q4", owner, prompt: "build a shop", mode: "act", effort: "balanced"
    });
    await runStore.askQuestion(run.id, { id: "aq_4", askedAt: "now", questions: [] });
    assert.strictEqual(await runStore.answerQuestion(run.id, owner, "aq_WRONG", { a: "b" }), false);
  });

  await check("a run already holding a question does not park on a second", async () => {
    const run = await runStore.createRun({
      projectId: "pr_q5", owner: { userId: "u1" }, prompt: "p", mode: "act", effort: "balanced"
    });
    assert.strictEqual(await runStore.askQuestion(run.id, { id: "a", askedAt: "n", questions: [] }), true);
    assert.strictEqual(await runStore.askQuestion(run.id, { id: "b", askedAt: "n", questions: [] }), false);
  });

  console.log("\n── a run whose process is gone ─────────");

  /* The lockout this exists to prevent: createRun takes activeOwnerKey
     under a unique index, the keys are released only on a terminal
     transition, and a killed process never makes one. Every later build
     was then refused with RUN_ALREADY_ACTIVE, naming a run whose id the
     client had already discarded. */
  /** Age a run past the stale threshold, as real time would. */
  const ageStale = (id, minutes) => {
    const doc = mockDb.collection("agent_runs")._docs.find((d) => d.id === id);
    assert.ok(doc, "no such run to age: " + id);
    doc.updatedAt = new Date(Date.now() - (minutes || 11) * 60000).toISOString();
  };

  await check("a run that is still working is not swept", async () => {
    const run = await runStore.createRun({
      projectId: "pr_s1", owner: { userId: "u1" }, prompt: "p", mode: "auto", effort: "balanced"
    });
    await runStore.updateRun(run.id, { status: "running" });
    const swept = await runStore.recoverStaleRuns();
    assert.strictEqual(swept.length, 0, "swept a run that had just been touched");
    assert.strictEqual((await runStore.getRun(run.id)).status, "running");
  });

  await check("an abandoned run is finalised and its owner is unlocked", async () => {
    const owner = { userId: "u2" };
    const run = await runStore.createRun({
      projectId: "pr_s2", owner, prompt: "p", mode: "auto", effort: "balanced"
    });
    await runStore.updateRun(run.id, { status: "running" });
    // As if the process died eleven minutes ago.
    ageStale(run.id);

    const swept = await runStore.recoverStaleRuns();
    assert.strictEqual(swept.length, 1, "did not sweep an abandoned run");
    const after = await runStore.getRun(run.id);
    assert.ok(["partial", "failed"].includes(after.status), "status is " + after.status);
    assert.strictEqual(after.activeOwnerKey, undefined, "the owner is still locked out");
    assert.match(String(after.latestError), /stopped before finishing/);
  });

  /* recoverExpiredRuns cannot find these, and that is the whole reason
     recoverStaleRuns exists: it matches leaseExpiresAt $lte now, and an
     in-process run never takes a lease, so Mongo never matches it. */
  await check("the lease sweep does not find a leaseless run", async () => {
    const run = await runStore.createRun({
      projectId: "pr_s3", owner: { userId: "u3" }, prompt: "p", mode: "auto", effort: "balanced"
    });
    await runStore.updateRun(run.id, { status: "running" });
    ageStale(run.id);
    assert.strictEqual((await runStore.recoverExpiredRuns()).length, 0,
      "the lease sweep claimed a run that holds no lease");
    assert.strictEqual((await runStore.recoverStaleRuns()).length, 1,
      "the stale sweep missed it");
  });

  await check("touchRun keeps a working run out of the sweep", async () => {
    const run = await runStore.createRun({
      projectId: "pr_s4", owner: { userId: "u4" }, prompt: "p", mode: "auto", effort: "balanced"
    });
    await runStore.updateRun(run.id, { status: "running" });
    ageStale(run.id);
    await runStore.touchRun(run.id);
    assert.strictEqual((await runStore.recoverStaleRuns()).length, 0,
      "swept a run that had just heartbeated");
  });

  /* agent_steps had a writer, an index and four comments calling it
     recoverable, and no reader at all — so the line micro-compaction
     puts in front of the model ("recoverable from agent_steps: run X,
     call Y") was a promise nothing could keep. These are the other half.

     The long one is the brief's own acceptance test: exact file content
     can be retrieved again after compaction. */

  const BIG = "export default function App() {\n" +
    Array.from({ length: 200 }, (_, i) => "  // original line " + i).join("\n") + "\n}\n";

  async function runWithOneStep(owner, callId, content) {
    const run = await runStore.createRun({
      projectId: null, owner, prompt: "read it", mode: "auto", effort: "balanced"
    });
    await runStore.recordStep(run.id, {
      turn: 1,
      toolCalls: [{ id: callId, function: { name: "read_file", arguments: '{"path":"src/App.tsx"}' } }],
      toolResults: [{ role: "tool", tool_call_id: callId, content: content }],
      costUsd: 0
    });
    return run;
  }

  await check("exact tool output is retrievable after compaction cleared it", async () => {
    const owner = { userId: "usr_recover", anonId: null };
    const callId = "call_read_1";
    const run = await runWithOneStep(owner, callId, BIG);

    // Compaction clears it out of the request, leaving only the pointer.
    const micro = require("../lib/codeagent/context/micro-compact");
    const { messages } = micro.microCompact([
      { role: "user", content: "read it" },
      { role: "tool", tool_call_id: callId, content: BIG }
    ], { runId: run.id, keepRecent: 0 });

    const cleared = messages.find((m) => m.role === "tool").content;
    assert.ok(cleared.startsWith(micro.CLEARED_PREFIX), "the result should have been cleared");
    assert.ok(cleared.length < BIG.length / 4, "clearing should actually free the bulk");
    assert.ok(cleared.includes(run.id) && cleared.includes(callId),
      "the pointer must name what it points at");

    // The pointer is now worth something.
    const back = await runStore.recoverToolResult(run.id, callId, owner);
    assert.ok(back, "the pointer named a row that could not be read");
    assert.strictEqual(back.content, BIG, "recovery must return the original bytes, not a summary");
    assert.strictEqual(back.tool, "read_file");
    assert.strictEqual(back.turn, 1);
    assert.ok(back.args.includes("src/App.tsx"),
      "a recovered result without the call that produced it does not say what was asked");
  });

  await check("another owner cannot recover your tool output", async () => {
    const owner = { userId: "usr_owner", anonId: null };
    const run = await runWithOneStep(owner, "call_private", BIG);
    // A step holds whole file contents — this is the most sensitive row
    // in the collection, and recover-by-id is the shape that leaks.
    assert.strictEqual(await runStore.recoverToolResult(run.id, "call_private", { userId: "usr_other" }), null);
    assert.deepStrictEqual(await runStore.getSteps(run.id, { userId: "usr_other" }), []);
    assert.strictEqual((await runStore.getSteps(run.id, owner)).length, 1);
  });

  await check("an unknown run or call id recovers nothing rather than throwing", async () => {
    const owner = { userId: "usr_missing", anonId: null };
    const run = await runWithOneStep(owner, "call_known", BIG);
    assert.strictEqual(await runStore.recoverToolResult(run.id, "call_never_made", owner), null);
    assert.strictEqual(await runStore.recoverToolResult("run_does_not_exist", "call_known", owner), null);
    assert.strictEqual(await runStore.recoverToolResult(run.id, "", owner), null);
  });

  /* The bug this pins: answering left the WORKER's lease on a run the app
     process had taken over, and recoverExpiredRuns reaps status:"running"
     with an expired lease. Every answered question died 60s after the
     original claim, mid-build, blaming the worker for stopping. */
  await check("answering releases the worker's lease, so the reaper leaves it alone", async () => {
    const owner = { userId: "u_lease" };
    const run = await runStore.createRun({
      projectId: "pr_lease", owner, prompt: "build a shop", mode: "act", effort: "balanced"
    });
    /* Earlier tests leave queued runs in the shared double, and claimNext
       takes the oldest — so drain until this one comes up rather than
       asserting it is first, which is a fact about the other tests. */
    let claimed = null;
    for (let i = 0; i < 50 && !claimed; i++) {
      const next = await runStore.claimNext("worker_lease_test");
      if (!next) break;
      if (next.id === run.id) claimed = next;
    }
    assert.ok(claimed, "the queue never produced the test run");
    assert.ok(claimed.leaseExpiresAt, "a claimed run must carry a lease");

    await runStore.askQuestion(run.id, { id: "aq_lease", askedAt: "now", questions: [] });
    assert.strictEqual(await runStore.answerQuestion(run.id, owner, "aq_lease", { q: "a" }), true);

    const after = await runStore.getRun(run.id);
    assert.strictEqual(after.status, "running");
    assert.strictEqual(after.leaseExpiresAt, undefined, "the worker's lease outlived the question");
    assert.strictEqual(after.leaseOwner, undefined, "the worker still owns a run it is not executing");

    // The lease reaper must not see it at all, however long the answer took.
    const reaped = await runStore.recoverExpiredRuns();
    assert.ok(!reaped.some((r) => r.id === run.id), "an answered run was reaped as an expired lease");
    assert.strictEqual((await runStore.getRun(run.id)).status, "running");
  });

  await check("steps come back in turn order", async () => {
    const owner = { userId: "usr_order", anonId: null };
    const run = await runStore.createRun({
      projectId: null, owner, prompt: "p", mode: "auto", effort: "balanced"
    });
    for (const turn of [3, 1, 2]) {
      await runStore.recordStep(run.id, {
        turn, toolCalls: [], toolResults: [{ role: "tool", tool_call_id: "c" + turn, content: "x" }], costUsd: 0
      });
    }
    assert.deepStrictEqual((await runStore.getSteps(run.id, owner)).map((s) => s.turn), [1, 2, 3]);
  });

  console.log("\n" + (failed === 0 ? "✓ ALL RUN-STORE TESTS PASSED (" + passed + ")" : "✗ " + failed + " FAILED, " + passed + " passed"));
  process.exit(failed === 0 ? 0 : 1);
})();
