/* =================================================================
   Souqi — rate limiter (Redis / Mongo / in-memory, in that order)
   -----------------------------------------------------------------
   Guards brute-force (login), spam (guest orders/inquiries) and cost
   abuse (AI proxy).

   THE COUNTER HAS TO BE SHARED, and for a long time it was not. Redis
   was the only shared backend, no Redis is configured, and production
   is Vercel — so every limit fell through to a Map that lives inside
   ONE lambda instance. Vercel runs many at once and recycles them
   constantly, so an attacker's attempts landed in a different counter
   each time and every counter started again at zero on the next cold
   start. The login limit read as 30 attempts per 15 minutes and was, in
   practice, close to unlimited.

   Mongo is the fix available today: the app is already connected to it,
   it is shared across every instance by definition, and one indexed
   findOneAndUpdate is a cheaper round-trip than the bcrypt compare the
   login route is about to do anyway. Redis stays ahead of it when it is
   configured — it is faster and purpose-built — and the in-memory map
   stays behind both, for local runs and for the moments the database is
   unreachable.

   Failing OPEN is deliberate, at every level. A rate limiter that locks
   every customer out when its store blips has caused a worse outage
   than the abuse it prevents.

   Emits standard X-RateLimit-* / Retry-After headers and a 429 envelope.
   ================================================================= */
"use strict";
const { httpError } = require("../lib/errors");
const { getMasterDb } = require("../db");

const redisUrl = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "").trim().replace(/\/+$/, "");
const redisToken = (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "").trim();
const hasRedis = Boolean(redisUrl && redisToken);

/* Every limiter gets its OWN namespace, and that is not cosmetic.
   In-memory each limiter had a private Map, so two limiters keyed the
   same way could never collide. The moment the counter is shared, they
   can: visitLimiter and any other ip-keyed limiter would both write
   "rl:<ip>" and spend each other's budget, and the tighter of the two
   would start refusing traffic the looser one had used up. Nothing
   passed a prefix, so all of them were "rl". */
let seq = 0;

/* WHOSE ADDRESS THIS IS.

   Every limiter in the app keys on the caller's IP, and for a long time
   none of them did. Express only reads X-Forwarded-For when `trust proxy`
   is set, and it is set nowhere — so `req.ip` was the socket peer, and on
   both deployments the socket peer is a proxy. Measured on the dev server:
   three POSTs carrying three different client addresses took the SAME
   bucket, 119 -> 118 -> 117. On Vercel that is one counter for the whole
   internet: 20 project creations per 15 minutes shared by every visitor,
   and a login limit that a second visitor can exhaust for everybody.

   Fixed here rather than with `app.set("trust proxy")` on purpose. That
   switch also rewrites req.protocol and req.secure for every route and
   every cookie decision in the app; this needs one thing, so it changes
   one thing.

   The order matters, and so does what is NOT trusted:

   - x-vercel-forwarded-for is set by Vercel's edge, which overwrites any
     copy the client sends. It is the one header here that cannot be
     forged, so it wins.
   - Otherwise the LAST entry of x-forwarded-for, not the first. Both
     deployments put exactly one proxy in front of the app — Vercel's edge
     and, on the VPS, the Caddy in infra/deploy/docker-compose.yml — and
     each APPENDS the peer it actually saw. Anything a client puts in that
     header lands to the left of it and is ignored. Reading the first
     entry, which is the usual way this is written, would hand every
     caller a free `X-Forwarded-For: <anything>` bypass.
   - TRUST_PROXY_HOPS=0 turns that off for a deployment that exposes the
     app directly, where the header is attacker-controlled and req.ip is
     the honest answer.

   Returning "" is deliberate when nothing identifies the caller: an empty
   key is still a key, so those callers share one bucket rather than each
   getting an unlimited private one. */
function normalizeIp(raw) {
  let v = String(raw || "").trim();
  if (!v) return "";
  if (v[0] === "[") {                    // [::1]:53124
    const end = v.indexOf("]");
    if (end > 0) v = v.slice(1, end);
  } else if (v.slice(0, 7) === "::ffff:") {
    v = v.slice(7);                      // ::ffff:203.0.113.7 is 203.0.113.7
  } else if (v.indexOf(":") > -1 && v.indexOf(":") === v.lastIndexOf(":")) {
    v = v.slice(0, v.indexOf(":"));      // 203.0.113.7:53124 — one colon means a port
  }
  return v.toLowerCase();
}

function clientIp(req) {
  const headers = (req && req.headers) || {};

  const vercel = String(headers["x-vercel-forwarded-for"] || "").split(",")[0];
  if (vercel.trim()) return normalizeIp(vercel);

  const hops = process.env.TRUST_PROXY_HOPS === undefined
    ? 1
    : Number(process.env.TRUST_PROXY_HOPS);
  if (hops > 0) {
    const chain = String(headers["x-forwarded-for"] || "")
      .split(",").map((x) => x.trim()).filter(Boolean);
    if (chain.length) return normalizeIp(chain[Math.max(0, chain.length - hops)]);
  }

  return normalizeIp((req && req.ip) || (req && req.socket && req.socket.remoteAddress) || "");
}

/* One index, created once, so the rows clean themselves up. expireAfter
   Seconds:0 means "delete when the date in this field passes", which is
   exactly a fixed window's reset time. */
let indexReady = null;
function ratesCollection() {
  const db = getMasterDb && getMasterDb();
  if (!db) return null;
  const c = db.collection("ratelimits");
  if (!indexReady) {
    indexReady = c.createIndex({ reset: 1 }, { expireAfterSeconds: 0 }).catch(() => {});
  }
  return c;
}

function rateLimit({ windowMs, max, key, prefix }) {
  const ns = prefix || ("rl" + (++seq));
  const hits = new Map(); // k -> { count, reset }
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  if (timer.unref) timer.unref();

  return async function (req, res, next) {
    const rawKey = String((key ? key(req) : (clientIp(req) || "ip")));
    const now = Date.now();

    if (hasRedis) {
      try {
        const fullKey = ns + ":" + rawKey;
        const pipeRes = await fetch(redisUrl + "/pipeline", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + redisToken,
            "Content-Type": "application/json"
          },
          body: JSON.stringify([
            ["INCR", fullKey],
            ["PTTL", fullKey]
          ]),
          signal: AbortSignal.timeout(2000)
        });

        if (pipeRes.ok) {
          const results = await pipeRes.json();
          const count = results && results[0] && results[0].result;
          let pttl = results && results[1] && results[1].result;

          if (count === 1 || pttl <= 0) {
            fetch(redisUrl + "/pexpire/" + encodeURIComponent(fullKey) + "/" + windowMs, {
              headers: { "Authorization": "Bearer " + redisToken }
            }).catch(() => {});
            pttl = windowMs;
          }

          const remaining = Math.max(0, max - count);
          const resetSeconds = Math.max(1, Math.ceil((pttl > 0 ? pttl : windowMs) / 1000));

          res.setHeader("X-RateLimit-Limit", String(max));
          res.setHeader("X-RateLimit-Remaining", String(remaining));
          res.setHeader("X-RateLimit-Reset", String(Math.floor(Date.now() / 1000) + resetSeconds));

          if (count > max) {
            res.setHeader("Retry-After", String(resetSeconds));
            return next(httpError(429, "rate_limited", "too many requests — please slow down"));
          }
          return next();
        }
      } catch (err) {
        // Fall back below
      }
    }

    /* ---- Mongo: shared across instances, which is the whole point ---- */
    const rates = ratesCollection();
    if (rates) {
      try {
        const id = ns + ":" + rawKey;
        /* Increment only a window that is still open. If the filter misses
           — no row, or the window has passed — this is the first hit of a
           new window and the upsert below starts one.

           Two instances can both miss on the same tick and both write
           count:1, which costs an attacker one extra attempt out of
           thirty. The alternative is a transaction per login attempt,
           which is a real cost for an imaginary gain. */
        const open = await rates.findOneAndUpdate(
          { _id: id, reset: { $gt: new Date(now) } },
          { $inc: { count: 1 } },
          { returnDocument: "after", projection: { count: 1, reset: 1 } }
        );
        /* The driver changed shape at v6: findOneAndUpdate used to return
           { value, ok } and now returns the document itself. Handle both,
           because getting it wrong means every hit looks like a new window
           and the limit never trips. */
        const doc = open ? (open.value !== undefined ? open.value : open) : null;

        let count, resetAt;
        if (doc && doc.reset) { count = doc.count; resetAt = new Date(doc.reset).getTime(); }
        else {
          resetAt = now + windowMs;
          await rates.updateOne({ _id: id }, { $set: { count: 1, reset: new Date(resetAt) } }, { upsert: true });
          count = 1;
        }

        const resetSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
        res.setHeader("X-RateLimit-Limit", String(max));
        res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - count)));
        res.setHeader("X-RateLimit-Reset", String(Math.floor(now / 1000) + resetSeconds));
        if (count > max) {
          res.setHeader("Retry-After", String(resetSeconds));
          return next(httpError(429, "rate_limited", "too many requests — please slow down"));
        }
        return next();
      } catch (err) {
        // Database unreachable — fall through rather than lock everyone out.
      }
    }

    let e = hits.get(rawKey);
    if (!e || e.reset <= now) { e = { count: 0, reset: now + windowMs }; hits.set(rawKey, e); }
    e.count++;
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - e.count)));
    if (e.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((e.reset - now) / 1000)));
      return next(httpError(429, "rate_limited", "too many requests — please slow down"));
    }
    next();
  };
}

module.exports = { rateLimit, clientIp };

