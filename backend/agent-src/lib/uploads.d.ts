/* =================================================================
   lib/uploads.d.ts — the seam, not a module
   -----------------------------------------------------------------
   backend/lib/uploads.js stays hand-written JavaScript: it is the
   platform's record of what someone attached, shared with routes that
   have nothing to do with the agent.

   The worker needs exactly two things from it. init(), because the
   worker is an entry point and has to wire its own dependencies; and
   attachToProject, because an upload carries a 24h expiry until
   something builds with it — and on the durable path the worker is the
   only thing that knows the build succeeded.

   Emits nothing. See the rootDir note in agent-src/tsconfig.json.
   ================================================================= */

export function init(deps: {
  getMasterDb: () => unknown;
  onPersist?: (keys: string[]) => unknown;
}): void;

export function attachToProject(
  uploadIds: string[], projectId: string
): Promise<{ attached: number; keys: string[] }>;
