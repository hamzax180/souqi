/* =================================================================
   lib/crypto.d.ts — the seam, not a module
   -----------------------------------------------------------------
   backend/lib/crypto.js stays hand-written JavaScript: it is the
   platform's secret envelope, shared with routes that have nothing to
   do with the agent. worker-service uses decryptSecret to open a
   run's BYOK credentials inside the worker, and nothing else.

   Emits nothing. See the rootDir note in agent-src/tsconfig.json.
   ================================================================= */

export function encryptSecret(plaintext: string): string;
export function decryptSecret(envelope: string): string;
