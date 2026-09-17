"use strict";

/* The finalizer is the only thing that makes a durable run real: it moves
   the run, the project head, the revision, the turn and the usage record
   together, under the lease that authorised the work. There was no test
   for it, and two defects shipped behind that gap — it was never called
   at all, and once it was, it did not release the owner lock. Both were
   found by running a build against production, which is a slow and
   expensive way to learn either. */

const assert = require("assert");
const { createFinalizer, TERMINAL } = require("../lib/codeagent/worker-service");

function createMockDb(seed) {
  const data = JSON.parse(JSON.stringify(seed || {}));
  function matches(doc, query) {
    for (const [k, v] of Object.entries(query)) {
      const actual = k.split(".").reduce((o, part) => (o === undefined || o === null ? o : o[part]), doc);
      if (actual !== v) return false;
    }
    return true;
  }
  function apply(doc, update) {
    if (update.$set) Object.assign(doc, update.$set);
    if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v;
    if (update.$unset) {
      for (const k of Object.keys(update.$unset)) {
        if (!k.includes(".")) { delete doc[k]; continue; }
        const parts = k.split(".");
        const leaf = parts.pop();
        const parent = parts.reduce((o, p) => (o && o[p]) || null, doc);
        if (parent) delete parent[leaf];
      }
    }
  }
  return {
    data,
    collection(name) {
      if (!data[name]) data[name] = [];
      const docs = data[name];
      return {
        async findOne(query, opts) {
          let hits = docs.filter((d) => matches(d, query));
          if (opts && opts.sort) {
            const [k, dir] = Object.entries(opts.sort)[0];
            hits = hits.slice().sort((a, b) => (dir === -1 ? (b[k] > a[k] ? 1 : -1) : (a[k] > b[k] ? 1 : -1)));
          }
          return hits.length ? hits[0] : null;
        },
        async updateOne(query, update, opts) {
          const hit = docs.find((d) => matches(d, query));
          if (hit) { apply(hit, update); return { matchedCount: 1, modifiedCount: 1 }; }
          if (opts && opts.upsert) {
            const fresh = Object.assign({}, query, update.$setOnInsert || {});
            apply(fresh, { $set: update.$set, $inc: update.$inc });
            docs.push(fresh);
            return { matchedCount: 0, upsertedCount: 1 };
          }
          return { matchedCount: 0, modifiedCount: 0 };
        },
        async insertOne(doc) { docs.push(doc); return { insertedId: 1 }; }
      };
    }
  };
}

const LATER = new Date(Date.now() + 60000).toISOString();

function scenario(overrides) {
  const run = Object.assign({
    id: "run_1", projectId: "pr_1", ownerAnonId: "an_1", ownerUserId: null,
    chatId: "c1", baseRevisionId: null, leaseGeneration: 3, context: {}
  }, (overrides && overrides.run) || {});

  const db = createMockDb({
    agent_runs: [Object.assign({
      id: "run_1", status: "running", cancelled: false,
      leaseOwner: "w_1", leaseGeneration: 3, leaseExpiresAt: LATER,
      activeOwnerKey: "anon:an_1", activeProjectId: "pr_1"
    }, (overrides && overrides.runRow) || {})],
    projects: [{ id: "pr_1", slug: "cafe", ownerAnonId: "an_1", headRevision: null }],
    revisions: [], turns: [], codeagent_usage: [], codeagent_usage_events: []
  });

  const withTransaction = async (fn) => fn(db, { id: "sess" });
  const finalize = createFinalizer({ withTransaction, run, workerId: "w_1", generation: 3 });
  return { db, finalize, row: () => db.data.agent_runs[0] };
}

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n      " + e.message); }
}

(async () => {
  console.log("\n── worker-service finalizer tests ──────────────────");

  await check("a terminal finalize releases the owner lock", async () => {
    const s = scenario();
    assert.strictEqual(await s.finalize({ reason: "provider refused" }, "failed"), true);
    const row = s.row();
    // activeOwnerKey carries a unique partial index. Left behind, the
    // owner's next build is refused with RUN_ALREADY_ACTIVE for ever.
    assert.ok(!("activeOwnerKey" in row), "activeOwnerKey must be released");
    assert.ok(!("activeProjectId" in row), "activeProjectId must be released");
    assert.ok(!("leaseExpiresAt" in row), "a finished run holds no lease");
  });

  await check("the stop reason reaches the row, not just the return value", async () => {
    const s = scenario();
    await s.finalize({ stopReason: "provider_error", reason: "402" }, "failed");
    assert.strictEqual(s.row().stopReason, "provider_error");
    assert.strictEqual(s.row().status, "failed");
    assert.strictEqual(s.row().phase, "failed");
  });

  await check("a success with new files commits a revision and moves the project head", async () => {
    const s = scenario();
    await s.finalize({
      files: { "src/App.tsx": "x" }, fileStats: [{ path: "src/App.tsx", isNew: true }],
      summary: "Built it", costUsd: 0.02
    }, "succeeded");
    assert.strictEqual(s.db.data.projects[0].headRevision, "rv_run_1");
    assert.strictEqual(s.db.data.revisions.length, 1);
    assert.strictEqual(s.db.data.turns.length, 1, "the chat must show a reply, or the build vanished");
    assert.strictEqual(s.db.data.turns[0].kind, "result");
    assert.strictEqual(s.db.data.codeagent_usage[0].costUsd, 0.02);
  });

  await check("a failure still writes a turn, so the chat is not silent", async () => {
    const s = scenario();
    await s.finalize({ reason: "provider refused" }, "failed");
    assert.strictEqual(s.db.data.turns.length, 1);
    assert.strictEqual(s.db.data.turns[0].kind, "text");
    assert.strictEqual(s.db.data.revisions.length, 0, "a failed run commits no revision");
  });

  await check("a worker whose lease was stolen cannot write the result", async () => {
    const s = scenario({ runRow: { leaseOwner: "w_2" } });
    assert.strictEqual(await s.finalize({ summary: "mine" }, "succeeded"), false);
    assert.strictEqual(s.row().status, "running", "the run must be untouched");
  });

  await check("a stale lease generation cannot write the result", async () => {
    const s = scenario({ runRow: { leaseGeneration: 4 } });
    assert.strictEqual(await s.finalize({ summary: "mine" }, "succeeded"), false);
  });

  await check("an already terminal run is not finalized twice", async () => {
    const s = scenario({ runRow: { status: "succeeded" } });
    assert.strictEqual(await s.finalize({ summary: "again" }, "succeeded"), false);
  });

  await check("an expired lease cannot write the result", async () => {
    const s = scenario({ runRow: { leaseExpiresAt: new Date(Date.now() - 1000).toISOString() } });
    assert.strictEqual(await s.finalize({ summary: "late" }, "succeeded"), false);
  });

  await check("a non-terminal status is refused outright", async () => {
    const s = scenario();
    await assert.rejects(() => s.finalize({}, "running"), /Invalid terminal run state/);
    assert.ok(TERMINAL.has("partial") && !TERMINAL.has("running"));
  });

  await check("a project that changed owner mid-run is refused", async () => {
    const s = scenario();
    s.db.data.projects[0].ownerAnonId = "an_someone_else";
    await assert.rejects(() => s.finalize({ summary: "x" }, "succeeded"), /deleted or its owner changed/);
  });

  console.log("\n" + (failed === 0 ? "✓ ALL WORKER-SERVICE TESTS PASSED (" + passed + ")" : "✗ " + failed + " FAILED, " + passed + " passed"));
  process.exit(failed === 0 ? 0 : 1);
})();
