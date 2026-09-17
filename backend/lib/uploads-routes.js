/* =================================================================
   uploads-routes.js — sign, verify, and (in dev) serve
   -----------------------------------------------------------------
   Three routes, and the shape of them is dictated by one number: Vercel
   caps a serverless request body at about 4.5MB, which sits UNDER every
   express limit this app declares. Proxying a photo through the function
   would therefore fail at exactly the sizes people upload from a phone,
   and would burn function time doing it.

   So the bytes never touch us on the way in. /sign mints a presigned PUT
   and the browser uploads straight to the bucket; /complete then fetches
   back 256 bytes to check that what landed is what was promised.

   That split is also the security model. Between sign and complete the
   object is whatever the browser chose to send — a signed URL is a
   capability, not a guarantee — so a row stays "pending" and unusable
   until the bytes have been looked at. The client's declared MIME type is
   a hint; the magic bytes are the fact.

   Registered from index.js like any other route group, but kept in lib/
   rather than inlined there because index.js is already seven thousand
   lines and this is a self-contained feature with its own dependencies.
   ================================================================= */
"use strict";

const express = require("express");
const uploads = require("./uploads");
/* No direct s3 require any more, and that is the point of the seam: this
   file decides policy — what types are allowed, what the quota is, what
   the bytes have to prove — and blobs.js decides where the bytes go. */
const blobs = require("./storage/blobs");
const vision = require("./codeagent/vision");

/* Raised from the old 2MB because direct-to-bucket removed the reason for
   it — that cap existed to keep a base64 data URL inside a JSON request
   body. A modern phone photo is 3-6MB and should not be refused.

   This is now the ceiling for the BUCKET path only. With the bytes in the
   database the limit is lower and set by a different constraint entirely
   — see blobs.maxBytes(), which is the one to ask. */
const MAX_BYTES = Number(process.env.UPLOADS_MAX_BYTES) || 10 * 1024 * 1024;
const MAX_PER_MESSAGE = Number(process.env.UPLOADS_MAX_PER_MESSAGE) || 8;
const MONTHLY_PER_OWNER = Number(process.env.UPLOADS_MONTHLY_PER_OWNER) || 60;

/* SVG is deliberately absent, and it is the one exclusion worth explaining.
   As an <img src> it never executes — but the bucket is public-read so that
   published sites keep working without an expiring signature, which means
   anyone can NAVIGATE to the URL, and an SVG then runs as a document in the
   asset domain's origin. Allowing it would turn a bucket that hosts nothing
   else into an XSS surface. A PNG export is five seconds of work; a
   sanitiser that is actually correct is a day of it. */
const ALLOWED = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif"
};

/**
 * What the bytes actually are.
 *
 * The declared Content-Type is chosen by the uploader and signed into the
 * URL, which pins what the bucket will accept but says nothing about the
 * content. This is the check that a .png is a PNG.
 */
function sniff(buf) {
  if (!buf || buf.length < 12) return "";
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return "";
}

function monthStartIso() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/**
 * @param {object} app          express app
 * @param {object} deps
 * @param {function} deps.appOwnerOf   (req,res) -> {userId, anonId, email}
 * @param {function} deps.isAdminEmail (email) -> boolean
 * @param {function} [deps.limiter]    rate-limit middleware
 * @param {function} [deps.recordSpend] (owner, usd) -> void
 */
function register(app, deps) {
  const ownerOf = deps.appOwnerOf;
  const isAdmin = deps.isAdminEmail || (() => false);
  const limiter = deps.limiter || ((req, res, next) => next());

  /* ---- 1. mint a presigned PUT ------------------------------------ */
  app.post("/api/uploads/sign", limiter, async (req, res) => {
    /* Must run before anything writes a header — it sets the sq_anon
       cookie, which is the identity every later step checks against. */
    const owner = ownerOf(req, res);

    /* Asks the seam, not S3 directly. Unconfigured object storage is no
       longer the end of the story — the database takes the bytes instead —
       so this 503 now means what it says: there is nowhere at all to put
       them. */
    if (!blobs.available()) {
      return res.status(503).json({ error: "Image uploads aren't set up on this server yet." });
    }

    const body = req.body || {};
    const type = String(body.type || "").toLowerCase();
    const ext = ALLOWED[type];
    if (!ext) {
      return res.status(415).json({
        error: "That file type isn't supported. Use a PNG, JPG, WebP or GIF."
      });
    }

    const limit = blobs.maxBytes();
    const bytes = Number(body.bytes) || 0;
    if (bytes > limit) {
      return res.status(413).json({
        error: "That image is " + Math.round(bytes / 1048576) + "MB — the limit is " +
          Math.round(limit / 1048576) + "MB."
      });
    }
    /* Required on the database path and only there: the number of parts
       cannot be computed without it. On the bucket path it stays advisory,
       because the browser PUTs directly and the HEAD in /complete is what
       measures the truth. */
    if (blobs.backend() === "db" && !bytes) {
      return res.status(400).json({ error: "The upload needs to declare its size." });
    }

    // Quota is a month of uploads per owner. Admins are exempt, same as builds.
    if (!isAdmin(owner.email)) {
      const used = await uploads.countSince(owner, monthStartIso());
      if (used >= MONTHLY_PER_OWNER) {
        return res.status(429).json({
          error: "You've uploaded " + used + " images this month, which is the limit."
        });
      }
    }

    const key = blobs.newKey(ext);
    const row = await uploads.create({
      owner: owner,
      key: key,
      url: blobs.publicUrl(key),
      name: String(body.name || "image." + ext),
      mime: type,
      ext: ext,
      bytes: bytes,
      width: Number(body.width) || 0,
      height: Number(body.height) || 0,
      seedHex: String(body.seedHex || "")
    });

    const up = blobs.plan(key, { contentType: type, bytes: bytes });
    res.json({
      id: row.id,
      /* The bucket's two fields stay at the top level, exactly where they
         were, so a client cached from before this change keeps working
         untouched. `upload` is additive and carries the branch. */
      putUrl: up.putUrl,
      headers: up.headers,
      expiresIn: up.expiresIn,
      upload: up.mode === "parts"
        ? { mode: "parts", partSize: up.partSize, parts: up.parts,
            partUrl: "/api/uploads/" + row.id + "/part/" }
        : { mode: "put" }
    });
  });

  /* ---- 1b. one slice of a file, when the database is the store ----- */
  /* PUT, because it is idempotent by construction: a part is stored under
     its index and a retry replaces itself. The raw body reaches here only
     because index.js exempts this path from the global JSON parser — see
     the note there, which is the same lesson the Stripe webhook taught.

     This route does not exist on the bucket path, where the browser PUTs
     straight to the bucket and these bytes never touch the function. */
  app.put("/api/uploads/:id/part/:index", limiter, express.raw({
    type: "*/*", limit: blobs.partBytes() + 4096
  }), async (req, res) => {
    const owner = ownerOf(req, res);
    const row = await uploads.get(String(req.params.id || ""));
    if (!row || !uploads.owns(row, owner)) return res.status(404).json({ error: "not found" });
    // A finished upload cannot have its bytes rewritten underneath it.
    if (row.status !== "pending") return res.status(409).json({ error: "that upload is already finished" });

    const index = Number(req.params.index);
    if (!Number.isInteger(index)) return res.status(400).json({ error: "bad part index" });

    const partSize = blobs.partBytes();
    const parts = Math.max(1, Math.ceil((Number(row.bytes) || 1) / partSize));
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    /* Sniffing part 0 the moment it lands is an OPTIMISATION — it fails a
       lie after one megabyte instead of after the whole file. It is NOT
       the security boundary; /complete re-reads the committed bytes and
       that check is the one that matters. Do not delete it as redundant. */
    if (index === 0 && buf.length >= 12) {
      const early = sniff(buf);
      if (!early || early !== row.mime) {
        await blobs.remove(row.key);
        await uploads.markFailed(row.id, "content is " + (early || "unrecognised") + ", not " + row.mime);
        return res.status(415).json({ error: "That file isn't the image type it claimed to be." });
      }
    }

    const put = await blobs.putPart(row.key, index, buf, {
      parts: parts, partSize: partSize, declaredBytes: Number(row.bytes) || 0
    });
    if (!put.ok) {
      if (put.status === 413) {
        await blobs.remove(row.key);
        await uploads.markFailed(row.id, put.error);
      }
      return res.status(put.status || 500).json({ error: put.error || "the part was not stored" });
    }
    res.json({ ok: true, index: index, parts: parts, received: put.received });
  });

  /* ---- 2. verify what landed -------------------------------------- */
  app.post("/api/uploads/:id/complete", limiter, async (req, res) => {
    const owner = ownerOf(req, res);
    const row = await uploads.get(String(req.params.id || ""));
    if (!row || !uploads.owns(row, owner)) return res.status(404).json({ error: "not found" });
    if (row.status === "ready") {
      // Idempotent: a retried completion returns the same answer rather than
      // paying for a second description of the same image.
      return res.json({ id: row.id, url: row.url, description: row.description });
    }

    /* One caller gets to verify, and the transition decides which.
       Read-then-write here was a race that a bucket forgave and the
       database does not: the winner stitches the parts and deletes them,
       and the loser then finds none and fails a good upload. */
    if (!await uploads.claimForVerify(row.id)) {
      return res.status(409).json({ error: "That upload is already being checked." });
    }

    let sniffed = "", realBytes = 0;
    try {
      // Stitches the parts on the database path; a no-op against a bucket,
      // which already holds the whole object.
      const partCount = Math.max(1, Math.ceil((Number(row.bytes) || 1) / blobs.partBytes()));
      const fin = await blobs.finalize(row.key, { contentType: row.mime, parts: partCount });
      if (!fin.ok) throw new Error(fin.error || "could not assemble the upload");

      /* 256 bytes, not the whole object. Enough for every signature we
         check, and it keeps a photo from crossing the function to answer a
         question about its first twelve bytes. */
      const ranged = await blobs.readRange(row.key, 0, 255);
      if (!ranged.ok) throw new Error("could not read the bytes back");
      sniffed = sniff(ranged.buf);

      const meta = await blobs.head(row.key);
      realBytes = (meta && meta.bytes) || 0;
    } catch (e) {
      await uploads.markFailed(row.id, "could not read back: " + e.message);
      return res.status(502).json({ error: "The upload didn't finish. Try again." });
    }

    /* The two ways a signed URL gets abused: send something that is not an
       image at all, or send an image of a different type than was signed
       for. Both end the same way — the object is removed, because leaving
       unverified content in a public bucket is the actual risk. */
    if (!sniffed || sniffed !== row.mime) {
      await blobs.remove(row.key);
      await uploads.markFailed(row.id, "content is " + (sniffed || "unrecognised") + ", not " + row.mime);
      return res.status(415).json({ error: "That file isn't the image type it claimed to be." });
    }
    if (realBytes > blobs.maxBytes()) {
      await blobs.remove(row.key);
      await uploads.markFailed(row.id, "oversize: " + realBytes);
      return res.status(413).json({ error: "That image is over the size limit." });
    }

    await uploads.markReady(row.id, {
      bytes: realBytes, mime: sniffed, width: row.width, height: row.height
    });

    /* Describe it now, once, while the person is still looking at a
       spinner — not at build time, where it would be paid again on every
       edit and would add latency to the thing they are waiting for. */
    let description = "";
    if (vision.available()) {
      try {
        const whole = await blobs.read(row.key);
        if (whole.ok) {
          const seen = await vision.describe(whole.buf, sniffed);
          if (seen) {
            description = seen.description;
            await uploads.setDescription(row.id, seen.description, seen.costUsd);
            if (deps.recordSpend) { try { deps.recordSpend(owner, seen.costUsd); } catch (e) {} }
          }
        }
      } catch (e) { /* soft: an undescribed image is still a usable image */ }
    }
    // Records that we asked, so a failure is not retried on every turn.
    if (!description) await uploads.setDescription(row.id, "", 0);

    res.json({ id: row.id, url: row.url, description: description });
  });

  /* ---- 3. serve the bytes ----------------------------------------- */
  /* Registered ALWAYS, and this is a fix, not a fallback concern.
     It used to be skipped whenever S3_PUBLIC_BASE_URL was set — which
     means the day a CDN domain is configured, every URL minted before it
     stops resolving. publicUrl() bakes these strings permanently into
     published customer source and exported ZIPs, so those are not URLs
     anyone can go back and rewrite. It was latent only because nothing
     had ever been uploaded in production; storing bytes in the database
     makes every URL minted from now until the switch a relative one, and
     would have made it certain.

     It reads BOTH stores, database first, which is the entire migration
     story: while S3 is being turned on, new uploads land in the bucket
     and everything older still answers out of Mongo. */
  app.get("/api/img/*", async (req, res) => {
    const key = String(req.params[0] || "");
    if (!/^u\/[0-9a-f]{32}\.[a-z0-9]{1,5}$/.test(key)) return res.status(404).end();
    try {
      const meta = await blobs.head(key);
      if (!meta.ok) return res.status(404).end();

      // The sniffed type, stored at finalize — strictly stronger than
      // echoing back the type the uploader declared.
      res.set("Content-Type", meta.contentType || "application/octet-stream");
      // Immutable: the key contains 128 bits of randomness and an object
      // is never rewritten under the same one.
      res.set("Cache-Control", "public, max-age=31536000, immutable");
      res.set("X-Content-Type-Options", "nosniff");
      if (meta.etag) res.set("ETag", meta.etag);
      if (meta.bytes) res.set("Content-Length", String(meta.bytes));

      /* Both of these answer from metadata alone. head() projects `data`
         away, so neither a HEAD nor a 304 pulls megabytes out of the
         database to say nothing changed — which on this path is the whole
         cost of the request for none of its value. */
      if (req.method === "HEAD") return res.status(200).end();
      if (meta.etag && req.headers["if-none-match"] === meta.etag) return res.status(304).end();

      const got = await blobs.read(key);
      if (!got.ok) return res.status(404).end();
      res.send(got.buf);
    } catch (e) { res.status(502).end(); }
  });
}

module.exports = { register, sniff, ALLOWED, MAX_BYTES, MAX_PER_MESSAGE, MONTHLY_PER_OWNER };
