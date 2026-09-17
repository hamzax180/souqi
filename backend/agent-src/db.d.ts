/* =================================================================
   db.d.ts — the seam, not a module
   -----------------------------------------------------------------
   backend/db.js is the single shared Mongo client for the whole
   platform. The agent never requires it directly — run-store and
   usage take `getMasterDb` by injection so the tests can hand them a
   mock instead. The one exception is the worker process, which is an
   entry point: it has to connect the database before it can inject
   anything.

   withTransaction needs a replica set, which Atlas provides and a bare
   local mongod does not. That is why the tests use the mock rather
   than a real database.

   Emits nothing. See the rootDir note in agent-src/tsconfig.json.
   ================================================================= */

import type { MongoDb } from "./lib/codeagent/mongo";

export function connect(): Promise<MongoDb>;
export function getDb(): MongoDb | null;
export function getMasterDb(): MongoDb | null;
export function close(): Promise<void>;
export function withTransaction<T>(
  fn: (db: MongoDb, session: unknown) => Promise<T>
): Promise<T>;
