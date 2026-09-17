/* =================================================================
   model-loop.d.ts — the seam, not a module
   -----------------------------------------------------------------
   backend/lib/codeagent/model-loop.js is 3581 lines of hand-written
   CommonJS and stays that way. This file describes the parts of it
   this subsystem calls, so the TypeScript here can typecheck against
   it without anyone porting it.

   It sits beside the .ts sources rather than in the output directory
   because of how the two resolutions differ: at COMPILE time
   `./model-loop` finds this .d.ts, and at RUN time the emitted
   lib/codeagent/tool-registry.js sits next to the real model-loop.js
   and require()s that. A .d.ts input emits nothing, so nothing here
   reaches the deployed tree.

   If a signature below stops matching model-loop.js, the typecheck is
   wrong and confident about it. The tests are what catch that — this
   file is an assertion, not a proof.
   ================================================================= */

/** Thrown by both validators; the message is written to be read by the
    model, so it is passed through to the tool result verbatim. */
export interface WriteFileArgs {
  path?: unknown;
  content?: unknown;
}

export interface EditFileArgs {
  path?: unknown;
  find?: unknown;
  replace?: unknown;
}

export interface RewriteOpts {
  imageUrls?: string[];
}

/**
 * Rejects a leading `/`, any `..`, anything outside `src/**` or a root
 * `*.html`, the PROTECTED_PATHS set, and a non-`.ts|.tsx|.css` file under
 * `src/`. Returns the normalised path and the content after the
 * twoUpOnMobile and fixImageUrls rewrites. Throws on every refusal.
 */
export function validateWriteFileArgs(
  args: WriteFileArgs,
  opts?: RewriteOpts
): { path: string; content: string };

/**
 * Exact-match replace. Throws when the file does not exist, when the
 * anchor is absent, and — the case agent-runner.js used to get wrong by
 * taking the first match — when the anchor appears more than once.
 */
export function applyEditFileArgs(
  args: EditFileArgs,
  current: string | undefined,
  opts?: RewriteOpts
): { path: string; content: string; edited: true };

export function validateReadPath(path: unknown): string;

export interface EffortLevel {
  id: "fast" | "balanced" | "smart" | "max";
  label: string;
  tier: "eco" | "power";
  maxTokens: number;
  rounds: number;
  blurb: string;
}

/** `legacyMode` exists because a cached page can still be sending the old
    "power", which lands on `smart` rather than being demoted to default. */
export function effortFor(value?: string, legacyMode?: string): EffortLevel;

export function systemPromptFor(mode?: string): string;

/** Takes the same options object callOptions() does — NOT an effort id.
    Handing it the string "balanced" leaves o.effort undefined and silently
    returns the default tier's budget, which is what the /runs engine was
    doing before this was typed. */
export function codeBudgetChars(opts?: {
  effort?: string;
  mode?: string;
  tools?: unknown[];
  byok?: unknown;
  thinking?: boolean;
}): number;

export function buildCodebaseContext(
  files: Record<string, string>,
  opts?: { prompt?: string; budget?: number }
): { text: string; included: string[]; excerpted: string[]; omitted: string[] };

/** Returns MESSAGES, not a string — callers concat it onto the protocol
    array. Walks the turns backwards so the budget drops the oldest
    context rather than the message the user just referred to. */
export function buildHistory(turns: unknown[]): Array<{
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}>;

export const PROMPT_VERSION: string;
