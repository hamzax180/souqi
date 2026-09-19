/* =================================================================
   ai/client.js — one adapter, two providers, routed by task
   -----------------------------------------------------------------
   docs/AI-PROVIDER-PLAN.md §3 split this by WHO the output is for, with
   prose and vision on Gemini for its multilingual range. EVERY ROUTE IS
   DEEPSEEK NOW, by decision, until that is revisited:

     • "prose"  -> deepseek-flash. Replies, plan cards, the assessor.
     • "json"   -> deepseek-flash, or deepseek-v4-pro on the upper effort
       levels. Tool calls and write_file rounds; judged on structured
       output, and the prefix cache makes the long system prompt cheap.
     • "vision" -> deepseek-flash, which does read images — verified
       against the live API, where it described a logo correctly while
       deepseek-v4-pro answered "NO IMAGE" to the same picture.

   The three-route SHAPE is kept rather than collapsed, because it is
   what makes going back a configuration change: each route still has
   its own base URL, model, key, breaker and spend line, so pointing
   prose at another provider is three environment variables and no code.

   Everything speaks the OpenAI chat-completions shape, so this is one
   HTTP client and a routing table — nothing else in the codebase is
   allowed to know a provider's name or URL.

   OFF BY DEFAULT: `init()` with no AI_ENABLED=1 in the environment
   makes every call return {ok:false, disabled:true} instantly, no
   network touched. That is the acceptance criterion for this module —
   every existing deterministic path must be provably unaffected by
   its presence (§0, "off by default").

   Every failure degrades to a return value the caller can act on.
   Nothing here throws for an ordinary operational failure (timeout,
   5xx, breaker open, budget spent) — those are correctness Mode, not
   exceptions, because a model being unavailable is not a bug.
   ================================================================= */
"use strict";

const DEFAULT_TIMEOUT_MS = 6000;
const BREAKER_FAILURE_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 10 * 60 * 1000;

// Approximate $/1M tokens. VERIFY AGAINST CURRENT RATE CARDS before relying
// on this for real budgeting — both providers move these. Used only to
// produce an estimated costUsd on each call for the budget guard and for
// observability (docs/AI-PROVIDER-PLAN.md §7); never billed against directly.
const PRICING = {
  /* All three are DeepSeek now, so all three carry DeepSeek's rate.
     prose was billed at Gemini's $0.75/$3.75 while running DeepSeek, which
     over-counted every reply and plan card by roughly 3x — and this table
     feeds the budget guard, so the effect was a monthly cap that tripped
     early on spend that had not happened. */
  prose: { inputPerM: 0.27, inputCachedPerM: 0.07, outputPerM: 1.10 },
  json: { inputPerM: 0.27, inputCachedPerM: 0.07, outputPerM: 1.10 },
  /* Same rate again. An image is billed as input tokens — a photo is worth
     a few hundred to a couple of thousand depending on resolution, which is
     the real reason the client downscales before upload, not just transfer
     time. Verify against the current rate card before trusting any of this
     for real budgeting. */
  vision: { inputPerM: 0.27, inputCachedPerM: 0.07, outputPerM: 1.10 }
};

/* Context windows, in tokens, by model-id substring — first match wins.
 *
 * Same caveat as PRICING above: these are vendor facts that move, and there
 * is no endpoint that reports them, so they have to live somewhere. A route
 * can override its own with AI_<ROUTE>_CONTEXT_TOKENS, which is the thing to
 * reach for when a provider raises a window and this table has not caught up
 * — no code change, no redeploy of a constant.
 *
 * Wrong-but-low is safe here and wrong-but-high is not: too low trims a few
 * files that read_file can fetch back, too high is a 400 and a starter
 * template in someone's face. The unknown default is deliberately pessimistic
 * for the same reason.
 */
const CONTEXT_WINDOWS = [
  /* MEASURED, not looked up. A single request to api.deepseek.com was accepted
     with prompt_tokens 400,031, and both deepseek-flash and deepseek-v4-pro
     report a valid max_tokens range of [1, 393216]. The 65,536 that was here
     was a remembered figure for deepseek-chat, and it was wrong by more than
     6x — which made codeBudgetChars hand the model a fraction of the codebase
     it could actually have read, on every single build.
     Held at the measured floor rather than a guessed ceiling: 400k is proven,
     anything above it is not, and this is the number a 400 depends on. */
  [/deepseek/i, 400000],
  /* Kept even though no route points at Gemini any more: this table is keyed
     on the MODEL id, not the route, so it is still the right answer for
     anyone who brings their own Gemini key through BYOK. Removing it would
     drop those callers to the pessimistic unknown default. */
  [/gemini/i, 1048576],
  [/gpt-4o|gpt-4\.1|o[34]-/i, 128000],
  [/claude/i, 200000]
];
const UNKNOWN_CONTEXT_TOKENS = 32768;

/* Chars per token, used to size a request before sending it.
 *
 * 3.0 is below every real measurement for this traffic (English prose runs
 * ~4, TypeScript and JSX ~3.2-3.6) and that is the point: this number decides
 * whether a request is sent, so it must over-count tokens rather than under.
 * Guessing high costs a file that read_file can ask for; guessing low costs
 * the whole build. */
const CHARS_PER_TOKEN = 3.0;

/* Per-message protocol overhead: role, delimiters, and for a tool call the
 * id and function envelope. OpenAI's own guidance is ~4; tool traffic here
 * carries more, and this is padding, so 8. */
const MESSAGE_OVERHEAD_TOKENS = 8;

let CONFIG = null;
const breakers = {}; // route -> { failCount, openUntil }
let spend = {};       // "YYYY-MM" -> route -> usd  (in-memory; see recordSpend hook)

function monthKey(d) {
  const dt = d || new Date();
  return dt.getUTCFullYear() + "-" + String(dt.getUTCMonth() + 1).padStart(2, "0");
}

function routeFromEnv(env, prefix) {
  return {
    baseUrl: env[prefix + "_BASE_URL"] || "",
    model: env[prefix + "_MODEL"] || "",
    key: env[prefix + "_KEY"] || "",
    // Escape hatch for a window this build's table does not know about.
    contextTokens: Number(env[prefix + "_CONTEXT_TOKENS"]) || 0
  };
}

function visionRouteFromEnv(env) {
  const custom = routeFromEnv(env, "AI_VISION");
  if (custom.key && custom.baseUrl && custom.model) return custom;
  // Fall back to deepseek-flash using the configured prose or json credentials
  const prose = routeFromEnv(env, "AI_PROSE");
  const fallbackKey = custom.key || prose.key || env.AI_JSON_KEY || "";
  const fallbackBaseUrl = custom.baseUrl || prose.baseUrl || env.AI_JSON_BASE_URL || "";
  const fallbackModel = custom.model || "deepseek-flash";
  return {
    baseUrl: fallbackBaseUrl,
    model: fallbackModel,
    key: fallbackKey,
    contextTokens: custom.contextTokens || prose.contextTokens || 0
  };
}

/**
 * The context window a call on this route will actually get, in tokens.
 *
 * Takes the model explicitly because tiering passes one per call — an eco
 * build and a power build share a route and differ only in that string, and
 * they need not share a window.
 */
function windowFor(route, model) {
  ensureInit();
  const r = (CONFIG.routes || {})[resolveRoute(route)] || {};
  if (r.contextTokens) return r.contextTokens;
  const id = String(model || r.model || "");
  for (const [re, n] of CONTEXT_WINDOWS) if (re.test(id)) return n;
  return UNKNOWN_CONTEXT_TOKENS;
}

/**
 * A deliberately pessimistic token count for a request.
 *
 * No tokenizer, on purpose: adding one means a native dependency and a model
 * -specific vocabulary for every provider, to refine a number whose only job
 * is to keep a request under a ceiling. A conservative ratio plus real
 * padding does that job, and cannot be wrong in the direction that hurts.
 */
function estimateTokens(messages, tools) {
  let chars = 0, count = 0;
  for (const m of messages || []) {
    count++;
    if (typeof m.content === "string") chars += m.content.length;
    else if (Array.isArray(m.content)) {
      // Vision turns: text parts measured, image parts charged a flat rate
      // because their cost is resolution-driven and not in this string.
      for (const part of m.content) {
        if (part && typeof part.text === "string") chars += part.text.length;
        else if (part && part.type === "image_url") chars += 1200 * CHARS_PER_TOKEN;
      }
    }
    // Tool calls live beside content, not in it, and carry the whole file
    // the model just wrote — the single biggest thing this has to measure.
    for (const c of m.tool_calls || []) {
      chars += String((c.function && c.function.arguments) || "").length +
               String((c.function && c.function.name) || "").length;
    }
    // DeepSeek replays reasoning alongside tool exchanges. Ignoring it here
    // let a seemingly small continuation overflow after several tool rounds.
    if (tools && typeof m.reasoning_content === "string") chars += m.reasoning_content.length;
  }
  if (tools) chars += JSON.stringify(tools).length;
  return Math.ceil(chars / CHARS_PER_TOKEN) + count * MESSAGE_OVERHEAD_TOKENS;
}

/**
 * @param {object} [overrides]
 * @param {boolean} [overrides.enabled]
 * @param {number} [overrides.budgetUsd]
 * @param {Function} [overrides.fetchImpl]   injection point for tests — never hits the network when supplied
 * @param {Function} [overrides.recordSpend] (route, usd) => void — plug in the audit collection later; defaults to in-memory
 * @param {object} [overrides.routes]        { prose: {baseUrl,model,key}, json: {...} } — overrides env for tests
 */
/* Last shared total read out of the store, and when.

   budgetExceeded runs on every single call, so it cannot pay a database
   round trip each time. It reads through this, refreshed at most once a
   SHARED_TTL_MS — a few seconds of staleness against a monthly budget is
   a rounding error, and the write path below keeps it moving in between
   so the number never sits still while money is being spent. */
let sharedTotal = null;
let sharedAt = 0;
const SHARED_TTL_MS = 10000;

function init(overrides) {
  const o = overrides || {};
  const env = process.env;
  CONFIG = {
    enabled: (o.enabled !== null && o.enabled !== undefined) ? o.enabled : env.AI_ENABLED === "1",
    budgetUsd: Number((o.budgetUsd !== null && o.budgetUsd !== undefined) ? o.budgetUsd : (env.AI_MONTHLY_BUDGET_USD || 0)),
    fetchImpl: o.fetchImpl || globalThis.fetch,
    recordSpendHook: o.recordSpend || null,
    /* Shared, durable spend. See the note on budgetExceeded. */
    spendStore: o.spendStore || null,
    routes: {
      prose: (o.routes && o.routes.prose) || routeFromEnv(env, "AI_PROSE"),
      json: (o.routes && o.routes.json) || routeFromEnv(env, "AI_JSON"),
      /* "vision" defaults to deepseek-flash when custom AI_VISION is unset */
      vision: (o.routes && o.routes.vision) || visionRouteFromEnv(env)
    }
  };
  for (const r of Object.keys(CONFIG.routes)) breakers[r] = { failCount: 0, openUntil: 0 };
  spend = {};
  /* The shared total belongs to the store that was just replaced, so it
     goes with it. Leaving it behind meant a reconfigured client answered
     from the previous store's numbers until the cache aged out — which
     is exactly how the "a second process sees the first one's spend"
     test first passed against a stale total instead of a real read. */
  sharedTotal = null;
  sharedAt = 0;
  return CONFIG;
}

function ensureInit() {
  if (!CONFIG) init(); // reads real env on first use — same as any other lazily-configured module here
}

function configured(r) { return !!(r && r.key && r.baseUrl && r.model); }

/**
 * Which route actually SERVES a request for `route`.
 *
 * prose and json are a cost-and-quality preference, not a capability split:
 * both are OpenAI-shaped chat endpoints and either model can do either job.
 * When only one was configured the other role just returned {disabled:true},
 * and every caller of it fell back — assessPrompt failed open to "build", so
 * the agent could only ever build and never hold a conversation, and every
 * plan card came from fallbackPlan(). One unset key turned the conversational
 * half of the product off with nothing logged and no error to notice.
 *
 * Answering from whichever route IS configured is strictly better than not
 * answering. The breaker, the budget and the spend all follow the route that
 * did the work, not the one that was asked for, so the accounting stays
 * honest about which provider was actually billed.
 */
function resolveRoute(route) {
  if (configured(CONFIG.routes[route])) return route;
  /* VISION NEVER FALLS BACK, and it is the one exception to everything the
     comment above argues.

     That reasoning — answering from whichever route is configured beats not
     answering — holds when the routes differ in cost and temperament but can
     both do the job. Vision is not that, and the reason is not the one that
     used to be written here.

     It said both other routes were text-only. That is no longer true now
     that everything is DeepSeek: prose is deepseek-flash, which reads images
     perfectly well. But json is not always — the upper effort levels run
     deepseek-v4-pro, which answered "NO IMAGE" to a picture deepseek-flash
     described correctly. So a fallback would be right some of the time and
     silently wrong the rest, depending on which effort level the person
     happened to pick.

     And the failure is the bad kind. A model that cannot see does not
     decline: it writes a fluent description of a photo it never received,
     which is then cached on the upload row and used to place that photo in
     someone's website. A confident invention is far worse than an honest
     blank, and unlike a missing plan card there is nothing downstream that
     could notice.

     Returning the unconfigured route makes configured() fail below and the
     caller degrade on purpose. */
  if (route === "vision") return route;
  const alt = route === "prose" ? "json" : "prose";
  return configured(CONFIG.routes[alt]) ? alt : route;
}

/**
 * Does this status mean the PROVIDER is in trouble, or that WE sent a bad
 * request?
 *
 * The breaker exists to stop hammering a provider that is struggling, and to
 * fail fast instead of making every user wait out a timeout. Neither purpose
 * is served by a 400. A 400 is our own request being wrong — too many tokens,
 * a malformed body, a parameter the model does not take — and it says nothing
 * at all about whether the next, different request will succeed.
 *
 * Counting them was doing real damage. An oversized build request returns 400
 * instantly, costs the provider nothing, and used to advance the same counter
 * as an outage: five large projects in a row opened the json route's breaker
 * for ten minutes FOR EVERY USER, and the builds that got turned away were
 * turned away with "circuit breaker open" — a message about a provider that
 * was, the whole time, perfectly healthy.
 *
 * 429 counts despite being a 4xx: rate limiting is the provider telling us to
 * back off, and backing off is exactly what the breaker does.
 *
 * 401/403/404 do not count. They are configuration — a revoked key, a model
 * that no longer exists — and they are cheap to receive and persistent, so
 * there is no herd to protect anyone from. Letting the real status surface on
 * every call keeps the error legible; behind an open breaker the operator
 * reads "breaker open" and never learns the key was rejected.
 */
function countsAsProviderFailure(status) {
  if (!status) return true;          // network error, abort, no response at all
  if (status === 429) return true;   // "slow down" — the one 4xx worth backing off for
  return status >= 500;
}

function recordFailure(route) {
  const b = breakers[route];
  b.failCount += 1;
  if (b.failCount >= BREAKER_FAILURE_THRESHOLD) b.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
}
function recordSuccess(route) {
  breakers[route] = { failCount: 0, openUntil: 0 };
}
function breakerOpen(route) {
  const b = breakers[route];
  return !!(b && b.openUntil && Date.now() < b.openUntil);
}

function recordSpend(route, usd) {
  const k = monthKey();
  spend[k] = spend[k] || {};
  spend[k][route] = (spend[k][route] || 0) + usd;
  if (CONFIG.recordSpendHook) { try { CONFIG.recordSpendHook(route, usd); } catch (e) { /* observability must never break the call */ } }
  if (CONFIG.spendStore && usd > 0) {
    /* Moved immediately rather than waiting for the next refresh, so a
       burst inside one TTL window still counts against the budget. */
    if (sharedTotal !== null) sharedTotal += usd;
    try {
      const p = CONFIG.spendStore.add(k, route, usd);
      if (p && p.catch) p.catch(() => { /* metering must never break the call */ });
    } catch (e) { /* same */ }
  }
}
function monthSpend(route) {
  const k = monthKey();
  return (spend[k] && spend[k][route]) || 0;
}
/* THE BUDGET HAS TO BE COUNTED SOMEWHERE BOTH PROCESSES CAN SEE.

   This used to sum the in-memory `spend` map, and nothing ever plugged
   the recordSpend hook in — the docstring on init still called it
   "plug in the audit collection later". So the monthly cap was counted
   per process, in a Map that dies with the lambda. Production is Vercel:
   many instances at once, recycled constantly, each starting again at
   zero. AI_MONTHLY_BUDGET_USD was a number in the environment and
   nothing else.

   This is the same failure middleware/rateLimit.js documents at length
   and already fixed for request limits, and the fix is the same shape:
   a store the whole deployment shares, with the in-memory map left
   underneath it for local runs and for the moments the store is down.

   Unavailable store falls back to THIS process's own total rather than
   to zero. A budget breaker that opens the floodgates the moment its
   database blinks is worse than one that is briefly too strict, and
   unlike a rate limiter the thing on the other side of it is money. */
function budgetExceeded(route) {
  if (!CONFIG.budgetUsd || CONFIG.budgetUsd <= 0) return false;
  // Budget is a whole-adapter guard (docs/AI-PROVIDER-PLAN.md §6 "monthly
  // budget hit"), not per-route — one runaway route shouldn't get a full
  // budget's worth of headroom just because another route stayed quiet.
  const local = Object.keys(CONFIG.routes).reduce((sum, r) => sum + monthSpend(r), 0);
  const total = (CONFIG.spendStore && sharedTotal !== null) ? Math.max(sharedTotal, local) : local;
  return total >= CONFIG.budgetUsd;
}

/* Pulled on a timer by chat(), never awaited by the caller on the hot
   path. Returns the shared total so a caller can prime it at boot. */
async function refreshSharedSpend(force) {
  if (!CONFIG || !CONFIG.spendStore) return null;
  if (!force && sharedTotal !== null && Date.now() - sharedAt < SHARED_TTL_MS) return sharedTotal;
  try {
    const t = await CONFIG.spendStore.total(monthKey());
    if (typeof t === "number" && isFinite(t) && t >= 0) { sharedTotal = t; sharedAt = Date.now(); }
  } catch (e) {
    /* Leave the last known total in place. Dropping to null here would
       silently reopen the budget until the next successful read. */
    sharedAt = Date.now();
  }
  return sharedTotal;
}

function estimateCost(route, usage) {
  const p = PRICING[route];
  if (!p || !usage) return 0;
  const outTok = usage.completion_tokens || 0;
  let inCost;
  const hasCacheBreakdown = (usage.prompt_cache_hit_tokens !== null && usage.prompt_cache_hit_tokens !== undefined) ||
    (usage.prompt_cache_miss_tokens !== null && usage.prompt_cache_miss_tokens !== undefined);
  if (p.inputCachedPerM && hasCacheBreakdown) {
    const hit = usage.prompt_cache_hit_tokens || 0;
    const miss = usage.prompt_cache_miss_tokens || 0;
    inCost = (hit / 1e6) * p.inputCachedPerM + (miss / 1e6) * p.inputPerM;
  } else {
    inCost = ((usage.prompt_tokens || 0) / 1e6) * p.inputPerM;
  }
  const outCost = (outTok / 1e6) * p.outputPerM;
  return inCost + outCost;
}

function requestScope(req) {
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(req.timeoutMs) && req.timeoutMs > 0
    ? Math.min(req.timeoutMs, 2147483647) : DEFAULT_TIMEOUT_MS;
  let stoppedBy = null;
  const stop = (cause) => {
    if (stoppedBy) return;
    stoppedBy = cause;
    controller.abort();
  };
  const onParentAbort = () => stop("cancelled");
  if (req.signal) {
    if (req.signal.aborted) onParentAbort();
    else req.signal.addEventListener("abort", onParentAbort, { once: true });
  }
  /* Two clocks once a response streams, because "no answer" and "a long
     answer" stopped being the same thing the moment tokens started
     arriving one at a time.

     - the stall clock is re-armed on every chunk. A stream still
       delivering is answering; killing it at a fixed total and
       reporting "the model did not answer" is simply false, and that is
       what a 90s total deadline did to a power-model turn writing eight
       files.
     - the hard clock is never re-armed, so a trickle cannot run for
       ever. The caller sets it from the time the RUN has left.

     With neither stallMs nor hardMs supplied this behaves exactly as it
     did: one timer, one deadline, covering headers and body alike. */
  const stallMs = Number.isFinite(req.stallMs) && req.stallMs > 0 ? Math.min(req.stallMs, 2147483647) : 0;
  const hardMs = Number.isFinite(req.hardMs) && req.hardMs > 0 ? Math.min(req.hardMs, 2147483647) : 0;

  let timer = setTimeout(() => stop("timeout"), timeoutMs);
  const hardTimer = hardMs ? setTimeout(() => stop("hard"), hardMs) : null;
  let touched = false;

  return {
    signal: controller.signal,
    /* Called by the stream reader for every chunk that arrives. */
    touch: () => {
      if (stoppedBy || !stallMs) return;
      touched = true;
      clearTimeout(timer);
      timer = setTimeout(() => stop("stall"), stallMs);
    },
    // Both headers and the body consume the same deadline. Racing the abort
    // also bounds custom transports that do not reject a pending body read.
    run: (operation) => new Promise((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error("request aborted"), { name: "AbortError" }));
      if (controller.signal.aborted) { onAbort(); return; }
      controller.signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw Object.assign(new Error("request aborted"), { name: "AbortError" });
        return operation();
      }).then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", onAbort));
    }),
    failure: (error, t0) => ({
      ok: false, error: true,
      cancelled: stoppedBy === "cancelled",
      timedOut: stoppedBy === "timeout" || stoppedBy === "stall" || stoppedBy === "hard",
      stalled: stoppedBy === "stall",
      /* Retrying this one cannot work: the ceiling is the time the RUN
         has left, so a second attempt starts with less of it. */
      ranOutOfTime: stoppedBy === "hard",
      /* Named for what actually happened. "The model did not answer" is
         wrong for a stream that answered for a minute and then stopped,
         and wrong again for one cut off by the run's own deadline — and
         which of the three it was decides whether retrying helps. */
      reason: stoppedBy === "cancelled" ? "request cancelled"
        : stoppedBy === "stall" ? "the model stopped sending after " + stallMs + "ms of silence"
        : stoppedBy === "hard" ? "the run ran out of time after " + hardMs + "ms"
        : stoppedBy === "timeout" ? (touched
            ? "the model stopped sending after " + timeoutMs + "ms"
            : "timed out after " + timeoutMs + "ms")
        : (error && error.message) || "provider request failed",
      latencyMs: Date.now() - t0
    }),
    close: () => {
      clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      if (req.signal) req.signal.removeEventListener("abort", onParentAbort);
    }
  };
}

/**
 * Reassemble a streamed chat completion into the shape the non-streamed
 * one returns.
 *
 * Deliberately NOT a second response format. Everything downstream — the
 * agent loop, the tool dispatcher, cost accounting — reads
 * `choices[0].message` and `usage`, and it should not be able to tell
 * which transport produced them. Streaming is a way to watch the answer
 * being written, not a different kind of answer.
 *
 * `onDelta` is called as text arrives, and once per tool call at the
 * moment its NAME becomes known. That second one is the useful one: a
 * turn that writes eight files spends twenty seconds generating tool
 * arguments, and the name arrives at the start of each.
 */
async function readCompletionStream(res, onDelta, scope) {
  const content = [];
  const reasoning = [];
  const byIndex = new Map();
  const named = new Set();
  let finishReason = null;
  let usage = {};

  const tell = (event) => { if (onDelta) { try { onDelta(event); } catch (e) { /* a watcher must never break the call */ } } };

  const consumeLine = (line) => {
    const text = line.trim();
    if (!text.startsWith("data:")) return;
    const payload = text.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let event;
    try { event = JSON.parse(payload); } catch (e) { return; }   // a keepalive or a split frame

    // Arrives in its own final chunk, after the last choice.
    if (event.usage) usage = event.usage;

    const choice = event.choices && event.choices[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const delta = choice.delta || {};
    if (typeof delta.content === "string" && delta.content) {
      content.push(delta.content);
      tell({ textDelta: delta.content });
    }
    /* Reported now, under its own name.

       This used to be collected and deliberately withheld — "not for
       showing to anyone". On a reasoning model at high effort that is the
       only thing the provider sends for minutes at a time: content deltas
       do not start until the thinking is over. So the run emitted nothing,
       and the UI sat on an empty "Thinking" header through a five-minute
       turn with no way to tell it apart from a hang.

       Kept separate from textDelta rather than merged into it. The
       narration is the agent talking to the person and is what the turn is
       replayed as; this is the model working, and the watcher spends it on
       a different event so the two never end up in the same paragraph. */
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      reasoning.push(delta.reasoning_content);
      tell({ reasoningDelta: delta.reasoning_content });
    }

    for (const part of delta.tool_calls || []) {
      const i = part.index === undefined ? 0 : part.index;
      let call = byIndex.get(i);
      if (!call) { call = { id: "", type: "function", function: { name: "", arguments: "" } }; byIndex.set(i, call); }
      if (part.id) call.id = part.id;
      if (part.type) call.type = part.type;
      if (part.function) {
        // Both accumulate: a name can be split across frames just as
        // arguments are, and assigning would keep only the last fragment.
        if (part.function.name) call.function.name += part.function.name;
        if (part.function.arguments) call.function.arguments += part.function.arguments;
      }
      if (call.function.name && !named.has(i)) { named.add(i); tell({ toolName: call.function.name, index: i }); }
    }
  };

  let buffered = "";
  const feed = (text) => {
    buffered += text;
    let nl;
    while ((nl = buffered.indexOf("\n")) >= 0) {
      consumeLine(buffered.slice(0, nl));
      buffered = buffered.slice(nl + 1);
    }
  };

  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      /* Before parsing, and for every chunk including a keepalive: the
         question the stall clock answers is "is the provider still
         there", not "did that chunk contain anything we wanted". */
      if (scope && scope.touch) scope.touch();
      feed(decoder.decode(chunk.value, { stream: true }));
    }
  } else if (typeof res.text === "function") {
    /* No readable body. Some proxies buffer the whole stream before
       handing it over — the frames are the same, they just all arrive at
       once. */
    feed(await res.text());
  } else if (typeof res.json === "function") {
    /* Asked for a stream and got a whole completion. OpenAI-compatible
       gateways do ignore the flag, and the honest thing is to use the
       answer rather than return an empty message because the transport
       was not the one we asked for. onDelta simply never fires. */
    const whole = await res.json();
    if (whole && whole.choices) return whole;
  }
  if (buffered) consumeLine(buffered);

  const message = { role: "assistant", content: content.join("") };
  if (reasoning.length) message.reasoning_content = reasoning.join("");

  /* Only calls that got a name. A stream cut off mid-tool-call leaves a
     fragment whose arguments will not parse, and handing that to the
     dispatcher is executing half of something the model never finished
     saying. finish_reason already tells the caller it was truncated. */
  const calls = Array.from(byIndex.entries())
    .sort((a, b) => a[0] - b[0])
    .map((entry) => entry[1])
    .filter((call) => call.function.name);
  if (calls.length) message.tool_calls = calls;

  return { choices: [{ message, finish_reason: finishReason }], usage };
}

function completionBody(req, model, baseUrl) {
  const body = {
    model, messages: req.messages, tools: req.tools || undefined,
    tool_choice: req.toolChoice || undefined, response_format: req.responseFormat || undefined,
    max_tokens: req.maxTokens || 900,
    temperature: req.temperature !== null && req.temperature !== undefined ? req.temperature : 0.5,
    stream: req.stream ? true : undefined,
    /* Without this a streamed response carries no usage block at all, and
       every call would be recorded as costing nothing — the budget guard
       and the breaker both read what recordSpend is given. */
    stream_options: req.stream ? { include_usage: true } : undefined
  };
  let deepseek = /^deepseek/i.test(model);
  try { deepseek = deepseek || new URL(baseUrl).hostname === "api.deepseek.com"; } catch (_) { /* validated by fetch */ }
  if (!deepseek) return { body };

  if (req.thinking !== undefined && typeof req.thinking !== "boolean") {
    return { ok: false, error: true, badRequest: true, reason: "thinking must be a boolean" };
  }
  const efforts = { none: "none", minimal: "low", low: "low", medium: "high", high: "high", xhigh: "high", max: "max", ultra: "max" };
  const effort = req.reasoningEffort === undefined ? undefined
    : Object.hasOwn(efforts, String(req.reasoningEffort)) ? efforts[String(req.reasoningEffort)] : undefined;
  if (req.reasoningEffort !== undefined && !effort) {
    return { ok: false, error: true, badRequest: true, reason: "unsupported DeepSeek reasoning effort" };
  }
  const thinking = req.thinking !== undefined ? req.thinking : effort !== undefined
    ? effort !== "none" : !/^deepseek-chat$/i.test(model);
  if (req.thinking !== undefined || effort !== undefined) body.thinking = { type: thinking ? "enabled" : "disabled" };
  if (thinking) {
    if (effort && effort !== "none") body.reasoning_effort = effort;
    delete body.temperature;
    // Forced tool choices get a 400 in DeepSeek's thinking mode. The loop
    // must ask for a tool in its prompt and still handle an ordinary reply.
    if (body.tool_choice && body.tool_choice !== "none" && body.tool_choice !== "auto") body.tool_choice = "auto";
  }
  return { body };
}

/**
 * @param {object} req
 * @param {"prose"|"json"} req.route
 * @param {Array<{role:string, content:string}>} req.messages
 * @param {Array<object>} [req.tools]            OpenAI tool-calling schema
 * @param {{type:string}} [req.responseFormat]    e.g. {type:"json_object"}
 * @param {number} [req.maxTokens]
 * @param {number} [req.temperature]
 * @param {number} [req.timeoutMs]
 * @param {{provider:string, apiKey:string, model?:string}} [req.byok]
 *   The USER's own provider credentials (lib/ai/providers.js). When present
 *   this bypasses `route` entirely — different key, different endpoint,
 *   different billing party.
 * @param {boolean} [req.thinking]                extended reasoning, where the provider supports it
 * @param {string} [req.reasoningEffort]          DeepSeek reasoning depth (low/high/max)
 * @param {AbortSignal} [req.signal]              cancellation from the owning agent run
 * @returns {Promise<object>} always resolves — never throws for an operational failure
 */
async function chat(req) {
  ensureInit();

  // ---- BYOK path ----------------------------------------------------
  // Taken BEFORE the AI_ENABLED / breaker / budget guards on purpose:
  // every one of those protects SOUQI's keys and SOUQI's spend. A user
  // running on their own key is not spending Souqi's budget, so blocking
  // them because Souqi's own DeepSeek route tripped a breaker would be
  // punishing them for an outage that cannot affect them.
  if (req.byok && req.byok.apiKey) {
    return chatByok(req);
  }

  if (!CONFIG.routes[req.route]) throw new Error("ai/client: unknown route \"" + req.route + "\" (expected \"prose\", \"json\" or \"vision\")");

  if (!CONFIG.enabled) return { ok: false, disabled: true, reason: "AI_ENABLED is not set" };

  // Everything below bills, trips and counts against the route that serves
  // the call, which is not always the one that was asked for.
  const route = resolveRoute(req.route);
  const r = CONFIG.routes[route];
  if (!configured(r)) {
    return { ok: false, disabled: true, reason: "no route configured with a key/baseUrl/model (asked for \"" + req.route + "\")" };
  }
  if (breakerOpen(route)) {
    return { ok: false, breakerOpen: true, reason: "circuit breaker open for \"" + route + "\" until " + new Date(breakers[route].openUntil).toISOString() };
  }
  /* Refreshed here because chat() is the only place the answer matters,
     and it is already async. Cached for SHARED_TTL_MS, so this is a
     database read a few times a minute, not one per call. */
  await refreshSharedSpend(false);
  if (budgetExceeded(route)) {
    return { ok: false, budgetExceeded: true, reason: "monthly AI budget of $" + CONFIG.budgetUsd + " reached" };
  }

  /* Refuse a request that cannot fit, here, instead of paying a round trip to
     be told the same thing by the provider.

     Callers are expected to have trimmed already (model-loop's
     fitConversation does). This is the backstop for the ones that have not,
     and it exists mostly to make the failure legible: as a provider 400 this
     arrived as "provider returned 400: {...}" and became a starter template,
     which reads like the model gave up rather than like a request that was
     never sent. These numbers say exactly what to cut.

     Deliberately NOT a silent trim. Dropping messages down here would mean
     guessing which of them matter, invisibly to everything upstream — and an
     assistant message carrying tool_calls must keep its tool replies, so a
     naive drop produces a 400 for a second reason. */
  const wantTokens = req.maxTokens || 900;
  const windowTokens = windowFor(route, req.model || r.model);   // `route` is already resolved
  const needTokens = estimateTokens(req.messages, req.tools) + wantTokens;
  if (needTokens > windowTokens) {
    return {
      ok: false, error: true, badRequest: true, overflow: true,
      neededTokens: needTokens, windowTokens: windowTokens,
      reason: "request needs about " + needTokens + " tokens (including " + wantTokens +
        " reserved for the reply) but " + (req.model || r.model) + " has a " +
        windowTokens + " token window"
    };
  }

  const request = completionBody(req, req.model || r.model, r.baseUrl);
  if (!request.body) return request;
  const t0 = Date.now();
  const scope = requestScope(req);
  let failureRecorded = false;
  try {
    const res = await scope.run(() => CONFIG.fetchImpl(r.baseUrl.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + r.key },
      body: JSON.stringify(request.body),
      signal: scope.signal
    }));

    if (!res.ok) {
      /* Only an outage advances the breaker — see countsAsProviderFailure.
         A 400 is this process sending something the model would not take. */
      const providerFault = countsAsProviderFailure(res.status);
      let detail = "";
      try { detail = JSON.stringify(await scope.run(() => res.json())).slice(0, 300); }
      catch (e) { if (scope.signal.aborted) throw e; /* not JSON */ }
      if (providerFault) { recordFailure(route); failureRecorded = true; }
      return {
        ok: false, error: true, status: res.status,
        /* Lets a caller tell "try again later" from "this will fail the same
           way forever". The build loop wants that distinction: retrying an
           outage is reasonable, retrying a request the model rejected is not. */
        badRequest: !providerFault,
        reason: "provider returned " + res.status + (detail ? ": " + detail : ""),
        latencyMs: Date.now() - t0
      };
    }

    const json = request.body.stream
      ? await scope.run(() => readCompletionStream(res, req.onDelta, scope))
      : await scope.run(() => res.json());
    const usage = (json && json.usage) || {};
    const costUsd = estimateCost(route, usage);
    recordSpend(route, costUsd);

    const choice = json && json.choices && json.choices[0];
    if (!choice || !choice.message || typeof choice.message !== "object") {
      recordFailure(route);
      failureRecorded = true;
      return { ok: false, error: true, reason: "provider returned no completion message", usage, costUsd, latencyMs: Date.now() - t0 };
    }
    recordSuccess(route);
    return {
      ok: true,
      // Which route ran, so a caller (and the demo scripts) can tell that a
      // prose request was served by the json provider.
      route: route,
      servedFallback: route !== req.route,
      message: choice ? choice.message : null,
      finishReason: choice ? choice.finish_reason : null,
      usage: usage,
      costUsd: costUsd,
      latencyMs: Date.now() - t0
    };
  } catch (e) {
    const failure = scope.failure(e, t0);
    if (!failure.cancelled && !failureRecorded) recordFailure(route);
    return failure;
  } finally {
    scope.close();
  }
}

/**
 * One call against the USER's own provider credentials.
 *
 * Shares the OpenAI chat-completions transport below with the route path
 * but none of its state: no breaker (a user's key failing says nothing
 * about Souqi's), no spend recording (Souqi is not being billed), no
 * budget guard. `costUsd` is still reported so the UI can show what a
 * build cost on their account — it is information, not a limit.
 */
async function chatByok(req) {
  const providers = require("./providers");
  const p = providers.get(req.byok.provider);
  if (!p || !p.byok) return { ok: false, error: true, reason: "unknown model provider \"" + req.byok.provider + "\"" };

  const model = req.byok.model || p.defaultModel;

  if (p.kind === "anthropic") {
    return require("./anthropic").chat({
      apiKey: req.byok.apiKey, model: model, messages: req.messages, tools: req.tools,
      maxTokens: req.maxTokens, timeoutMs: req.timeoutMs, thinking: req.thinking,
      reasoningEffort: req.reasoningEffort, toolChoice: req.toolChoice, signal: req.signal
    });
  }

  const request = completionBody(req, model, p.baseUrl);
  if (!request.body) return request;
  const t0 = Date.now();
  const scope = requestScope(req);
  try {
    const res = await scope.run(() => CONFIG.fetchImpl(p.baseUrl.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + req.byok.apiKey },
      body: JSON.stringify(request.body),
      signal: scope.signal
    }));

    if (!res.ok) {
      let detail = "";
      try { detail = JSON.stringify(await scope.run(() => res.json())).slice(0, 300); }
      catch (e) { if (scope.signal.aborted) throw e; /* not JSON */ }
      // Same reasoning as ai/anthropic.js: the user pasted this key, so a
      // rejection is almost always THEIR key and they can fix it — say so
      // in words, rather than surfacing a raw provider error body.
      let reason;
      if (res.status === 401 || res.status === 403) reason = "your " + p.label + " API key was rejected — check it in the model picker";
      else if (res.status === 404) reason = "model \"" + model + "\" was not found on your " + p.label + " account";
      else if (res.status === 429) reason = "your " + p.label + " account is rate limited — try again shortly";
      else reason = p.label + " returned " + res.status + (detail ? ": " + detail : "");
      return { ok: false, error: true, badRequest: !countsAsProviderFailure(res.status), status: res.status, reason: reason, latencyMs: Date.now() - t0 };
    }

    /* The same builder produces this body, so a streamed request is a
       streamed request here too — reading it as JSON would fail on the
       first `data:` line, and only for users on their own keys. */
    const json = request.body.stream
      ? await scope.run(() => readCompletionStream(res, req.onDelta, scope))
      : await scope.run(() => res.json());
    const choice = json && json.choices && json.choices[0];
    if (!choice || !choice.message || typeof choice.message !== "object") {
      return { ok: false, error: true, reason: "provider returned no completion message", usage: (json && json.usage) || {}, costUsd: 0, latencyMs: Date.now() - t0 };
    }
    return {
      ok: true,
      message: choice ? choice.message : null,
      finishReason: choice ? choice.finish_reason : null,
      usage: json.usage || {},
      costUsd: 0, // billed to the user's own account; Souqi has no rate card for it
      latencyMs: Date.now() - t0
    };
  } catch (e) {
    return scope.failure(e, t0);
  } finally {
    scope.close();
  }
}

/** For tests and dashboards — not used in the request path. */
function _debugState() {
  return { config: CONFIG, breakers: JSON.parse(JSON.stringify(breakers)), spend: JSON.parse(JSON.stringify(spend)) };
}

/**
 * Is this route actually usable?
 *
 * Lets a caller skip work it would only throw away — vision.js uses it to
 * avoid a storage round-trip fetching bytes for a model that is not there.
 * Deliberately does NOT consider the breaker or the budget: those are
 * transient and belong to the call, this answers the static question of
 * whether the deployment has a provider for this at all.
 */
function routeConfigured(route) {
  ensureInit();
  return !!(CONFIG && configured(CONFIG.routes[route]));
}

module.exports = { init, chat, routeConfigured, monthSpend, budgetExceeded,
  refreshSharedSpend, windowFor, estimateTokens, CHARS_PER_TOKEN, _debugState };
