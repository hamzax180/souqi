/* =================================================================
   ai/anthropic.js — Claude via the official SDK, not the compat shim
   -----------------------------------------------------------------
   Anthropic publishes an OpenAI-compatible endpoint, and it was
   tempting to point ai/client.js at it and be done in four lines.
   That path is deliberately NOT taken: the compat layer flattens
   away adaptive thinking, the `refusal` stop reason, and the
   tool_use/tool_result block shape — exactly the three things
   Powered Souqi's MCP loop depends on. Using the real Messages API
   costs one adapter and keeps all of it.

   This module's job is translation, in both directions, between the
   internal OpenAI-ish message shape that model-loop.js speaks and
   Anthropic's Messages API:

     internal                        Anthropic
     ────────────────────────────    ──────────────────────────────
     {role:"system", content}        top-level `system` string
     {role:"user"|"assistant"}       messages[] with content blocks
     {role:"tool", tool_call_id}     user message w/ tool_result block
     message.tool_calls[]            assistant content tool_use blocks
     tools[].function.parameters     tools[].input_schema

   Returns the SAME result envelope as ai/client.js chat() so callers
   never branch on which provider ran. Operational failures resolve
   as {ok:false, reason}; they do not throw.
   ================================================================= */
"use strict";

let Anthropic = null;
function loadSdk() {
  if (Anthropic) return Anthropic;
  try {
    Anthropic = require("@anthropic-ai/sdk");
    // The SDK ships as ESM+CJS; the CJS build puts the class on .default.
    if (Anthropic && Anthropic.default) Anthropic = Anthropic.default;
  } catch (e) {
    Anthropic = null;
  }
  return Anthropic;
}

// $/1M tokens, Anthropic first-party rates. Used only to report an estimated
// costUsd back to the caller for display — a BYOK build is billed by
// Anthropic to the user's own account, never against Souqi's budget guard.
const PRICING = {
  "claude-opus-5": { in: 5.00, out: 25.00 },
  "claude-opus-4-8": { in: 5.00, out: 25.00 },
  "claude-sonnet-5": { in: 2.00, out: 10.00 },
  "claude-haiku-4-5": { in: 1.00, out: 5.00 },
  "claude-fable-5": { in: 10.00, out: 50.00 }
};
const DEFAULT_PRICING = { in: 5.00, out: 25.00 };

function estimateCost(model, usage) {
  const p = PRICING[model] || DEFAULT_PRICING;
  const inTok = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  return (inTok / 1e6) * p.in + ((usage.output_tokens || 0) / 1e6) * p.out;
}

/** internal tools[] (OpenAI function shape) -> Anthropic tools[] */
function toAnthropicTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((t) => {
    const f = t.function || t;
    return {
      name: f.name,
      description: f.description || "",
      input_schema: f.parameters || { type: "object", properties: {} }
    };
  });
}

/**
 * internal messages[] -> { system, messages }
 *
 * The fiddly part is `role:"tool"`. Anthropic has no tool role: a tool
 * result is a `tool_result` content block inside a USER message, and every
 * result for one assistant turn has to land in a single user message.
 * Emitting one user message per tool result is accepted by the API but
 * teaches the model to stop making parallel calls, so consecutive tool
 * messages are coalesced here.
 */
function toAnthropicMessages(messages) {
  const system = [];
  const out = [];

  for (const m of messages || []) {
    if (m.role === "system") { system.push(String(m.content || "")); continue; }

    if (m.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content: String(m.content == null ? "" : m.content)
      };
      const last = out[out.length - 1];
      // Coalesce into the pending user message when it is already a
      // tool-result carrier, so a parallel batch stays one message.
      if (last && last.role === "user" && Array.isArray(last.content) &&
          last.content.length && last.content[0].type === "tool_result") {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }

    if (m.role === "assistant") {
      const content = [];
      const text = typeof m.content === "string" ? m.content.trim() : "";
      if (text) content.push({ type: "text", text: text });
      for (const c of m.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(c.function.arguments); }
        catch (e) { input = {}; } // a call we could not parse going out is a call the model will be asked to redo
        content.push({ type: "tool_use", id: c.id, name: c.function.name, input: input });
      }
      // An assistant turn with neither text nor tool calls is not a legal
      // Anthropic message; dropping it is correct — there is nothing in it.
      if (content.length) out.push({ role: "assistant", content: content });
      continue;
    }

    out.push({ role: "user", content: String(m.content == null ? "" : m.content) });
  }

  return { system: system.join("\n\n"), messages: out };
}

/** Anthropic response -> the internal {message:{content, tool_calls}} shape */
function fromAnthropicMessage(resp) {
  let text = "";
  const toolCalls = [];
  for (const block of resp.content || []) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input || {}) }
      });
    }
  }
  const msg = { role: "assistant", content: text };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  return msg;
}

/**
 * Anthropic stop_reason -> the internal finishReason vocabulary.
 * model-loop.js branches on "length" specifically (it retries truncated
 * completions with a bigger budget), so that mapping has to be exact.
 */
function toFinishReason(stopReason) {
  if (stopReason === "max_tokens") return "length";
  if (stopReason === "tool_use") return "tool_calls";
  if (stopReason === "refusal") return "refusal";
  return "stop";
}

/**
 * @param {object} req
 * @param {string} req.apiKey            the USER's key — never Souqi's
 * @param {string} [req.model]
 * @param {Array}  req.messages          internal shape
 * @param {Array}  [req.tools]           internal (OpenAI function) shape
 * @param {number} [req.maxTokens]
 * @param {number} [req.timeoutMs]
 * @param {boolean}[req.thinking]        adaptive thinking on/off
 * @returns {Promise<object>} same envelope as ai/client.js chat()
 */
async function chat(req) {
  if (req.signal && req.signal.aborted) return { ok: false, error: true, cancelled: true, timedOut: false, reason: "request cancelled", latencyMs: 0 };
  const Sdk = loadSdk();
  if (!Sdk) {
    return { ok: false, error: true, reason: "the Anthropic SDK is not installed on this server (npm i @anthropic-ai/sdk)" };
  }
  if (!req.apiKey) return { ok: false, disabled: true, reason: "no Anthropic API key configured" };

  const model = req.model || "claude-opus-5";
  const maxTokens = req.maxTokens || 8000;
  const t0 = Date.now();

  const { system, messages } = toAnthropicMessages(req.messages);
  const body = {
    model: model,
    max_tokens: maxTokens,
    messages: messages
  };
  if (system) body.system = system;
  const tools = toAnthropicTools(req.tools);
  if (tools) body.tools = tools;
  // Adaptive thinking, not budget_tokens: budget_tokens is rejected with a
  // 400 on Opus 5 / Sonnet 5 / Fable 5. Effort is the depth dial instead.
  if (req.thinking) {
    body.thinking = { type: "adaptive" };
    body.output_config = { effort: "high" };
  }

  const timeoutMs = Number.isFinite(req.timeoutMs) && req.timeoutMs > 0
    ? Math.min(req.timeoutMs, 2147483647) : 120000;
  const controller = new AbortController();
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
  const timer = setTimeout(() => stop("timeout"), timeoutMs);
  let onAbort;

  try {
    if (controller.signal.aborted) throw new Error("request cancelled");
    const client = new Sdk({
      apiKey: req.apiKey,
      timeout: timeoutMs,
      maxRetries: 1
    });
    // Streamed, then collected: a multi-file build routinely asks for tens of
    // thousands of output tokens, and the SDK requires streaming above ~21k
    // max_tokens to avoid an HTTP timeout. Nothing here consumes the
    // individual events — this call is one turn of a loop, not a chat UI.
    const stream = client.messages.stream(body, { signal: controller.signal });
    // The SDK's HTTP timeout can finish at headers. The owning run's
    // deadline must also cover thinking and the rest of the streamed body.
    const resp = await Promise.race([
      stream.finalMessage(),
      new Promise((resolve, reject) => {
        onAbort = () => reject(new Error("request aborted"));
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener("abort", onAbort, { once: true });
      })
    ]);

    const usage = resp.usage || {};
    return {
      ok: true,
      message: fromAnthropicMessage(resp),
      finishReason: toFinishReason(resp.stop_reason),
      // Normalised to the OpenAI usage field names the rest of the codebase
      // already reads, so metrics and the budget guard need no provider
      // branch of their own.
      usage: {
        prompt_tokens: usage.input_tokens || 0,
        completion_tokens: usage.output_tokens || 0,
        total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0)
      },
      costUsd: estimateCost(model, usage),
      latencyMs: Date.now() - t0
    };
  } catch (e) {
    const cancelled = stoppedBy === "cancelled";
    const timedOut = stoppedBy === "timeout" || (!cancelled && e && e.name === "APIConnectionTimeoutError");
    if (cancelled || timedOut) {
      return { ok: false, error: true, cancelled, timedOut,
        reason: cancelled ? "request cancelled" : "Anthropic timed out after " + timeoutMs + "ms", latencyMs: Date.now() - t0 };
    }
    const status = e && e.status;
    let reason = (e && e.message) || "Anthropic request failed";
    // A user's own key failing auth is the single most likely error here and
    // the raw SDK message ("401 {\"type\":\"error\"...}") is unreadable in a
    // chat bubble, so the common statuses get a plain-language rewrite.
    if (status === 401) reason = "your Anthropic API key was rejected — check it in the model picker";
    else if (status === 403) reason = "your Anthropic API key does not have access to " + model;
    else if (status === 404) reason = "model \"" + model + "\" was not found on your Anthropic account";
    else if (status === 429) reason = "your Anthropic account is rate limited — try again shortly";
    else if (status === 400 && /credit|balance/i.test(reason)) reason = "your Anthropic account is out of credit";
    return { ok: false, error: true, badRequest: !!status && status < 500 && status !== 429, status: status, reason: reason, latencyMs: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    if (req.signal) req.signal.removeEventListener("abort", onParentAbort);
  }
}

module.exports = { chat, toAnthropicMessages, toAnthropicTools, fromAnthropicMessage, toFinishReason };
