/* =================================================================
   codeagent/agent-state.ts — what mode a run is in, and what that
   mode is allowed to touch
   -----------------------------------------------------------------
   Two things lived on the honour system before this file existed.

   ONE: the read-only restriction for a question turn was applied by
   FILTERING THE SCHEMA (agent-runner.js:331). Not offering a tool is
   not the same as refusing it. A model that emitted write_file anyway
   — and one will, because the instruction to do so can arrive inside
   a file it has just read — was dispatched normally, because the
   switch that ran the tool never asked what mode it was in.
   `permits()` is that question, and tool-registry asks it before
   every call rather than only when building the schema.

   TWO: plan mode's approval was a boolean the client sent. The gate
   read `req.body.confirmed` on /api/codeagent/build — but when the
   user presses "Looks good — Build it", frontend/code.html:2360 sends
   the turn to /api/codeagent/runs instead, where index.js:4756 maps
   the mode onto one of power|build|auto and "plan" stops existing. So
   the approved path and the gated path were different paths, and a
   client posting straight to /runs skipped the plan altogether.

   An approval here is a signed statement about four things at once:
   WHO approved it (session), WHAT project, WHICH plan, and WHICH
   revision it was approved against. The revision is what expires it.
   Every build writes one (index.js:4963), headRevision moves, and
   yesterday's approval stops verifying against today's tree — which
   is what "an edited plan cannot be executed with an old approval"
   has to mean if it is going to mean anything.
   ================================================================= */

import * as crypto from "crypto";
import type {
  AgentMode,
  ToolName,
  ApprovalClaims,
  ApprovalExpectation,
  ApprovalResult,
  ToolSchema
} from "./types";

/* The model's SURFACE: which tools each mode puts in the schema.

   awaiting_question is byte-identical to the filter it replaces
   (agent-runner.js:331-333), deliberately. Three of the eight cases in
   agent-runner-test.js assert on exactly that list, and a mode machine
   that quietly widened the model's surface would be a worse bug than
   the one this file was written to fix. */
const READ_ONLY_TOOLS: ToolName[] = ["read_file", "search_code", "list_files"];

const ALL_TOOLS: ToolName[] = [
  "write_file", "edit_file", "read_file", "list_files",
  "search_code", "check_project", "run_command", "ask_user_question", "complete_task"
];

/* Plan mode is offered the question tool and the other read-only modes
   are not, and that asymmetry is the point of plan mode: working out
   what to build is exactly when a consequential unknown shows up, and
   the alternative to asking is guessing and writing the guess into a
   plan the user then approves. A mode that is ANSWERING a question does
   not get to ask one back — that is a loop. */
const OFFERS: Record<AgentMode, ToolName[]> = {
  chat: [],
  /* present_plan is how a plan turn ENDS, and it is the reason plan mode
     can now take as long as it needs. Without a defined ending the model
     either wrote a plan into prose that nothing could approve, or reached
     for complete_task and finished a turn that had produced nothing. */
  plan: READ_ONLY_TOOLS.concat(["ask_user_question", "present_plan"]),
  awaiting_question: READ_ONLY_TOOLS.slice(),
  awaiting_approval: READ_ONLY_TOOLS.slice(),
  act: ALL_TOOLS.slice()
};

/* Permitted in every mode, offered only in act.

   complete_task is how a turn ends. Refusing it in a read-only mode
   would make a model that calls it anyway spend a whole extra turn
   before falling back to the plain-text ending at agent-runner.js:394
   — a refusal that costs the user a provider call and changes nothing
   about what got written. It writes nothing, so there is nothing to
   refuse. This is the one place `permits` is wider than `offers`, and
   the invariant `permits ⊇ offers` is asserted in the tests. */
const CONTROL_TOOLS: ToolName[] = ["complete_task"];

const MODES: AgentMode[] = ["chat", "act", "plan", "awaiting_question", "awaiting_approval"];

export function offers(mode: AgentMode | string): ToolName[] {
  const list = OFFERS[mode as AgentMode];
  return (list ?? OFFERS.act).slice();
}

/** The only question tool-registry asks before running anything. */
export function permits(mode: AgentMode | string, tool: ToolName | { name: ToolName } | string): boolean {
  const name = (typeof tool === "string" ? tool : tool?.name) as ToolName | undefined;
  if (!name) return false;
  if (CONTROL_TOOLS.indexOf(name) !== -1) return true;
  return offers(mode).indexOf(name) !== -1;
}

/* Written to be read by the model rather than by us: it says what is
   not allowed AND what to do instead, because a refusal the model
   cannot act on just gets retried verbatim until the turn budget is
   gone. */
export function denialMessage(mode: AgentMode | string, toolName: string): string {
  if (mode === "plan" || mode === "awaiting_approval") {
    return 'Error: "' + toolName + '" cannot run in plan mode. Plan mode inspects and proposes only — ' +
      "nothing is created, changed, installed or deployed until the user approves the plan. " +
      "Use read_file, search_code and list_files to finish the plan, then present it.";
  }
  if (mode === "awaiting_question" || mode === "chat") {
    return 'Error: "' + toolName + '" cannot run while you are answering a question. ' +
      "Answer in plain language from what read_file, search_code and list_files show you. " +
      "If the user wants the change made, they will ask for it.";
  }
  return 'Error: "' + toolName + '" is not permitted in ' + String(mode) + " mode.";
}

/** The schema array for a mode, in the registry's own order. */
export function schemaFor(
  mode: AgentMode | string,
  registry: { schemas: (names?: ToolName[]) => ToolSchema[] }
): ToolSchema[] {
  return registry.schemas(offers(mode));
}

/* ── the mode a run starts in ───────────────────────────────────── */

/** Off until the client echoes a token back. See verifyApproval. */
export function requiresApproval(): boolean {
  return process.env.CODEAGENT_REQUIRE_PLAN_APPROVAL === "1";
}

export interface ResolveInput {
  mode?: string;
  approval?: { ok: boolean } | null;
  isQuestion?: boolean;
}

export function resolve(input: ResolveInput): { mode: AgentMode; reason: string } {
  const o = input || {};
  const approved = !!(o.approval && o.approval.ok);

  // Build mode skips all detection by design — index.js:4755 says so too.
  if (o.mode === "build") return { mode: "act", reason: "build mode was selected" };

  if (o.mode === "plan") {
    if (approved) return { mode: "act", reason: "the user approved this plan" };
    /* AN UNAPPROVED PLAN RUN PLANS. It used to return act — because the
       plan itself was made somewhere else entirely, by a single 700-token
       JSON call on the way in, and by the time a run existed the planning
       was over. That planner never read a file; it was handed the list of
       PATHS and asked to imagine the rest, which is why plan mode answered
       in ten seconds and why its questions could only be plain sentences.

       Now the run is the plan: read-only tools to explore, ask_user_question
       to settle what the code cannot answer, present_plan to end. Approval
       still gates the build, and an approved plan still resolves to act
       above — that half is unchanged. */
    return { mode: "plan", reason: "planning, and the build waits for approval" };
  }

  if (o.isQuestion) return { mode: "awaiting_question", reason: "the prompt reads as a question" };
  return { mode: "act", reason: "default" };
}

/* ── the approval token ─────────────────────────────────────────── */

export const APPROVAL_TTL_MS = 30 * 60 * 1000;

/* Read lazily and never cached: the tests set it per case, and a module
   that snapshotted it at require() time would sign everything with
   whatever the first test happened to export. */
function secret(): string {
  return process.env.CODEAGENT_APPROVAL_SECRET || process.env.JWT_SECRET || "dev-insecure-secret";
}

/** Mirrors run-store.js:66, so one person is one session key in both. */
export function sessionKeyOf(owner: { userId?: string; anonId?: string } | null | undefined): string {
  const o = owner || {};
  return o.userId ? "user:" + o.userId : "anon:" + (o.anonId || "");
}

/* Key-sorted, so a plan re-serialised in a different order is still the
   same plan and a plan whose text moved anywhere is not. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return "{" + Object.keys(obj).sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function planVersionOf(plan: unknown): string {
  return crypto.createHash("sha256").update(canonical(plan ?? {})).digest("hex").slice(0, 16);
}

function sign(payloadB64: string): string {
  return crypto.createHmac("sha256", secret()).update(payloadB64).digest("base64url");
}

export interface IssueApprovalOpts {
  sessionKey: string;
  projectId: string;
  planVersion: string;
  revisionId: string;
  ttlMs?: number;
}

/** @returns `<base64url claims>.<hmac>` */
export function issueApproval(opts: IssueApprovalOpts): string {
  const iat = Date.now();
  const claims: ApprovalClaims = {
    v: 1,
    sid: String(opts.sessionKey || ""),
    pid: String(opts.projectId || ""),
    pv: String(opts.planVersion || ""),
    rev: String(opts.revisionId || "none"),
    iat,
    exp: iat + (Number(opts.ttlMs) || APPROVAL_TTL_MS)
  };
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return body + "." + sign(body);
}

/**
 * Never throws. The reason codes are coarse on purpose — a verifier
 * that reports which of the four bindings failed is a verifier that
 * helps someone guess the other three.
 */
export function verifyApproval(
  token: unknown,
  expected: ApprovalExpectation
): ApprovalResult {
  const e = expected || ({} as ApprovalExpectation);
  const deny = (reason: ApprovalResult["reason"]): ApprovalResult =>
    ({ ok: false, reason, planVersion: null });

  if (!token || typeof token !== "string") return deny("missing");
  const dot = token.indexOf(".");
  if (dot < 1 || dot === token.length - 1) return deny("malformed");

  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const want = Buffer.from(sign(body), "base64url");
  // Lengths must match first: timingSafeEqual throws on a length mismatch.
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return deny("signature");

  let claims: ApprovalClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ApprovalClaims;
  } catch {
    return deny("malformed");
  }
  if (!claims || claims.v !== 1) return deny("malformed");

  const now = Number(e.now) || Date.now();
  if (!(Number(claims.exp) > now)) return deny("expired");
  if (claims.sid !== String(e.sessionKey || "")) return deny("session");
  if (claims.pid !== String(e.projectId || "")) return deny("project");
  if (claims.rev !== String(e.revisionId || "none")) return deny("revision");
  if (e.planVersion != null && claims.pv !== String(e.planVersion)) return deny("plan");

  return { ok: true, reason: "approved", planVersion: claims.pv };
}

export { MODES, OFFERS, CONTROL_TOOLS, ALL_TOOLS, READ_ONLY_TOOLS };
