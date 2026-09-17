/* =================================================================
   codeagent/tool-registry.ts — one place a tool name is interpreted
   -----------------------------------------------------------------
   This replaces the if/else chain at agent-runner.js:419-492, which
   had three defects that were all the same defect: the chain ran the
   tool the model named without anyone having agreed the tool was
   allowed to run.

     - write_file did `currentFiles[args.path] = content` with no
       validation at all. No `..` check, no src/ confinement, no
       PROTECTED_PATHS. src/lib/payments.ts — the server-side price
       boundary — was overwritable by a model on the live path.
       agent-runner.js:20 imported validateWriteFileArgs and never
       called it.

     - the read-only restriction for question turns was a schema
       filter (agent-runner.js:331). The chain never checked the mode,
       so a write_file the model emitted anyway ran anyway. That is
       the prompt-injection case: the instruction can arrive inside a
       file the model just read.

     - edit_file used text.replace(find, replace), which takes the
       FIRST of however many matches there are. Three matches meant
       silently editing the wrong one.

   Validation is not reimplemented here. validateWriteFileArgs and
   applyEditFileArgs in model-loop.js are the boundary — they are
   tested by 135 assertions, one of which parses PROTECTED_PATHS out
   of that file's source text — so this calls them. What is new is
   that something calls them at all on this path, and that a mode is
   consulted first.

   dispatch() NEVER THROWS. Every refusal comes back as a tool result
   the model can read. A thrown refusal would leave an assistant
   tool_call with no matching tool reply, and the next provider call
   fails with a 400 about message pairing rather than about the thing
   that actually went wrong.
   ================================================================= */

import { validateWriteFileArgs, applyEditFileArgs } from "./model-loop";
import * as agentState from "./agent-state";
import { hashOf } from "./context/file-retrieval";
import type {
  ToolContext, ToolEntry, ToolName, ToolOutcome, ToolSchema
} from "./types";

/* Copied verbatim from agent-runner.js:28-128. A test asserts this is
   deep-equal to what that file exported, because the point of moving
   it was to gate the tools, not to change which tools exist. */
const SCHEMAS: ToolSchema[] = [
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
      name: "ask_user_question",
      description:
        "Ask the user to decide something you cannot decide for them, and stop until they answer. " +
        "Use this ONLY when the choice is consequential and the answer is not already in the project " +
        "files, the conversation, or the project's remembered rules — check those first. A question " +
        "the user has effectively already answered costs them a round trip and reads as not listening. " +
        "Good: which payment provider, whether prices include tax, what the business is actually called. " +
        "Bad: anything about colour, spacing or wording, which you should choose and let them correct.",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            description: "1-4 questions. Ask everything you need in one go rather than in a series.",
            items: {
              type: "object",
              properties: {
                question: { type: "string", description: "The question, in full. Ends with a question mark." },
                header: { type: "string", description: "A 1-3 word label for the chip, e.g. \"Payments\" or \"Currency\"." },
                options: {
                  type: "array",
                  description: "2-4 distinct choices. Do not add an \"other\" option — the user always has one.",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string", description: "1-5 words. What the user picks." },
                      description: { type: "string", description: "What choosing this means, and its trade-off." }
                    },
                    required: ["label", "description"]
                  }
                },
                multiSelect: { type: "boolean", description: "True when the choices are not mutually exclusive." }
              },
              required: ["question", "header", "options"]
            }
          }
        },
        required: ["questions"]
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

function schemaOf(name: ToolName): ToolSchema {
  const found = SCHEMAS.find((s) => s.function.name === name);
  if (!found) throw new Error("tool-registry: no schema for " + name);
  return found;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

async function emit(ctx: ToolContext, type: string, payload: Record<string, unknown>): Promise<void> {
  if (ctx.emit) await ctx.emit(type, payload);
}

/* ── the seven ──────────────────────────────────────────────────── */

const TOOLS: ToolEntry[] = [
  {
    name: "write_file",
    readOnly: false,
    schema: schemaOf("write_file"),
    async run(args, ctx) {
      // Throws on every refusal; dispatch turns that into a tool result.
      const { path, content } = validateWriteFileArgs(args, { imageUrls: ctx.imageUrls ?? [] });
      ctx.files[path] = content;
      // The model wrote it, so it knows this version — no stale-read refusal.
      if (ctx.seen) ctx.seen[path] = hashOf(content);
      await emit(ctx, "file_written", { path, bytes: content.length });
      await emit(ctx, "stage", { id: "file-" + path, state: "done", detail: "Wrote " + path });
      return { ok: true, content: "Successfully wrote " + path, effects: { wrotePath: path } };
    }
  },
  {
    name: "edit_file",
    readOnly: false,
    schema: schemaOf("edit_file"),
    async run(args, ctx) {
      /* applyEditFileArgs validates the path, refuses a missing file,
         refuses zero matches, and — the case this path used to get
         wrong — refuses MORE THAN ONE match instead of taking the
         first. It also applies the same two content rewrites a write
         gets, because an edit can introduce a grid-cols-1 or an
         invented image URL exactly as a write can. */
      const probe = validateEditPathish(args);
      const current = ctx.files[probe];

      /* READ BEFORE EDIT, and the same read.

         The candidate tree is edited in memory as the run goes, so a
         file the model read on turn two is not necessarily the file it
         is editing on turn nine — its own later write may have replaced
         it. applyEditFileArgs would then find the anchor missing and say
         "copy it exactly as it appears", which is true and useless,
         because the model DID copy it exactly as it appeared at the time.

         Refusing with the reason is what lets it recover: re-read, then
         edit. Only enforced when there IS a recorded read; an edit to a
         file the model has not read is the existing behaviour and
         applyEditFileArgs still has the last word on it. */
      if (ctx.seen && typeof current === "string") {
        const sawAt = ctx.seen[probe];
        if (sawAt && sawAt !== hashOf(current)) {
          return {
            ok: false,
            content: 'Error: "' + probe + '" has changed since you read it — most likely you wrote to it ' +
              "yourself later in this run. Call read_file on it again and base the edit on what comes back."
          };
        }
      }

      const { path, content } = applyEditFileArgs(args, current, { imageUrls: ctx.imageUrls ?? [] });
      ctx.files[path] = content;
      if (ctx.seen) ctx.seen[path] = hashOf(content);
      await emit(ctx, "file_edited", { path });
      await emit(ctx, "stage", { id: "file-" + path, state: "done", detail: "Edited " + path });
      return { ok: true, content: "Successfully edited " + path, effects: { editedPath: path } };
    }
  },
  {
    name: "read_file",
    readOnly: true,
    schema: schemaOf("read_file"),
    /* No path rules on the read tools, on purpose. They iterate an
       in-memory object that holds only this run's candidate files —
       there is no filesystem behind them for a traversal to reach, so
       a containment check here would refuse nothing that could have
       happened and would only differ from what agent-runner did
       before. The write tools are where the boundary belongs. */
    run(args, ctx) {
      const path = str(args.path).trim();
      const content = ctx.files[path];
      if (content === undefined) return { ok: true, content: "File not found: " + path };
      /* Remember WHICH version the model was shown. edit_file compares
         against this, so an anchor written from a stale read is refused
         rather than applied to a file that has moved on. */
      if (ctx.seen) ctx.seen[path] = hashOf(content);
      return { ok: true, content };
    }
  },
  {
    name: "list_files",
    readOnly: true,
    schema: schemaOf("list_files"),
    run(_args, ctx) {
      const names = Object.keys(ctx.files);
      return { ok: true, content: names.length ? names.join("\n") : "(empty project)" };
    }
  },
  {
    name: "search_code",
    readOnly: true,
    schema: schemaOf("search_code"),
    run(args, ctx) {
      const query = str(args.query).toLowerCase();
      const hits: string[] = [];
      outer:
      for (const [p, c] of Object.entries(ctx.files)) {
        const lines = c.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? "";
          if (line.toLowerCase().includes(query)) {
            hits.push(p + ":" + (i + 1) + " " + line.trim().slice(0, 80));
            /* The old loop's `break` only left the INNER loop, so a
               query matching 10 times in one file and once in another
               still went on to scan every remaining file. Same output,
               less work — and the label says which loop is meant. */
            if (hits.length >= 10) break outer;
          }
        }
      }
      return { ok: true, content: hits.length ? hits.join("\n") : "No matches found." };
    }
  },
  {
    name: "check_project",
    /* Not read-only: it blocks the run for up to 45 seconds and asks a
       browser to build. Plan mode must not be able to spend that. */
    readOnly: false,
    schema: schemaOf("check_project"),
    run() {
      return { ok: true, content: "check_project initiated.", effects: { checkRequested: true } };
    }
  },
  {
    name: "ask_user_question",
    /* Writes nothing, so readOnly — but it is the one tool whose whole
       effect is on the RUN rather than on the files: it parks the run
       and the turn loop stops. See agent-runner, which persists the
       question before it returns. */
    readOnly: true,
    schema: schemaOf("ask_user_question"),
    run(args) {
      const raw = Array.isArray(args.questions) ? args.questions : [];
      const questions = raw.slice(0, 4).map((q: any, i: number) => {
        const options = (Array.isArray(q && q.options) ? q.options : [])
          .slice(0, 4)
          .map((o: any) => ({
            label: str(o && o.label).slice(0, 60),
            description: str(o && o.description).slice(0, 240)
          }))
          .filter((o: { label: string }) => o.label);
        return {
          id: "q" + (i + 1),
          question: str(q && q.question).slice(0, 400),
          header: str(q && q.header).slice(0, 24),
          options,
          multiSelect: !!(q && q.multiSelect)
        };
      }).filter((q: { question: string }) => q.question);

      if (!questions.length) {
        return { ok: false, content: 'Error: ask_user_question needs at least one question with text.' };
      }
      /* Two options or none. One option is not a choice, and a model
         that offers one is usually stating a decision it should have
         just taken. */
      for (const q of questions) {
        if (q.options.length === 1) {
          return {
            ok: false,
            content: 'Error: "' + q.header + '" offers a single option, which is not a choice. ' +
              "Give 2-4 distinct options, or none at all if the answer is free text."
          };
        }
      }

      return {
        ok: true,
        content: "Asked the user " + questions.length + " question" + (questions.length === 1 ? "" : "s") +
          ". The run is paused until they answer.",
        effects: { questionAsked: questions }
      };
    }
  },
  {
    name: "complete_task",
    readOnly: true,
    schema: schemaOf("complete_task"),
    run(args, ctx) {
      if (!ctx.files["src/App.tsx"] && !ctx.files["index.html"]) {
        return {
          ok: false,
          content: "Error: Cannot complete task yet. src/App.tsx does not exist. " +
            "Please write src/App.tsx using write_file to import and display your components before completing."
        };
      }
      return {
        ok: true,
        content: "Task marked complete.",
        effects: { completed: true, summary: str(args.summary) }
      };
    }
  }
];

/* applyEditFileArgs needs the file's CURRENT text, which means knowing
   the path before it has validated the path. Normalise the same way it
   does (model-loop.js:1023 — backslashes to forward, trimmed) and let
   it do the real refusing; a wrong guess here just looks up a key that
   is not there, and it throws the proper "does not exist yet" error. */
function validateEditPathish(args: Record<string, unknown>): string {
  return str(args.path).trim().replace(/\\/g, "/");
}

const BY_NAME = new Map<string, ToolEntry>(TOOLS.map((t) => [t.name, t]));

export function names(): ToolName[] {
  return TOOLS.map((t) => t.name);
}

export function byName(name: string): ToolEntry | undefined {
  return BY_NAME.get(name);
}

/** The schema array, in the registry's own order. No argument = all. */
export function schemas(only?: ToolName[]): ToolSchema[] {
  if (!only) return SCHEMAS.slice();
  const wanted = new Set<string>(only);
  return SCHEMAS.filter((s) => wanted.has(s.function.name));
}

/**
 * The single gate. Returns a result for every input, including the bad
 * ones — see the header for why it must not throw.
 */
export async function dispatch(
  name: string,
  rawArgs: unknown,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const entry = byName(name);
  // Same wording the old chain used, so nothing downstream has to change.
  if (!entry) return { ok: false, content: "Unknown tool: " + name };

  /* THE GATE. Asked before the arguments are even looked at, because a
     write in plan mode is refused whether or not its arguments were
     valid — and because this is the check the schema filter could only
     pretend to make. */
  if (!agentState.permits(ctx.mode, entry.name)) {
    return { ok: false, content: agentState.denialMessage(ctx.mode, entry.name) };
  }

  const args: Record<string, unknown> =
    rawArgs && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>) : {};

  try {
    if (entry.validate) entry.validate(args, ctx);
    return await entry.run(args, ctx);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, content: "Error: " + message };
  }
}

export { TOOLS, SCHEMAS };
