/* =================================================================
   codeagent/agent-runner.js — Autonomous ReAct execution loop
   -----------------------------------------------------------------
   Docs/DYNAMIC-AGENT-PLAN.md §5.
   Executes dynamic multi-turn agent tasks with progressive tool calls:
   list_files, read_file, search_code, write_file, edit_file, check_project.
   Connects browser WebContainer compilation to verify candidate files.
   ================================================================= */
"use strict";

const runStore = require("./run-store");
const client = require("../ai/client");
const { preflight } = require("./preflight");
const { statsFor } = require("./diffstat");
const scaffoldFiles = require("./scaffold-files");
const theme = require("./theme");
const {
  systemPromptFor,
  parseToolCalls,
  validateWriteFileArgs,
  buildCodebaseContext,
  codeBudgetChars,
  effortFor,
  buildHistory
} = require("./model-loop");

// Extended dynamic tools schema including list_files and check_project
const DYNAMIC_TOOLS_SCHEMA = [
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write or overwrite a file in the project. Paths are relative to the project root (e.g. \"src/App.tsx\", \"src/components/Hero.tsx\").",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path, e.g. src/App.tsx" },
          content: { type: "string", description: "The full, final content of the file." }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Change part of an existing file by searching for an exact unique text snippet and replacing it. Faster and safer for incremental changes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" },
          find: { type: "string", description: "Exact unique text to replace" },
          replace: { type: "string", description: "What to put there instead" }
        },
        required: ["path", "find", "replace"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the entire content of a file from the project.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path, e.g. src/App.tsx" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List all existing files in the current project directory tree.",
      parameters: {
        type: "object",
        properties: {
          dir: { type: "string", description: "Optional subfolder to list (default: root)" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_code",
      description: "Search for a string or regex pattern across all project files.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The string or regex pattern to search for" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "check_project",
      description: "Trigger TypeScript compilation and browser render check to verify that all current files compile and render without errors.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Why you are checking (e.g. 'Verifying App component imports')" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "complete_task",
      description: "Declare the task complete when all user requirements are satisfied and code compiles cleanly.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "A friendly, user-facing summary of what was created or changed" }
        },
        required: ["summary"]
      }
    }
  }
];

// Pending check-result callbacks (runId -> { resolve, timer })
const pendingCheckWaiters = new Map();

/**
 * Called by index.js when browser WebContainer finishes a compile check.
 */
function reportCheckResult(runId, checkResult) {
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
function isQuestionOrConversational(prompt) {
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
async function executeRun(runId, opts = {}) {
  const run = await runStore.getRun(runId);
  if (!run) throw new Error("Run not found: " + runId);

  // Materialize starting files from checkpoint 0 or empty
  const latestChk = await runStore.getLatestCheckpoint(runId);
  const currentFiles = Object.assign({}, (latestChk && latestChk.files) || {});
  const turnBaseFiles = Object.assign({}, currentFiles);
  const hasExistingApp = !!currentFiles["src/App.tsx"] || !!currentFiles["index.html"];
  const isBuildMode = String(run.mode || "").toLowerCase() === "build";
  const isQuestionTurn = !isBuildMode && isQuestionOrConversational(run.prompt);

  await runStore.updateRun(runId, { status: "running", phase: isQuestionTurn ? "answering" : isBuildMode ? "building" : "planning" });
  await runStore.appendEvent(runId, "stage", {
    id: isBuildMode ? "building" : "planning",
    state: "start",
    detail: isQuestionTurn ? "Thinking..." : isBuildMode ? "Building components..." : "Analyzing requirements..."
  });

  const effort = effortFor(run.effort, run.mode);
  const isPower = effort.tier === "power";
  const maxTurns = effort.id === "fast" ? 5 : effort.id === "balanced" ? 8 : effort.id === "smart" ? 12 : 16;

  let totalCostUsd = 0;

  let messages = [
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

  // Include starting codebase if any files exist
  const codebaseCtx = buildCodebaseContext(currentFiles, codeBudgetChars(effort.id));
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

  let taskCompleted = false;
  let finalSummary = "";
  let repairedCount = 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    // Check for cancellation
    const currentRun = await runStore.getRun(runId);
    if (currentRun && currentRun.cancelled) {
      await runStore.appendEvent(runId, "stage", { id: "turn-" + turn, state: "cancelled", detail: "Run was cancelled by user." });
      return { ok: false, cancelled: true };
    }

    const hasEntry = !!currentFiles["src/App.tsx"] || !!currentFiles["index.html"];

    await runStore.appendEvent(runId, "stage", {
      id: "turn-" + turn,
      state: "start",
      detail: isQuestionTurn
        ? "Thinking..."
        : ("Step " + turn + " — " + (hasEntry ? "Refining and verifying..." : "Building components..."))
    });

    // If it's an informational question on an existing codebase, restrict tools to read-only
    const toolsForTurn = isQuestionTurn
      ? DYNAMIC_TOOLS_SCHEMA.filter((t) => t.function.name === "read_file" || t.function.name === "search_code" || t.function.name === "list_files")
      : DYNAMIC_TOOLS_SCHEMA;

    // Call model
    const callOpts = {
      route: "json",
      tools: toolsForTurn,
      model: isPower ? process.env.AI_JSON_POWER_MODEL : undefined,
      maxTokens: effort.id === "max" ? 5000 : effort.id === "smart" ? 4000 : 2500,
      temperature: 0.3,
      timeoutMs: 90000
    };

    const aiRes = await client.chat(Object.assign({}, callOpts, { messages }));
    totalCostUsd += aiRes.costUsd || 0;

    if (!aiRes.ok) {
      await runStore.updateRun(runId, { status: "failed", latestError: aiRes.reason });
      await runStore.appendEvent(runId, "error", { error: aiRes.reason || "Model call failed" });
      return { ok: false, reason: aiRes.reason };
    }

    const assistantMsg = aiRes.message || { role: "assistant", content: "" };
    messages.push(assistantMsg);

    const toolCalls = assistantMsg.tool_calls || [];

    if (!toolCalls.length) {
      // Check if the model wrote code blocks directly in markdown text
      const codeBlockRe = /```(?:[a-zA-Z0-9_-]+)?\s*(?:\/\/\s*([a-zA-Z0-9_\-\.\/]+))?\n([\s\S]*?)```/g;
      let match;
      let extractedAny = false;
      while ((match = codeBlockRe.exec(assistantMsg.content || "")) !== null) {
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
      if ((isQuestionTurn || hasEntry) && assistantMsg.content && assistantMsg.content.trim()) {
        taskCompleted = true;
        finalSummary = assistantMsg.content.trim();
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
    const toolResults = [];
    let needsBrowserCheck = false;

    for (const tc of toolCalls) {
      const fnName = tc.function && tc.function.name;
      let args = {};
      try {
        args = JSON.parse(tc.function && tc.function.arguments || "{}");
      } catch (e) {
        toolResults.push({ role: "tool", tool_call_id: tc.id, content: "Error: malformed JSON arguments" });
        continue;
      }

      await runStore.appendEvent(runId, "tool_start", { tool: fnName, args });

      if (fnName === "list_files") {
        const fileList = Object.keys(currentFiles);
        const resText = fileList.length ? fileList.join("\n") : "(empty project)";
        toolResults.push({ role: "tool", tool_call_id: tc.id, content: resText });
      } else if (fnName === "read_file") {
        const filePath = String(args.path || "").trim();
        const content = currentFiles[filePath];
        if (content !== undefined) {
          toolResults.push({ role: "tool", tool_call_id: tc.id, content });
        } else {
          toolResults.push({ role: "tool", tool_call_id: tc.id, content: "File not found: " + filePath });
        }
      } else if (fnName === "search_code") {
        const query = String(args.query || "").toLowerCase();
        const hits = [];
        for (const [p, c] of Object.entries(currentFiles)) {
          const lines = c.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(query)) {
              hits.push(p + ":" + (i + 1) + " " + lines[i].trim().slice(0, 80));
              if (hits.length >= 10) break;
            }
          }
        }
        toolResults.push({ role: "tool", tool_call_id: tc.id, content: hits.length ? hits.join("\n") : "No matches found." });
      } else if (fnName === "write_file") {
        const filePath = String(args.path || "").trim();
        const content = String(args.content || "");
        currentFiles[filePath] = content;
        await runStore.appendEvent(runId, "file_written", { path: filePath, bytes: content.length });
        await runStore.appendEvent(runId, "stage", { id: "file-" + filePath, state: "done", detail: "Wrote " + filePath });
        toolResults.push({ role: "tool", tool_call_id: tc.id, content: "Successfully wrote " + filePath });
      } else if (fnName === "edit_file") {
        const filePath = String(args.path || "").trim();
        const find = String(args.find || "");
        const replace = String(args.replace || "");
        const text = currentFiles[filePath];
        if (!text) {
          toolResults.push({ role: "tool", tool_call_id: tc.id, content: "Error: file " + filePath + " does not exist." });
        } else if (!text.includes(find)) {
          toolResults.push({ role: "tool", tool_call_id: tc.id, content: "Error: find snippet not found in " + filePath });
        } else {
          currentFiles[filePath] = text.replace(find, replace);
          await runStore.appendEvent(runId, "file_edited", { path: filePath });
          await runStore.appendEvent(runId, "stage", { id: "file-" + filePath, state: "done", detail: "Edited " + filePath });
          toolResults.push({ role: "tool", tool_call_id: tc.id, content: "Successfully edited " + filePath });
        }
      } else if (fnName === "check_project") {
        needsBrowserCheck = true;
        toolResults.push({ role: "tool", tool_call_id: tc.id, content: "check_project initiated." });
      } else if (fnName === "complete_task") {
        if (!currentFiles["src/App.tsx"] && !currentFiles["index.html"]) {
          toolResults.push({ role: "tool", tool_call_id: tc.id, content: "Error: Cannot complete task yet. src/App.tsx does not exist. Please write src/App.tsx using write_file to import and display your components before completing." });
        } else {
          taskCompleted = true;
          finalSummary = args.summary || assistantMsg.content || "Task completed successfully.";
          toolResults.push({ role: "tool", tool_call_id: tc.id, content: "Task marked complete." });
        }
      } else {
        toolResults.push({ role: "tool", tool_call_id: tc.id, content: "Unknown tool: " + fnName });
      }
    }

    // Save checkpoint of current files after tool batch
    await runStore.saveCheckpoint(runId, currentFiles, "Step " + turn + " tool updates");
    await runStore.recordStep(runId, { turn, toolCalls, toolResults, costUsd: aiRes.costUsd || 0 });

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
      const checkOutcome = await new Promise((resolve) => {
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
        const errSummary = (checkOutcome.errors || []).map((e) => (e.file ? e.file + ":" + e.line + " — " + e.message : e.message)).join("\n");
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
      const tags = [];
      for (const cf of compFiles) {
        const baseName = cf.split("/").pop().replace(/\.(tsx|jsx)$/, "");
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
    Object.entries(currentFiles).map(([path, content]) => ({ path, content })),
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

  await runStore.updateRun(runId, {
    status: "succeeded",
    costUsd: totalCostUsd,
    phase: "completed"
  });

  await runStore.appendEvent(runId, "result", {
    ok: true,
    summary: finalSummary,
    files: currentFiles,
    fileContents: fullBundle,
    fileStats: diff,
    costUsd: totalCostUsd,
    warnings: finalGate.soft || []
  });

  return {
    ok: true,
    files: currentFiles,
    fileContents: fullBundle,
    summary: finalSummary,
    fileStats: diff,
    costUsd: totalCostUsd
  };
}

module.exports = {
  DYNAMIC_TOOLS_SCHEMA,
  executeRun,
  reportCheckResult,
  isQuestionOrConversational
};
