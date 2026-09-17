/* =================================================================
   codeagent/agent-runner.js — Autonomous ReAct execution loop
   -----------------------------------------------------------------
   Docs/DYNAMIC-AGENT-PLAN.md §5.
   Executes dynamic multi-turn agent tasks with progressive tool calls:
   list_files, read_file, search_code, write_file, edit_file, check_project.
   Connects browser WebContainer compilation to verify candidate files.
   ================================================================= */
import * as runStore from "./run-store";
import * as client from "../ai/client";
import { preflight } from "./preflight";
import { statsFor } from "./diffstat";
import * as scaffoldFiles from "./scaffold-files";
import * as theme from "./theme";
import * as registry from "./tool-registry";
import * as agentState from "./agent-state";
import * as contextManager from "./context/context-manager";
import * as retrieval from "./context/file-retrieval";
import { redact } from "./context/redact";
import type { AgentMode, StopReason, ToolContext } from "./types";
import {
  systemPromptFor,
  buildCodebaseContext,
  codeBudgetChars,
  effortFor,
  buildHistory
} from "./model-loop";

/* eslint-disable @typescript-eslint/no-explicit-any */

/* A provider message's content is a string everywhere in this file, but
   the type allows the content-ARRAY form because vision.ts uses it. One
   narrowing helper rather than a cast at each of the six places that
   read assistant text. */
function textOf(content: unknown): string {
  return typeof content === "string" ? content : "";
}

/* ── retrying a blip, but not a mistake ──────────────────────────
   lib/ai/client.js has a circuit breaker and no retry at all — the only
   two mentions of the word in it are prose in comments. So one
   transient 429 or 503 from the provider failed an entire build, which
   is a bad trade for a wait of half a second.

   It lives HERE rather than in the client on purpose. The client is a
   shared adapter: every route goes through it, and its own tests assert
   how quickly the breaker trips, which a retry changes. This is the
   caller that actually wants retries, so this is where they are until
   there is a reason to move them.

   WHAT IS NOT RETRIED is the point. client.chat already separates a
   provider fault from a `badRequest` — the latter being this process
   sending something the model would not take, which will be refused the
   same way for ever. Retrying that burns the budget to arrive at the
   same answer more slowly. Nor is an aborted call retried: the user
   pressed stop.

   ERROR WITHHOLDING: nothing is reported to the run until the retries
   are spent. A recoverable error that surfaces immediately is a run
   that looks broken while it is in fact recovering. */
const RETRY_BACKOFF_MS = [500, 1500, 4000];

/* One readable line for a tool's outcome, safe to put in an event.
   Redacted, because tool output is the likeliest place in the whole run
   for a key to appear — a .env read back, a config file, a search hit —
   and an event is durable and goes to the browser. */
function firstLineOf(text: unknown): string {
  const first = String(text || "").split("\n")[0] || "";
  return redact(first.slice(0, 160)).text;
}

/* Streaming is on unless it is turned off. CODEAGENT_STREAMING=0 is the
   rollback: it changes the transport and nothing else, because the client
   reassembles a streamed answer into the same shape a whole one has. */
const STREAMING = process.env.CODEAGENT_STREAMING !== "0";

/** How often a run is willing to write its own narration to the database. */
const DELTA_FLUSH_MS = 600;

/**
 * Turn a token stream into events worth storing.
 *
 * Not one event per token. These are persisted and replayed to every
 * reconnecting browser, and a thousand-row turn would cost more to read
 * back than the text is worth — so text is coalesced on a timer.
 *
 * The tool names are not coalesced, because the whole point of them is
 * WHEN they arrive: measured against the live provider, a turn writing a
 * file knows the tool's name 703ms in and finishes generating its
 * arguments at 896ms. Before this the first sign of that turn was the
 * finished write, twenty seconds later on an eight-file build.
 */
function streamWatcher(runId: string, turn: number) {
  let pending = "";
  let lastFlush = Date.now();
  let inFlight: Promise<any> = Promise.resolve();

  /* Serialised, and never awaited by the caller. appendEvent allocates a
     sequence number, so two overlapping writes can collide; and onDelta
     runs inside the read loop, where awaiting a database round trip per
     token would make the stream slower than not streaming at all. */
  const queue = (fn: () => Promise<any>) => {
    inFlight = inFlight.then(fn).catch(() => { /* narration must never fail a run */ });
  };

  const flush = () => {
    if (!pending) return;
    const text = pending;
    pending = "";
    lastFlush = Date.now();
    queue(() => runStore.appendEvent(runId, "assistant_delta", { turn, text: redact(text).text }));
  };

  const watcher = (d: any) => {
    if (d && d.textDelta) {
      pending += d.textDelta;
      if (Date.now() - lastFlush >= DELTA_FLUSH_MS) flush();
    }
    if (d && d.toolName) {
      flush();   // whatever was said before the tool belongs before it
      queue(() => runStore.appendEvent(runId, "tool_intent", { turn, tool: d.toolName, index: d.index }));
    }
  };
  /* The caller settles this after the call returns, so the tail of the
     answer is not left sitting in `pending` until the next turn. */
  watcher.done = async () => { flush(); await inFlight; };
  return watcher;
}

function retryableReason(res: any): string | null {
  if (!res || res.ok) return null;
  if (res.badRequest || res.disabled || res.budgetExceeded) return null;
  if (res.overflow) return null;   // a fit problem; retrying sends the same thing
  /* The ceiling was the run's own remaining time, so a second attempt
     starts with less of it than the first. Retrying here spends what is
     left failing the same way. */
  if (res.ranOutOfTime) return null;
  return String(res.reason || "provider error");
}

export interface ExecuteRunOpts {
  /** Absolute epoch ms. Defaults to CODEAGENT_MAX_RUN_MS from now. */
  deadlineAt?: number;
  /** Aborts the provider call in flight, not just between turns. */
  signal?: AbortSignal;
  history?: any[];
  imagesBlock?: string;
  attachedImages?: Array<{ url?: string }>;
  [k: string]: any;
}

/* The schema lives in tool-registry now, beside the code that runs each
   tool and the gate that decides whether it may. Re-exported under the
   old name because that is what this module has always exported. */
const DYNAMIC_TOOLS_SCHEMA = registry.schemas();

// Pending check-result callbacks (runId -> { resolve, timer })
const pendingCheckWaiters = new Map();

/**
 * Called by index.js when browser WebContainer finishes a compile check.
 *
 * EXPORTED, and it has to be: index.js:5215 calls it on every
 * check-result POST. The TypeScript port dropped the keyword, so that
 * call was a TypeError — which, being uncaught in an Express handler,
 * took the whole process down. The browser saw its in-flight request
 * die and reported "Failed to fetch", naming neither the route nor the
 * reason.
 *
 * Only the in-process path reaches this. A run on the durable worker is
 * verified in the build sandbox and never asks the browser, which is
 * why production builds through the worker were unaffected and this
 * survived being on the critical path.
 */
export function reportCheckResult(runId: string, checkResult: any): boolean {
  const pending = pendingCheckWaiters.get(runId);
  if (!pending) return false;
  pendingCheckWaiters.delete(runId);
  clearTimeout(pending.timer);
  pending.resolve(checkResult);
  return true;
}

/**
 * Detects whether a prompt is an informational question, feedback, compliment,
 * indecision, acknowledgment, or conversational remark rather than an imperative
 * directive to build or edit code.
 */
export function isQuestionOrConversational(prompt: string): boolean {
  if (!prompt || typeof prompt !== "string") return false;
  const p = prompt.trim().toLowerCase();
  const squished = p.replace(/\s+/g, "");

  // 1. Definite imperative build / edit directives:
  // Starts with command verbs like "build a ...", "create an ...", "make a ...", "add a button", etc.
  const isDirectCommand = /^(please\s+)?(build|create|make|add|generate|implement|design|write|code|develop)\s+(a|an|the|me|some|new)\b/i.test(p) ||
    /^(please\s+)?(change|update|fix|remove|delete|replace|style|rewrite|redesign)\s+(the|a|an|this|all|my)\b/i.test(p);
  if (isDirectCommand) return false;

  // 2. Disclaimers, corrections, or telling the agent when to build or not to build:
  // e.g. "build when i tell you build", "i didnt say build yet", "don't build yet", "wait", "hold on", "not yet", "stop"
  const stopOrCorrection = /\b(didn'?t say|don'?t build|don'?t touch|dont touch|never said|not yet|wait|hold on|stop|not now|why are you building|i didn'?t ask|i haven'?t|no wait|dont build|tell you build|when i tell|only when i|build when i|build after|tell you to build|who said build|did i say build|before i told you|before you were asked|without asking)\b/i;
  if (stopOrCorrection.test(p)) return true;

  // 3. Indecision, lack of ideas, or asking for suggestions:
  const indecision = /\b(idk|i don'?t know|not sure|dunno|no idea|have no idea|undecided|any ideas?|suggest something|recommend something|help me decide|what should i build|what do you suggest|give me ideas)\b/i;
  if (indecision.test(p)) return true;

  // 4. Short affirmations, acknowledgments, or single-word reactions (including common slang):
  const shortReactions = /^(ok|okay|k|kk|sure|yes|no|yep|nope|yeah|yea|nah|fine|alright|sweet|bet|true|right|definitely|idk|hmm|hm|bro|bruh|lol|lmao|wdym|wtf|wth|omg|oof|meh|ah|oh|huh|damn|dang|yikes|nice|cool|wow|sup|yo)$/i;
  if (shortReactions.test(p)) return true;

  // 5. Casual conversational remarks, compliments, reactions:
  const casualChat = /\b(you know|you understand|you got it|impressive|smart|genius|cool|awesome|great|haha|lol|lmao|omg|good job|well done|thank you|thanks|thx|nice|wow|super|amazing|wdym|wtf|wth|bruh|bro)\b/i;
  if (casualChat.test(p)) return true;

  // 6. Conversational statements starting with personal pronouns/opinions that are not build commands
  if (/^(i|you|we|it|that|they)\s+(am|are|was|were|think|feel|mean|said|didn'?t|don'?t|didnt|dont|know|thought|see|hear|just|only|already|can|will|started|began|got|never|should)\b/i.test(p)) {
    return true;
  }

  // 7. Questions about capabilities, questions starting with auxiliary verbs:
  // "can you...", "could you...", "do you...", "are you...", "will you...", "is it..."
  if (/^(can you|could you|would you|do you|are you|will you|should you|is it|is there)\b/i.test(p)) {
    if (!/\b(can you|could you|please)\s+(build|create|make|add|generate|write)\s+(a|an|the|me)\b/i.test(p)) {
      return true;
    }
  }

  // 8. Questions: why, what, how, where, who, when, which, or ending with '?'
  const questionPatterns = [
    /^(why|what|how|where|when|who|which)\b/i,
    /\b(why u|why did you|why'd you|why was|why is|why does|why it|how come|how do you)\b/i,
    /\b(what was|what went wrong|what happened|what changed|what did you|what can you)\b/i,
    /\b(explain|tell me|walk me through|can you explain|could you explain)\b/i,
    /\?$/
  ];
  if (questionPatterns.some((pattern) => pattern.test(p))) {
    if (!/^(add|create|make|build|change|update|fix)\s+(a|an|the)\b/i.test(p)) {
      return true;
    }
  }

  // 9. Short conversational expressions or greetings (including elongated words like "heyyyy", "hiiii")
  const conversationalPhrases = [
    /\b(h+e+y+|h+i+|h+e+l+l+o+|h+o+w+d+y+|y+o+|s+u+p+|g+m+|g+n+|g+r+e+e+t+i+n+g+s*|good morning|good evening|good afternoon)\b/i,
    /\b(how are you|how r u|how are u|how you doing|whats up|what's up|how's it going|hows it going)\b/i,
    /\b(who are you|what are you|what is your name)\b/i
  ];
  if (conversationalPhrases.some((pattern) => pattern.test(p))) return true;

  // 10. Single letters or keyboard noise / typos (e.g. "s", "a", "asdf", "zzz")
  // Exclude real domain/subject acronyms (e.g. "ai", "ui", "ux", "db", "vr", "ar", "os", "2d", "3d", "crm", "pos")
  const KNOWN_TECH_WORDS = new Set(["ai","ui","ux","db","vr","ar","os","2d","3d","crm","cms","pos","sql","sms","dns","app"]);
  if (squished.length <= 2 && !KNOWN_TECH_WORDS.has(squished)) {
    return true;
  }
  if (/^(asdf|qwerty|zzz+|hhh+|aaa+|xxx+)$/i.test(squished)) {
    return true;
  }

  return false;
}

/**
 * Runs the autonomous dynamic agent loop for a runId.
 */
export async function executeRun(runId: string, opts: ExecuteRunOpts = {}): Promise<any> {
  const run = await runStore.getRun(runId);
  if (!run) throw new Error("Run not found: " + runId);

  // Materialize starting files from checkpoint 0 or empty
  const latestChk = await runStore.getLatestCheckpoint(runId);
  const currentFiles = Object.assign({}, (latestChk && latestChk.files) || {});
  const turnBaseFiles = Object.assign({}, currentFiles);
  const hasExistingApp = !!currentFiles["src/App.tsx"] || !!currentFiles["index.html"];
  const isBuildMode = String(run.mode || "").toLowerCase() === "build";

  /* The mode is resolved ONCE, here, from the run document — not from
     opts. worker-service.js:109 is a second caller of executeRun and it
     passes run.context as opts, so anything derived from opts would be
     enforced on one path and not the other. The run document is the only
     thing both callers share.

     isQuestionTurn stays as its own name because six later lines read it,
     and keeping it means those lines do not move. */
  const state = agentState.resolve({
    mode: String(run.mode || ""),
    approval: (run.meta && run.meta.approval) || null,
    isQuestion: !isBuildMode && isQuestionOrConversational(run.prompt)
  });
  const isQuestionTurn = state.mode === "awaiting_question";

  /* ONE writer for the terminal transition, and which one depends on who
     called.

     In process on Vercel there is no finalizer, and the route's own
     .then() writes the revision and the turn after this returns. Under
     the durable worker there is one, and it moves the run, the project
     head, the revision, the turn and the usage record together or not at
     all — including the lease-fencing check that a bare updateRun skips.

     This existed and was never called. worker-service built a finalizer,
     passed it in opts, and nothing here ever read it: every exit wrote
     its own status with updateRun and returned an outcome the claim loop
     then discarded. A worker run therefore marked itself `succeeded`
     while the project stayed empty and the chat showed no reply at all —
     found by the first build ever driven through the worker, because the
     in-process path persists elsewhere and hid it. */
  async function settle(status: string, patch: any, outcome: any) {
    const stopReason = outcome && outcome.stopReason;
    if (typeof opts.finalize === "function") {
      let committed: boolean;
      try {
        committed = await opts.finalize(Object.assign({ stopReason }, outcome), status);
      } catch (e: any) {
        /* A conflict is an answer, not a crash. The finalizer throws when
           the project moved under the run, and nothing caught it: the
           throw escaped to the worker's catch, the run was abandoned
           still holding its lease, and the stale sweep later relabelled
           it "the agent worker stopped before finishing" — which is both
           wrong and unactionable. Recorded as what it is, with the files
           kept so the next turn can start from them. */
        const reason = (e && e.message) || "the result could not be committed";
        await runStore.updateRun(runId, {
          status: "partial", phase: "conflict",
          stopReason: "conflict" as StopReason, latestError: reason
        });
        await runStore.appendEvent(runId, "error", { error: reason });
        return Object.assign({}, outcome, {
          ok: false, conflict: true, reason, stopReason: "conflict" as StopReason
        });
      }
      /* It refuses when the lease has moved on. Saying so is the point:
         another worker owns this run, and continuing as though we had
         written the result is how two workers both claim to have. */
      if (!committed) return Object.assign({}, outcome, { fenced: true });
      return outcome;
    }
    await runStore.updateRun(runId, Object.assign({ status, stopReason }, patch));
    return outcome;
  }

  await runStore.updateRun(runId, { status: "running", phase: isQuestionTurn ? "answering" : isBuildMode ? "building" : "planning" });
  await runStore.appendEvent(runId, "stage", {
    id: isBuildMode ? "building" : "planning",
    state: "start",
    detail: isQuestionTurn ? "Thinking..." : isBuildMode ? "Building components..." : "Analyzing requirements..."
  });

  const effort = effortFor(run.effort, run.mode);
  const isPower = effort.tier === "power";

  /* Turns scale with the same ladder rather than a second one written
     here. EFFORT.rounds is 1/2/3/4 repair passes for the single-shot
     engine; this loop spends a turn per tool batch, so it gets four
     turns per round — derived, so the two cannot drift apart the way a
     hardcoded ternary beside them would. */
  const maxTurns = Math.max(4, effort.rounds * 4);

  /* The reply ceiling follows the effort ladder, as a SHARE of the
     window rather than as the ladder's absolute number.

     It used to be 2500 here whatever the user chose — "max" got 5000
     against the ladder's 64000, and "fast" and "balanced" were the same
     2500 as each other, so the slider moved and almost nothing moved
     with it. A ceiling that is too low TRUNCATES, and unlike the
     single-shot engine this loop has no retry-at-double-the-budget to
     catch it: a write_file whose content ran out mid-file is a broken
     file nobody is told about.

     But the ladder's numbers cannot be used raw. EFFORT.maxTokens goes
     up to 64000 and the configured window is 32768 — reserving the
     ladder's top for the reply asks for twice the whole window, and
     client.chat refuses it locally before spending a round trip. So the
     ladder sets WHERE IN the window the reply sits: its top is 40% of
     whatever the model actually has, and the rest of the rungs scale
     from that. Ordering is preserved at any window size, and it is
     always feasible. */
  const windowTokens = client.windowFor("json", isPower ? process.env.AI_JSON_POWER_MODEL : undefined);
  const LADDER_TOP = 64000;   // EFFORT's own ceiling; the share is relative to it
  const MAX_REPLY_SHARE = 0.4;
  const replyTokens = Math.max(
    1500,
    Math.min(effort.maxTokens, Math.floor(windowTokens * MAX_REPLY_SHARE * (effort.maxTokens / LADDER_TOP)))
  );

  /* THE WALL CLOCK.

     The loop used to have none, and its own arithmetic overruns the
     host at every effort level: sixteen turns at a 90-second provider
     timeout is twenty-four minutes, and Vercel terminates the function
     at 300 seconds. Even `fast` can reach 360.

     What made that a lockout rather than a lost result: createRun sets
     activeOwnerKey under a unique index, those keys are released only
     on a TERMINAL transition, and a killed process never makes one. So
     the row stayed `running` for ever and every later build was refused
     with RUN_ALREADY_ACTIVE — pointing at a run the client could no
     longer cancel, because it had already discarded the id.

     So the run finishes ITSELF, early and on purpose, keeping its files
     and saying why. A partial result the user can continue from is a
     different thing from a run that vanished.

     The reserve is what makes the finish possible: checkpointing,
     finalising and emitting the result all have to happen inside it. */
  const AGENT_WALL_MS = Number(process.env.CODEAGENT_MAX_RUN_MS) || 300000;
  const FINISH_RESERVE_MS = Number(process.env.CODEAGENT_FINISH_RESERVE_MS) || 30000;
  const startedAt = Date.now();
  const deadlineAt = Number(opts.deadlineAt) || (startedAt + AGENT_WALL_MS);
  const msLeft = () => deadlineAt - Date.now();

  /* Cancellation used to be noticed only at the TOP of a turn, so a
     stop during a 90-second provider call waited out the call and paid
     for it. client.chat has always accepted a signal; nothing ever gave
     it one. */
  const abort = new AbortController();
  const outer = opts.signal;
  if (outer) {
    if (outer.aborted) abort.abort(outer.reason);
    else outer.addEventListener("abort", () => abort.abort(outer.reason), { once: true });
  }

  /* Budgets asked BEFORE each call rather than recorded after. A run
     whose allowance is gone is exactly the run most likely to keep
     going — a loop that is failing makes more calls, not fewer. */
  const ceiling = {
    maxCostUsd: Number(run.context && run.context.maxCostUsd) || 0,
    maxCalls: maxTurns
  };

  let totalCostUsd = 0;
  /* Reported to the UI, which until now could show elapsed time and
     nothing else about what a turn was actually costing. */
  let totalTokens = 0;
  let calls = 0;

  let messages: client.ChatMessage[] = [
    {
      role: "system",
      content: systemPromptFor(run.mode) +
        "\n\nDYNAMIC AGENT EXECUTION (Effort: " + effort.label + "):\n" +
        (effort.id === "fast"
          ? "You are in Fast mode: solve the task cleanly in as few tool calls as possible. Write the essential files directly.\n"
          : "You have full autonomy to inspect files (`list_files`, `read_file`, `search_code`), create or edit files modularly (`write_file`, `edit_file`), and verify your work (`check_project`).\n") +
        "CRITICAL EXECUTION RULES:\n" +
        (isBuildMode ? "0. BUILD MODE ACTIVE: The user selected Build mode. Directly implement, write, or edit code immediately using write_file and edit_file without extra confirmation or delays.\n" : "") +
        "1. Communicate like a helpful, intelligent human software engineer. Speak naturally like a normal human in conversational tone, answering questions or explaining changes clearly in your message text.\n" +
        "2. If the user is asking a question or seeking an explanation (e.g. 'why did you do that', 'what was the error', 'why did it fail', 'how does this work'), answer them directly and clearly in natural conversational markdown without modifying code. DO NOT invoke write_file or edit_file when answering questions.\n" +
        "3. When code changes or new features are requested, use your tools (write_file, edit_file) to implement the changes cleanly and modularly, then call check_project to verify the build.\n" +
        "4. Always ensure src/App.tsx exists to render the application.\n" +
        "5. When concluding your turn or calling complete_task, always provide a clear, concise summary of what you did: specifically state what components or files were created, what was modified, or what errors/bugs were fixed (e.g. '• Created Hero and Features components\\n• Updated App.tsx layout\\n• Fixed button click handler'). Never return an empty or vague summary."
    }
  ];

  if (opts.history && Array.isArray(opts.history)) {
    messages = messages.concat(buildHistory(opts.history));
  }

  // Include attached images block if provided (URLs and descriptions from vision)
  if (opts.imagesBlock && opts.imagesBlock.trim()) {
    messages.push({ role: "user", content: opts.imagesBlock.trim() });
  }

  /* Include starting codebase if any files exist.

     Both arguments used to be the wrong shape, and both failed silently
     rather than loudly, which is why this survived: codeBudgetChars was
     handed the STRING "balanced" where it wants an options object, so
     o.effort was undefined and every run got the default tier's budget
     whatever the user had selected; and its result — a number — was
     passed where buildCodebaseContext wants { prompt, budget }, so
     o.budget was undefined too and the budget fell back to the flat
     120,000-char cap. A Max run and a Fast run were reading the same
     amount of code. Typing the seam is what surfaced it. */
  const codebaseCtx = buildCodebaseContext(currentFiles, {
    prompt: run.prompt,
    budget: codeBudgetChars({ effort: effort.id, mode: run.mode })
  });
  if (codebaseCtx && codebaseCtx.text && codebaseCtx.text.trim()) {
    messages.push({ role: "user", content: codebaseCtx.text });
  }

  if (hasExistingApp) {
    if (isQuestionTurn) {
      messages.push({
        role: "user",
        content: "User question: " + run.prompt +
          "\n\nCRITICAL INSTRUCTIONS:\n- The user is asking an explanation or question about what was done or an error. Answer them directly and helpfully in conversational markdown.\n- DO NOT edit or create any code files. DO NOT invoke write_file or edit_file.\n- Answer their question like a human software engineer."
      });
    } else {
      messages.push({
        role: "user",
        content: "User message: " + run.prompt +
          "\n\nIf the user is asking a question (such as asking about previous errors, what you did, or how code works), answer them conversationally in your response text without writing code. If they are asking for changes or new features, use your tools to make the changes and verify them."
      });
    }
  } else {
    messages.push({
      role: "user",
      content: "Task: " + run.prompt + "\n\nBegin by creating the required components and src/App.tsx using write_file."
    });
  }

  /* A run that was parked on a question resumes here. The answer goes
     in as its own turn rather than being concatenated onto the original
     prompt — which is what the old clarify flow did, and it meant the
     model saw one sentence somebody had glued together instead of a
     question it asked and a person answering it. */
  const answered = run.meta && run.meta.answeredQuestion;
  if (answered && answered.answers) {
    const lines = Object.entries(answered.answers as Record<string, string>)
      .map(([q, a]) => "  " + q + " -> " + a);
    if (lines.length) {
      messages.push({
        role: "user",
        content: "You asked, and the user answered:\n" + lines.join("\n") +
          "\n\nCarry on from where you stopped. Do not ask this again."
      });
    }
  }

  /* What version of each file the model has actually been shown. Lives
     for the whole run, not the turn, because the stale read it guards
     against happens across turns. */
  const seen: Record<string, string> = {};

  let taskCompleted = false;
  let finalSummary = "";
  let repairedCount = 0;

  /* Where the opening request ends. Everything before this — the system
     prompt, the history, the codebase, the task — is never compacted and
     never dropped, because a run that has shed its own task is a run
     doing something nobody asked for. */
  const headLen = messages.length;

  /* What the summary will be built from if this run gets long enough to
     need one. Tracked as it happens rather than reconstructed from the
     transcript afterwards, because by then the transcript is the thing
     being thrown away. */
  const facts: contextManager.PrepareInput["facts"] = {
    prompt: run.prompt,
    mode: state.mode,
    approvalReason: (run.meta && run.meta.approval && run.meta.approval.reason) || undefined,
    fileHashes: retrieval.hashAll(currentFiles),
    filesWritten: [],
    filesEdited: [],
    errors: [],
    verification: null
  };

  /* Finish cleanly rather than being killed mid-turn. Called at the top
     of each turn and again before each provider call, because one call
     can take ninety seconds and the reserve is thirty. */
  async function finishOnDeadline(turn: number) {
    const diff = statsFor(
      Object.entries(currentFiles).map(([path, content]) => ({ path, content: String(content) })),
      turnBaseFiles
    );
    const detail = "Stopped at the time limit after " +
      Math.round((Date.now() - startedAt) / 1000) + "s. What was built is saved.";
    await runStore.saveCheckpoint(runId, currentFiles, "Deadline reached on step " + turn);
    await runStore.appendEvent(runId, "stage", { id: "turn-" + turn, state: "failed", detail });
    return await settle("partial", { phase: "deadline", latestError: detail }, {
      ok: false, stopReason: "budget_limit" as StopReason, reason: detail,
      files: currentFiles, fileStats: diff, summary: finalSummary || detail, costUsd: totalCostUsd
    });
  }

  for (let turn = 1; turn <= maxTurns; turn++) {
    // Check for cancellation
    const currentRun = await runStore.getRun(runId);
    if (currentRun && currentRun.cancelled) {
      abort.abort(new Error("cancelled by user"));
      await runStore.appendEvent(runId, "stage", { id: "turn-" + turn, state: "cancelled", detail: "Run was cancelled by user." });
      return { ok: false, cancelled: true, stopReason: "cancelled" as StopReason };
    }

    /* No turn is started that cannot also be finished. Starting one with
       twenty seconds left spends a provider call to be killed mid-way
       through writing its result. */
    if (msLeft() <= FINISH_RESERVE_MS) return await finishOnDeadline(turn);

    /* So a sweep can tell a working run from an abandoned one. Cheap,
       and the only signal available for a run that holds no lease. */
    await runStore.touchRun(runId).catch(() => { /* not worth failing a turn */ });

    const hasEntry = !!currentFiles["src/App.tsx"] || !!currentFiles["index.html"];

    await runStore.appendEvent(runId, "stage", {
      id: "turn-" + turn,
      state: "start",
      detail: isQuestionTurn
        ? "Thinking..."
        : ("Step " + turn + " — " + (hasEntry ? "Refining and verifying..." : "Building components..."))
    });

    // If it's an informational question on an existing codebase, restrict tools to read-only
    /* The schema the model SEES. The gate that decides what actually runs
       is registry.dispatch, which asks agentState.permits again — this
       narrowing is a courtesy to the model, not a control. */
    const toolsForTurn = agentState.schemaFor(state.mode, registry);

    // Call model
    const callOpts = {
      route: "json",
      tools: toolsForTurn,
      model: isPower ? process.env.AI_JSON_POWER_MODEL : undefined,
      maxTokens: replyTokens,
      temperature: 0.3,
      /* Never longer than the time actually remaining. A 90-second
         timeout with 40 seconds left is a call guaranteed to be cut off
         by the host rather than by us, and the difference is whether
         anything gets saved. */
      timeoutMs: Math.max(5000, Math.min(90000, msLeft() - FINISH_RESERVE_MS)),
      /* How long the stream may go QUIET, once it has started. The 90s
         above is how long the model has to start answering; it used to
         be how long it had to finish, which on a power model writing
         eight files meant killing a response mid-delivery and telling
         the user it "did not answer". It had answered, for ninety
         seconds. */
      stallMs: Math.max(5000, Math.min(45000, msLeft() - FINISH_RESERVE_MS)),
      /* And a ceiling that is never re-armed, so a trickle cannot
         outlive the run that is waiting for it. */
      hardMs: Math.max(10000, msLeft() - FINISH_RESERVE_MS),
      signal: abort.signal,
      stream: STREAMING,
      onDelta: STREAMING ? streamWatcher(runId, turn) : undefined
    };

    /* Reassembled every call rather than accumulated: measure, then
       shrink old tool output, then summarise the middle, and only then
       let fitConversation drop anything. Its only move is to drop whole
       turns, so everything above it is a turn it does not have to lose. */
    facts.fileHashes = retrieval.hashAll(currentFiles);
    const prepared = await contextManager.prepare({
      messages,
      headLen,
      tools: toolsForTurn,
      route: "json",
      model: callOpts.model,
      maxTokens: callOpts.maxTokens,
      runId,
      facts
    });
    messages = prepared.messages as client.ChatMessage[];

    for (const action of prepared.actions) {
      await runStore.appendEvent(runId, "context", {
        step: action.step, removed: action.removed, detail: action.detail,
        usedTokens: prepared.after.usedTokens, usableTokens: prepared.after.usableTokens
      });
    }

    // Re-checked here: preparing the context can itself take seconds.
    if (msLeft() <= FINISH_RESERVE_MS) return await finishOnDeadline(turn);

    const verdict = contextManager.budget.canSpend({ costUsd: totalCostUsd, calls }, ceiling);
    if (!verdict.ok) {
      await runStore.appendEvent(runId, "stage", {
        id: "turn-" + turn, state: "failed", detail: verdict.detail || "This run reached its limit."
      });
      return await settle("partial", { phase: "budget", latestError: verdict.detail }, {
        ok: false, stopReason: verdict.reason as StopReason, reason: verdict.detail,
        files: currentFiles, costUsd: totalCostUsd
      });
    }
    calls++;

    /* Retried here, and withheld until the retries are spent. */
    let aiRes = await client.chat(Object.assign({}, callOpts, { messages }));
    for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt++) {
      const why = retryableReason(aiRes);
      if (!why) break;
      if (abort.signal.aborted) break;

      /* Never wait past the deadline to retry — a backoff that runs out
         the clock turns a recoverable blip into a dead run. */
      const wait = RETRY_BACKOFF_MS[attempt] as number;
      if (msLeft() - wait <= FINISH_RESERVE_MS) break;

      await runStore.appendEvent(runId, "stage", {
        id: "retry-" + turn + "-" + attempt, state: "start",
        detail: "The model did not answer (" + why.slice(0, 80) + "). Retrying…"
      });
      await new Promise((r) => setTimeout(r, wait));
      if (abort.signal.aborted) break;

      calls++;
      aiRes = await client.chat(Object.assign({}, callOpts, { messages }));
    }
    /* The tail of the answer is still sitting in the watcher's buffer,
       and the retries above share one watcher — so this is after the loop,
       not after each call. */
    if (callOpts.onDelta) await (callOpts.onDelta as any).done();
    totalCostUsd += aiRes.costUsd || 0;
    // Both spellings, because the block is the provider's and they differ.
    totalTokens += Number(aiRes.usage && (aiRes.usage.total_tokens ?? aiRes.usage.totalTokens)) || 0;
    /* One per model call, not per token: this is a number in a status
       line, and a run that wrote its own token counter a thousand times
       would cost more to read back than the counter is worth. */
    if (totalTokens) {
      await runStore.appendEvent(runId, "usage", {
        turn, tokens: totalTokens, costUsd: Number(totalCostUsd.toFixed(6))
      });
    }

    if (!aiRes.ok) {
      await runStore.appendEvent(runId, "error", { error: aiRes.reason || "Model call failed" });
      /* Not "tool_error": no tool ran. The provider refused — a rejected
         key, an exhausted balance, a model that does not exist — and
         calling that a tool failure sends whoever reads the run looking
         in the wrong place. The first worker run died here on a 402 and
         the row said `tool_error` with no stopReason persisted at all.

         Work already written is kept and the run is `partial`, because a
         blip on step five must not throw away four steps of files. Only
         a run that produced nothing is a flat failure. */
      const diff = statsFor(
        Object.entries(currentFiles).map(([path, content]) => ({ path, content: String(content) })),
        turnBaseFiles
      );
      const salvaged = diff.length > 0;
      return await settle(salvaged ? "partial" : "failed", {
        phase: salvaged ? "provider" : "failed", latestError: aiRes.reason
      }, {
        ok: false, reason: aiRes.reason, stopReason: "provider_error" as StopReason,
        files: salvaged ? currentFiles : undefined,
        fileStats: salvaged ? diff : [],
        summary: salvaged ? (finalSummary || aiRes.reason) : undefined,
        costUsd: totalCostUsd
      });
    }

    const assistantMsg = aiRes.message || { role: "assistant", content: "" };
    messages.push(assistantMsg);

    const toolCalls = assistantMsg.tool_calls || [];

    if (!toolCalls.length) {
      // Check if the model wrote code blocks directly in markdown text
      const codeBlockRe = /```(?:[a-zA-Z0-9_-]+)?\s*(?:\/\/\s*([a-zA-Z0-9_\-\.\/]+))?\n([\s\S]*?)```/g;
      let match;
      let extractedAny = false;
      while ((match = codeBlockRe.exec(textOf(assistantMsg.content))) !== null) {
        let path = match[1];
        const code = match[2];
        if (!path) {
          const firstLine = (code.split("\n")[0] || "").trim();
          const pathMatch = /(?:\/\/\s*|\/\*\s*)([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)/.exec(firstLine);
          if (pathMatch) path = pathMatch[1].trim();
          else if (!hasEntry) path = "src/App.tsx";
        }
        if (path && code.trim()) {
          path = path.trim().replace(/^[\\\/]+/, "");
          if (!path.startsWith("src/") && !path.endsWith(".html")) path = "src/" + path;
          currentFiles[path] = code;
          await runStore.appendEvent(runId, "file_written", { path, bytes: code.length });
          await runStore.appendEvent(runId, "stage", { id: "file-" + path, state: "done", detail: "Wrote " + path });
          extractedAny = true;
        }
      }
      if (extractedAny) {
        await runStore.saveCheckpoint(runId, currentFiles, "Step " + turn + " code updates");
        await runStore.appendEvent(runId, "stage", { id: "turn-" + turn, state: "done", detail: "Step " + turn + " completed" });
        if (currentFiles["src/App.tsx"]) {
          taskCompleted = true;
          finalSummary = "Created application components and src/App.tsx.";
          break;
        }
        continue;
      }

      // Natural text response without tools — could be answering a question or providing a summary
      if ((isQuestionTurn || hasEntry) && textOf(assistantMsg.content).trim()) {
        taskCompleted = true;
        finalSummary = textOf(assistantMsg.content).trim();
        await runStore.appendEvent(runId, "stage", {
          id: "turn-" + turn,
          state: "done",
          detail: "Answered: " + (finalSummary.length > 50 ? finalSummary.slice(0, 50) + "…" : finalSummary)
        });
        break;
      }

      if (!hasEntry && !isQuestionTurn) {
        messages.push({
          role: "user",
          content: "You must create src/App.tsx so the application can render. Invoke write_file now."
        });
        await runStore.appendEvent(runId, "stage", { id: "turn-" + turn, state: "done", detail: "Step " + turn + " completed" });
        continue;
      }
    }

    // Execute tool calls in order
    const toolResults: any[] = [];
    let needsBrowserCheck = false;

    /* Every tool call goes through registry.dispatch — one path, and the
       mode is checked before the arguments are even parsed for meaning.

       What this replaces was a 74-line if/else chain that ran whatever
       the model named. It had three defects and they were one defect:
       write_file assigned straight into currentFiles with no path rules
       at all (so src/lib/payments.ts, the server-side price boundary, was
       overwritable); the read-only restriction for question turns was a
       schema filter that the chain never consulted, so an injected write
       ran anyway; and edit_file used text.replace, which silently edits
       the first of however many matches there are.

       dispatch never throws, so a refusal still produces a tool reply
       matched to its tool_call_id. Without that the assistant message
       carries a tool_call with no answer and the NEXT provider call
       fails with a 400 about message pairing — an error about the wrong
       thing entirely. */
    const ctx: ToolContext = {
      mode: state.mode,
      files: currentFiles,
      seen,
      runId,
      imageUrls: (opts.attachedImages || []).map((i) => String(i && i.url || "")).filter(Boolean),
      emit: (type, payload) => runStore.appendEvent(runId, type, payload)
    };

    /* NOT parallelised, and that is a finding rather than an omission.

       read_file, list_files and search_code look like the obvious
       candidates — the registry even marks them readOnly. But all three
       are SYNCHRONOUS functions over ctx.files, an object already in
       memory. There is no I/O to overlap, so Promise.all over them buys
       nothing and costs a second code path.

       The reference agent parallelises its equivalents because they
       shell out, touch a real filesystem and call networks. If a tool
       here ever does actual I/O — a real sandbox read, an MCP call —
       this is the place to revisit, and readOnly is the flag to key on. */
    for (const tc of toolCalls) {
      const fnName = (tc.function && tc.function.name) || "";
      let args: any = {};
      try {
        args = JSON.parse((tc.function && tc.function.arguments) || "{}");
      } catch {
        toolResults.push({ role: "tool", tool_call_id: tc.id, content: "Error: malformed JSON arguments" });
        continue;
      }

      await runStore.appendEvent(runId, "tool_start", { tool: fnName, args });

      const toolStartedAt = Date.now();
      const outcome = await registry.dispatch(fnName, args, ctx);
      toolResults.push({ role: "tool", tool_call_id: tc.id, content: outcome.content });

      /* Every tool_start now has a tool_result. It did not: writes closed
         with file_written, commands with a command/done, refusals with
         tool_denied — and a successful read_file, list_files, search_code
         or check_project closed with nothing at all. The terminal printed
         those starting and never finishing.

         The id is here so a line in the transcript can be traced to the
         row that still holds its full output; `bytes` is measured before
         the turn budget trims anything, so it reports what the tool
         actually produced. */
      await runStore.appendEvent(runId, "tool_result", {
        tool: fnName,
        toolCallId: tc.id,
        ok: outcome.ok !== false,
        ms: Date.now() - toolStartedAt,
        bytes: String(outcome.content || "").length,
        detail: firstLineOf(outcome.content)
      });

      /* A refusal is worth recording separately from the tool result the
         model sees. Frontend code.html:2701 is an else-if chain, so an
         event name it does not know is ignored rather than breaking it. */
      if (!outcome.ok) {
        await runStore.appendEvent(runId, "tool_denied", { tool: fnName, reason: outcome.content });
      }

      if (!outcome.ok) (facts.errors as string[]).push(outcome.content.slice(0, 220));

      const effects = outcome.effects;
      if (effects) {
        if (effects.wrotePath && !(facts.filesWritten as string[]).includes(effects.wrotePath)) {
          (facts.filesWritten as string[]).push(effects.wrotePath);
        }
        if (effects.editedPath && !(facts.filesEdited as string[]).includes(effects.editedPath)) {
          (facts.filesEdited as string[]).push(effects.editedPath);
        }
        if (effects.checkRequested) needsBrowserCheck = true;
        if (effects.commandRequested) {
          /* Goes to the build sandbox on the deploy plane, which is the
             only thing on the platform holding a Docker socket. The
             worker injects `checkProject`; the in-process path on
             Vercel has no verifier at all, and says so rather than
             pretending the command ran and returned nothing. */
          const send = opts.checkProject;
          if (typeof send !== "function") {
            toolResults[toolResults.length - 1] = {
              role: "tool", tool_call_id: tc.id,
              content: "Error: no build sandbox is configured for this run, so commands cannot be run. " +
                "Use read_file and search_code instead, and check_project to compile."
            };
          } else {
            const cmd = effects.commandRequested.command;
            await runStore.appendEvent(runId, "command", {
              command: cmd, reason: effects.commandRequested.reason, state: "start"
            });
            let out: any;
            try {
              out = await send(scaffoldFiles.withScaffold(currentFiles), {
                runId, checkId: "cmd_" + runId + "_" + turn,
                sourceHash: "", command: cmd
              });
            } catch (e) {
              out = { ok: false, infra: true, reason: (e as Error).message };
            }
            const text = out && out.refused
              ? "Error: " + out.error
              : out && out.infra
                ? "The sandbox could not run that: " + (out.reason || out.error || "unavailable") +
                  " — this is an infrastructure problem, not a defect in the code."
                : "$ " + cmd + "\n" +
                  "exit " + (out && out.exitCode !== undefined ? out.exitCode : (out && out.ok ? 0 : 1)) + "\n" +
                  String((out && out.raw) || "(no output)").slice(-8000);

            await runStore.appendEvent(runId, "command", {
              command: cmd, state: out && out.ok ? "done" : "failed",
              exitCode: out && out.exitCode, ms: out && out.ms,
              output: String((out && out.raw) || "").slice(-4000)
            });
            toolResults[toolResults.length - 1] = { role: "tool", tool_call_id: tc.id, content: text };
            if (out && out.infra) (facts.errors as string[]).push("sandbox unavailable: " + (out.reason || ""));
          }
        }

        if (effects.questionAsked && effects.questionAsked.length) {
          /* Persisted BEFORE the loop is left, so a process that dies
             on the next line has still asked the question and the run
             can be answered by whichever instance takes the request. */
          const questionId = "aq_" + runId + "_" + turn;
          const parked = await runStore.askQuestion(runId, {
            id: questionId, questions: effects.questionAsked, askedAt: new Date().toISOString()
          });
          if (parked) {
            await runStore.appendEvent(runId, "question", {
              id: questionId, questions: effects.questionAsked
            });
            await runStore.recordStep(runId, { turn, toolCalls, toolResults, costUsd: aiRes.costUsd || 0 });
            return {
              ok: false, stopReason: "awaiting_question" as StopReason,
              questionId, questions: effects.questionAsked,
              files: currentFiles, costUsd: totalCostUsd
            };
          }
          /* askQuestion refuses when one is already outstanding. Telling
             the model that is better than parking twice. */
          toolResults[toolResults.length - 1] = {
            role: "tool", tool_call_id: tc.id,
            content: "Error: this run is already waiting on a question. Answer that one first."
          };
        }
        if (effects.completed) {
          taskCompleted = true;
          finalSummary = effects.summary || textOf(assistantMsg.content) || "Task completed successfully.";
        }
      }
    }

    // Save checkpoint of current files after tool batch
    /* One budget across the whole batch. Each result is already capped
       on its own, but several under the cap still add up past it — and
       the request has to fit before any of this is worth having.
       Spent in call order, so the first answers stay whole. */
    /* Copied BEFORE the budget trims anything, because this is the copy
       micro-compaction points at when it clears a result out of the
       request. Recorded after trimming, the "raw record" was the trimmed
       text, and recovering it returned the same truncated thing the
       pointer was offering to replace. */
    const rawToolResults = (toolResults as any[]).map((r) => Object.assign({}, r));

    const budgeted = registry.applyTurnBudget(toolResults as any);
    if (budgeted.trimmed) {
      await runStore.appendEvent(runId, "context", {
        step: "tool-budget",
        detail: budgeted.trimmed + " tool result" + (budgeted.trimmed === 1 ? "" : "s") +
          " trimmed to fit this turn's output budget"
      });
    }
    toolResults.length = 0;
    toolResults.push(...(budgeted.results as any[]));

    await runStore.saveCheckpoint(runId, currentFiles, "Step " + turn + " tool updates");
    await runStore.recordStep(runId, {
      turn, toolCalls, toolResults: rawToolResults, costUsd: aiRes.costUsd || 0
    });

    messages = messages.concat(toolResults);

    // If check_project was requested or if we are nearing the cap with written files
    if (needsBrowserCheck) {
      await runStore.updateRun(runId, { status: "waiting_for_check" });
      const fullBundle = scaffoldFiles.withScaffold(currentFiles);
      const buildSeedHex = (run.meta && run.meta.seedHex) || "#0f172a";
      const buildType = (run.meta && run.meta.buildType) || "website";
      const buildTheme = theme.forBuild({ buildType, seedHex: buildSeedHex });
      fullBundle["tailwind.config.js"] = theme.tailwindConfig(buildTheme);
      fullBundle["__souqi_fonts__"] = theme.fontLinkTag(buildTheme);

      await runStore.appendEvent(runId, "check_needed", { files: fullBundle });

      // Wait for browser WebContainer feedback (up to 45 seconds)
      const checkOutcome = await new Promise<any>((resolve) => {
        const timer = setTimeout(() => {
          pendingCheckWaiters.delete(runId);
          resolve({ ok: true, errors: [], note: "Browser check timed out; continuing." });
        }, 45000);
        pendingCheckWaiters.set(runId, { resolve, timer });
      });

      await runStore.updateRun(runId, { status: "running" });

      if (checkOutcome.ok) {
        messages.push({ role: "user", content: "Browser check PASSED. The app compiles and renders cleanly." });
        await runStore.appendEvent(runId, "stage", { id: "check-" + turn, state: "done", detail: "Verification passed" });
        if (currentFiles["src/App.tsx"] || currentFiles["index.html"]) {
          taskCompleted = true;
          finalSummary = finalSummary || "Verification passed. Built and verified all components cleanly.";
          break;
        }
      } else {
        const errSummary = (checkOutcome.errors || []).map((e: any) => (e.file ? e.file + ":" + e.line + " — " + e.message : e.message)).join("\n");
        repairedCount += ((checkOutcome.errors && checkOutcome.errors.length) || 1);
        messages.push({ role: "user", content: "Browser check FAILED with these errors:\n" + errSummary + "\n\nFix them using edit_file or write_file." });
        await runStore.appendEvent(runId, "stage", { id: "check-" + turn, state: "failed", detail: "Compilation errors detected — repairing..." });
      }
    }

    await runStore.appendEvent(runId, "stage", {
      id: "turn-" + turn,
      state: "done",
      detail: "Step " + turn + " completed (" + (toolCalls.length ? toolCalls.length + " action" + (toolCalls.length === 1 ? "" : "s") : "verified") + ")"
    });

    if (taskCompleted) break;
  }

  // Auto-recovery: If src/App.tsx is missing but components exist, connect them into App.tsx
  if (!currentFiles["src/App.tsx"] && !currentFiles["index.html"]) {
    const compFiles = Object.keys(currentFiles).filter(f => f.startsWith("src/components/") && (f.endsWith(".tsx") || f.endsWith(".jsx")));
    if (compFiles.length > 0) {
      const imports = [];
      const tags: string[] = [];
      for (const cf of compFiles) {
        const baseName = (cf.split("/").pop() as string).replace(/\.(tsx|jsx)$/, "");
        const cleanName = baseName.charAt(0).toUpperCase() + baseName.slice(1).replace(/[^a-zA-Z0-9]/g, "");
        imports.push(`import { ${cleanName} } from './components/${baseName}';`);
        tags.push(`      <${cleanName} />`);
      }
      currentFiles["src/App.tsx"] = `${imports.join("\n")}\n\nexport default function App() {\n  return (\n    <div className="min-h-screen bg-zinc-950 text-white selection:bg-amber-400 selection:text-black">\n${tags.join("\n")}\n    </div>\n  );\n}\n`;
      await runStore.appendEvent(runId, "file_written", { path: "src/App.tsx", bytes: currentFiles["src/App.tsx"].length });
      await runStore.appendEvent(runId, "stage", { id: "file-src/App.tsx", state: "done", detail: "Wrote src/App.tsx" });
    }
  }

  // Final validation
  const finalGate = preflight(currentFiles);
  const diff = statsFor(
    Object.entries(currentFiles).map(([path, content]) => ({ path, content: String(content) })),
    turnBaseFiles
  );

  // Synthesize a descriptive summary of what was created, edited, or fixed
  const isGeneric = !finalSummary ||
    finalSummary === "Task completed successfully." ||
    finalSummary === "Build completed successfully." ||
    finalSummary === "Verification passed. Built and verified all components cleanly." ||
    finalSummary.trim().length < 12;

  if (isGeneric && !isQuestionTurn) {
    const created = diff.filter(d => d.isNew).map(d => (d.path || "").split("/").pop()).filter(Boolean);
    const modified = diff.filter(d => !d.isNew && (d.added || d.removed)).map(d => (d.path || "").split("/").pop()).filter(Boolean);
    const parts = [];
    if (created.length) {
      parts.push("Created " + created.join(", "));
    }
    if (modified.length) {
      parts.push("Updated " + modified.join(", "));
    }
    if (repairedCount > 0) {
      parts.push("resolved " + repairedCount + " build issue" + (repairedCount === 1 ? "" : "s"));
    }
    if (parts.length) {
      finalSummary = parts.join("; ") + ". Cleanly compiled and verified in preview.";
    } else {
      finalSummary = "Completed updates for “" + (run.prompt.length > 50 ? run.prompt.slice(0, 50) + "…" : run.prompt) + "”. Cleanly verified.";
    }
  }

  const fullBundle = scaffoldFiles.withScaffold(currentFiles);
  const buildSeedHex = (run.meta && run.meta.seedHex) || "#0f172a";
  const buildType = (run.meta && run.meta.buildType) || "website";
  const buildTheme = theme.forBuild({ buildType, seedHex: buildSeedHex });
  fullBundle["tailwind.config.js"] = theme.tailwindConfig(buildTheme);
  fullBundle["__souqi_fonts__"] = theme.fontLinkTag(buildTheme);

  await runStore.appendEvent(runId, "result", {
    ok: true,
    summary: finalSummary,
    files: currentFiles,
    fileContents: fullBundle,
    fileStats: diff,
    costUsd: totalCostUsd,
    warnings: finalGate.soft || []
  });

  /* Eight outcomes, and they are not the same event. A turn_limit keeps
     its files and can be continued; a tool_error may not have any. The
     old shape said ok:true either way and left the caller to guess from
     whether `summary` looked finished. */
  const stopReason: StopReason = taskCompleted ? "completed" : "turn_limit";

  return await settle("succeeded", { costUsd: totalCostUsd, phase: "completed" }, {
    ok: true,
    stopReason,
    files: currentFiles,
    fileContents: fullBundle,
    summary: finalSummary,
    fileStats: diff,
    costUsd: totalCostUsd
  });
}

export { DYNAMIC_TOOLS_SCHEMA };
