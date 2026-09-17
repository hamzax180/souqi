/* =================================================================
   turn-history-test.js — the transcript a reopened chat is built from

   A project kept exactly one user message however long the conversation
   ran, because the only write of one lived inside the branch that creates
   the project. Reopening showed the prompt that started it and then a
   column of replies to questions nobody could see.

   The fix hangs on two properties of addTurn, and both are the kind that
   look fine until two writers race: a caller-named turn must be written
   once however many times it is submitted, and seq must not hand two rows
   the same number — a tie sorts arbitrarily, which puts the reply above
   the message that asked for it.

   Run: node test/turn-history-test.js
   ================================================================= */
"use strict";
const assert = require("assert");
const projects = require("../lib/projects");

let passed = 0;
async function ok(name, fn) {
  try { await fn(); console.log("  ok  " + name); passed++; }
  catch (e) { console.error("  FAIL " + name + "\n       " + e.message); process.exitCode = 1; }
}

const owner = { anonId: "anon_turn_history" };
const newProject = () => projects.create({ title: "t", prompt: "p", owner });

(async () => {
  console.log("\nevery message, written down once");

  await ok("a turn named by its caller is written once, not twice", async () => {
    const p = await newProject();
    // What a double-submitted build does: createRun hands back the SAME run
    // on an idempotency hit, so the route asks for the same turn twice.
    await projects.addTurn(p.id, { id: "turn_user_run_x", role: "user", body: "make it blue" });
    await projects.addTurn(p.id, { id: "turn_user_run_x", role: "user", body: "make it blue" });
    const turns = await projects.listTurns(p.id);
    assert.strictEqual(turns.length, 1, "the same id was stored twice");
    assert.strictEqual(turns[0].body, "make it blue");
  });

  await ok("the first write wins; a resubmit never rewrites what is stored", async () => {
    const p = await newProject();
    await projects.addTurn(p.id, { id: "turn_run_y", role: "agent", body: "done" });
    await projects.addTurn(p.id, { id: "turn_run_y", role: "agent", body: "OVERWRITTEN" });
    const turns = await projects.listTurns(p.id);
    assert.strictEqual(turns.length, 1);
    assert.strictEqual(turns[0].body, "done");
  });

  await ok("an unnamed turn still gets its own id, and several coexist", async () => {
    const p = await newProject();
    await projects.addTurn(p.id, { role: "user", body: "one" });
    await projects.addTurn(p.id, { role: "agent", body: "two" });
    await projects.addTurn(p.id, { role: "user", body: "three" });
    const turns = await projects.listTurns(p.id);
    assert.strictEqual(turns.length, 3);
    assert.strictEqual(new Set(turns.map((t) => t.id)).size, 3, "generated ids collided");
  });

  await ok("seq is one past the highest, and survives the transcript cap", async () => {
    /* One past the highest, not the number of rows. The durable worker's
       finalizer does not go through addTurn — it hand-builds its row with
       `lastTurn.seq + 1` — and the two rules have to agree or a user turn
       written while a worker run is finalizing claims a seq already taken.

       The counting rule is only distinguishable from the max rule once the
       rows stop being dense, and the cap is where that happens: past
       MAX_TURNS the oldest are dropped, so a count sticks at 400 and hands
       the same number out for ever, while listTurns sorts on it. */
    const p = await newProject();
    const n = 405;
    for (let i = 0; i < n; i++) await projects.addTurn(p.id, { role: "user", body: "m" + i });
    const turns = await projects.listTurns(p.id);
    const seqs = turns.map((t) => t.seq);
    assert.strictEqual(new Set(seqs).size, seqs.length, "two turns claim the same seq");
    for (let i = 1; i < seqs.length; i++) {
      assert.ok(seqs[i] > seqs[i - 1], "seq went backwards at " + i + ": " + seqs[i - 1] + " then " + seqs[i]);
    }
    assert.strictEqual(turns[turns.length - 1].body, "m" + (n - 1), "the newest turn is not last");
  });

  await ok("a user turn keeps its images and its run link", async () => {
    const p = await newProject();
    const t = await projects.addTurn(p.id, {
      id: "turn_user_run_img", role: "user", body: "like this one", runId: "run_img",
      images: [{ id: "up_1", url: "https://example.test/a.png", name: "a.png" }]
    });
    assert.strictEqual(t.runId, "run_img");
    assert.strictEqual(t.images.length, 1, "the row is fixed-shape and dropped the images");
    assert.strictEqual(t.images[0].url, "https://example.test/a.png");
  });

  await ok("turns stay in their own chat", async () => {
    const p = await newProject();
    await projects.addTurn(p.id, { role: "user", body: "main thread", chatId: "" });
    await projects.addTurn(p.id, { role: "user", body: "second thread", chatId: "c2" });
    const main = await projects.listTurns(p.id, projects.MAIN_CHAT);
    const other = await projects.listTurns(p.id, "c2");
    assert.strictEqual(main.length, 1);
    assert.strictEqual(main[0].body, "main thread");
    assert.strictEqual(other.length, 1);
    assert.strictEqual(other[0].body, "second thread");
  });

  console.log("\n✓ ALL TURN-HISTORY TESTS PASSED (" + passed + ")\n");
})();
