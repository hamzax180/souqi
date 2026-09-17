/* =================================================================
   context/token-budget.ts — how much room is left, measured
   -----------------------------------------------------------------
   The existing budget work is good and is not replaced here.
   codeBudgetChars computes the codebase allowance from the model's
   real window, and fitConversation keeps a conversation inside it.
   What neither answers is "how close are we?", because both are
   called at the moment something has to be cut.

   That matters because fitConversation's only move is to DROP —
   whole repair groups, oldest first. By the time it runs, the choice
   is already between losing a round entirely and failing the call.
   Compaction needs to act earlier than that, and to act earlier it
   needs pressure as a number rather than as an exception.

   Thresholds are fractions of the usable window, not message counts.
   A message count is a proxy for size that is wrong in both
   directions: forty short turns fit comfortably, and three turns
   carrying a 24,000-character read_file do not.
   ================================================================= */

import * as client from "../../ai/client";

/** Reserved above the reply so a slightly-wrong estimate is not fatal.
    The same 512 fitConversation uses; kept in step deliberately. */
export const SAFETY_MARGIN_TOKENS = 512;

/* Measured against the USABLE window — what is left after the reply and
   the margin are set aside — because that is the number the request is
   actually competing for.

   0.60 / 0.85 rather than something tighter: micro-compaction is cheap
   and lossless-ish (the raw record stays in agent_steps), so it can run
   early and often. Full compaction costs a provider call and loses
   detail, so it waits until dropping is otherwise imminent. */
export const MICRO_COMPACT_AT = 0.60;
export const AUTO_COMPACT_AT = 0.85;

export interface BudgetInput {
  route?: string;
  model?: string;
  /** The reply allowance for this call — EFFORT's maxTokens. */
  maxTokens?: number;
  tools?: unknown[];
}

export interface Budget {
  /** The model's real context window, from the client's own table. */
  windowTokens: number;
  /** What the reply is allowed to take. */
  replyTokens: number;
  /** windowTokens - replyTokens - margin. What the request may use. */
  usableTokens: number;
  route: string;
  model: string | undefined;
}

export function budgetFor(input: BudgetInput): Budget {
  const route = input.route || "json";
  const windowTokens = client.windowFor(route, input.model);
  const replyTokens = Math.max(0, Number(input.maxTokens) || 0);
  return {
    windowTokens,
    replyTokens,
    usableTokens: Math.max(0, windowTokens - replyTokens - SAFETY_MARGIN_TOKENS),
    route,
    model: input.model
  };
}

export interface Pressure {
  usedTokens: number;
  usableTokens: number;
  /** used / usable. Above 1 the request will not fit at all. */
  ratio: number;
  needsMicroCompact: boolean;
  needsAutoCompact: boolean;
  /** True when even a full compaction may not be enough and something
      will have to be dropped. */
  overflowing: boolean;
}

/**
 * What the conversation costs right now, against what it may spend.
 *
 * `tools` counts. The schemas are sent on every single call, and
 * leaving them out of the estimate is how a budget that looked fine
 * produces a request that does not fit.
 */
export function measure(messages: unknown[], budget: Budget, tools?: unknown[]): Pressure {
  const usedTokens = client.estimateTokens(messages as never[], tools);
  const usable = budget.usableTokens || 1;
  const ratio = usedTokens / usable;
  return {
    usedTokens,
    usableTokens: budget.usableTokens,
    ratio,
    needsMicroCompact: ratio >= MICRO_COMPACT_AT,
    needsAutoCompact: ratio >= AUTO_COMPACT_AT,
    overflowing: ratio >= 1
  };
}

/* ── spend ──────────────────────────────────────────────────────── */

export interface SpendCeiling {
  /** Dollars this run may spend in total. 0 or absent means no ceiling. */
  maxCostUsd?: number;
  /** Provider calls this run may make. */
  maxCalls?: number;
}

export interface SpendState {
  costUsd: number;
  calls: number;
}

export interface SpendVerdict {
  ok: boolean;
  /** Set when ok is false — which ceiling was reached. */
  reason?: "budget_limit" | "turn_limit";
  detail?: string;
}

/**
 * Asked BEFORE a call, not after.
 *
 * Checking afterwards records an overspend rather than preventing one,
 * and the run whose budget is gone is exactly the run most likely to
 * keep going: a loop that is failing makes more calls, not fewer.
 */
export function canSpend(state: SpendState, ceiling: SpendCeiling): SpendVerdict {
  const max = Number(ceiling.maxCostUsd) || 0;
  if (max > 0 && state.costUsd >= max) {
    return {
      ok: false, reason: "budget_limit",
      detail: "this run has spent $" + state.costUsd.toFixed(4) + " of its $" + max.toFixed(2) + " allowance"
    };
  }
  const maxCalls = Number(ceiling.maxCalls) || 0;
  if (maxCalls > 0 && state.calls >= maxCalls) {
    return {
      ok: false, reason: "turn_limit",
      detail: "this run has made " + state.calls + " of its " + maxCalls + " allowed model calls"
    };
  }
  return { ok: true };
}
