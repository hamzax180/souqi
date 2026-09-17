/* =================================================================
   Souqi backend — MongoDB connection

   A single shared client/db, lazily connected on first use, and safe to
   call concurrently from a serverless runtime (Vercel), where this
   module is re-evaluated per cold start and many requests can race the
   very first connect().
   ================================================================= */
const { MongoClient } = require("mongodb");

let client = null;
let db = null;
// The in-flight connect(), cached so concurrent callers await ONE
// handshake instead of each opening their own client. Without this, a
// burst of requests against a cold instance opens a burst of clients —
// which is how a hosted Atlas cluster's connection limit gets exhausted
// by a site with barely any traffic.
let connecting = null;

/** The database name, resolved from DB_NAME, else the URI's own path,
    else a default. Atlas connection strings frequently carry no path
    (…mongodb.net/?retryWrites=true), and client.db(undefined) silently
    binds to "test" rather than failing — a wrong-database bug that
    looks exactly like an empty database. */
function resolveDbName(uri) {
  if (process.env.DB_NAME) return process.env.DB_NAME;
  try {
    const afterHost = uri.split("://")[1] || "";
    const path = afterHost.split("/")[1] || "";
    const name = path.split("?")[0];
    if (name) return decodeURIComponent(name);
  } catch (e) { /* fall through to the default */ }
  // Changed from the legacy "merveks_sap" only once every document had
  // been copied across and counted against the original. On its own this
  // line moves nothing: it points at a different, empty database, which
  // presents as "everything disappeared" rather than as a rename.
  return "souqi";
}

async function connect() {
  if (db) return db;
  if (connecting) return connecting;

  const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
  const name = resolveDbName(uri);

  connecting = (async () => {
    const c = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5000,
      // A serverless instance handles very few concurrent requests, so a
      // large pool is wasted sockets multiplied by every warm instance.
      maxPoolSize: Number(process.env.MONGO_MAX_POOL || 10),
      minPoolSize: 0
    });
    await c.connect();
    const d = c.db(name);
    await d.command({ ping: 1 }); // confirm the connection is actually live
    client = c;
    db = d;
    console.log("✓ MongoDB connected →", name);
    return d;
  })().catch((e) => {
    // Don't cache a failed attempt — a later request should be free to
    // retry (the cluster may simply have been waking up).
    connecting = null;
    throw e;
  });

  return connecting;
}

function getDb() {
  if (!db) throw new Error("Database not connected — call connect() first.");
  return db;
}

/** Returns the master DB instance, or null if not yet connected. Safe for middleware use. */
function getMasterDb() {
  return db || null;
}

/**
 * A sibling database on the SAME client — currently only the blob store.
 *
 * Image bytes are megabytes each and are read once and never queried. Left
 * in the master database they share WiredTiger's cache with projects,
 * sessions and agent runs, so a handful of photo views evicts the working
 * set that every request depends on. A separate database keeps them out of
 * it while costing no extra connection: the pool, the credentials and the
 * handshake are all the one this module already made.
 *
 * Null before connect(), exactly like getMasterDb, because callers must
 * keep tolerating "no database yet" rather than throwing at import time.
 */
function getSiblingDb(suffix) {
  if (!client || !db) return null;
  return client.db(db.databaseName + "_" + String(suffix || "").replace(/[^a-z0-9_]/gi, ""));
}

async function close() {
  if (client) await client.close();
  client = null;
  db = null;
  connecting = null;
}

async function withTransaction(fn) {
  if (!client) throw new Error("Database not connected");
  const session = client.startSession();
  try { return await session.withTransaction(() => fn(db, session)); }
  finally { await session.endSession(); }
}

module.exports = { connect, getDb, getMasterDb, getSiblingDb, close, withTransaction };
