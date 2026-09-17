/* =================================================================
   agent-state-test.js — the mode machine, and what an approval binds
   -----------------------------------------------------------------
   Plan mode's approval used to be a boolean the client sent. The gate
   read req.body.confirmed on /api/codeagent/build — but pressing
   "Looks good — Build it" sends the turn to /api/codeagent/runs, where
   index.js maps the mode onto power|build|auto and "plan" stops
   existing. The approved path and the gated path were different paths.

   So an approval is a signed statement about four things, and most of
   what follows is one test per binding: change any one of them and the
   token stops verifying. The revision binding is the one that carries
   the requirement — every build writes a revision, headRevision moves,
   and yesterday's approval cannot execute against today's tree.

   The OFFERS assertions look trivial and are not. Three cases in
   agent-runner-test.js assert on the exact read-only tool list, so a
   mode machine that widened the surface by one name would break them
   somewhere far away from here.

   Run: npm run test:agent-state
   ================================================================= */
"use strict";
const assert = require("assert");

process.env.CODEAGENT_APPROVAL_SECRET = "test-secret-not-the-real-one";
const st = require("../lib/codeagent/agent-state");
const registry = require("../lib/codeagent/tool-registry");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n      " + e.message); }
}

const BASE = { sessionKey: "user:u1", projectId: "pr_1", revisionId: "rv_a" };
const issue = (over) => st.issueApproval(Object.assign({}, BASE, { planVersion: "pv1" }, over));

console.log("\n── the surface each mode offers ─────────");

/* Byte-identical to the filter this replaced (agent-runner.js:331). */
check("a read-only mode offers exactly read_file, search_code, list_files", () => {
  assert.deepStrictEqual(st.offers("awaiting_question"), ["read_file", "search_code", "list_files"]);
  assert.deepStrictEqual(st.offers("awaiting_approval"), ["read_file", "search_code", "list_files"]);
});

/* Plan mode is the one read-only mode that may ask, and that is what
   plan mode is for: working out what to build is exactly when a
   consequential unknown surfaces, and the alternative to asking is
   guessing and writing the guess into a plan the user then approves. */
check("plan mode may ask a question, and a mode answering one may not ask back", () => {
  assert.deepStrictEqual(st.offers("plan"),
    ["read_file", "search_code", "list_files", "ask_user_question"]);
  assert.strictEqual(st.permits("plan", "ask_user_question"), true);
  assert.strictEqual(st.permits("awaiting_question", "ask_user_question"), false);
  assert.strictEqual(st.permits("act", "ask_user_question"), true);
});

/* Asking writes nothing, but it is not free: it stops the run. Plan
   mode is allowed it; the mode that exists BECAUSE a question is
   outstanding is not, or a run could ask its way in a circle. */
check("asking is still refused where it is not offered", () => {
  assert.strictEqual(st.permits("chat", "ask_user_question"), false);
  assert.strictEqual(st.permits("awaiting_approval", "ask_user_question"), false);
});

check("act offers all seven, and chat offers none", () => {
  assert.deepStrictEqual(st.offers("act"), registry.names());
  assert.deepStrictEqual(st.offers("chat"), []);
});

/* The one deliberate asymmetry: complete_task is permitted everywhere
   and offered only in act. Anything else offered-but-not-permitted
   would be a tool the model is shown and then refused, which wastes a
   provider call to reach the same place. */
check("everything a mode offers, it also permits", () => {
  for (const mode of st.MODES) {
    for (const name of st.offers(mode)) {
      assert.ok(st.permits(mode, name), mode + " offers " + name + " but does not permit it");
    }
  }
});

check("no read-only mode permits a write tool", () => {
  for (const mode of ["chat", "plan", "awaiting_question", "awaiting_approval"]) {
    for (const name of ["write_file", "edit_file", "check_project"]) {
      assert.strictEqual(st.permits(mode, name), false, mode + " permits " + name);
    }
  }
});

check("complete_task is permitted in every mode", () => {
  for (const mode of st.MODES) assert.ok(st.permits(mode, "complete_task"), mode);
});

check("a denial names the tool and never throws", () => {
  for (const mode of st.MODES) {
    for (const name of registry.names()) {
      const msg = st.denialMessage(mode, name);
      assert.ok(typeof msg === "string" && msg.length > 0, mode + "/" + name);
      assert.ok(msg.includes(name), "the denial does not name " + name);
    }
  }
});

console.log("\n── which mode a run starts in ───────────");

check("build mode goes straight to act, question detection and all", () => {
  const r = st.resolve({ mode: "build", isQuestion: true });
  assert.strictEqual(r.mode, "act");
});

check("a question on any other mode answers rather than builds", () => {
  assert.strictEqual(st.resolve({ mode: "auto", isQuestion: true }).mode, "awaiting_question");
});

check("an ordinary build request acts", () => {
  assert.strictEqual(st.resolve({ mode: "auto", isQuestion: false }).mode, "act");
});

/* An APPROVED plan never re-runs question detection — the user has
   already pressed the button, and "add a dark mode?" reading as a
   question at that point would refuse to build what was just approved. */
check("an approved plan acts without re-asking whether it is a question", () => {
  const r = st.resolve({ mode: "plan", approval: { ok: true }, isQuestion: true });
  assert.strictEqual(r.mode, "act");
});

check("an unapproved plan holds when enforcement is on", () => {
  process.env.CODEAGENT_REQUIRE_PLAN_APPROVAL = "1";
  try {
    assert.strictEqual(st.resolve({ mode: "plan", approval: { ok: false } }).mode, "awaiting_approval");
  } finally { delete process.env.CODEAGENT_REQUIRE_PLAN_APPROVAL; }
});

/* Shipped off, because the client does not echo a token yet and
   enforcing on day one would refuse every plan-mode build. */
check("an unapproved plan proceeds while enforcement is off, and says so", () => {
  const r = st.resolve({ mode: "plan", approval: { ok: false } });
  assert.strictEqual(r.mode, "act");
  assert.match(r.reason, /not enforced/);
});

console.log("\n── what an approval binds ───────────────");

check("a token issued for these four things verifies against them", () => {
  const r = st.verifyApproval(issue(), Object.assign({}, BASE, { planVersion: "pv1" }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.planVersion, "pv1");
});

check("a different session cannot use it", () => {
  const r = st.verifyApproval(issue(), Object.assign({}, BASE, { sessionKey: "user:u2" }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "session");
});

check("a different project cannot use it", () => {
  const r = st.verifyApproval(issue(), Object.assign({}, BASE, { projectId: "pr_2" }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "project");
});

/* The requirement, stated as a test: a build moved headRevision, so the
   approval that was given against the old tree no longer applies. */
check("an approval given against an older revision does not execute", () => {
  const r = st.verifyApproval(issue(), Object.assign({}, BASE, { revisionId: "rv_b" }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "revision");
});

check("an edited plan cannot be executed with the old plan's approval", () => {
  const r = st.verifyApproval(issue(), Object.assign({}, BASE, { planVersion: "pv2" }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "plan");
});

check("a token past its expiry is refused", () => {
  const token = issue({ ttlMs: 1000 });
  const r = st.verifyApproval(token, Object.assign({}, BASE, { now: Date.now() + 60000 }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "expired");
});

check("one flipped character in the signature is refused", () => {
  const token = issue();
  const dot = token.indexOf(".");
  const sig = token.slice(dot + 1);
  const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
  const r = st.verifyApproval(token.slice(0, dot + 1) + flipped, Object.assign({}, BASE, { planVersion: "pv1" }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "signature");
});

check("a token forged under a different secret is refused", () => {
  const token = issue();
  const real = process.env.CODEAGENT_APPROVAL_SECRET;
  process.env.CODEAGENT_APPROVAL_SECRET = "a-different-secret-entirely";
  try {
    const r = st.verifyApproval(token, Object.assign({}, BASE, { planVersion: "pv1" }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "signature");
  } finally { process.env.CODEAGENT_APPROVAL_SECRET = real; }
});

check("nothing, an empty string and rubbish are all refused rather than thrown", () => {
  for (const bad of [undefined, null, "", "garbage", ".", "a.", ".b", 42, {}]) {
    const r = st.verifyApproval(bad, BASE);
    assert.strictEqual(r.ok, false, JSON.stringify(bad) + " verified");
    assert.ok(["missing", "malformed", "signature"].includes(r.reason), "unexpected reason " + r.reason);
  }
});

console.log("\n── a plan version names one plan ────────");

check("reordering a plan's keys is the same plan", () => {
  const a = st.planVersionOf({ title: "T", phases: [{ name: "p", steps: ["s"] }] });
  const b = st.planVersionOf({ phases: [{ name: "p", steps: ["s"] }], title: "T" });
  assert.strictEqual(a, b);
});

check("changing any of a plan's text is a different plan", () => {
  const a = st.planVersionOf({ title: "T", phases: [{ name: "p", steps: ["s"] }] });
  const b = st.planVersionOf({ title: "T", phases: [{ name: "p", steps: ["s2"] }] });
  assert.notStrictEqual(a, b);
});

check("a session key is the identity run-store already uses", () => {
  assert.strictEqual(st.sessionKeyOf({ userId: "u1" }), "user:u1");
  assert.strictEqual(st.sessionKeyOf({ anonId: "a1" }), "anon:a1");
  // A signed-in user is strictly more identity than the cookie before it.
  assert.strictEqual(st.sessionKeyOf({ userId: "u1", anonId: "a1" }), "user:u1");
});

console.log("\n" + (failed === 0
  ? "✓ ALL AGENT-STATE TESTS PASSED (" + passed + ")"
  : "✗ " + failed + " FAILED, " + passed + " passed"));
process.exit(failed === 0 ? 0 : 1);
