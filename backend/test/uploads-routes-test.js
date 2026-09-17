/* =================================================================
   The upload routes, with storage and vision stubbed.

   The interesting half is the completion check, because that is the actual
   security boundary: between /sign and /complete the object is whatever the
   browser chose to PUT, so everything downstream depends on this step
   refusing what does not match. A signed URL is a capability, not a promise.

   Every one of those assertions now runs TWICE — once with the bytes going
   to a bucket and once with them going to the database — because that claim
   has to hold identically on both paths and the only way to know it does is
   to make the same demands of each. If the two ever diverge, the divergence
   is the bug this feature can actually produce.

   Run: node test/uploads-routes-test.js
   ================================================================= */
"use strict";

const assert = require("assert");
const path = require("path");
const { makeDb } = require("./mongo-double");

/* ---- stubs, injected before the routes module loads ---------------- */
const store = { objects: new Map(), deleted: [] };
let visionResult = { description: "A warm-lit cafe interior.", costUsd: 0.001 };
let visionUp = true;
let s3On = true;

const s3Stub = {
  isConfigured: () => s3On,
  newKey: (ext) => "u/" + "a".repeat(32) + "." + ext,
  publicUrl: (k) => "https://cdn.test/" + k,
  presignPut: (k, o) => "https://bucket.test/" + k + "?sig=1&ct=" + encodeURIComponent(o.contentType),
  deleteObject: async (k) => { store.deleted.push(k); store.objects.delete(k); return { ok: true }; },
  signedFetch: async (method, key, body, opts) => {
    const buf = store.objects.get(key);
    if (!buf) return { ok: false, status: 404, headers: { get: () => null } };
    if (method === "HEAD") {
      return { ok: true, status: 200, headers: { get: (h) => h === "content-length" ? String(buf.length) : null } };
    }
    const sliced = opts && opts.range ? buf.subarray(0, 256) : buf;
    return {
      ok: true, status: opts && opts.range ? 206 : 200,
      headers: { get: (h) => h === "content-type" ? "image/png" : null },
      arrayBuffer: async () => sliced.buffer.slice(sliced.byteOffset, sliced.byteOffset + sliced.byteLength)
    };
  }
};
const visionStub = { available: () => visionUp, describe: async () => visionResult };

const S3 = path.join(__dirname, "..", "lib", "storage", "s3.js");
const VIS = path.join(__dirname, "..", "lib", "codeagent", "vision.js");
require.cache[S3] = { id: S3, filename: S3, loaded: true, exports: s3Stub };
require.cache[VIS] = { id: VIS, filename: VIS, loaded: true, exports: visionStub };

const blobs = require("../lib/storage/blobs");
const uploads = require("../lib/uploads");
const routes = require("../lib/uploads-routes");

const db = makeDb();
blobs.init({ getMasterDb: () => db, getBlobDb: () => db });
uploads.init({ getMasterDb: () => null, onPersist: (keys) => blobs.persist(keys) });

/* ---- a tiny express double ----------------------------------------- */
function makeApp() {
  const handlers = {};
  const take = (method) => (p, ...rest) => { handlers[method + " " + p] = rest[rest.length - 1]; };
  const app = { post: take("POST"), get: take("GET"), put: take("PUT") };
  app.call = async (key, req) => {
    let code = 200, payload = null;
    const headers = {};
    const res = {
      status(c) { code = c; return this; },
      json(o) { payload = o; return this; },
      set(k, v) { headers[k] = v; return this; },
      send(b) { payload = b; return this; },
      end() { return this; }
    };
    await handlers[key](Object.assign({ headers: {} }, req), res);
    return { code, body: payload, headers };
  };
  return app;
}

const OWNER = { anonId: "anon-1", userId: null, email: "a@b.c" };
const app = makeApp();
routes.register(app, { appOwnerOf: () => OWNER, isAdminEmail: () => false });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const HTML = Buffer.from("<html><script>alert(1)</script></html>" + "x".repeat(40));
const KEY = "u/" + "a".repeat(32) + ".png";

let passed = 0;
async function ok(name, fn) {
  try { await fn(); console.log("  ok  " + name); passed++; }
  catch (e) { console.error("  FAIL " + name + "\n       " + e.message); process.exitCode = 1; }
}

const sign = (body) => app.call("POST /api/uploads/sign", { body: body });
const complete = (id) => app.call("POST /api/uploads/:id/complete", { params: { id: id } });
const part = (id, index, buf) =>
  app.call("PUT /api/uploads/:id/part/:index", { params: { id: id, index: String(index) }, body: buf });

/**
 * Put the bytes where this backend expects to find them, so the rest of a
 * test reads the same in both modes.
 */
async function deliver(id, buf) {
  if (s3On) { store.objects.set(KEY, buf); return { code: 200 }; }
  const size = blobs.partBytes();
  const n = Math.max(1, Math.ceil(buf.length / size));
  let last = { code: 200 };
  for (let i = 0; i < n; i++) {
    last = await part(id, i, buf.subarray(i * size, Math.min(buf.length, (i + 1) * size)));
    if (last.code !== 200) break;
  }
  return last;
}

(async () => {
  for (const mode of ["s3", "db"]) {
    s3On = mode === "s3";
    db._reset(); store.objects.clear(); store.deleted.length = 0;

    console.log("\n═══ backend: " + mode + " ═══");
    console.log("\nsigning");

    await ok("[" + mode + "] tells the client how to send the bytes", async () => {
      const r = await sign({ name: "a.png", type: "image/png", bytes: 1000 });
      assert.strictEqual(r.code, 200);
      assert.match(r.body.id, /^img_/);
      if (mode === "s3") {
        assert.strictEqual(r.body.upload.mode, "put");
        assert.ok(r.body.putUrl.includes("image%2Fpng"), "content-type must be signed in");
        assert.strictEqual(r.body.headers["Content-Type"], "image/png");
      } else {
        assert.strictEqual(r.body.upload.mode, "parts");
        assert.strictEqual(r.body.upload.parts, 1);
        assert.ok(!r.body.putUrl, "no presigned URL exists on this path, and pretending otherwise would hide the branch");
        assert.ok(r.body.upload.partUrl.includes(r.body.id));
      }
    });

    await ok("[" + mode + "] refuses SVG — a public bucket makes it an XSS surface", async () => {
      const r = await sign({ name: "logo.svg", type: "image/svg+xml", bytes: 500 });
      assert.strictEqual(r.code, 415);
      assert.match(r.body.error, /PNG, JPG, WebP or GIF/);
    });

    await ok("[" + mode + "] refuses a non-image outright", async () => {
      assert.strictEqual((await sign({ name: "x.pdf", type: "application/pdf", bytes: 10 })).code, 415);
    });

    await ok("[" + mode + "] refuses oversize before a byte is uploaded", async () => {
      const r = await sign({ name: "big.jpg", type: "image/jpeg", bytes: 40 * 1024 * 1024 });
      assert.strictEqual(r.code, 413);
      // The two paths have different ceilings and each must name its own.
      assert.match(r.body.error, mode === "s3" ? /10MB/ : /2MB/);
    });

    console.log("\ncompletion — the security boundary");

    await ok("[" + mode + "] accepts an image that is what it claimed", async () => {
      const s = await sign({ name: "a.png", type: "image/png", bytes: PNG.length });
      await deliver(s.body.id, PNG);
      const r = await complete(s.body.id);
      assert.strictEqual(r.code, 200);
      assert.strictEqual(r.body.url, "https://cdn.test/" + KEY);
      assert.strictEqual((await uploads.get(s.body.id)).status, "ready");
    });

    await ok("[" + mode + "] HTML renamed .png is rejected AND the bytes are removed", async () => {
      store.deleted.length = 0; db._reset();
      const s = await sign({ name: "evil.png", type: "image/png", bytes: HTML.length });
      const sent = await deliver(s.body.id, HTML);
      if (mode === "db") {
        // Caught at part 0 rather than deferred — an optimisation, not the boundary.
        assert.strictEqual(sent.code, 415);
      } else {
        assert.strictEqual((await complete(s.body.id)).code, 415);
        assert.ok(store.deleted.includes(KEY), "unverified content must not stay in a public bucket");
      }
      assert.strictEqual((await uploads.get(s.body.id)).status, "failed");
      assert.strictEqual((await blobs.head(KEY)).ok, false, "and it must not be readable afterwards");
    });

    await ok("[" + mode + "] a real image of the WRONG type is also rejected", async () => {
      store.deleted.length = 0; db._reset();
      const s = await sign({ name: "a.png", type: "image/png", bytes: JPEG.length });
      const sent = await deliver(s.body.id, JPEG);      // signed png, sent jpeg
      const code = mode === "db" ? sent.code : (await complete(s.body.id)).code;
      assert.strictEqual(code, 415);
      assert.strictEqual((await uploads.get(s.body.id)).status, "failed");
    });

    await ok("[" + mode + "] bytes that never arrived fail cleanly", async () => {
      db._reset();
      const s = await sign({ name: "a.png", type: "image/png", bytes: 10 });
      store.objects.delete(KEY);
      const r = await complete(s.body.id);
      assert.strictEqual(r.code, 502);
      assert.strictEqual((await uploads.get(s.body.id)).status, "failed");
    });

    await ok("[" + mode + "] someone else's id is a 404, not a 403 that confirms it exists", async () => {
      const s = await sign({ name: "a.png", type: "image/png", bytes: 10 });
      const other = makeApp();
      routes.register(other, { appOwnerOf: () => ({ anonId: "anon-2" }), isAdminEmail: () => false });
      const r = await other.call("POST /api/uploads/:id/complete", { params: { id: s.body.id } });
      assert.strictEqual(r.code, 404);
    });

    console.log("\ndescription");

    await ok("[" + mode + "] caches what vision saw", async () => {
      db._reset(); visionUp = true;
      const s = await sign({ name: "a.png", type: "image/png", bytes: PNG.length });
      await deliver(s.body.id, PNG);
      const r = await complete(s.body.id);
      assert.match(r.body.description, /cafe interior/);
      assert.match((await uploads.get(s.body.id)).description, /cafe interior/);
    });

    await ok("[" + mode + "] no vision is not a failed upload", async () => {
      db._reset(); visionUp = false;
      const s = await sign({ name: "a.png", type: "image/png", bytes: PNG.length });
      await deliver(s.body.id, PNG);
      const r = await complete(s.body.id);
      assert.strictEqual(r.code, 200, "an undescribed image is still a usable image");
      assert.strictEqual(r.body.description, "");
      assert.ok((await uploads.get(s.body.id)).describedAt, "must record that we asked");
      visionUp = true;
    });

    await ok("[" + mode + "] completion is idempotent and does not pay twice", async () => {
      db._reset();
      const s = await sign({ name: "a.png", type: "image/png", bytes: PNG.length });
      await deliver(s.body.id, PNG);
      await complete(s.body.id);
      let calls = 0;
      const prev = visionStub.describe;
      visionStub.describe = async () => { calls++; return visionResult; };
      const again = await complete(s.body.id);
      assert.strictEqual(again.code, 200);
      assert.strictEqual(calls, 0, "a retried completion must not re-describe");
      visionStub.describe = prev;
    });

    /* Two /complete calls in flight at once. On a bucket a lost race was
       harmless — both re-read the same object. On the database the winner
       stitches the parts and deletes them, so the loser used to find none
       and fail a perfectly good upload. A double-clicked button was enough. */
    await ok("[" + mode + "] two completions racing cannot destroy the upload", async () => {
      db._reset();
      const s = await sign({ name: "a.png", type: "image/png", bytes: PNG.length });
      await deliver(s.body.id, PNG);
      const [a, b] = await Promise.all([complete(s.body.id), complete(s.body.id)]);
      const codes = [a.code, b.code].sort();
      assert.deepStrictEqual(codes, [200, 409], "one verifies, the other is told it is already being checked");
      assert.strictEqual((await uploads.get(s.body.id)).status, "ready");
    });

    console.log("\nserving");

    await ok("[" + mode + "] /api/img serves the bytes with an ETag and 304s on it", async () => {
      db._reset();
      const s = await sign({ name: "a.png", type: "image/png", bytes: PNG.length });
      await deliver(s.body.id, PNG);
      await complete(s.body.id);
      const first = await app.call("GET /api/img/*", { params: { 0: KEY }, method: "GET" });
      assert.strictEqual(first.code, 200);
      assert.strictEqual(first.headers["Cache-Control"], "public, max-age=31536000, immutable");
      if (mode === "db") {
        assert.ok(first.headers.ETag, "an ETag is what keeps a 304 from reading the bytes");
        const again = await app.call("GET /api/img/*", {
          params: { 0: KEY }, method: "GET", headers: { "if-none-match": first.headers.ETag }
        });
        assert.strictEqual(again.code, 304);
      }
    });

    await ok("[" + mode + "] /api/img refuses a key that is not one of ours", async () => {
      const r = await app.call("GET /api/img/*", { params: { 0: "../../etc/passwd" }, method: "GET" });
      assert.strictEqual(r.code, 404);
    });
  }

  /* ---- things that are true of one backend only --------------------- */
  console.log("\n═══ the part route ═══");
  s3On = false; db._reset();

  await ok("a part from a different owner is a 404", async () => {
    const s = await sign({ name: "a.png", type: "image/png", bytes: PNG.length });
    const other = makeApp();
    routes.register(other, { appOwnerOf: () => ({ anonId: "anon-2" }), isAdminEmail: () => false });
    const r = await other.call("PUT /api/uploads/:id/part/:index", {
      params: { id: s.body.id, index: "0" }, body: PNG
    });
    assert.strictEqual(r.code, 404);
  });

  await ok("a finished upload cannot have its bytes rewritten", async () => {
    db._reset();
    const s = await sign({ name: "a.png", type: "image/png", bytes: PNG.length });
    await deliver(s.body.id, PNG);
    await complete(s.body.id);
    const r = await part(s.body.id, 0, PNG);
    assert.strictEqual(r.code, 409);
  });

  await ok("an index beyond the declared part count is refused", async () => {
    db._reset();
    const s = await sign({ name: "a.png", type: "image/png", bytes: PNG.length });
    const r = await part(s.body.id, 4, PNG);
    assert.strictEqual(r.code, 400);
  });

  await ok("a multi-part image round-trips byte for byte", async () => {
    db._reset();
    const size = blobs.partBytes();
    const big = Buffer.concat([PNG, Buffer.alloc(size, 0x5a)]);   // spans two parts
    const s = await sign({ name: "a.png", type: "image/png", bytes: big.length });
    assert.strictEqual(s.body.upload.parts, 2, "this is the path that never runs if partSize is set too high");
    const sent = await deliver(s.body.id, big);
    assert.strictEqual(sent.code, 200);
    assert.strictEqual((await complete(s.body.id)).code, 200);
    const got = await blobs.read(KEY);
    assert.ok(got.buf.equals(big), "a stitched file must be the file");
  });

  console.log("\nsniffer");
  await ok("recognises exactly the four allowed signatures", () => {
    assert.strictEqual(routes.sniff(PNG), "image/png");
    assert.strictEqual(routes.sniff(JPEG), "image/jpeg");
    assert.strictEqual(routes.sniff(Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(20)])), "image/gif");
    assert.strictEqual(routes.sniff(Buffer.concat([
      Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(20)])), "image/webp");
    assert.strictEqual(routes.sniff(HTML), "");
    assert.strictEqual(routes.sniff(Buffer.from("<svg/>")), "", "SVG has no magic bytes and must not pass");
    assert.strictEqual(routes.sniff(Buffer.alloc(4)), "", "too short to judge");
  });

  console.log("\n" + passed + " passed" + (process.exitCode ? " — WITH FAILURES" : "") + "\n");
})();
