/* =================================================================
   codeagent/runtime.ts — the seam Phase 1 plugs a real sandbox into
   -----------------------------------------------------------------
   Every runtime (local, E2B, Daytona, ...) implements the same five
   verbs. The seven tools in tools.ts are written against THIS
   interface, never against a specific backend — so swapping the
   local dev runtime for a Firecracker microVM later is a one-file
   change, not a rewrite (docs/CODE-AGENT-PLAN.md §2, §5).

     create()                        -> workspace handle
     writeFile(ws, path, content)    -> void
     readFile(ws, path, from?, to?)  -> string
     listFiles(ws, dir?)             -> string[]      (relative paths)
     run(ws, argv, timeoutMs)        -> {code, stdout, stderr, timedOut}
     snapshot(ws)                    -> {files: [{path, sha256}], at}
     destroy(ws)                     -> void

   `run` takes an ARGV ARRAY, never a shell string — the allowlist in
   tools.ts decides what commands exist at all, and passing argv means
   there is no shell to inject into even for an allowed command.

   Two OPTIONAL extended capabilities (Phase 5, docs/CODE-AGENT-PLAN.md §4),
   present when a runtime can actually back them — daytona-runtime.js has
   both, local-runtime.js has neither:

     startPreview(ws, timeoutMs)     -> {ok, url} | {ok:false, reason}
     domSnapshot(ws, url, timeoutMs) -> {ok, degraded, text, empty}

   tools.ts's dom_snapshot tool checks for `runtime.domSnapshot` and uses
   it when present, falling back to the orchestrator-side Puppeteer path
   otherwise — the runtime, not the tool, decides how "does this route
   actually render" gets answered.

   NOTE ON REACHABILITY: nothing in backend/index.js requires this file
   or anything that registers into it. The only callers are the phase
   demos. Daytona is gone (docs/HOW-IT-WORKS.md §11 — `sandboxAlive` is
   hardcoded false), and local-runtime refuses to run under NODE_ENV=
   production unless CODEAGENT_ALLOW_LOCAL_IN_PROD=1. Treat this as a
   seam waiting for a sandbox, not as something serving traffic.
   ================================================================= */

export interface Workspace {
  id: string;
  /** "local" | "e2b" | "daytona" | ... */
  kind: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SnapshotResult {
  files: Array<{ path: string; sha256: string }>;
  at: string;
}

export interface RuntimeImpl {
  create(...args: unknown[]): Promise<Workspace> | Workspace;
  writeFile(ws: Workspace, path: string, content: string): Promise<void> | void;
  readFile(ws: Workspace, path: string, from?: number, to?: number): Promise<string> | string;
  listFiles(ws: Workspace, dir?: string): Promise<string[]> | string[];
  run(ws: Workspace, argv: string[], timeoutMs: number): Promise<RunResult> | RunResult;
  snapshot(ws: Workspace): Promise<SnapshotResult> | SnapshotResult;
  destroy(ws: Workspace): Promise<void> | void;

  startPreview?(ws: Workspace, timeoutMs?: number): Promise<{ ok: boolean; url?: string; reason?: string }>;
  domSnapshot?(ws: Workspace, url: string, timeoutMs?: number): Promise<{
    ok: boolean; degraded: boolean; text: string; empty?: boolean;
  }>;

  /** Some runtimes carry extra verbs the tools never call. */
  [extra: string]: unknown;
}

const REGISTRY: Record<string, RuntimeImpl> = {};

/** A runtime module registers itself here; kept separate from require()
    order so adding e2b-runtime.js later needs no change to this file. */
export function registerRuntime(kind: string, impl: RuntimeImpl): void {
  REGISTRY[kind] = impl;
}

export function createRuntime(kind: string): RuntimeImpl {
  const impl = REGISTRY[kind];
  if (!impl) {
    const known = Object.keys(REGISTRY);
    throw new Error(
      "no runtime registered for \"" + kind + "\"" +
      (known.length ? " (known: " + known.join(", ") + ")" : " (none registered yet)")
    );
  }
  return impl;
}
