/* =================================================================
   ai-client-test.js — lib/ai/client.js's contract, with NO real network
   -----------------------------------------------------------------
   Every guarantee in docs/AI-PROVIDER-PLAN.md is testable without a
   live key: off by default, per-route missing-config disables that
   route only, the per-route circuit breaker trips at 5 failures and
   cools down, the whole-adapter budget guard stops spend, and a
   successful call is costed and recorded. `fetchImpl` is injected so
   nothing here ever leaves the machine.

   Run: npm run test:ai-client
   ================================================================= */
"use strict";
const assert = require("assert");
const client = require("../lib/ai/client");

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n      " + e.message); }
}

function okFetch(body, usage) {
  return async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { role: "assistant", content: body || "hi" }, finish_reason: "stop" }],
      usage: usage || { prompt_tokens: 100, completion_tokens: 50 }
    })
  });
}
function failFetch(status) {
  return async () => ({ ok: false, status: status || 500, json: async () => ({ error: { message: "boom" } }) });
}
function hangingFetch(ms) {
  return async (url, opts) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve({ ok: true, json: async () => ({ choices: [], usage: {} }) }), ms);
    if (opts && opts.signal) opts.signal.addEventListener("abort", () => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
  });
}

const FULL_ROUTES = {
  prose: { baseUrl: "https://example.invalid/prose", model: "test-prose", key: "k1" },
  json: { baseUrl: "https://example.invalid/json", model: "test-json", key: "k2" }
};

(async () => {
  console.log("\n── off by default ──────────────────────────────────");

  await check("AI_ENABLED not set -> disabled, no fetch called", async () => {
    let called = false;
    client.init({ enabled: false, fetchImpl: async () => { called = true; }, routes: FULL_ROUTES });
    const res = await client.chat({ route: "json", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.disabled, true);
    assert.strictEqual(called, false, "fetch was called despite AI_ENABLED being off");
  });

  await check("a route with no key is served by the one that has a key", async () => {
    // prose and json are a cost preference, not a capability split. This used
    // to return {disabled:true}, and in production AI_PROSE_KEY was empty:
    // assessPrompt failed open to "build" on every turn, so the agent could
    // never hold a conversation and every plan came from fallbackPlan(). One
    // unset key, no error anywhere.
    client.init({ enabled: true, fetchImpl: okFetch(), routes: { prose: FULL_ROUTES.prose, json: { baseUrl: "", model: "", key: "" } } });
    const res = await client.chat({ route: "json", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.servedFallback, true);
    assert.strictEqual(res.route, "prose");        // billed to whoever did the work
  });

  await check("a configured route is never diverted", async () => {
    client.init({ enabled: true, fetchImpl: okFetch(), routes: FULL_ROUTES });
    const res = await client.chat({ route: "json", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(res.route, "json");
    assert.strictEqual(res.servedFallback, false);
  });

  await check("no route configured at all -> disabled, not a crash", async () => {
    const none = { baseUrl: "", model: "", key: "" };
    client.init({ enabled: true, fetchImpl: okFetch(), routes: { prose: none, json: none } });
    const res = await client.chat({ route: "json", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.disabled, true);
  });

  await check("unknown route throws — this is a caller bug, not an operational failure", async () => {
    client.init({ enabled: true, fetchImpl: okFetch(), routes: FULL_ROUTES });
    await assert.rejects(() => client.chat({ route: "typo", messages: [] }), /unknown route/);
  });

  /* "vision" used to be the example of an unknown route here. It is a real
     one now, and these two cases are why it needed adding rather than
     borrowing prose: both other routes in this deployment are text-only. */
  await check("vision is a real route, and is NOT served by a text-only fallback", async () => {
    client.init({
      enabled: true, fetchImpl: okFetch("described"),
      routes: { prose: FULL_ROUTES.prose, json: FULL_ROUTES.json, vision: { baseUrl: "", model: "", key: "" } }
    });
    const res = await client.chat({ route: "vision", messages: [{ role: "user", content: "x" }] });
    assert.strictEqual(res.ok, false, "an unconfigured vision route must fail, not borrow a blind model");
    assert.notStrictEqual(res.servedBy, "prose");
  });

  await check("vision serves itself when configured", async () => {
    client.init({
      enabled: true, fetchImpl: okFetch("a cafe interior"),
      routes: { prose: FULL_ROUTES.prose, json: FULL_ROUTES.json, vision: FULL_ROUTES.prose }
    });
    const res = await client.chat({ route: "vision", messages: [{ role: "user", content: "x" }] });
    assert.strictEqual(res.ok, true);
  });

  console.log("\n── the happy path is costed and recorded ───────────");

  await check("a successful call returns message + usage + an estimated cost", async () => {
    client.init({ enabled: true, fetchImpl: okFetch("hello there"), routes: FULL_ROUTES });
    const res = await client.chat({ route: "json", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.message.content, "hello there");
    assert.strictEqual(res.usage.prompt_tokens, 100);
    assert.ok(res.costUsd > 0, "expected a nonzero estimated cost");
    assert.ok(client.monthSpend("json") > 0, "spend was not recorded against the route");
  });

  await check("DeepSeek cache-hit tokens are costed at the cached rate, not the miss rate", async () => {
    client.init({ enabled: true, fetchImpl: okFetch("x", { prompt_cache_hit_tokens: 10000, prompt_cache_miss_tokens: 0, completion_tokens: 0 }), routes: FULL_ROUTES });
    const cheap = await client.chat({ route: "json", messages: [] });
    client.init({ enabled: true, fetchImpl: okFetch("x", { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10000, completion_tokens: 0 }), routes: FULL_ROUTES });
    const expensive = await client.chat({ route: "json", messages: [] });
    assert.ok(cheap.costUsd < expensive.costUsd, "a full cache hit should cost less than a full cache miss for the same token count");
  });

  console.log("\n── the circuit breaker, per route ──────────────────");

  await check("5 consecutive failures open the breaker; the 6th call never reaches fetch", async () => {
    let calls = 0;
    client.init({ enabled: true, fetchImpl: async () => { calls++; return failFetch()(); }, routes: FULL_ROUTES });
    for (let i = 0; i < 5; i++) await client.chat({ route: "json", messages: [] });
    assert.strictEqual(calls, 5);
    const res = await client.chat({ route: "json", messages: [] });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.breakerOpen, true, "breaker should be open after 5 straight failures");
    assert.strictEqual(calls, 5, "the 6th call reached fetch — the breaker did not actually stop it");
  });

  await check("a failing DeepSeek route does not affect Gemini — breakers are per route", async () => {
    let proseCalls = 0, jsonCalls = 0;
    client.init({
      enabled: true,
      fetchImpl: async (url) => { if (url.indexOf("/json") >= 0) { jsonCalls++; return failFetch()(); } proseCalls++; return okFetch()(); },
      routes: FULL_ROUTES
    });
    for (let i = 0; i < 6; i++) await client.chat({ route: "json", messages: [] });
    const proseRes = await client.chat({ route: "prose", messages: [] });
    assert.strictEqual(proseRes.ok, true, "prose route was blocked by the json route's breaker");
    assert.ok(jsonCalls >= 5 && proseCalls === 1);
  });

  console.log("\n── what the breaker is allowed to count ───────");

  await check("our own 400s never open the breaker, however many there are", async () => {
    /* The case this was written for: a build whose prompt outgrew the model's
       context window returns 400 instantly. Five of those in a row used to
       take the json route down for ten minutes for EVERY user — an outage
       invented by the client, while the provider was healthy throughout. */
    let calls = 0;
    client.init({ enabled: true, fetchImpl: async () => { calls++; return failFetch(400)(); }, routes: FULL_ROUTES });
    for (let i = 0; i < 10; i++) await client.chat({ route: "json", messages: [] });
    assert.strictEqual(calls, 10, "a 400 stopped reaching fetch — the breaker opened on our own bad request");

    client.init({ enabled: true, fetchImpl: okFetch("fine"), routes: FULL_ROUTES });
    const after = await client.chat({ route: "json", messages: [] });
    assert.strictEqual(after.ok, true, "a good request was refused after a run of 400s");
  });

  await check("a 400 says so, and a 500 does not", async () => {
    // The flag is what lets the build loop tell "try again later" from
    // "this exact request will fail the same way forever".
    client.init({ enabled: true, fetchImpl: failFetch(400), routes: FULL_ROUTES });
    const bad = await client.chat({ route: "json", messages: [] });
    assert.strictEqual(bad.badRequest, true);
    assert.strictEqual(bad.status, 400);

    client.init({ enabled: true, fetchImpl: failFetch(503), routes: FULL_ROUTES });
    const down = await client.chat({ route: "json", messages: [] });
    assert.strictEqual(down.badRequest, false, "a 503 is the provider, not us");
  });

  await check("429 still opens it — that 4xx is the one that means back off", async () => {
    let calls = 0;
    client.init({ enabled: true, fetchImpl: async () => { calls++; return failFetch(429)(); }, routes: FULL_ROUTES });
    for (let i = 0; i < 6; i++) await client.chat({ route: "json", messages: [] });
    assert.strictEqual(calls, 5, "rate limiting must still trip the breaker; made " + calls + " calls");
  });

  await check("a config error stays visible instead of hiding behind an open breaker", async () => {
    /* 401 and 404 are persistent and cheap to receive, so there is no herd to
       protect. Opening the breaker would replace "your key was rejected" with
       "circuit breaker open" on every later call, which is the one message
       that does not tell an operator what to fix. */
    client.init({ enabled: true, fetchImpl: failFetch(401), routes: FULL_ROUTES });
    let last;
    for (let i = 0; i < 8; i++) last = await client.chat({ route: "json", messages: [] });
    assert.strictEqual(last.breakerOpen, undefined, "the breaker swallowed a key error");
    assert.strictEqual(last.status, 401, "the real status stopped surfacing");
  });

  console.log("\n── the monthly budget guard ────────────────────────");

  await check("spend at/above the budget disables every route, not just the one that spent it", async () => {
    client.init({ enabled: true, budgetUsd: 0.000001, fetchImpl: okFetch("x", { prompt_tokens: 100000, completion_tokens: 100000 }), routes: FULL_ROUTES });
    const first = await client.chat({ route: "json", messages: [] });
    assert.strictEqual(first.ok, true, "the call that PUSHES spend over budget should still complete");
    const second = await client.chat({ route: "prose", messages: [] });
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.budgetExceeded, true);
  });

  await check("budgetUsd: 0 means unlimited (the safety default is opt-in, not silently on)", async () => {
    client.init({ enabled: true, budgetUsd: 0, fetchImpl: okFetch("x", { prompt_tokens: 999999999, completion_tokens: 999999999 }), routes: FULL_ROUTES });
    await client.chat({ route: "json", messages: [] });
    const res = await client.chat({ route: "json", messages: [] });
    assert.strictEqual(res.ok, true, "budgetUsd:0 incorrectly blocked a call");
  });

  console.log("\n── timeouts degrade, they do not hang or throw ─────");

  await check("a slow provider aborts at the timeout and reports timedOut, not an exception", async () => {
    client.init({ enabled: true, fetchImpl: hangingFetch(5000), routes: FULL_ROUTES });
    const res = await client.chat({ route: "json", messages: [], timeoutMs: 50 });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.timedOut, true);
  });

  for (const byok of [false, true]) {
    for (const status of [200, 503]) {
      await check((byok ? "BYOK" : "shared") + " deadline includes a hanging " + status + " body after headers", async () => {
        let signal;
        client.init({ enabled: true, routes: FULL_ROUTES, fetchImpl: async (url, opts) => {
          signal = opts.signal;
          return { ok: status === 200, status, json: () => new Promise(() => {}) };
        } });
        const res = await client.chat({ route: "json", messages: [], timeoutMs: 20,
          byok: byok ? { provider: "deepseek", apiKey: "test-key" } : undefined });
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.timedOut, true);
        assert.strictEqual(res.cancelled, false);
        assert.strictEqual(signal.aborted, true);
        assert.strictEqual(client._debugState().breakers.json.failCount, byok ? 0 : 1);
      });
    }
  }

  await check("a cancelled request never reaches fetch or poisons the provider breaker", async () => {
    let calls = 0;
    client.init({ enabled: true, routes: FULL_ROUTES, fetchImpl: async () => { calls++; return okFetch()(); } });
    const controller = new AbortController();
    controller.abort();
    for (let i = 0; i < 6; i++) {
      const res = await client.chat({ route: "json", messages: [], signal: controller.signal });
      assert.strictEqual(res.cancelled, true);
      assert.strictEqual(res.timedOut, false);
    }
    assert.strictEqual(calls, 0);
    assert.strictEqual(client._debugState().breakers.json.failCount, 0);
    assert.strictEqual((await client.chat({ route: "json", messages: [] })).ok, true);
  });

  for (const byok of [false, true]) {
    await check((byok ? "BYOK" : "shared") + " cancellation interrupts the body and removes the parent listener", async () => {
      const controller = new AbortController();
      let attached = 0, detached = 0;
      const parentSignal = {
        get aborted() { return controller.signal.aborted; },
        addEventListener(...args) { attached++; controller.signal.addEventListener(...args); },
        removeEventListener(...args) { detached++; controller.signal.removeEventListener(...args); }
      };
      client.init({ enabled: true, routes: FULL_ROUTES, fetchImpl: async () => ({
        ok: true, json: () => {
          controller.abort(new Error("run was stopped"));
          return new Promise(() => {});
        }
      }) });
      const res = await client.chat({ route: "json", messages: [], signal: parentSignal,
        byok: byok ? { provider: "deepseek", apiKey: "test-key" } : undefined });
      assert.strictEqual(res.cancelled, true);
      assert.strictEqual(res.timedOut, false);
      assert.strictEqual(attached, detached);
      assert.strictEqual(client._debugState().breakers.json.failCount, 0);
    });
  }

  await check("a late body cannot record spend or success after the deadline", async () => {
    let complete;
    client.init({ enabled: true, routes: FULL_ROUTES, fetchImpl: async () => ({
      ok: true, json: () => new Promise(resolve => { complete = resolve; })
    }) });
    const res = await client.chat({ route: "json", messages: [], timeoutMs: 10 });
    complete({ choices: [{ message: { role: "assistant", content: "late" } }], usage: { completion_tokens: 10000 } });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(res.timedOut, true);
    assert.strictEqual(client.monthSpend("json"), 0);
    assert.strictEqual(client._debugState().breakers.json.failCount, 1);
  });

  console.log("\n── DeepSeek wire contract ──────────────────────────");

  await check("thinking and its effort reach DeepSeek in both shared and BYOK calls", async () => {
    for (const byok of [false, true]) {
      const sent = [];
      client.init({ enabled: true, routes: FULL_ROUTES, fetchImpl: async (url, opts) => {
        sent.push(JSON.parse(opts.body));
        return okFetch()();
      } });
      const req = { route: "json", model: "deepseek-v4-pro", messages: [], thinking: true,
        reasoningEffort: "max", toolChoice: "required",
        byok: byok ? { provider: "deepseek", apiKey: "test-key", model: "deepseek-v4-pro" } : undefined };
      assert.strictEqual((await client.chat(req)).ok, true);
      assert.deepStrictEqual(sent[0].thinking, { type: "enabled" });
      assert.strictEqual(sent[0].reasoning_effort, "max");
      assert.strictEqual(sent[0].tool_choice, "auto");
      assert.strictEqual(sent[0].temperature, undefined);
      await client.chat({ ...req, thinking: false });
      assert.deepStrictEqual(sent[1].thinking, { type: "disabled" });
      assert.strictEqual(sent[1].reasoning_effort, undefined);
      assert.strictEqual(sent[1].tool_choice, "required");
    }
  });

  await check("DeepSeek default thinking avoids forced tools and canonicalizes effort aliases", async () => {
    const sent = [];
    client.init({ enabled: true, routes: FULL_ROUTES, fetchImpl: async (url, opts) => {
      sent.push(JSON.parse(opts.body)); return okFetch()();
    } });
    await client.chat({ route: "json", model: "deepseek-flash", messages: [], toolChoice: { type: "function", function: { name: "write_file" } } });
    assert.strictEqual(sent[0].tool_choice, "auto");
    for (const [effort, canonical] of [["minimal", "low"], ["medium", "high"], ["xhigh", "high"], ["ultra", "max"]]) {
      await client.chat({ route: "json", model: "deepseek-flash", messages: [], reasoningEffort: effort });
      assert.strictEqual(sent.at(-1).reasoning_effort, canonical);
    }
  });

  await check("invalid DeepSeek effort and thinking fail before billing or breaker changes", async () => {
    let calls = 0;
    client.init({ enabled: true, routes: FULL_ROUTES, fetchImpl: async () => { calls++; return okFetch()(); } });
    for (const invalid of [{ reasoningEffort: "bogus" }, { reasoningEffort: "__proto__" }, { thinking: "enabled" }]) {
      const res = await client.chat({ route: "json", model: "deepseek-flash", messages: [], ...invalid });
      assert.strictEqual(res.badRequest, true);
    }
    assert.strictEqual(calls, 0);
    assert.strictEqual(client._debugState().breakers.json.failCount, 0);
  });

  await check("DeepSeek parameters never leak into other providers", async () => {
    let body;
    client.init({ enabled: true, routes: FULL_ROUTES, fetchImpl: async (url, opts) => {
      body = JSON.parse(opts.body); return okFetch()();
    } });
    await client.chat({ route: "json", messages: [], thinking: true, reasoningEffort: "max", toolChoice: "required" });
    assert.strictEqual(body.thinking, undefined);
    assert.strictEqual(body.reasoning_effort, undefined);
    assert.strictEqual(body.tool_choice, "required");
  });

  await check("reasoning is preserved and counted when a tool continuation replays it", async () => {
    const message = { role: "assistant", content: "", reasoning_content: "r".repeat(900), tool_calls: [] };
    client.init({ enabled: true, routes: FULL_ROUTES, fetchImpl: async () => ({
      ok: true, json: async () => ({ choices: [{ message, finish_reason: "length" }], usage: {} })
    }) });
    const res = await client.chat({ route: "json", messages: [] });
    assert.strictEqual(res.message.reasoning_content, message.reasoning_content);
    assert.strictEqual(res.finishReason, "length");
    const without = { ...message }; delete without.reasoning_content;
    assert.strictEqual(client.estimateTokens([message], []) - client.estimateTokens([without], []), 300);
    assert.strictEqual(client.estimateTokens([message]), client.estimateTokens([without]));
  });

  await check("a malformed successful response is a provider error with usage still accounted", async () => {
    client.init({ enabled: true, routes: FULL_ROUTES, fetchImpl: async () => ({
      ok: true, json: async () => ({ choices: [], usage: { completion_tokens: 1000 } })
    }) });
    const res = await client.chat({ route: "json", messages: [] });
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /no completion message/);
    assert.ok(res.costUsd > 0);
    assert.ok(client.monthSpend("json") > 0);
  });

  console.log("\n── Anthropic BYOK cancellation ─────────────────────");
  const sdkPath = require.resolve("@anthropic-ai/sdk");
  const anthropicPath = require.resolve("../lib/ai/anthropic");
  const originalSdk = require.cache[sdkPath];
  const originalAnthropic = require.cache[anthropicPath];
  let sdkSignal, onFinalMessage;
  class FakeAnthropic {
    constructor() {
      this.messages = { stream(body, opts) {
        sdkSignal = opts.signal;
        return { finalMessage: () => onFinalMessage() };
      } };
    }
  }
  require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: FakeAnthropic };
  delete require.cache[anthropicPath];
  try {
    await check("Anthropic streamed body obeys the total timeout", async () => {
      onFinalMessage = () => new Promise(() => {});
      const res = await client.chat({ messages: [], timeoutMs: 20, byok: { provider: "claude", apiKey: "fake" } });
      assert.strictEqual(res.timedOut, true);
      assert.strictEqual(res.cancelled, false);
      assert.strictEqual(sdkSignal.aborted, true);
    });
    await check("Anthropic receives the run signal and reports cancellation distinctly", async () => {
      const controller = new AbortController();
      onFinalMessage = () => { controller.abort(); return new Promise(() => {}); };
      const res = await client.chat({ messages: [], signal: controller.signal, byok: { provider: "claude", apiKey: "fake" } });
      assert.strictEqual(res.cancelled, true);
      assert.strictEqual(res.timedOut, false);
      assert.strictEqual(sdkSignal.aborted, true);
    });
  } finally {
    if (originalSdk) require.cache[sdkPath] = originalSdk; else delete require.cache[sdkPath];
    if (originalAnthropic) require.cache[anthropicPath] = originalAnthropic; else delete require.cache[anthropicPath];
  }

  console.log("\n── observability hook ──────────────────────────────");

  await check("recordSpend hook fires with (route, usd) on every successful call", async () => {
    const seen = [];
    client.init({ enabled: true, fetchImpl: okFetch(), recordSpend: (route, usd) => seen.push({ route, usd }), routes: FULL_ROUTES });
    await client.chat({ route: "prose", messages: [] });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].route, "prose");
  });

  console.log("\n── streaming ───────────────────────────────────────");

  /* A streamed answer must be indistinguishable from a whole one by the
     time it leaves this module. Everything downstream reads
     choices[0].message and usage, and it should not be able to tell which
     transport produced them. */
  function sseFetch(frames, opts) {
    const body = frames.map((f) => "data: " + (typeof f === "string" ? f : JSON.stringify(f)) + "\n\n").join("") +
      "data: [DONE]\n\n";
    return async (url, init) => {
      if (opts && opts.captureBody) opts.captureBody(JSON.parse(init.body));
      if (opts && opts.asText) return { ok: true, text: async () => body };
      // Split at an awkward place on purpose: a frame that arrives in two
      // TCP chunks is the normal case, not the exceptional one.
      const bytes = new TextEncoder().encode(body);
      const cut = Math.floor(bytes.length / 3);
      const parts = [bytes.slice(0, cut), bytes.slice(cut, cut * 2), bytes.slice(cut * 2)];
      let i = 0;
      return {
        ok: true,
        body: { getReader: () => ({ read: async () => (i < parts.length ? { done: false, value: parts[i++] } : { done: true }) }) }
      };
    };
  }

  const textFrames = [
    { choices: [{ delta: { role: "assistant", content: "Look" } }] },
    { choices: [{ delta: { content: "ing at " } }] },
    { choices: [{ delta: { content: "the code." }, finish_reason: "stop" }] },
    { usage: { prompt_tokens: 100, completion_tokens: 50 } }
  ];

  await check("a streamed reply reassembles into the same shape as a whole one", async () => {
    client.init({ enabled: true, fetchImpl: sseFetch(textFrames), routes: FULL_ROUTES });
    const res = await client.chat({ route: "prose", messages: [{ role: "user", content: "hi" }], stream: true });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.message.content, "Looking at the code.");
    assert.strictEqual(res.message.role, "assistant");
    assert.strictEqual(res.finishReason, "stop");
    assert.deepStrictEqual(res.usage, { prompt_tokens: 100, completion_tokens: 50 });
    assert.ok(res.costUsd > 0, "a streamed call must still be costed, or the budget guard is blind");
  });

  await check("the request asks for usage, or every streamed call looks free", async () => {
    let sent = null;
    client.init({ enabled: true, fetchImpl: sseFetch(textFrames, { captureBody: (b) => { sent = b; } }), routes: FULL_ROUTES });
    await client.chat({ route: "prose", messages: [{ role: "user", content: "hi" }], stream: true });
    assert.strictEqual(sent.stream, true);
    assert.deepStrictEqual(sent.stream_options, { include_usage: true });
  });

  await check("not asking for a stream still sends no stream fields", async () => {
    let sent = null;
    client.init({
      enabled: true, routes: FULL_ROUTES,
      fetchImpl: async (url, init) => {
        sent = JSON.parse(init.body);
        return { ok: true, json: async () => ({ choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: {} }) };
      }
    });
    const res = await client.chat({ route: "prose", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(res.ok, true);
    assert.ok(!("stream" in sent) || sent.stream === undefined);
    assert.ok(!("stream_options" in sent) || sent.stream_options === undefined);
  });

  await check("text arrives as it is generated, not all at the end", async () => {
    const seen = [];
    client.init({ enabled: true, fetchImpl: sseFetch(textFrames), routes: FULL_ROUTES });
    const res = await client.chat({
      route: "prose", messages: [{ role: "user", content: "hi" }], stream: true,
      onDelta: (d) => { if (d.textDelta) seen.push(d.textDelta); }
    });
    assert.ok(seen.length >= 3, "expected several deltas, got " + seen.length);
    assert.strictEqual(seen.join(""), res.message.content);
  });

  await check("tool calls split across frames are stitched back together", async () => {
    // How a real provider sends them: id and name first, then the
    // arguments in fragments, interleaved across two parallel calls.
    client.init({
      enabled: true, routes: FULL_ROUTES,
      fetchImpl: sseFetch([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "write_file", arguments: "" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "read_file", arguments: "" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"src/' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"path":"src/b' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'a.tsx","content":"x"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '.tsx"}' } }] }, finish_reason: "tool_calls" }] },
        { usage: { prompt_tokens: 10, completion_tokens: 5 } }
      ])
    });
    const names = [];
    const res = await client.chat({
      route: "prose", messages: [{ role: "user", content: "hi" }], stream: true,
      onDelta: (d) => { if (d.toolName) names.push(d.toolName); }
    });
    assert.strictEqual(res.finishReason, "tool_calls");
    assert.strictEqual(res.message.tool_calls.length, 2);
    const [a, b] = res.message.tool_calls;
    assert.strictEqual(a.id, "call_a");
    assert.strictEqual(a.function.name, "write_file");
    assert.deepStrictEqual(JSON.parse(a.function.arguments), { path: "src/a.tsx", content: "x" });
    assert.strictEqual(b.id, "call_b");
    assert.deepStrictEqual(JSON.parse(b.function.arguments), { path: "src/b.tsx" });
    // The name is the part worth announcing: it arrives before twenty
    // seconds of argument generation, not after.
    assert.deepStrictEqual(names, ["write_file", "read_file"]);
  });

  await check("a tool call cut off before it was named is dropped, not dispatched", async () => {
    client.init({
      enabled: true, routes: FULL_ROUTES,
      fetchImpl: sseFetch([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "write_file", arguments: '{"path":"src/a.tsx","content":"x"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", type: "function", function: { arguments: '{"pa' } }] }, finish_reason: "length" }] }
      ])
    });
    const res = await client.chat({ route: "prose", messages: [{ role: "user", content: "hi" }], stream: true });
    assert.strictEqual(res.message.tool_calls.length, 1,
      "a nameless fragment is half of something the model never finished saying");
    assert.strictEqual(res.finishReason, "length", "the caller is still told it was truncated");
  });

  await check("a buffered stream with no readable body still parses", async () => {
    // Some proxies hand over the whole thing at once; the frames are the same.
    client.init({ enabled: true, fetchImpl: sseFetch(textFrames, { asText: true }), routes: FULL_ROUTES });
    const res = await client.chat({ route: "prose", messages: [{ role: "user", content: "hi" }], stream: true });
    assert.strictEqual(res.message.content, "Looking at the code.");
  });

  await check("keepalives and junk frames are skipped rather than throwing", async () => {
    client.init({
      enabled: true, routes: FULL_ROUTES,
      fetchImpl: sseFetch([": keepalive", "not json at all", { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }])
    });
    const res = await client.chat({ route: "prose", messages: [{ role: "user", content: "hi" }], stream: true });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.message.content, "ok");
  });

  await check("an onDelta that throws does not break the call", async () => {
    client.init({ enabled: true, fetchImpl: sseFetch(textFrames), routes: FULL_ROUTES });
    const res = await client.chat({
      route: "prose", messages: [{ role: "user", content: "hi" }], stream: true,
      onDelta: () => { throw new Error("the watcher is broken"); }
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.message.content, "Looking at the code.");
  });

  await check("a reasoning trace is kept off the visible stream", async () => {
    const seen = [];
    client.init({
      enabled: true, routes: FULL_ROUTES,
      fetchImpl: sseFetch([
        { choices: [{ delta: { reasoning_content: "the user probably wants..." } }] },
        { choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] }
      ])
    });
    const res = await client.chat({
      route: "prose", messages: [{ role: "user", content: "hi" }], stream: true,
      onDelta: (d) => { if (d.textDelta) seen.push(d.textDelta); }
    });
    assert.strictEqual(seen.join(""), "Done.", "a private reasoning trace must not be streamed to anyone");
    assert.strictEqual(res.message.reasoning_content, "the user probably wants...");
  });

  /* A stream that is still delivering is answering. The deadline used to
     be a single total, so a model that streamed for ninety seconds was
     killed and reported as not having answered. */
  function dripFetch(chunks, gapMs) {
    return async () => {
      let i = 0;
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => {
              if (i >= chunks.length) return { done: true };
              await new Promise((r) => setTimeout(r, gapMs));
              return { done: false, value: new TextEncoder().encode(chunks[i++]) };
            }
          })
        }
      };
    };
  }

  await check("a slow but steady stream is not killed by the total deadline", async () => {
    // Six chunks 120ms apart is 720ms of delivery against a 300ms
    // timeoutMs — under the old single clock this was a timeout.
    const frames = [
      'data: {"choices":[{"delta":{"content":"one "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"two "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"three "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"four "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"five"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ];
    client.init({ enabled: true, fetchImpl: dripFetch(frames, 120), routes: FULL_ROUTES });
    const res = await client.chat({
      route: "prose", messages: [{ role: "user", content: "hi" }], stream: true,
      timeoutMs: 300, stallMs: 2000, hardMs: 10000
    });
    assert.strictEqual(res.ok, true, "a steady stream was killed: " + res.reason);
    assert.strictEqual(res.message.content, "one two three four five");
  });

  await check("a stream that goes silent is a stall, and says so", async () => {
    client.init({
      enabled: true, routes: FULL_ROUTES,
      fetchImpl: async () => ({
        ok: true,
        body: {
          getReader: () => {
            let sent = false;
            return {
              read: async () => {
                if (!sent) { sent = true; return { done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"start"}}]}\n\n') }; }
                await new Promise(() => {});   // never speaks again
              }
            };
          }
        }
      })
    });
    const res = await client.chat({
      route: "prose", messages: [{ role: "user", content: "hi" }], stream: true,
      timeoutMs: 5000, stallMs: 250, hardMs: 10000
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.stalled, true);
    assert.ok(/stopped sending/.test(res.reason), "got: " + res.reason);
    assert.ok(!res.ranOutOfTime, "a stall is retryable; running out of run time is not");
  });

  await check("the hard ceiling still bounds a stream that never stops", async () => {
    // Re-arming the stall clock for ever must not mean running for ever.
    const frames = new Array(200).fill('data: {"choices":[{"delta":{"content":"."}}]}\n\n');
    client.init({ enabled: true, fetchImpl: dripFetch(frames, 20), routes: FULL_ROUTES });
    const t0 = Date.now();
    const res = await client.chat({
      route: "prose", messages: [{ role: "user", content: "hi" }], stream: true,
      timeoutMs: 5000, stallMs: 5000, hardMs: 400
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.ranOutOfTime, true, "got: " + res.reason);
    assert.ok(/ran out of time/.test(res.reason), "got: " + res.reason);
    assert.ok(Date.now() - t0 < 3000, "the ceiling did not bound it");
  });

  await check("without the new clocks the old single deadline is unchanged", async () => {
    client.init({ enabled: true, fetchImpl: hangingFetch(5000), routes: FULL_ROUTES });
    const res = await client.chat({ route: "prose", messages: [{ role: "user", content: "hi" }], timeoutMs: 200 });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.timedOut, true);
    assert.ok(/timed out after 200ms/.test(res.reason), "got: " + res.reason);
    assert.ok(!res.stalled && !res.ranOutOfTime);
  });

  await check("a gateway that ignores the stream flag is still answered", async () => {
    /* OpenAI-compatible gateways do ignore it and return a whole
       completion. Returning an empty message because the transport was
       not the one we asked for would turn a working provider into a
       silent failure. */
    let called = 0;
    client.init({
      enabled: true, routes: FULL_ROUTES,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { role: "assistant", content: "whole answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
      })
    });
    const res = await client.chat({
      route: "prose", messages: [{ role: "user", content: "hi" }], stream: true,
      onDelta: () => { called++; }
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.message.content, "whole answer");
    assert.strictEqual(called, 0, "nothing streamed, so nothing should have been announced as streaming");
  });

  await check("a streamed error is still an error, not a parse failure", async () => {
    client.init({
      enabled: true, routes: FULL_ROUTES,
      fetchImpl: async () => ({ ok: false, status: 402, json: async () => ({ error: { message: "Insufficient Balance" } }) })
    });
    const res = await client.chat({ route: "prose", messages: [{ role: "user", content: "hi" }], stream: true });
    assert.strictEqual(res.ok, false);
    assert.ok(/402/.test(res.reason));
    assert.strictEqual(res.badRequest, true, "a 402 is not a provider outage");
  });

  console.log("\n" + (failed === 0 ? "✓ ALL AI CLIENT TESTS PASSED (" + passed + ")" : "✗ " + failed + " FAILED, " + passed + " passed"));
  process.exit(failed === 0 ? 0 : 1);
})();
