/* =================================================================
   ai/client.d.ts — the seam, not a module
   -----------------------------------------------------------------
   backend/lib/ai/client.js stays hand-written JavaScript: it is the
   provider adapter for the whole platform, not part of the agent, and
   index.js shares it with routes that have nothing to do with coding.

   This file exists so `../ai/client` resolves for the TypeScript. It
   emits nothing — see the rootDir note in tsconfig.json for why the
   source tree has to mirror the output tree for this to work at all.
   ================================================================= */

/** A provider message. `content` is a string everywhere except the
    vision route, which passes a content array — see vision.ts. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<Record<string, unknown>>;
  tool_calls?: Array<{
    id: string;
    type?: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface ChatRequest {
  route: string;
  messages: ChatMessage[];
  tools?: unknown[];
  toolChoice?: unknown;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  byok?: unknown;
  thinking?: boolean;
  signal?: AbortSignal;
  /** Asks the provider for strict JSON. Used by the plan/assess calls. */
  responseFormat?: unknown;
  [extra: string]: unknown;
}

export interface ChatResponse {
  ok: boolean;
  message?: ChatMessage;
  reason?: string;
  finishReason?: string;
  costUsd?: number;
  route?: string;
  servedFallback?: boolean;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  /* Three distinct reasons a call did not happen, kept apart because
     none of them is a code defect and a repair round spent on one is a
     round spent on nothing. */
  disabled?: boolean;
  breakerOpen?: boolean;
  budgetExceeded?: boolean;
  [extra: string]: unknown;
}

export function chat(req: ChatRequest): Promise<ChatResponse>;
export function routeConfigured(route: string): boolean;
export function init(opts: Record<string, unknown>): void;

/** Characters per token, the estimate the whole context budget is built
    on. A constant, not a measurement. */
export const CHARS_PER_TOKEN: number;

/** The model's context window, by route and model id. Not a fixed
    number — the budget is computed from it rather than hardcoded. */
export function windowFor(route: string, model?: string): number;

/** Conservative token estimate for a message array plus its tool
    schemas. The schemas count: they are sent on every call. */
export function estimateTokens(messages: ChatMessage[], tools?: unknown[]): number;

export function monthSpend(route: string): number;
export function budgetExceeded(route: string): boolean;
export function _debugState(): Record<string, unknown>;
