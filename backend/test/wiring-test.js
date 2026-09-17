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

console.log("\n✓ ALL WIRING TESTS PASSED (" + passed + " call targets resolve)");
