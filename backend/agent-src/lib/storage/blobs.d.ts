/* =================================================================
   lib/storage/blobs.d.ts — the seam, not a module
   -----------------------------------------------------------------
   backend/lib/storage/blobs.js stays hand-written JavaScript: it is
   where an uploaded photo's bytes live until S3 exists, and it is
   shared with the upload routes, publish and the export.

   The worker needs init() to wire it, and persist() only indirectly —
   uploads.attachToProject fires it through the onPersist hook, so the
   expiry on the row and the expiry on the bytes are cleared by one
   call rather than two that can drift.

   Emits nothing. See the rootDir note in agent-src/tsconfig.json.
   ================================================================= */

export function init(deps: {
  getMasterDb: () => unknown;
  getBlobDb?: () => unknown;
}): void;

export function persist(keys: string[]): Promise<{ persisted: number }>;

/* The worker creates them at boot. Its own comment says why they were
   missing in production; this line is what lets it say so in TypeScript. */
export function ensureIndexes(): Promise<void>;
