/* =================================================================
   types.ts — the contracts the agent subsystem agrees on
   -----------------------------------------------------------------
   These are discriminated unions rather than loose objects wherever a
   value has states, because the bugs this subsystem actually had were
   state confusions: a tool result that was sometimes a string and
   sometimes an object, a mode that existed in the schema but not in
   the dispatcher, an approval that was a boolean the client sent.
   ================================================================= */

/** The five states a run can be in. `chat` and the two `awaiting_*`
    states permit no writes; `act` is the only one that does. */
export type AgentMode =
  | "chat"
  | "act"
  | "plan"
  | "awaiting_question"
  | "awaiting_approval";

/** Why a turn stopped. `completed` is one of eight, and the other
    seven are not failures of the same kind — a turn_limit keeps its
    files, a tool_error may not. */
export type StopReason =
  | "completed"
  | "awaiting_question"
  | "awaiting_approval"
  | "cancelled"
  | "turn_limit"
  | "budget_limit"
  | "tool_error"
  | "runtime_unavailable";

export type ToolName =
  | "write_file"
  | "edit_file"
  | "read_file"
  | "list_files"
  | "search_code"
  | "check_project"
  | "complete_task";

/** OpenAI-shaped function schema — the form DYNAMIC_TOOLS_SCHEMA already
    uses, kept identical so the array can be handed to client.chat(). */
export interface ToolSchema {
  type: "function";
  function: {
    name: ToolName;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/** Loop-control signals. Two of the seven tools do not produce a value
    so much as steer the turn: check_project blocks the run on a build,
    complete_task ends it. Returning these as data keeps tool-registry
    the only place a tool NAME is interpreted. */
export interface ToolEffects {
  checkRequested?: boolean;
  completed?: boolean;
  summary?: string;
  wrotePath?: string;
  editedPath?: string;
}

/** What dispatch() always returns. It never throws and never returns
    undefined: a refusal is a result with `ok:false` whose `content` is
    written for the model to read and act on. A thrown refusal would
    leave an assistant tool_call with no matching tool reply, and the
    next provider call fails with a 400 about message pairing rather
    than about the thing that actually went wrong. */
export interface ToolOutcome {
  ok: boolean;
  content: string;
  effects?: ToolEffects;
}

/** Everything a tool is allowed to touch. There is no filesystem here:
    `files` is the in-memory candidate tree, which is why the read tools
    need no traversal rules of their own. */
export interface ToolContext {
  mode: AgentMode;
  files: Record<string, string>;
  runId: string;
  imageUrls?: string[];
  emit?: (type: string, payload: Record<string, unknown>) => Promise<void> | void;
}

export interface ToolEntry {
  name: ToolName;
  readOnly: boolean;
  schema: ToolSchema;
  validate?: (args: Record<string, unknown>, ctx: ToolContext) => void;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutcome> | ToolOutcome;
}

/* ── approval ───────────────────────────────────────────────────── */

/** Why an approval did not verify. Deliberately coarse: a verifier that
    says which of the four bindings failed helps someone guess the other
    three. */
export type ApprovalDenial =
  | "missing"
  | "malformed"
  | "signature"
  | "session"
  | "project"
  | "revision"
  | "plan"
  | "expired";

export interface ApprovalResult {
  ok: boolean;
  reason: ApprovalDenial | "approved";
  planVersion: string | null;
}

export interface ApprovalClaims {
  /** version — there is exactly one, and a token without it is refused */
  v: 1;
  /** session key, as run-store spells it: "user:<id>" or "anon:<id>" */
  sid: string;
  /** project id */
  pid: string;
  /** hash of the plan card that was shown */
  pv: string;
  /** the project's headRevision when the plan was approved */
  rev: string;
  iat: number;
  exp: number;
}

export interface ApprovalExpectation {
  sessionKey: string;
  projectId: string;
  revisionId: string;
  /** Only checked when the caller has the plan to hand. /runs has the
      token but not the card that produced it, so it omits this. */
  planVersion?: string | null;
  now?: number;
}
