"use strict";

const assert = require("assert");
const runStore = require("../lib/codeagent/run-store");

/* Dotted paths, because the question a run is parked on lives at
   meta.pendingQuestion and both the query and the update address it that
   way. Without these the mock silently matched nothing and every
   pause/resume assertion passed by not happening. */
function dotGet(doc, path) {
  return String(path).split(".").reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), doc);
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

// Mock in-memory DB for unit testing without live MongoDB
function createMockDb() {
  const collections = {};
  function getCollection(name) {
    if (!collections[name]) {
      const docs = [];
      collections[name] = {
        async insertOne(doc) { docs.push(Object.assign({}, doc)); return { insertedId: doc.id }; },
        async findOne(query, opts) {
          let matches = docs.filter((d) => {
            for (const [k, v] of Object.entries(query)) {
              if (d[k] !== v) return false;
            }
            return true;
          });
          if (!matches.length) return null;
          if (opts && opts.sort) {
            const [sortKey, sortDir] = Object.entries(opts.sort)[0];
            matches.sort((a, b) => sortDir === -1 ? (b[sortKey] > a[sortKey] ? 1 : -1) : (a[sortKey] > b[sortKey] ? 1 : -1));
          }
          return Object.assign({}, matches[0]);
        },
        async updateOne(query, update) {
          const match = docs.find((d) => {
            for (const [k, v] of Object.entries(query)) {
              const actual = dotGet(d, k);
              if (v && typeof v === "object" && Array.isArray(v.$in)) {
                if (!v.$in.includes(actual)) return false;
              } else if (v && typeof v === "object" && v.$gt !== undefined) {
                if (actual <= v.$gt) return false;
              } else if (v && typeof v === "object" && v.$lte !== undefined) {
                if (actual > v.$lte) return false;
              } else if (v && typeof v === "object" && v.$exists !== undefined) {
                if ((actual !== undefined) !== !!v.$exists) return false;
              } else if (actual !== v) {
                return false;
              }
            }
            return true;
          });
          if (!match) return { modifiedCount: 0, matchedCount: 0 };
          if (update.$set) { for (const [k, v] of Object.entries(update.$set)) dotSet(match, k, v); }
          if (update.$unset) { for (const k of Object.keys(update.$unset)) dotUnset(match, k); }
          if (update.$inc) { for (const [k, v] of Object.entries(update.$inc)) dotSet(match, k, (dotGet(match, k) || 0) + v); }
          return { modifiedCount: 1, matchedCount: 1 };
        },
        find(query, opts) {
          let res = docs.filter((d) => {
            for (const [k, v] of Object.entries(query)) {
              if (v && typeof v === "object" && v.$gt !== undefined) {
                if (d[k] <= v.$gt) return false;
              } else if (d[k] !== v) {
                return false;
              }
            }
            return true;
          });
          if (opts && opts.sort) {
            const [sortKey, sortDir] = Object.entries(opts.sort)[0];
            res.sort((a, b) => sortDir === -1 ? (b[sortKey] > a[sortKey] ? 1 : -1) : (a[sortKey] > b[sortKey] ? 1 : -1));
          }
          return {
            async toArray() { return res.map((d) => Object.assign({}, d)); }
          };
        },
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

  console.log("\n" + (failed === 0 ? "✓ ALL RUN-STORE TESTS PASSED (" + passed + ")" : "✗ " + failed + " FAILED, " + passed + " passed"));
  process.exit(failed === 0 ? 0 : 1);
})();
