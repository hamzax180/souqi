/* =================================================================
   context-test.js — what a long run is allowed to forget
   -----------------------------------------------------------------
   The context engine's whole job is deciding what to lose, so every
   test here is really the same question asked about a different
   thing: after the conversation has been shrunk, summarised and
   trimmed, is the fact still there?

   The 100-turn case is the one that matters. It is synthetic and says
   so — no provider is called, token accounting is the client's own
   estimator, and the summariser is injected. What it proves is not
   that DeepSeek writes good summaries; it is that a constraint stated
   on turn two survives the machinery, which is the part this
   directory is responsible for.

   Run: npm run test:context
   ================================================================= */
"use strict";
const assert = require("assert");

const budget = require("../lib/codeagent/context/token-budget");
const micro = require("../lib/codeagent/context/micro-compact");
const auto = require("../lib/codeagent/context/auto-compact");
const retrieval = require("../lib/codeagent/context/file-retrieval");
const projectMemory = require("../lib/codeagent/context/project-memory");
const redactor = require("../lib/codeagent/context/redact");
const ctx = require("../lib/codeagent/context/context-manager");

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n      " + e.message); }
}

const big = (n) => "x".repeat(n);

(async () => {

console.log("\n── secrets do not become durable ────────");

await check("an api key, a jwt and a connection string are all removed", () => {
  const cases = [
    "the key is sk-live-AbCdEf0123456789XyZw",
    "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    "MONGODB_URI=mongodb+srv://admin:hunter2@cluster0.example.net/db",
    "AKIAIOSFODNN7EXAMPLE",
    "const STRIPE_SECRET_KEY = \"rk_live_51H8xQ2abcdefghijklmn\""
  ];
  for (const c of cases) {
    const r = redactor.redact(c);
    assert.ok(r.redacted > 0, "nothing redacted in: " + c.slice(0, 40));
    assert.ok(!/hunter2|AbCdEf0123456789|AKIAIOSFODNN7EXAMPLE|51H8xQ2abcdefghijklmn/.test(r.text),
      "the secret survived: " + r.text);
  }
});

await check("ordinary prose is left alone", () => {
  const prose = "Make the hero section taller and use a warmer accent colour.";
  assert.strictEqual(redactor.redact(prose).text, prose);
  assert.strictEqual(redactor.redact(prose).redacted, 0);
});

/* A rule is durable by definition, so a secret in one is a secret in
   the database afterwards. */
await check("a secret typed into a rule is not what gets stored", () => {
  const m = projectMemory.remember(null, [
    { text: "use the key sk-live-AbCdEf0123456789XyZw for payments", source: "user" }
  ]);
  assert.ok(!/AbCdEf0123456789/.test(JSON.stringify(m)), "the key was stored");
  assert.match(projectMemory.promptBlock(m), /redacted/);
});

await check("a secret in a cleared tool result is not what gets kept", () => {
  const msgs = [
    { role: "system", content: "s" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1" }] },
    { role: "tool", tool_call_id: "c1", content: "AKIAIOSFODNN7EXAMPLE and then " + big(2000) }
  ];
  const r = micro.microCompact(msgs, { runId: "run_1", keepRecent: 0 });
  assert.strictEqual(r.compacted, 1);
  assert.ok(!/AKIAIOSFODNN7EXAMPLE/.test(r.messages[2].content), "the key survived compaction");
});

console.log("\n── micro-compaction keeps the structure ─");

await check("an old bulky result is cleared and the recent ones are not", () => {
  const msgs = [{ role: "system", content: "s" }];
  for (let i = 0; i < 10; i++) {
    msgs.push({ role: "assistant", content: "", tool_calls: [{ id: "c" + i }] });
    msgs.push({ role: "tool", tool_call_id: "c" + i, content: "line one\n" + big(3000) });
  }
  const r = micro.microCompact(msgs, { runId: "run_1", keepRecent: 3 });
  assert.strictEqual(r.compacted, 7, "expected the 7 oldest of 10 to be cleared");
  assert.ok(r.charsFreed > 18000);
  // the three most recent still hold their content
  assert.ok(msgs[msgs.length - 1].content.length > 3000);
  assert.strictEqual(r.messages[r.messages.length - 1].content.length, msgs[msgs.length - 1].content.length);
});

/* Dropping a tool message orphans its assistant's tool_call, and the
   next provider call fails with a 400 about message pairing rather
   than about anything that is wrong. */
await check("every tool message keeps its id and its position", () => {
  const msgs = [{ role: "system", content: "s" }];
  for (let i = 0; i < 8; i++) {
    msgs.push({ role: "assistant", content: "", tool_calls: [{ id: "c" + i }] });
    msgs.push({ role: "tool", tool_call_id: "c" + i, content: big(4000) });
  }
  const r = micro.microCompact(msgs, { runId: "run_1", keepRecent: 0 });
  assert.strictEqual(r.messages.length, msgs.length);
  for (let i = 0; i < msgs.length; i++) {
    assert.strictEqual(r.messages[i].role, msgs[i].role);
    assert.strictEqual(r.messages[i].tool_call_id, msgs[i].tool_call_id);
  }
});

await check("a failure is never cleared, however old or large", () => {
  const msgs = [{ role: "system", content: "s" }];
  for (let i = 0; i < 6; i++) {
    msgs.push({ role: "assistant", content: "", tool_calls: [{ id: "c" + i }] });
    msgs.push({
      role: "tool", tool_call_id: "c" + i,
      content: 'Error: write_file: "../../etc/passwd" is not a safe relative path. ' + big(2000)
    });
  }
  const r = micro.microCompact(msgs, { runId: "run_1", keepRecent: 0 });
  assert.strictEqual(r.compacted, 0, "a refusal was compacted away");
});

await check("compacting twice does not compact the pointer", () => {
  const msgs = [
    { role: "assistant", content: "", tool_calls: [{ id: "c1" }] },
    { role: "tool", tool_call_id: "c1", content: big(5000) }
  ];
  const once = micro.microCompact(msgs, { runId: "run_1", keepRecent: 0 });
  const twice = micro.microCompact(once.messages, { runId: "run_1", keepRecent: 0 });
  assert.strictEqual(twice.compacted, 0);
});

await check("the cleared line says where the real thing still is", () => {
  const msgs = [
    { role: "assistant", content: "", tool_calls: [{ id: "call_abc" }] },
    { role: "tool", tool_call_id: "call_abc", content: "Successfully wrote src/App.tsx\n" + big(3000) }
  ];
  const r = micro.microCompact(msgs, { runId: "run_xyz", keepRecent: 0 });
  assert.match(r.messages[1].content, /agent_steps/);
  assert.match(r.messages[1].content, /run_xyz/);
  assert.match(r.messages[1].content, /call_abc/);
  assert.match(r.messages[1].content, /Successfully wrote src\/App\.tsx/);
});

console.log("\n── the summary carries the facts ────────");

await check("the user's words are preserved verbatim, not paraphrased", () => {
  const block = auto.factsBlock({ prompt: "a barber shop in Casablanca, and the prices must be in dirhams" });
  assert.ok(block.includes("a barber shop in Casablanca, and the prices must be in dirhams"));
});

await check("a pending question survives compaction as a pending question", () => {
  const block = auto.factsBlock({ pendingQuestion: { id: "q1", text: "Do you want online booking?" } });
  assert.match(block, /AWAITING AN ANSWER to question q1/);
  assert.ok(block.includes("Do you want online booking?"));
});

/* A browser check is a client claim. A summary that records it as
   "tests passed" launders an unattested result into a verified one. */
await check("an unattested check is not summarised as proof", () => {
  const block = auto.factsBlock({
    verification: { kind: "browser build", passed: true, attested: false }
  });
  assert.match(block, /UNATTESTED/);
  const attested = auto.factsBlock({
    verification: { kind: "sandbox build", passed: true, attested: true }
  });
  assert.ok(!/UNATTESTED/.test(attested));
});

await check("files are summarised with the hash they were last seen at", () => {
  const block = auto.factsBlock({
    filesWritten: ["src/App.tsx"],
    fileHashes: { "src/App.tsx": "abcdef0123456789" }
  });
  assert.ok(block.includes("src/App.tsx"));
  assert.ok(block.includes("abcdef012345"));
});

await check("a compaction that cannot reach the provider still produces the facts", async () => {
  const msgs = [{ role: "system", content: "s" }];
  for (let i = 0; i < 12; i++) msgs.push({ role: "user", content: "turn " + i });
  const r = await auto.autoCompact(msgs, {
    headLen: 1, keepRecent: 2,
    facts: { prompt: "build a shop" },
    summarise: async () => { throw new Error("provider unreachable"); }
  });
  assert.ok(r.replaced > 0, "nothing was compacted");
  assert.strictEqual(r.modelWritten, false);
  assert.ok(r.summary.includes("build a shop"));
});

await check("too little in the middle to be worth a summary is left alone", async () => {
  const msgs = [{ role: "system", content: "s" }, { role: "user", content: "a" }, { role: "user", content: "b" }];
  const r = await auto.autoCompact(msgs, { headLen: 1, keepRecent: 1, facts: {} });
  assert.strictEqual(r.replaced, 0);
  assert.strictEqual(r.messages, msgs);
});

console.log("\n── retrieval knows why, and knows when ──");

await check("a file named in the request outranks one that is not", () => {
  const files = { "src/Hero.tsx": "export const Hero = () => null;", "src/Footer.tsx": "export const Footer = () => null;" };
  const sel = retrieval.select(files, { prompt: "make the hero taller" });
  assert.strictEqual(sel[0].path, "src/Hero.tsx");
  assert.strictEqual(sel[0].reason, "named in the request");
});

await check("a file imported by one being edited comes with it", () => {
  const files = {
    "src/App.tsx": 'import { Cart } from "./Cart";\nexport default function App(){ return <Cart/>; }',
    "src/Cart.tsx": "export const Cart = () => null;",
    "src/Unrelated.tsx": "export const U = () => null;"
  };
  const sel = retrieval.select(files, { touched: ["src/App.tsx"] });
  const cart = sel.find((s) => s.path === "src/Cart.tsx");
  assert.ok(cart, "the imported file was not selected");
  assert.strictEqual(cart.reason, "imported by a file being changed");
  const u = sel.find((s) => s.path === "src/Unrelated.tsx");
  assert.ok(cart.score > u.score);
});

await check("every selection says why it is there", () => {
  const files = { "src/App.tsx": "a", "src/Hero.tsx": "b", "index.html": "c" };
  for (const s of retrieval.select(files, { prompt: "hero", touched: ["src/App.tsx"] })) {
    assert.ok(typeof s.reason === "string" && s.reason.length > 0, s.path + " has no reason");
    assert.ok(/^[0-9a-f]{16}$/.test(s.hash), s.path + " has no hash");
  }
});

/* The tree is edited in memory as the run goes, so a file read on turn
   two is being remembered at a version that no longer exists. */
await check("a changed file is reported stale, and an unchanged one is not", () => {
  const before = { "src/App.tsx": "version one", "src/Hero.tsx": "unchanged" };
  const sel = retrieval.select(before, {});
  const after = { "src/App.tsx": "version two", "src/Hero.tsx": "unchanged" };
  const s = retrieval.stale(sel, after);
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].path, "src/App.tsx");
  assert.notStrictEqual(s[0].was, s[0].now);
});

await check("a deleted file is stale with no current hash", () => {
  const sel = retrieval.select({ "src/Gone.tsx": "here" }, {});
  const s = retrieval.stale(sel, {});
  assert.strictEqual(s[0].now, null);
});

console.log("\n── a rule and a guess are not the same ──");

await check("the user's rules are requirements and the model's are observations", () => {
  const m = projectMemory.remember(null, [
    { text: "prices must be in dirhams", source: "user" },
    { text: "they probably want a dark theme", source: "model" }
  ]);
  const block = projectMemory.promptBlock(m);
  assert.match(block, /Treat these as requirements/);
  assert.ok(block.indexOf("prices must be in dirhams") < block.indexOf("observations, not instructions"));
  assert.match(block, /observations, not instructions/);
});

await check("the user restating the model's guess promotes it, and not the reverse", () => {
  let m = projectMemory.remember(null, [{ text: "use a dark theme", source: "model" }]);
  assert.strictEqual(m.rules[0].source, "model");
  m = projectMemory.remember(m, [{ text: "use a dark theme", source: "user" }]);
  assert.strictEqual(m.rules[0].source, "user");
  m = projectMemory.remember(m, [{ text: "use a dark theme", source: "model" }]);
  assert.strictEqual(m.rules[0].source, "user", "a model note demoted a user requirement");
});

await check("a stale model note is dropped and a user rule is not", () => {
  const old = new Date(Date.now() - projectMemory.MODEL_NOTE_TTL_MS - 1000).toISOString();
  const m = projectMemory.remember(
    { rules: [
      { id: "a", text: "an old guess", source: "model", at: old, hits: 1 },
      { id: "b", text: "an old requirement", source: "user", at: old, hits: 1 }
    ] },
    [{ text: "something new", source: "user" }]
  );
  const texts = m.rules.map((r) => r.text);
  assert.ok(!texts.includes("an old guess"), "a stale model note was kept");
  assert.ok(texts.includes("an old requirement"), "a user requirement was expired");
});

await check("what the user gives, the user can take", () => {
  const m = projectMemory.remember(null, [
    { text: "keep it minimal", source: "user" }, { text: "use serif type", source: "user" }
  ]);
  const less = projectMemory.forget(m, "keep it minimal");
  assert.deepStrictEqual(less.rules.map((r) => r.text), ["use serif type"]);
});

await check("a project that has been told nothing stores nothing", () => {
  assert.strictEqual(projectMemory.remember(null, []), null);
  assert.strictEqual(projectMemory.promptBlock(null), "");
});

console.log("\n── the budget is measured, not guessed ──");

await check("pressure rises with content, not with message count", () => {
  const b = budget.budgetFor({ route: "json", maxTokens: 4000 });
  const many = Array.from({ length: 80 }, () => ({ role: "user", content: "ok" }));
  const few = [{ role: "user", content: big(400000) }];
  assert.ok(budget.measure(many, b).ratio < budget.measure(few, b).ratio,
    "eighty short turns were treated as heavier than one huge one");
});

await check("the usable window is the window minus the reply and the margin", () => {
  const b = budget.budgetFor({ route: "json", maxTokens: 8000 });
  assert.strictEqual(b.usableTokens, b.windowTokens - 8000 - budget.SAFETY_MARGIN_TOKENS);
  assert.ok(b.windowTokens > 0);
});

await check("a spend ceiling is refused before the call, not after", () => {
  assert.strictEqual(budget.canSpend({ costUsd: 0.5, calls: 2 }, { maxCostUsd: 1 }).ok, true);
  const over = budget.canSpend({ costUsd: 1.2, calls: 2 }, { maxCostUsd: 1 });
  assert.strictEqual(over.ok, false);
  assert.strictEqual(over.reason, "budget_limit");
  const many = budget.canSpend({ costUsd: 0, calls: 16 }, { maxCalls: 16 });
  assert.strictEqual(many.reason, "turn_limit");
});

await check("no ceiling means no refusal", () => {
  assert.strictEqual(budget.canSpend({ costUsd: 999, calls: 999 }, {}).ok, true);
});

console.log("\n── a hundred turns, and what survives ───");

/* Synthetic and says so: no provider, the client's own estimator for
   tokens, an injected summariser. What it proves is that the machinery
   does not lose the constraint — not that any model writes well. */
await check("a constraint from turn two survives a hundred turns of compaction", async () => {
  const CONSTRAINT = "every price must be shown in dirhams, never euros";
  let messages = [
    { role: "system", content: "You are a coding agent. " + big(2000) },
    { role: "user", content: "Task: build a barber shop site. " + CONSTRAINT }
  ];
  const headLen = messages.length;

  const facts = {
    prompt: "build a barber shop site. " + CONSTRAINT,
    mode: "act", filesWritten: [], filesEdited: [], errors: [], fileHashes: {}
  };

  const tally = {};
  const summarise = async () => "Work proceeded across many turns.";

  for (let turn = 1; turn <= 100; turn++) {
    messages.push({ role: "assistant", content: "", tool_calls: [{ id: "c" + turn }] });
    messages.push({ role: "tool", tool_call_id: "c" + turn, content: "read src/File" + turn + ".tsx\n" + big(4000) });
    if (turn % 10 === 0) facts.filesWritten.push("src/File" + turn + ".tsx");

    const r = await ctx.prepare({
      messages, headLen, route: "json", maxTokens: 4000, runId: "run_long", facts, summarise
    });
    messages = r.messages;
    for (const a of r.actions) tally[a.step] = (tally[a.step] || 0) + 1;
    assert.ok(r.after.ratio <= 1.02,
      "turn " + turn + " left the request over the window at ratio " + r.after.ratio.toFixed(2));
  }

  const text = messages.map((m) => String(m.content || "")).join("\n");
  assert.ok(text.includes(CONSTRAINT), "the constraint was lost");
  assert.ok(Object.keys(tally).length > 0, "a hundred turns of 4KB reads needed no context work at all");
  assert.strictEqual(messages[0].role, "system", "the system prompt was dropped");

  /* Recorded rather than asserted: for THIS shape of load — bulk that is
     all tool output — clearing it is enough on its own and the expensive
     step never runs. That is the ladder working, not a hole in the test.
     The case below forces the rung above it. */
  console.log("      (steps taken: " + JSON.stringify(tally) +
    ", final request " + messages.length + " messages)");
});

/* Micro-compaction only touches TOOL results. When the bulk is the
   conversation itself — long assistant answers, long user replies —
   there is nothing to clear and the summary is the only thing left
   before whole turns start being dropped. */
await check("when the bulk is conversation rather than tool output, the summary runs", async () => {
  let messages = [{ role: "system", content: "s" }, { role: "user", content: "TASK MARKER: dirhams only" }];
  for (let i = 0; i < 60; i++) {
    messages.push({ role: "assistant", content: "Here is my reasoning in full. " + big(9000) });
    messages.push({ role: "user", content: "Understood, carry on. " + big(9000) });
  }
  const tally = {};
  const r = await ctx.prepare({
    messages, headLen: 2, route: "json", maxTokens: 4000, runId: "r",
    facts: { prompt: "TASK MARKER: dirhams only" },
    summarise: async () => "The middle of this conversation was about layout."
  });
  for (const a of r.actions) tally[a.step] = (tally[a.step] || 0) + 1;
  assert.ok(tally["auto-compact"], "the summary never ran; steps were " + JSON.stringify(tally));
  assert.ok(r.after.ratio < r.before.ratio, "the request did not get smaller");
  const text = r.messages.map((m) => String(m.content || "")).join("\n");
  assert.ok(text.includes("TASK MARKER: dirhams only"), "the task was lost in the summary");
  assert.match(text, /\[context summary\]/);
});

await check("the head is never compacted or dropped", async () => {
  let messages = [
    { role: "system", content: "SYSTEM MARKER " + big(1000) },
    { role: "user", content: "TASK MARKER" }
  ];
  for (let i = 0; i < 60; i++) {
    messages.push({ role: "assistant", content: "", tool_calls: [{ id: "c" + i }] });
    messages.push({ role: "tool", tool_call_id: "c" + i, content: big(6000) });
  }
  const r = await ctx.prepare({
    messages, headLen: 2, route: "json", maxTokens: 4000, runId: "r",
    facts: { prompt: "TASK MARKER" }, summarise: async () => "summary"
  });
  const text = r.messages.map((m) => String(m.content || "")).join("\n");
  assert.ok(text.includes("SYSTEM MARKER"));
  assert.ok(text.includes("TASK MARKER"));
});

await check("a conversation that already fits is returned untouched", async () => {
  const messages = [
    { role: "system", content: "s" },
    { role: "user", content: "build a page" },
    { role: "assistant", content: "done" }
  ];
  const r = await ctx.prepare({ messages, headLen: 2, route: "json", maxTokens: 4000 });
  assert.strictEqual(r.actions.length, 0);
  assert.strictEqual(r.messages, messages);
});

await check("every step it took is reported, so a run can say what it lost", async () => {
  let messages = [{ role: "system", content: "s" }, { role: "user", content: "t" }];
  for (let i = 0; i < 50; i++) {
    messages.push({ role: "assistant", content: "", tool_calls: [{ id: "c" + i }] });
    messages.push({ role: "tool", tool_call_id: "c" + i, content: big(8000) });
  }
  const r = await ctx.prepare({
    messages, headLen: 2, route: "json", maxTokens: 4000, runId: "r",
    facts: { prompt: "t" }, summarise: async () => "s"
  });
  assert.ok(r.actions.length > 0);
  for (const a of r.actions) {
    assert.ok(["micro-compact", "auto-compact", "fit"].includes(a.step), "unknown step " + a.step);
    assert.ok(typeof a.detail === "string" && a.detail.length > 0);
  }
  assert.ok(r.after.usedTokens < r.before.usedTokens, "the request did not get smaller");
});

console.log("\n── one project cannot see another ───────");

await check("rules are per-project objects, never a shared store", () => {
  const a = projectMemory.remember(null, [{ text: "project A is in dirhams", source: "user" }]);
  const b = projectMemory.remember(null, [{ text: "project B is in euros", source: "user" }]);
  assert.ok(!projectMemory.promptBlock(a).includes("euros"));
  assert.ok(!projectMemory.promptBlock(b).includes("dirhams"));
  // and folding into one does not reach back into the other
  const a2 = projectMemory.remember(a, [{ text: "also dark mode", source: "user" }]);
  assert.ok(!projectMemory.promptBlock(b).includes("dark mode"));
  assert.strictEqual(a.rules.length, 1, "the original was mutated");
  assert.strictEqual(a2.rules.length, 2);
});

await check("remember never mutates what it was given", () => {
  const before = projectMemory.remember(null, [{ text: "keep it minimal", source: "user" }]);
  const snapshot = JSON.stringify(before);
  projectMemory.remember(before, [{ text: "add a booking page", source: "user" }]);
  assert.strictEqual(JSON.stringify(before), snapshot);
});

console.log("\n" + (failed === 0
  ? "✓ ALL CONTEXT TESTS PASSED (" + passed + ")"
  : "✗ " + failed + " FAILED, " + passed + " passed"));
process.exit(failed === 0 ? 0 : 1);

})();
