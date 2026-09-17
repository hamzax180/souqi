"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.READ_ONLY_TOOLS = exports.ALL_TOOLS = exports.CONTROL_TOOLS = exports.OFFERS = exports.MODES = exports.APPROVAL_TTL_MS = void 0;
exports.offers = offers;
exports.permits = permits;
exports.denialMessage = denialMessage;
exports.schemaFor = schemaFor;
exports.requiresApproval = requiresApproval;
exports.resolve = resolve;
exports.sessionKeyOf = sessionKeyOf;
exports.planVersionOf = planVersionOf;
exports.issueApproval = issueApproval;
exports.verifyApproval = verifyApproval;
const crypto = __importStar(require("crypto"));
/* The model's SURFACE: which tools each mode puts in the schema.

   awaiting_question is byte-identical to the filter it replaces
   (agent-runner.js:331-333), deliberately. Three of the eight cases in
   agent-runner-test.js assert on exactly that list, and a mode machine
   that quietly widened the model's surface would be a worse bug than
   the one this file was written to fix. */
const READ_ONLY_TOOLS = ["read_file", "search_code", "list_files"];
exports.READ_ONLY_TOOLS = READ_ONLY_TOOLS;
const ALL_TOOLS = [
    "write_file", "edit_file", "read_file", "list_files",
    "search_code", "check_project", "run_command", "ask_user_question", "complete_task"
];
exports.ALL_TOOLS = ALL_TOOLS;
/* Plan mode is offered the question tool and the other read-only modes
   are not, and that asymmetry is the point of plan mode: working out
   what to build is exactly when a consequential unknown shows up, and
   the alternative to asking is guessing and writing the guess into a
   plan the user then approves. A mode that is ANSWERING a question does
   not get to ask one back — that is a loop. */
const OFFERS = {
    chat: [],
    plan: READ_ONLY_TOOLS.concat(["ask_user_question"]),
    awaiting_question: READ_ONLY_TOOLS.slice(),
    awaiting_approval: READ_ONLY_TOOLS.slice(),
    act: ALL_TOOLS.slice()
};
exports.OFFERS = OFFERS;
/* Permitted in every mode, offered only in act.

   complete_task is how a turn ends. Refusing it in a read-only mode
   would make a model that calls it anyway spend a whole extra turn
   before falling back to the plain-text ending at agent-runner.js:394
   — a refusal that costs the user a provider call and changes nothing
   about what got written. It writes nothing, so there is nothing to
   refuse. This is the one place `permits` is wider than `offers`, and
   the invariant `permits ⊇ offers` is asserted in the tests. */
const CONTROL_TOOLS = ["complete_task"];
exports.CONTROL_TOOLS = CONTROL_TOOLS;
const MODES = ["chat", "act", "plan", "awaiting_question", "awaiting_approval"];
exports.MODES = MODES;
function offers(mode) {
    const list = OFFERS[mode];
    return (list ?? OFFERS.act).slice();
}
/** The only question tool-registry asks before running anything. */
function permits(mode, tool) {
    const name = (typeof tool === "string" ? tool : tool?.name);
    if (!name)
        return false;
    if (CONTROL_TOOLS.indexOf(name) !== -1)
        return true;
    return offers(mode).indexOf(name) !== -1;
}
/* Written to be read by the model rather than by us: it says what is
   not allowed AND what to do instead, because a refusal the model
   cannot act on just gets retried verbatim until the turn budget is
   gone. */
function denialMessage(mode, toolName) {
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
function schemaFor(mode, registry) {
    return registry.schemas(offers(mode));
}
/* ── the mode a run starts in ───────────────────────────────────── */
/** Off until the client echoes a token back. See verifyApproval. */
function requiresApproval() {
    return process.env.CODEAGENT_REQUIRE_PLAN_APPROVAL === "1";
}
function resolve(input) {
    const o = input || {};
    const approved = !!(o.approval && o.approval.ok);
    // Build mode skips all detection by design — index.js:4755 says so too.
    if (o.mode === "build")
        return { mode: "act", reason: "build mode was selected" };
    if (o.mode === "plan") {
        if (approved)
            return { mode: "act", reason: "the user approved this plan" };
        if (requiresApproval())
            return { mode: "awaiting_approval", reason: "this plan has not been approved" };
        /* Enforcement off: proceed, but the run document records that it
           proceeded unapproved, so the logs can answer "how often would
           this have refused?" before anyone turns the flag on. */
        return { mode: "act", reason: "unapproved, and approval is not enforced yet" };
    }
    if (o.isQuestion)
        return { mode: "awaiting_question", reason: "the prompt reads as a question" };
    return { mode: "act", reason: "default" };
}
/* ── the approval token ─────────────────────────────────────────── */
exports.APPROVAL_TTL_MS = 30 * 60 * 1000;
/* Read lazily and never cached: the tests set it per case, and a module
   that snapshotted it at require() time would sign everything with
   whatever the first test happened to export. */
function secret() {
    return process.env.CODEAGENT_APPROVAL_SECRET || process.env.JWT_SECRET || "dev-insecure-secret";
}
/** Mirrors run-store.js:66, so one person is one session key in both. */
function sessionKeyOf(owner) {
    const o = owner || {};
    return o.userId ? "user:" + o.userId : "anon:" + (o.anonId || "");
}
/* Key-sorted, so a plan re-serialised in a different order is still the
   same plan and a plan whose text moved anywhere is not. */
function canonical(value) {
    if (Array.isArray(value))
        return "[" + value.map(canonical).join(",") + "]";
    if (value && typeof value === "object") {
        const obj = value;
        return "{" + Object.keys(obj).sort()
            .map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
    }
    return JSON.stringify(value === undefined ? null : value);
}
function planVersionOf(plan) {
    return crypto.createHash("sha256").update(canonical(plan ?? {})).digest("hex").slice(0, 16);
}
function sign(payloadB64) {
    return crypto.createHmac("sha256", secret()).update(payloadB64).digest("base64url");
}
/** @returns `<base64url claims>.<hmac>` */
function issueApproval(opts) {
    const iat = Date.now();
    const claims = {
        v: 1,
        sid: String(opts.sessionKey || ""),
        pid: String(opts.projectId || ""),
        pv: String(opts.planVersion || ""),
        rev: String(opts.revisionId || "none"),
        iat,
        exp: iat + (Number(opts.ttlMs) || exports.APPROVAL_TTL_MS)
    };
    const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    return body + "." + sign(body);
}
/**
 * Never throws. The reason codes are coarse on purpose — a verifier
 * that reports which of the four bindings failed is a verifier that
 * helps someone guess the other three.
 */
function verifyApproval(token, expected) {
    const e = expected || {};
    const deny = (reason) => ({ ok: false, reason, planVersion: null });
    if (!token || typeof token !== "string")
        return deny("missing");
    const dot = token.indexOf(".");
    if (dot < 1 || dot === token.length - 1)
        return deny("malformed");
    const body = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1), "base64url");
    const want = Buffer.from(sign(body), "base64url");
    // Lengths must match first: timingSafeEqual throws on a length mismatch.
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want))
        return deny("signature");
    let claims;
    try {
        claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    }
    catch {
        return deny("malformed");
    }
    if (!claims || claims.v !== 1)
        return deny("malformed");
    const now = Number(e.now) || Date.now();
    if (!(Number(claims.exp) > now))
        return deny("expired");
    if (claims.sid !== String(e.sessionKey || ""))
        return deny("session");
    if (claims.pid !== String(e.projectId || ""))
        return deny("project");
    if (claims.rev !== String(e.revisionId || "none"))
        return deny("revision");
    if (e.planVersion != null && claims.pv !== String(e.planVersion))
        return deny("plan");
    return { ok: true, reason: "approved", planVersion: claims.pv };
}
