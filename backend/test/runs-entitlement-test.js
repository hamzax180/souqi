"use strict";
/* The route the browser actually posts to has to charge the same toll.

   /api/codeagent/build carried the whole entitlement story — the
   anonymous single build, the free monthly builds, the free edits,
   spendGate — and /api/codeagent/runs carried none of it. /runs is the
   one code.html posts to; /build is only reached as a fallback. So every
   limit in the pricing page was written, documented, tested against
   /build, and unenforced in production: an anonymous caller could spawn
   runs until the rate limiter noticed, and each one was a DeepSeek bill.

   These are source-level assertions rather than live requests. Spinning
   the real route up needs Mongo, a session cookie, a plan lookup and a
   provider, and the thing that actually regressed is structural: a gate
   present on one route and absent on the other. That is what this
   watches. The live behaviour is covered by the deploy-time suites.

   If this file starts failing after a refactor, the question to ask is
   "did the gate move, or did it go?" */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok   " + name);
  } catch (e) {
    console.error("  FAIL " + name);
    console.error("       " + e.message);
    process.exitCode = 1;
  }
}

/** The source of one route handler, from its app.post to the next route. */
function routeBody(startsWith) {
  const at = SRC.indexOf(startsWith);
  assert.ok(at > -1, "could not find the route: " + startsWith);
  const rest = SRC.slice(at + startsWith.length);
  const next = rest.search(/\napp\.(get|post|put|delete|use)\(/);
  return rest.slice(0, next > -1 ? next : rest.length);
}

const runs = routeBody('app.post("/api/codeagent/runs"');
const build = routeBody('app.post("/api/codeagent/build"');

console.log("\n── /api/codeagent/runs pays the same toll ────────");

check("the run route exists and is the longer of the two paths", () => {
  assert.ok(runs.length > 500, "the runs route looks empty");
  assert.ok(build.length > 500, "the build route looks empty");
});

/* The four gates, each one a thing someone could otherwise have for
   free. Named individually so a failure says which one went missing. */
const GATES = [
  ["the anonymous single build", "CODEAGENT_ANON_BUILDS"],
  ["the free monthly builds", "CODEAGENT_FREE_BUILDS"],
  ["the free monthly edits", "CODEAGENT_FREE_EDITS"],
  ["the spend gate", "spendGate("]
];
for (const [label, needle] of GATES) {
  check(label + " is enforced on /runs", () => {
    assert.ok(runs.includes(needle),
      needle + " appears nowhere in the runs route — the limit is unenforced on the path the browser uses");
  });
  check(label + " is still enforced on /build", () => {
    assert.ok(build.includes(needle), needle + " disappeared from the build route");
  });
}

check("an admin is not charged for their own platform", () => {
  assert.ok(/isAdminEmail/.test(runs), "no admin bypass on /runs");
});

check("a refusal carries no runId, so the browser falls through to /build", () => {
  /* This is the whole reason the fix needed no frontend change:
     code.html treats a spawn with no runId as a reason to retry on
     /build, which re-checks the same gate and emits the SSE frame the
     UI already draws. A 402 that still handed back a runId would start
     the run anyway. */
  const refusals = runs.match(/return res\.status\((401|402)\)\.json\(\{[\s\S]{0,400}?\}\);/g) || [];
  assert.ok(refusals.length >= 3, "expected the gate to refuse in several places, found " + refusals.length);
  for (const r of refusals) {
    assert.ok(!/runId/.test(r), "a refusal handed back a runId, which would start the run: " + r.slice(0, 120));
  }
});

check("the allowance is spent only once the run is real", () => {
  const at = runs.indexOf("recordAction(");
  assert.ok(at > -1, "nothing increments the build/edit counter on /runs");
  /* After the gate, not before it — a request refused above has not used
     anyone's allowance, and a request that failed validation has not
     either. */
  const gateAt = runs.indexOf("spendGate(");
  assert.ok(at > gateAt, "the counter is incremented before the gate decides");
});

check("spend is recorded when a run finishes", () => {
  const at = SRC.indexOf("async function persistRunOutcome");
  assert.ok(at > -1, "persistRunOutcome is gone");
  const body = SRC.slice(at, at + 2000);
  assert.ok(/recordSpend\(/.test(body), "a finished run books no spend, so spendGate reads $0 forever");
  /* Above the `if (!project) return` — a run that produced no project
     still spent the money. */
  const spendAt = body.indexOf("recordSpend(");
  const guardAt = body.indexOf("if (!project) return");
  assert.ok(guardAt > -1 && spendAt < guardAt,
    "spend is booked after the no-project guard, so runs that built nothing are free");
});

check("the owner is read from the columns the run document actually has", () => {
  const at = SRC.indexOf("async function persistRunOutcome");
  const body = SRC.slice(at, at + 2000);
  /* run-store stores ownerUserId / ownerAnonId, not a nested owner
     object. Reaching for run.owner alone recorded nothing and threw
     nothing, which is the worst way for a meter to fail. */
  assert.ok(/ownerUserId/.test(body) && /ownerAnonId/.test(body),
    "spend is keyed off a field the run document does not have");
});

console.log("\n  all " + passed + " checks passed\n");
