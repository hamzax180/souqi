/* =================================================================
   mongo.ts — the shape of the database handle, loosely
   -----------------------------------------------------------------
   usage and run-store both take their database by injection —
   `init({ getMasterDb })` — rather than requiring backend/db.js, so
   that the tests can hand them a mock (see test/run-store-test.js,
   which implements just enough of a collection to drive them).

   The types here are deliberately loose. Typing the real driver would
   mean either depending on mongodb's own types across the whole
   subsystem, or writing a fake that the hand-rolled test mocks would
   then fail to satisfy — and the mocks are the point: they implement
   the four methods these modules use and nothing else.

   So this describes what the CALLERS use, not what MongoDB offers. It
   is an honest under-description, and the place a wrong assumption
   shows up is a test, not production.
   ================================================================= */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface MongoCursor {
  sort(spec: Record<string, number>): MongoCursor;
  limit(n: number): MongoCursor;
  toArray(): Promise<any[]>;
}

export interface MongoCollection {
  find(query?: any, opts?: any): MongoCursor;
  findOne(query?: any, opts?: any): Promise<any>;
  insertOne(doc: any, opts?: any): Promise<any>;
  updateOne(query: any, update: any, opts?: any): Promise<any>;
  deleteOne(query: any, opts?: any): Promise<any>;
  deleteMany(query: any, opts?: any): Promise<any>;
  countDocuments(query?: any, opts?: any): Promise<number>;
  createIndex(spec: any, opts?: any): Promise<any>;
  aggregate(pipeline: any[], opts?: any): MongoCursor;
  findOneAndUpdate(query: any, update: any, opts?: any): Promise<any>;
}

export interface MongoDb {
  collection(name: string): MongoCollection;
}

/** Returns null when no database is configured. Two of the modules that
    take this treat that as a reason to fall back to memory and one
    treats it as a 503 — deliberately different policies, each stated
    where it is chosen. */
export type GetMasterDb = () => MongoDb | null;
