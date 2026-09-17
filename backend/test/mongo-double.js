/* =================================================================
   mongo-double.js — enough of a Db to test code that stores bytes
   -----------------------------------------------------------------
   Not a test itself (no -test suffix, so no runner picks it up): a
   shared fixture for blobs-test.js and uploads-routes-test.js, which
   both need the blob store running for real rather than stubbed. A stub
   would let the two files agree with each other and with nothing else.

   Deliberately small and deliberately strict. It implements only what
   lib/storage/blobs.js actually calls, and throws on an operator it does
   not know rather than silently matching everything — a double that
   quietly returns the wrong rows turns a real bug into a passing test,
   which is worse than having no test.

   It records every projection it was handed, because "head() must not
   read the bytes" is an assertion about the query, not about the answer.
   ================================================================= */
"use strict";

function matches(doc, q) {
  return Object.keys(q || {}).every((k) => {
    const want = q[k];
    if (want && typeof want === "object" && !Array.isArray(want) && !Buffer.isBuffer(want)) {
      if ("$in" in want) return want.$in.includes(doc[k]);
      throw new Error("mongo-double: unsupported operator in " + k + ": " + JSON.stringify(want));
    }
    return doc[k] === want;
  });
}

function project(doc, p) {
  if (!p) return Object.assign({}, doc);
  const keys = Object.keys(p).filter((k) => k !== "_id");
  const including = keys.some((k) => p[k] === 1 || p[k] === true);
  const out = {};
  for (const k of Object.keys(doc)) {
    if (k === "_id") continue;
    const listed = Object.prototype.hasOwnProperty.call(p, k);
    // Mongo forbids mixing the two forms, so one check decides the mode.
    if (including ? (listed && p[k]) : !(listed && !p[k])) out[k] = doc[k];
  }
  return out;
}

function makeCollection(name, log) {
  let rows = [];
  const api = {
    name: name,
    async createIndex() { return name + "_ix"; },
    async findOne(q, opts) {
      log.projections.push({ collection: name, op: "findOne", projection: (opts || {}).projection || null });
      const hit = rows.find((r) => matches(r, q));
      return hit ? project(hit, (opts || {}).projection) : null;
    },
    find(q, opts) {
      let picked = rows.filter((r) => matches(r, q));
      let p = (opts || {}).projection || null;
      const cursor = {
        sort(spec) {
          const k = Object.keys(spec)[0], dir = spec[k] < 0 ? -1 : 1;
          picked = picked.slice().sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * dir);
          return cursor;
        },
        project(pp) { p = pp; return cursor; },
        async toArray() {
          log.projections.push({ collection: name, op: "find", projection: p });
          return picked.map((r) => project(r, p));
        }
      };
      return cursor;
    },
    async countDocuments(q) { return rows.filter((r) => matches(r, q || {})).length; },
    async updateOne(q, update, opts) {
      const i = rows.findIndex((r) => matches(r, q));
      if (i >= 0) {
        if (update.$set) Object.assign(rows[i], update.$set);
        // $setOnInsert is, by definition, not applied to an existing row —
        // that is the whole reason finalize() uses it.
        return { matchedCount: 1, modifiedCount: update.$set ? 1 : 0, upsertedCount: 0 };
      }
      if (!(opts && opts.upsert)) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      rows.push(Object.assign({}, q, update.$setOnInsert || {}, update.$set || {}));
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    },
    async updateMany(q, update) {
      let n = 0;
      for (const r of rows) if (matches(r, q)) { Object.assign(r, update.$set || {}); n++; }
      return { matchedCount: n, modifiedCount: n };
    },
    async deleteOne(q) {
      const i = rows.findIndex((r) => matches(r, q));
      if (i >= 0) rows.splice(i, 1);
      return { deletedCount: i >= 0 ? 1 : 0 };
    },
    async deleteMany(q) {
      const before = rows.length;
      rows = rows.filter((r) => !matches(r, q));
      return { deletedCount: before - rows.length };
    },
    _rows: () => rows,
    _reset: () => { rows = []; }
  };
  return api;
}

function makeDb() {
  const cols = new Map();
  const log = { projections: [] };
  const db = {
    databaseName: "test_db",
    collection(name) {
      if (!cols.has(name)) cols.set(name, makeCollection(name, log));
      return cols.get(name);
    },
    _log: log,
    _reset() { for (const c of cols.values()) c._reset(); log.projections.length = 0; }
  };
  return db;
}

module.exports = { makeDb };
