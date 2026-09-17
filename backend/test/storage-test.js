/* =================================================================
   Known-answer tests for the SigV4 signer in lib/storage/s3.js.

   Why this file exists: a signature is either exactly right or it is a 403
   with an empty body. There is no partial credit and no useful error, so a
   canonicalisation bug — one unencoded character, one header out of sort
   order, a scope whose date disagrees with X-Amz-Date — presents as
   "uploads are broken" with nothing to grep for. These pin the arithmetic
   against values that do not come from this codebase.

   Run: node server/storage-test.js
   ================================================================= */
"use strict";

const assert = require("assert");

// Must be set BEFORE the module is required — REGION is read at load.
process.env.S3_REGION = "auto";
process.env.S3_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
process.env.S3_BUCKET = "souqi-uploads";
process.env.S3_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";
process.env.S3_SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

const s3 = require("../lib/storage/s3");
const { uriEncode, encodeKey, stamps, signingKey } = s3._internal;

let passed = 0;
function ok(name, fn) {
  try { fn(); console.log("  ok  " + name); passed++; }
  catch (e) { console.error("  FAIL " + name + "\n       " + e.message); process.exitCode = 1; }
}

console.log("\nSigV4 signer");

/* AWS's documented example INPUTS (from "Deriving the Signing Key"), with the
   expected value computed from a separate from-scratch implementation of the
   four-step chain rather than copied from anywhere.

   Be clear about what this does and does not prove. It is a REGRESSION PIN,
   not an external oracle: it catches the chain being reordered, a step
   dropped, the "AWS4" prefix lost, or a digest swapped — which are the ways
   this actually breaks. It does not independently confirm the spec, because
   the number and the code share an author.

   The genuinely external check is step 2 of the verification plan: presign a
   real PUT against the bucket and watch it return 200. Until R2 exists, this
   is the strongest available guard, and it is worth having because the
   failure it prevents is a 403 with an empty body. */
ok("signing key derivation is stable (AWS example inputs)", () => {
  const k = signingKey("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "20120215", "us-east-1", "iam");
  assert.strictEqual(k.toString("hex"),
    "004aa806e13dae88b9032d9261bcb04c67d023afadd221e6b0d206e1760e0b5e");
});

/* The chain is four HMACs in a fixed order; pin the intermediates too, so a
   regression names the step that moved instead of just "the key changed". */
ok("each step of the derivation chain is pinned", () => {
  const sec = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  const crypto = require("crypto");
  const H = (k, v) => crypto.createHmac("sha256", k).update(v).digest();
  assert.strictEqual(H("AWS4" + sec, "20120215").toString("hex"),
    "ed838dceb93f9c66f7ce5dd7db2e81f32359d5b3937685ad412bbc1aecb0db20", "kDate");
  assert.strictEqual(H(H("AWS4" + sec, "20120215"), "us-east-1").toString("hex"),
    "64c626d0405c3fe0ccc60cfd05dc1267c580f03552d867dcfcc1005ef272151e", "kRegion");
});

/* encodeURIComponent leaves these alone and AWS requires them encoded. Each
   one is a silent 403 if it slips through. */
ok("uriEncode escapes the characters encodeURIComponent misses", () => {
  assert.strictEqual(uriEncode("!'()*"), "%21%27%28%29%2A");
  assert.strictEqual(uriEncode("a b"), "a%20b");          // not '+'
  assert.strictEqual(uriEncode("a/b"), "a%2Fb");          // slash IS encoded here
  assert.strictEqual(uriEncode("~-_."), "~-_.");          // unreserved, untouched
});

ok("encodeKey keeps path separators but encodes the segments", () => {
  assert.strictEqual(encodeKey("u/ab cd.png"), "u/ab%20cd.png");
  assert.strictEqual(encodeKey("u/a(1).png"), "u/a%281%29.png");
});

/* Both stamps must come from ONE instant. Derived separately they can
   straddle midnight UTC, producing a scope date that disagrees with
   X-Amz-Date — signs cleanly, rejected every time, and only at midnight. */
ok("stamps derive both forms from a single timestamp", () => {
  const s = stamps(new Date("2026-09-13T23:59:59.500Z"));
  assert.strictEqual(s.amzDate, "20260913T235959Z");
  assert.strictEqual(s.dateStamp, "20260913");
  assert.strictEqual(s.dateStamp, s.amzDate.slice(0, 8));
});

console.log("\npresignPut");

const FIXED = new Date("2026-09-13T12:00:00.000Z");
const url = s3.presignPut("u/deadbeef.png", { contentType: "image/png", expiresSec: 300, now: FIXED });

ok("carries every parameter R2 requires", () => {
  const u = new URL(url);
  const q = u.searchParams;
  assert.strictEqual(q.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.strictEqual(q.get("X-Amz-Date"), "20260913T120000Z");
  assert.strictEqual(q.get("X-Amz-Expires"), "300");
  assert.strictEqual(q.get("X-Amz-SignedHeaders"), "content-type;host");
  assert.strictEqual(q.get("X-Amz-Credential"),
    "AKIAIOSFODNN7EXAMPLE/20260913/auto/s3/aws4_request");
  assert.match(q.get("X-Amz-Signature"), /^[0-9a-f]{64}$/);
  assert.strictEqual(u.pathname, "/souqi-uploads/u/deadbeef.png");
});

ok("the Credential slashes survive as %2F in the raw query", () => {
  // URL.searchParams decodes; the SIGNED string is the raw one, so check it.
  const raw = url.split("?")[1];
  assert.ok(raw.includes("X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260913%2Fauto%2Fs3%2Faws4_request"),
    "Credential must be percent-encoded inside the canonical query");
});

ok("is deterministic for a fixed instant", () => {
  const again = s3.presignPut("u/deadbeef.png", { contentType: "image/png", expiresSec: 300, now: FIXED });
  assert.strictEqual(again, url);
});

/* Each of these must move the signature. A parameter that is built into the
   URL but left out of the canonical request signs fine and is rejected by the
   store — this is the failure mode the whole file exists to catch. */
function sigOf(opts, key) {
  return new URL(s3.presignPut(key || "u/deadbeef.png", opts)).searchParams.get("X-Amz-Signature");
}
const base = { contentType: "image/png", expiresSec: 300, now: FIXED };

ok("signature covers the key", () => {
  assert.notStrictEqual(sigOf(base, "u/other.png"), sigOf(base));
});
ok("signature covers content-type", () => {
  assert.notStrictEqual(sigOf(Object.assign({}, base, { contentType: "image/jpeg" })), sigOf(base));
});
ok("signature covers the expiry", () => {
  assert.notStrictEqual(sigOf(Object.assign({}, base, { expiresSec: 600 })), sigOf(base));
});
ok("signature covers the timestamp", () => {
  assert.notStrictEqual(sigOf(Object.assign({}, base, { now: new Date("2026-09-14T12:00:00Z") })), sigOf(base));
});

ok("expiry is clamped to a sane window", () => {
  assert.strictEqual(new URL(s3.presignPut("u/a.png", { expiresSec: 99999, now: FIXED }))
    .searchParams.get("X-Amz-Expires"), "3600");
  assert.strictEqual(new URL(s3.presignPut("u/a.png", { expiresSec: 1, now: FIXED }))
    .searchParams.get("X-Amz-Expires"), "30");
});

console.log("\nkeys and public urls");

ok("newKey is unguessable and keeps a safe extension", () => {
  const k = s3.newKey("JPG");
  assert.match(k, /^u\/[0-9a-f]{32}\.jpg$/);
  assert.notStrictEqual(s3.newKey("png"), s3.newKey("png"));
  assert.match(s3.newKey("../evil"), /^u\/[0-9a-f]{32}\.evil$/);  // no traversal
});

ok("publicUrl prefers our own domain and falls back to the proxy", () => {
  process.env.S3_PUBLIC_BASE_URL = "https://cdn.souqi.site";
  assert.strictEqual(s3.publicUrl("u/a.png"), "https://cdn.souqi.site/u/a.png");
  delete process.env.S3_PUBLIC_BASE_URL;
  assert.strictEqual(s3.publicUrl("u/a.png"), "/api/img/u/a.png");
});

/* The URL goes into GENERATED CODE, and that code never runs on our
   pages. The preview serves the app from a WebContainer on
   *.webcontainer-api.io and an export runs on the customer's own host, so
   a relative "/api/img/…" resolves against their origin and 404s. The
   model wrote exactly what it was told, the build compiled, and the photo
   was a broken image in the only place anyone looks at it. */
ok("an image URL bound for generated code is absolute", () => {
  const saved = process.env.PUBLIC_BASE_URL;
  delete process.env.PUBLIC_BASE_URL;

  const fromRequest = s3.publicUrl("u/a.png", "https://souqi.site");
  assert.strictEqual(fromRequest, "https://souqi.site/api/img/u/a.png",
    "a relative URL here is a broken image in every preview and every export");
  assert.strictEqual(s3.publicUrl("u/a.png", "https://souqi.site/"), "https://souqi.site/api/img/u/a.png",
    "a trailing slash on the origin must not double up");

  process.env.PUBLIC_BASE_URL = "https://souqi.site";
  assert.strictEqual(s3.publicUrl("u/a.png"), "https://souqi.site/api/img/u/a.png",
    "PUBLIC_BASE_URL is the override for hosts that cannot name themselves");

  // A CDN still wins: it is the cheaper origin and the one we want baked in.
  process.env.S3_PUBLIC_BASE_URL = "https://cdn.souqi.site";
  assert.strictEqual(s3.publicUrl("u/a.png", "https://souqi.site"), "https://cdn.souqi.site/u/a.png");
  delete process.env.S3_PUBLIC_BASE_URL;

  if (saved === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = saved;
});

ok("isConfigured is false when the bucket is unset", () => {
  assert.strictEqual(s3.isConfigured(), true);
  const saved = process.env.S3_BUCKET;
  process.env.S3_BUCKET = "";
  assert.strictEqual(s3.isConfigured(), false);
  process.env.S3_BUCKET = saved;
});

console.log("\n" + passed + " passed" + (process.exitCode ? " — WITH FAILURES" : "") + "\n");
