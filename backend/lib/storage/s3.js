/* =================================================================
   S3-compatible object storage for USER UPLOADS (R2, S3, MinIO).

   Deliberately a second copy of the signer in deploy/src/storage/objects.js
   rather than a shared module, and the reason is deployment shape, not
   taste: deploy/ is listed in .vercelignore and ships as its own Docker
   image (ship.sh tars from deploy/, compose builds with context: .), so a
   file at the repo root is outside BOTH bundles. Sharing one would mean
   editing ship.sh, the Dockerfile and the compose context to buy nothing —
   the two stores never read each other's objects. deploy/ writes
   sources/<id>.json.gz; this writes u/<token>.<ext>.

   The env var NAMES are identical on purpose, so one set of R2 credentials
   serves both.

   What this adds over that file: PRESIGNED urls. objects.js signs request
   HEADERS and hashes the payload to do it, which a browser upload cannot
   use — the bytes never reach us. A presigned PUT moves the signature into
   the QUERY STRING and signs the literal UNSIGNED-PAYLOAD instead, so the
   browser can PUT straight to the bucket. That is what keeps image uploads
   off the serverless function, where Vercel caps a request body at ~4.5MB
   — below every express limit this app declares.
   ================================================================= */
"use strict";

const crypto = require("crypto");

const REGION = process.env.S3_REGION || "auto";
const SERVICE = "s3";

function conf() {
  return {
    endpoint: process.env.S3_ENDPOINT || "",
    bucket: process.env.S3_BUCKET || "",
    accessKey: process.env.S3_ACCESS_KEY || "",
    secretKey: process.env.S3_SECRET_KEY || "",
    publicBase: process.env.S3_PUBLIC_BASE_URL || ""
  };
}

/* Not configured is a normal state, not an error — same contract as
   deploy/src/storage/objects.js. Callers turn this into a clean 503 rather
   than a stack trace. */
function isConfigured() {
  const s = conf();
  return !!(s.endpoint && s.bucket && s.accessKey && s.secretKey);
}

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const hmac = (key, v) => crypto.createHmac("sha256", key).update(v).digest();

/* encodeURIComponent leaves !'()* alone; SigV4 requires them encoded, and a
   single unencoded character changes the canonical request and therefore the
   signature. This is the classic cause of a 403 with no useful body. */
function uriEncode(str) {
  return encodeURIComponent(String(str))
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Everything after the host, percent-encoded the way SigV4 wants. */
function encodeKey(key) {
  return String(key).split("/").map(uriEncode).join("/");
}

/* SigV4 wants two forms of "now" and they must come from ONE timestamp —
   taking Date.now() twice can straddle midnight UTC and produce a scope
   whose date disagrees with X-Amz-Date, which signs cleanly and is then
   rejected. */
function stamps(now) {
  const amzDate = (now || new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: amzDate, dateStamp: amzDate.slice(0, 8) };
}

/* region and service are parameters rather than closed-over constants purely
   so the tests can drive AWS's own published derivation vector, which uses
   us-east-1/iam. A signer with no known-answer test is a 403 waiting to
   happen, and this is the cheapest way to have one. */
function signingKey(secretKey, dateStamp, region, service) {
  let k = hmac("AWS4" + secretKey, dateStamp);
  k = hmac(k, region || REGION);
  k = hmac(k, service || SERVICE);
  return hmac(k, "aws4_request");
}

function urlFor(s, key) {
  const base = s.endpoint.replace(/\/+$/, "");
  return new URL(base + "/" + s.bucket + "/" + encodeKey(key));
}

/**
 * A presigned PUT the BROWSER performs.
 *
 * content-type is signed, which pins it at the edge: a URL minted for
 * image/png cannot be used to upload text/html, so a stolen url is not a
 * way to host arbitrary content on the bucket's domain.
 *
 * content-length is deliberately NOT signed. It is a forbidden header in
 * fetch(), so the browser sets it itself and a signature over it could
 * never match; R2 has no POST-policy equivalent to bound size at the edge
 * either. Size is enforced by the client cap plus the HEAD in the complete
 * step, which is also where the bytes are checked for being the type they
 * claim.
 */
function presignPut(key, opts) {
  const s = conf();
  const o = opts || {};
  const contentType = o.contentType || "application/octet-stream";
  const expires = Math.max(30, Math.min(3600, o.expiresSec || 300));
  const url = urlFor(s, key);
  const { amzDate, dateStamp } = stamps(o.now);
  const scope = [dateStamp, REGION, SERVICE, "aws4_request"].join("/");

  // host is signed so the URL cannot be replayed against another endpoint.
  const signedHeaders = "content-type;host";
  const canonicalHeaders = "content-type:" + contentType + "\n" + "host:" + url.host + "\n";

  // Sorted by name, and both halves individually encoded. The Credential
  // value contains slashes, which MUST survive as %2F inside the query.
  const params = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": s.accessKey + "/" + scope,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": signedHeaders
  };
  const canonicalQuery = Object.keys(params).sort()
    .map((k) => uriEncode(k) + "=" + uriEncode(params[k])).join("&");

  const canonicalRequest = [
    "PUT", url.pathname, canonicalQuery, canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD"
  ].join("\n");

  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signature = crypto.createHmac("sha256", signingKey(s.secretKey, dateStamp))
    .update(toSign).digest("hex");

  return url.origin + url.pathname + "?" + canonicalQuery + "&X-Amz-Signature=" + signature;
}

/**
 * One signed request made BY US — used for HEAD (real size), a ranged GET
 * (magic-byte sniff) and DELETE (reject an upload that lied about itself).
 *
 * Unlike the deploy-plane copy this takes an options bag, because the
 * upload-verify path needs a Range header: reading 256 bytes to identify a
 * file beats pulling 5MB through the function to do the same job.
 */
async function signedFetch(method, key, body, opts) {
  const s = conf();
  const o = opts || {};
  const url = urlFor(s, key);

  const payload = body || Buffer.alloc(0);
  const payloadHash = sha256(payload);
  const { amzDate, dateStamp } = stamps(o.now);

  const headers = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate
  };
  if (body) headers["content-type"] = o.contentType || "application/octet-stream";
  if (o.range) headers.range = o.range;

  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonicalHeaders = names.map((h) => h + ":" + headers[h] + "\n").join("");

  const canonicalRequest = [
    method, url.pathname, "", canonicalHeaders, signedHeaders, payloadHash
  ].join("\n");

  const scope = [dateStamp, REGION, SERVICE, "aws4_request"].join("/");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signature = crypto.createHmac("sha256", signingKey(s.secretKey, dateStamp))
    .update(toSign).digest("hex");

  headers.authorization = "AWS4-HMAC-SHA256 Credential=" + s.accessKey + "/" + scope +
    ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;

  return fetch(url.toString(), {
    method: method,
    headers: headers,
    body: body || undefined,
    signal: AbortSignal.timeout(o.timeoutMs || 30000)
  });
}

async function deleteObject(key) {
  try {
    const res = await signedFetch("DELETE", key);
    return { ok: res.ok || res.status === 404 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * The URL that goes into generated source, and therefore into published
 * sites and exported ZIPs — permanently.
 *
 * S3_PUBLIC_BASE_URL should be OUR OWN domain (cdn.souqi.site), never the
 * provider's *.r2.dev. These strings are baked into customer source the
 * moment a site is published; a domain we control can be re-pointed at a
 * different bucket, a provider hostname cannot, and every published site
 * would break the day the bucket moved.
 *
 * With it unset we fall back to proxying through the function, which is
 * correct for local development and wrong for production — every image
 * view becomes an invocation.
 *
 * ABSOLUTE, and that is not cosmetic. This returned "/api/img/<key>",
 * which resolves against whatever origin is asking — and the one place
 * the generated code is never running is ours. The preview serves the
 * app from a WebContainer on *.webcontainer-api.io, so a relative URL
 * became webcontainer-api.io/api/img/… and 404'd; an exported ZIP does
 * the same on the customer's own host. The model had written exactly
 * what it was told to write, the build compiled, and the photo was a
 * broken image in the only place anyone looks at it.
 *
 * `origin` comes from the request (PUBLIC_BASE_URL, else the host that
 * was called), so it is right in development and production without a
 * second thing to configure. Omitting it keeps the old relative form,
 * which is what the callers that only ever render on our own pages want.
 */
function publicUrl(key, origin) {
  const s = conf();
  if (s.publicBase) return s.publicBase.replace(/\/+$/, "") + "/" + encodeKey(key);
  const base = String(origin || process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  return base + "/api/img/" + encodeKey(key);
}

/* 128 bits of randomness: the key IS the access control, since the bucket
   is public-read so that published sites keep working without a signature
   that expires. Unguessable defeats enumeration. */
function newKey(ext) {
  const safe = String(ext || "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "bin";
  return "u/" + crypto.randomBytes(16).toString("hex") + "." + safe;
}

module.exports = {
  isConfigured, presignPut, signedFetch, deleteObject, publicUrl, newKey,
  // exported for the known-answer tests
  _internal: { uriEncode, encodeKey, stamps, signingKey }
};
