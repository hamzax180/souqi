/* =================================================================
   tool-registry-test.js — the three things the old dispatch chain did
   -----------------------------------------------------------------
   agent-runner dispatched whatever the model named. Everything here is
   a case that USED TO SUCCEED, and most of these assert twice: once
   that the call was refused, and once that the file map is unchanged
   afterwards. A refusal that still wrote the file would pass the first
   assertion on its own, which is exactly the bug shape worth guarding.

   The mode cases matter most. They bypass the schema entirely — the
   arguments are valid and the tool exists — because that is the real
   attack: the instruction to write arrives inside a file the model has
   just read, and a schema the model has already been handed cannot
   refuse anything.

   Run: npm run test:tool-registry
   ================================================================= */
"use strict";
const assert = require("assert");
const registry = require("../lib/codeagent/tool-registry");
const agentRunner = require("../lib/codeagent/agent-runner");

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n      " + e.message); }
}

const APP = 'export default function App(){ return <div className="a">hi</div>; }';
const files = () => ({ "src/App.tsx": APP });
const ctx = (mode, f) => ({ mode, files: f, runId: "run_test" });

(async () => {

console.log("\n── the surface did not move ─────────────");

/* An EXACT set, in the same spirit as model-loop-test's TOOLS_SCHEMA
   assertion: widening the model's surface should cost somebody a
   deliberate edit here. Adding ask_user_question broke this, which is
   the assertion working. */
await check("the registry offers exactly these eight tools, in this order", () => {
  assert.deepStrictEqual(
    registry.names(),
    ["write_file", "edit_file", "read_file", "list_files", "search_code",
     "check_project", "ask_user_question", "complete_task"]
  );
});

/* The schema moved out of agent-runner into the registry. If those two
   ever disagree, the model is being offered one set and gated on another. */
await check("agent-runner's exported schema is the registry's, unchanged", () => {
  assert.deepStrictEqual(agentRunner.DYNAMIC_TOOLS_SCHEMA, registry.schemas());
});

await check("no tool named run, exec, shell or install is offered", () => {
  for (const forbidden of ["run", "exec", "shell", "bash", "npm_install", "install", "fetch"]) {
    assert.ok(!registry.names().includes(forbidden), "a tool named " + forbidden + " is offered");
  }
});

console.log("\n── write_file has a boundary again ──────");

await check("a traversal path is refused and writes nothing", async () => {
  const f = files();
  const r = await registry.dispatch("write_file", { path: "../../etc/passwd", content: "x" }, ctx("act", f));
  assert.strictEqual(r.ok, false);
  assert.match(r.content, /not a safe relative path/);
  assert.deepStrictEqual(Object.keys(f), ["src/App.tsx"]);
});

await check("an absolute path is refused", async () => {
  const f = files();
  const r = await registry.dispatch("write_file", { path: "/etc/passwd", content: "x" }, ctx("act", f));
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(Object.keys(f), ["src/App.tsx"]);
});

/* The one that motivated all of this: payments.ts is the server-side
   price boundary, and the live path could overwrite it. */
await check("src/lib/payments.ts is refused", async () => {
  const f = files();
  const r = await registry.dispatch("write_file", { path: "src/lib/payments.ts", content: "x" }, ctx("act", f));
  assert.strictEqual(r.ok, false);
  assert.match(r.content, /fixed scaffold/);
  assert.strictEqual(f["src/lib/payments.ts"], undefined);
});

await check("src/main.tsx is refused", async () => {
  const f = files();
  const r = await registry.dispatch("write_file", { path: "src/main.tsx", content: "x" }, ctx("act", f));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(f["src/main.tsx"], undefined);
});

await check("package.json and vite.config.ts are outside the writable tree", async () => {
  for (const p of ["package.json", "vite.config.ts", "tsconfig.json"]) {
    const f = files();
    const r = await registry.dispatch("write_file", { path: p, content: "x" }, ctx("act", f));
    assert.strictEqual(r.ok, false, p + " was accepted");
    assert.strictEqual(f[p], undefined);
  }
});

await check("a .txt under src/ is refused — src/ is .ts, .tsx or .css", async () => {
  const f = files();
  const r = await registry.dispatch("write_file", { path: "src/notes.txt", content: "x" }, ctx("act", f));
  assert.strictEqual(r.ok, false);
  assert.match(r.content, /\.ts, \.tsx or \.css/);
});

/* Not over-tightened: a page at the root is how a website gets a page,
   and refusing it would break the thing the boundary exists to protect. */
await check("a .html page at the project root is still written", async () => {
  const f = files();
  const r = await registry.dispatch("write_file", { path: "about.html", content: "<h1>About</h1>" }, ctx("act", f));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(f["about.html"], "<h1>About</h1>");
});

await check("a backslash path normalises rather than making a second key", async () => {
  const f = files();
  const r = await registry.dispatch("write_file", { path: "  src\\Hero.tsx  ", content: "x" }, ctx("act", f));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(f["src/Hero.tsx"], "x");
});

console.log("\n── edit_file refuses to guess ───────────");

await check("an anchor appearing twice is refused, and the file is untouched", async () => {
  const f = { "src/App.tsx": "const a = 1;\nconst b = 2;\nconst a = 1;\n" };
  const before = f["src/App.tsx"];
  const r = await registry.dispatch("edit_file",
    { path: "src/App.tsx", find: "const a = 1;", replace: "const a = 9;" }, ctx("act", f));
  assert.strictEqual(r.ok, false);
  assert.match(r.content, /appears 2 times/);
  assert.strictEqual(f["src/App.tsx"], before, "the file was edited despite the refusal");
});

await check("an anchor that is not there is refused", async () => {
  const f = files();
  const r = await registry.dispatch("edit_file",
    { path: "src/App.tsx", find: "nowhere", replace: "x" }, ctx("act", f));
  assert.strictEqual(r.ok, false);
  assert.match(r.content, /is not in that file/);
});

await check("exactly one match is replaced", async () => {
  const f = files();
  const r = await registry.dispatch("edit_file",
    { path: "src/App.tsx", find: "hi", replace: "hello" }, ctx("act", f));
  assert.strictEqual(r.ok, true);
  assert.ok(f["src/App.tsx"].includes("hello"));
});

await check("editing a protected file is refused too", async () => {
  const f = { "src/lib/payments.ts": "const PRICE = 100;" };
  const r = await registry.dispatch("edit_file",
    { path: "src/lib/payments.ts", find: "100", replace: "0" }, ctx("act", f));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(f["src/lib/payments.ts"], "const PRICE = 100;");
});

console.log("\n── the mode is a gate, not a suggestion ─");

/* The schema is bypassed entirely here. Valid arguments, real tool, and
   the only thing standing between the model and the file is the mode. */
for (const mode of ["plan", "awaiting_approval", "awaiting_question", "chat"]) {
  await check("write_file is refused in " + mode + " mode even with valid arguments", async () => {
    const f = files();
    const r = await registry.dispatch("write_file", { path: "src/Hero.tsx", content: "x" }, ctx(mode, f));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(f["src/Hero.tsx"], undefined, "the write happened anyway");
  });

  await check("edit_file is refused in " + mode + " mode", async () => {
    const f = files();
    const r = await registry.dispatch("edit_file",
      { path: "src/App.tsx", find: "hi", replace: "bye" }, ctx(mode, f));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(f["src/App.tsx"], APP);
  });
}

/* check_project is not read-only: it blocks the run for up to 45 seconds
   and asks a browser to build. Plan mode must not be able to spend that. */
await check("check_project is refused in plan mode", async () => {
  const r = await registry.dispatch("check_project", { reason: "why not" }, ctx("plan", files()));
  assert.strictEqual(r.ok, false);
});

await check("the read tools still work in a read-only mode", async () => {
  const f = files();
  for (const name of ["read_file", "list_files", "search_code"]) {
    const args = name === "read_file" ? { path: "src/App.tsx" } : { query: "div" };
    const r = await registry.dispatch(name, args, ctx("awaiting_question", f));
    assert.strictEqual(r.ok, true, name + " was refused in a read-only mode");
  }
});

/* Permitted-but-not-offered, and deliberately so: complete_task writes
   nothing, and refusing it costs a provider call to reach the same end. */
await check("complete_task is permitted in a read-only mode", async () => {
  const r = await registry.dispatch("complete_task", { summary: "answered" }, ctx("awaiting_question", files()));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.effects.completed, true);
});

console.log("\n── read before edit, and the same read ──");

/* The candidate tree is edited in memory as the run goes, so a file read
   on turn two may not be the file being edited on turn nine — the model's
   own later write can have replaced it. */
await check("an edit based on a stale read is refused, and the file is untouched", async () => {
  const f = { "src/App.tsx": "const a = 1;" };
  const seen = {};
  const c = { mode: "act", files: f, runId: "r", seen };

  await registry.dispatch("read_file", { path: "src/App.tsx" }, c);
  // something else rewrites it — in a real run, the model's own write_file
  f["src/App.tsx"] = "const a = 2;";

  const r = await registry.dispatch("edit_file",
    { path: "src/App.tsx", find: "const a = 2;", replace: "const a = 3;" }, c);
  assert.strictEqual(r.ok, false);
  assert.match(r.content, /has changed since you read it/);
  assert.strictEqual(f["src/App.tsx"], "const a = 2;", "the stale edit was applied anyway");
});

await check("re-reading clears the conflict", async () => {
  const f = { "src/App.tsx": "const a = 1;" };
  const seen = {};
  const c = { mode: "act", files: f, runId: "r", seen };

  await registry.dispatch("read_file", { path: "src/App.tsx" }, c);
  f["src/App.tsx"] = "const a = 2;";
  await registry.dispatch("read_file", { path: "src/App.tsx" }, c);

  const r = await registry.dispatch("edit_file",
    { path: "src/App.tsx", find: "const a = 2;", replace: "const a = 3;" }, c);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(f["src/App.tsx"], "const a = 3;");
});

await check("writing a file counts as having seen it", async () => {
  const f = {};
  const seen = {};
  const c = { mode: "act", files: f, runId: "r", seen };
  await registry.dispatch("write_file", { path: "src/Hero.tsx", content: "export const Hero = 1;" }, c);
  const r = await registry.dispatch("edit_file",
    { path: "src/Hero.tsx", find: "1", replace: "2" }, c);
  assert.strictEqual(r.ok, true, r.content);
});

/* Without a recorded read there is nothing to compare against, and the
   old behaviour stands — applyEditFileArgs still has the last word. */
await check("a file that was never read edits as it always did", async () => {
  const f = { "src/App.tsx": "const a = 1;" };
  const r = await registry.dispatch("edit_file",
    { path: "src/App.tsx", find: "const a = 1;", replace: "const a = 9;" },
    { mode: "act", files: f, runId: "r", seen: {} });
  assert.strictEqual(r.ok, true);
});

console.log("\n── asking is a choice, not a prompt ────");

await check("a well-formed question is accepted and comes back as an effect", async () => {
  const r = await registry.dispatch("ask_user_question", {
    questions: [{
      question: "Which payment provider should the shop use?",
      header: "Payments",
      options: [
        { label: "Stripe", description: "Cards worldwide, needs a Stripe account." },
        { label: "Cash on delivery", description: "No integration, no card fees." }
      ]
    }]
  }, ctx("act", files()));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.effects.questionAsked.length, 1);
  assert.strictEqual(r.effects.questionAsked[0].id, "q1");
  assert.strictEqual(r.effects.questionAsked[0].options.length, 2);
  assert.match(r.content, /paused until they answer/);
});

/* One option is not a choice — a model offering one has usually taken a
   decision it should have just taken silently. */
await check("a single option is refused as not being a choice", async () => {
  const r = await registry.dispatch("ask_user_question", {
    questions: [{ question: "Use Stripe?", header: "Payments", options: [{ label: "Yes", description: "ok" }] }]
  }, ctx("act", files()));
  assert.strictEqual(r.ok, false);
  assert.match(r.content, /not a choice/);
});

await check("questions and options are capped, and empty ones dropped", async () => {
  const r = await registry.dispatch("ask_user_question", {
    questions: Array.from({ length: 9 }, (_, i) => ({
      question: "Question " + i + "?", header: "H" + i,
      options: Array.from({ length: 9 }, (_, j) => ({ label: "opt" + j, description: "d" }))
    }))
  }, ctx("act", files()));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.effects.questionAsked.length, 4, "more than four questions got through");
  for (const q of r.effects.questionAsked) assert.strictEqual(q.options.length, 4);
});

await check("a question with no text is refused rather than parked", async () => {
  for (const bad of [{ questions: [] }, { questions: [{ header: "H", options: [] }] }, {}]) {
    const r = await registry.dispatch("ask_user_question", bad, ctx("act", files()));
    assert.strictEqual(r.ok, false, JSON.stringify(bad) + " was accepted");
  }
});

await check("a free-text question needs no options at all", async () => {
  const r = await registry.dispatch("ask_user_question", {
    questions: [{ question: "What is the business called?", header: "Name", options: [] }]
  }, ctx("act", files()));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.effects.questionAsked[0].options.length, 0);
});

console.log("\n── a refusal is always a reply ──────────");

/* A thrown refusal leaves an assistant tool_call with no matching tool
   reply, and the NEXT provider call fails with a 400 about message
   pairing — an error about something entirely unrelated to the cause. */
await check("no tool throws, whatever it is handed", async () => {
  for (const name of registry.names()) {
    for (const args of [undefined, null, {}, { path: 123 }, { path: "", content: null }, []]) {
      const r = await registry.dispatch(name, args, ctx("act", files()));
      assert.strictEqual(typeof r.ok, "boolean", name + " returned no ok");
      assert.strictEqual(typeof r.content, "string", name + " returned no content for " + JSON.stringify(args));
    }
  }
});

await check("an unknown tool name is reported, not thrown", async () => {
  const r = await registry.dispatch("rm_rf", { path: "/" }, ctx("act", files()));
  assert.strictEqual(r.ok, false);
  assert.match(r.content, /Unknown tool/);
});

await check("check_project asks for a build rather than doing one", async () => {
  const f = files();
  const r = await registry.dispatch("check_project", { reason: "verifying" }, ctx("act", f));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.effects.checkRequested, true);
  assert.deepStrictEqual(Object.keys(f), ["src/App.tsx"]);
});

await check("complete_task refuses while the app has no entry point", async () => {
  const r = await registry.dispatch("complete_task", { summary: "done" }, ctx("act", { "src/Hero.tsx": "x" }));
  assert.strictEqual(r.ok, false);
  assert.match(r.content, /src\/App\.tsx does not exist/);
});

console.log("\n" + (failed === 0
  ? "✓ ALL TOOL-REGISTRY TESTS PASSED (" + passed + ")"
  : "✗ " + failed + " FAILED, " + passed + " passed"));
process.exit(failed === 0 ? 0 : 1);

})();
