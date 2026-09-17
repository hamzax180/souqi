"use strict";

const assert = require("assert");
const runStore = require("../lib/codeagent/run-store");
const agentRunner = require("../lib/codeagent/agent-runner");
const client = require("../lib/ai/client");

// In-memory DB
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
              if (v && typeof v === "object" && Array.isArray(v.$in)) {
                if (!v.$in.includes(d[k])) return false;
              } else if (d[k] !== v) {
                return false;
              }
            }
            return true;
          });
          if (!match) return { modifiedCount: 0 };
          if (update.$set) Object.assign(match, update.$set);
          return { modifiedCount: 1 };
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
  console.log("\n── agent-runner unit tests ─────────────────────────");

  const mockDb = createMockDb();
  runStore.init({ getMasterDb: () => mockDb });

  const owner = { userId: "usr_test", anonId: null };

  await check("agentRunner executes multi-turn tool flow and completes", async () => {
    // Mock client responses
    let step = 0;
    const fetchStub = async (url, opts) => {
      step++;
      if (step === 1) {
        // Step 1: Model writes src/App.tsx
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                role: "assistant",
                content: "I will write the initial App component.",
                tool_calls: [{
                  id: "call_1",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({ path: "src/App.tsx", content: "export default function App() { return <h1>Barber</h1>; }" })
                  }
                }]
              },
              finish_reason: "tool_calls"
            }]
          })
        };
      } else {
        // Step 2: Model completes task
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                role: "assistant",
                content: "All files written and verified.",
                tool_calls: [{
                  id: "call_2",
                  function: {
                    name: "complete_task",
                    arguments: JSON.stringify({ summary: "Built the Barber shop landing page." })
                  }
                }]
              },
              finish_reason: "tool_calls"
            }]
          })
        };
      }
    };

    client.init({
      enabled: true,
      routes: { json: { baseUrl: "http://mock", key: "mock-key", model: "mock-model" } },
      fetchImpl: fetchStub
    });

    const run = await runStore.createRun({
      projectId: null,
      owner,
      prompt: "Build a Barber shop landing page",
      mode: "auto",
      effort: "smart"
    });

    const outcome = await agentRunner.executeRun(run.id);

    assert.strictEqual(outcome.ok, true);
    assert.ok(outcome.files["src/App.tsx"]);
    assert.strictEqual(outcome.summary, "Built the Barber shop landing page.");

    const finalRun = await runStore.getRun(run.id, owner);
    assert.strictEqual(finalRun.status, "succeeded");
  });

  await check("agentRunner halts when run is cancelled mid-flight", async () => {
    const fetchStub = async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            role: "assistant",
            tool_calls: [{
              id: "call_slow",
              function: { name: "write_file", arguments: JSON.stringify({ path: "src/Test.tsx", content: "test" }) }
            }]
          }
        }]
      })
    });

    client.init({
      enabled: true,
      routes: { json: { baseUrl: "http://mock", key: "mock-key", model: "mock-model" } },
      fetchImpl: fetchStub
    });

    const run = await runStore.createRun({
      projectId: null,
      owner,
      prompt: "Large project",
      mode: "auto",
      effort: "smart"
    });

    // Cancel immediately
    await runStore.cancelRun(run.id, owner, "User cancelled");

    const outcome = await agentRunner.executeRun(run.id);
    assert.strictEqual(outcome.cancelled, true);
  });

  await check("agentRunner answers conversational inquiry without tools when app already exists", async () => {
    const fetchStub = async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            role: "assistant",
            content: "The previous error was a missing import of Button component in src/App.tsx."
          }
        }]
      })
    });

    client.init({
      enabled: true,
      routes: { json: { baseUrl: "http://mock", key: "mock-key", model: "mock-model" } },
      fetchImpl: fetchStub
    });

    const run = await runStore.createRun({
      projectId: "proj_123",
      owner,
      prompt: "what was the error",
      mode: "auto",
      effort: "smart",
      baseFiles: { "src/App.tsx": "export default function App() { return null; }" }
    });

    const outcome = await agentRunner.executeRun(run.id);
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.summary, "The previous error was a missing import of Button component in src/App.tsx.");
    const finalRun = await runStore.getRun(run.id, owner);
    assert.strictEqual(finalRun.status, "succeeded");
  });

  await check("agentRunner in build mode bypasses question detection and directly writes code", async () => {
    let toolsOffered = null;
    const fetchStub = async (_url, init) => {
      const body = JSON.parse(init.body);
      toolsOffered = body.tools;
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: "assistant",
              content: "Building the navbar.",
              tool_calls: [{
                id: "call_build",
                function: {
                  name: "complete_task",
                  arguments: JSON.stringify({ summary: "Added navbar." })
                }
              }]
            },
            finish_reason: "tool_calls"
          }]
        })
      };
    };

    client.init({
      enabled: true,
      routes: { json: { baseUrl: "http://mock", key: "mock-key", model: "mock-model" } },
      fetchImpl: fetchStub
    });

    const run = await runStore.createRun({
      projectId: "proj_456",
      owner,
      prompt: "why don't you add a navbar?",
      mode: "build",
      effort: "smart",
      baseFiles: { "src/App.tsx": "export default function App() { return null; }" }
    });

    const outcome = await agentRunner.executeRun(run.id);
    assert.strictEqual(outcome.ok, true);
    // In build mode, dynamic tools schema must be offered to the model
    assert.ok(Array.isArray(toolsOffered) && toolsOffered.length > 0);
    assert.ok(toolsOffered.some(t => t.function && t.function.name === "write_file"));
  });

  await check("agentRunner answers conversational prompt without tools on fresh project", async () => {
    let toolsOffered = null;
    const fetchStub = async (_url, init) => {
      const body = JSON.parse(init.body);
      toolsOffered = body.tools;
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: "assistant",
              content: "I'm doing well, thanks! What would you like me to build for you today?"
            }
          }]
        })
      };
    };

    client.init({
      enabled: true,
      routes: { json: { baseUrl: "http://mock", key: "mock-key", model: "mock-model" } },
      fetchImpl: fetchStub
    });

    const run = await runStore.createRun({
      projectId: null,
      owner,
      prompt: "how are you",
      mode: "auto",
      effort: "smart",
      baseFiles: {}
    });

    const outcome = await agentRunner.executeRun(run.id);
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.summary, "I'm doing well, thanks! What would you like me to build for you today?");
    assert.ok(Array.isArray(toolsOffered));
    assert.ok(!toolsOffered.some(t => t.function && (t.function.name === "write_file" || t.function.name === "edit_file")));
  });

  await check("agentRunner treats corrections like 'i didnt say build yet' as conversational", async () => {
    let toolsOffered = null;
    const fetchStub = async (_url, init) => {
      const body = JSON.parse(init.body);
      toolsOffered = body.tools;
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: "assistant",
              content: "My bad! I won't touch any code until you're ready. What are you planning to build?"
            }
          }]
        })
      };
    };

    client.init({
      enabled: true,
      routes: { json: { baseUrl: "http://mock", key: "mock-key", model: "mock-model" } },
      fetchImpl: fetchStub
    });

    const run = await runStore.createRun({
      projectId: "proj_correction",
      owner,
      prompt: "i didnt say build yet",
      mode: "auto",
      effort: "smart",
      baseFiles: {}
    });

    const outcome = await agentRunner.executeRun(run.id);
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.summary, "My bad! I won't touch any code until you're ready. What are you planning to build?");
    assert.ok(!toolsOffered.some(t => t.function && (t.function.name === "write_file" || t.function.name === "edit_file")));
  });

  await check("agentRunner treats 'build when i tell you build' as conversational", async () => {
    let toolsOffered = null;
    const fetchStub = async (_url, init) => {
      const body = JSON.parse(init.body);
      toolsOffered = body.tools;
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: "assistant",
              content: "Understood! I will only build when you tell me to. What would you like to plan?"
            }
          }]
        })
      };
    };

    client.init({
      enabled: true,
      routes: { json: { baseUrl: "http://mock", key: "mock-key", model: "mock-model" } },
      fetchImpl: fetchStub
    });

    const run = await runStore.createRun({
      projectId: "proj_meta",
      owner,
      prompt: "build when i tell you build",
      mode: "auto",
      effort: "smart",
      baseFiles: {}
    });

    const outcome = await agentRunner.executeRun(run.id);
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.summary, "Understood! I will only build when you tell me to. What would you like to plan?");
    assert.ok(!toolsOffered.some(t => t.function && (t.function.name === "write_file" || t.function.name === "edit_file")));
  });

  await check("isQuestionOrConversational accurately distinguishes casual chat/idk/typos from build tasks", async () => {
    const shouldBeChat = [
      "idk", "not sure", "dunno", "no idea", "any ideas?", "suggest something",
      "s", "a", "asdf", "zzz", "ok", "okay", "k", "cool", "nice", "wow",
      "you know when to build and when not now , wow", "i didnt say build yet",
      "how are you", "what can you do", "wait", "hold on", "stop"
    ];
    for (const prompt of shouldBeChat) {
      assert.strictEqual(agentRunner.isQuestionOrConversational(prompt), true, `${prompt} should be detected as conversational`);
    }

    const shouldBeBuild = [
      "build a todo app", "create a landing page", "add a dark mode button",
      "portfolio website", "ecommerce store", "crm", "2d snake game", "calculator"
    ];
    for (const prompt of shouldBeBuild) {
      assert.strictEqual(agentRunner.isQuestionOrConversational(prompt), false, `${prompt} should be detected as a build task`);
    }
  });

  /* An attached photo is intent, and the route needs exactly one question
     answered to know when it is not: is the user telling us to hold off?

     "can you see this pic make it one of the slides" is read as a question
     about our capabilities by rule 7, correctly, on the text alone — the
     classifier cannot see that a file came with it. The route overrides it
     when there is an attachment, EXCEPT for this class, because "wait,
     don't build yet" with a logo attached still means wait. */
  await check("isStopOrCorrection isolates 'hold off' from every other kind of chat", async () => {
    const holdOff = [
      "wait", "hold on", "stop", "not yet", "i didnt say build yet",
      "dont build", "don't touch that", "i didn't ask for that", "no wait"
    ];
    for (const prompt of holdOff) {
      assert.strictEqual(agentRunner.isStopOrCorrection(prompt), true,
        `${prompt} must keep its veto over an attachment`);
    }

    // Conversational, but NOT telling us to hold off — so an attachment
    // is allowed to carry the turn into a real build.
    const notHoldOff = [
      "can you see this pic make it the one of the slides",
      "what do you think of this", "how are you", "idk", "nice", "asdf",
      "use this as the hero image", "make this the logo"
    ];
    for (const prompt of notHoldOff) {
      assert.strictEqual(agentRunner.isStopOrCorrection(prompt), false,
        `${prompt} is not a hold-off and must not veto an attachment`);
    }
  });

  /* The four below are the tests that were missing when the durable
     worker shipped. worker-service built a finalizer, passed it in opts,
     and executeRun never called it — so a worker run marked itself
     succeeded and the project stayed empty. Nothing here exercised the
     finalizer seam, so eight green tests said the path was fine. */

  function completingStub(summary) {
    let step = 0;
    return async () => {
      step++;
      const call = step === 1
        ? { id: "c1", function: { name: "write_file", arguments: JSON.stringify({ path: "src/App.tsx", content: "export default function App(){return <h1>Hi</h1>;}" }) } }
        : { id: "c2", function: { name: "complete_task", arguments: JSON.stringify({ summary }) } };
      return { ok: true, json: async () => ({ choices: [{ message: { role: "assistant", tool_calls: [call] }, finish_reason: "tool_calls" }] }) };
    };
  }

  function useStub(fetchImpl) {
    client.init({
      enabled: true,
      routes: { json: { baseUrl: "http://mock", key: "mock-key", model: "mock-model" } },
      fetchImpl
    });
  }

  await check("a supplied finalizer owns the terminal transition, not updateRun", async () => {
    useStub(completingStub("Done."));
    const run = await runStore.createRun({ projectId: null, owner, prompt: "Build a page", mode: "auto", effort: "smart" });

    const seen = [];
    const outcome = await agentRunner.executeRun(run.id, {
      finalize: async (result, status) => { seen.push({ status, stopReason: result.stopReason }); return true; }
    });

    assert.strictEqual(outcome.ok, true);
    assert.deepStrictEqual(seen, [{ status: "succeeded", stopReason: "completed" }],
      "finalize must be called exactly once, with the terminal status");
    // The whole point: the runner must NOT have written the status itself,
    // or the finalizer's transaction is bypassed and its fencing with it.
    const row = await runStore.getRun(run.id, owner);
    assert.notStrictEqual(row.status, "succeeded",
      "the runner wrote the terminal status itself, so the finalizer was decoration");
  });

  await check("a fenced finalizer is reported, not treated as committed", async () => {
    useStub(completingStub("Done."));
    const run = await runStore.createRun({ projectId: null, owner, prompt: "Build a page", mode: "auto", effort: "smart" });

    const outcome = await agentRunner.executeRun(run.id, { finalize: async () => false });
    assert.strictEqual(outcome.fenced, true,
      "a refused finalize means another worker owns this run; saying nothing lets both claim the result");
  });

  await check("with no finalizer the runner still settles the run itself", async () => {
    useStub(completingStub("Done."));
    const run = await runStore.createRun({ projectId: null, owner, prompt: "Build a page", mode: "auto", effort: "smart" });

    await agentRunner.executeRun(run.id);
    const row = await runStore.getRun(run.id, owner);
    assert.strictEqual(row.status, "succeeded");
    assert.strictEqual(row.stopReason, "completed", "the stop reason must reach the row, not just the return value");
  });

  await check("a provider refusal is provider_error, and keeps work already written", async () => {
    // Writes a file, then the provider refuses — a 402 is badRequest, so
    // it is not retried and the second call is the one that fails.
    let step = 0;
    useStub(async () => {
      step++;
      if (step === 1) {
        return { ok: true, json: async () => ({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "c1", function: { name: "write_file", arguments: JSON.stringify({ path: "src/App.tsx", content: "export default function App(){return <h1>Hi</h1>;}" }) } }] }, finish_reason: "tool_calls" }] }) };
      }
      return { ok: false, status: 402, text: async () => '{"error":{"message":"Insufficient Balance"}}', json: async () => ({}) };
    });

    const run = await runStore.createRun({ projectId: null, owner, prompt: "Build a page", mode: "auto", effort: "smart" });
    const outcome = await agentRunner.executeRun(run.id);

    assert.strictEqual(outcome.stopReason, "provider_error", "no tool failed — the provider refused");
    assert.ok(outcome.files && outcome.files["src/App.tsx"],
      "a blip on a later step must not discard the files earlier steps wrote");
    const row = await runStore.getRun(run.id, owner);
    assert.strictEqual(row.status, "partial", "work survived, so the run is partial rather than failed");
    assert.strictEqual(row.stopReason, "provider_error");
  });

  await check("the step recorded for recovery is the untrimmed output", async () => {
    /* The turn budget trims tool results to fit the request, and the step
       was recorded AFTER that — so the "raw record" micro-compaction
       points at was the trimmed text, and recovering it returned the same
       truncated thing the pointer was offering to replace.

       Three big reads exceed MAX_TURN_RESULT_CHARS, which is what makes
       the budget trim at all. */
    const registry = require("../lib/codeagent/tool-registry");
    const big = (tag) => tag + "\n" + "x".repeat(registry.MAX_RESULT_CHARS);
    const baseFiles = { "src/a.tsx": big("A"), "src/b.tsx": big("B"), "src/c.tsx": big("C") };

    let step = 0;
    useStub(async () => {
      step++;
      const calls = step === 1
        ? ["src/a.tsx", "src/b.tsx", "src/c.tsx"].map((p, i) => ({
            id: "r" + i, function: { name: "read_file", arguments: JSON.stringify({ path: p }) }
          }))
        : [{ id: "done", function: { name: "complete_task", arguments: JSON.stringify({ summary: "read them" }) } }];
      return { ok: true, json: async () => ({ choices: [{ message: { role: "assistant", tool_calls: calls }, finish_reason: "tool_calls" }] }) };
    });

    const captured = [];
    const realRecordStep = runStore.recordStep;
    runStore.recordStep = async (runId, data) => { captured.push(data); return realRecordStep(runId, data); };
    try {
      const run = await runStore.createRun({
        projectId: null, owner, prompt: "read the files", mode: "auto", effort: "smart", baseFiles
      });
      await agentRunner.executeRun(run.id);
    } finally {
      runStore.recordStep = realRecordStep;
    }

    const readTurn = captured.find((s) => (s.toolResults || []).length === 3);
    assert.ok(readTurn, "the turn with three reads was never recorded");

    /* The budget spends in call order, so it is the LAST result that gets
       cut — the total stays just over the ceiling either way, which is
       why asserting on the total proved nothing. The property that
       actually distinguishes them is that no single recorded result was
       shortened. */
    const lengths = readTurn.toolResults.map((r) => String(r.content || "").length);
    assert.ok(Math.min(...lengths) >= registry.MAX_RESULT_CHARS,
      "a recorded result was trimmed (lengths " + lengths.join(", ") +
      ") — the raw record is not raw, so recovering it returns the same truncated text");
  });

  /* A streaming transport, so the runner's own streaming path is what
     these exercise. The stubs above return a whole completion, which the
     client accepts as a gateway that ignored the flag — useful coverage,
     but not this. */
  function sseStub(framesPerCall) {
    let call = 0;
    return async () => {
      const frames = framesPerCall[Math.min(call++, framesPerCall.length - 1)];
      const body = frames.map((f) => "data: " + JSON.stringify(f) + "\n\n").join("") + "data: [DONE]\n\n";
      const bytes = new TextEncoder().encode(body);
      let sent = false;
      return {
        ok: true,
        body: { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: bytes })) }) }
      };
    };
  }

  await check("a streamed turn narrates itself and still dispatches its tools", async () => {
    useStub(sseStub([
      [
        { choices: [{ delta: { content: "I will write " } }] },
        { choices: [{ delta: { content: "the component." } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "s1", type: "function", function: { name: "write_file", arguments: "" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: "src/App.tsx", content: "export default function App(){return <h1>Hi</h1>;}" }) } }] }, finish_reason: "tool_calls" }] },
        { usage: { prompt_tokens: 10, completion_tokens: 5 } }
      ],
      [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "s2", type: "function", function: { name: "complete_task", arguments: JSON.stringify({ summary: "Wrote it." }) } }] }, finish_reason: "tool_calls" }] },
        { usage: { prompt_tokens: 10, completion_tokens: 5 } }
      ]
    ]));

    const run = await runStore.createRun({
      projectId: null, owner, prompt: "write a component", mode: "auto", effort: "smart"
    });
    const outcome = await agentRunner.executeRun(run.id);

    assert.strictEqual(outcome.ok, true, "a streamed turn must dispatch exactly as a whole one does");
    assert.ok(outcome.files["src/App.tsx"], "the stitched tool arguments never reached the dispatcher");

    const events = await runStore.getEvents(run.id, 0);
    const deltas = events.filter((e) => e.type === "assistant_delta");
    assert.ok(deltas.length >= 1, "the run said nothing while it was writing");
    assert.strictEqual(deltas.map((e) => e.payload.text).join(""), "I will write the component.",
      "the narration must be complete — the tail is easy to leave in the buffer");

    // The point of streaming: the tool is announced before its arguments
    // finish generating, which on a real eight-file turn is ~20s earlier.
    const intents = events.filter((e) => e.type === "tool_intent");
    assert.ok(intents.some((e) => e.payload.tool === "write_file"), "no tool_intent for the write");
    const intentSeq = intents.find((e) => e.payload.tool === "write_file").seq;
    const startSeq = events.find((e) => e.type === "tool_start" && e.payload.tool === "write_file").seq;
    assert.ok(intentSeq < startSeq, "the intent must arrive before the dispatch, or it is telling us nothing new");
  });

  await check("streamed narration is redacted", async () => {
    const KEY = "sk-ant-api03-" + "B".repeat(40);
    useStub(sseStub([
      [
        { choices: [{ delta: { content: "Your key is " + KEY + " apparently." } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "s1", type: "function", function: { name: "complete_task", arguments: JSON.stringify({ summary: "done" }) } }] }, finish_reason: "tool_calls" }] }
      ]
    ]));
    const run = await runStore.createRun({
      projectId: null, owner, prompt: "say it", mode: "auto", effort: "smart"
    });
    await agentRunner.executeRun(run.id);
    for (const e of await runStore.getEvents(run.id, 0)) {
      if (e.type !== "assistant_delta") continue;
      assert.ok(!String(e.payload.text || "").includes(KEY), "a streamed delta leaked a key");
    }
  });

  await check("a finalizer that rejects is reported as a conflict, not abandoned", async () => {
    /* The finalizer throws when the project moved under the run. Nothing
       caught it: the throw escaped to the worker's catch, the run was
       left mid-flight still holding its lease, and the stale sweep later
       relabelled a run that had already emitted ok:true as "the agent
       worker stopped before finishing". Seen on a live edit. */
    useStub(completingStub("Done."));
    const run = await runStore.createRun({
      projectId: "pr_moved", owner, prompt: "edit it", mode: "auto", effort: "smart"
    });

    const outcome = await agentRunner.executeRun(run.id, {
      finalize: async () => { throw new Error("Project changed during this run; candidate files are saved, but were not applied"); }
    });

    assert.strictEqual(outcome.conflict, true);
    assert.strictEqual(outcome.stopReason, "conflict", "a conflict is not a tool error");
    assert.ok(/Project changed/.test(outcome.reason));

    const row = await runStore.getRun(run.id, owner);
    assert.strictEqual(row.status, "partial", "the run must reach a terminal state, not be left running");
    assert.strictEqual(row.stopReason, "conflict");
    assert.ok(/Project changed/.test(row.latestError), "the row must say what actually happened");
  });

  await check("every tool_start is closed by a tool_result", async () => {
    /* It was not. Writes closed with file_written, commands with a
       command/done and refusals with tool_denied — a successful
       read_file, list_files or search_code closed with nothing, so the
       terminal showed them starting and never finishing. */
    let step = 0;
    useStub(async () => {
      step++;
      const calls = step === 1
        ? [
            { id: "t1", function: { name: "list_files", arguments: "{}" } },
            { id: "t2", function: { name: "write_file", arguments: JSON.stringify({ path: "src/App.tsx", content: "export default function App(){return <h1>Hi</h1>;}" }) } },
            { id: "t3", function: { name: "read_file", arguments: JSON.stringify({ path: "src/App.tsx" }) } },
            // A genuine refusal. A traversal path is not one — the tree is
            // in memory, so it comes back "File not found" with ok:true.
            { id: "t4", function: { name: "definitely_not_a_tool", arguments: "{}" } }
          ]
        : [{ id: "done", function: { name: "complete_task", arguments: JSON.stringify({ summary: "ok" }) } }];
      return { ok: true, json: async () => ({ choices: [{ message: { role: "assistant", tool_calls: calls }, finish_reason: "tool_calls" }] }) };
    });

    const run = await runStore.createRun({
      projectId: null, owner, prompt: "look around", mode: "auto", effort: "smart"
    });
    await agentRunner.executeRun(run.id);

    const events = await runStore.getEvents(run.id, 0);
    const starts = events.filter((e) => e.type === "tool_start");
    const results = events.filter((e) => e.type === "tool_result");
    assert.strictEqual(starts.length, results.length,
      starts.length + " tool_start events but " + results.length + " tool_result");

    // The refused read is still a result — a refusal that reports nothing
    // is exactly the case the terminal could not show.
    const refused = results.find((e) => e.payload.toolCallId === "t4");
    assert.ok(refused, "the refused tool never reported a result");
    assert.strictEqual(refused.payload.ok, false);
    assert.ok(events.some((e) => e.type === "tool_denied"), "a refusal still reports tool_denied too");

    const read = results.find((e) => e.payload.toolCallId === "t3");
    assert.strictEqual(read.payload.ok, true);
    assert.ok(read.payload.bytes > 0, "a successful read reports how much it returned");
    assert.ok(typeof read.payload.ms === "number");
  });

  await check("a tool_result detail carries no secret", async () => {
    // Tool output is the likeliest place in a run for a key to appear,
    // and an event is durable and goes to the browser.
    const KEY = "sk-ant-api03-" + "A".repeat(40);
    let step = 0;
    useStub(async () => {
      step++;
      const calls = step === 1
        ? [{ id: "w", function: { name: "write_file", arguments: JSON.stringify({ path: "src/App.tsx", content: "// " + KEY + "\nexport default function App(){return <h1>Hi</h1>;}" }) } }]
        : [{ id: "done", function: { name: "complete_task", arguments: JSON.stringify({ summary: "ok" }) } }];
      return { ok: true, json: async () => ({ choices: [{ message: { role: "assistant", tool_calls: calls }, finish_reason: "tool_calls" }] }) };
    });

    const run = await runStore.createRun({
      projectId: null, owner, prompt: "write it", mode: "auto", effort: "smart"
    });
    await agentRunner.executeRun(run.id);

    for (const e of await runStore.getEvents(run.id, 0)) {
      if (e.type !== "tool_result") continue;
      assert.ok(!String(e.payload.detail || "").includes(KEY),
        "a tool_result detail leaked a key");
    }
  });

  console.log("\n" + (failed === 0 ? "✓ ALL AGENT-RUNNER TESTS PASSED (" + passed + ")" : "✗ " + failed + " FAILED, " + passed + " passed"));
  process.exit(failed === 0 ? 0 : 1);
})();
