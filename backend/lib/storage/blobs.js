/* =================================================================
   blobs.js — where an uploaded image's bytes actually live
   -----------------------------------------------------------------
   S3 is implemented and, on this deployment, configured nowhere: there
   is not one S3_* variable in the production environment, so
   s3.isConfigured() is false and /api/uploads/sign has been answering
   503. Image upload was not degraded, it was off.

   So the bytes fall back to the database the platform already runs on,
   behind one seam, until a bucket exists. The whole design rests on a
   single invariant:

       NOTHING THE FALLBACK WRITES NAMES THE FALLBACK.

   newKey() and publicUrl() delegate to s3.js unconditionally, so a row
   stored in Mongo carries the same u/<32 hex>.<ext> key and the same URL
   an S3 row would. Reads check the database first and fall through to
   the bucket. That is what makes turning S3 on later a configuration
   change with no backfill and no broken URLs, rather than a migration —
   and those URLs are baked permanently into published customer source,
   so there is no second chance at it.

   This module owns BYTES and nothing else. The type allowlist, the
   quota, the magic-byte sniff and the delete-on-mismatch all stay in
   uploads-routes.js, which is where the security model is written down.
   It is deliberately not given a presign-shaped API: presigning is an S3
   concept and making Mongo impersonate it would buy nothing.
   ================================================================= */
"use strict";

const crypto = require("crypto");
const s3 = require("./s3");

/* Vercel refuses a function RESPONSE over about 4.5MB, and every view of
   every image on a published site comes back through /api/img/*. So the
   cap on this path is set by egress, not by Mongo's 16MB document limit —
   a larger image could be stored perfectly well and then never served.

   Note the irony against uploads-routes.js's own comment: the old 2MB cap
   existed to keep a base64 data URL inside a JSON request body, and
   direct-to-bucket removed the reason for it. This puts a cap of the same
   order back for the opposite reason — the response side, not the request
   side. Do not "restore" it to 10MB; images would start failing to render
   at exactly the sizes phones produce. */
const MAX_BYTES_DB = Number(process.env.UPLOADS_MAX_BYTES_DB) || 2 * 1024 * 1024;
const MAX_BYTES_S3 = Number(process.env.UPLOADS_MAX_BYTES) || 10 * 1024 * 1024;

/* 1 MiB, not 3. Vercel's REQUEST cap is ~4.5MB so 3MB would fit — but
   with a 2MB ceiling above, a 3MB part means every real upload is a
   single part and the multi-part path never executes in production. A
   dormant path rots, and the day the cap is raised is the worst possible
   day to discover it. At 1 MiB every ordinary upload exercises it. */
const PART_BYTES = Number(process.env.UPLOADS_PART_BYTES) || 1024 * 1024;

/* A half-uploaded part is expensive to keep and worthless to anyone; the
   400-byte metadata row it belongs to is neither, which is why these two
   clocks are deliberately different (uploads.js keeps 24h). */
const PART_TTL_MS = 2 * 60 * 60 * 1000;

/* Matches the metadata row's pending TTL exactly, and is cleared at the
   same moment by persist(). Without it, an upload that verifies but is
   never built with leaks its bytes for ever while its row vanishes at 24h
   — an orphan nothing points at and no admin view can see. */
const BLOB_TTL_MS = 24 * 60 * 60 * 1000;

let getDb = () => null;

/**
 * @param {object} deps
 * @param {function} deps.getMasterDb  kept for the uploads.js/projects.js convention
 * @param {function} [deps.getBlobDb]  the sibling database the bytes belong in
 */
function init(deps) {
  // Prefers the sibling database, falls back to master so a caller that
  // only has getMasterDb (a test, a script) still works.
  getDb = deps.getBlobDb || deps.getMasterDb || (() => null);
}

const blobsCol = () => { const d = getDb(); return d ? d.collection("blobs") : null; };
const partsCol = () => { const d = getDb(); return d ? d.collection("blob_parts") : null; };

async function ensureIndexes() {
  const d = getDb();
  if (!d) return;
  try {
    await d.collection("blobs").createIndex({ key: 1 }, { unique: true });
    await d.collection("blobs").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    // Unique on (key, index) is what makes a retried part overwrite itself
    // instead of arriving twice — see putPart.
    await d.collection("blob_parts").createIndex({ key: 1, index: 1 }, { unique: true });
    await d.collection("blob_parts").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  } catch (e) { /* indexes are an optimisation, never a hard dependency */ }
}

/**
 * Which store is in play.
 *
 * "" means neither, and the 503 in /sign stays honest rather than becoming
 * a confusing success that stores nothing.
 *
 * There is deliberately NO in-memory fallback here, unlike uploads.js. On
 * Vercel two parts of one upload land on two different lambda instances,
 * so an in-memory part store would stitch a silently truncated file — a
 * corrupt image is worse than a refused one.
 */
function backend() {
  const forced = String(process.env.BLOB_BACKEND || "auto").toLowerCase();
  if (forced === "s3") return s3.isConfigured() ? "s3" : "";
  if (forced === "db") return getDb() ? "db" : "";
  if (s3.isConfigured()) return "s3";
  return getDb() ? "db" : "";
}

const available = () => backend() !== "";
const maxBytes = () => (backend() === "s3" ? MAX_BYTES_S3 : MAX_BYTES_DB);
const partBytes = () => PART_BYTES;

/* Delegated, unconditionally, and this is the line the migration hangs
   on. A key minted while the bytes are in Mongo is indistinguishable from
   one minted against a bucket, so no stored row has to be rewritten when
   the bucket appears. */
const newKey = (ext) => s3.newKey(ext);
const publicUrl = (key, origin) => s3.publicUrl(key, origin);

const etagOf = (sha) => '"' + String(sha || "").slice(0, 32) + '"';

/* Buffer FIRST, and the order is the whole point.
   The driver hands binary back as a Mongo Binary, whose .buffer is the
   bytes — but a plain Node Buffer has a .buffer too, and it is the
   allocation POOL behind it, not the value. Testing for .buffer first
   therefore returns up to 8KB of unrelated pool for anything that was
   already a Buffer, which reads as a file that grew in storage: a 32-byte
   image coming back 8192 bytes long. */
function toBuffer(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v && v.buffer) return Buffer.from(v.buffer);
  return Buffer.from(v || []);
}

/**
 * How the client should send the bytes.
 *
 * S3 gets the presigned PUT it always got, plus an additive `mode` so an
 * older cached client that ignores it keeps working unchanged. The db path
 * returns no putUrl at all — an un-updated client then fetches undefined,
 * gets a 404 and reports that the upload did not complete, which is a
 * clean failure and strictly better than today's 503.
 */
function plan(key, opts) {
  const o = opts || {};
  if (backend() === "s3") {
    return {
      mode: "put",
      putUrl: s3.presignPut(key, { contentType: o.contentType, expiresSec: 300 }),
      headers: { "Content-Type": o.contentType },
      expiresIn: 300
    };
  }
  const bytes = Math.max(1, Number(o.bytes) || 0);
  return {
    mode: "parts",
    partSize: PART_BYTES,
    parts: Math.ceil(bytes / PART_BYTES),
    expiresIn: 900
  };
}

/**
 * One slice of a file, stored under its index.
 *
 * Keyed by index and upserted, never pushed into an array. $push is the
 * natural Mongo idiom here and is exactly the wrong one: a retried part
 * appends a second copy and the stitched file is silently corrupt. With
 * the unique index on (key, index), a retry — or two of them racing —
 * resolves to one row holding the last bytes received.
 *
 * Ordering therefore does not matter either, which is what lets the client
 * retry a single failed part rather than the whole upload.
 */
async function putPart(key, index, buf, opts) {
  const parts = partsCol();
  if (!parts) return { ok: false, error: "no blob store" };
  const o = opts || {};
  const total = Math.max(1, Number(o.parts) || 1);
  const size = Number(o.partSize) || PART_BYTES;

  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, status: 400, error: "empty part" };
  if (index < 0 || index >= total) return { ok: false, status: 400, error: "part out of range" };
  if (buf.length > size) return { ok: false, status: 413, error: "part too large" };
  /* A part that is not the last must be exactly partSize. Without this a
     client that mis-slices produces a short file that still sniffs
     correctly — a valid PNG header over truncated data, which renders as a
     broken image nobody can explain. */
  if (index < total - 1 && buf.length !== size) {
    return { ok: false, status: 400, error: "a part before the last must be exactly " + size + " bytes" };
  }

  // The running total counts what is already stored, with this index's own
  // contribution replaced rather than added — a retry must not inflate it.
  const existing = await parts.find({ key: key }, { projection: { _id: 0, index: 1, bytes: 1 } }).toArray();
  let running = buf.length;
  for (const p of existing) if (p.index !== index) running += Number(p.bytes) || 0;
  const ceiling = Math.min(Number(o.declaredBytes) || maxBytes(), maxBytes());
  if (running > ceiling) return { ok: false, status: 413, error: "upload is larger than declared" };

  const now = Date.now();
  await parts.updateOne(
    { key: key, index: index },
    { $set: { key: key, index: index, bytes: buf.length, data: buf,
              createdAt: new Date(now), expiresAt: new Date(now + PART_TTL_MS) } },
    { upsert: true }
  );
  return { ok: true, received: running };
}

/**
 * Stitch the parts into the one object, then drop them.
 *
 * A no-op on S3: the bucket already holds the whole thing, because the
 * browser PUT it there directly.
 */
async function finalize(key, opts) {
  if (backend() === "s3") return { ok: true };
  const blobs = blobsCol(), parts = partsCol();
  if (!blobs || !parts) return { ok: false, error: "no blob store" };
  const o = opts || {};

  const rows = await parts.find({ key: key })
    .sort({ index: 1 }).project({ _id: 0, index: 1, bytes: 1, data: 1 }).toArray();
  if (!rows.length) return { ok: false, error: "no parts were received" };

  const expected = Number(o.parts) || rows.length;
  if (rows.length !== expected) {
    return { ok: false, error: "incomplete upload (" + rows.length + " of " + expected + " parts)" };
  }
  // Contiguous from zero, or the file has a hole in the middle that no
  // byte count would reveal.
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].index !== i) return { ok: false, error: "part " + i + " is missing" };
  }

  const whole = Buffer.concat(rows.map((r) => toBuffer(r.data)));
  if (whole.length > maxBytes()) {
    await remove(key);
    return { ok: false, status: 413, error: "upload is over the size limit" };
  }

  const sha = crypto.createHash("sha256").update(whole).digest("hex");
  const now = Date.now();
  /* $setOnInsert, so a blob is written once and never rewritten under the
     same key. publicUrl() promises these are immutable and the cache
     headers say so for a year; a second write under one key would serve
     stale bytes to everyone who already has it. */
  await blobs.updateOne(
    { key: key },
    { $setOnInsert: {
        key: key, contentType: String(o.contentType || "application/octet-stream"),
        bytes: whole.length, sha256: sha, data: whole,
        createdAt: new Date(now), expiresAt: new Date(now + BLOB_TTL_MS)
      } },
    { upsert: true }
  );
  await parts.deleteMany({ key: key });
  return { ok: true, bytes: whole.length, sha256: sha };
}

/**
 * Store a whole object in one go, for bytes the server already holds.
 *
 * The upload path arrives in slices because a browser is on the other end
 * of a 4.5MB request cap; a published build is already here, so faking
 * parts for it would be ceremony. Content-addressed: the key IS the hash,
 * so re-publishing an unchanged asset writes nothing and two projects
 * using the same logo share one copy.
 *
 * `persist` because a published site's assets outlive the 24h sweep by
 * definition — nobody publishes a site that is meant to stop working
 * tomorrow.
 */
async function put(buf, opts) {
  const o = opts || {};
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (!bytes.length) return { ok: false, error: "empty object" };

  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const ext = String(o.ext || "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "bin";
  const key = "u/" + sha.slice(0, 32) + "." + ext;

  if (backend() === "s3") {
    try {
      const res = await s3.signedFetch("PUT", key, bytes, { contentType: o.contentType });
      if (!res.ok) return { ok: false, error: "storage rejected the object (" + res.status + ")" };
      return { ok: true, key, bytes: bytes.length, sha256: sha };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  const blobs = blobsCol();
  if (!blobs) return { ok: false, error: "no blob store" };
  const now = Date.now();
  await blobs.updateOne(
    { key: key },
    { $setOnInsert: {
        key: key, contentType: String(o.contentType || "application/octet-stream"),
        bytes: bytes.length, sha256: sha, data: bytes, createdAt: new Date(now),
        expiresAt: o.persist ? null : new Date(now + BLOB_TTL_MS)
      } },
    { upsert: true }
  );
  // A key that already existed keeps whatever expiry it had, so an asset
  // first seen as a draft upload is made permanent when it is published.
  if (o.persist) await blobs.updateOne({ key: key }, { $set: { expiresAt: null } });
  return { ok: true, key, bytes: bytes.length, sha256: sha };
}

/**
 * Size and type without the bytes.
 *
 * The projection excluding `data` is the point: answering a HEAD, or a
 * 304, by pulling two megabytes out of Mongo is the entire cost of the
 * request for none of its value.
 */
async function head(key) {
  const blobs = blobsCol();
  if (blobs) {
    const row = await blobs.findOne({ key: key }, { projection: { _id: 0, data: 0 } });
    if (row) {
      return { ok: true, from: "db", bytes: row.bytes, contentType: row.contentType, etag: etagOf(row.sha256) };
    }
  }
  if (!s3.isConfigured()) return { ok: false };
  try {
    const res = await s3.signedFetch("HEAD", key);
    if (!res.ok) return { ok: false };
    return {
      ok: true, from: "s3",
      bytes: Number(res.headers.get("content-length")) || 0,
      contentType: res.headers.get("content-type") || "",
      etag: res.headers.get("etag") || ""
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** The first bytes, for the magic-byte sniff. A slice here, a ranged GET there. */
async function readRange(key, first, last) {
  const blobs = blobsCol();
  if (blobs) {
    const row = await blobs.findOne({ key: key }, { projection: { _id: 0, data: 1 } });
    if (row && row.data) {
      const buf = toBuffer(row.data);
      // A slice past the end is a shorter buffer, not a throw — a 5-byte
      // file asked for its first 256 bytes has 5 to give.
      return { ok: true, from: "db", buf: buf.subarray(first, Math.min(buf.length, last + 1)) };
    }
  }
  if (!s3.isConfigured()) return { ok: false, buf: Buffer.alloc(0) };
  try {
    const res = await s3.signedFetch("GET", key, null, { range: "bytes=" + first + "-" + last });
    if (!res.ok && res.status !== 206) return { ok: false, status: res.status, buf: Buffer.alloc(0) };
    return { ok: true, from: "s3", buf: Buffer.from(await res.arrayBuffer()) };
  } catch (e) { return { ok: false, error: e.message, buf: Buffer.alloc(0) }; }
}

/**
 * The whole object — database first, bucket second.
 *
 * The fall-through IS the migration. While S3 is being switched on, new
 * uploads land in the bucket and everything written before it still reads
 * out of Mongo, so no URL minted during the fallback ever 404s.
 */
async function read(key) {
  const blobs = blobsCol();
  if (blobs) {
    const row = await blobs.findOne({ key: key }, { projection: { _id: 0 } });
    if (row && row.data) {
      const buf = toBuffer(row.data);
      return { ok: true, from: "db", buf: buf, contentType: row.contentType, etag: etagOf(row.sha256) };
    }
  }
  if (!s3.isConfigured()) return { ok: false };
  try {
    const res = await s3.signedFetch("GET", key);
    if (!res.ok) return { ok: false };
    return {
      ok: true, from: "s3", buf: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") || "", etag: res.headers.get("etag") || ""
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** Remove from wherever it is — including any parts still in flight. */
async function remove(key) {
  const blobs = blobsCol(), parts = partsCol();
  if (blobs) await blobs.deleteOne({ key: key });
  if (parts) await parts.deleteMany({ key: key });
  if (s3.isConfigured()) { try { await s3.deleteObject(key); } catch (e) { /* best effort */ } }
  return { ok: true };
}

/**
 * The image is in a build now, so its bytes outlive the 24h sweep.
 *
 * Called through the onPersist hook uploads.attachToProject fires, rather
 * than beside each of its call sites — the failure this prevents is
 * images that work for a day and then vanish out of a published site,
 * which nobody would connect back to a missing line in a route handler.
 */
async function persist(keys) {
  const blobs = blobsCol();
  const list = (Array.isArray(keys) ? keys : []).filter(Boolean);
  if (!blobs || !list.length) return { persisted: 0 };
  const r = await blobs.updateMany({ key: { $in: list } }, { $set: { expiresAt: null } });
  return { persisted: r.modifiedCount || 0 };
}

module.exports = {
  init, ensureIndexes,
  backend, available, maxBytes, partBytes,
  newKey, publicUrl, plan,
  put, putPart, finalize, head, readRange, read, remove, persist,
  MAX_BYTES_DB, PART_BYTES, PART_TTL_MS, BLOB_TTL_MS
};
