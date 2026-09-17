/* =================================================================
   blobs-test.js — the store that holds an image's bytes
   -----------------------------------------------------------------
   The loudest assertion in this file is that a key and a URL are
   IDENTICAL whichever backend is active. Everything else here is
   ordinary correctness; that one is the migration. If a row written
   while the bytes were in Mongo named Mongo anywhere, turning S3 on
   would mean rewriting URLs that are already baked permanently into
   published customer source — which is not a thing anyone can do.

   Run: node test/blobs-test.js
   ================================================================= */
"use strict";

const assert = require("assert");
const path = require("path");
const { makeDb } = require("./mongo-double");

/* ---- stub s3.js before blobs.js requires it ------------------------ */
const store = { objects: new Map(), deleted: [] };
let s3On = false;

const s3Stub = {
  isConfigured: () => s3On,
  newKey: (ext) => "u/" + "a".repeat(32) + "." + ext,
  publicUrl: (k) => (process.env.S3_PUBLIC_BASE_URL ? "https://cdn.test/" + k : "/api/img/" + k),
  presignPut: (k, o) => "https://bucket.test/" + k + "?ct=" + encodeURIComponent(o.contentType),
  deleteObject: async (k) => { store.deleted.push(k); store.objects.delete(k); return { ok: true }; },
  signedFetch: async (method, key, body, opts) => {
    const buf = store.objects.get(key);
    if (!buf) return { ok: false, status: 404, headers: { get: () => null } };
    if (method === "HEAD") {
      return { ok: true, status: 200, headers: { get: (h) => h === "content-length" ? String(buf.length) : "image/png" } };
    }
    const sliced = opts && opts.range ? buf.subarray(0, 256) : buf;
    return {
      ok: true, status: opts && opts.range ? 206 : 200,
      headers: { get: (h) => h === "content-type" ? "image/png" : '"s3etag"' },
      arrayBuffer: async () => sliced.buffer.slice(sliced.byteOffset, sliced.byteOffset + sliced.byteLength)
    };
  }
};
const S3 = path.join(__dirname, "..", "lib", "storage", "s3.js");
require.cache[S3] = { id: S3, filename: S3, loaded: true, exports: s3Stub };

const blobs = require("../lib/storage/blobs");

const db = makeDb();
blobs.init({ getMasterDb: () => db, getBlobDb: () => db });

const PART = blobs.PART_BYTES;
const KEY = "u/" + "a".repeat(32) + ".png";
const PNGHEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let passed = 0;
async function ok(name, fn) {
  try { await fn(); console.log("  ok  " + name); passed++; }
  catch (e) { console.error("  FAIL " + name + "\n       " + e.message); process.exitCode = 1; }
}
const reset = () => { db._reset(); store.objects.clear(); store.deleted.length = 0; };

(async () => {
  console.log("\nwhich store is in play");

  await ok("S3 when it is configured, the database when it is not", () => {
    s3On = true;  assert.strictEqual(blobs.backend(), "s3");
    s3On = false; assert.strictEqual(blobs.backend(), "db");
  });

  await ok("BLOB_BACKEND=db keeps the bytes local even with a bucket available", () => {
    s3On = true;
    process.env.BLOB_BACKEND = "db";
    assert.strictEqual(blobs.backend(), "db",
      "this is the reversible switch: it stops WRITES to the bucket while reads still fall through");
    delete process.env.BLOB_BACKEND;
    s3On = false;
  });

  await ok("no bucket and no database is an honest nothing, not a silent success", () => {
    blobs.init({ getMasterDb: () => null, getBlobDb: () => null });
    s3On = false;
    assert.strictEqual(blobs.backend(), "");
    assert.strictEqual(blobs.available(), false, "/sign must keep its 503");
    blobs.init({ getMasterDb: () => db, getBlobDb: () => db });
  });

  console.log("\nthe migration invariant");

  await ok("a key and a URL are byte-identical whichever backend is active", () => {
    s3On = true;
    const keyS3 = blobs.newKey("png"), urlS3 = blobs.publicUrl(keyS3);
    s3On = false;
    const keyDb = blobs.newKey("png"), urlDb = blobs.publicUrl(keyDb);
    assert.strictEqual(keyDb, keyS3,
      "a key minted on the database path must be indistinguishable from an S3 one — " +
      "otherwise turning S3 on means rewriting URLs already baked into published sites");
    assert.strictEqual(urlDb, urlS3, "same, for the URL that goes into customer source");
  });

  console.log("\nparts");

  await ok("a retried part replaces itself instead of arriving twice", async () => {
    reset();
    const a = Buffer.alloc(PART, 1), b = Buffer.alloc(200, 2);
    await blobs.putPart(KEY, 0, a, { parts: 2, partSize: PART, declaredBytes: PART + 200 });
    await blobs.putPart(KEY, 0, a, { parts: 2, partSize: PART, declaredBytes: PART + 200 });
    await blobs.putPart(KEY, 1, b, { parts: 2, partSize: PART, declaredBytes: PART + 200 });
    const fin = await blobs.finalize(KEY, { contentType: "image/png", parts: 2 });
    assert.strictEqual(fin.ok, true);
    assert.strictEqual(fin.bytes, PART + 200, "$push would have made this one part longer");
  });

  /* Two parts, not three: three full parts is 3 MiB and the database cap
     is 2, so a third would be refused by the size check and this would be
     testing that instead. Order-independence needs exactly two. */
  await ok("parts arriving out of order stitch to the same bytes", async () => {
    reset();
    const p0 = Buffer.alloc(PART, 7), p1 = Buffer.alloc(9, 9);
    const declared = PART + 9;
    await blobs.putPart(KEY, 1, p1, { parts: 2, partSize: PART, declaredBytes: declared });
    await blobs.putPart(KEY, 0, p0, { parts: 2, partSize: PART, declaredBytes: declared });
    const fin = await blobs.finalize(KEY, { contentType: "image/png", parts: 2 });
    assert.strictEqual(fin.ok, true, fin.error || "");
    const got = await blobs.read(KEY);
    assert.ok(got.buf.equals(Buffer.concat([p0, p1])), "the last part arriving first must not reorder the file");
  });

  await ok("a hole in the middle fails finalize and stores no blob", async () => {
    reset();
    await blobs.putPart(KEY, 0, Buffer.alloc(PART, 1), { parts: 3, partSize: PART, declaredBytes: 3 * PART });
    await blobs.putPart(KEY, 2, Buffer.alloc(10, 1), { parts: 3, partSize: PART, declaredBytes: 3 * PART });
    const fin = await blobs.finalize(KEY, { contentType: "image/png", parts: 3 });
    assert.strictEqual(fin.ok, false);
    assert.strictEqual((await blobs.head(KEY)).ok, false, "a partial file must not become readable");
  });

  await ok("a part before the last must be exactly partSize", async () => {
    reset();
    const r = await blobs.putPart(KEY, 0, Buffer.alloc(99, 1), { parts: 2, partSize: PART, declaredBytes: PART + 1 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 400,
      "a short middle part stitches to a valid header over truncated data, which renders as nothing");
  });

  await ok("the running total is refused at the part, not deferred to finalize", async () => {
    reset();
    const huge = blobs.MAX_BYTES_DB + PART;
    const parts = Math.ceil(huge / PART);
    let refused = null;
    for (let i = 0; i < parts && !refused; i++) {
      const r = await blobs.putPart(KEY, i, Buffer.alloc(PART, 1), { parts: parts, partSize: PART, declaredBytes: huge });
      if (!r.ok) refused = r;
    }
    assert.ok(refused, "the cap must bite while the bytes are arriving");
    assert.strictEqual(refused.status, 413);
  });

  await ok("an index outside the declared range is refused", async () => {
    reset();
    const r = await blobs.putPart(KEY, 5, Buffer.alloc(10, 1), { parts: 2, partSize: PART, declaredBytes: 20 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 400);
  });

  console.log("\nreading");

  await ok("finalize clears the parts it stitched", async () => {
    reset();
    await blobs.putPart(KEY, 0, PNGHEAD, { parts: 1, partSize: PART, declaredBytes: PNGHEAD.length });
    await blobs.finalize(KEY, { contentType: "image/png", parts: 1 });
    assert.strictEqual(db.collection("blob_parts")._rows().length, 0);
    assert.strictEqual(db.collection("blobs")._rows().length, 1);
  });

  await ok("a range past the end returns what there is rather than throwing", async () => {
    reset();
    await blobs.putPart(KEY, 0, PNGHEAD, { parts: 1, partSize: PART, declaredBytes: PNGHEAD.length });
    await blobs.finalize(KEY, { contentType: "image/png", parts: 1 });
    const r = await blobs.readRange(KEY, 0, 255);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.buf.length, PNGHEAD.length, "8 bytes asked for 256 has 8 to give");
  });

  await ok("head() never reads the bytes", async () => {
    reset();
    await blobs.putPart(KEY, 0, Buffer.alloc(4096, 3), { parts: 1, partSize: PART, declaredBytes: 4096 });
    await blobs.finalize(KEY, { contentType: "image/png", parts: 1 });
    db._log.projections.length = 0;
    const meta = await blobs.head(KEY);
    assert.strictEqual(meta.bytes, 4096);
    const q = db._log.projections.find((p) => p.collection === "blobs" && p.op === "findOne");
    assert.ok(q && q.projection && q.projection.data === 0,
      "answering a HEAD or a 304 by pulling megabytes out of the database is the cost this avoids");
  });

  await ok("an ETag comes back and is stable", async () => {
    reset();
    await blobs.putPart(KEY, 0, PNGHEAD, { parts: 1, partSize: PART, declaredBytes: PNGHEAD.length });
    await blobs.finalize(KEY, { contentType: "image/png", parts: 1 });
    const a = await blobs.head(KEY), b = await blobs.head(KEY);
    assert.ok(a.etag && a.etag === b.etag);
  });

  await ok("a blob is written once and a second finalize cannot rewrite it", async () => {
    reset();
    await blobs.putPart(KEY, 0, Buffer.alloc(32, 1), { parts: 1, partSize: PART, declaredBytes: 32 });
    await blobs.finalize(KEY, { contentType: "image/png", parts: 1 });
    await blobs.putPart(KEY, 0, Buffer.alloc(64, 2), { parts: 1, partSize: PART, declaredBytes: 64 });
    await blobs.finalize(KEY, { contentType: "image/png", parts: 1 });
    const got = await blobs.read(KEY);
    assert.strictEqual(got.buf.length, 32,
      "the URL promises these are immutable for a year; a rewrite would serve stale bytes for ever");
  });

  console.log("\nreading across both stores — the switch");

  await ok("a miss in the database falls through to the bucket", async () => {
    reset();
    s3On = true;
    store.objects.set(KEY, Buffer.concat([PNGHEAD, Buffer.alloc(40)]));
    const got = await blobs.read(KEY);
    assert.strictEqual(got.ok, true);
    assert.strictEqual(got.from, "s3",
      "this fall-through IS the migration: old rows keep answering out of Mongo while new ones land in the bucket");
    const meta = await blobs.head(KEY);
    assert.strictEqual(meta.from, "s3");
    s3On = false;
  });

  await ok("remove() clears the blob, its parts and the bucket copy", async () => {
    reset();
    s3On = true;
    store.objects.set(KEY, PNGHEAD);
    await blobs.putPart(KEY, 0, Buffer.alloc(PART, 1), { parts: 2, partSize: PART, declaredBytes: PART + 1 });
    await blobs.remove(KEY);
    assert.strictEqual(db.collection("blob_parts")._rows().length, 0);
    assert.ok(store.deleted.includes(KEY));
    s3On = false;
  });

  console.log("\nkeeping the bytes");

  await ok("persist() clears the expiry that would have swept them", async () => {
    reset();
    await blobs.putPart(KEY, 0, PNGHEAD, { parts: 1, partSize: PART, declaredBytes: PNGHEAD.length });
    await blobs.finalize(KEY, { contentType: "image/png", parts: 1 });
    assert.ok(db.collection("blobs")._rows()[0].expiresAt, "unused bytes must still expire");
    await blobs.persist([KEY]);
    assert.strictEqual(db.collection("blobs")._rows()[0].expiresAt, null,
      "an image in a published site cannot be allowed to vanish 24h later");
  });

  console.log("\n" + passed + " passed" + (process.exitCode ? " — WITH FAILURES" : "") + "\n");
})();
