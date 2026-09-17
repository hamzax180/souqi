/* =================================================================
   wiring-test.js — every module call in index.js resolves
   -----------------------------------------------------------------
   `agentRunner.reportCheckResult` was called on every WebContainer
   check-result POST and was not exported: the TypeScript port dropped
   the keyword. The call was a TypeError, the handler is async, an
   async throw in Express 4 is an unhandled rejection, and Node exits
   on those — so a missing export took the whole server down and the
   browser reported "Failed to fetch", naming neither the route nor
   the reason.

   Nothing caught it because every test imports the modules directly
   and calls the functions that DO exist. This checks the seam
   instead: what index.js reaches for, against what is actually there.

   Run: npm run test:wiring
   ================================================================= */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const BACKEND = path.resolve(__dirname, "..");
const src = fs.readFileSync(path.join(BACKEND, "index.js"), "utf8");

/* alias -> module path, from index.js's own requires. Read rather than
   listed so a new require is covered the day it is added. */
const requires = {};
const reRequire = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(["']([^"']+)["']\)/g;
let m;
while ((m = reRequire.exec(src))) requires[m[1]] = m[2];

let passed = 0;
const missing = [];
let skipped = 0;

for (const [alias, rel] of Object.entries(requires)) {
  if (!rel.startsWith(".")) continue;            // node_modules is npm's problem
  let mod;
  try { mod = require(path.resolve(BACKEND, rel)); }
  catch (e) { skipped++; continue; }             // needs env we do not have here
  if (!mod || typeof mod !== "object") continue;

  const used = new Set();
  const reUse = new RegExp("\\b" + alias.replace(/\$/g, "\\$") + "\\.([A-Za-z_$][\\w$]*)\\s*\\(", "g");
  let u;
  while ((u = reUse.exec(src))) used.add(u[1]);

  for (const fn of used) {
    if (typeof mod[fn] === "function") { passed++; continue; }
    missing.push(alias + "." + fn + "()  from " + rel + "  — is " + typeof mod[fn]);
  }
}

console.log("\n── index.js wiring ─────────────────────────────────");
for (const line of missing) console.log("  ✗ " + line);
console.log("  checked " + (passed + missing.length) + " call targets" +
  (skipped ? " (" + skipped + " module(s) not loadable here, skipped)" : ""));

assert.ok(passed > 60, "only " + passed + " call targets found — the scan stopped working, which is worse than a failure");
assert.deepStrictEqual(missing, [], missing.length + " call(s) in index.js have no function behind them");

/* ── both executors are fed from the same place ──────────────────────
   A run executes in one of two ways, and only one of them can read the
   HTTP request. The worker claims a queued run minutes later and rebuilds
   its options from run.context (worker-service.js: Object.assign({},
   context, ...)), so anything the route does not persist there does not
   exist for a durable run.

   Nothing was persisted there, and the in-process call was assembled
   separately from req.body. So the two paths were handed different
   inputs: in process saw the attached photos and the conversation, the
   worker saw neither. It produced two bugs that looked unrelated — the
   agent insisting no image "came through" while its thumbnail sat above
   the reply, and the agent proposing a new site for a project that
   already had one because it had no history.

   Static, because the real thing needs a worker, a queue and a model. */
const runsRoute = src.slice(src.indexOf('app.post("/api/codeagent/runs"'));
const routeBody = runsRoute.slice(0, runsRoute.indexOf('app.post("/api/codeagent/runs/:id'));

console.log("\n── the run carries its own context ─────────────────");
const ctxChecks = [
  ["createRun persists a context", /createRun\(\{[\s\S]*?\bcontext:\s*runContext\b/.test(routeBody),
    "createRun stores no context — a durable run reaches the model with no images and no history"],
  ["the context carries the attached images", /\bimagesBlock\b/.test(routeBody) && /attachedImages:\s*attachedImages\.map/.test(routeBody),
    "run.context has no images, so a photo attached to a durable run never reaches the model"],
  ["the context carries the conversation", /history:\s*\(Array\.isArray\(req\.body && req\.body\.conversation\)/.test(routeBody),
    "run.context has no history, so a durable run answers with no memory of the conversation"],
  ["in-process executes from that same context", /executeRun\(run\.id,\s*Object\.assign\(\{\},\s*runContext\)\)/.test(routeBody),
    "the in-process path builds its own options again — that divergence is the bug this check exists for"]
];
const ctxFailed = [];
for (const [name, ok, why] of ctxChecks) {
  if (ok) { console.log("  ✓ " + name); } else { console.log("  ✗ " + name); ctxFailed.push(why); }
}
assert.deepStrictEqual(ctxFailed, [], ctxFailed.join("\n       "));

console.log("\n✓ ALL WIRING TESTS PASSED (" + passed + " call targets resolve)");
