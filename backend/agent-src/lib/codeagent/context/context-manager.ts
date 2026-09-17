/* =================================================================
   context/context-manager.ts — assemble the request, every call
   -----------------------------------------------------------------
   The one entry point the runner uses. Everything else in this
   directory is a step it can take; this decides which steps this
   particular call needs and in what order.

   The order is not arbitrary. Each step is more expensive and more
   lossy than the one before it, so each runs only when the cheaper
   ones have not been enough:

     1. measure          — free
     2. micro-compact    — free, and the raw record survives in
                           agent_steps
     3. auto-compact     — one provider call, and detail is lost
     4. fitConversation  — free, and whole turns are lost

   Step 4 already existed and is the reason for the other three. Its
   only move is to drop, so anything that reduces the request before
   it runs is a turn it does not have to throw away.

   REASSEMBLED EVERY CALL, not accumulated. The alternative — mutate
   one array and keep appending — is how a run ends up with a
   conversation nobody can account for, where the thing that trimmed
   it three turns ago has already removed the message that explains
   why the current one looks wrong. Given the same inputs this returns
   the same request.
   ================================================================= */

import { fitConversation } from "../model-loop";
import * as budget from "./token-budget";
import * as micro from "./micro-compact";
import * as auto from "./auto-compact";
import type { CompactMessage, RunFacts } from "./auto-compact";

export interface PrepareInput {
  messages: CompactMessage[];
  /** System prompt, codebase and task — never compacted or dropped. */
  headLen: number;
  tools?: unknown[];
  route?: string;
  model?: string;
  /** The reply allowance, from EFFORT. */
  maxTokens?: number;
  runId?: string;
  facts?: RunFacts;
  /** Injected by the tests so compaction needs no provider. */
  summarise?: (messages: CompactMessage[], facts: RunFacts) => Promise<string>;
  /** Turns at the end kept verbatim through compaction. */
  keepRecent?: number;
}

export interface PrepareAction {
  step: "micro-compact" | "auto-compact" | "fit";
  /** What it cost the transcript. Messages, or characters for micro. */
  removed: number;
  detail: string;
}

export interface PrepareResult {
  messages: CompactMessage[];
  budget: budget.Budget;
  before: budget.Pressure;
  after: budget.Pressure;
  actions: PrepareAction[];
}

/**
 * Turn an accumulated conversation into a request that fits.
 *
 * Never throws: a context engine that fails is a run that fails, and
 * the fallback — hand back the messages it was given and let
 * fitConversation deal with them — is what happened before any of this
 * existed. Each step is attempted, and a step that cannot run is
 * recorded and skipped.
 */
export async function prepare(input: PrepareInput): Promise<PrepareResult> {
  const tools = input.tools;
  const b = budget.budgetFor({
    route: input.route, model: input.model, maxTokens: input.maxTokens, tools
  });

  let messages = input.messages || [];
  const before = budget.measure(messages, b, tools);
  const actions: PrepareAction[] = [];

  // 2 — cheap, and the cleared text stays readable in agent_steps.
  if (before.needsMicroCompact) {
    const r = micro.microCompact(messages as micro.CompactableMessage[], { runId: input.runId });
    if (r.compacted) {
      messages = r.messages as CompactMessage[];
      actions.push({
        step: "micro-compact", removed: r.charsFreed,
        detail: r.compacted + " old tool result" + (r.compacted === 1 ? "" : "s") +
          " cleared, " + r.charsFreed + " chars freed"
      });
    }
  }

  // 3 — only if shrinking the bulk was not enough.
  let mid = budget.measure(messages, b, tools);
  if (mid.needsAutoCompact) {
    try {
      const r = await auto.autoCompact(messages, {
        headLen: input.headLen,
        keepRecent: input.keepRecent,
        facts: input.facts || {},
        summarise: input.summarise,
        route: input.route,
        model: input.model
      });
      if (r.replaced) {
        messages = r.messages;
        actions.push({
          step: "auto-compact", removed: r.replaced,
          detail: r.replaced + " messages replaced by a " +
            (r.modelWritten ? "written" : "facts-only") + " summary"
        });
      }
    } catch (e) {
      /* Compaction failing is not a reason to fail the turn — step 4
         can still make this fit, it will just cost whole rounds. */
      actions.push({ step: "auto-compact", removed: 0, detail: "skipped: " + (e as Error).message });
    }
    mid = budget.measure(messages, b, tools);
  }

  // 4 — the existing trimmer, and now the last resort rather than the first.
  if (mid.ratio >= 1) {
    const fit = fitConversation(messages, {
      windowTokens: b.windowTokens,
      maxTokens: b.replyTokens,
      tools,
      headLen: input.headLen
    });
    if (fit.dropped) {
      messages = fit.messages;
      actions.push({
        step: "fit", removed: fit.dropped,
        detail: fit.dropped + " message group" + (fit.dropped === 1 ? "" : "s") + " dropped to fit the window"
      });
    }
  }

  return { messages, budget: b, before, after: budget.measure(messages, b, tools), actions };
}

export { budget, micro, auto };
