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
  maxTokens: number;
  rounds: number;
  tier: "eco" | "power";
}

export function effortFor(id?: string): EffortLevel;

export function systemPromptFor(mode?: string): string;

export function codeBudgetChars(opts?: {
  effort?: string;
  mode?: string;
  systemPrompt?: string;
  history?: string;
  errors?: string;
}): number;

export function buildCodebaseContext(
  files: Record<string, string>,
  opts?: { prompt?: string; budget?: number }
): { text: string; included: string[]; excerpted: string[]; omitted: string[] };

export function buildHistory(turns: unknown[]): string;

export const PROMPT_VERSION: string;
