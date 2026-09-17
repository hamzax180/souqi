"use strict";
/* =================================================================
   context/micro-compact.ts — shrink the bulk, keep the record
   -----------------------------------------------------------------
   Almost all of a long run's context is old tool output. read_file
   truncates at 24,000 characters and list_files grows with the
   project, so three reads early in a run can outweigh every word
   anybody has actually said — and they stay in the request for every
   later turn, being re-sent and re-billed to tell the model about a
   file it has since rewritten twice.

   So the oldest bulky tool RESULTS are replaced with a line saying
   what was there and where it still is. The content moves out of the
   request; it does not stop existing. run-store writes every turn's
   toolCalls and toolResults to agent_steps before this ever runs, so
   the pointer is to a real row that can be read back.

   Three things are never touched, and each is a bug that would
   otherwise be easy to cause:

     - the most recent turns. That is the work in progress.
     - anything that FAILED. An error is small and is the most
       load-bearing text in the whole request — it is what the next
       turn is for.
     - the message structure. Only `content` is rewritten. Dropping a
       tool message outright would orphan its assistant's tool_call,
       and the next provider call fails with a 400 about message
       pairing rather than about anything that is actually wrong.
   ================================================================= */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CLEARED_PREFIX = exports.KEEP_RECENT_RESULTS = exports.MIN_COMPACTABLE_CHARS = void 0;
exports.microCompact = microCompact;
const redact_1 = require("./redact");
/** Below this a tool result is not worth the pointer that replaces it. */
exports.MIN_COMPACTABLE_CHARS = 600;
/** How many trailing tool results are left alone, whatever their size. */
exports.KEEP_RECENT_RESULTS = 6;
exports.CLEARED_PREFIX = "[earlier tool output cleared to save context";
/* An error is the point of the turn that follows it, and it is small
   anyway — compacting one saves nothing and costs the model the only
   description of what went wrong. */
function isFailure(text) {
    return /^Error:/.test(text) || /\bcannot run in\b/.test(text) || /\bis not in that file\b/.test(text) ||
        /\bappears \d+ times\b/.test(text) || /\bnot a safe relative path\b/.test(text) ||
        /\bUnknown tool\b/.test(text);
}
function alreadyCompacted(text) {
    return text.startsWith(exports.CLEARED_PREFIX);
}
/**
 * Rewrite old bulky tool results in place.
 *
 * Returns a NEW array; the messages it does not change are the same
 * objects, so nothing that holds a reference to a live message sees it
 * mutate underneath them.
 */
function microCompact(messages, opts = {}) {
    const minChars = Number(opts.minChars) || exports.MIN_COMPACTABLE_CHARS;
    const keepRecent = opts.keepRecent === undefined ? exports.KEEP_RECENT_RESULTS : Number(opts.keepRecent);
    // Indices of every tool result, oldest first.
    const toolIdx = [];
    messages.forEach((m, i) => { if (m && m.role === "tool")
        toolIdx.push(i); });
    // The tail is protected whatever it contains.
    const protectedFrom = Math.max(0, toolIdx.length - keepRecent);
    const eligible = new Set(toolIdx.slice(0, protectedFrom));
    let compacted = 0;
    let charsFreed = 0;
    const out = messages.map((m, i) => {
        if (!eligible.has(i))
            return m;
        const text = typeof m.content === "string" ? m.content : "";
        if (text.length < minChars)
            return m;
        if (alreadyCompacted(text) || isFailure(text))
            return m;
        /* The first line usually says what it was — "Successfully wrote
           src/App.tsx", or the first hit of a search. Keeping it means the
           pointer is still readable as a fact rather than as a hole, and
           it is redacted because the whole point of clearing this is that
           it is about to be summarised into something durable. */
        const firstLine = (0, redact_1.redact)((text.split("\n")[0] || "").slice(0, 120)).text;
        const where = opts.runId && m.tool_call_id
            ? " — recoverable from agent_steps: run " + opts.runId + ", call " + m.tool_call_id
            : "";
        const replacement = exports.CLEARED_PREFIX + ": " + text.length + " chars" + where + "]" +
            (firstLine ? "\n" + firstLine : "");
        compacted++;
        charsFreed += text.length - replacement.length;
        return Object.assign({}, m, { content: replacement });
    });
    return { messages: out, compacted, charsFreed: Math.max(0, charsFreed) };
}
