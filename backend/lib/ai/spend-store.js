"use strict";
/* =================================================================
   ai/spend-store.js — the monthly AI budget, counted where every
   instance can see it
   -----------------------------------------------------------------
   AI_MONTHLY_BUDGET_USD is the platform's last line of defence against
   a runaway bill. Until this existed it was enforced against a plain
   object in lib/ai/client.js, and nothing ever supplied the recordSpend
   hook that was meant to persist it — init's own docstring still called
   it "plug in the audit collection later".

   Production is Vercel. Many lambdas run at once and are recycled
   constantly, so each one counted its own spend from zero and the cap
   was reached by nobody. This is the same failure middleware/rateLimit.js
   describes for request limits, which is why this is deliberately the
   same shape as its Mongo tier: one indexed document per month, updated
   with $inc, read back with a short cache in front of it.

   Mongo rather than anything new: the app is already connected to it, it
   is shared across every instance by definition, and one $inc per model
   call is nothing next to the call it is measuring.

   Rows are kept, not expired. A monthly spend history is the thing you
   want when a bill surprises you, and twelve documents a year is free.
   ================================================================= */

const COLLECTION = "aispend";

let getDb = null;
let indexReady = null;

/** @param {object} deps - { getMasterDb } */
function init(deps) {
  getDb = (deps && deps.getMasterDb) || null;
  indexReady = null;
}

function col() {
  const db = getDb && getDb();
  if (!db) return null;
  const c = db.collection(COLLECTION);
  if (!indexReady) {
    indexReady = c.createIndex({ month: 1 }, { unique: true }).catch(() => {});
  }
  return c;
}

/**
 * Book spend against a month.
 *
 * Route-level totals go in as well as the grand total. The grand total is
 * what the breaker reads; the per-route numbers are what tells you which
 * route ran away, which is the first question anyone asks.
 */
async function add(month, route, usd) {
  const c = col();
  if (!c) return false;
  const amount = Number(usd);
  if (!isFinite(amount) || amount <= 0) return false;
  const inc = { totalUsd: amount };
  // Route names come from CONFIG.routes, not from a request — but this is
  // a key in a Mongo update, so it is checked anyway.
  if (/^[a-z][a-z0-9_-]{0,31}$/i.test(String(route || ""))) {
    inc["routes." + route] = amount;
  }
  await c.updateOne(
    { month: String(month) },
    { $inc: inc, $set: { updatedAt: new Date() } },
    { upsert: true }
  );
  return true;
}

/**
 * The whole deployment's spend for a month.
 *
 * Throws rather than returning 0 when the database is unreachable. The
 * caller in client.js keeps its last known total on a throw; a 0 here
 * would read as "nothing spent yet" and reopen the budget.
 */
async function total(month) {
  const c = col();
  if (!c) throw new Error("spend store unavailable");
  const row = await c.findOne({ month: String(month) }, { projection: { _id: 0, totalUsd: 1 } });
  return (row && Number(row.totalUsd)) || 0;
}

/** Everything on record, newest month first — for the admin meter. */
async function history(limit) {
  const c = col();
  if (!c) return [];
  return c.find({}, { projection: { _id: 0 } })
    .sort({ month: -1 })
    .limit(Math.max(1, Math.min(Number(limit) || 12, 120)))
    .toArray();
}

module.exports = { init, add, total, history, COLLECTION };
