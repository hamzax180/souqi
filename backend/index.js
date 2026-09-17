/* =================================================================
   Souqi — REST + auth + AI proxy backend (Multi-Database Support)
   -----------------------------------------------------------------
   Implements exactly the contract the front-end Store expects.
   Workspace/DB context is resolved SERVER-SIDE from the signed JWT
   session (via tenantScope middleware) for authenticated requests,
   or from the :wsId path param for public portal routes.
   Client headers never select which database is used.
   ================================================================= */
const path = require("path");
const fs = require("fs");
// Explicit path, not the default require("dotenv").config() — that
// resolves .env relative to process.cwd(), which silently does nothing
// (no error, no warning) whenever this is launched from anywhere other
// than server/ itself. Found live: DAYTONA_API_KEY IS set in
// server/.env, but a launcher starting `node server/index.js` from the
// repo root left process.env.DAYTONA_API_KEY undefined, and every build
// failed at sandbox creation with "DAYTONA_API_KEY is not set" — a
// working-directory bug wearing a missing-credentials error message.
require("dotenv").config({ path: path.join(__dirname, ".env") });
const crypto = require("crypto");
const dns = require("dns");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { connect, getMasterDb } = require("./db"); // default master MongoDB connection
const { testConnection, seedWorkspaceDatabase, dbAdapter } = require("./db-adapters");
const { idForCollection } = require("./lib/ids");
const { httpError, errorHandler } = require("./lib/errors");
const requestId = require("./middleware/requestId");
const { makeAuth } = require("./middleware/auth");
const { validateBody } = require("./lib/validate");
const { loginSchema, orderSchema, inquirySchema, microClaimSchema, signupSchema } = require("./lib/schemas");
const { initIdempotency, withIdempotency } = require("./lib/idempotency");
const securityHeaders = require("./middleware/securityHeaders");
const { rateLimit } = require("./middleware/rateLimit");
const { encryptSecret, decryptSecret } = require("./lib/crypto");
const aiProviders = require("./lib/ai/providers");
const aiClient = require("./lib/ai/client");
const scaffoldFiles = require("./lib/codeagent/scaffold-files");
const theme = require("./lib/codeagent/theme");
/* Scaffold files the BROWSER's build container does not mount for itself and
   the model is not allowed to write, so they have to travel with the files
   frame or the build cannot resolve them.

   Only src/ files belong here. index.html, package.json, vite.config.ts and
   the rest are already in wc-runtime.js's own mount and are not things the
   model imports; payments.ts is the one the prompt actively instructs it to
   import. Keep this list minimal — everything on it is sent on every build
   round. */
const SCAFFOLD_RUNTIME_FILES = ["src/lib/payments.ts"];
const scaffoldAll = scaffoldFiles.readScaffold();
const secretscan = require("./lib/secretscan");
const depscan = require("./lib/depscan");
const stripeLib = require("./lib/stripe");

/* How long a brief is allowed to be.

   This was 2000 characters, in four separate hardcoded copies, and it was
   far too tight for what people actually type. A brief describing a real
   app — the features, the levels, the tabs, what happens at each one —
   runs past 2000 without trying, and the only feedback was "prompt is too
   long" after they had written the whole thing. Someone who has just
   described their idea in detail is exactly the person you least want to
   throw away.

   16000 characters is roughly 2500 words, or about 4000 tokens against a
   64k context, so it costs a fraction of a build and nothing is at risk
   of being truncated downstream. It is still a bound rather than no bound
   — a limit exists so a single request cannot be made arbitrarily
   expensive, and the per-route rate limiters do the rest. */
const MAX_PROMPT_CHARS = 16000;

/* Long enough to say what is wrong AND what to do about it. "prompt is
   too long" tells someone nothing they can act on; the number they wrote
   and the number allowed tells them exactly how much to cut. */
function tooLongMessage(kind, len, cap) {
  const limit = cap || MAX_PROMPT_CHARS;
  const upsell = limit < MAX_PROMPT_CHARS
    ? " Subscribers can write up to " + MAX_PROMPT_CHARS.toLocaleString() + "."
    : "";
  return kind + " is too long \u2014 " + len.toLocaleString() + " characters, and the limit is "
    + limit.toLocaleString() + ". Trim it a little and send it again." + upsell;
}

const githubLib = require("./lib/github");
const mcpClient = require("./lib/codeagent/mcp");
const requestLog = require("./middleware/requestLog");
const metrics = require("./lib/metrics");
const { writeAudit, writeMasterAudit } = require("./lib/audit");
const { verifyCaptcha } = require("./middleware/captcha");

const app = express();
app.disable("x-powered-by");

// Per-route body limits. Storefront-config routes carry inline data-URL
// images and legitimately run to a few MB; everything else is capped tight
// to shrink the DoS surface.
const jsonBig = express.json({ limit: "12mb" });
const jsonDefault = express.json({ limit: "4mb" });
app.use((req, res, next) => {
  /* The Stripe webhook is authenticated by an HMAC over the RAW request
     bytes, so it has to reach its own express.raw() with the stream still
     unread. Parsing it here set req._body, body-parser then SKIPPED the raw
     parser on the route, and verifyWebhook was handed the parsed object
     instead of the bytes — it stringified to [object Object] and no genuine
     Stripe signature could ever match it. The route looked correct in
     isolation, which is why this survived: the damage is done four hundred
     lines earlier, by a middleware that runs on everything. */
  if (req.path === "/api/stripe/webhook") return next();

  // /api/codeagent/build: a base64-encoded logo upload (see attachLogoIfPresent)
  // can legitimately run to ~4MB even after the client's own 2MB cap on the
  // decoded image — base64 adds ~33%, and this is JSON, not multipart.
  const big = req.path === "/api/storefront/config" || req.path === "/api/codeagent/build"
    || /^\/api\/ws\/[^/]+\/domain$/.test(req.path);
  return (big ? jsonBig : jsonDefault)(req, res, next);
});

/* CORS_ORIGIN is a comma-separated allowlist. `*` reflects whatever Origin
   the request carried, which is the right default for local development
   and the wrong one for a public deployment — so production refuses to
   start on it rather than quietly serving every origin that asks.

   Worth being precise about what this does and does not protect: browsers
   never send sq_session cross-origin, because credentials are not enabled
   on this middleware and the cookie is SameSite=Lax. So a wildcard was
   never an account-takeover route. What it did allow was any site reading
   this API's unauthenticated responses from its own page. */
let origins = (process.env.CORS_ORIGIN || "*").split(",").map((s) => s.trim()).filter(Boolean);
let corsWildcard = origins.includes("*");

/* A wildcard in production is refused — but by NARROWING, not by throwing.

   This used to `throw` here, at module scope. On a long-lived server that is
   a loud startup failure you fix in a minute; in a serverless function it is
   a crash on every single invocation, so one unset variable turned into
   FUNCTION_INVOCATION_FAILED on every API route while the static pages kept
   serving and looked fine. A guard against a misconfiguration must not be
   more destructive than the misconfiguration.

   So the wildcard is dropped and the app's own domain is used instead: the
   safe end of the range it was refusing, and the same value the message
   below asks for. Loud in the log, still running. */
if (corsWildcard && process.env.NODE_ENV === "production") {
  const appDomain = (process.env.APP_DOMAIN || "souqi.site").toLowerCase();
  origins = ["https://" + appDomain, "https://www." + appDomain];
  corsWildcard = false;
  console.error(
    "[cors] CORS_ORIGIN is '*' in production — refusing it and falling back to " +
    origins.join(", ") + ". Set CORS_ORIGIN explicitly to the origins allowed " +
    "to call this API, e.g. CORS_ORIGIN=https://" + appDomain + ",https://www." + appDomain
  );
}
/* =================================================================
   THE TWO ENDPOINTS A PUBLISHED APP IS ALLOWED TO CALL
   -----------------------------------------------------------------
   Published apps run in an opaque origin (see securityHeaders — the
   sandbox is what stops one reading the platform API as whoever opens
   it). An opaque origin sends `Origin: null` and is cross-origin to
   everything, so a shop could no longer fetch its own prices or start a
   checkout.

   Allowing any origin is correct HERE and nowhere else, because both
   were already public and credential-free by design: the prices are not
   a secret, and a shopper has no Souqi account. `*` also forbids
   credentials by specification, which is the property wanted — no cookie
   can ride one of these even by accident.

   AHEAD of the global cors(), because that one answers the preflight
   itself and answers it for an allowlist these two are not on: OPTIONS
   came back 204 with no Access-Control-Allow-Origin at all, which fails
   the preflight and blocks the POST that follows. Measured, after the
   first attempt at this put the handler on the route instead, where it
   never ran.
   ================================================================= */
const PUBLIC_APP_PATH = /^\/api\/apps\/[^\/]+\/(payment-items|checkout)$/;
app.use((req, res, next) => {
  if (!PUBLIC_APP_PATH.test(req.path || "")) return next();
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.vary("Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.use(cors({ origin: corsWildcard ? true : origins }));

// Every request gets a unique correlation id (req_...), echoed as X-Request-Id.
app.use(requestId);
// Baseline security headers on every response.
app.use(securityHeaders);
// Structured per-request logging + metrics.
app.use(requestLog);

// Reusable limiters for the abuse-prone endpoints.
/* TWO limits on the way in, because one of them answers a question the
   other cannot.

   Per (address, account) catches someone guessing ONE person's password:
   thirty tries a quarter-hour against a bcrypt hash is nothing.

   Per address catches the attack that actually happens. Credential
   stuffing does not guess many passwords for one account, it tries ONE
   leaked password against thousands of accounts — and under the first
   key alone every new email address is a brand-new bucket with a fresh
   thirty, so a stuffing run from a single host was never throttled at
   all. The second limiter is the ceiling across every account that host
   touches.

   120 is deliberately loose. A household, an office or a phone network
   behind one NAT address shares it, and locking out a whole office to
   slow one attacker is a bad trade — the per-account limit is what
   protects the individual, and this only has to make a run of thousands
   of attempts impractical. */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30, prefix: "rl-login-acct",
  key: (req) => (req.ip || "") + ":" + String((req.body && req.body.email) || "").toLowerCase()
});
const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 120, prefix: "rl-login-ip",
  key: (req) => req.ip || ""
});
const orderLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, key: (req) => (req.ip || "") + ":" + req.params.wsId });
const inquiryLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, key: (req) => (req.ip || "") + ":" + req.params.wsId });
const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
const visitLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, key: (req) => req.ip || "" });

/* ---- a custom domain is that project's site, and nothing else ----

   THIS HAS TO RUN FIRST. It used to be registered several hundred lines
   down — after app.get("/") and after express.static — so on a connected
   custom domain the root path served Souqi's own marketing page and the
   customer's app was reachable at no address at all. The one URL that
   matters most on a domain someone just pointed at us was the one URL
   that showed them somebody else's homepage.

   It waits for Mongo itself rather than being moved below the ensureDb
   middleware, because that one sits under express.static deliberately so
   static assets never block on a database. Only a request on a custom
   host pays for this.

   /api and /auth are excluded below: a customer's domain serves their
   SITE, and does not get to be the platform's API or its sign-in page. */
app.use(async (req, res, next) => {
  const host = (req.hostname || "").toLowerCase().replace(/^www\./, "");
  if (PLATFORM_HOSTS.has(host)) return next();   // the platform itself

  const p = req.path || "";
  if (p.indexOf("/api/") === 0 || p.indexOf("/auth/") === 0) return next();

  try {
    await ensureDb();
    const masterDb = getMasterDb();
    if (masterDb) {
      const codeProject = await projects.findByCustomDomain(host);
      if (codeProject && codeProject.published) {
        return servePublishedSite(req, res, p.replace(/^\//, ""), codeProject);
      }
    }
  } catch (err) {
    // Non-fatal: fall through and let the platform answer.
  }
  next();
});

/* The one place the served directory is named.

   It used to be spelled out at all 22 send sites and resolved a 23rd time
   for the page fallback, so renaming the folder meant finding every one of
   them and missing none. Now the fallback's own traversal guard and every
   route read the same constant. */
const PUBLIC_DIR = path.resolve(__dirname, "..", "frontend");

// home.html is the public entry point — the marketing page, not login.
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "home.html")));

// WebContainers require Cross-Origin Isolation (SharedArrayBuffer).
// These headers ONLY apply to the builder page, not globally — set
// site-wide they blank every deployed-app preview thumbnail on /projects
// and /deployments, because those apps send no cross-origin headers of
// their own (see the long note in middleware/securityHeaders.js).
//
// /agent and /agent/:slug are in this list because THEY are the routes a
// user actually lands on; both sendFile code.html. Without them the page
// loads fine, SharedArrayBuffer is undefined, and WebContainer.boot()
// fails — a build that dies for a reason nothing on the page explains.
// (/code and /code.html stay listed: they serve the same document, so
// isolating one entry point and not the others would just move the bug.)
//
// /settings is here for the OTHER reason a route belongs in this list: it
// does not need isolation itself, it is FRAMED by pages that have it. A
// document embedded in a COEP context must assert COEP too, and that rule
// is not origin-scoped — a same-origin child is blocked exactly like a
// cross-origin one, and `credentialless` relaxes the requirement for
// subresources, never for frames. The builder's settings overlay is an
// <iframe src="/settings">, so with no COEP on the response the browser
// refused the navigation and painted "localhost refused to connect" where
// the settings panel should have been. Anything else this page ever frames
// has to be added here for the same reason.
function crossOriginIsolate(req, res, next) {
  res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  next();
}
app.use("/agent", crossOriginIsolate);
app.use("/code", crossOriginIsolate);
app.use("/code.html", crossOriginIsolate);
app.use("/settings", crossOriginIsolate);
app.use("/settings.html", crossOriginIsolate);

app.use(express.static(PUBLIC_DIR));

/* Wait for Mongo before running any route that might need it.
   -----------------------------------------------------------------
   getMasterDb() returns `db || null` and never connects on its own, so
   whether a request works depends entirely on whether the connection had
   already resolved by the time it arrived. With a long-lived server that
   is fine: ensureDb() is awaited before app.listen(), so by the time a
   request can arrive the connection exists.

   On Vercel there is no listen() to gate on. ensureDb() was started and
   not awaited, so every request landing on a COLD instance saw null and
   answered 503 "Master DB not available" — while warm instances served
   the same route perfectly. That is why signup failed consistently and
   /api/account/me looked fine: signup is rare enough to always land cold.

   Awaiting it here costs nothing once warm (an already-resolved promise)
   and is the difference between working and not on the first request to
   a new instance. Failures still fall through: ensureDb() swallows its
   own error and clears the cached promise, so the route below still gets
   null and still answers 503 — this removes the race, not the error
   path. Static assets are served above this line and never wait. */
app.use(async (req, res, next) => {
  try { await ensureDb(); } catch (e) { /* route-level null check reports it */ }
  next();
});

const JWT_SECRET = process.env.JWT_SECRET || "dev-insecure-secret";
// Fail closed: never boot production with a default/placeholder secret.
if (process.env.NODE_ENV === "production" && (!process.env.JWT_SECRET || JWT_SECRET === "dev-insecure-secret")) {
  console.error("FATAL: JWT_SECRET must be set to a strong secret in production. Refusing to start.");
  process.exit(1);
}
if (JWT_SECRET === "dev-insecure-secret") {
  console.warn("⚠ JWT_SECRET is using the insecure development default — set a strong JWT_SECRET before production.");
}
if (!process.env.DB_ENCRYPTION_KEY) {
  console.warn("⚠ DB_ENCRYPTION_KEY is unset — users will not be able to store their own API keys (BYOK). Set a 32-byte hex key: openssl rand -hex 32");
}

// Server-authoritative auth / tenancy / RBAC middleware.
const { requireSession, tenantScope, authorizeCrud, requireAdmin, resolveWsContext } = makeAuth({ JWT_SECRET, getMasterDb });
initIdempotency({ getMasterDb });

/* =================================================================
   SESSION REVOCATION, IN ONE PLACE
   -----------------------------------------------------------------
   "Sign out other sessions" bumps a sessionEpoch on the user, and a
   token carrying an older one is supposed to stop working. Exactly one
   helper checked that — codeAgentSessionUserVerified — and only a
   handful of routes call it. Measured against the running server, a
   token with a stale epoch still opened the platform admin API, the
   GDPR export, the whole generic CRUD, and every route in Code. The
   button said "signed out"; nothing was.

   Fixing that at each call site means changing appOwnerOf and its
   twenty-five callers from sync to async. Doing it HERE is one function
   and covers everything, including routes written later — the request
   never reaches them carrying a revoked identity.

   It is also cheap, which the old comment assumed it could not be. That
   assumption came from codeAgentSessionUserVerified loading EVERY user in
   the workspace to find one; this reads the one row by id.

   THE EPOCH IS NEVER CACHED, and the first version of this cached it for
   thirty seconds. An end-to-end test caught what that meant: revoke, then
   immediately try the old cookie, and it still worked — the cached value
   matched the token, so nothing even looked at the database. Half a minute
   of "signed out" that is not signed out is most of the time that matters
   in the case the feature exists for. A revocation check that can be stale
   is not a revocation check.

   What IS cached is the workspace context, which is the right thing to
   cache: where a tenant's database lives is configuration and changes
   approximately never, while the epoch is live state and is the whole
   point. That keeps this to ONE read per authenticated request instead of
   two, without holding on to the one value that must be current. The TTL
   is there so a moved database is picked up without a redeploy.

   Fails OPEN. If the database cannot be reached the request proceeds as
   before: every other gate still applies, and refusing everyone because
   Mongo blinked is a worse outage than the window it closes.
   ================================================================= */
/* THE EPOCH LIVES IN THE MASTER DATABASE, mirrored from the user row.

   The first version read the user's own row, which is where the value
   belongs — and cost 195ms per authenticated request in production,
   measured. Not because the query is slow: the row is in the TENANT
   database, which means resolving the workspace and then opening a
   SECOND MongoClient to it. On serverless every cold instance pays that
   handshake, and cold instances are most of them.

   The master connection is already open on every request that does
   anything. So revocation writes to both places — the user row, which
   other code reads, and a master document keyed by user id, which is
   what this reads. One findOne on _id, on a pooled connection, indexed
   by definition.

   Absent means never revoked, which is correct because revoke always
   writes it, and nothing in this database carries a bumped epoch from
   before the mirror existed — checked rather than assumed. */
const REVOCATIONS = "session_epochs";

async function liveSessionEpoch(wsId, userId) {
  const db = getMasterDb();
  if (!db) return null;                 // caller treats a throw/null as "cannot check"
  const row = await db.collection(REVOCATIONS).findOne({ _id: userId }, { projection: { epoch: 1 } });
  return row ? (row.epoch || 0) : 0;
}

/** Strip the credentials off the REQUEST, not just the response. Clearing
    the cookie on the way out does nothing for the handler about to read
    req.headers.cookie and honour the very token being revoked. */
function stripSession(req) {
  delete req.headers.authorization;
  const raw = req.headers.cookie || "";
  const kept = raw.split(";").map((p) => p.trim()).filter((p) => p && !/^sq_session=/.test(p));
  if (kept.length) req.headers.cookie = kept.join("; ");
  else delete req.headers.cookie;
}

app.use(async (req, res, next) => {
  let token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    const m = /(?:^|;\s*)sq_session=([^;]*)/.exec(req.headers.cookie || "");
    if (m) { try { token = decodeURIComponent(m[1]); } catch (e) { token = m[1]; } }
  }
  if (!token) return next();

  let d = null;
  try { d = jwt.verify(token, JWT_SECRET); } catch (e) { return next(); }
  // Not a session: an anon or edit grant carries no id, and requireSession
  // and appOwnerOf both refuse a scope of their own accord.
  if (!d || d.scope || !d.id) return next();

  try {
    const mine = d.sessionEpoch || 0;
    const live = await liveSessionEpoch(d.wsId, d.id);
    // null = the database is not reachable, which is not evidence of a
    // revocation. Fail open, as every other level here does.
    if (live === null || live === mine) return next();

    stripSession(req);
    res.clearCookie("sq_session", { path: "/" });

    /* A page request is answered as a signed-OUT page rather than a JSON
       401, so somebody whose session was revoked lands on the signed-out
       view instead of a wall of JSON in the browser. An API caller gets
       the 401 it can act on.

       /auth/* is neither: it is the way BACK IN. Login and signup
       authenticate from the body and logout only clears, so none of them
       wants the cookie that was just stripped — and answering them 401
       would mean a revoked session could never sign in again, which is
       the same trap the missing epoch stamp set from the other side. */
    const p = req.path || "";
    const isAuthRoute = p.indexOf("/auth/") === 0;
    const wantsJson = !isAuthRoute && (p.indexOf("/api/") === 0 ||
      String(req.headers.accept || "").indexOf("application/json") >= 0);
    if (wantsJson) {
      return res.status(401).json({ error: { code: "session_revoked", message: "this session was signed out", requestId: req.id || null } });
    }
    return next();
  } catch (e) {
    return next();   // cannot check -> behave as before
  }
});

// Canonical subscription plans; anything other than "free" is a paying
// "subscriber". Monthly prices drive the MRR estimate (override via env
// PLAN_PRICES as JSON if your pricing differs).
const PLANS = ["free", "pro", "business", "max", "team", "enterprise"];
let PLAN_PRICES = { free: 0, pro: 29, business: 79, max: 149, team: 199, enterprise: 499 };
try { if (process.env.PLAN_PRICES) PLAN_PRICES = Object.assign(PLAN_PRICES, JSON.parse(process.env.PLAN_PRICES)); } catch (e) { /* keep defaults */ }


// Only these collections may be read/written through the generic CRUD API.
const COLLECTIONS = ["users", "clients", "suppliers", "products", "quotes", "orders", "shipments", "invoices", "purchaseorders", "bills", "payments", "notifications", "audit"];

/* =================================================================
   WHAT NEVER LEAVES THE SERVER
   -----------------------------------------------------------------
   A users row carries the bcrypt hash on the same document as the name
   and the email, because /auth/login needs both in one read. That is
   fine at rest and was not fine on the wire: GET /users, GET /users/:id
   and GET /api/ws/:id/export each answered 200 with every hash in the
   workspace in the body. Checked against the running server, not read
   off the schema.

   bcrypt is not plaintext, but it is offline-crackable at the attacker's
   leisure, and the caller does not have to be an attacker to matter — a
   Staff account reading /users got the Owner's hash, which is a
   privilege escalation with a delay on it. The export is worse: a file
   people email to each other.

   Stripped BY FIELD NAME and for every collection, not by a per-route
   allowlist, so a collection that grows a password column later is
   covered the day it does rather than the day someone remembers. _id
   goes too — Mongo's own key is not part of anyone's API.
   ================================================================= */
const NEVER_SERVED = ["password", "passwordHash", "salt", "resetToken", "sessionEpoch", "_id"];

function servable(doc) {
  if (!doc || typeof doc !== "object") return doc;
  const out = {};
  for (const k of Object.keys(doc)) if (!NEVER_SERVED.includes(k)) out[k] = doc[k];
  return out;
}
const servableAll = (docs) => (Array.isArray(docs) ? docs.map(servable) : docs);

/* =================================================================
   CUSTOM DOMAIN MIDDLEWARE
   Runs on every request. A Host header that is not the platform itself
   is looked up against Souqi Code's published projects, and a match is
   served that project's site.

   It used to check storefront workspaces first and render public/portal.html
   for them. That product is retired, so there is one kind of custom domain
   now: a published project.
   ================================================================= */
/* Hosts that ARE the platform, and therefore never belong to a customer.

   This set had localhost, 127.0.0.1 and PLATFORM_HOST — and not the app's
   own domain. So souqi.site fell through to the custom-domain lookup on
   every request, and a published project claiming that name would have
   been served in its place. Measured against a running server with a
   throwaway host: a matching project took over /api/projects,
   /api/account/me, /auth/login and /login alike.

   Listing them here also removes a database round trip from every request
   to the main domain, which is what that lookup was costing. */
const APP_HOST = (process.env.APP_DOMAIN || "souqi.site").toLowerCase();
const PLATFORM_HOSTS = new Set([
  "localhost", "127.0.0.1",
  APP_HOST,
  "www." + APP_HOST,
  (process.env.PLATFORM_HOST || "app.souqi.site").toLowerCase()
]);

/** Is this name the platform's own, or anything beneath it? */
function isPlatformZone(name) {
  const h = String(name || "").toLowerCase().trim().replace(/\.$/, "");
  if (!h) return true;
  if (PLATFORM_HOSTS.has(h)) return true;
  if (h === APP_HOST || h.endsWith("." + APP_HOST)) return true;
  const plat = (process.env.PLATFORM_HOST || "app.souqi.site").toLowerCase();
  if (h === plat || h.endsWith("." + plat)) return true;
  return false;
}


/* ---- Serve specific frontend pages ----
   The old deterministic site builder (agent.html), the workspace/signup
   flow (signup.html), and the Operations Console (index.html) are gone —
   deleted, not just unrouted. Souqi Code (code.html, at /agent) is the
   only way to build now. Anything that isn't a real product surface
   anymore (/signup, /index, /public/signup, /public/index) is removed
   below rather than left pointing at a 404 sendFile. */
app.get("/home", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "home.html")));
app.get("/agent", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "code.html")));
app.get("/agent/:slug", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "code.html")));
app.get("/build", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "home.html")));
app.get("/login", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "login.html")));
app.get("/signup", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "signup.html")));
app.get("/pricing", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "pricing.html")));
app.get("/terms", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "terms.html")));
app.get("/privacy", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "privacy.html")));
app.get("/settings", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "settings.html")));
app.get("/projects", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "projects.html")));
app.get("/deployments", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "deployments.html")));
app.get("/security", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "security.html")));
app.get("/checkout", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "checkout.html")));
app.get("/mobile", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "mobile.html")));
// Where Stripe Checkout returns a shopper. Souqi-hosted rather than bouncing
// back to a URL the app supplied: a client-named redirect target is an open
// redirect, and this one is reachable by anyone who can open a generated app.
app.get("/pay/success", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "pay-success.html")));
app.get("/pay/cancelled", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "pay-cancelled.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin.html")));

app.get("/public/login", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "login.html")));

/* NOTE: workspace/DB context is no longer derived from client headers.
   Authenticated requests get it from the signed session via the
   tenantScope middleware (server/middleware/auth.js); public portal
   routes resolve it from the :wsId path param via resolvePortalWs().
   The old header-trust helpers were removed to keep that invariant. */

/* ---- health probe ---- */
/* Two paths, one handler. /health is what a probe conventionally asks for
   and is what works locally — but on Vercel the ONLY rewrite into this
   function is /api/:path*, so /health never reaches Express there and
   answers 404 as a missing static file. A health endpoint that is down in
   production and up in dev is worse than not having one, because the first
   thing anyone points an uptime monitor at is the one that lies. */
const healthHandler = (req, res) => res.json({ ok: true, service: "souqi-api", time: new Date().toISOString() });
app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

/* ---- metrics (gated by METRICS_TOKEN; disabled if unset) ---- */
app.get("/metrics", (req, res, next) => {
  const tok = (process.env.METRICS_TOKEN || "").trim();
  if (!tok) return next(httpError(404, "not_found", "metrics disabled"));
  const supplied = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (supplied !== tok) return next(httpError(401, "unauthorized", "metrics token required"));
  res.json(metrics.snapshot());
});

/* =================================================================
   VISIT TRACKING  (public, privacy-preserving)
   Stores a per-visit row with a DAILY-ROTATING hashed visitor id
   (no raw IP/UA persisted), so unique visitors can be counted without
   retaining PII.
   ================================================================= */
app.post("/api/track/visit", visitLimiter, async (req, res) => {
  try {
    const masterDb = getMasterDb();
    if (!masterDb) return res.json({ ok: true });
    const b = req.body || {};
    const day = new Date().toISOString().slice(0, 10);
    const seed = (req.ip || "") + "|" + (req.headers["user-agent"] || "") + "|" + day + "|" + (process.env.VISIT_SALT || "souqi");
    const vid = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
    const coll = masterDb.collection("visits");
    await coll.insertOne({
      id: idForCollection("audit").replace(/^aud_/, "vis_"),
      ts: new Date().toISOString(),
      createdAt: new Date(),
      day,
      path: String(b.path || "/").slice(0, 200),
      type: b.type === "portal" ? "portal" : "marketing",
      wsId: b.wsId ? String(b.wsId).slice(0, 60) : null,
      ref: b.ref ? String(b.ref).slice(0, 200) : null,
      vid
    });
    // Retain raw visit rows for 180 days (aggregates can be rolled up before
    // expiry); keeps the collection bounded.
    coll.createIndex({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 }).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: true }); // tracking must never break the page
  }
});

/* =================================================================
   PLATFORM SUPER-ADMIN API  (requireSession + requireAdmin)
   Aggregates the master registry (accounts, plans, visits) and each
   tenant's orders (revenue) into a single overview for the console.
   ================================================================= */
const adminGuard = [requireSession, requireAdmin];

function lastNDays(n) {
  const days = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

app.get("/api/admin/overview", adminGuard, async (req, res, next) => {
  try {
    const masterDb = getMasterDb();
    if (!masterDb) return res.json({ empty: true });

    const workspaces = await masterDb.collection("workspaces").find({}).toArray();

    // Plan distribution + premium count.
    const byPlan = {};
    PLANS.forEach((p) => { byPlan[p] = 0; });
    let premium = 0, mrr = 0;
    workspaces.forEach((w) => {
      const pl = PLANS.includes(w.plan) ? w.plan : "free";
      byPlan[pl] = (byPlan[pl] || 0) + 1;
      if (pl !== "free") premium++;
      mrr += PLAN_PRICES[pl] || 0;
    });

    // Visits.
    const visitsColl = masterDb.collection("visits");
    const totalVisits = await visitsColl.countDocuments().catch(() => 0);
    const uniqueVisitors = (await visitsColl.distinct("vid").catch(() => [])).length;

    // Per-store revenue (sum each tenant's orders).
    const stores = [];
    for (const w of workspaces) {
      let orders = [];
      try { orders = await dbAdapter.findAll(await resolveWsContext(w.id), "orders"); } catch (e) { orders = []; }
      const revenue = orders.reduce((s, o) => s + (Number(o.total) || 0), 0);
      stores.push({
        wsId: w.id, company: w.company || "Untitled", ownerEmail: w.ownerEmail || "",
        plan: PLANS.includes(w.plan) ? w.plan : "free", industry: w.industry || "",
        country: w.country || "", orders: orders.length, revenue: Math.round(revenue * 100) / 100,
        createdAt: w.createdAt || null, customDomain: w.customDomain || null
      });
    }
    stores.sort((a, b) => b.revenue - a.revenue);

    const totalRevenue = Math.round(stores.reduce((s, x) => s + x.revenue, 0) * 100) / 100;
    const totalOrders = stores.reduce((s, x) => s + x.orders, 0);

    // 14-day time series for signups and visits.
    const days = lastNDays(14);
    const signupsByDay = days.map((d) => ({ day: d, count: workspaces.filter((w) => String(w.createdAt || "").slice(0, 10) === d).length }));
    let visitDayRows = [];
    try {
      visitDayRows = await visitsColl.aggregate([
        { $group: { _id: "$day", visits: { $sum: 1 }, uniques: { $addToSet: "$vid" } } }
      ]).toArray();
    } catch (e) { visitDayRows = []; }
    const visitMap = {}; visitDayRows.forEach((r) => { visitMap[r._id] = { visits: r.visits, uniques: (r.uniques || []).length }; });
    const visitsByDay = days.map((d) => ({ day: d, visits: (visitMap[d] || {}).visits || 0, uniques: (visitMap[d] || {}).uniques || 0 }));

    const recentSignups = workspaces
      .slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .slice(0, 12)
      .map((w) => ({ wsId: w.id, company: w.company, ownerEmail: w.ownerEmail, plan: PLANS.includes(w.plan) ? w.plan : "free", industry: w.industry, country: w.country, createdAt: w.createdAt }));

    // Visit split by surface (marketing vs storefront).
    const byType = { marketing: 0, portal: 0 };
    try {
      const typeRows = await visitsColl.aggregate([{ $group: { _id: "$type", n: { $sum: 1 } } }]).toArray();
      typeRows.forEach((r) => { if (r._id === "portal") byType.portal = r.n; else byType.marketing += r.n; });
    } catch (e) { /* empty */ }

    res.json({
      generatedAt: new Date().toISOString(),
      admin: { name: req.session.name || null, email: req.session.email || null },
      totals: { accounts: workspaces.length, premium, subscribers: premium, mrr, arr: mrr * 12, freeAccounts: workspaces.length - premium, visits: totalVisits, uniqueVisitors, revenue: totalRevenue, orders: totalOrders },
      byPlan,
      byType,
      plans: PLANS,
      planPrices: PLAN_PRICES,
      topStores: stores.slice(0, 10),
      recentSignups,
      signupsByDay,
      visitsByDay
    });
  } catch (e) { next(e); }
});

/**
 * GET /api/admin/apps — the Code side of the product.
 *
 * The overview above is entirely storefront: accounts, plans, MRR, orders,
 * visits. None of it says how many apps exist, how many are deployed, or
 * whether the machine running them is healthy — so the panel could look
 * fine while every container on the host was down.
 *
 * Status comes from the deploy plane one deployment at a time because that
 * is the only thing it offers; the work is capped and done in parallel so a
 * slow host degrades this to "unknown" rather than hanging the page.
 */
app.get("/api/admin/apps", adminGuard, async (req, res, next) => {
  try {
    const masterDb = getMasterDb();
    if (!masterDb) return res.json({ empty: true });
    const cookie = cookieOf(req);

    const rows = await masterDb.collection("projects")
      .find({}, { projection: { id: 1, slug: 1, title: 1, meta: 1, updatedAt: 1, createdAt: 1,
                                deploymentId: 1, ownerUserId: 1, ownerAnonId: 1, published: 1,
                                deployConfig: 1 } })
      .sort({ updatedAt: -1 }).limit(400).toArray();

    const byType = {};
    let claimed = 0, anon = 0, deployedCount = 0;
    for (const r of rows) {
      const kind = (r.meta || {}).buildType || "website";
      byType[kind] = (byType[kind] || 0) + 1;
      if (r.ownerUserId) claimed++; else anon++;
      if (r.deploymentId) deployedCount++;
    }

    // Built in the last N days, from the same rows.
    const since = (n) => new Date(Date.now() - n * 86400000).toISOString();
    const d1 = since(1), d7 = since(7), d30 = since(30);
    const createdAfter = (iso) => rows.filter((r) => String(r.createdAt || "") >= iso).length;

    /* No per-app container status here, deliberately.

       The deploy plane authenticates every deployment route with the OWNER's
       session, not the platform token — its own comment is explicit that the
       two answer different questions and that the token is "not a substitute
       for requireUser". An admin forwarding their own cookie is not the owner
       of anyone else's app, so /deployments/:id and /capacity both answer 401
       "sign in to continue". Calling them anyway produced a column of
       "Unknown" for every row, which reads like an outage rather than like a
       boundary being respected.

       So this reports what THIS database actually knows: which projects have
       been deployed, to what address, by whom, and when they last changed.
       The address is derived from deployConfig rather than asked for, because
       that is where it was chosen. */
    const appDomain = process.env.DEPLOY_APP_DOMAIN || "souqi.site";
    const apps = rows.filter((r) => r.deploymentId).slice(0, 80).map((r) => {
      const cfg = r.deployConfig || {};
      return {
        id: r.id, slug: r.slug, title: r.title || "Untitled app",
        buildType: (r.meta || {}).buildType || null,
        owner: r.ownerUserId ? "user" : "anon",
        updatedAt: r.updatedAt, createdAt: r.createdAt,
        deploymentId: r.deploymentId,
        url: cfg.subdomain ? "https://" + cfg.subdomain + "." + appDomain : null,
        dbMode: cfg.dbMode || null,
        published: !!r.published
      };
    });

    /* Health is the one plane call that answers without a user session, and
       it is the one that matters most: it says whether the box running
       everyone's containers is alive, which docker it is on, and how long
       ago the worker checked in. */
    let health = null;
    if (deployplane.isConfigured()) {
      try { const h = await deployplane.health(cookie); health = h.ok ? (h.body || { ok: true }) : { ok: false }; }
      catch (e) { health = { ok: false }; }
    }

    // AI spend this month, across everyone.
    let spend = { costUsd: 0, builds: 0 };
    try {
      const usageRows = await masterDb.collection("codeagent_usage")
        .find({ month: codeAgentUsage.monthKey() }).toArray();
      spend = usageRows.reduce((a, r) => ({
        costUsd: a.costUsd + (Number(r.costUsd) || 0),
        builds: a.builds + (Number(r.builds) || 0)
      }), { costUsd: 0, builds: 0 });
      spend.costUsd = Math.round(spend.costUsd * 10000) / 10000;
    } catch (e) { /* usage is observability, never a reason to fail the page */ }

    res.json({
      generatedAt: new Date().toISOString(),
      planeConfigured: deployplane.isConfigured(),
      health: health,
      // Said out loud so the UI can explain the gap instead of implying one.
      liveStatusAvailable: false,
      totals: {
        projects: rows.length, deployed: deployedCount,
        claimed: claimed, anon: anon,
        builtToday: createdAfter(d1), built7d: createdAfter(d7), built30d: createdAfter(d30)
      },
      byType: byType,
      spend: spend,
      apps: apps.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    });
  } catch (e) { next(e); }
});

// Full account list (every workspace with plan + revenue) for the drill-down.
app.get("/api/admin/accounts", adminGuard, async (req, res, next) => {
  try {
    const masterDb = getMasterDb();
    if (!masterDb) return res.json({ accounts: [] });
    const workspaces = await masterDb.collection("workspaces").find({}).toArray();
    const accounts = [];
    for (const w of workspaces) {
      let orders = [];
      try { orders = await dbAdapter.findAll(await resolveWsContext(w.id), "orders"); } catch (e) { orders = []; }
      accounts.push({
        wsId: w.id, company: w.company || "Untitled", ownerEmail: w.ownerEmail || "",
        plan: PLANS.includes(w.plan) ? w.plan : "free", industry: w.industry || "",
        country: w.country || "", customDomain: w.customDomain || null,
        orders: orders.length, revenue: Math.round(orders.reduce((s, o) => s + (Number(o.total) || 0), 0) * 100) / 100,
        createdAt: w.createdAt || null
      });
    }
    accounts.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    res.json({ plans: PLANS, accounts });
  } catch (e) { next(e); }
});

// Set a workspace's plan (billing/admin action).
app.post("/api/admin/ws/:id/plan", adminGuard, async (req, res, next) => {
  try {
    const masterDb = getMasterDb();
    if (!masterDb) return res.status(503).json({ error: "Master DB not available" });
    const plan = String((req.body && req.body.plan) || "").toLowerCase();
    if (!PLANS.includes(plan)) return next(httpError(400, "validation_error", "plan must be one of: " + PLANS.join(", ")));
    const r = await masterDb.collection("workspaces").updateOne({ id: req.params.id }, { $set: { plan } });
    if (!r.matchedCount) return next(httpError(404, "not_found", "workspace not found"));
    await writeMasterAudit(masterDb, {
      requestId: req.id, actor: req.session.email, wsId: req.params.id,
      action: "admin.plan.update", entityId: req.params.id, summary: "Plan set to " + plan
    });
    res.json({ ok: true, plan });
  } catch (e) { next(e); }
});

/* ---- dynamic db connection testing (auth required) ---- */
app.post("/api/db/test", requireSession, async (req, res) => {
  try {
    const { dbType, dbUri } = req.body || {};
    if (!dbType || !dbUri) return res.status(400).json({ error: "dbType and dbUri are required" });
    await testConnection(dbType, dbUri);
    res.json({ ok: true, message: "Connected successfully!" });
  } catch (e) {
    console.error("Test connection failed:", e.message);
    res.status(400).json({ error: e.message });
  }
});

/* ---- dynamic db seeding/provisioning (auth required) ---- */
app.post("/api/db/seed", requireSession, async (req, res) => {
  try {
    const { workspaceId, dbType, dbUri } = req.body || {};
    if (!workspaceId || !dbType || !dbUri) return res.status(400).json({ error: "workspaceId, dbType, and dbUri are required" });
    await seedWorkspaceDatabase({ workspaceId, dbType, dbUri });
    res.json({ ok: true, message: "Database schemas and starter templates successfully provisioned!" });
  } catch (e) {
    console.error("Seeding workspace failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* =================================================================
   WORKSPACE DOMAIN MANAGEMENT API
   ================================================================= */

/**
 * Verifies the request carries a valid JWT AND that the signed-in identity
 * (matched by email) actually owns the given workspace. Throws an Error
 * with a `.status` set (401/403/404/503) that route handlers can catch
 * and forward as the HTTP response.
 *
 * Ownership is anchored on `ownerEmail` on the workspace's master-DB
 * record (set at provisioning time by POST /api/ws) rather than embedded
 * in the JWT, since the JWT is minted by whichever DB the caller happens
 * to authenticate against (their own workspace DB or the master DB) and
 * never carries a workspace id.
 */
async function assertOwnsWorkspace(req, wsId) {
  /* TWO TRANSPORTS, ONE TOKEN. The Authorization header is what a CLI or
     a server-to-server caller sends; the sq_session cookie is what a
     browser sends, because /auth/login sets it httpOnly on purpose so no
     page can keep the token where script can read it. Same signature,
     same secret, same expiry — accepting the cookie proves exactly as
     much as accepting the header, and refusing it meant the dashboard
     got 401 from operations it is the only caller of. */
  const header = (req.headers.authorization || "").replace("Bearer ", "").trim();
  let decoded = null;
  if (header) {
    try { decoded = jwt.verify(header, JWT_SECRET); }
    catch (e2) { const e = new Error("invalid or expired token"); e.status = 401; throw e; }
  } else {
    decoded = codeAgentSessionUser(req);   // verifies sq_session, or null
  }
  if (!decoded) { const e = new Error("unauthorized"); e.status = 401; throw e; }

  /* A SCOPED TOKEN IS NOT WORKSPACE AUTHORITY.
     This is the check that was missing, and it was worth more than the
     one above. A portal-edit token is a narrow grant: fifteen minutes,
     for editing one storefront, handed to a PAGE rather than kept
     httpOnly, and rotatable indefinitely through /edit-token/refresh. It
     also carries { wsId, email } — and email is half of the ownership
     test below, so it matched. A token meant to let someone move a
     heading around therefore satisfied every gate in this function:
     GET /api/ws/:id/export (all thirteen collections, the users table and
     its password hashes among them), POST /api/ws/:id/domain, and
     DELETE /api/ws/:id, which erases the workspace.

     Confirmed against the running server before this line existed: an
     edit token exported the whole tenant. Nothing in public/ mints or
     sends one any more — the live storefront editor it was built for is
     gone — so this refuses a capability that had no remaining legitimate
     caller and one very illegitimate one.

     403, not 401: the token is genuine and the holder is authenticated.
     They are simply not carrying authority over this workspace. */
  if (decoded.scope) {
    const e = new Error("forbidden — this token does not carry workspace authority");
    e.status = 403; throw e;
  }

  const masterDb = getMasterDb();
  if (!masterDb) { const e = new Error("Master DB not available"); e.status = 503; throw e; }

  const ws = await masterDb.collection("workspaces").findOne({ id: wsId });
  if (!ws) { const e = new Error("workspace not found"); e.status = 404; throw e; }

  const callerEmail = String(decoded.email || "").toLowerCase();
  const owns = (ws.ownerUserId && ws.ownerUserId === decoded.id) ||
    (ws.ownerEmail && callerEmail && String(ws.ownerEmail).toLowerCase() === callerEmail);
  if (!owns) { const e = new Error("forbidden — you do not own this workspace"); e.status = 403; throw e; }

  return { decoded, ws, masterDb };
}

/**
 * GET /api/ws/:id/config
 * Returns public workspace config for the portal (no secrets).
 */
app.get("/api/ws/:id/config", async (req, res) => {
  try {
    const masterDb = getMasterDb();
    if (!masterDb) return res.status(503).json({ error: "Master DB not available" });
    const ws = await masterDb.collection("workspaces").findOne({ id: req.params.id });

    /* A STOREFRONT'S config, and only a storefront's.

       This is unauthenticated because a shop page has to read its own
       theme before anyone signs in. It stripped the obviously secret
       fields and returned the rest — which, for an account that runs no
       shop, still meant handing anyone holding a workspace id the company
       name, the PLAN they are on, and the day they signed up.

       Gated on the same flag as /api/portal/*, for the same reason: every
       account here is a Souqi Code account and none has a storefront, so
       there is no caller and nothing legitimate to answer. Folded into the
       404 above so a workspace with no shop and a workspace that does not
       exist give the same answer. */
    if (!ws || ws.storefrontEnabled !== true) {
      return res.status(404).json({ error: "Workspace not found" });
    }

    // Strip sensitive fields
    const { _id, dbUri, dbType, password, ownerUserId, ownerEmail, ...safe } = ws;
    res.json(safe);
  } catch (e) {
    console.error("GET /api/ws/:id/config error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* POST /api/ws is gone.

   It provisioned a workspace record, unauthenticated, from a body that
   named the id, the owner's email, and the DATABASE URI. Its comment
   justified that by saying it mirrored /api/db/seed and /api/db/test,
   which also ran pre-login — and both of those have required a session
   for a long time, so the justification had quietly stopped being true.
   Nothing in public/ called it. Nothing in server/ called it. No test
   named it.

   What it did allow, measured against a running server:

     1. A stranger POSTs { id: "ws_anything", ownerEmail: "you@" }  -> 201
     2. You try to sign up                                          -> 409
        "an account with this email already exists — sign in instead"
     3. You try to sign in, as instructed                           -> 500

   Any address could be locked out of the product permanently, by anyone,
   with a message telling the victim to do the one thing that then fails.
   Scriptable against a list.

   And the dbUri in that body is stored and later decrypted and CONNECTED
   TO by resolveWsContext — so it also let an unauthenticated caller put a
   connection string of their choosing into the master registry.

   /auth/signup is the provisioning path and has been for a while: it
   creates the workspace itself, always with dbType local and an empty
   dbUri, behind a captcha and two rate limits. */

/**
 * POST /api/ws/:id/domain
 * Set or clear the custom domain for a workspace.
 * Body: { domain: "store.example.com" | "" }
 * Requires the caller to own the workspace.
 */
app.post("/api/ws/:id/domain", async (req, res, next) => {
  try {
    const { decoded, masterDb } = await assertOwnsWorkspace(req, req.params.id);

    const { domain, storefrontEnabled, storefrontConfig } = req.body || {};
    const patch = {};
    if (domain !== undefined) patch.customDomain = domain ? String(domain).toLowerCase().trim() : null;
    if (storefrontEnabled !== undefined) patch.storefrontEnabled = !!storefrontEnabled;
    if (storefrontConfig !== undefined) patch.storefrontConfig = storefrontConfig;

    await masterDb.collection("workspaces").updateOne(
      { id: req.params.id },
      { $set: patch },
      { upsert: false }
    );
    const ws = await resolveWsContext(req.params.id);
    await writeAudit(dbAdapter, ws, {
      requestId: req.id, actor: decoded.email, action: "workspace.domain.update",
      entity: "workspace", entityId: req.params.id,
      summary: "Domain/storefront settings updated"
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/ws/:id/export  — GDPR data portability.
 * Returns every collection for the workspace. Owner-only.
 */
app.get("/api/ws/:id/export", async (req, res, next) => {
  try {
    const { decoded } = await assertOwnsWorkspace(req, req.params.id);
    const ws = await resolveWsContext(req.params.id);
    const collections = {};
    for (const c of COLLECTIONS) {
      /* An export is a data-subject's own copy of their records, not a
         credential dump. Redacted like every other exit: a GDPR file is
         the single most likely document here to be mailed onward. */
      collections[c] = servableAll(await dbAdapter.findAll(ws, c).catch(() => []));
    }
    await writeAudit(dbAdapter, ws, {
      requestId: req.id, actor: decoded.email, action: "workspace.export",
      entity: "workspace", entityId: req.params.id, summary: "Full data export"
    });
    res.json({ workspaceId: req.params.id, exportedAt: new Date().toISOString(), collections });
  } catch (e) {
    next(e);
  }
});

/**
 * DELETE /api/ws/:id  — GDPR right-to-erasure.
 * Drops the workspace's tenant database and master record. Owner-only.
 * The deletion itself is recorded to the PLATFORM audit (which survives).
 */
app.delete("/api/ws/:id", async (req, res, next) => {
  try {
    const { decoded, masterDb } = await assertOwnsWorkspace(req, req.params.id);
    await writeMasterAudit(masterDb, {
      requestId: req.id, actor: decoded.email, wsId: req.params.id,
      action: "workspace.delete", entityId: req.params.id, summary: "Workspace erased"
    });
    const ws = await resolveWsContext(req.params.id);
    await dbAdapter.purgeWorkspace(ws);
    await masterDb.collection("workspaces").deleteOne({ id: req.params.id });
    res.json({ ok: true, deleted: req.params.id });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/storefront/config
 * Persists the full storefront (theme/pages/blocks) config. Requires the
 * caller to own the workspace.
 */
app.post("/api/storefront/config", async (req, res, next) => {
  try {
    const { wsId, storefrontConfig } = req.body || {};
    if (!wsId) return res.status(400).json({ error: "Missing wsId" });

    const { decoded, masterDb } = await assertOwnsWorkspace(req, wsId);

    await masterDb.collection("workspaces").updateOne(
      { id: wsId },
      { $set: { storefrontConfig: storefrontConfig } },
      { upsert: false }
    );
    const ws = await resolveWsContext(wsId);
    await writeAudit(dbAdapter, ws, {
      requestId: req.id, actor: decoded.email, action: "workspace.storefront.update",
      entity: "workspace", entityId: wsId, summary: "Storefront config saved"
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/storefront/edit-token
 * Mints a short-lived, scope-limited token the admin app hands to the
 * portal's live editor (which may run on a different origin/custom
 * domain and can't see the admin app's localStorage). Requires the
 * caller to own the workspace being edited.
 */
app.post("/api/storefront/edit-token", async (req, res) => {
  try {
    const { wsId } = req.body || {};
    if (!wsId) return res.status(400).json({ error: "Missing wsId" });

    const { decoded } = await assertOwnsWorkspace(req, wsId);

    const editToken = jwt.sign(
      { wsId, email: decoded.email, scope: "portal-edit" },
      JWT_SECRET,
      { expiresIn: "15m" }
    );
    res.json({ editToken, expiresIn: 900 });
  } catch (e) {
    console.error("POST /api/storefront/edit-token error:", e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

/**
 * GET /api/storefront/edit-token/verify
 * Called by the portal's live editor on load to confirm an `et` query
 * param is a valid, unexpired edit token scoped to this workspace,
 * before mounting the editor UI.
 */
app.get("/api/storefront/edit-token/verify", async (req, res) => {
  try {
    const wsId = req.query && req.query.wsId;
    /* HEADER ONLY. This used to fall back to ?et= "for older edit links",
       and the comment that said so also said why it was the second choice:
       a query string is logged in the request line. Not by this app's own
       logger, which records req.path — but by the platform's access log, by
       the browser's history, and by the Referer sent to any third party the
       page then loads.

       The fallback had no caller left. The live storefront editor it was
       written for is retired and nothing in public/ mints or sends an edit
       token at all, so this removes a way to leak a credential and takes
       nothing working with it. */
    const et = req.headers["x-edit-token"];
    if (!wsId || !et) return res.status(400).json({ ok: false, error: "wsId and et are required" });
    const decoded = jwt.verify(String(et), JWT_SECRET);
    if (decoded.scope !== "portal-edit" || decoded.wsId !== wsId) {
      return res.status(403).json({ ok: false, error: "token not valid for this workspace" });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(401).json({ ok: false, error: "invalid or expired edit token" });
  }
});

/**
 * POST /api/storefront/edit-token/refresh
 * Rotates a STILL-VALID edit token into a fresh 15-minute one so long
 * editing sessions don't fail at Publish. The current unexpired token is
 * itself the proof of an authorized session — no owner JWT needed on the
 * portal page. An already-expired token cannot be refreshed (reopen from
 * the console).
 */
app.post("/api/storefront/edit-token/refresh", (req, res) => {
  try {
    const et = req.headers["x-edit-token"] || (req.body && req.body.et);
    if (!et) return res.status(400).json({ error: "edit token required" });
    const decoded = jwt.verify(String(et), JWT_SECRET);
    if (decoded.scope !== "portal-edit" || !decoded.wsId) {
      return res.status(403).json({ error: "not an edit token" });
    }
    const editToken = jwt.sign(
      { wsId: decoded.wsId, email: decoded.email, scope: "portal-edit" },
      JWT_SECRET, { expiresIn: "15m" }
    );
    res.json({ editToken, expiresIn: 900 });
  } catch (e) {
    res.status(401).json({ error: "invalid or expired edit token" });
  }
});

/* =================================================================
   PUBLIC PORTAL API  (no auth required — guest access)
   All portal reads use findAllPublic() which strips private fields.
   ================================================================= */

/**
 * Helper: resolve the server-owned DB context for a public portal :wsId.
 * Delegates to the same resolver the authenticated CRUD path uses, so
 * "local"/empty dbType normalizes to the platform default and no client
 * value ever selects the database.
 */
async function resolvePortalWs(wsId) {
  return resolveWsContext(wsId);
}

/**
 * GET /api/portal/:wsId/config
 * Public workspace config for the portal frontend.
 */
/* =================================================================
   THE STOREFRONT'S PUBLIC SURFACE IS GATED ON HAVING A STOREFRONT
   -----------------------------------------------------------------
   /api/portal/:wsId/* is the retired storefront product: a shop page
   for anonymous visitors. Public is the right shape for that — a
   shopper has no account — and two of the five WRITE: /orders inserts
   into the workspace's orders collection, /inquiry into its quotes.

   What was missing is any check that the workspace being written to
   actually runs a shop. storefrontEnabled has existed on the record
   since the beginning and was never read as a gate. So with a
   workspace id — and only that — anyone could fill a stranger's
   collections. The captcha that would have slowed it only engages when
   CAPTCHA_SECRET is set, and it is not set in production.

   Every account on this deployment is a Souqi Code account, and signup
   writes storefrontEnabled:false. Not one has it on. So this closes the
   whole surface today while leaving the product working for a workspace
   that genuinely turns it on.

   404, not 403: a workspace that runs no shop should be indistinguish-
   able from one that does not exist, or this becomes a way to ask which
   ids are real.
   ================================================================= */
app.use("/api/portal/:wsId", async (req, res, next) => {
  try {
    const masterDb = getMasterDb();
    if (!masterDb) return res.status(503).json({ error: "Master DB not available" });
    const ws = await masterDb.collection("workspaces").findOne(
      { id: String(req.params.wsId || "") }, { projection: { storefrontEnabled: 1 } });
    if (!ws || ws.storefrontEnabled !== true) {
      return res.status(404).json({ error: "no storefront here" });
    }
    return next();
  } catch (e) { return next(e); }
});

app.get("/api/portal/:wsId/config", async (req, res) => {
  try {
    const masterDb = getMasterDb();
    if (masterDb) {
      const ws = await masterDb.collection("workspaces").findOne({ id: req.params.wsId });
      if (ws) {
        const { _id, dbUri, dbType, password, ...safe } = ws;
        return res.json(safe);
      }
    }
    // Fallback: return minimal config so portal can still render
    res.json({ id: req.params.wsId, company: "Souqi", industry: "logistics", storefrontEnabled: true });
  } catch (e) {
    console.error("GET /api/portal/:wsId/config error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/portal/:wsId/products
 * Public product/menu/service catalogue (strips cost prices etc.)
 */
app.get("/api/portal/:wsId/products", async (req, res) => {
  try {
    const ws = await resolvePortalWs(req.params.wsId);
    const items = await dbAdapter.findAllPublic(ws, "products");
    res.json(items);
  } catch (e) {
    // DB unavailable — return empty so portal falls back to localStorage
    console.warn("GET /api/portal/:wsId/products (no DB):", e.message);
    res.json([]);
  }
});


/**
 * POST /api/portal/:wsId/orders
 * Guest checkout — creates an order in the workspace's orders collection.
 * Body: { customer: { name, email, phone, address }, items: [...], note, type }
 */
app.post("/api/portal/:wsId/orders",
  orderLimiter,
  withIdempotency((req) => req.params.wsId),
  verifyCaptcha(),
  validateBody(orderSchema),
  async (req, res, next) => {
  try {
    const ws = await resolvePortalWs(req.params.wsId);
    const { customer, items, note, type, payment } = req.valid;
    const total = items.reduce((s, i) => s + (Number(i.price || 0) * Number(i.qty || 1)), 0);
    const orderId = idForCollection("orders");
    const ref = "SQ-ORD-" + new Date().getFullYear() + "-" + orderId.split("_").pop().slice(-8);
    // Demo checkout only — no real payment gateway is wired up. Only the
    // method + a non-reversible {brand,last4} are ever stored; full card
    // numbers/CVCs are validated client-side and never sent here.
    const paymentInfo = payment && ["card", "paypal", "cod", "bank"].includes(payment.method)
      ? { method: payment.method, brand: payment.brand || null, last4: payment.last4 || null }
      : { method: "cod", brand: null, last4: null };
    const order = {
      id: orderId,
      ref,
      wsId: ws.workspaceId,
      requestId: req.id,
      date: new Date().toISOString(),
      status: "Pending",
      source: "portal",
      type: type || "online",
      customer,
      items,
      total,
      payment: paymentInfo,
      note: note || "",
      createdAt: new Date().toISOString()
    };
    await dbAdapter.insertOne(ws, "orders", order);
    await writeAudit(dbAdapter, ws, {
      requestId: req.id, actor: "guest:" + customer.email, action: "order.create",
      entity: "orders", entityId: order.id, summary: "Guest order " + ref + " total " + total
    });
    res.status(201).json({ ok: true, ref, orderId: order.id });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/portal/:wsId/track/:ref
 * Shipment / order tracking by reference number. Guest-safe.
 */
app.get("/api/portal/:wsId/track/:ref", async (req, res) => {
  try {
    const ws = await resolvePortalWs(req.params.wsId);
    const ref = req.params.ref;

    // Search shipments first, then orders
    const [shipments, orders] = await Promise.all([
      dbAdapter.findAllPublic(ws, "shipments"),
      dbAdapter.findAllPublic(ws, "orders")
    ]);

    const shipment = shipments.find(s => String(s.ref || s.id || "").toLowerCase() === ref.toLowerCase());
    if (shipment) return res.json({ type: "shipment", record: shipment });

    const order = orders.find(o => String(o.ref || o.id || "").toLowerCase() === ref.toLowerCase());
    if (order) return res.json({ type: "order", record: order });

    res.status(404).json({ error: "Reference not found" });
  } catch (e) {
    console.error("GET /api/portal/:wsId/track error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/portal/:wsId/inquiry
 * Quote request / service inquiry form. Creates a lead in clients + a quote.
 * Body: { name, email, phone, message, budget, service }
 */
app.post("/api/portal/:wsId/inquiry",
  inquiryLimiter,
  withIdempotency((req) => req.params.wsId),
  verifyCaptcha(),
  validateBody(inquirySchema),
  async (req, res, next) => {
  try {
    const ws = await resolvePortalWs(req.params.wsId);
    const { name, email, phone, message, budget, service } = req.valid;

    const quoteId = idForCollection("quotes");
    const ref = "SQ-INQ-" + new Date().getFullYear() + "-" + quoteId.split("_").pop().slice(-8);
    const quote = {
      id: quoteId,
      ref,
      wsId: ws.workspaceId,
      requestId: req.id,
      date: new Date().toISOString(),
      status: "Draft",
      source: "portal-inquiry",
      client: name,
      email,
      phone: phone || "",
      service: service || "",
      budget: budget || "",
      notes: message || "",
      createdAt: new Date().toISOString()
    };
    await dbAdapter.insertOne(ws, "quotes", quote);
    await writeAudit(dbAdapter, ws, {
      requestId: req.id, actor: "guest:" + email, action: "inquiry.create",
      entity: "quotes", entityId: quote.id, summary: "Portal inquiry " + ref
    });
    res.status(201).json({ ok: true, ref });
  } catch (e) {
    next(e);
  }
});

/* ---- auth: verify a hashed password, return a token + safe profile ---- */
app.post("/auth/login", loginIpLimiter, loginLimiter, validateBody(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.valid;

    // The workspace being signed into is named by the client; the DB context
    // for it is resolved SERVER-SIDE (never from a client-supplied dbUri).
    // When no workspace is named (e.g. the admin panel's email+password
    // login), resolve it from the master registry by owner email.
    let wsId = String(req.headers["x-workspace-id"] || "");
    if (!wsId || wsId === "default") {
      const masterDb = getMasterDb();
      if (masterDb) {
        const owned = await masterDb.collection("workspaces").findOne({ ownerEmail: email });
        if (owned) wsId = owned.id;
      }
    }
    if (!wsId) wsId = "default";
    const ws = await resolveWsContext(wsId);
    const users = await dbAdapter.findAll(ws, "users");
    const u = users.find(usr => String(usr.email).toLowerCase() === String(email).toLowerCase());

    if (!u || !u.active) return res.status(401).json({ error: "invalid credentials" });

    // Only bcrypt-hashed passwords authenticate. Plaintext is never accepted
    // server-side (the seeder hashes all users at provisioning time).
    const stored = String(u.password || "");
    const ok = stored.startsWith("$2") ? await bcrypt.compare(password, stored) : false;
    if (!ok) return res.status(401).json({ error: "invalid credentials" });

    // The signed token carries the workspace id — this is what every later
    // request is scoped by, so tenancy can't be spoofed via a header.
    /* sessionEpoch is part of the session, not an afterthought.
       "Sign out other sessions" works by bumping a counter on the user and
       refusing any token carrying an older one. Only the revoke route was
       stamping it, so the FIRST login after a revoke minted a token with no
       epoch at all — which reads as 0, which does not match the bumped
       value, which means the account's own Settings page refused its owner
       from then on. Permanently. The feature broke the thing it protects. */
    const session = { id: u.id, name: u.name, email: u.email, role: u.role, dept: u.dept, wsId: ws.workspaceId, sessionEpoch: u.sessionEpoch || 0 };
    const token = jwt.sign(session, JWT_SECRET, { expiresIn: "12h" });
    // Also set an httpOnly session cookie so browser clients (e.g. the admin
    // panel) never keep the token in JS-readable storage. httpOnly = not
    // reachable by XSS; SameSite=Lax = not sent on cross-site mutations.
    res.cookie("sq_session", token, {
      httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
      maxAge: 12 * 3600 * 1000, path: "/"
    });

    /* Anything built before signing in belongs to a cookie, not a person.
       Attach it to the account now, or it disappears the next time that
       cookie rotates — a different browser, cleared site data, a new
       device — with no way back to it.

       Never fatal: a failed claim must not stop someone signing in. */
    try {
      const moved = await projects.claimAnon(anon.anonIdOf(req), session.id);
      if (moved.claimed) console.log("[auth] claimed " + moved.claimed + " project(s) for " + session.id);
    } catch (e) { console.warn("[auth] claim skipped:", e.message); }
    res.json({ token, user: session });
  } catch (e) {
    console.error("login error:", e.message);
    res.status(500).json({ error: "login failed" });
  }
});

/* ---- signup: create an account + its workspace, then sign in ----
 *
 * Until now the ONLY way to get an account was POST /api/codeagent/:key/
 * micro-claim, which creates one as a side effect of claiming a build and
 * therefore needs a project to exist first. This is the same provisioning
 * (workspace row in the master registry + an Owner user inside that
 * workspace) with the project half removed, so a visitor can sign up
 * before building anything.
 *
 * Deliberate choices:
 *  - The password is passed to dbAdapter.insertOne as PLAINTEXT. That
 *    adapter bcrypt-hashes any `users.password` that isn't already
 *    $2-prefixed (see db-adapters.js). Hashing here as well would double-
 *    hash and silently break /auth/login, which bcrypt.compare()s once.
 *  - Duplicate email is checked against master `workspaces.ownerEmail`,
 *    the same field micro-claim and /auth/login resolve against, so the
 *    three agree on what "this email already has an account" means.
 *  - Reuses loginLimiter (30 per 15min per ip+email) rather than adding
 *    another bucket: it is already keyed the right way for this shape.
 *  - Responds with the identical { token, user } body and sq_session
 *    cookie as /auth/login, so a client can treat signup as "login that
 *    also provisions" and needs no second code path.
 */
app.post("/auth/signup", loginIpLimiter, loginLimiter, verifyCaptcha(), validateBody(signupSchema), async (req, res, next) => {
  try {
    const { name, email, password, company, country } = req.valid;
    const emailLower = String(email).toLowerCase();

    /* The schema's min:1 measures the raw string, so "   " satisfies it. The
       store then trimmed it to nothing and quietly fell back to the email's
       local part — which is the exact behaviour requiring a name was meant to
       end, reachable by typing three spaces. Rejected here instead. */
    const displayName = String(name || "").trim();
    if (!displayName) {
      return res.status(400).json({ error: "name is required" });
    }

    const masterDb = getMasterDb();
    if (!masterDb) return res.status(503).json({ error: "Master DB not available" });

    const existingWs = await masterDb.collection("workspaces").findOne({ ownerEmail: emailLower });
    if (existingWs) {
      return res.status(409).json({ error: "an account with this email already exists — sign in instead" });
    }

    const wsId = "ws_" + Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
    await masterDb.collection("workspaces").insertOne({
      id: wsId,
      company: String(company || "").slice(0, 120) || "My Apps",
      industry: "software",
      country: String(country || "").toUpperCase().slice(0, 5) || "OT",
      ownerEmail: emailLower,
      dbType: "local",
      dbUri: "",
      logo: null,
      tagline: "",
      storefrontEnabled: false,
      plan: "free",
      createdAt: new Date().toISOString()
    });

    const ownerUser = {
      id: "usr_" + crypto.randomBytes(8).toString("base64url"),
      /* The name they gave, not a slice of their address. No fallback: a
         blank one is rejected above, so reaching here means there is a real
         name to store. */
      name: displayName.slice(0, 80),
      email: emailLower,
      password: password,            // hashed by insertOne — see note above
      role: "Owner", dept: "Management", active: true,
      joined: new Date().toISOString().slice(0, 10)
    };
    const ws = await resolveWsContext(wsId);
    await dbAdapter.insertOne(ws, "users", ownerUser);

    const session = { id: ownerUser.id, name: ownerUser.name, email: ownerUser.email,
                      role: "Owner", dept: "Management", wsId: wsId, sessionEpoch: ownerUser.sessionEpoch || 0 };
    const token = jwt.sign(session, JWT_SECRET, { expiresIn: "12h" });
    res.cookie("sq_session", token, {
      httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
      maxAge: 12 * 3600 * 1000, path: "/"
    });

    /* Anything built before signing in belongs to a cookie, not a person.
       Attach it to the account now, or it disappears the next time that
       cookie rotates — a different browser, cleared site data, a new
       device — with no way back to it.

       Never fatal: a failed claim must not stop someone signing in. */
    try {
      const moved = await projects.claimAnon(anon.anonIdOf(req), session.id);
      if (moved.claimed) console.log("[auth] claimed " + moved.claimed + " project(s) for " + session.id);
    } catch (e) { console.warn("[auth] claim skipped:", e.message); }
    res.json({ ok: true, wsId: wsId, token: token, user: session });
  } catch (e) {
    console.error("signup error:", e.message);
    res.status(500).json({ error: "signup failed" });
  }
});

/* ---- logout: clear the httpOnly session cookie ---- */
app.post("/auth/logout", (req, res) => {
  res.clearCookie("sq_session", { path: "/" });
  res.json({ ok: true });
});

/* POST /ai/chat is gone.

   An unauthenticated proxy that forwarded any prompt to Gemini on the
   PLATFORM's key and returned the completion. No session, no owner, no
   spend cap — only 30 requests a minute per address. A free LLM for the
   internet, billed to whoever runs this.

   It was dormant rather than harmless: GEMINI_API_KEY is unset, so it
   answered 503, and production does not route /ai/* to the function at
   all, so it answered 404 there. Both of those are conditions, not
   defences. It arms itself on the day someone adds the key — which is a
   stated plan — or adds /ai/* to the rewrites.

   Nothing called it. It belonged to the retired storefront product; the
   builder reaches models through lib/ai/client.js, which routes by task,
   takes the user's OWN key when they have stored one, and is metered by
   a per-owner spend cap and AI_MONTHLY_BUDGET_USD. That is where an AI
   endpoint goes.

   GEMINI_API_KEY and GEMINI_MODEL were read for this and nothing else. */

/* =================================================================
   AI SITE BUILDER  ("what will you build?")
   -----------------------------------------------------------------
   A prompt becomes a storefront config. Two hard rules:

     1. Whatever produces the config — the composer today, a
        model tomorrow — its output goes through site-validate.js
        before it is stored or returned. One trust boundary, no
        exceptions. See docs/AI-BUILDER-PLAN.md §3.6.
     2. A draft is NOT a workspace. It has no database, no tenancy and
        no owner, so it can safely exist for an anonymous visitor.
        Claiming one (post-signup) is what creates the real workspace.
   ================================================================= */
const { validateSiteConfig } = require("./lib/site-validate");
const composer = require("./lib/composer");
const { classify, choices } = require("./lib/nlu/classify");
const { extract } = require("./lib/nlu/slots");

/* Labels the visitor sees when we have to ask which industry they meant. */
const INDUSTRY_LABELS = {
  restaurant: "Restaurant / café", fashion: "Fashion & clothing", logistics: "Logistics & freight",
  manufacturing: "Manufacturing", construction: "Construction", services: "Services & bookings",
  wholesale: "Wholesale & trade", retail: "Retail shop"
};

/* The Sites agent's draft store stood here — a TTL'd agent_drafts collection
   with an in-memory fallback, plus the rate limiter for /api/agent/build.
   All of it served routes that are gone. A build in the current product is a
   PROJECT: durable, owned by a cookie or an account, and versioned, which is
   what the section below this one is about. */



/* =================================================================
   PROJECTS — the durable object (docs/AGENT-PARITY-PLAN.md §1–3)
   -----------------------------------------------------------------
   A build used to be a throwaway draft. A project survives a reload,
   has a URL, remembers its conversation and keeps every version.
   Owned by an anonymous signed cookie first, by a user after claim.
   ================================================================= */
const projects = require("./lib/projects");
const anon = require("./lib/anon");
const uploads = require("./lib/uploads");
projects.init({ getMasterDb });
uploads.init({ getMasterDb });
anon.init({ JWT_SECRET });

const projectLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, key: (req) => req.ip || "" });
// Micro-claim creates a real account — a tighter budget than the build
// endpoints, since abuse here means spamming workspace/user rows, not just CPU.
const microClaimLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, key: (req) => req.ip || "" });

/**
 * Run the whole pipeline for a prompt. Shared by create and follow-up, and by
 * both the plain-JSON and SSE response modes below.
 *
 * `onStage(id, state, detail)` is called at REAL boundaries in the actual
 * work — not on a timer. `state` is "start" or "done"; `detail` is only ever
 * present on "done" and is built from data that genuinely exists at that
 * point (see docs/AGENT-PARITY-PLAN.md §5 — a stage is done when it IS done,
 * so a fast pipeline shows a fast build instead of a manufactured 1.5s wait).
 * The default no-op keeps every existing caller — including both integration
 * test suites — behaving exactly as before.
 */
async function buildFromPrompt(prompt, opts, onStage) {
  const emit = onStage || function () {};
  const o = opts || {};
  const t0 = Date.now();

  emit("understand", "start", "Reading your prompt");
  const verdictNlu = classify(prompt);
  const slots = extract(prompt, verdictNlu.lang);

  if (!o.industry && !verdictNlu.certain) {
    emit("understand", "done", "not sure yet");
    return {
      needsAnswer: {
        question: "Which is closest to your business?",
        options: choices(verdictNlu).map((k) => ({ key: k, label: INDUSTRY_LABELS[k] || k }))
      },
      nlu: verdictNlu, ms: Date.now() - t0
    };
  }
  const industry = o.industry || verdictNlu.industry;
  emit("understand", "done", [INDUSTRY_LABELS[industry] || industry, slots.city, slots.tone !== "neutral" ? slots.tone : ""].filter(Boolean).join(" · "));

  emit("structure", "start", "Choosing your sections");
  const composed = composer.compose(prompt, {
    industry: industry, company: o.company || slots.company,
    city: slots.city, currency: slots.currency, colour: slots.colour,
    features: slots.features, tone: slots.tone, lang: slots.lang, mode: o.mode || ""
  });
  const verdict = validateSiteConfig(composed.config, { forAgent: true });
  emit("structure", "done", composed.meta.archetypeLabel || "");

  emit("write", "start", "Writing your pages");
  if (verdict.ok) {
    const pages = Object.keys(verdict.config.pages);
    const blocks = pages.reduce((n, s) => n + ((verdict.config.pages[s].blocks || []).length), 0);
    emit("write", "done", blocks + " sections across " + pages.length + " pages");
  } else {
    emit("write", "done", "");
  }

  return { composed: composed, verdict: verdict, nlu: verdictNlu, slots: slots, ms: Date.now() - t0 };
}

/* ---- SSE plumbing ----
   Native EventSource can only GET, and this endpoint needs a POST body, so
   the client reads a normal streamed fetch() response and parses SSE frames
   itself — the standard workaround for POST-triggered server-sent events.
   Negotiated by Accept, so the exact same route serves plain JSON to any
   client (including both test suites) that doesn't ask for a stream. */
function wantsStream(req) {
  return String(req.headers.accept || "").indexOf("text/event-stream") >= 0;
}
function sseOpen(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"        // nginx/proxies: don't buffer the stream
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
}
/* `id` is optional because most streams here are not resumable — a
   project create has nothing to resume to. An agent run does, and the
   id line is what lets a browser say where it got to. */
function sseFrame(res, event, data, id) {
  res.write((id === undefined ? "" : "id: " + id + "\n") +
    "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
}

/* Every status a run can stop at. run-store's own list omits `blocked`
   and worker-service's includes it; a stream that watches the short list
   never stops watching. */
const TERMINAL_RUN_STATUS = new Set(["succeeded", "failed", "cancelled", "partial", "blocked"]);

/**
 * POST /api/projects
 * Body: { prompt, mode?, industry? }
 * Creates the project AND its first revision. No auth — the anonymous
 * cookie is minted here and owns it until someone claims it.
 */
/** The side effects of a successful create: persisted once, used by both the
    plain-JSON and SSE response paths so they can never drift apart. */
async function finishCreate(built, prompt, owner) {
  const meta = built.composed.meta;
  const project = await projects.create({ title: meta.company, prompt: prompt, meta: meta, owner: owner });
  const revision = await projects.addRevision(project.id, built.verdict.config, "First build");
  await projects.addTurn(project.id, { role: "user", kind: "text", body: prompt });
  await projects.addTurn(project.id, {
    role: "agent", kind: "result", body: summarise(built.verdict.config, meta),
    revisionId: revision.id, ms: built.ms
  });
  await projects.ensureIndexes();
  return {
    projectId: project.id, slug: project.slug, title: project.title,
    config: built.verdict.config, meta: meta, revisionId: revision.id, ms: built.ms
  };
}

app.post("/api/projects", projectLimiter, async (req, res, next) => {
  const prompt = String((req.body && req.body.prompt) || "").trim();
  if (prompt.length < 3) return res.status(400).json({ error: "prompt is required" });
  const promptCap = await promptLimitFor(req);
  if (prompt.length > promptCap) return res.status(400).json({ error: tooLongMessage("That brief", prompt.length, promptCap) });
  const owner = anon.ownerOf(req, res);
  const opts = { mode: req.body.mode, industry: req.body.industry };

  if (wantsStream(req)) {
    sseOpen(res);
    try {
      const built = await buildFromPrompt(prompt, opts, (id, state, detail) => sseFrame(res, "stage", { id, state, detail }));
      if (built.needsAnswer) {
        sseFrame(res, "needsAnswer", { needsAnswer: built.needsAnswer, lang: built.nlu.lang });
      } else if (!built.verdict.ok) {
        sseFrame(res, "error", { error: "could not build a site from that", issues: built.verdict.issues.slice(0, 5) });
      } else {
        sseFrame(res, "result", await finishCreate(built, prompt, owner));
      }
      sseFrame(res, "done", { ms: built.ms });
    } catch (e) {
      sseFrame(res, "error", { error: "build failed" });
      console.error("SSE /api/projects error:", e.message);
    }
    return res.end();
  }

  try {
    const built = await buildFromPrompt(prompt, opts);
    // Not confident enough to build something good — ask, don't guess. No
    // project is created for a question, so nothing half-made is left behind.
    if (built.needsAnswer) return res.json({ needsAnswer: built.needsAnswer, lang: built.nlu.lang });
    if (!built.verdict.ok) {
      console.error("project build failed validation:", built.verdict.issues.slice(0, 5));
      return res.status(502).json({ error: "could not build a site from that", issues: built.verdict.issues.slice(0, 5) });
    }
    res.status(201).json(await finishCreate(built, prompt, owner));
  } catch (e) {
    next(e);
  }
});

/** GET /api/projects — everything this owner has made.
    ?kind=code filters to Souqi Code projects only (for its own sidebar) —
    filtered here rather than in projects.js's query, so a mixed history
    (Sites + Code) still returns `limit` Code rows even if Sites projects
    are more numerous; fetching a wider page first is the cheap way to
    keep that true without a schema-level index change for one filter. */
app.get("/api/projects", async (req, res, next) => {
  try {
    /* appOwnerOf, not anon.ownerOf — the same distinction the usage card was
       fixed for, and the same symptom: anon.ownerOf fills userId from the
       Authorization header ONLY, so a person signed in by cookie came back
       carrying their anon id. This list was therefore scoped to whatever that
       browser cookie happened to own, while /api/deploy/overview (which uses
       deployOwnerOf, i.e. appOwnerOf) was scoped to the account — one account,
       two endpoints, 52 apps on /deployments and 3 on /projects.

       ownerFilter() ORs ownerUserId with ownerAnonId, so this only ever adds:
       anything still held by the cookie stays in the list beside the
       account-owned projects, and a signed-out visitor resolves to exactly the
       same owner as before.

       Only the LIST moves. Every /api/projects/:key route keeps anon.ownerOf
       deliberately — microclaim-test.js pins that a cookie-only read of a
       CLAIMED project is refused, and that asymmetry is a real property, not
       an oversight. Listing what you own is not the same question as proving
       you own one particular thing. */
    const owner = appOwnerOf(req, res);
    const kind = String(req.query.kind || "");
    const onlyFavorites = req.query.favorite === "1";
    const limit = Number(req.query.limit) || 30;
    const rows = await projects.list(owner, (kind || onlyFavorites) ? Math.max(limit * 3, 60) : limit);
    let filtered = kind ? rows.filter((p) => (p.meta || {}).kind === kind) : rows;
    if (onlyFavorites) filtered = filtered.filter((p) => !!p.favorite);
    res.json({
      projects: filtered.slice(0, limit).map((p) => ({
        id: p.id, slug: p.slug, title: p.title, prompt: p.prompt,
        industry: (p.meta || {}).industry, accent: (p.meta || {}).accent, kind: (p.meta || {}).kind || null,
        buildType: (p.meta || {}).buildType || null, published: !!p.published, favorite: !!p.favorite,
        // "published" is the old static path (a built dist in Mongo, served
        // from /s/:slug). An app deployed into a container sets
        // deploymentId instead, so a rail keyed only on `published` shows
        // a running app as if it had never shipped.
        deployed: !!p.deploymentId,
        // createdAt as well as updatedAt: the projects table shows "Last
        // opened" and "Created" as separate columns, and one timestamp
        // cannot answer both. projects.create() has always written it.
        claimed: !!p.wsId, updatedAt: p.updatedAt, createdAt: p.createdAt
      }))
    });
  } catch (e) { next(e); }
});

/** POST /api/codeagent/:key/favorite — Body: { favorite: true|false } */
app.post("/api/codeagent/:key/favorite", async (req, res, next) => {
  try {
    const owner = appOwnerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });
    const favorite = !!(req.body && req.body.favorite);
    await projects.patch(project.id, { favorite });
    res.json({ ok: true, favorite });
  } catch (e) { next(e); }
});

/** GET /api/codeagent/usage — this owner's spend this month, for the
    Settings view (reuses the exact tracker the build-time cap already
    checks in POST /build, so the number shown always matches what's
    actually enforced). */
app.get("/api/codeagent/usage", async (req, res, next) => {
  try {
    const owner = appOwnerOf(req, res);
    const plan = await planOfRequest(req);
    const spentUsd = await codeAgentUsage.monthSpend(owner);
    // The same numbers the gate enforces, so the meter in the rail cannot
    // disagree with the wall people actually hit. Reading a different
    // figure from the one being enforced is how a credit system stops
    // being believed.
    const win = await codeAgentUsage.windowSpend(owner, CODEAGENT_WINDOW_HOURS);
    const counts = await codeAgentUsage.monthCounts(owner);
    const liveDeploys = (await projects.list(owner, 200)).filter((p) => p.deploymentId).length;
    res.json({
      spentUsd, plan: plan,
      budgetUsd: CODEAGENT_PLAN_BUDGET_USD[plan] || CODEAGENT_PLAN_BUDGET_USD.free,
      windowUsd: win.usd,
      windowBudgetUsd: CODEAGENT_PLAN_WINDOW_USD[plan] || CODEAGENT_PLAN_WINDOW_USD.free,
      windowHours: CODEAGENT_WINDOW_HOURS,
      windowResetAt: win.resetAt,
      promptChars: CODEAGENT_PLAN_PROMPT_CHARS[plan] || CODEAGENT_PLAN_PROMPT_CHARS.free,
      promptCharsMax: MAX_PROMPT_CHARS,
      freeEdits: CODEAGENT_FREE_EDITS,
      signedIn: !!codeAgentSessionUser(req),
      /* The allowance the gate actually enforces, so the meters in the rail
         cannot promise something the wall then refuses. Same reasoning as the
         spend figures above: a credit system stops being believed the moment
         the number shown and the number enforced disagree. */
      builds: counts.builds,
      edits: counts.edits,
      buildLimit: codeAgentSessionUser(req)
        ? (isPaidPlan(plan) ? null : CODEAGENT_FREE_BUILDS)
        : CODEAGENT_ANON_BUILDS,
      editLimit: isPaidPlan(plan) ? null : CODEAGENT_FREE_EDITS,
      deployLimit: isPaidPlan(plan) ? DEPLOY_PAID_LIMIT : DEPLOY_FREE_LIMIT,
      deploysLive: liveDeploys,
      billingConfigured: stripeLib.isBillingConfigured()
    });
  } catch (e) { next(e); }
});

/** GET /api/codeagent/stats — a small dashboard: how many apps this owner
    has built, broken down by the type they picked at build time. */
app.get("/api/codeagent/stats", async (req, res, next) => {
  try {
    const owner = appOwnerOf(req, res);
    const rows = (await projects.list(owner, 200)).filter((p) => (p.meta || {}).kind === "code");
    const byType = {};
    let published = 0;
    rows.forEach((p) => {
      const t = (p.meta || {}).buildType || "website";
      byType[t] = (byType[t] || 0) + 1;
      if (p.published) published += 1;
    });
    res.json({ total: rows.length, published, byType });
  } catch (e) { next(e); }
});

/** GET /api/projects/:idOrSlug — the project, its transcript and head config. */
app.get("/api/projects/:key", async (req, res, next) => {
  try {
    const owner = appOwnerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });

    const [turns, revision, revisions] = await Promise.all([
      projects.listTurns(project.id),
      projects.head(project.id),
      projects.listRevisions(project.id)
    ]);

    res.json({
      project: {
        id: project.id, slug: project.slug, title: project.title, prompt: project.prompt,
        meta: project.meta, claimed: !!project.wsId, wsId: project.wsId,
        publishedRevisionId: project.publishedRevisionId || null,
        createdAt: project.createdAt, updatedAt: project.updatedAt
      },
      turns: turns,
      config: revision ? revision.config : null,
      revisionId: revision ? revision.id : null,
      revisions: revisions
    });
  } catch (e) { next(e); }
});

/**
 * POST /api/projects/:key/turns
 * Body: { message, industry? }
 * A follow-up. First tries to PATCH the head revision in place — the six ops
 * in refine/grammar.js + refine/apply.js (docs/AGENT-PARITY-PLAN.md §4) — so
 * "make it darker" doesn't throw away three turns of other changes. Only
 * when nothing in that closed vocabulary matches does it fall back to a full
 * rebuild from the combined description, same as before. Either way the
 * result is a new revision through the SAME validator; nothing bypasses it.
 */
const refineGrammar = require("./lib/refine/grammar");
const { applyOps } = require("./lib/refine/apply");

/** The side effects of a successful rebuild-style follow-up. */
async function finishFollowUp(built, project, message, combined) {
  const meta = built.composed.meta;
  const revision = await projects.addRevision(project.id, built.verdict.config, message.slice(0, 60));
  const body = summarise(built.verdict.config, meta);
  await projects.addTurn(project.id, { role: "agent", kind: "result", body: body, revisionId: revision.id, ms: built.ms });
  // the prompt grows, so the next follow-up still knows everything so far
  await projects.patch(project.id, { prompt: combined.slice(0, 2000), meta: meta, title: meta.company });
  return { kind: "rebuild", config: built.verdict.config, meta: meta, revisionId: revision.id, body: body, ms: built.ms };
}

/**
 * Try to satisfy `message` as a patch against the CURRENT head revision.
 *   undefined → no rule matched; caller should fall back to a full rebuild
 *   {noop:true, reason} → recognised the intent, there was nothing to change
 *   {kind:"patch", …} → applied, validated, stored as a new revision
 */
async function attemptPatch(project, message, onStage) {
  const emit = onStage || function () {};
  const t0 = Date.now();
  emit("understand", "start", "Reading your message");

  const head = await projects.head(project.id);
  if (!head) { emit("understand", "done", "no revision to patch yet"); return undefined; }

  const parsed = refineGrammar.parse(message, head.config, project.meta || {});
  if (!parsed) { emit("understand", "done", "no direct match"); return undefined; }
  emit("understand", "done", parsed.noop ? "nothing to change" : parsed.summary);
  if (parsed.noop) return { noop: true, reason: parsed.reason };

  emit("apply", "start", "Making the change");
  const applied = applyOps(head.config, parsed.ops);
  if (!applied.changed) { emit("apply", "done", "no effect"); return { noop: true, reason: "That didn't change anything." }; }

  const verdict = validateSiteConfig(applied.config, { forAgent: true });
  if (!verdict.ok) { emit("apply", "done", "failed"); return { error: "could not apply that", issues: verdict.issues.slice(0, 5) }; }
  emit("apply", "done", parsed.summary);

  const revision = await projects.addRevision(project.id, verdict.config, parsed.summary.slice(0, 60));
  const body = "Done — " + parsed.summary + ".";
  const ms = Date.now() - t0;
  await projects.addTurn(project.id, { role: "agent", kind: "result", body: body, revisionId: revision.id, ms: ms });
  await projects.patch(project.id, {});   // bump updatedAt only — meta/title are unchanged by a patch
  return { kind: "patch", config: verdict.config, meta: project.meta, revisionId: revision.id, body: body, ms: ms };
}

app.post("/api/projects/:key/turns", projectLimiter, async (req, res, next) => {
  try {
    const owner = appOwnerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });

    const message = String((req.body && req.body.message) || "").trim();
    if (!message) return res.status(400).json({ error: "message is required" });
    const messageCap = await promptLimitFor(req);
    if (message.length > messageCap) return res.status(400).json({ error: tooLongMessage("That message", message.length, messageCap) });

    await projects.addTurn(project.id, { role: "user", kind: "text", body: message });
    const combined = (project.prompt ? project.prompt + ". " : "") + message;
    const opts = { industry: req.body.industry };

    if (wantsStream(req)) {
      sseOpen(res);
      try {
        const onStage = (id, state, detail) => sseFrame(res, "stage", { id, state, detail });
        const patch = await attemptPatch(project, message, onStage);
        let ms = 0;

        if (patch && patch.error) {
          sseFrame(res, "error", { error: patch.error, issues: patch.issues });
        } else if (patch && patch.noop) {
          await projects.addTurn(project.id, { role: "agent", kind: "text", body: patch.reason });
          sseFrame(res, "noop", { reason: patch.reason });
        } else if (patch) {
          ms = patch.ms;
          sseFrame(res, "result", patch);
        } else {
          const built = await buildFromPrompt(combined, opts, onStage);
          ms = built.ms;
          if (built.needsAnswer) {
            await projects.addTurn(project.id, { role: "agent", kind: "question", body: built.needsAnswer.question });
            sseFrame(res, "needsAnswer", { needsAnswer: built.needsAnswer });
          } else if (!built.verdict.ok) {
            sseFrame(res, "error", { error: "could not apply that", issues: built.verdict.issues.slice(0, 5) });
          } else {
            sseFrame(res, "result", await finishFollowUp(built, project, message, combined));
          }
        }
        sseFrame(res, "done", { ms: ms });
      } catch (e) {
        sseFrame(res, "error", { error: "build failed" });
        console.error("SSE /turns error:", e.message);
      }
      return res.end();
    }

    const patch = await attemptPatch(project, message);
    if (patch && patch.error) return res.status(502).json(patch);
    if (patch && patch.noop) {
      await projects.addTurn(project.id, { role: "agent", kind: "text", body: patch.reason });
      return res.json({ noop: true, reason: patch.reason });
    }
    if (patch) return res.json(patch);

    const built = await buildFromPrompt(combined, opts);
    if (built.needsAnswer) {
      await projects.addTurn(project.id, { role: "agent", kind: "question", body: built.needsAnswer.question });
      return res.json({ needsAnswer: built.needsAnswer });
    }
    if (!built.verdict.ok) return res.status(502).json({ error: "could not apply that", issues: built.verdict.issues.slice(0, 5) });
    res.json(await finishFollowUp(built, project, message, combined));
  } catch (e) { next(e); }
});

/**
 * GET /api/projects/:key/preview
 * The head revision, in the EXACT shape /api/portal/:wsId/config returns —
 * so public/portal.html can render an unclaimed project through the same
 * renderer (generic-renderer.js) the published storefront runs, with no
 * separate preview code path to keep in sync (docs/AGENT-PARITY-PLAN.md §6).
 * Owner-only: a draft isn't published, so it isn't public like a real portal.
 *
 * THE ONLY handler for this path, and it has to stay that way. A second
 * app.get() on it used to sit further down the file, rendering HTML instead
 * of this JSON — published snapshot if there was one, otherwise a generated
 * "this project hasn't been published yet" page. Express matches the first
 * route registered, so that one never ran at all, and the two disagreed
 * about both the response body and the content type.
 *
 * It was a leftover of the server-side preview approach that was already
 * retired: /api/codeagent/preview/:key above it is a 410 stub saying
 * previews are served locally by WebContainers now, and code.html says the
 * same in its own words — it renders through a real build precisely because
 * this endpoint "never showed anything real" for a draft. Nothing called
 * the HTML one; portal.js calls this one and wants the JSON.
 */
app.get("/api/projects/:key/preview", async (req, res, next) => {
  try {
    const owner = appOwnerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });

    const revision = await projects.head(project.id);
    if (!revision) return res.status(404).json({ error: "nothing built yet" });

    res.json({
      id: project.id,
      company: project.title,
      industry: (project.meta || {}).industry || "retail",
      logo: null,
      storefrontEnabled: true,
      storefrontConfig: revision.config
    });
  } catch (e) { next(e); }
});


/**
 * GET /api/projects/:key/thumb — what a card can actually show for this
 * project, decided here rather than guessed at by the page.
 *
 * Two answers, and the honest part is that there are only two:
 *
 *   { mode: "url", url }   a deployment that is RUNNING and has an address.
 *                          The card iframes the real running site.
 *   { mode: "none", reason } everything else.
 *
 * There is deliberately no "render the source" mode. A Souqi Code project is
 * React/TSX — measured across every revision in this database, not one
 * contains an .html file of any kind, because the model writes components and
 * the build is what turns them into a page. So there is no document to put in
 * an iframe until something has built it. An older endpoint tried anyway and
 * produced a grey "this project hasn't been published yet" card with a file
 * listing on it; code.html says so in its own comment and renders through a
 * real build instead. A placeholder that looks like a broken screenshot is
 * worse than a card that admits it has nothing to show.
 *
 * Only a project that has actually been deployed costs a request to the
 * deploy plane — the rest answer from the row itself.
 */
app.get("/api/projects/:key/thumb", async (req, res, next) => {
  try {
    const owner = appOwnerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });

    if (!project.deploymentId) return res.json({ mode: "none", reason: "not-deployed" });
    if (!deployplane.isConfigured()) return res.json({ mode: "none", reason: "deploy-plane-off" });

    const s = await deployplane.getStatus(cookieOf(req), project.deploymentId);
    if (!s.ok || !s.body) return res.json({ mode: "none", reason: "status-unavailable" });
    if (s.body.status !== "RUNNING" || !s.body.url) {
      return res.json({ mode: "none", reason: String(s.body.status || "not-running").toLowerCase() });
    }

    /* A short cache: a running app's address does not move, and without this
       every scroll back over a card pays for the deploy-plane round trip
       again. */
    res.setHeader("Cache-Control", "private, max-age=60");
    res.json({ mode: "url", url: s.body.url, status: s.body.status });
  } catch (e) { next(e); }
});

/** POST /api/projects/:key/restore — go back to a revision, without losing it. */
app.post("/api/projects/:key/restore", async (req, res, next) => {
  try {
    const owner = appOwnerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });

    const target = await projects.getRevision(String((req.body && req.body.revisionId) || ""));
    if (!target || target.projectId !== project.id) return res.status(404).json({ error: "revision not found" });

    // Restoring APPENDS a revision rather than rewinding, so the thing you
    // undid is still there if you change your mind again.
    const verdict = validateSiteConfig(target.config, { forAgent: true });
    if (!verdict.ok) return res.status(422).json({ error: "that revision is no longer valid" });

    // Name it after what it restored TO, not the internal revision id — "Restored
    // rv_wvkNLnLa2pU" means nothing to the person looking at their own history.
    const revision = await projects.addRevision(project.id, verdict.config, "Restored: " + (target.label || "an earlier version"));
    await projects.addTurn(project.id, {
      role: "agent", kind: "result", body: "Restored an earlier version.", revisionId: revision.id
    });
    res.json({ config: verdict.config, revisionId: revision.id });
  } catch (e) { next(e); }
});

/** DELETE /api/projects/:key */
/** PATCH /api/projects/:key - Body: { title }
    Renames a project. The SLUG is deliberately left alone: it is the URL the
    project already has, it is in the address bar and in every link anyone has
    to it, and re-deriving it from a new title would break all of them to fix
    nothing. Title is what people read; slug is what machines follow. */
app.patch("/api/projects/:key", async (req, res, next) => {
  try {
    const owner = appOwnerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });

    const title = String((req.body && req.body.title) || "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!title) return res.status(400).json({ error: "title required" });

    await projects.patch(project.id, { title });
    res.json({ ok: true, title });
  } catch (e) { next(e); }
});

app.delete("/api/projects/:key", async (req, res, next) => {
  try {
    const owner = appOwnerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });
    await projects.remove(project.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** Accept either a project id or a slug in the URL. */
/**
 * A project key is either its id or its slug, and the two are NOT equally
 * safe to resolve.
 *
 * A slug is looked up THROUGH the owner: findBySlug filters on ownerUserId
 * or ownerAnonId, so a slug you do not own simply does not exist for you.
 * An id is not — projects.get() is a primary-key read with no owner in it
 * at all, because several callers legitimately need the row before they can
 * decide anything about it (the claim route has to see an unclaimed
 * project in order to claim it).
 *
 * So this function answers "which project is this key" and NOT "may you
 * have it". Every caller owes it a
 *
 *     if (!projects.owns(project, owner)) return res.status(403)...
 *
 * on the very next line. Three routes forgot — both /api/security/scan
 * endpoints and /api/projects/:key/thumb — and with a project id alone, no
 * cookie and no token, a stranger could read another account's title,
 * deploy state, dependency advisories and secret-scan findings. There is a
 * test that now walks every call site below and fails if one is missing;
 * if you add a caller, it will tell you.
 */
async function resolveProject(key, owner) {
  const k = String(key || "");
  if (/^pr_[A-Za-z0-9_-]{6,40}$/.test(k)) return projects.get(k);   // by id: UNSCOPED, caller must check owns()
  return projects.findBySlug(k.toLowerCase(), owner);               // by slug: already scoped to the owner
}

/** One sentence about what was built, from the config itself. */
function summarise(config, meta) {
  const pages = Object.keys(config.pages || {});
  const blocks = pages.reduce((n, s) => n + ((config.pages[s].blocks || []).length), 0);
  return blocks + " sections across " + pages.length + " page" + (pages.length === 1 ? "" : "s") +
    (meta && meta.industry ? " for a " + meta.industry + " business" : "") + ".";
}

/**
 * The write side of "publish": push ONE revision's config into the
 * workspace's live storefrontConfig. Pure — no ownership changes, no
 * project.patch, no audit — because claim-time publishing and every publish
 * after it need this same write but each layers different bookkeeping on
 * top (see finalizeClaim and POST /publish below). This is what fixes
 * docs/AGENT-GAP-AUDIT.md §1.3: it's the ONE place a project's head
 * revision becomes the live site, called explicitly, not implicitly on
 * every agent turn.
 */
async function publishRevisionToWorkspace({ revision, wsId, masterDb }) {
  // Re-validate on the way in — a revision was validated when it was
  // written, but it has been sitting in a database since.
  const verdict = validateSiteConfig(revision.config, { forAgent: true });
  if (!verdict.ok) {
    const e = new Error("this version is no longer valid");
    e.status = 422; e.issues = verdict.issues.slice(0, 5);
    throw e;
  }
  await masterDb.collection("workspaces").updateOne(
    { id: wsId },
    { $set: { storefrontConfig: verdict.config, storefrontEnabled: true } }
  );
  return verdict;
}

/**
 * The rest of a claim: re-point project ownership to the user and mint an
 * edit token. Shared by the pre-authenticated /claim route and the one-shot
 * micro-claim route below, so "what a claim actually does" only exists in
 * one place. Claiming publishes the head revision as a side effect — that
 * first publish is what makes "claim this site" mean something immediately
 * — but every publish AFTER this one goes through POST /publish instead.
 */
async function finalizeClaim({ project, wsId, userId, email, masterDb, requestId }) {
  const revision = await projects.head(project.id);
  if (!revision) { const e = new Error("project has no build yet"); e.status = 422; throw e; }

  await publishRevisionToWorkspace({ revision, wsId, masterDb });
  await projects.patch(project.id, {
    wsId: wsId, ownerUserId: userId, ownerAnonId: project.ownerAnonId, expiresAt: null,
    publishedRevisionId: revision.id
  });

  const ws = await resolveWsContext(wsId);
  await writeAudit(dbAdapter, ws, {
    requestId: requestId, actor: email, action: "workspace.storefront.claim",
    entity: "workspace", entityId: wsId,
    summary: "Project " + project.id + " (" + project.slug + ") claimed as the live storefront"
  });

  return jwt.sign({ wsId: wsId, email: email, scope: "portal-edit" }, JWT_SECRET, { expiresIn: "15m" });
}

/**
 * POST /api/projects/:key/claim
 * Body: { wsId }   Header: Authorization: Bearer <owner JWT>
 *
 * Turns a project into the workspace's live storefront and moves ownership
 * from the anonymous cookie to the signed-in user — the same row, re-pointed,
 * so nothing is copied and nothing is lost. The anonymous cookie on THIS
 * request must match the project's anonymous owner: knowing a project's slug
 * or id is not authorisation for anything, same as the workspace check below.
 */
app.post("/api/projects/:key/claim", async (req, res, next) => {
  try {
    const wsId = String((req.body && req.body.wsId) || "");
    if (!wsId) return res.status(400).json({ error: "wsId is required" });

    const { decoded, masterDb } = await assertOwnsWorkspace(req, wsId);
    const owner = anon.ownerOf(req, res);

    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });

    const alreadyClaimedByMe = project.ownerUserId && project.ownerUserId === decoded.id;
    const claimableByAnon = !project.ownerUserId && project.ownerAnonId && project.ownerAnonId === owner.anonId;
    if (!alreadyClaimedByMe && !claimableByAnon) {
      return res.status(403).json({ error: "not your project" });
    }
    if (project.wsId && project.wsId !== wsId) {
      return res.status(409).json({ error: "this project is already attached to a different workspace" });
    }

    const editToken = await finalizeClaim({ project, wsId, userId: decoded.id, email: decoded.email, masterDb, requestId: req.id });
    res.json({ ok: true, wsId: wsId, editToken: editToken, expiresIn: 900, meta: project.meta || null });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, issues: e.issues });
    next(e);
  }
});

/**
 * POST /api/projects/:key/publish
 * Header: Authorization: Bearer <owner JWT>
 *
 * Pushes the project's CURRENT head revision live. Claiming already
 * publishes once as a side effect (finalizeClaim) — this is every publish
 * after that. Deliberately its own step rather than automatic on every
 * agent turn: docs/AGENT-GAP-AUDIT.md §1.3 is what happens when a project's
 * revisions and a workspace's storefrontConfig are allowed to drift with no
 * one ever telling the owner they've diverged. This endpoint is the one
 * place that reconciles them, and only when asked to.
 */
app.post("/api/projects/:key/publish", async (req, res, next) => {
  try {
    const owner = appOwnerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });
    if (!project.wsId) return res.status(400).json({ error: "this project has not been claimed yet — nothing to publish to" });

    const { decoded, masterDb } = await assertOwnsWorkspace(req, project.wsId);
    const revision = await projects.head(project.id);
    if (!revision) return res.status(422).json({ error: "project has no build yet" });

    if (project.publishedRevisionId === revision.id) {
      return res.json({ ok: true, alreadyPublished: true, publishedRevisionId: revision.id });
    }

    await publishRevisionToWorkspace({ revision, wsId: project.wsId, masterDb });
    await projects.patch(project.id, { publishedRevisionId: revision.id });

    const ws = await resolveWsContext(project.wsId);
    await writeAudit(dbAdapter, ws, {
      requestId: req.id, actor: decoded.email, action: "workspace.storefront.publish",
      entity: "workspace", entityId: project.wsId,
      summary: "Project " + project.id + " (" + project.slug + ") published revision " + revision.id
    });

    res.json({ ok: true, publishedRevisionId: revision.id });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, issues: e.issues });
    next(e);
  }
});

/**
 * POST /api/projects/:key/micro-claim
 * Body: { email, password, company?, industry?, country? }
 *
 * The "own it in ten seconds" path (docs/AGENT-PARITY-PLAN.md §7): two
 * fields instead of the full twelve-field signup, because everything else
 * a workspace needs is already known — the agent extracted the industry
 * and company name while building, and the database defaults to local
 * until the owner says otherwise from the console.
 *
 * Order of operations matters: create the account, then the workspace,
 * then claim, then let the caller redirect. A failure at any step leaves
 * the project exactly as it was — nothing here can lose the work someone
 * just watched being made, it can only fail to attach it yet.
 */
app.post("/api/projects/:key/micro-claim", microClaimLimiter, verifyCaptcha(), validateBody(microClaimSchema), async (req, res, next) => {
  try {
    const { email, password, company, industry, country } = req.valid;
    const emailLower = email.toLowerCase();

    const owner = anon.ownerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });
    if (project.wsId) return res.status(409).json({ error: "this project is already claimed" });

    const masterDb = getMasterDb();
    if (!masterDb) return res.status(503).json({ error: "Master DB not available" });

    const existingWs = await masterDb.collection("workspaces").findOne({ ownerEmail: emailLower });
    if (existingWs) {
      return res.status(409).json({ error: "an account with this email already exists — sign in and claim from there instead" });
    }

    const meta = project.meta || {};
    const wsId = "ws_" + Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
    const companyName = String(company || meta.company || project.title || "My Business").slice(0, 120);

    await masterDb.collection("workspaces").insertOne({
      id: wsId,
      company: companyName,
      industry: String(industry || meta.industry || "retail"),
      country: String(country || "OT"),
      ownerEmail: emailLower,
      dbType: "local",
      dbUri: "",
      logo: null,
      tagline: "",
      storefrontEnabled: false,
      plan: "free",
      createdAt: new Date().toISOString()
    });

    const ownerUser = {
      id: "usr_" + crypto.randomBytes(8).toString("base64url"),
      name: emailLower.split("@")[0],
      email: emailLower,
      password: password,              // insertOne() bcrypt-hashes "users" passwords automatically
      role: "Owner", dept: "Management", active: true,
      joined: new Date().toISOString().slice(0, 10)
    };
    const ws = await resolveWsContext(wsId);
    await dbAdapter.insertOne(ws, "users", ownerUser);

    let editToken;
    try {
      editToken = await finalizeClaim({ project, wsId, userId: ownerUser.id, email: emailLower, masterDb, requestId: req.id });
    } catch (claimErr) {
      // Account + workspace exist; the project just isn't attached yet. Say
      // so plainly rather than losing either half of what already happened.
      const status = claimErr.status || 500;
      const session = { id: ownerUser.id, name: ownerUser.name, email: ownerUser.email, role: "Owner", dept: "Management", wsId: wsId, sessionEpoch: ownerUser.sessionEpoch || 0 };
      const token = jwt.sign(session, JWT_SECRET, { expiresIn: "12h" });
      return res.status(status).json({
        ok: false, accountCreated: true, wsId: wsId, token: token, user: session,
        error: "your account and workspace were created, but this build could not be attached: " + claimErr.message
      });
    }

    const session = { id: ownerUser.id, name: ownerUser.name, email: ownerUser.email, role: "Owner", dept: "Management", wsId: wsId, sessionEpoch: ownerUser.sessionEpoch || 0 };
    const token = jwt.sign(session, JWT_SECRET, { expiresIn: "12h" });
    res.json({ ok: true, wsId: wsId, token: token, user: session, editToken: editToken, expiresIn: 900, meta: project.meta || null });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

/* =================================================================
   SOUQI CODE — the code-generating agent (docs/CODE-AGENT-PLAN.md)
   -----------------------------------------------------------------
   A different product line from the site builder above it: this one
   writes real files and runs them in an isolated Daytona sandbox,
   not a storefront config — but it durably persists through the SAME
   `projects.js` object the site builder uses (one `projects` Mongo
   collection, both product lines, differentiated only by
   `meta.kind === "code"`), so it inherits the same owner-scoped
   security model for free: `projects.owns()` gates every read and
   write here exactly as it does for the site builder.

   One lifetime now. There used to be two — an in-memory `codeBuilds`
   cache of live Daytona sandboxes alongside the durable record — and
   the sandbox half is gone with the move to WebContainers: the build
   runs in the user's browser, so there is nothing server-side to keep
   warm between turns.
     - `projects` (Mongo) durably stores full file contents per
       revision — what makes a build survive a reload or a server
       restart. If the sandbox is gone but the project isn't, a
       follow-up (or just reopening the page) re-creates a sandbox and
       re-materializes the last known files onto it before doing
       anything new — "resume", not "start over".
   Git commits inside the sandbox (Phase 7's literal ask) are a THIRD,
   shorter-lived layer on top of the first — checkpoints for undo
   within a still-alive session; they die with the sandbox exactly
   like everything else in it, which is why they are not the
   durability mechanism on their own.
   ================================================================= */
/* The Daytona runtime, its registry and the seven-tool surface used to be
   required here. They are gone with the sandbox they served: builds moved
   into the browser, nothing has written a revision `sandboxId` since, and
   the one function that consumed them could therefore never return a
   handle. Requiring @daytona/sdk on every cold start to reach code that
   could not run was 7.2MB of bundle for nothing.

   lib/codeagent/tools.js and dom-snapshot.js stay ON DISK, unreferenced.
   tools.js still holds the read_file and list_files implementations, which
   are the next thing the model needs, and dom-snapshot.js is the original
   blank-page check — the one just rebuilt in the browser. Deleting them
   would mean writing them again. */
const { proposeChanges, proposeWithRepair, proposeWithClientBuild, repairProposal, assessPrompt, buildPlan, buildCodebaseContext, buildImagesBlock, codeBudgetChars, effortFor, EFFORT, PROMPT_VERSION, quickAssess } = require("./lib/codeagent/model-loop");
const diffstat = require("./lib/codeagent/diffstat");
const codeMemory = require("./lib/codeagent/memory");
const codeAgentUsage = require("./lib/codeagent/usage");
codeAgentUsage.init({ getMasterDb });
const runStore = require("./lib/codeagent/run-store");
const agentRunner = require("./lib/codeagent/agent-runner");
const agentState = require("./lib/codeagent/agent-state");
runStore.init({ getMasterDb });
runStore.ensureIndexes().catch(() => {});

/* Ten per fifteen minutes PER ADDRESS was too tight for the thing it
   guards, and the counter it shares is the reason.

   An address is not a person. An office, a university, a café and an
   entire mobile carrier's customers all arrive from one — and a launch is
   exactly when several strangers behind one NAT try the product within a
   few minutes of each other. Ten between all of them, shared with publish,
   export and domain calls, walls real users in the first hour.

   It was never the real limit anyway. An anonymous visitor gets ONE build
   and a free account gets three a month, checked per owner, plus a
   per-owner spend cap above this — so what actually bounds cost is the
   quota, and this only has to stop a script. Forty does that and does not
   punish a shared address. (I hit the old ceiling myself, testing the
   launch path a handful of times from one IP, which is how tight it was.)

   A prefix because the shared counter is namespaced per limiter now, and
   naming it is better than taking whatever number it is assigned. */
const codeAgentLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, prefix: "rl-codeagent", key: (req) => req.ip || "" });

/* Its own bucket rather than sharing the build limiter. Attaching six photos
   to one message is six signing calls and six completions — normal use that
   would eat a build allowance meant for something far more expensive. */
const uploadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 120, prefix: "rl-upload", key: (req) => req.ip || "" });

/* appOwnerOf and isAdminEmail are declared further down and hoisted, so the
   references here are live by the time a request arrives. */
require("./lib/uploads-routes").register(app, {
  appOwnerOf: (req, res) => appOwnerOf(req, res),
  isAdminEmail: (email) => isAdminEmail(email),
  limiter: uploadLimiter,
  // Describing an image is AI spend and is billed to the same owner budget a
  // build is, so it cannot be a free side channel around the quota.
  recordSpend: (owner, usd) => {
    if (!usd) return;
    try { codeAgentUsage.recordSpend(owner, usd); } catch (e) {}
  }
});

// WebContainers flow: the SSE handler proposes files and waits for the client
// to build them in the browser. This map holds pending promises keyed by a
// unique buildId — the build-feedback endpoint resolves them.
const pendingBuildResults = new Map(); // buildId -> { resolve, timer }

// The platform-wide AI_MONTHLY_BUDGET_USD (lib/ai/client.js) stops total
// spend across BOTH product lines from running away — but it's a shared
// pool, and that guard alone doesn't stop one visitor from spending all of
// it before anyone else gets a turn. This caps spend per OWNER instead,
// independently of that shared ceiling. 0 disables the check (useful for
// local dev, matching AI_MONTHLY_BUDGET_USD's own "0 = off" convention).
const CODEAGENT_OWNER_MONTHLY_BUDGET_USD = Number(process.env.CODEAGENT_OWNER_MONTHLY_BUDGET_USD || 1);

/* What a plan is actually allowed to spend, per month.
 *
 * The single budget above applied to EVERYONE, paying or not. So a Pro
 * subscriber at $18/month hit a $1 AI wall and was told to wait until next
 * month — they had paid, and the product stopped. That is the bug in the
 * credit system, not the presence of a cap.
 *
 * Free stays where it was. Paid gets four dollars of model spend, which
 * against DeepSeek's pricing is a great many builds and still leaves the
 * subscription comfortably profitable.
 */
const CODEAGENT_PLAN_BUDGET_USD = {
  free: CODEAGENT_OWNER_MONTHLY_BUDGET_USD,
  pro: Number(process.env.CODEAGENT_PRO_BUDGET_USD || 4),
  max: Number(process.env.CODEAGENT_MAX_BUDGET_USD || 4)
};

/* The pacing cap, on the model people already know from Claude.
 *
 * A monthly ceiling on its own can be spent in an afternoon, and then the
 * product is dead for three weeks — which is a worse experience than a
 * smaller limit that keeps coming back. A rolling five-hour window makes
 * the monthly number last the month, and it is rolling rather than a fixed
 * bucket so there is no edge to stand on at the boundary.
 *
 * The window sits UNDER the monthly cap, never over it: whichever runs out
 * first stops the build, and the message says which one and when it lifts.
 */
const CODEAGENT_WINDOW_HOURS = Number(process.env.CODEAGENT_WINDOW_HOURS || 5);
const CODEAGENT_PLAN_WINDOW_USD = {
  free: Number(process.env.CODEAGENT_FREE_WINDOW_USD || 0.5),
  pro: Number(process.env.CODEAGENT_PRO_WINDOW_USD || 0.8),
  max: Number(process.env.CODEAGENT_MAX_WINDOW_USD || 0.8)
};

/* A long brief is a paid feature. 16000 characters is room to describe a
   whole product; 2000 is room to describe one page, which is what the
   limit was before today and is still enough to build something real. */
const CODEAGENT_PLAN_PROMPT_CHARS = {
  free: Number(process.env.CODEAGENT_FREE_PROMPT_CHARS || 2000),
  pro: MAX_PROMPT_CHARS,
  max: MAX_PROMPT_CHARS
};

function isPaidPlan(plan) { return plan === "pro" || plan === "max"; }

/**
 * May this owner put another app on the air?
 *
 * Deployments are the paid line: a free account gets DEPLOY_FREE_LIMIT (0),
 * a subscriber DEPLOY_PAID_LIMIT live at once. The cap is on what is RUNNING
 * rather than on how many times someone presses deploy, because a container
 * that stays up is the thing that costs money — and re-deploying an app that
 * is already live has to stay free, or fixing a bug would count against you.
 *
 * FAILS OPEN when billing is not configured. A server that cannot sell a
 * subscription must not punish people for not having one: with no Stripe
 * keys set, /api/billing/config already answers "not available here", and
 * gating on a plan nobody can buy would take deployment away from everyone
 * with no route back. The moment real keys exist the gate is real.
 *
 * Returns null to allow, or {status, body} to refuse.
 */
async function deployAllowance(req, project) {
  if (!stripeLib.isBillingConfigured()) return null;

  const sessionUser = codeAgentSessionUser(req);
  if (sessionUser && isAdminEmail(sessionUser.email)) return null;

  const plan = await planOfRequest(req);
  const cap = isPaidPlan(plan) ? DEPLOY_PAID_LIMIT : DEPLOY_FREE_LIMIT;

  if (cap <= 0) {
    return { status: 402, body: {
      error: "Deploying is part of a paid plan — subscribe to put your app on the internet.",
      reason: "subscription_required",
      pricingUrl: "/pricing"
    } };
  }

  /* Already live counts once. Re-deploying an app that is on the air is a
     replacement, not a new slot, so it is never refused. */
  if (project.deploymentId) return null;

  const owner = appOwnerOf(req, res0(req));
  const mine = await projects.list(owner, 200);
  const live = mine.filter((p) => p.deploymentId && p.id !== project.id).length;
  if (live >= cap) {
    return { status: 402, body: {
      error: "Your plan runs " + cap + " app" + (cap === 1 ? "" : "s") +
        " at a time, and you have " + live + " live. Stop one, or upgrade for more.",
      reason: "deploy_limit", live: live, limit: cap, pricingUrl: "/pricing"
    } };
  }
  return null;
}

/* appOwnerOf wants a response to write an anon cookie onto; a plan check
   never should. A throwaway stands in so the ownership read stays read-only. */
function res0() { return { cookie: function () {}, setHeader: function () {} }; }

/* One place that answers "what plan is this request on".
 *
 * The same workspace lookup was written inline in two separate gates
 * already, and every new limit wanted a third copy. Anonymous and
 * signed-out both resolve to free, which is correct: there is no
 * subscription without an account to attach it to.
 */
async function planOfRequest(req) {
  const sessionUser = codeAgentSessionUser(req);
  if (!sessionUser || !sessionUser.wsId) return "free";
  const db = getMasterDb();
  if (!db) return "free";
  try {
    const ws = await db.collection("workspaces").findOne({ id: sessionUser.wsId }, { projection: { plan: 1 } });
    return (ws && ws.plan) || "free";
  } catch (e) { return "free"; }
}

/** The prompt ceiling for whoever is asking. */
async function promptLimitFor(req) {
  const plan = await planOfRequest(req);
  return CODEAGENT_PLAN_PROMPT_CHARS[plan] || CODEAGENT_PLAN_PROMPT_CHARS.free;
}

/**
 * Both spend gates for one owner, answered together.
 *
 * Returns { ok } or { ok:false, scope, message }. Checked in the order the
 * person experiences them: the window is the one that lifts on its own, so
 * it is worth reporting even when the month is also close, because "try
 * again at 6pm" is actionable and "wait for next month" is not.
 */
async function spendGate(owner, plan) {
  const paid = isPaidPlan(plan);
  const monthCap = CODEAGENT_PLAN_BUDGET_USD[plan] || CODEAGENT_PLAN_BUDGET_USD.free;
  const windowCap = CODEAGENT_PLAN_WINDOW_USD[plan] || CODEAGENT_PLAN_WINDOW_USD.free;

  if (windowCap > 0) {
    const w = await codeAgentUsage.windowSpend(owner, CODEAGENT_WINDOW_HOURS);
    if (w.usd >= windowCap) {
      const when = w.resetAt ? new Date(w.resetAt) : null;
      const mins = when ? Math.max(1, Math.round((when.getTime() - Date.now()) / 60000)) : null;
      const inWords = mins === null ? "shortly"
        : mins < 60 ? ("in " + mins + " minute" + (mins === 1 ? "" : "s"))
        : ("in about " + Math.round(mins / 60) + " hour" + (Math.round(mins / 60) === 1 ? "" : "s"));
      return {
        ok: false, scope: "window", resetAt: w.resetAt,
        message: "You've used this " + CODEAGENT_WINDOW_HOURS + "-hour window's build allowance. It refills "
          + inWords + "." + (paid ? "" : " Subscribing raises it.")
      };
    }
  }

  if (monthCap > 0) {
    const spent = await codeAgentUsage.monthSpend(owner);
    if (spent >= monthCap) {
      return {
        ok: false, scope: "month",
        message: paid
          ? "You've used this month's $" + monthCap.toFixed(2) + " of build credit. It resets next month."
          : "You've used this month's free build budget ($" + monthCap.toFixed(2) + "). Subscribe for more, or it resets next month."
      };
    }
  }
  return { ok: true };
}

// First build is always free and anonymous (matches the rest of the funnel
// — no signup wall before someone has seen anything real). Editing it is
// where the product asks for something: sign in for the first few free
// edits, then a paid plan to keep going. Both gates apply ONLY to
// follow-ups, never the first message.
const CODEAGENT_FREE_EDITS = Number(process.env.CODEAGENT_FREE_EDITS || 10);

/* ---- the free allowance, in whole actions --------------------------------

   The spend budget above answers "what has this owner cost us". That is the
   right question for abuse and the wrong one for a plan: "3 builds a month"
   has to count builds, and a cheap build and an expensive one are one build
   each.

   Anonymous gets exactly one. It is enough to see the product do the thing
   it claims — which is the whole argument for not putting a signup wall in
   front of it — and not enough to live here for free.

   Every number is env-tunable because the right values are a pricing
   decision, not an engineering one, and changing them should not need a
   deploy of new code. */
const CODEAGENT_ANON_BUILDS = Number(process.env.CODEAGENT_ANON_BUILDS || 1);
const CODEAGENT_FREE_BUILDS = Number(process.env.CODEAGENT_FREE_BUILDS || 3);

/* Deployments are the paid line. FREE_DEPLOYS is 0 and PAID_DEPLOYS is the
   number of apps a subscriber may have live at once — a cap on what is
   RUNNING, not on how many times they press the button, because what costs
   us money is a container that stays up. */
const DEPLOY_FREE_LIMIT = Number(process.env.DEPLOY_FREE_LIMIT || 0);
const DEPLOY_PAID_LIMIT = Number(process.env.DEPLOY_PAID_LIMIT || 2);

/** Reads the sq_session cookie directly, scoped to this file rather than
    anon.js's shared userOf() — that one is Authorization-header-only on
    purpose (project-test.js's claim/publish security model depends on a
    stray session cookie NOT counting as ownership proof). Code's own
    sign-in gate below needs the opposite: recognize a visitor who's
    logged in through the site's normal cookie-based flow, since code.html
    has no reason to duplicate Bearer-token plumbing the rest of the site
    doesn't use either. Used ONLY for the gate check, never for project
    ownership — projects.owns() keeps working exactly as before. */
function codeAgentSessionUser(req) {
  const raw = req.headers.cookie || "";
  const m = /(?:^|;\s*)sq_session=([^;]*)/.exec(raw);
  if (!m) return null;
  try {
    const decoded = jwt.verify(decodeURIComponent(m[1]), JWT_SECRET);
    return decoded && decoded.id ? decoded : null;
  } catch (e) { return null; }
}

/**
 * The async half of session verification: everything codeAgentSessionUser
 * can decide from the token alone, PLUS the one thing it can't — whether
 * the token has been revoked since it was signed.
 *
 * POST /api/account/sessions/revoke bumps a per-user `sessionEpoch`; a
 * token minted before that bump carries a stale value and must stop
 * working, which is the entire mechanism by which "sign out other
 * sessions" means anything for stateless JWTs. Kept separate from the
 * sync version deliberately: this costs a DB read, so only the routes
 * where revocation actually matters (settings, account deletion) pay for
 * it, while the hot build path keeps its cheap synchronous check.
 */
async function codeAgentSessionUserVerified(req) {
  const decoded = codeAgentSessionUser(req);
  if (!decoded) return null;
  try {
    const ws = await resolveWsContext(decoded.wsId);
    const users = await dbAdapter.findAll(ws, "users");
    const user = users.find((u) => u.id === decoded.id);
    if (!user || user.active === false) return null;
    // Absent on both sides = never revoked; that's a match, not a mismatch.
    if ((user.sessionEpoch || 0) !== (decoded.sessionEpoch || 0)) return null;
    return decoded;
  } catch (e) {
    return null; // can't prove the token is still valid -> treat as signed out
  }
}

/** Only the truly-degenerate case (empty, or a couple of stray characters)
    is worth rejecting for free — genuine vagueness ("hello", "build me
    something cool") now gets a REAL clarifying question from
    assessPrompt() instead of a canned message, which is strictly better
    and is what this gate used to stand in for before that existed. */
function promptTooVague(prompt) {
  return prompt.length < 3;
}

// Whole-message match only, deliberately — "thanks for the great header but
// also make the button blue" is a real change request that happens to
// start with a pleasantry, and must NOT get caught here.
const CODEAGENT_CHITCHAT_RE = /^(thanks?( you)?|thx|ty|cool|nice|great|awesome|perfect|good( job| one)?|ok(ay)?|sounds good|lol+|ha+h?a*|nvm|never ?mind|no(pe)?|yes|yep|yup|k|👍|🙏|❤️?)[\s.!?]*$/i;
function isCodeAgentChitChat(message) {
  return CODEAGENT_CHITCHAT_RE.test(message.trim());
}
/**
 * "Publish this" as a whole message — the user asking to deploy, not
 * asking for a change that happens to mention the word.
 *
 * Detected here rather than given to the model as a tool, because the
 * server CANNOT publish: with WebContainers the built dist/ only exists
 * in the user's browser, so publishing is necessarily client-driven (see
 * POST /:key/publish, which receives dist from the client). A tool the
 * model could call but the server could not execute would be a lie in
 * the tool schema. This routes to the client's existing publish path
 * instead — the same one the Publish button already uses.
 *
 * Whole-message only, same discipline as chit-chat above: "add a footer
 * and then publish it" is a real change request and must still build.
 */
const CODEAGENT_PUBLISH_RE = /^(please\s+)?(publish|deploy|ship|go\s+live|make\s+(it|this)\s+live|put\s+(it|this)\s+online)(\s+(it|this|the\s+)?(app|site|project|page)?)?[\s.!]*$/i;
function isCodeAgentPublishRequest(message) {
  return CODEAGENT_PUBLISH_RE.test(String(message || "").trim());
}

const CODEAGENT_CHITCHAT_REPLIES = [
  "Glad it's working! Tell me what to change whenever you're ready.",
  "You're welcome — happy to keep going whenever you have another change.",
  "Anytime! Just say the word if you want to tweak anything."
];
function codeAgentChitChatReply() {
  return CODEAGENT_CHITCHAT_REPLIES[Math.floor(Math.random() * CODEAGENT_CHITCHAT_REPLIES.length)];
}

/** One line for the transcript — what actually happened, not a template. */
function summariseCodeBuild(fileCount, repaired, rounds, fileStats) {
  let actions = [];
  if (Array.isArray(fileStats) && fileStats.length) {
    const created = fileStats.filter(s => s.isNew).map(s => (s.path || "").split("/").pop()).filter(Boolean);
    const updated = fileStats.filter(s => !s.isNew && (s.added || s.removed)).map(s => (s.path || "").split("/").pop()).filter(Boolean);
    if (created.length) actions.push("Created " + created.join(", "));
    if (updated.length) actions.push("Updated " + updated.join(", "));
  }
  if (!actions.length) {
    actions.push("Wrote " + fileCount + (fileCount === 1 ? " file" : " files"));
  }
  if (repaired) {
    actions.push("fixed build issues (" + rounds + " tries)");
  }
  return actions.join("; ") + ". Cleanly compiled and verified in preview.";
}

/** A safe, short git commit message from a free-text prompt — same escaping
    concern as anywhere else user text reaches a shell-adjacent argument. */
function gitSafeMessage(label) {
  return label.slice(0, 72).replace(/["\\\n]/g, " ").trim() || "Update";
}

/** code.html's type-picker (Website/Web App/Dashboard/Mobile) — kept
    server-side rather than baked into the client's prompt string
    deliberately: `projects.create()` derives the project's title AND
    slug from the raw prompt (`prompt.slice(0, 60)`), and a client-side
    prefix like "Build this as a dashboard-style app…" landed IN that
    slice, ahead of anything the user actually typed — found live, a
    build of "a sales tracker" got the title "Build this as a
    dashboard-style app with stat tiles, a chart" and a matching
    unreadable URL. Applying the hint here, after the raw prompt is
    already captured for storage, keeps the model instruction and the
    human-facing title/slug from fighting over the same 60 characters.
    Every option still produces the same one stack (React/Vite) — this
    only ever changes what gets ASKED FOR, never what gets built. */
const CODEAGENT_TYPE_HINT = {
  webapp: " Build it as an interactive web app (meaningful state, more than one view or section as needed), not a static marketing page.",
  dashboard: " Build it as a dashboard-style app with stat tiles, a chart or table, and realistic example data.",
  portfolio: " Build it as a personal portfolio site with a projects/work grid, short case-study blurbs, and an about section.",
  mobile: " Build it as a mobile-optimized, single-column, touch-friendly layout that feels great on a phone screen.",
  // Honest extensions of the same idea as the four above: every one of
  // these still only ever produces the same React/Vite web app
  // (docs/CODE-AGENT-PLAN.md §1) — just steered toward a different shape
  // of ONE, same as "mobile" biases a layout without promising a native
  // app. Deliberately NOT Replit's full type list: several of theirs
  // (3D Game, Spreadsheet, Slides, Document) are genuinely different
  // output formats their agent builds differently, which this one does
  // not — offering them as selectable options here would promise a
  // capability that doesn't exist behind it.
  landing: " Build it as a single-page marketing landing page: a hero, a few feature/benefit sections, and a clear call to action — not a multi-page app.",
  blog: " Build it as a blog: a post list/index and an individual post view, with realistic example posts, not lorem ipsum.",
  ecommerce: " Build it as a storefront: a product grid, a product detail view, and a cart — with realistic example products, not a payment integration.",
  // 2D only, and deliberately so — same reasoning as the note above about
  // Replit's "3D Game". A canvas/DOM game with a loop, input handling and
  // score IS just a React web app, so this steers the same single output
  // shape and promises nothing the agent can't build. A 3D engine game
  // would be a different output format and is still not offered.
  game: " Build it as a playable 2D browser game rendered on a <canvas>: a real game loop, keyboard/touch controls, collision, score, and a restart — not a page about a game."
};

// docs/pricing.html: Free has no total-app cap (each app gets its own
// CODEAGENT_FREE_EDITS before hitting the subscribe gate, unbounded in
// count) — only Pro and Max cap how many apps you can have at once.
// Checked once, at fresh-build time, so it costs nothing to enforce.
const CODEAGENT_PLAN_APP_LIMITS = { pro: 1, max: 5 };

// Admin emails bypass all limits — no app cap, no edit gate, unlimited builds.
function isAdminEmail(email) {
  const admins = String(process.env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  return admins.includes(String(email || "").toLowerCase());
}

// data:image/<type>;base64,<data> -> ["png","jpeg","svg+xml","webp"] plus
// the actual payload. Anything else (a non-image mime, no base64 marker,
// malformed) is rejected rather than guessed at.
const LOGO_MIME_RE = /^data:image\/(png|jpeg|jpg|svg\+xml|webp);base64,([a-z0-9+/=]+)$/i;
const LOGO_EXT = { png: "png", jpeg: "jpg", jpg: "jpg", "svg+xml": "svg", webp: "webp" };

/**
 * Writes an uploaded logo into a FRESH sandbox before the model's first
 * turn, and returns the sentence to append to its prompt — or "" if there
 * was nothing valid to attach. Called only for !project (a follow-up has
 * no fresh sandbox to seed and no reason to re-attach an asset that's
 * already sitting in the project's files from the first build).
 *
 * The write goes through runtime.writeBinaryFile DIRECTLY, not through
 * tools.write_file — that one asserts a string and treats it as utf8,
 * which would corrupt binary image bytes. Same "server writes raw bytes,
 * the model's own tool surface never does" boundary as readDist.
 */
async function attachLogoIfPresent(req, tools, runtime, ws) {
  const logo = req.body && req.body.logo;
  if (!logo || typeof logo.dataUrl !== "string") return "";

  const m = LOGO_MIME_RE.exec(logo.dataUrl);
  if (!m) return "";

  const base64 = m[2];
  // Decoded size, not the base64 string's length (~33% larger) — matches
  // what actually lands on disk and what the client-side 2MB check means.
  if (Buffer.byteLength(base64, "base64") > 3 * 1024 * 1024) return "";

  const ext = LOGO_EXT[m[1].toLowerCase()] || "png";
  const relPath = "src/assets/logo." + ext;
  if (typeof runtime.writeBinaryFile !== "function") return "";

  try {
    await runtime.writeBinaryFile(ws, relPath, base64);
  } catch (e) {
    return ""; // a failed upload isn't worth failing the whole build over
  }

  return " An image has already been uploaded and saved at " + relPath +
    " — import and use it as the site's logo/brand mark (e.g. in the header) instead of inventing a placeholder.";
}

/* -----------------------------------------------------------------
   Account endpoints backing public/settings.html.
   Every one of these is session-gated via codeAgentSessionUser(): a
   settings page that let an anonymous cookie read a plan or delete an
   account would be a much worse bug than the pages it configures.
   ----------------------------------------------------------------- */

/** GET /api/account/me — who is signed in, and on what plan. */
app.get("/api/account/me", async (req, res, next) => {
  try {
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.json({ signedIn: false });

    let plan = "free", company = "";
    const masterDb = getMasterDb();
    if (masterDb && sessionUser.wsId) {
      const ws = await masterDb.collection("workspaces").findOne({ id: sessionUser.wsId }, { projection: { plan: 1, company: 1 } });
      if (ws) { plan = ws.plan || "free"; company = ws.company || ""; }
    }

    /* appOwnerOf, not anon.ownerOf — and the difference is the whole bug.
       A build RECORDS its spend under appOwnerOf, which fills in userId
       from the session cookie. anon.ownerOf is deliberately
       Authorization-header-only (project-test.js depends on a stray
       session cookie not counting as ownership proof), so for a
       cookie-signed-in person it returned the anon id instead.

       Spend was therefore written under u:<userId> and read back under
       a:<anonId>, and the two never met: the usage card read 0% for
       everyone signed in, no matter how much they had built. This is a
       read of your own usage with your own session, not an ownership
       decision, so the cookie-aware identity is the correct one here. */
    const owner = appOwnerOf(req, res);
    const spentUsd = await codeAgentUsage.monthSpend(owner);
    // The window belongs here too. The rail reads this endpoint once and
    // draws the whole usage card from it; making it fetch a second URL for
    // the half of the limit that resets soonest is how the two numbers end
    // up disagreeing on screen.
    const win = await codeAgentUsage.windowSpend(owner, CODEAGENT_WINDOW_HOURS);
    res.json({
      windowUsd: win.usd,
      windowBudgetUsd: CODEAGENT_PLAN_WINDOW_USD[plan] || CODEAGENT_PLAN_WINDOW_USD.free,
      windowHours: CODEAGENT_WINDOW_HOURS,
      windowResetAt: win.resetAt,
      signedIn: true, email: sessionUser.email, name: sessionUser.name,
      wsId: sessionUser.wsId, accountId: sessionUser.id, company: company,
      plan: plan, spentUsd: spentUsd,
      budgetUsd: CODEAGENT_PLAN_BUDGET_USD[plan] || CODEAGENT_PLAN_BUDGET_USD.free,
      promptChars: CODEAGENT_PLAN_PROMPT_CHARS[plan] || CODEAGENT_PLAN_PROMPT_CHARS.free,
      freeEdits: CODEAGENT_FREE_EDITS
    });
  } catch (e) { next(e); }
});

/**
 * POST /api/account/sessions/revoke — "sign out other sessions".
 *
 * Sessions here are stateless JWTs, so there is no session table to delete
 * rows from; the only honest way to invalidate tokens already issued is to
 * make them fail verification. Bumping a per-user `sessionEpoch` and
 * checking it at verify time does that: every token minted before the bump
 * carries a stale epoch and is rejected, while THIS request gets a freshly
 * minted cookie so the caller stays signed in — which is exactly the
 * "other sessions" semantics.
 */
app.post("/api/account/sessions/revoke", async (req, res, next) => {
  try {
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.status(401).json({ error: "not signed in" });

    const ws = await resolveWsContext(sessionUser.wsId);
    const epoch = Date.now();
    const updated = await dbAdapter.updateOne(ws, "users", sessionUser.id, { sessionEpoch: epoch });
    if (!updated) return res.status(404).json({ error: "account not found" });

    /* Mirrored into the master database, which is what the per-request
       check reads — see liveSessionEpoch. Written AFTER the user row and
       before the new cookie goes out, so the window where a revoked token
       still works is the width of one await rather than anything a person
       could use. If this write fails the revoke fails with it: reporting
       success for a sign-out that did not take is the whole bug this
       feature was found to have. */
    const master = getMasterDb();
    if (!master) return res.status(503).json({ error: "cannot sign other sessions out right now — try again in a moment" });
    await master.collection(REVOCATIONS).updateOne(
      { _id: sessionUser.id },
      { $set: { epoch: epoch, at: new Date(), wsId: sessionUser.wsId || null } },
      { upsert: true }
    );

    const session = {
      id: sessionUser.id, name: sessionUser.name, email: sessionUser.email,
      role: sessionUser.role, dept: sessionUser.dept, wsId: sessionUser.wsId, sessionEpoch: epoch
    };
    const token = jwt.sign(session, JWT_SECRET, { expiresIn: "12h" });
    res.cookie("sq_session", token, {
      httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
      maxAge: 12 * 3600 * 1000, path: "/"
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/**
 * DELETE /api/account — the Danger Zone.
 * Deletes the user's projects (with their turns and revisions), the user
 * record, and the workspace, then clears the cookie. Requires the account's
 * own password in the body: a destructive, irreversible action gated only
 * by an existing cookie is one stolen laptop away from being permanent.
 */
app.delete("/api/account", async (req, res, next) => {
  try {
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.status(401).json({ error: "not signed in" });
    const password = String((req.body && req.body.password) || "");
    if (!password) return res.status(400).json({ error: "your password is required to delete this account" });

    const ws = await resolveWsContext(sessionUser.wsId);
    const users = await dbAdapter.findAll(ws, "users");
    const user = users.find((u) => u.id === sessionUser.id);
    if (!user) return res.status(404).json({ error: "account not found" });

    const stored = String(user.password || "");
    const ok = stored.startsWith("$2") ? await bcrypt.compare(password, stored) : false;
    if (!ok) return res.status(401).json({ error: "that password doesn't match" });

    /* WHOSE projects — from the VERIFIED session, not anon.ownerOf.

       anon.ownerOf reads the user only from an Authorization header, and
       no page in this app sends one. So this listed by anon id alone:
       projects built on another device were not matched and survived the
       deletion, and for anyone with no sq_anon cookie at all — a fresh
       browser, or one whose 30-day anon grant had lapsed — the filter
       matched nothing and NONE of their projects were removed. Measured:
       an account deleted this way left both of its projects behind.

       The session is already verified above, so its id is the right
       answer. The anon id stays in the owner alongside it, because
       anything built before they signed up is theirs too. */
    const owner = { userId: sessionUser.id, anonId: anon.anonIdOf(req) };

    /* Until there are none left. list() is capped, and one capped pass is
       a deletion that silently stops at the cap. */
    for (let pass = 0; pass < 40; pass++) {
      const batch = await projects.list(owner, 200);
      if (!batch.length) break;
      for (const p of batch) await projects.remove(p.id);
    }

    /* The account's OWN DATABASE, which this did not touch.

       Deleting the user row and the workspace record left the tenant
       database — clients, orders, invoices, audit, all of it — sitting
       there with nothing pointing at it. DELETE /api/ws/:id, the other
       way out of this product, has always purged it. "Delete my account"
       has to mean the same thing, or it is not deletion. */
    const masterDb = getMasterDb();
    if (masterDb && sessionUser.wsId) {
      /* Written BEFORE the purge and to the MASTER audit, which is not in
         the database being erased — an audit of a deletion has to outlive
         the deletion. Same shape the workspace-erasure route uses. */
      try {
        await writeMasterAudit(masterDb, {
          requestId: req.id, actor: sessionUser.email, wsId: sessionUser.wsId,
          action: "account.delete", entityId: sessionUser.id,
          summary: "Account deleted by its owner"
        });
      } catch (e) { /* an audit must never block the erasure it describes */ }
    }

    await dbAdapter.deleteOne(ws, "users", sessionUser.id);
    try { await dbAdapter.purgeWorkspace(ws); } catch (e) { /* best effort; the records below still go */ }
    if (masterDb && sessionUser.wsId) await masterDb.collection("workspaces").deleteOne({ id: sessionUser.wsId });

    res.clearCookie("sq_session", { path: "/" });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** DELETE /api/codeagent/history — clears this owner's builds. Scoped by
    projects.list(owner), so it can only ever reach the caller's own rows. */
app.delete("/api/codeagent/history", async (req, res, next) => {
  try {
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.status(401).json({ error: "not signed in" });
    const owner = appOwnerOf(req, res);
    const mine = (await projects.list(owner, 500)).filter((p) => (p.meta || {}).kind === "code");
    for (const p of mine) await projects.remove(p.id);
    res.json({ ok: true, deleted: mine.length });
  } catch (e) { next(e); }
});

/**
 * GET /api/codeagent/export
 * Bulk-exports every Souqi Code app this owner has built as one ZIP, one
 * folder per project (named by slug) holding its current source files —
 * same per-project archiver pattern /api/codeagent/:key/export-android
 * uses above, just walking every project instead of one already-published
 * one. Requires sign-in (same reasoning as /api/codeagent/history: this
 * is account-level, not something an anonymous cookie-only visitor should
 * trigger) even though projects.list(owner) would already scope it
 * correctly either way.
 */
app.get("/api/codeagent/export", async (req, res, next) => {
  try {
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.status(401).json({ error: "not signed in" });
    const owner = appOwnerOf(req, res);
    const mine = (await projects.list(owner, 500)).filter((p) => (p.meta || {}).kind === "code");
    if (!mine.length) return res.status(404).json({ error: "nothing built yet" });

    const archiver = require("archiver");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="souqi-code-export.zip"');
    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", (e) => { try { res.status(500); } catch (e2) {} res.end(); });
    archive.pipe(res);

    for (const p of mine) {
      const revision = await projects.head(p.id);
      const files = (revision && revision.config && revision.config.files) || {};
      const folder = (p.slug || p.id).replace(/[^a-z0-9-]/gi, "").slice(0, 60) || p.id;
      for (const [path, content] of Object.entries(files)) {
        archive.append(String(content), { name: folder + "/" + path });
      }
      archive.append(JSON.stringify({ title: p.title, slug: p.slug, buildType: (p.meta || {}).buildType, updatedAt: p.updatedAt }, null, 2), { name: folder + "/project.json" });
    }
    await archive.finalize();
  } catch (e) { next(e); }
});

/**
 * PATCH /api/account/workspace
 * Renames the signed-in user's workspace (the "company" field on their
 * masterDb workspace record — the same one /api/account/me already reads
 * back as `company`). Separate from the unauthenticated /api/ws upsert
 * above, which is signup-time provisioning with its own takeover guard —
 * this is the ordinary authenticated "rename my workspace" action a
 * signed-in owner performs from Settings.
 */
app.patch("/api/account/workspace", async (req, res, next) => {
  try {
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.status(401).json({ error: "not signed in" });
    if (!sessionUser.wsId) return res.status(400).json({ error: "no workspace on this account" });
    const name = String((req.body && req.body.company) || "").trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: "a workspace name is required" });

    const masterDb = getMasterDb();
    if (!masterDb) return res.status(503).json({ error: "Master DB not available" });
    const result = await masterDb.collection("workspaces").updateOne({ id: sessionUser.wsId }, { $set: { company: name } });
    if (!result.matchedCount) return res.status(404).json({ error: "workspace not found" });
    res.json({ ok: true, company: name });
  } catch (e) { next(e); }
});

/* -----------------------------------------------------------------
   BRING-YOUR-OWN-KEY model providers
   -----------------------------------------------------------------
   A user pastes their own Anthropic/Gemini/OpenAI/DeepSeek key and
   their builds run on it instead of Souqi's models. Three rules hold
   across all four endpoints below and are the reason they are not
   simply a field on PATCH /api/account/workspace:

     1. SIGNED-IN ONLY. An anon cookie is not an identity — storing a
        real API key against one means the next person to get that
        cookie inherits the key, and the owner has no way to revoke it.
     2. THE KEY NEVER COMES BACK OUT. GET returns the provider, the
        model, and the last four characters. There is no endpoint that
        returns a stored key, for the user or for anyone else: a
        read-back route is a credential exfiltration primitive one XSS
        away from being used, and nothing in the product needs it.
     3. ENCRYPTED AT REST via lib/crypto.js, same envelope as tenant
        connection strings, so a dump of the collection is not a pile
        of live third-party credentials.
   ----------------------------------------------------------------- */

/** The catalogue the picker renders. Public — it contains no secrets. */
app.get("/api/ai/providers", (req, res) => {
  res.json({ providers: aiProviders.publicList() });
});

/** Which providers this account has a key for. Never returns a key. */
app.get("/api/account/ai-keys", async (req, res, next) => {
  try {
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.json({ signedIn: false, keys: [] });
    const stored = await readAiKeys(sessionUser);
    res.json({
      signedIn: true,
      keys: Object.keys(stored).map((id) => ({
        provider: id, model: stored[id].model || null, masked: stored[id].masked || "••••",
        addedAt: stored[id].addedAt || null
      }))
    });
  } catch (e) { next(e); }
});

/** Save (or replace) the key for one provider. */
app.post("/api/account/ai-keys", async (req, res, next) => {
  try {
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.status(401).json({ error: "Sign in to use your own API key." });

    const providerId = String((req.body && req.body.provider) || "").toLowerCase();
    const provider = aiProviders.get(providerId);
    if (!provider || !provider.byok) return res.status(400).json({ error: "unknown model provider" });

    const check = aiProviders.validateKey(providerId, req.body && req.body.apiKey);
    if (!check.ok) return res.status(400).json({ error: check.reason });

    // Refuse rather than store in the clear. lib/crypto.js is deliberately
    // pass-through when DB_ENCRYPTION_KEY is unset — a documented dev
    // convenience for tenant DB strings, which are Souqi's own secrets in
    // Souqi's own database. A user's third-party API key is not: storing it
    // as plaintext is a breach of what the picker promises ("encrypted"),
    // and it is a live billable credential belonging to someone else. An
    // operator who has not configured encryption gets an actionable error;
    // the user is not silently exposed to a deployment mistake.
    if (!process.env.DB_ENCRYPTION_KEY) {
      return res.status(503).json({
        error: "This server cannot store API keys securely yet (DB_ENCRYPTION_KEY is not configured). Use Souqi Default, or ask the operator to set it."
      });
    }

    const model = String((req.body && req.body.model) || "").trim().slice(0, 80) || provider.defaultModel;

    const ws = await resolveWsContext(sessionUser.wsId);
    const existing = await readAiKeys(sessionUser);
    existing[providerId] = {
      key: encryptSecret(check.key),
      model: model,
      masked: aiProviders.maskKey(check.key),
      addedAt: new Date().toISOString()
    };
    await dbAdapter.updateOne(ws, "users", sessionUser.id, { aiKeys: existing });

    try {
      const masterDbForAudit = getMasterDb();
      if (masterDbForAudit) {
        await writeMasterAudit(masterDbForAudit, {
          requestId: req.id, actor: sessionUser.id, action: "account.aiKey.set",
          entityId: sessionUser.id, summary: "Saved a " + provider.label + " API key",
          meta: { provider: providerId, model: model }
        });
      }
    } catch (e) { /* audit must never fail the write it describes */ }

    res.json({ ok: true, provider: providerId, model: model, masked: aiProviders.maskKey(check.key) });
  } catch (e) { next(e); }
});

/** Forget the key for one provider. */
app.delete("/api/account/ai-keys/:provider", async (req, res, next) => {
  try {
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.status(401).json({ error: "not signed in" });
    const providerId = String(req.params.provider || "").toLowerCase();
    if (!aiProviders.isValidId(providerId)) return res.status(400).json({ error: "unknown model provider" });

    const ws = await resolveWsContext(sessionUser.wsId);
    const existing = await readAiKeys(sessionUser);
    delete existing[providerId];
    await dbAdapter.updateOne(ws, "users", sessionUser.id, { aiKeys: existing });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* =================================================================
   STRIPE CONNECT — payments inside a generated app
   -----------------------------------------------------------------
   The owner connects THEIR Stripe account; charges are created on it
   directly and the money is theirs. Souqi stores an account id, never
   a secret key. See lib/stripe.js for why that distinction is the
   whole design.

   Three surfaces, with deliberately different auth:
     • /api/integrations/stripe/*  — the OWNER, signed in. Connect,
       check status, disconnect.
     • /api/apps/:projectId/checkout — PUBLIC. A shopper in a
       generated app has no Souqi session and never will. This is the
       endpoint that must not be abusable; see its own note.
     • /api/stripe/webhook — STRIPE, authenticated by signature over
       the raw body, not by session.
   ================================================================= */

/** Signed, short-lived, session-bound OAuth state — the CSRF guard.
 *
 *  Without this an attacker can hand a victim a callback URL carrying the
 *  ATTACKER's authorization code. The victim's browser completes the flow and
 *  the attacker's Stripe account gets attached to the victim's project —
 *  quietly redirecting that project's revenue. The state is an HMAC over the
 *  user id, so a code that comes back with someone else's state is rejected.
 */
function signStripeState(userId) {
  const nonce = crypto.randomBytes(12).toString("hex");
  const exp = Date.now() + 10 * 60 * 1000;
  const payload = userId + "." + nonce + "." + exp;
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(payload).digest("hex").slice(0, 32);
  return Buffer.from(payload + "." + sig, "utf8").toString("base64url");
}
function verifyStripeState(state, userId) {
  try {
    const raw = Buffer.from(String(state || ""), "base64url").toString("utf8");
    const parts = raw.split(".");
    if (parts.length !== 4) return false;
    const [uid, nonce, exp, sig] = parts;
    if (uid !== userId) return false;
    if (!(Number(exp) > Date.now())) return false;
    const expected = crypto.createHmac("sha256", JWT_SECRET).update(uid + "." + nonce + "." + exp).digest("hex").slice(0, 32);
    const a = Buffer.from(sig, "utf8"), b = Buffer.from(expected, "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

function stripeRedirectUri(req) {
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "")
    || (req.protocol + "://" + req.get("host"));
  return base + "/api/integrations/stripe/callback";
}

/** Is this account connected, and to what. Never returns anything secret. */
app.get("/api/integrations/stripe", async (req, res, next) => {
  try {
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.status(401).json({ error: "not signed in" });
    if (!stripeLib.isConfigured()) {
      return res.json({ configured: false, connected: false, reason: "Stripe is not configured on this server" });
    }
    const ws = await resolveWsContext(sessionUser.wsId);
    const user = await dbAdapter.findOne(ws, "users", sessionUser.id);
    const acct = (user && user.stripeAccount) || null;
    res.json({
      configured: true,
      connected: !!(acct && acct.accountId),
      accountId: acct ? acct.accountId : null,
      livemode: acct ? !!acct.livemode : stripeLib.livemode(),
      connectedAt: acct ? acct.connectedAt : null
    });
  } catch (e) { next(e); }
});

/** Start the OAuth handshake. */
app.get("/api/integrations/stripe/connect", async (req, res, next) => {
  try {
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.status(401).json({ error: "not signed in" });
    if (!stripeLib.isConfigured()) {
      return res.status(503).json({ error: "Stripe is not configured on this server (STRIPE_CLIENT_ID / STRIPE_SECRET_KEY)" });
    }
    const url = stripeLib.authorizeUrl(signStripeState(sessionUser.id), stripeRedirectUri(req));
    res.redirect(url);
  } catch (e) { next(e); }
});

/** Finish it: swap the code for an account id and remember only that. */
app.get("/api/integrations/stripe/callback", async (req, res, next) => {
  try {
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.status(401).send("Sign in to Souqi, then connect Stripe again.");

    if (req.query.error) {
      return res.redirect("/settings#integrations?stripe=" + encodeURIComponent(String(req.query.error_description || req.query.error).slice(0, 120)));
    }
    if (!verifyStripeState(req.query.state, sessionUser.id)) {
      return res.status(400).send("That Stripe connection link was not valid or has expired. Start again from Settings.");
    }

    const out = await stripeLib.exchangeCode(req.query.code);
    if (!out.ok) {
      return res.redirect("/settings#integrations?stripe=" + encodeURIComponent(String(out.reason).slice(0, 120)));
    }

    const ws = await resolveWsContext(sessionUser.wsId);
    await dbAdapter.updateOne(ws, "users", sessionUser.id, {
      stripeAccount: { accountId: out.accountId, livemode: !!out.livemode, connectedAt: new Date().toISOString() }
    });

    try {
      const masterDbForAudit = getMasterDb();
      if (masterDbForAudit) {
        await writeMasterAudit(masterDbForAudit, {
          requestId: req.id, actor: sessionUser.id, action: "account.stripe.connect",
          entityId: sessionUser.id, summary: "Connected a Stripe account",
          meta: { accountId: out.accountId, livemode: !!out.livemode }
        });
      }
    } catch (e) { /* audit must never fail the write it describes */ }

    res.redirect("/settings#integrations?stripe=connected");
  } catch (e) { next(e); }
});

/** Disconnect. */
app.delete("/api/integrations/stripe", async (req, res, next) => {
  try {
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.status(401).json({ error: "not signed in" });
    const ws = await resolveWsContext(sessionUser.wsId);
    const user = await dbAdapter.findOne(ws, "users", sessionUser.id);
    const acct = (user && user.stripeAccount) || null;

    // Revoke at Stripe if we can, but forget locally regardless. If Stripe is
    // down (or the grant is already gone), refusing to disconnect would leave
    // the owner stuck connected to an account they are trying to remove.
    if (acct && acct.accountId && stripeLib.isConfigured()) {
      try { await stripeLib.deauthorize(acct.accountId); } catch (e) { /* best effort */ }
    }
    await dbAdapter.updateOne(ws, "users", sessionUser.id, { stripeAccount: null });

    try {
      const masterDbForAudit = getMasterDb();
      if (masterDbForAudit) {
        await writeMasterAudit(masterDbForAudit, {
          requestId: req.id, actor: sessionUser.id, action: "account.stripe.disconnect",
          entityId: sessionUser.id, summary: "Disconnected the Stripe account", meta: {}
        });
      }
    } catch (e) { /* ignore */ }

    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* =====================================================================
   BILLING — Souqi's own subscriptions.

   The Connect routes above sell things for OTHER people. These sell
   Souqi, and the money lands on Souqi's account, so nothing here carries
   a connected-account id.

   The card is collected by Stripe Elements inside /checkout, which means
   the card number never reaches this server and PCI scope stays at SAQ-A.
   What the browser sends is a plan name and an interval; what it gets
   back is a client secret for one PaymentIntent. It never sends an
   amount, and it is never trusted about a price: /checkout used to do its
   own arithmetic on a hardcoded 20 USD and a hardcoded exchange rate,
   which is fine for a mockup and indefensible the moment a real card is
   involved. Every figure below comes from Stripe.
   ===================================================================== */

/* A subscribe creates real objects on Souqi's Stripe account, so it is not
   somewhere to allow unlimited retries — a loop here fills the dashboard
   with incomplete subscriptions. The reads are cheap and cached, so only
   the writing routes are limited. */
const billingLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  key: (req) => (req.ip || "") + ":billing"
});

/* Prices change about once a year and the checkout page asks for all of
   them on every load, so they are cached rather than fetched per request.
   Five minutes is short enough that a price edit in the dashboard shows up
   while someone is still looking at the tab it was wrong in. */
const PRICE_TTL_MS = 5 * 60 * 1000;
const priceCache = new Map();

async function cachedPrice(priceId) {
  if (!priceId) return null;
  const hit = priceCache.get(priceId);
  if (hit && hit.until > Date.now()) return hit.price;
  const got = await stripeLib.getPrice(priceId);
  if (!got.ok) {
    // A price id that Stripe will not return is a configuration error, and
    // the honest answer is to omit that option from the catalogue rather
    // than show a button that cannot charge.
    console.warn("[billing] could not read price " + priceId + ": " + got.reason);
    return null;
  }
  priceCache.set(priceId, { price: got, until: Date.now() + PRICE_TTL_MS });
  return got;
}

/** Plan already lives on the workspace row, so billing state joins it there. */
async function readWorkspaceBilling(wsId) {
  const db = getMasterDb();
  if (!db || !wsId) return null;
  try {
    return await db.collection("workspaces").findOne(
      { id: wsId }, { projection: { plan: 1, billing: 1, company: 1 } });
  } catch (e) { return null; }
}

/**
 * Write one subscription's outcome onto its workspace.
 *
 * The delicate part is the downgrade. A subscription is born `incomplete`
 * — that is what default_incomplete means — so treating "not entitled" as
 * "set plan to free" would knock a paying customer down to free the
 * instant they clicked Subscribe on a bigger plan, and leave them there
 * until the card cleared. So an un-entitled subscription only clears the
 * plan when it is the one the workspace is actually relying on; a brand
 * new incomplete one writes the pointer and leaves the plan alone.
 *
 * Returns the plan the workspace ended up on.
 */
async function applySubscription(wsId, sub, soldPlan, req, actor) {
  const db = getMasterDb();
  if (!db || !wsId || !sub || !sub.id) return null;

  const plan = String(soldPlan || (sub.metadata && sub.metadata.souqiPlan) || "");
  const entitlement = stripeLib.entitlementForStatus(sub.status, plan);
  // An entitlement the rest of the server has no limits for is a config
  // mistake. Granting it anyway would silently hand out a plan that every
  // gate then reads as free — better to refuse it here, loudly.
  const granted = entitlement && PLANS.includes(entitlement) ? entitlement : null;
  if (entitlement && !granted) {
    console.warn("[billing] plan '" + plan + "' maps to entitlement '" + entitlement +
      "', which is not one of: " + PLANS.join(", "));
  }

  const existing = await readWorkspaceBilling(wsId);
  const wasRelyingOnThis = !!(existing && existing.billing && existing.billing.subscriptionId === sub.id);

  const billing = {
    customerId: sub.customerId || (existing && existing.billing && existing.billing.customerId) || null,
    subscriptionId: sub.id,
    status: sub.status || null,
    soldPlan: plan || null,
    priceId: sub.priceId || null,
    currentPeriodEnd: sub.currentPeriodEnd || null,
    cancelAtPeriodEnd: !!sub.cancelAtPeriodEnd,
    updatedAt: new Date().toISOString()
  };

  const set = { billing: billing };
  let nextPlan = existing ? (existing.plan || "free") : "free";
  if (granted) {
    nextPlan = granted;
    set.plan = granted;
  } else if (wasRelyingOnThis) {
    nextPlan = "free";
    set.plan = "free";
  }

  try {
    await db.collection("workspaces").updateOne({ id: wsId }, { $set: set });
  } catch (e) {
    console.warn("[billing] could not write billing state for " + wsId + ": " + e.message);
    return null;
  }

  // Only worth an audit line when the plan actually moved — a webhook for
  // a renewal fires monthly and says nothing new.
  if (set.plan && (!existing || existing.plan !== set.plan)) {
    try {
      await writeMasterAudit(db, {
        requestId: req && req.id, actor: actor || "stripe", wsId: wsId,
        action: "billing.plan.change", entityId: wsId,
        summary: "Plan set to " + set.plan + " (" + (plan || "unknown") + ", " + sub.status + ")",
        meta: {
          subscriptionId: sub.id, status: sub.status, soldPlan: plan || null,
          from: existing ? existing.plan || "free" : null, to: set.plan
        }
      });
    } catch (e) { /* an audit line is not worth failing a payment over */ }
  }
  return nextPlan;
}

/**
 * GET /api/billing/config — everything /checkout needs to render honestly.
 *
 * Publishable key, the sold plans, and each plan's REAL amount straight
 * from the Price object. No price ids: a page that knew them could ask to
 * be charged for a different one.
 */
app.get("/api/billing/config", async (req, res, next) => {
  try {
    if (!stripeLib.isBillingConfigured()) {
      return res.json({
        configured: false,
        reason: "subscriptions are not configured on this server (STRIPE_SECRET_KEY / STRIPE_PUBLISHABLE_KEY / STRIPE_BILLING_PLANS)"
      });
    }
    const sessionUser = await codeAgentSessionUserVerified(req);
    const catalogue = stripeLib.planCatalogue();
    const plans = {};

    for (const id of Object.keys(catalogue)) {
      const entry = { id: id, label: catalogue[id].label, prices: {} };
      const intervals = catalogue[id].intervals || {};
      for (const interval of Object.keys(intervals)) {
        for (const currency of intervals[interval]) {
          const price = await cachedPrice(stripeLib.priceIdFor(id, interval, currency));
          if (!price) continue;
          entry.prices[interval] = entry.prices[interval] || {};
          entry.prices[interval][currency] = {
            amountMinor: price.amountMinor,
            currency: price.currency,
            interval: price.interval,
            intervalCount: price.intervalCount
          };
        }
      }
      // A plan with no readable price is not offerable, so it is not offered.
      if (Object.keys(entry.prices).length) plans[id] = entry;
    }

    const ws = sessionUser ? await readWorkspaceBilling(sessionUser.wsId) : null;
    res.json({
      configured: Object.keys(plans).length > 0,
      publishableKey: stripeLib.publishableKey(),
      plans: plans,
      signedIn: !!sessionUser,
      email: sessionUser ? sessionUser.email : null,
      currentPlan: ws ? ws.plan || "free" : "free",
      subscriptionStatus: ws && ws.billing ? ws.billing.status || null : null
    });
  } catch (e) { next(e); }
});

/**
 * POST /api/billing/promo — is this code real, and what does it take off.
 *
 * Only ever a PREVIEW. The discount that is actually applied is applied by
 * Stripe when the subscription is created, from the same code; this exists
 * so the order summary can show a true figure before submit instead of the
 * flat 10% off anything that /checkout used to draw.
 */
app.post("/api/billing/promo", billingLimiter, jsonDefault, async (req, res, next) => {
  try {
    if (!stripeLib.isBillingConfigured()) return res.status(503).json({ error: "subscriptions are not configured on this server" });
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.status(401).json({ error: "not signed in" });

    const promo = await stripeLib.lookupPromotionCode((req.body && req.body.code) || "");
    if (!promo.ok) {
      // A wrong code is the shopper's normal case, not a server fault.
      if (promo.notFound) return res.status(404).json({ error: promo.reason });
      return res.status(502).json({ error: promo.reason });
    }
    res.json({
      ok: true, code: promo.code,
      percentOff: promo.percentOff, amountOffMinor: promo.amountOffMinor,
      currency: promo.currency
    });
  } catch (e) { next(e); }
});

/**
 * POST /api/billing/subscribe — create the subscription, hand back one
 * client secret for the page to confirm the card against.
 *
 * Signed in is mandatory: a subscription with no account to attach it to
 * would take money and entitle nobody.
 */
app.post("/api/billing/subscribe", billingLimiter, jsonDefault, async (req, res, next) => {
  try {
    if (!stripeLib.isBillingConfigured()) return res.status(503).json({ error: "subscriptions are not configured on this server" });
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.status(401).json({ error: "not signed in" });
    if (!sessionUser.wsId) return res.status(409).json({ error: "this account has no workspace to put a plan on" });

    const body = req.body || {};
    const plan = String(body.plan || "").toLowerCase();
    const interval = String(body.interval || "month").toLowerCase();
    const currency = String(body.currency || "usd").toLowerCase();

    // The price id is resolved HERE, from server config. This is the line
    // that stops a crafted request buying the top plan at the bottom price.
    const priceId = stripeLib.priceIdFor(plan, interval, currency);
    if (!priceId) return res.status(400).json({ error: "that plan, interval or currency is not for sale" });

    const entitlement = stripeLib.entitlementFor(plan);
    if (!entitlement || !PLANS.includes(entitlement)) {
      return res.status(500).json({ error: "that plan is misconfigured on this server" });
    }

    const ws = await readWorkspaceBilling(sessionUser.wsId);
    const customer = await stripeLib.findOrCreateCustomer({
      existingId: ws && ws.billing ? ws.billing.customerId : null,
      email: sessionUser.email,
      name: (ws && ws.company) || sessionUser.name || undefined,
      metadata: { souqiWsId: String(sessionUser.wsId), souqiUserId: String(sessionUser.id) }
    });
    if (!customer.ok) return res.status(502).json({ error: customer.reason });

    let promotionCodeId = null;
    if (body.promoCode) {
      const promo = await stripeLib.lookupPromotionCode(body.promoCode);
      if (!promo.ok) {
        if (promo.notFound) return res.status(400).json({ error: promo.reason });
        return res.status(502).json({ error: promo.reason });
      }
      promotionCodeId = promo.id;
    }

    const made = await stripeLib.createSubscription({
      customerId: customer.id,
      priceId: priceId,
      promotionCodeId: promotionCodeId,
      // The webhook has no session to ask, so everything it needs to find
      // the workspace again rides along on the subscription itself.
      metadata: {
        souqiWsId: String(sessionUser.wsId),
        souqiUserId: String(sessionUser.id),
        souqiPlan: plan,
        souqiEntitlement: entitlement
      },
      // Stripe replays an idempotency key's first response, so a double
      // click gets one subscription rather than two.
      idempotencyKey: req.get("Idempotency-Key") || undefined
    });
    if (!made.ok) return res.status(502).json({ error: made.reason });

    const sub = made.subscription;
    await applySubscription(sessionUser.wsId, sub, plan, req, sessionUser.id);

    const alreadyPaid = sub.status === "active" || sub.status === "trialing";
    if (!sub.clientSecret && !alreadyPaid) {
      return res.status(502).json({ error: "Stripe created the subscription but returned no payment to confirm" });
    }

    res.json({
      ok: true,
      subscriptionId: sub.id,
      status: sub.status,
      // Null when a 100%-off code or a trial means there is nothing to pay
      // today. The page treats that as done rather than as an error.
      clientSecret: sub.clientSecret,
      invoice: sub.invoice
    });
  } catch (e) { next(e); }
});

/**
 * POST /api/billing/sync — read this account's subscription back from
 * Stripe and apply whatever it says.
 *
 * The browser learns the card cleared before the webhook does, so without
 * this the success page would have to either lie or poll. The webhook is
 * still the authority for everything afterwards — renewals, failures,
 * cancellations — this only closes the gap on the first payment.
 */
app.post("/api/billing/sync", billingLimiter, jsonDefault, async (req, res, next) => {
  try {
    if (!stripeLib.isBillingConfigured()) return res.status(503).json({ error: "subscriptions are not configured on this server" });
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.status(401).json({ error: "not signed in" });

    const ws = await readWorkspaceBilling(sessionUser.wsId);
    const subId = ws && ws.billing ? ws.billing.subscriptionId : null;
    if (!subId) return res.json({ ok: true, plan: ws ? ws.plan || "free" : "free", status: null });

    const got = await stripeLib.getSubscription(subId);
    if (!got.ok) return res.status(502).json({ error: got.reason });

    // Read back from Stripe, never from the request: a body that could say
    // "I am on Pro now" would be a free upgrade button.
    const sub = got.subscription;
    const plan = await applySubscription(sessionUser.wsId, sub, sub.metadata && sub.metadata.souqiPlan, req, sessionUser.id);
    res.json({ ok: true, plan: plan || "free", status: sub.status, currentPeriodEnd: sub.currentPeriodEnd });
  } catch (e) { next(e); }
});

/* =====================================================================
   GITHUB — the generated app, in a repository the person actually owns.

   Same split of surfaces as Stripe above, and the same principle: the
   account belongs to the OWNER. Souqi holds a token, creates a repo in
   their name, and writes a commit. Disconnecting forgets the token and
   revokes the grant; it never touches a repository, because by then the
   code is theirs and deleting someone's repo to tidy up our own state
   would be indefensible.

   The token is a live third-party credential, so it follows the rule
   /api/account/ai-keys already set: encrypted at rest or refused, never
   stored in the clear because an operator forgot to configure a key.
   ===================================================================== */

/* Bound to the provider as well as to the user. The Stripe pair above
   does the same job for Stripe and is deliberately not shared: a state
   minted for one provider must not validate for the other. They are
   different endpoints exchanging different codes, and a CSRF guard that
   cannot tell them apart is a guard with a hole in it. */
function signGithubState(userId) {
  const nonce = crypto.randomBytes(12).toString("hex");
  const exp = Date.now() + 10 * 60 * 1000;
  const payload = "github." + userId + "." + nonce + "." + exp;
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(payload).digest("hex").slice(0, 32);
  return Buffer.from(payload + "." + sig, "utf8").toString("base64url");
}
function verifyGithubState(state, userId) {
  try {
    const raw = Buffer.from(String(state || ""), "base64url").toString("utf8");
    const parts = raw.split(".");
    if (parts.length !== 5) return false;
    const [tag, uid, nonce, exp, sig] = parts;
    if (tag !== "github" || uid !== userId) return false;
    if (!(Number(exp) > Date.now())) return false;
    const expected = crypto.createHmac("sha256", JWT_SECRET)
      .update(tag + "." + uid + "." + nonce + "." + exp).digest("hex").slice(0, 32);
    const a = Buffer.from(sig, "utf8"), b = Buffer.from(expected, "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

function githubRedirectUri(req) {
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "")
    || (req.protocol + "://" + req.get("host"));
  return base + "/api/integrations/github/callback";
}

/** The stored token, decrypted, plus the account it belongs to. */
async function githubCredsFor(sessionUser) {
  const ws = await resolveWsContext(sessionUser.wsId);
  const user = await dbAdapter.findOne(ws, "users", sessionUser.id);
  const g = (user && user.githubAccount) || null;
  if (!g || !g.token) return null;
  let token = null;
  try { token = decryptSecret(g.token); } catch (e) { token = null; }
  return token ? { token: token, account: g, ws: ws } : null;
}

/** Is this account connected, and to whom. Never returns the token. */
app.get("/api/integrations/github", async (req, res, next) => {
  try {
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.status(401).json({ error: "not signed in" });
    if (!githubLib.isConfigured()) {
      return res.json({ configured: false, connected: false, reason: "GitHub is not configured on this server" });
    }
    const ws = await resolveWsContext(sessionUser.wsId);
    const user = await dbAdapter.findOne(ws, "users", sessionUser.id);
    const g = (user && user.githubAccount) || null;
    res.json({
      configured: true,
      connected: !!(g && g.token),
      login: g ? g.login : null,
      name: g ? g.name : null,
      avatarUrl: g ? g.avatarUrl : null,
      scope: g ? g.scope : null,
      connectedAt: g ? g.connectedAt : null
    });
  } catch (e) { next(e); }
});

/** Start the handshake. A full navigation, so the person sees github.com. */
app.get("/api/integrations/github/connect", async (req, res, next) => {
  try {
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.status(401).json({ error: "not signed in" });
    if (!githubLib.isConfigured()) {
      return res.status(503).json({ error: "GitHub is not configured on this server (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET)" });
    }
    // Refuse BEFORE the redirect rather than after. Sending someone to
    // GitHub to authorize a scope this server then cannot store is a way
    // of collecting a credential we promised to encrypt and could not.
    if (!process.env.DB_ENCRYPTION_KEY) {
      return res.status(503).json({ error: "This server cannot store a GitHub token securely yet (DB_ENCRYPTION_KEY is not configured)." });
    }
    res.redirect(githubLib.authorizeUrl(signGithubState(sessionUser.id), githubRedirectUri(req)));
  } catch (e) { next(e); }
});

/** Come back with a code, leave with a stored token. */
app.get("/api/integrations/github/callback", async (req, res, next) => {
  const back = (msg) => res.redirect("/settings#integrations?github=" + encodeURIComponent(String(msg).slice(0, 140)));
  try {
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.redirect("/login?next=" + encodeURIComponent("/settings#integrations"));
    if (req.query.error) return back(req.query.error_description || req.query.error);
    if (!verifyGithubState(req.query.state, sessionUser.id)) return back("That sign-in link expired or did not match. Try again.");
    if (!process.env.DB_ENCRYPTION_KEY) return back("This server cannot store a GitHub token securely yet.");

    const { token, scope } = await githubLib.exchangeCode(String(req.query.code || ""), githubRedirectUri(req));
    const who = await githubLib.viewer(token);

    const ws = await resolveWsContext(sessionUser.wsId);
    await dbAdapter.updateOne(ws, "users", sessionUser.id, {
      githubAccount: {
        token: encryptSecret(token),
        login: who.login, name: who.name, avatarUrl: who.avatarUrl,
        scope: scope, connectedAt: new Date().toISOString()
      }
    });

    try {
      const masterDbForAudit = getMasterDb();
      if (masterDbForAudit) {
        await writeMasterAudit(masterDbForAudit, {
          requestId: req.id, actor: sessionUser.id, action: "account.github.connect",
          entityId: sessionUser.id, summary: "Connected the GitHub account " + who.login,
          meta: { login: who.login, scope: scope }
        });
      }
    } catch (e) { /* audit must never fail the write it describes */ }

    back("connected");
  } catch (e) { back(e && e.message ? e.message : "Could not finish connecting to GitHub."); }
});

/** Forget the token here and revoke it at GitHub. Repositories are untouched. */
app.delete("/api/integrations/github", async (req, res, next) => {
  try {
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.status(401).json({ error: "not signed in" });
    const creds = await githubCredsFor(sessionUser);
    const ws = await resolveWsContext(sessionUser.wsId);

    // Revoke if we can, forget regardless. If GitHub is unreachable,
    // refusing to disconnect would leave the owner stuck connected to an
    // account they are actively trying to remove.
    if (creds) { try { await githubLib.revoke(creds.token); } catch (e) { /* best effort */ } }
    await dbAdapter.updateOne(ws, "users", sessionUser.id, { githubAccount: null });

    try {
      const masterDbForAudit = getMasterDb();
      if (masterDbForAudit) {
        await writeMasterAudit(masterDbForAudit, {
          requestId: req.id, actor: sessionUser.id, action: "account.github.disconnect",
          entityId: sessionUser.id, summary: "Disconnected the GitHub account", meta: {}
        });
      }
    } catch (e) { /* ignore */ }

    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* What this app is built out of, read off its own package.json rather
   than assumed from the scaffold. A project is only as React as its
   dependencies say it is, and the scaffold has been changed before. */
function techOf(files) {
  const out = [];
  let pkg = null;
  try { pkg = JSON.parse(files["package.json"] || "null"); } catch (e) { pkg = null; }
  const deps = Object.assign({}, (pkg && pkg.dependencies) || {}, (pkg && pkg.devDependencies) || {});
  const has = (n) => Object.prototype.hasOwnProperty.call(deps, n);
  const add = (name, version) => out.push({ name: name, version: version || null });
  if (has("next")) add("Next.js", deps.next);
  if (has("react")) add("React", deps.react);
  if (has("vue")) add("Vue", deps.vue);
  if (has("svelte")) add("Svelte", deps.svelte);
  if (has("vite")) add("Vite", deps.vite);
  if (has("typescript") || Object.keys(files).some((f) => /\.tsx?$/.test(f))) add("TypeScript", deps.typescript);
  if (has("tailwindcss")) add("Tailwind CSS", deps.tailwindcss);
  if (has("framer-motion")) add("Framer Motion", deps["framer-motion"]);
  if (has("react-router-dom")) add("React Router", deps["react-router-dom"]);
  if (has("express")) add("Express", deps.express);
  if (has("three")) add("three.js", deps.three);
  if (!out.length && Object.keys(files).some((f) => /\.html$/.test(f))) add("Static HTML", null);
  return out;
}

/**
 * GET /api/projects/:key/details — everything the project card cannot say.
 *
 * The list endpoint returns what a card needs; this returns what a person
 * asks for once they have clicked: what it is made of, how big it is, how
 * many times it has been revised, and where its code lives if anywhere.
 * materialize() replays the revision chain, so `complete:false` means
 * pruning has eaten part of the history and the file list below is a
 * partial tree — said out loud rather than presented as the whole thing.
 */
app.get("/api/projects/:key/details", async (req, res, next) => {
  try {
    const owner = appOwnerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });

    const tree = await projects.materialize(project.id);
    const paths = Object.keys(tree.files || {}).sort();
    let bytes = 0;
    const files = paths.slice(0, 400).map((p) => {
      const size = Buffer.byteLength(String(tree.files[p] || ""), "utf8");
      bytes += size;
      return { path: p, bytes: size };
    });
    for (const p of paths.slice(400)) bytes += Buffer.byteLength(String(tree.files[p] || ""), "utf8");

    res.json({
      id: project.id, slug: project.slug, title: project.title || "Untitled",
      prompt: project.prompt || null,
      buildType: (project.meta || {}).buildType || null,
      kind: (project.meta || {}).kind || null,
      createdAt: project.createdAt, updatedAt: project.updatedAt,
      published: !!project.published, deployed: !!project.deploymentId,
      favorite: !!project.favorite,
      revisions: tree.revisions, historyComplete: !!tree.complete,
      fileCount: paths.length, totalBytes: bytes,
      files: files,
      tech: techOf(tree.files || {}),
      github: project.github || null
    });
  } catch (e) { next(e); }
});

/**
 * POST /api/projects/:key/github — create the repo if there isn't one, then
 * write every file as a single commit.
 *
 * Two different owners are checked here and they are not the same person by
 * accident: the PROJECT is checked against the anonymous/claimed owner the
 * way every other project route does it, and the TOKEN belongs to the signed
 * in user. Pushing someone else's project into your own GitHub account has
 * to fail on the first of those, not the second.
 */
app.post("/api/projects/:key/github", async (req, res, next) => {
  try {
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.status(401).json({ error: "Sign in to push to GitHub." });
    if (!githubLib.isConfigured()) {
      return res.status(503).json({ error: "GitHub is not configured on this server." });
    }

    const owner = appOwnerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });

    const creds = await githubCredsFor(sessionUser);
    if (!creds) return res.status(400).json({ error: "Connect your GitHub account in Settings first." });

    const tree = await projects.materialize(project.id);
    if (!Object.keys(tree.files || {}).length) {
      return res.status(400).json({ error: "This project has no files yet — build something first." });
    }

    let link = project.github && project.github.fullName ? project.github : null;
    let created = false;
    if (!link) {
      const repo = await githubLib.createRepo(creds.token, {
        name: (req.body && req.body.name) || project.slug || project.title,
        description: (project.title || "Souqi app") + " — built with Souqi",
        private: !(req.body && req.body.private === false)
      });
      link = {
        fullName: repo.fullName, htmlUrl: repo.htmlUrl, private: repo.private,
        branch: repo.defaultBranch, owner: repo.owner, linkedAt: new Date().toISOString()
      };
      created = true;
    }

    const message = (req.body && String(req.body.message || "").trim().slice(0, 200))
      || ("Souqi build — " + (project.title || project.slug));
    const push = await githubLib.pushFiles(creds.token, link.fullName, tree.files, message);

    link = Object.assign({}, link, {
      branch: push.branch, lastCommit: push.commitSha,
      lastCommitUrl: push.commitUrl, lastPushedAt: new Date().toISOString(),
      lastFiles: push.files
    });
    await projects.patch(project.id, { github: link });

    res.json({
      ok: true, created: created, repo: link, push: push,
      // A partial history means a partial tree. Better to say so on the
      // push that shipped it than to let someone find it missing later.
      historyComplete: !!tree.complete
    });
  } catch (e) {
    if (e && e.status === 401) {
      return res.status(400).json({ error: "Your GitHub connection is no longer valid. Reconnect it in Settings." });
    }
    if (e && e.status === 422) {
      return res.status(400).json({ error: e.message || "GitHub refused that repository name — it may already exist." });
    }
    if (e && e.status) return res.status(502).json({ error: e.message });
    next(e);
  }
});

/** Unlink the repository from the project. The repository itself stays. */
app.delete("/api/projects/:key/github", async (req, res, next) => {
  try {
    const owner = appOwnerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });
    await projects.patch(project.id, { github: null });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------- the item catalogue a generated app can charge for ---------- */

const MAX_PAYMENT_ITEMS = 50;

/** Normalize and validate one item. Money is integer minor units, always. */
function normalizePaymentItem(raw) {
  const name = String((raw && raw.name) || "").trim().slice(0, 250);
  if (!name) return { ok: false, reason: "each item needs a name" };
  // Minor units (cents) as an integer. Floats are how you end up charging
  // 1000.0000000001 and how rounding disagreements become refund tickets.
  const amountMinor = Number(raw && raw.amountMinor);
  if (!Number.isInteger(amountMinor) || amountMinor < 0) {
    return { ok: false, reason: "amountMinor must be a whole number of cents" };
  }
  if (amountMinor > 99999999) return { ok: false, reason: "that amount is too large" };
  const currency = String((raw && raw.currency) || "usd").toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) return { ok: false, reason: "currency must be a 3-letter code" };
  const id = String((raw && raw.id) || "").trim().slice(0, 60) || ("item_" + crypto.randomBytes(6).toString("hex"));
  if (!/^[A-Za-z0-9_\-]+$/.test(id)) return { ok: false, reason: "item ids may use letters, digits, _ and - only" };
  return { ok: true, item: { id: id, name: name, amountMinor: amountMinor, currency: currency } };
}

/** Replace the catalogue for one project. Owner only. */
app.put("/api/apps/:projectId/payment-items", jsonDefault, async (req, res, next) => {
  try {
    const sessionUser = await codeAgentSessionUserVerified(req);
    if (!sessionUser) return res.status(401).json({ error: "not signed in" });
    const project = await projects.get(String(req.params.projectId || ""));
    if (!project) return res.status(404).json({ error: "no such app" });
    if (project.ownerUserId !== sessionUser.id) return res.status(403).json({ error: "not your app" });

    const raw = (req.body && req.body.items);
    if (!Array.isArray(raw)) return res.status(400).json({ error: "items must be an array" });
    if (raw.length > MAX_PAYMENT_ITEMS) return res.status(400).json({ error: "at most " + MAX_PAYMENT_ITEMS + " items" });

    const items = [];
    const seen = new Set();
    for (const r of raw) {
      const norm = normalizePaymentItem(r);
      if (!norm.ok) return res.status(400).json({ error: norm.reason });
      if (seen.has(norm.item.id)) return res.status(400).json({ error: "duplicate item id: " + norm.item.id });
      seen.add(norm.item.id);
      items.push(norm.item);
    }
    await projects.patch(project.id, { payments: { items: items, updatedAt: new Date().toISOString() } });
    res.json({ ok: true, items: items });
  } catch (e) { next(e); }
});

/** What this app sells. Public: a shop's prices are not a secret. */
app.get("/api/apps/:projectId/payment-items", async (req, res, next) => {
  try {
    const project = await projects.get(String(req.params.projectId || ""));
    if (!project) return res.status(404).json({ error: "no such app" });
    const items = (project.payments && project.payments.items) || [];
    res.json({ items: items, acceptsPayments: !!(await ownerStripeAccount(project)) });
  } catch (e) { next(e); }
});

/** The connected account behind a project's owner, or null. */
async function ownerStripeAccount(project) {
  if (!project || !project.ownerUserId) return null;
  try {
    const ws = await resolveWsContext(project.wsId || null);
    const user = await dbAdapter.findOne(ws, "users", project.ownerUserId);
    const acct = user && user.stripeAccount;
    return acct && acct.accountId ? acct : null;
  } catch (e) { return null; }
}

// A generated app is public, so this endpoint is public, so it is the one an
// attacker actually reaches. Tight limit, per IP and per app.
const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000, max: 20,
  key: (req) => (req.ip || "") + ":" + (req.params.projectId || "")
});

/**
 * Start a payment from inside a generated app.
 *
 * PUBLIC on purpose — a shopper has no Souqi account. Which is exactly why the
 * request names an ITEM, never a price: the amount is read from the owner's
 * server-side catalogue. A body that could carry `amount` would turn this into
 * a free card-testing oracle pointed at a stranger's Stripe account, and the
 * account that gets shut down for it is the OWNER's.
 */
app.post("/api/apps/:projectId/checkout", checkoutLimiter, jsonDefault, async (req, res, next) => {
  try {
    if (!stripeLib.isConfigured()) return res.status(503).json({ error: "payments are not configured on this server" });

    const project = await projects.get(String(req.params.projectId || ""));
    if (!project) return res.status(404).json({ error: "no such app" });

    const acct = await ownerStripeAccount(project);
    if (!acct) return res.status(409).json({ error: "this app's owner has not connected a Stripe account yet" });

    const catalogue = (project.payments && project.payments.items) || [];
    if (!catalogue.length) return res.status(409).json({ error: "this app has nothing for sale yet" });

    const requested = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!requested.length) return res.status(400).json({ error: "items is required" });
    if (requested.length > 20) return res.status(400).json({ error: "too many line items" });

    const resolved = [];
    for (const r of requested) {
      const found = catalogue.find((c) => c.id === String((r && r.itemId) || ""));
      if (!found) return res.status(400).json({ error: "unknown item: " + String((r && r.itemId) || "") });
      const qty = Number(r && r.quantity);
      const quantity = Number.isInteger(qty) && qty > 0 ? Math.min(qty, 100) : 1;
      // Price comes from `found`, the server's copy — never from `r`.
      resolved.push({ name: found.name, amountMinor: found.amountMinor, currency: found.currency, quantity: quantity });
    }

    const origin = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "") || (req.protocol + "://" + req.get("host"));
    const out = await stripeLib.createCheckoutSession({
      account: acct.accountId,
      items: resolved,
      successUrl: origin + "/pay/success?session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: origin + "/pay/cancelled",
      // Stripe replays an idempotency key's first response, so a shopper
      // double-clicking Buy gets one session, not two.
      idempotencyKey: req.get("Idempotency-Key") || undefined,
      metadata: { souqiProjectId: project.id }
    });
    if (!out.ok) return res.status(502).json({ error: out.reason });

    res.json({ ok: true, url: out.url, sessionId: out.id });
  } catch (e) { next(e); }
});

/**
 * Stripe's callback. Authenticated by signature over the RAW body — hence
 * express.raw here rather than the JSON parser every other route uses; a
 * re-serialized body has different bytes and would never verify.
 */
app.post("/api/stripe/webhook", express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
  const verified = stripeLib.verifyWebhook(req.body, req.get("Stripe-Signature"));
  if (!verified.ok) {
    /* The REASON stays here. This endpoint is unauthenticated by nature —
       anyone can POST to it — and the reasons are a description of the
       deployment: "STRIPE_WEBHOOK_SECRET is not configured" tells a
       stranger that billing is not wired up yet, and "timestamp outside
       tolerance" tells them their replay was noticed rather than their
       signature being wrong. Neither is catastrophic and neither is
       anyone's business.

       Stripe does not read this body; it reads the status. 400 tells it to
       retry, which is right for a transient problem and harmless for a
       forged one, which will simply keep failing. */
    console.warn("[stripe-webhook] rejected: " + verified.reason);
    return res.status(400).json({ error: "invalid signature" });
  }
  const event = verified.event;
  try {
    /* Connect events carry the connected account they happened on; Souqi's
       own events do not. Both arrive here when one endpoint is subscribed
       to both sets, so the presence of `account` is what tells a merchant's
       subscription apart from a Souqi subscription — without that check, a
       connected account which happens to sell subscriptions of its own
       could be read as a plan change on Souqi. */
    const onConnectedAccount = !!event.account;

    if (!onConnectedAccount && (
          event.type === "customer.subscription.created" ||
          event.type === "customer.subscription.updated" ||
          event.type === "customer.subscription.deleted")) {
      const sub = stripeLib.summariseSubscription(event.data && event.data.object);
      const wsId = sub.metadata && sub.metadata.souqiWsId;
      /* No workspace id in the metadata means this subscription did not come
         from /api/billing/subscribe — someone created it in the dashboard,
         say. There is nothing to attribute it to, and guessing from the
         customer would be worse than leaving it alone. */
      if (wsId) {
        /* A deletion arrives as the subscription in its final state, which
           Stripe reports as canceled — pinning it here means the plan is
           cleared even if that ever stops being true. */
        const effective = event.type === "customer.subscription.deleted"
          ? Object.assign({}, sub, { status: "canceled" })
          : sub;
        await applySubscription(wsId, effective, effective.metadata.souqiPlan, req, "stripe");
      }
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data && event.data.object;
      const projectId = session && session.metadata && session.metadata.souqiProjectId;
      if (projectId) {
        const masterDbForAudit = getMasterDb();
        if (masterDbForAudit) {
          await writeMasterAudit(masterDbForAudit, {
            requestId: req.id, actor: "stripe", action: "app.payment.completed",
            entityId: projectId,
            summary: "A payment completed in a generated app",
            // Never the customer's details — only what the owner needs to
            // reconcile against their own Stripe dashboard.
            meta: {
              projectId: projectId, sessionId: session.id,
              amountTotal: session.amount_total, currency: session.currency
            }
          });
        }
      }
    }
  } catch (e) {
    // Acknowledged below regardless: Stripe retries on a non-2xx, and our own
    // bookkeeping failing is not a reason to make Stripe redeliver forever.
  }
  res.json({ received: true });
});

/** Raw stored map, still encrypted. Callers decrypt only what they need. */
async function readAiKeys(sessionUser) {
  const ws = await resolveWsContext(sessionUser.wsId);
  const user = await dbAdapter.findOne(ws, "users", sessionUser.id);
  const keys = (user && user.aiKeys) || {};
  return (keys && typeof keys === "object") ? Object.assign({}, keys) : {};
}

/**
 * Resolve the BYOK credentials for a build request, or null for "use
 * Souqi's own models".
 *
 * The provider is taken from the request body but the KEY is only ever
 * loaded server-side from the signed-in account. A client that could send
 * its own key inline would let an anonymous visitor spend a key they pasted
 * once and can no longer revoke, and would put live credentials in request
 * bodies and logs. The client sends an intent; the server supplies the
 * secret. If the account has no key for the requested provider, this
 * returns null and the build falls back to Souqi's models rather than
 * failing — a missing key is a configuration gap, not an error worth
 * throwing away a build request over.
 */
async function resolveByok(req, providerId) {
  const id = String(providerId || "").toLowerCase();
  if (!id || id === "souqi") return null;
  const provider = aiProviders.get(id);
  if (!provider || !provider.byok) return null;

  const sessionUser = await codeAgentSessionUserVerified(req);
  if (!sessionUser) return null;

  const stored = await readAiKeys(sessionUser);
  const entry = stored[id];
  if (!entry || !entry.key) return null;
  try {
    return { provider: id, apiKey: decryptSecret(entry.key), model: entry.model || provider.defaultModel };
  } catch (e) {
    // Key present but undecryptable (DB_ENCRYPTION_KEY rotated or missing).
    // Fall back to Souqi's models rather than failing the build; the user
    // can re-save the key from the picker.
    console.warn("[byok] could not decrypt stored " + id + " key:", e.message);
    return null;
  }
}

/** Code's version of finalizeClaim (line ~1620) — re-points project
    ownership from the anonymous cookie to a real account, same idea as
    Sites' claim, but skips the Sites-only "publish this as the
    workspace's live storefront" step: a Code project has no
    storefrontConfig, it's a sandboxed app with its own preview/publish
    path, so claiming it just means it stops being anonymous. */
async function finalizeCodeClaim({ project, wsId, userId, email, requestId }) {
  await projects.patch(project.id, { wsId: wsId, ownerUserId: userId, ownerAnonId: project.ownerAnonId });
  const ws = await resolveWsContext(wsId);
  await writeAudit(dbAdapter, ws, {
    requestId: requestId, actor: email, action: "workspace.codeagent.claim",
    entity: "workspace", entityId: wsId,
    summary: "Code project " + project.id + " (" + project.slug + ") claimed"
  });
}

/**
 * POST /api/codeagent/:key/micro-claim
 * Body: { email, password }
 *
 * The account-creation step behind code.html's "sign up to see your app"
 * preview gate: two fields, because a Code visitor has already SEEN their
 * build work — they just need an account to keep it, not a full signup
 * form. Mirrors /api/projects/:key/micro-claim (the Sites equivalent, same
 * schema and rate limiter) but claims through finalizeCodeClaim instead of
 * finalizeClaim, and — unlike Sites, which only mints a short-lived
 * portal-edit token — sets the same httpOnly sq_session cookie /auth/login
 * does, since code.html's own gates (POST /build's edit gate above,
 * codeAgentSessionUser) read sign-in state from that cookie, not a Bearer
 * token.
 */
app.post("/api/codeagent/:key/micro-claim", microClaimLimiter, verifyCaptcha(), validateBody(microClaimSchema), async (req, res, next) => {
  try {
    const { email, password, country } = req.valid;
    const emailLower = email.toLowerCase();

    const owner = anon.ownerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });
    if (project.wsId) return res.status(409).json({ error: "this project is already claimed" });

    const masterDb = getMasterDb();
    if (!masterDb) return res.status(503).json({ error: "Master DB not available" });

    const existingWs = await masterDb.collection("workspaces").findOne({ ownerEmail: emailLower });
    if (existingWs) {
      return res.status(409).json({ error: "an account with this email already exists — sign in instead" });
    }

    const wsId = "ws_" + Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
    await masterDb.collection("workspaces").insertOne({
      id: wsId,
      company: String(project.title || "My Apps").slice(0, 120),
      industry: "software",
      // Collected at signup and surfaced by GET /api/admin/accounts, which
      // has always read this field — it just never had a real value to read
      // while this was hardcoded.
      country: String(country || "").toUpperCase().slice(0, 5) || "OT",
      ownerEmail: emailLower,
      dbType: "local",
      dbUri: "",
      logo: null,
      tagline: "",
      storefrontEnabled: false,
      plan: "free",
      createdAt: new Date().toISOString()
    });

    const ownerUser = {
      id: "usr_" + crypto.randomBytes(8).toString("base64url"),
      name: emailLower.split("@")[0],
      email: emailLower,
      password: password,              // insertOne() bcrypt-hashes "users" passwords automatically
      role: "Owner", dept: "Management", active: true,
      joined: new Date().toISOString().slice(0, 10)
    };
    const ws = await resolveWsContext(wsId);
    await dbAdapter.insertOne(ws, "users", ownerUser);

    await finalizeCodeClaim({ project, wsId, userId: ownerUser.id, email: emailLower, requestId: req.id });

    const session = { id: ownerUser.id, name: ownerUser.name, email: ownerUser.email, role: "Owner", dept: "Management", wsId: wsId, sessionEpoch: ownerUser.sessionEpoch || 0 };
    const token = jwt.sign(session, JWT_SECRET, { expiresIn: "12h" });
    res.cookie("sq_session", token, {
      httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
      maxAge: 12 * 3600 * 1000, path: "/"
    });

    /* Anything built before signing in belongs to a cookie, not a person.
       Attach it to the account now, or it disappears the next time that
       cookie rotates — a different browser, cleared site data, a new
       device — with no way back to it.

       Never fatal: a failed claim must not stop someone signing in. */
    try {
      const moved = await projects.claimAnon(anon.anonIdOf(req), session.id);
      if (moved.claimed) console.log("[auth] claimed " + moved.claimed + " project(s) for " + session.id);
    } catch (e) { console.warn("[auth] claim skipped:", e.message); }
    res.json({ ok: true, wsId: wsId, token: token, user: session });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

/**
 * POST /api/codeagent/build-feedback
 * Body: { buildId, ok, errors?, raw? }
 * Called by code.html after the browser's WebContainer finishes a build.
 * Resolves the pending promise in the SSE handler's repair loop.
 */
app.post("/api/codeagent/build-feedback", express.json({ limit: "1mb" }), (req, res) => {
  const { buildId, ok, errors, raw, infra, verified } = req.body || {};
  if (!buildId) return res.status(400).json({ error: "buildId required" });
  const pending = pendingBuildResults.get(buildId);
  if (!pending) return res.status(404).json({ error: "unknown or expired buildId" });
  pendingBuildResults.delete(buildId);
  clearTimeout(pending.timer);
  /* infra and verified were both being dropped here, and each was a lie of a
     different kind. infra:true means the BUILD never ran — a WebContainer that
     would not boot, not a defect in the generated code. verified:false means
     the device cannot build at all (no SharedArrayBuffer), so the ok:true that
     accompanies it is a formality, not a compile. Passing them through lets
     the loop stop asking the model to fix infrastructure, and lets the audit
     record stop counting unverified builds as successes. */
  pending.resolve({ ok: !!ok, errors: errors || [], raw: raw || "", infra: !!infra, verified: verified !== false });
  res.json({ received: true });
});

/**
 * POST /api/codeagent/repair
 * Body: { projectId, errors, prompt?, mode?, effort?, chatId? }
 * SSE or JSON.
 *
 * Dedicated repair endpoint for WebContainer builds:
 * When WebContainer in the browser detects a TypeScript compile or runtime error,
 * it calls this endpoint directly with the structured errors.
 * This runs a single, bounded repair turn (~25-35s) completely decoupled from
 * the initial build's HTTP lifetime, preventing 300s serverless timeouts.
 */
app.post("/api/codeagent/repair", codeAgentLimiter, async (req, res) => {
  const owner = appOwnerOf(req, res);
  const projectId = String((req.body && req.body.projectId) || "").trim();
  if (!projectId) return res.status(400).json({ error: "projectId required" });

  const project = await resolveProject(projectId, owner);
  if (!project) return res.status(404).json({ error: "project not found" });
  if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });

  const errors = Array.isArray(req.body && req.body.errors) ? req.body.errors : [];
  if (!errors.length) return res.status(400).json({ error: "errors array required" });

  const isStream = wantsStream(req);
  if (isStream) sseOpen(res);

  try {
    if (isStream) {
      sseFrame(res, "stage", {
        id: "repair-" + Date.now(), state: "start",
        detail: "Repairing " + errors.length + " build error" + (errors.length === 1 ? "" : "s") + "..."
      });
    }

    const full = await projects.materialize(project.id);
    const baseFiles = (full && full.files) || {};

    const rawMode = String((req.body && req.body.mode) || "").toLowerCase();
    const buildMode = (rawMode === "power" || (req.body && req.body.thinking)) ? "power" : "auto";
    const effort = effortFor(req.body && req.body.effort, buildMode);

    const repairRes = await repairProposal({
      files: baseFiles,
      errors: errors,
      userPrompt: req.body && req.body.prompt,
      mode: buildMode,
      effort: effort.id,
      byok: req.byok || undefined
    });

    if (!repairRes.ok || !repairRes.calls.length) {
      const errMsg = repairRes.reason || "Unable to repair build errors automatically";
      if (isStream) {
        sseFrame(res, "error", { error: errMsg });
        return res.end();
      }
      return res.status(500).json({ error: errMsg });
    }

    // Save repaired files as a new revision
    const revision = await projects.addRevision(
      project.id,
      { files: repairRes.updatedFiles },
      "Repaired " + errors.length + " issue" + (errors.length === 1 ? "" : "s")
    );

    const chatId = String((req.body && req.body.chatId) || "").slice(0, 40);
    const summary = "Repaired " + repairRes.calls.length + " file" + (repairRes.calls.length === 1 ? "" : "s") + " based on compiler feedback.";
    await projects.addTurn(project.id, {
      role: "agent", kind: "result",
      body: repairRes.note ? repairRes.note + "\n\n" + summary : summary,
      revisionId: revision.id, chatId: chatId
    });

    // Merge scaffold runtime files and theme so WebContainer has full bundle
    const filesObj = Object.assign({}, repairRes.updatedFiles);
    for (const p of SCAFFOLD_RUNTIME_FILES) {
      const content = scaffoldAll[p];
      if (typeof content === "string") filesObj[p] = content;
    }
    const buildSeedHex = (project.meta && project.meta.seedHex) || "#0f172a";
    const buildType = (project.meta && project.meta.buildType) || "website";
    const buildTheme = theme.forBuild({ buildType, seedHex: buildSeedHex });
    filesObj["tailwind.config.js"] = theme.tailwindConfig(buildTheme);
    filesObj["__souqi_fonts__"] = theme.fontLinkTag(buildTheme);

    if (isStream) {
      sseFrame(res, "stage", { id: "repair-done", state: "done", detail: "Applied repairs" });
      sseFrame(res, "files", { buildId: "rep-" + Date.now(), files: filesObj });
      sseFrame(res, "result", {
        ok: true,
        calls: repairRes.calls,
        repaired: true,
        revisionId: revision.id,
        note: repairRes.note
      });
      return res.end();
    }

    return res.json({
      ok: true,
      calls: repairRes.calls,
      files: filesObj,
      revisionId: revision.id,
      note: repairRes.note
    });
  } catch (err) {
    if (isStream) {
      sseFrame(res, "error", { error: err.message || "Repair encountered an internal error" });
      return res.end();
    }
    return res.status(500).json({ error: err.message || "Repair error" });
  }
});

/**
 * POST /api/codeagent/runs
 * Starts an autonomous dynamic agent run. Returns 202 Accepted.
 * Returns 200 with { chitchat } when the prompt is noise/question (non-build mode).
 */
app.post("/api/codeagent/runs", codeAgentLimiter, express.json({ limit: "1mb" }), async (req, res) => {
  const owner = appOwnerOf(req, res);
  const prompt = String((req.body && req.body.prompt) || "").trim();
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  const rawMode = String((req.body && req.body.mode) || "").toLowerCase();
  // "build" mode skips ALL smart detection — always goes straight to code.
  const isBuildMode = rawMode === "build";
  /* "plan" is preserved rather than collapsed into "auto". It used to be
     mapped away right here, so by the time a run reached agent-runner the
     mode it had been approved under no longer existed — and the confirmed
     flag that gated it lived on a different route entirely. */
  const buildMode = (rawMode === "power" || (req.body && req.body.thinking)) ? "power"
    : isBuildMode ? "build" : rawMode === "plan" ? "plan" : "auto";

  const existingKey = String((req.body && req.body.projectId) || "");
  let project = null;
  let baseFiles = {};
  if (existingKey) {
    project = await resolveProject(existingKey, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });
    const full = await projects.materialize(project.id);
    baseFiles = (full && full.files) || {};
  }

  /* Checked here because the head revision is part of what an approval is
     bound to, and it is not known until the project is resolved. A token
     that is present but does not verify is always refused; a token that is
     ABSENT is only refused when CODEAGENT_REQUIRE_PLAN_APPROVAL is on,
     because no shipped client sends one yet and enforcing it today would
     refuse every plan-mode build. The outcome is recorded on the run either
     way, so the logs can answer "how often would this have refused?" before
     anyone turns it on. */
  const approval = agentState.verifyApproval(req.body && req.body.approvalToken, {
    sessionKey: agentState.sessionKeyOf(owner),
    projectId: project ? project.id : "",
    revisionId: (project && project.headRevision) || "none"
  });

function getConversationalFallback(prompt, history) {
  const p = String(prompt || "").trim().toLowerCase();

  // 1. User correcting agent ("i said heyyy not build", "i didn't say build", "don't touch code", "stop", "not build")
  if (
    /\b(i said|said|told you|meant|meaning)\b.*\b(not|never|didn'?t)\b/i.test(p) ||
    /\b(not build|didn'?t say build|never said build|stop building|don'?t build|dont build|hold on|wait|not yet|no building)\b/i.test(p) ||
    /\b(started building|before i (finished|could|said)|premature|who said build|did i say build)\b/i.test(p)
  ) {
    const apologeticReplies = [
      "Haha my bad, heard you loud and clear! No building at all. How are you doing today? We can just chat or bounce ideas around.",
      "Understood, totally my fault! I won't touch any code until you give me the green light. What's on your mind?",
      "Got it, no code! Sorry about that. Let me know whenever you want to plan something or if you just want to talk through ideas.",
      "Haha my bad! Hey there! 👋 I'm all ears — take all the time you need, we'll only build when you explicitly say so."
    ];
    return apologeticReplies[Math.abs(p.length) % apologeticReplies.length];
  }

  // 2. Greetings (including elongated words like "heyyyy", "hiiii", "hellooo", "yoooo", "suuuup")
  if (/\b(h+e+y+|h+i+|h+e+l+l+o+|h+o+w+d+y+|y+o+|s+u+p+|g+m+|g+n+|g+r+e+e+t+i+n+g+s*)\b/i.test(p)) {
    const greetingReplies = [
      "Hey there! 👋 Great to see you. How are you doing today? Thinking of building something cool or just exploring?",
      "Hey! What's up? I'm here to help — we can brainstorm app ideas, plan a project, or just chat. What's on your mind?",
      "Hello! Hope you're having a great day. Let me know what you'd like to work on whenever you're ready!",
      "Hey! 👋 Ready whenever you are. What kind of project or ideas are you thinking about today?"
    ];
    return greetingReplies[Math.abs(p.length) % greetingReplies.length];
  }

  // 3. User asking "how are you", "what's up", "how's it going"
  if (/\b(how are you|how r u|how are u|how you doing|what's up|whats up|how's it going|hows it going)\b/i.test(p)) {
    return "I'm doing great, thanks for asking! Excited to help you build something awesome. What kind of project do you have in mind today?";
  }

  // 4. Indecision or asking for suggestions ("idk", "what should i build", "any ideas")
  if (/\b(idk|i don'?t know|not sure|dunno|no idea|have no idea|undecided|any ideas?|suggest|recommend|what should i build|give me ideas)\b/i.test(p)) {
    return "No worries at all! Here are a few fun ideas we could create:\n• A sleek personal portfolio or resume site\n• A local cafe or restaurant landing page with a menu\n• A modern task tracker or habit dashboard\n• A retro mini-game like 2D Snake\nWhich one sounds interesting to you?";
  }

  // 5. Short affirmations & acknowledgments ("ok", "sure", "cool", "nice")
  if (/^(ok|okay|k|kk|sure|got it|sounds good|alright|fine|yes|yep|yeah|bet|nice|cool|sweet)$/i.test(p)) {
    return "Awesome! Take your time, and whenever you're ready, let me know what kind of app or feature you'd like to build.";
  }

  // 6. Casual slang & confusion ("wdym", "wtf", "wth", "bro", "dude")
  if (/\b(wdym|wth|wtf|lol what|bro|dude|man|bruh)\b/i.test(p)) {
    return "Haha my bad if that was confusing! What's on your mind? Feel free to ask anything or let me know whenever you want to start building.";
  }

  // 7. Explanations & questions about tech ("how does this work", "explain", "what is")
  if (/\b(explain|walk me through|how does|what is|why is|difference between|what tech|technologies)\b/i.test(p)) {
    return "I'm happy to explain how things work or walk through any concepts! What specific part would you like to explore?";
  }

  // 8. Single letter or keyboard mash noise ("asdf", "zzz", "s")
  if (/^(s|a|z|x|d|c|asdf|qwerty|zzz+|hhh+|aaa+|xxx+|[?!\s]+)$/i.test(p) || (p.length <= 2 && !/^(ai|ui|ux|db|vr|ar|os|2d|3d)$/i.test(p))) {
    return "Looks like an accidental keystroke! What would you like to work on today?";
  }

  // Default natural rotating replies
  const defaultReplies = [
    "Sounds good! Whenever you're ready, let me know what kind of app or feature you'd like to build.",
    "Got it! Take your time, I'm right here whenever you're ready to plan or start building.",
    "All good! Feel free to ask questions, explore ideas, or describe what you want to create whenever you're ready."
  ];
  return defaultReplies[Math.abs(p.length) % defaultReplies.length];
}

  /* --- Smart guard (non-build mode): intercept conversational chatter,
     questions, indecision, and noise BEFORE creating projects or runs ---

     Skipped for an approved plan. "add a dark mode?" reads as a question,
     and refusing to build it after the user has approved a plan that says
     exactly that would be the guard working against itself. */
  if (!isBuildMode && !approval.ok) {
    const isConv = agentRunner.isQuestionOrConversational(prompt);
    const quick = quickAssess(prompt);
    const isNoiseOrGreeting = quick && !quick.clear;

    if (isConv || isNoiseOrGreeting) {
      let reply = "";
      try {
        const history = Array.isArray(req.body && req.body.conversation) ? req.body.conversation : [];
        const answerRes = await aiClient.chat({
          route: "prose",
          messages: [
            {
              role: "system",
              content:
                "You are Souqi, a friendly, intelligent, and natural human software engineer assisting a user in an app builder.\n" +
                "The user is talking with you casually, asking a question, making a remark, expressing indecision ('idk'), reacting, or telling you to hold on/not build yet.\n" +
                "They are NOT ordering a new code build right now.\n\n" +
                "CRITICAL HUMAN CONVERSATION RULES:\n" +
                "- Speak naturally, warmly, and concisely like a real human software engineer in chat.\n" +
                "- NEVER repeat robotic canned phrases like 'Hey! 👋 What would you like me to build?' over and over.\n" +
                "- If they say 'idk', 'not sure', or ask for ideas: be helpful and inspiring! Give 2-3 quick fun suggestions (e.g. sleek portfolio, coffee shop site, habit tracker, mini-game) and ask what sounds fun.\n" +
                "- If they make a casual remark or compliment ('you know when to build now, wow', 'cool', 'nice'): respond warmly like a teammate.\n" +
                "- If they type an accidental keystroke or typo (like 's', 'asdf'): acknowledge it playfully with good humor ('Looks like an accidental keystroke! What's on your mind?').\n" +
                "- If they say 'i didn't say build yet', 'wait', or 'stop': warmly apologize, reassure them you are waiting for their instructions, and ask what they'd like to plan or discuss.\n" +
                "- Keep your answer short (1 to 3 sentences). Never write code blocks or markdown backticks."
            }
          ].concat(
            history.slice(-6).map(t => ({
              role: t.role === "agent" ? "assistant" : "user",
              content: String(t.body || "")
            })),
            [{ role: "user", content: prompt }]
          ),
          timeoutMs: 30000
        });
        if (answerRes && answerRes.message && answerRes.message.content) {
          reply = answerRes.message.content.trim();
        }
      } catch (e) {
        console.warn("[runs guard] conversational AI reply failed:", e.message);
      }

      if (!reply) {
        reply = getConversationalFallback(prompt, history);
      }

      if (project) {
        try {
          const chatId = String((req.body && req.body.chatId) || "");
          await projects.addTurn(project.id, { role: "user", kind: "text", body: prompt, chatId });
          await projects.addTurn(project.id, { role: "agent", kind: "text", body: reply, chatId });
        } catch (e) {}
      }
      return res.status(200).json({ chitchat: reply });
    }

    // For fresh builds (no project yet): run assessPrompt if needed to detect questions/clarifications before building
    if (!project) {
      try {
        const convo = Array.isArray(req.body && req.body.conversation) ? req.body.conversation.slice(-12) : [];
        const assessment = await assessPrompt(prompt, { history: convo });
        if (assessment && !assessment.clear) {
          if (assessment.action === "ask") {
            return res.status(200).json({
              needsAnswer: assessment.reply,
              options: Array.isArray(assessment.options) ? assessment.options : undefined
            });
          }
          const reply = assessment.reply || getConversationalFallback(prompt);
          return res.status(200).json({ chitchat: reply });
        }
      } catch (e) {
        console.warn("[runs guard] assessPrompt check skipped:", e.message);
      }
    }
  }

  // If there is no existing project and this is a real build request, pre-create the project
  if (!project) {
    try {
      project = await projects.create({
        title: projects.titleFromPrompt(prompt),
        prompt,
        meta: { kind: "code", buildType: (req.body && req.body.buildType) || "website" },
        owner
      });
      await projects.addTurn(project.id, {
        role: "user", kind: "text", body: prompt, chatId: String((req.body && req.body.chatId) || "")
      });
    } catch (e) {
      console.warn("Could not pre-create project:", e.message);
    }
  }

  const effort = effortFor(req.body && req.body.effort, buildMode);

  const attachedImages = await uploads.listForOwner(
    Array.isArray(req.body && req.body.imageIds) ? req.body.imageIds : [], owner
  );
  const imagesBlock = buildImagesBlock(attachedImages);

  /* Reap stale runs BEFORE createRun can be refused by the single-active
     constraint.

     recoverExpiredRuns() has existed since run-store was written and was
     called by exactly one thing: the worker that is not deployed. So a
     run killed by the host kept activeOwnerKey for ever — those keys are
     released only on a terminal transition, and a killed process never
     makes one — and every later build was refused with
     RUN_ALREADY_ACTIVE, naming a run the client had already forgotten
     the id of.

     Opportunistic and non-fatal: a sweep that fails must not fail the
     build, and the next request will try again. */
  try {
    // Two sweeps, because they find different things: expired LEASES are
    // worker runs, and stale updatedAt with no lease is an in-process run
    // whose function was terminated.
    await runStore.recoverExpiredRuns();
    await runStore.recoverStaleRuns();
  } catch (e) { console.error("[codeagent] stale-run sweep failed:", e && e.message); }

  /* An idempotency key, so a double-submit is one run rather than two.
     run-store has had the unique index and getRunByIdempotency since it
     was written, and this call has never passed a key — so the index
     never engaged and a retried POST (a flaky connection, an impatient
     second click) started a second run against the same project.

     Taken from the client's header when it sends one, and otherwise
     DERIVED from what actually identifies this request: the same owner
     asking for the same thing in the same chat within the same minute
     is the same request. The minute bucket is what keeps a deliberate
     "do that again" from being swallowed. */
  const idemHeader = String(req.get("Idempotency-Key") || "").slice(0, 100);
  const idempotencyKey = /^[a-zA-Z0-9_-]{16,100}$/.test(idemHeader)
    ? idemHeader
    : require("crypto").createHash("sha256").update([
        (owner.userId ? "u:" + owner.userId : "a:" + (owner.anonId || "")),
        project ? project.id : "", prompt,
        buildMode, effort.id, String((req.body && req.body.chatId) || ""),
        Math.floor(Date.now() / 60000)
      ].join("\u0000")).digest("hex").slice(0, 40);

  const run = await runStore.createRun({
    projectId: project ? project.id : null,
    owner,
    prompt,
    mode: buildMode,
    effort: effort.id,
    baseFiles,
    idempotencyKey,
    requestHash: idempotencyKey,
    chatId: String((req.body && req.body.chatId) || ""),
    meta: {
      approval: {
        ok: approval.ok,
        reason: approval.reason,
        planVersion: approval.planVersion || null,
        at: new Date().toISOString()
      }
    }
  });

  /* Hand the run to the durable worker, or run it here.

     With CODEAGENT_DURABLE_RUNS=1 and a worker whose heartbeat is
     fresh, the run is left `queued` and claimNext() picks it up on the
     other machine — where it may take the thirty minutes its effort
     level promises rather than being terminated at 300 seconds.

     BOTH conditions, not just the flag. A worker that is configured but
     dead would otherwise leave every run queued for ever, which is a
     worse failure than the one this replaces: at least an in-process
     run finishes partial and says so. So the flag says "prefer the
     worker" and the heartbeat says "there is one".

     Unsetting the flag is the rollback, and it leaves nothing behind
     but an idle container. */
  let handedOff = false;
  if (process.env.CODEAGENT_DURABLE_RUNS === "1") {
    try {
      const health = await runStore.getWorkerHealth();
      if (health && health.healthy) {
        handedOff = true;
        await runStore.appendEvent(run.id, "stage", {
          id: "queued", state: "start", detail: "Queued for the build worker…"
        });
      } else {
        console.warn("[codeagent] durable runs are on but no worker is healthy — running in process");
      }
    } catch (e) {
      console.warn("[codeagent] worker health check failed, running in process:", e && e.message);
    }
  }

  // Launch the autonomous agent runner in background
  if (!handedOff) agentRunner.executeRun(run.id, {
    history: req.body && req.body.conversation,
    imagesBlock,
    attachedImages
  }).then(async (outcome) => {
    if (outcome && outcome.ok && project) {
      try {
        const hasChanges = outcome.fileStats && outcome.fileStats.length > 0;
        let rev = null;
        if (hasChanges && outcome.files) {
          rev = await projects.addRevision(
            project.id,
            { files: outcome.files },
            outcome.summary || "Autonomous build completed"
          );
        }
        await projects.addTurn(project.id, {
          role: "agent", kind: hasChanges ? "result" : "text",
          body: outcome.summary || "Task completed",
          fileStats: outcome.fileStats || [],
          revisionId: rev ? rev.id : undefined, chatId: run.chatId
        });
        if (attachedImages.length) {
          try { await uploads.attachToProject(attachedImages.map(i => i.id), project.id); } catch (e) {}
        }
      } catch (e) {
        /* background persistence */
      }
    }
  }).catch(async (err) => {
    await runStore.updateRun(run.id, { status: "failed", latestError: err.message });
  });

  res.status(202).json({
    runId: run.id,
    projectId: project ? project.id : null,
    projectSlug: project ? (project.slug || project.id) : null,
    status: run.status
  });
});

/**
 * GET /api/codeagent/runs/:id
 * Authoritative run state, progress, and current files.
 */
app.get("/api/codeagent/runs/:id", async (req, res) => {
  const owner = appOwnerOf(req, res);
  const run = await runStore.getRun(req.params.id, owner);
  if (!run) return res.status(404).json({ error: "run not found" });

  const chk = await runStore.getLatestCheckpoint(run.id);
  let project = null;
  if (run.projectId) {
    try { project = await projects.get(run.projectId); } catch (e) {}
  }
  res.json({
    run,
    projectId: run.projectId,
    projectSlug: project ? project.slug : null,
    files: (chk && chk.files) || {},
    fileCount: (chk && chk.fileCount) || 0
  });
});

/**
 * GET /api/codeagent/runs/:id/events
 * SSE stream with event replay (?after=N) and live heartbeats.
 */
app.get("/api/codeagent/runs/:id/events", async (req, res) => {
  const owner = appOwnerOf(req, res);
  const run = await runStore.getRun(req.params.id, owner);
  if (!run) return res.status(404).json({ error: "run not found" });

  /* The cursor comes from either place, and Last-Event-ID is the one the
     browser sends by itself. EventSource replays it automatically on a
     dropped connection — but only if the frames carried `id:` lines, and
     these did not, so a native reconnect could only ever restart from
     zero. The frames carry them now. */
  const cursor = Number(req.query.after || req.get("Last-Event-ID") || 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    return res.status(400).json({ error: "invalid event cursor" });
  }

  sseOpen(res);
  let lastSeq = cursor;

  /* Bounded, and ended cleanly rather than killed. An unbounded stream on
     a serverless function is terminated by the host mid-frame, which the
     client sees as a truncated event rather than a stream it may resume.
     Ending on our own terms leaves the client holding a cursor. */
  const until = Date.now() + 45000;
  let closed = false;
  res.on("close", () => { closed = true; });

  try {
    while (!closed && !res.writableEnded) {
      const fresh = await runStore.getEvents(run.id, lastSeq);
      for (const ev of fresh) {
        if (closed) break;
        sseFrame(res, ev.type, Object.assign({}, ev.payload, { seq: ev.seq }), ev.seq);
        if (ev.seq > lastSeq) lastSeq = ev.seq;
      }
      if (closed) break;

      const cur = await runStore.getRun(run.id, owner);
      /* Every terminal status, not three of them. `partial` and `blocked`
         were missing, so a run that stopped at its deadline or its budget
         left this loop polling the database once a second until something
         else killed it. Newly common: a provider refusal that kept the
         files it had already written now ends `partial` too. */
      if (!cur || TERMINAL_RUN_STATUS.has(cur.status)) break;
      if (Date.now() >= until) break;

      res.write(": ping\n\n");
      /* Awaited rather than an interval: a poll that takes longer than the
         tick used to overlap with the next one, and two in flight against
         the same cursor send the same frame twice. */
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (e) {
    /* The client going away is the ordinary ending, not a fault. */
  } finally {
    if (!res.writableEnded) res.end();
  }
});

/**
 * POST /api/codeagent/runs/:id/check-result
 * Receives WebContainer compiler/render feedback and unblocks the agent runner.
 */
app.post("/api/codeagent/runs/:id/check-result", express.json({ limit: "1mb" }), async (req, res) => {
  const ok = agentRunner.reportCheckResult(req.params.id, req.body);
  if (!ok) return res.status(404).json({ error: "no pending check waiter for this run" });
  res.json({ received: true });
});

/**
 * POST /api/codeagent/runs/:id/cancel
 * Halts an active run.
 */
/**
 * POST /api/codeagent/runs/:id/answer
 * Body: { questionId, answers: { "<question text>": "<answer>" } }
 *
 * Resumes a run parked on ask_user_question. The store does the work
 * that matters: ownership is part of the update query rather than a
 * check before it, and the questionId is too, so two submissions of the
 * same answer race on one document and exactly one wins. A second one
 * gets 409 rather than resuming the run again on the same transcript.
 */
app.post("/api/codeagent/runs/:id/answer", async (req, res) => {
  const owner = appOwnerOf(req, res);
  const questionId = String((req.body && req.body.questionId) || "");
  const raw = (req.body && req.body.answers) || {};
  if (!questionId) return res.status(400).json({ error: "questionId is required" });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return res.status(400).json({ error: "answers must be an object of question -> answer" });
  }

  // Bounded before it is stored: this is user text that ends up in a prompt.
  const answers = {};
  for (const [q, a] of Object.entries(raw).slice(0, 4)) {
    answers[String(q).slice(0, 400)] = String(a ?? "").slice(0, 2000);
  }

  const resumed = await runStore.answerQuestion(req.params.id, owner, questionId, answers);
  if (!resumed) {
    return res.status(409).json({
      error: "That question is not open — it may have been answered already, or the run has moved on."
    });
  }

  await runStore.appendEvent(req.params.id, "answered", { id: questionId });

  /* Same fire-and-forget shape the spawn route uses: the run continues
     in the background and the client follows it on the events stream it
     is already subscribed to. */
  const run = await runStore.getRun(req.params.id, owner);
  agentRunner.executeRun(req.params.id, {
    history: (run && run.context && run.context.history) || []
  }).catch(async (err) => {
    await runStore.updateRun(req.params.id, { status: "failed", latestError: String(err && err.message || err) })
      .catch(() => {});
  });

  res.status(202).json({ resumed: true, runId: req.params.id });
});

app.post("/api/codeagent/runs/:id/cancel", async (req, res) => {
  const owner = appOwnerOf(req, res);
  const ok = await runStore.cancelRun(req.params.id, owner, req.body && req.body.reason);
  if (!ok) return res.status(400).json({ error: "could not cancel run (already finished or not found)" });
  res.json({ cancelled: true });
});

/**
 * POST /api/codeagent/build
 * Body: { prompt, projectId? }   SSE only.
 *
 * No projectId -> a brand new project. With projectId -> a follow-up:
 * reuses the live sandbox if this process still has one, otherwise spins
 * up a fresh sandbox and re-materializes the project's last known files
 * onto it first (a resume, transparent to the caller — same event shape
 * either way). There is no persisted model conversation (see file
 * header) — a follow-up is seeded with whatever is CURRENTLY on disk
 * plus the new request, so the model re-orients from real state each
 * turn rather than from memory of the first message.
 */
/* What the whole turn has to finish inside.

   vercel.json gives this function maxDuration:300 and the platform does not
   negotiate: at the ceiling the process is killed mid-stream. No result
   frame, no error frame — just a socket that stops, and a client that throws
   "No result came back" over a build that may have finished two minutes
   earlier. Max effort made it the normal outcome rather than an edge case:
   four repair rounds, each allowed three minutes for the browser build,
   against a five minute ceiling.

   The reserve is for everything that happens AFTER the loop returns — the
   revision write, the audit row, the closing frames. Overrunning there loses
   the result exactly as completely as overrunning inside the loop.

   Both are env-tunable because the ceiling is a deployment property: a
   self-hosted box has no 300s limit and should not inherit one. */
const TURN_BUDGET_MS = Number(process.env.CODEAGENT_TURN_BUDGET_MS || 300000);
const TURN_RESERVE_MS = Number(process.env.CODEAGENT_TURN_RESERVE_MS || 25000);

app.post("/api/codeagent/build", codeAgentLimiter, async (req, res) => {
  /* Which conversation in the project this message belongs to. "" is the
     original thread and the default, so a client that never sends one keeps
     working exactly as before. */
  const turnStartedAt = Date.now();
  const turnDeadlineAt = turnStartedAt + TURN_BUDGET_MS - TURN_RESERVE_MS;
  const chatId = String((req.body && req.body.chatId) || "").slice(0, 40);

  /* The three modes the composer offers, normalised here so every read of
     them agrees.

       auto   decide per message: answer, ask, or build, and then just
              build it — no plan card, no confirm step, either way.
       plan   show the plan and wait for approval EVERY time, edits included.
              This is the ONLY mode that shows a plan; it is what the mode
              is for, and it is the whole difference between it and auto.
       power  deep reasoning, MCP tools, an extra repair round.

     "economy" and "power" were the old names and still arrive from anything
     not yet updated — a saved hand-off, an older tab left open — so they are
     mapped rather than rejected. thinking:true on its own also means power,
     because that is the switch it replaced. */
  const rawMode = String((req.body && req.body.mode) || "").toLowerCase();
  const buildMode = rawMode === "plan" ? "plan"
    : (rawMode === "power" || (req.body && req.body.thinking)) ? "power"
    : "auto";
  if (!wantsStream(req)) return res.status(400).json({ error: "this endpoint only supports SSE (Accept: text/event-stream)" });
  const prompt = String((req.body && req.body.prompt) || "").trim();

  // MUST run before sseOpen(): ownerOf() sets the sq_anon cookie the first
  // time a visitor is seen, which needs res.setHeader — writeHead (inside
  // sseOpen) commits the response headers immediately, and calling it
  // after that throws ERR_HTTP_HEADERS_SENT. Found live: that throw came
  // from OUTSIDE this handler's own try/catch, as an unhandled rejection —
  // which crashed the entire Node process, not just this one request, on
  // literally the first anonymous visitor. Same ordering the working
  // POST /api/projects above already uses.
  const owner = appOwnerOf(req, res);

  sseOpen(res);
  const promptCap = await promptLimitFor(req);
  if (prompt.length > promptCap) {
    sseFrame(res, "error", { error: tooLongMessage("That brief", prompt.length, promptCap) });
    return res.end();
  }
  if (promptTooVague(prompt)) {
    sseFrame(res, "error", { error: "Tell me a bit more about what to build — e.g. \"a landing page for a coffee shop\" or \"a todo app with categories\"." });
    return res.end();
  }

  const existingKey = String((req.body && req.body.projectId) || "");
  let project = null;
  if (existingKey) {
    project = await resolveProject(existingKey, owner);
    if (!project) { sseFrame(res, "error", { error: "project not found" }); return res.end(); }
    if (!projects.owns(project, owner)) { sseFrame(res, "error", { error: "not your project" }); return res.end(); }
  }
  const isFollowUp = !!project; // fixed at request start — independent of whether the sandbox turns out to still be alive below

  // A follow-up that's just conversational ("thanks!", "nice", "lol") is
  // not a change request — running it through proposeWithRepair would
  // waste a full build cycle on a model trying to interpret "thanks" as
  // an edit. Deterministic and cheap on purpose: unlike a first prompt's
  // near-infinite phrasing space, an acknowledgment is a small, closed
  // set of very short, common phrases — a model call here would be
  // slower AND less reliable than just matching it.
  if (isFollowUp && isCodeAgentChitChat(prompt)) {
    sseFrame(res, "chitchat", { reply: codeAgentChitChatReply() });
    sseFrame(res, "done", {});
    return res.end();
  }

  // "Publish it" — hand straight back to the client, which owns the
  // built files. Placed with the chit-chat gate and BEFORE the edit /
  // spend gates on purpose: publishing an already-built project is not
  // an edit, so it should not consume a free edit, hit the subscribe
  // wall, or spend a single token on a model call.
  if (isFollowUp && isCodeAgentPublishRequest(prompt)) {
    sseFrame(res, "publishRequest", { projectId: project.id });
    sseFrame(res, "done", {});
    return res.end();
  }

  // Edit gate: the first build stays free and anonymous, exactly like
  // today — this only applies to a follow-up (an actual edit request).
  // Two steps, checked before any sandbox/model cost is incurred:
  //  1. Must be signed in at all — an anonymous cookie can build once but
  //     not iterate indefinitely for free forever.
  //  2. Once signed in, CODEAGENT_FREE_EDITS follow-ups are free; beyond
  //     that, their workspace needs a paid plan. "Workspace" because every
  //     account in this system is one (see /auth/login) — there is no
  //     separate personal-account concept to check a plan against.
  // Loaded once: the free-edit count needs it, and so does the model —
  // the conversation is context, not just a billing counter.
  /* ---- the monthly allowance ---------------------------------------------

     Counted per calendar month against the same owner identity projects.js
     uses, so signing in carries an anonymous visitor's history forward
     rather than handing them a fresh allowance.

     Checked before any model or sandbox cost. An admin is exempt: the people
     who run this have to be able to use it. */
  /* The owner resolved at the top of this route, NOT a second appOwnerOf().

     Resolving it writes the anon cookie for a first-time visitor, and by here
     the SSE headers are long gone — so calling it again threw
     ERR_HTTP_HEADERS_SENT out of res.cookie(), uncaught, taking the process
     down. It only reached visitors with no anon cookie yet, which is to say
     exactly the people this gate exists to let build once. */
  const quotaOwner = owner;
  const quotaUser = codeAgentSessionUser(req);
  const quotaAdmin = quotaUser && isAdminEmail(quotaUser.email);
  const counts = quotaAdmin ? { builds: 0, edits: 0 } : await codeAgentUsage.monthCounts(quotaOwner);

  if (!isFollowUp && !quotaAdmin) {
    const plan = await planOfRequest(req);
    if (!quotaUser) {
      // Anonymous: one build, then the wall. Not a signup wall in front of
      // the product — a wall after it has already shown what it does.
      if (counts.builds >= CODEAGENT_ANON_BUILDS) {
        sseFrame(res, "authRequired", {
          message: "That's your free build. Sign in (it's free) to build more — your app is saved and comes with you.",
          loginUrl: "/login", signupUrl: "/signup"
        });
        sseFrame(res, "done", {});
        return res.end();
      }
    } else if (!isPaidPlan(plan) && counts.builds >= CODEAGENT_FREE_BUILDS) {
      sseFrame(res, "subscribeRequired", {
        message: "You've used your " + CODEAGENT_FREE_BUILDS + " builds this month. Subscribe to keep building.",
        pricingUrl: "/pricing"
      });
      sseFrame(res, "done", {});
      return res.end();
    }
  }

  let priorTurns = [];
  if (isFollowUp) {
    const sessionUser = quotaUser;
    if (!sessionUser) {
      sseFrame(res, "authRequired", {
        message: "Sign in (it's free) to keep editing this build.",
        loginUrl: "/login", signupUrl: "/signup"
      });
      sseFrame(res, "done", {});
      return res.end();
    }
    /* Scoped to the conversation, not the project. A project can hold
       several: they share the app and differ only in what has been said,
       which is the point of starting a new one. The edit COUNT stays
       project-wide though - that is a billing limit on the app, and
       resetting it by opening a new chat would be a way around it. */
    /* Scoped to the conversation, not the project: a project can hold
       several, and they differ only in what has been said. */
    priorTurns = await projects.listTurns(project.id, chatId);

    /* The edit allowance is MONTHLY and account-wide, not per project.

       It used to count the turns on this one app, which meant the limit
       reset itself every time you started a new app — three edits each,
       forever. Counting the month against the account is the number the
       plan actually promises. */
    if (!quotaAdmin) {
      const plan = await planOfRequest(req);
      if (!isPaidPlan(plan) && counts.edits >= CODEAGENT_FREE_EDITS) {
        sseFrame(res, "subscribeRequired", {
          message: "You've used your " + CODEAGENT_FREE_EDITS + " edits this month. Subscribe to keep editing.",
          pricingUrl: "/pricing"
        });
        sseFrame(res, "done", {});
        return res.end();
      }
    }
  }

  /* An EDIT is charged here: past the gates, and every follow-up that gets
     this far is going to call the model.

     A BUILD is not — see the note where it is charged instead. */
  if (!quotaAdmin && isFollowUp) {
    await codeAgentUsage.recordAction(quotaOwner, "editCount");
  }

  // Per-owner spend cap (§9 "Abuse") — checked AFTER the free chit-chat
  // path (that one costs nothing) but before assessPrompt/proposeWithRepair
  // (both real model calls), and for both a fresh build and a follow-up —
  // a follow-up is exactly as billable as a first build. This is
  // independent of AI_MONTHLY_BUDGET_USD's own check inside lib/ai/client.js:
  // that one protects the whole platform's shared pool from running away in
  // aggregate; this one stops a single owner from being the reason it does.
  {
    const sessionUserForSpend = codeAgentSessionUser(req);
    if (!sessionUserForSpend || !isAdminEmail(sessionUserForSpend.email)) {
      // Both ceilings, by plan: the rolling window and the month. See
      // spendGate — the window is reported first because it lifts by
      // itself and can be waited out, which the month cannot.
      const planForSpend = await planOfRequest(req);
      const gate = await spendGate(owner, planForSpend);
      if (!gate.ok) {
        sseFrame(res, "limit", {
          scope: gate.scope, message: gate.message,
          resetAt: gate.resetAt || null,
          pricingUrl: isPaidPlan(planForSpend) ? null : "/pricing"
        });
        sseFrame(res, "error", { error: gate.message });
        sseFrame(res, "done", {});
        return res.end();
      }
    }
  }

  // App-count cap (Pro/Max only, see CODEAGENT_PLAN_APP_LIMITS) — a FRESH
  // build only, and cheaper than assessPrompt (no model call), so it's
  // checked first. Anonymous/free visitors have no session to look a plan
  // up for, so this only ever applies to a signed-in paid owner.
  if (!isFollowUp) {
    const sessionUserForLimit = codeAgentSessionUser(req);
    if (sessionUserForLimit && sessionUserForLimit.wsId && !isAdminEmail(sessionUserForLimit.email)) {
      {
        const planForLimit = await planOfRequest(req);
        const appLimit = CODEAGENT_PLAN_APP_LIMITS[planForLimit];
        if (appLimit) {
          const existing = (await projects.list(owner, 200)).filter((p) => (p.meta || {}).kind === "code");
          if (existing.length >= appLimit) {
            sseFrame(res, "error", {
              error: "Your " + planForLimit + " plan is limited to " + appLimit + (appLimit === 1 ? " app" : " apps") + ". Delete one, or upgrade for more at /pricing."
            });
            sseFrame(res, "done", {});
            return res.end();
          }
        }
      }
    }
  }

  // Ask, don't guess — only for a FRESH build. A follow-up already has an
  // established project; re-litigating "is this clear enough" on every
  // small change would be an annoying tax on someone already mid-build,
  // and there's real context (the current files) a follow-up can lean on
  // that a first prompt doesn't have. No sandbox, no project, no cost
  // beyond one cheap model call for a question nobody asked to see built.
  // This used to also skip the check on any prompt with 5+ words, on the
  // theory that only short prompts can plausibly be vague — but "ARE YOU
  // U SOUQI AGENT" is 5 words and isn't a build request at all; a length
  // cutoff just moves the same failure to whatever phrase happens to sit
  // on the other side of it. assessPrompt's own instructions already say
  // to prefer {clear:true} the moment a prompt shows ANY real build
  // indication, so a long genuine build request still resolves on the
  // first pass — the only thing worth skipping this call for was never
  // "long prompts" in general, it was "obviously-a-build prompts", and
  // the model call itself is what actually tells those apart.
  // Set by the assessment below when the conversation produced more detail
  // than the last message carries on its own.
  /* THE PHOTOS THIS PERSON ATTACHED.
     Resolved once, here, because four separate things downstream need them:
     the assessment (so it does not ask what the shop looks like about a
     photo it was just sent), the plan card, the build prompt, and the
     URL-repair pass that runs over what the model writes.

     listForOwner is the ownership check as well as the lookup — it drops
     anything not owned by this person and anything still pending, so a
     guessed id resolves to nothing rather than to someone else's picture.
     Order is preserved, because the prompt numbers them and "the second
     one" has to mean what the composer showed. */
  const attachedImages = await uploads.listForOwner(
    Array.isArray(req.body && req.body.imageIds) ? req.body.imageIds : [], owner
  );
  /* This build's palette and typeface. Computed once, used three times: the
     Tailwind config the container compiles against, the prompt block, and the
     font link in index.html.

     Seeded from the uploaded logo when there is one, so the site comes out in
     the customer's own colours rather than a theme — otherwise from the build
     type, so a dashboard and a game do not open looking like each other.
     Costs no model call and is deterministic: the same request builds the
     same palette every time. */
  /* Hoisted because the project row stores it: forBuild() returns a palette,
     not its input, so without keeping the seed a reopen cannot reproduce the
     colours an uploaded logo produced. */
  const buildSeedHex = (attachedImages.find((i) => i.seedHex) || {}).seedHex || "";
  const buildTheme = theme.forBuild({
    buildType: String((req.body && req.body.buildType) || ""),
    seedHex: buildSeedHex
  });
  const imagesBlock = buildImagesBlock(attachedImages);
  const imageUrls = attachedImages.map((i) => i.url);

  let conversationBrief = null;
  if (!isFollowUp || buildMode === "plan") {
    /* The conversation so far, as the client has it.

       A fresh chat has no project yet, so there is nothing on the server to
       read the thread from — which is exactly why the agent used to forget
       every answer the moment it asked for one. The client keeps the thread
       and sends it; without this, assessPrompt sees a single orphaned line
       and either asks the same question again or builds without the answer. */
    /* The assessment is for FRESH prompts only. Given "make the button
       green" with no project context it has nothing to judge against and
       answers instead of building — which is what plan mode did to every
       edit when it ran this block too. Plan mode wants the CONFIRM step
       below, not a re-reading of what the person meant. */
    if (!isFollowUp) {
      const convo = Array.isArray(req.body && req.body.conversation)
        ? req.body.conversation.slice(-12)
        : [];
      // How many questions this conversation has already spent.
      const asked = convo.filter(function (m) {
        return m && m.role === "agent" && m.kind === "ask";
      }).length;

      /* A one-line note, not the whole block: the assessment only decides
         build/ask/chat and writes the brief, so it needs to KNOW photos
         arrived — otherwise it asks "what does your shop look like?" about a
         picture it was just handed, which is the most obviously stupid thing
         this product could do. It does not need the URLs or the
         descriptions to make that call. */
      const assessPromptText = attachedImages.length
        ? prompt + "\n\n(" + attachedImages.length + " photo" +
          (attachedImages.length === 1 ? "" : "s") + " attached: " +
          attachedImages.map((i) => i.name).join(", ") + ")"
        : prompt;
      const assessment = await assessPrompt(assessPromptText, { history: convo, asked: asked });
      if (!assessment.clear) {
        /* "ask" and "chat" mean the same thing to the client - show this and
           wait - but not to the person reading it, and the client counts the
           asks to know when the budget is spent. */
        sseFrame(res, "needsAnswer", {
          reply: assessment.reply,
          action: assessment.action || "chat",
          /* Pressable answers when the assessor offered any. Absent is the
             normal case for an open question and for plain chat, and the
             client renders the reply alone then — so an older client, or a
             turn with no options, behaves exactly as before. */
          options: Array.isArray(assessment.options) ? assessment.options : undefined
        });
        sseFrame(res, "done", {});
        return res.end();
      }
      /* What they said ACROSS the conversation, not just the line that tipped
         it into buildable. Without this, the answers given to the agent's own
         questions never reach the thing doing the building. */
      if (assessment.brief) conversationBrief = assessment.brief;
    }

    /* Confirm before building — PLAN MODE ONLY.

       The plan card shows what the agent understood before it spends a
       minute and some credits building it. Plan mode = always show plan/clarify first.
       The client re-POSTs with confirmed:true, which lands here with the gate passed. */
    if (buildMode === "plan" && !(req.body && req.body.confirmed)) {
      const planType = String((req.body && req.body.buildType) || "website");
      let plan = null;
      try {
        // Same reason as the assessment: a plan card that does not mention
        // the photos reads as though they were ignored.
        plan = await buildPlan(imagesBlock ? imagesBlock + prompt : prompt, planType);
      } catch (e) {
        // The confirm step must never become a new way for a build to die.
        plan = null;
      }
      if (plan) {
        try { if (plan.costUsd) await codeAgentUsage.recordSpend(owner, plan.costUsd); } catch (e) {}

        // Model wants to ask clarifying questions before making a plan
        if (plan.needsClarification && plan.questions && plan.questions.length) {
          sseFrame(res, "clarify", {
            questions: plan.questions,
            prompt: prompt, buildType: planType
          });
          sseFrame(res, "done", {});
          return res.end();
        }

        // Full rich plan — send the complete schema to the client
        /* The card carries the approval with it. Whatever the user is
           about to press "Build it" on is what gets signed — the token is
           bound to THIS plan's text, this project, this session and the
           revision the plan was written against, so an edited plan or a
           tree that moved underneath it cannot be executed with it.

           Additive: code.html:2709 stores the confirm payload whole and
           hands it to the plan card, so an extra field rides through
           without the client needing to know about it yet. */
        const planCard = {
          title: plan.title,
          overview: plan.overview,
          phases: plan.phases || [],
          screens: plan.screens || [],
          tech: plan.tech || [],
          assumptions: plan.assumptions || []
        };
        sseFrame(res, "confirm", {
          plan: planCard,
          approvalToken: agentState.issueApproval({
            sessionKey: agentState.sessionKeyOf(owner),
            projectId: project ? project.id : "",
            planVersion: agentState.planVersionOf(planCard),
            revisionId: (project && project.headRevision) || "none"
          }),
          prompt: prompt, buildType: planType
        });
        sseFrame(res, "done", {});
        return res.end();
      }
    }
  }

  /* THE BUILD IS CHARGED HERE: past the confirm step, on a request that is
     going to build.

     It used to be charged the moment assessPrompt decided the prompt was
     clear — which was right when that was the last gate, and became wrong
     the day the confirm step was added after it. A first-time visitor typed
     a prompt, the server spent their one free build, showed them a PLAN, and
     ended the stream. They pressed "Build it", the re-POST arrived with the
     counter already at its limit, and they got the signup wall having never
     seen the product build anything at all.

     Which is the exact failure the note in the old position was written to
     prevent — it said the single free build has to BE a build — reintroduced
     one layer further up. Reproduced against production before this line
     moved, and after it: confirm, then build, then the second build is the
     one that hits the wall.

     Still BEFORE the expensive call, not after. A build that fails has used
     its slot; otherwise a prompt that reliably fails is an unlimited model
     budget. And still only for a fresh build — a follow-up is charged as an
     edit, further up, for the same reason and at the same moment. */
  if (!isFollowUp && !quotaAdmin) {
    await codeAgentUsage.recordAction(quotaOwner, "buildCount");
  }

  // ---- WebContainers flow: server proposes files, client builds ----
  try {
    /* The work that happens before a single file is written was invisible:
       reading the request, deciding it is a build rather than a question,
       and — on a follow-up — loading the app that already exists. All of it
       has already run by this point; none of it was ever said out loud. */
    sseFrame(res, "stage", { id: "read", state: "done",
      detail: project ? "Read your message and the app so far" : "Read your request" });
    if (conversationBrief) {
      sseFrame(res, "stage", { id: "brief", state: "done",
        detail: "Folded the conversation into one brief" });
    }
    sseFrame(res, "stage", { id: "propose", state: "start", detail: project ? "Making the change" : "Writing your app" });
    /* The brief when the conversation produced one, the raw prompt
       otherwise. This is the payoff for asking at all: "a bakery site", "it
       needs online ordering" and "for a small shop" arrive as one instruction
       instead of three messages the builder never saw. */
    let effectivePrompt = conversationBrief || prompt;
    /* Images first, then the instruction — the model should know what it has
       before it is told what to do with it. Prepended rather than appended
       for the same reason: on a long edit prompt the codebase context runs to
       tens of thousands of characters, and a list of photos at the far end of
       that reads as an afterthought. Applies to BOTH paths, which is the
       whole point: the old logo handling sat inside `if (!project)`, so
       attaching a photo to an existing site did nothing at all. */
    if (imagesBlock) effectivePrompt = imagesBlock + effectivePrompt;
    /* The palette goes in front of the request on both paths. The model needs
       to know what it is designing WITH before it is told what to design —
       and a token list buried under thirty thousand characters of codebase
       context reads as trivia rather than as the system to build in. */
    effectivePrompt = theme.promptBlock(buildTheme) + effectivePrompt;
    if (!project) {
      const buildType = String((req.body && req.body.buildType) || "");
      effectivePrompt = effectivePrompt + (CODEAGENT_TYPE_HINT[buildType] || "");
      /* An attached logo used to append a sentence here telling the model the
         file was "already uploaded and saved at src/assets/logo.png".

         It never was. The comment that stood here said the logo is written
         client-side; nothing in public/ writes it — `src/assets/logo` does not
         appear anywhere in the client. The only function that would have,
         attachLogoIfPresent(), was dead code with no caller, left behind by the
         move to WebContainers along with runtime.writeBinaryFile(), which has
         no client counterpart.

         So this was not merely inert, it was load-bearing in the wrong
         direction: the model dutifully imported a file that does not exist,
         Vite failed to resolve it, and the repair loop then spent its two
         rounds on an error no rewrite could fix — a build that could end at
         getFallbackAppCode(), shipping a stock template because the prompt
         lied to it.

         Uploads are being rebuilt properly (images hosted in object storage and
         referenced by URL, which is the only form that survives this
         codebase's text-only revision/deploy contract). Until that lands, the
         honest behaviour is to say nothing about an attachment rather than
         invent a path for it. req.body.logo from an older tab is ignored. */
    }
    let hasExistingEntry = false;
  /* The materialised src/ tree, hoisted out of the follow-up branch because
     edit_file needs it at the proposeWithClientBuild call below. Empty on a
     first build, where there is nothing to edit. */
  let srcFilesForEdit = {};
    if (project) {
      // For follow-ups, give the model the FULL current project code so it
      // can make surgical edits. A one-file app gets its App.tsx; a multi-file
      // app gets every source file. The model needs to see the whole app to
      // change one part without breaking the rest.
      /* materialize, not head. The comment above says "the FULL current
         project code" and head does not provide it: a revision records only
         the files the model wrote that turn — it is told to write "every file
         you create or change", so a follow-up records two files, not twelve.
         The deploy path already replays the chain for exactly this reason.
         Showing the model two files and calling it the codebase is how it
         comes to rewrite an app from the fraction it was shown. */
      const full = await projects.materialize(project.id);
      const files = (full && full.files) || {};
      /* src/ AND the root .html pages, because both are now the model's to
         write. A multi-page site keeps everything it built in about.html,
         menu.html and the rest — filtering to src/ would show the model an
         empty codebase for its own site and invite it to build the whole
         thing again from the request text. The scaffold's own files are
         still excluded: they are fixed, and validateWriteFileArgs refuses
         them anyway. */
      const srcFiles = {};
      for (const [k, v] of Object.entries(files)) {
        if (k.startsWith("src/") || /^[^/]+\.html$/.test(k)) srcFiles[k] = v;
      }
      // Same tree the prompt context is built from, so an exact-match anchor
      // is matching the very text the model was shown.
      srcFilesForEdit = srcFiles;
      /* Whether the project ALREADY has an entry file, which is the only
         thing that makes "this build wrote no App.tsx" safe to judge: a
         follow-up that edits one component legitimately never touches it.

         An incomplete walk counts as "has one". It cannot prove the file is
         absent, only that it could not be reached — and the two mistakes are
         not equal: a missed guard costs one unclear preview, a false one
         makes the model overwrite a working App.tsx it was never shown. */
      hasExistingEntry = !!srcFiles["src/App.tsx"] || !!srcFiles["index.html"] ||
        !(full && full.complete);

      if (Object.keys(srcFiles).length) {
        // buildCodebaseContext fits whole files where it can, marks any
        // excerpt in the prompt itself, and names what it left out. The
        // old inline version cut every file at 8000 chars without saying
        // so, which is how a model came to rewrite a file from the half
        // it had been shown and delete the other half.
        /* Sized from the model's context window rather than a flat
           constant, because the flat one did not fit: at 120,000 chars a
           power build crossed DeepSeek's window on its first repair round
           and came back as a starter template. */
        const ctx = buildCodebaseContext(srcFiles, {
          prompt: prompt,
          budget: codeBudgetChars({ mode: buildMode === "power" ? "power" : "economy" })
        });
        /* This REPLACES effectivePrompt rather than extending it, so the
           images block prepended above would be thrown away here — it has to
           be re-inserted, and this is the better place for it anyway. After
           the code and immediately before the change request, so the photos
           sit next to the instruction that refers to them rather than tens of
           thousands of characters of source away from it. */
        /* WHAT THE PROJECT IS FOR, WHICH A FOLLOW-UP OTHERWISE NEVER LEARNS.

           A follow-up turn is assembled from the palette, the code and the
           new sentence — and nothing else. The original brief is sitting in
           project.prompt, where it has always been stored and never once
           been read on this path. So "make the hero taller" arrives with no
           indication that this is a barber shop in Kadıköy, and the model
           infers the goal from whatever the code budget happened to leave it.
           That is fine when the whole tree fits and progressively less fine
           as it gets excerpted.

           Framed as background and placed BEFORE the change request on
           purpose. The other way round — brief last, nearest the writing —
           is how a request to adjust one component becomes a rebuild of the
           original app, because the most recent instruction the model read
           was the one asking for the whole thing. */
        const brief = String(project.prompt || "").trim().slice(0, 600);
        const briefBlock = brief
          ? "What this project is for, from the first message that started it — background only, not the task:\n" +
            brief + "\n\n"
          : "";

        /* What has broken here before, beside the brief. Both are the
           project talking about itself rather than instructions, and both
           sit before the change request so neither reads as the task. */
        const lessonsBlock = codeMemory.promptBlock(project.memory);
        effectivePrompt = theme.promptBlock(buildTheme) +
          "Here is the current codebase:\n\n" + ctx.text +
          briefBlock + lessonsBlock + imagesBlock + "Change request: " + prompt;
        if (ctx.excerpted.length || ctx.omitted.length) {
          console.warn("[codeagent] context budget hit for " + project.id +
            ": excerpted=" + ctx.excerpted.join(",") + " omitted=" + ctx.omitted.join(","));
        }
      } else {
        // An existing project with nothing under src/ yet. Same reassignment
        // trap as the branch above — keep the images and the palette.
        effectivePrompt = theme.promptBlock(buildTheme) + imagesBlock + prompt;
      }
    }

    /* THE LAST THING THE MODEL READS ABOUT LANGUAGE, AND THE CLOSEST TO THE
       REQUEST ITSELF.

       Sites kept coming back in Turkish from English requests — a barber
       shop with "Hizmetler" and "Randevu al", an expense splitter titled
       "Ev Giderleri". The rule was in the system prompt and said the right
       thing, but it named Turkish four times in the one paragraph governing
       UI copy, as its only worked example. That paragraph also sits tens of
       thousands of characters before the request, behind the entire
       codebase, so the nearest thing to the model when it starts writing
       copy was the example rather than the instruction.

       This does not restate the rule so much as put it where recency makes
       it win, and it names the failure directly: judge the language from the
       request and from nothing else, examples in the instructions included. */
    effectivePrompt += "\n\nLANGUAGE OF THE FINISHED APP: every word a visitor reads — headings, buttons, labels, menu items, form placeholders, alt text, sample data — goes in the same language and script as the change request above. Decide it from the words in that request and nothing else: not from the kind of business, not from a currency, a city or a person's name, and not from any language named as an example elsewhere in your instructions. If the request is genuinely ambiguous, use English.";

    if (isFollowUp && agentRunner.isQuestionOrConversational(prompt)) {
      sseFrame(res, "stage", { id: "question", state: "done", detail: "Thinking..." });
      const answerRes = await aiClient.chat({
        route: "prose",
        messages: [
          {
            role: "system",
            content: "You are an intelligent, helpful human software engineer assisting a user with their web application. The user is asking a question or explanation about what you did, how the code works, or what an error was. Answer them clearly, accurately, and naturally in markdown. Do NOT write code blocks unless explaining a specific snippet."
          }
        ].concat(
          buildHistory(convo),
          [{ role: "user", content: effectivePrompt }]
        ),
        timeoutMs: 45000
      });
      const reply = (answerRes && answerRes.message && answerRes.message.content) || "I am happy to explain. What specific part would you like to know more about?";
      await projects.addTurn(project.id, {
        role: "agent", kind: "text",
        body: reply,
        chatId: chatId
      });
      sseFrame(res, "chitchat", { reply: reply });
      sseFrame(res, "done", {});
      return res.end();
    }

    // canBuild: false means the client is on mobile or a browser that does not
    // support WebContainers (no SharedArrayBuffer). In that case, skip the
    // client-build loop entirely and use proposeChanges (single AI call, no
    // sandbox or build step needed). The files are returned directly and the
    // client stores + previews them via the project's published URL.
    const canBuild = req.body && req.body.canBuild !== false; // default true if omitted (desktop)
    // Derived from buildMode so "power" has exactly one definition.
    /* EFFORT decides the model and the budget; buildMode decides only whether
       a plan card is shown first. They used to be one field, which is why
       choosing Plan silently dropped you back to the weaker model. */
    const effort = effortFor(req.body && req.body.effort, buildMode);
    const agentMode = effort.tier === "power" ? "power" : "economy";
    const thinking = effort.tier === "power";
    /* Reported here and not with the other opening steps: both of these are
       declared on this line, and reading them earlier is a dead-zone throw
       that takes the whole build down with it. */
    sseFrame(res, "stage", { id: "model", state: "done",
      detail: buildMode === "power" ? "Power \u2014 deep reasoning"
        : buildMode === "plan" ? "Plan \u2014 approval before every change"
        : "Auto" });
    const byok = await resolveByok(req, req.body && req.body.provider);

    // MCP is a Powered Souqi capability, and connecting costs a process
    // spawn or an HTTP handshake per configured server — so it happens only
    // when the mode actually asks for it, and never on the Eco path.
    let mcp = mcpClient.EMPTY;
    if (agentMode === "power") {
      try { mcp = await mcpClient.connectAll(); }
      catch (e) { console.warn("[mcp] connect failed, continuing without tools:", e.message); }
      if (mcp.size) {
        sseFrame(res, "stage", {
          id: "mcp", state: "done",
          detail: "Connected " + mcp.size + " MCP tool" + (mcp.size === 1 ? "" : "s")
        });
      }
    }

    const agentOpts = {
      mode: agentMode, byok: byok, thinking: thinking, mcp: mcp,
      /* In the shared bag, not on one call site, for the same reason
         imageUrls is below: the mobile path runs proposeChanges with this
         whole object, and an effort level that only reached the desktop
         build would be a setting that silently did nothing on a phone. */
      /* Passed in the shared bag so BOTH paths get it — the mobile branch
         runs proposeChanges with this same object, and a budget that only
         reached the desktop loop would be a guard that silently did nothing
         on a phone. */
      deadlineAt: turnDeadlineAt,
      effort: effort.id,
      hasExistingEntry: hasExistingEntry,
      /* Here rather than only on the proposeWithClientBuild call, so the
         mobile path gets it too — that branch runs proposeChanges, which
         takes this whole bag. An invented image URL renders as a torn page
         on a phone exactly as it does on a laptop. */
      imageUrls: imageUrls,
      // What was said before this message. The codebase tells the model
      // WHAT the app is; this tells it what the user has been asking for,
      // so "now make it bigger" has something to refer to.
      history: priorTurns,
      onToolCall: (c) => sseFrame(res, "stage", { id: "tool-" + c.name, state: "done", detail: "Used " + c.name }),
      /* One line per file the model wrote. The log used to say "Writing your
         app" and then nothing until it finished, which on a twelve-file app
         is a spinner for a minute with no way to tell whether anything is
         happening. Each of these is a file that exists by the time it is
         reported. */
      onProposal: (p) => {
        for (const c of (p.calls || [])) {
          const lines = String(c.content || "").split("\n").length;
          sseFrame(res, "stage", {
            id: "file-" + p.round + "-" + c.path, state: "done",
            detail: c.path + "  \u00b7  " + lines + " line" + (lines === 1 ? "" : "s")
          });
        }
      }
    };

    let result;
    try {
    if (!canBuild) {
      const attempt = await proposeChanges(effectivePrompt, agentOpts);
      if (!attempt.ok) {
        result = { ok: false, reason: attempt.reason, rounds: 1, costUsd: attempt.costUsd || 0 };
      } else {
        result = { ok: true, calls: attempt.calls, note: attempt.note, rounds: 1, repaired: false, costUsd: attempt.costUsd || 0 };
      }
    } else {
      result = await proposeWithClientBuild(Object.assign({}, agentOpts, {
        userPrompt: effectivePrompt,
        /* The URLs the model is allowed to reference. validateWriteFileArgs
           repairs a mistyped one back to the real image and replaces any
           other remote <img> with a gradient — an invented URL is a
           torn-page icon on a customer's site, and neither tsc nor Vite
           objects to a string, so nothing else would catch it. */
        imageUrls: imageUrls,
        /* What edit_file matches against. The edit path already materialises
           this tree to build the prompt context, so the model is now editing
           exactly the text it was shown — which is the only way an exact-match
           anchor can be expected to hit. Empty on a first build, where there
           is nothing to edit and the tool is unusable by construction. */
        baseFiles: srcFilesForEdit,
        // The level's own repair budget, not a binary derived from the tier.
        maxRounds: effort.rounds,
        onFiles: async (calls) => {
          /* The one phase with nothing to say for itself. The files have
             been written and reported, the round result has not happened
             yet, and in between the browser is installing and compiling —
             which on a cold container is the longest single stretch of the
             whole turn. It read as the log stalling right after the last
             file appeared. */
          sseFrame(res, "stage", {
            id: "build-" + calls.length + "-" + Date.now(), state: "start",
            detail: "Compiling " + calls.length + " file" + (calls.length === 1 ? "" : "s") + " to check it runs"
          });
          // Send proposed files to the client for WebContainer build
          const filesObj = {};
          /* THE ONE IMPORT THE PROMPT MANDATES HAS TO EXIST.

             SYSTEM_PROMPT spends ~15 lines telling the model to import
             ./lib/payments for anything that sells — and PROTECTED_PATHS
             forbids it from writing that file, and wc-runtime.js never
             mounted it. Its scaffold map has main.tsx, App.tsx and index.css
             and nothing else, and the only other thing the container ever
             receives is this frame.

             So every shop, booking fee and donate button failed on
             `Could not resolve "./lib/payments"`, and the repair loop could
             not save it: the single fix is writing a file validation rejects,
             so the model rewrote other things until the rounds ran out and it
             shipped a starter template. build-parser-client.js already calls
             this "the single most common way a generated app fails to build".

             Sent from readScaffold() rather than inlined into wc-runtime.js,
             because a third hand-maintained copy of the scaffold is what
             caused this in the first place — scaffold-data.json stays the one
             source of truth. Written before the model's files so a collision
             still resolves the model's way, matching withScaffold(). */
          for (const p of SCAFFOLD_RUNTIME_FILES) {
            const content = scaffoldAll[p];
            if (typeof content === "string") filesObj[p] = content;
          }
          /* This build's palette and typeface, as a real config the container
             compiles against — not advice in a prompt.

             A token is enforced in a way a hex value in a sentence is not:
             the model writes bg-accent and gets the contrast-checked colour,
             and cannot drift a shade over six files the way it does copying
             hex by hand. It lives outside src/, so the model cannot overwrite
             the palette halfway through its own build. */
          filesObj["tailwind.config.js"] = theme.tailwindConfig(buildTheme);
          /* The typeface has to be fetched by the DOCUMENT, so it cannot ride
             in the Tailwind config — index.html needs the link tag. Sent as a
             marker the client substitutes rather than a whole index.html,
             because that file is the container's own and rewriting it here
             would put a third copy of the scaffold in play. */
          filesObj["__souqi_fonts__"] = theme.fontLinkTag(buildTheme);
          for (const c of calls) filesObj[c.path] = c.content;
          const buildId = crypto.randomBytes(16).toString("hex");
          /* Three minutes was the wait whatever else was going on, which is
             how a single round could eat most of the turn and leave the
             function to be killed during the next one. It still cannot
             exceed three minutes; it just cannot outlive the turn either,
             and 15s is kept in hand so the loop gets the timeout as a
             RESULT rather than having the platform take the process. */
          const msLeft = turnDeadlineAt - Date.now() - 15000;
          if (msLeft <= 5000) {
            return { ok: false, infra: true, errors: [{ file: "", line: 0, col: 0, code: "DEADLINE", message: "Turn deadline reached before browser build feedback." }], raw: "" };
          }
          const buildWaitMs = Math.min(180000, msLeft);
          return new Promise((resolve) => {
            const timer = setTimeout(() => {
              pendingBuildResults.delete(buildId);
              resolve({ ok: false, infra: true, errors: [{ file: "", line: 0, col: 0, code: "INFRA", message: "build timed out (the browser did not report back within " + Math.round(buildWaitMs / 1000) + "s)" }], raw: "" });
            }, buildWaitMs);
            pendingBuildResults.set(buildId, { resolve, timer });
            sseFrame(res, "files", { buildId, files: filesObj });
          });
        },
        onRound: (r) => {
          /* "Fixing 3 issue(s)" says nothing about what is wrong. The errors
             are right here and the first one is almost always the cause of
             the rest, so name it and count the remainder. */
          let detail = "Checked out clean";
          if (!r.ok) {
            const errs = r.errors || [];
            const first = errs[0];
            const where = first && first.file ? first.file.replace(/^src\//, "") + ": " : "";
            const what = first && first.message ? String(first.message).slice(0, 70) : "a build error";
            detail = "Fixing " + where + what + (errs.length > 1 ? "  (+" + (errs.length - 1) + " more)" : "");
          }
          sseFrame(res, "stage", { id: "round-" + r.round, state: "done", detail: detail });
        }
      }));
    }
    } finally {
      // Every MCP server is a live child process or HTTP session. Closing in
      // `finally` and not on the success path is the whole point: a build
      // that throws, or a client that disconnects mid-stream, would otherwise
      // leak one spawned process per request until the box runs out.
      try { mcp.close(); } catch (e) { /* best effort */ }
    }

    // Record spend regardless of outcome — but only what SOUQI paid for.
    // A BYOK build is billed by the provider to the user's own account, so
    // charging it against Souqi's monthly guard as well would bill them
    // twice and could lock them out of a budget they are not spending.
    try { if (!byok) await codeAgentUsage.recordSpend(owner, result.costUsd || 0); } catch(e) {}
    try {
      const masterDbForAudit = getMasterDb();
      if (masterDbForAudit) {
        await writeMasterAudit(masterDbForAudit, {
          requestId: req.id, actor: owner.userId || owner.anonId || "anon",
          action: "codeagent.build", entityId: project ? project.id : null,
          /* "Build" / "Fell back" / "Failed build", three states rather than
             two. result.ok is TRUE when the loop gave up and shipped
             getFallbackAppCode() — a canned starter template with an apology
             attached — so on the old two-state summary a build that exhausted
             every repair round was indistinguishable from one that worked
             first try. That single conflation is why "what fraction of builds
             succeed" had no answer. */
          summary: (result.fellBack ? "Fell back" : result.ok ? "Build" : "Failed build") +
            " — $" + (result.costUsd || 0).toFixed(4),
          meta: {
            costUsd: result.costUsd || 0, ok: result.ok, rounds: result.rounds, isFollowUp,
            mode: agentMode, effort: effort.id, provider: byok ? byok.provider : "souqi", mcpTools: mcp.size,
            /* fellBack was written twice in model-loop.js and read nowhere.
               It is the difference between "worked" and "gave up politely",
               and it belongs in every quality number computed from here on.

               repaired/rounds say how hard it was; promptVersion is what makes
               a prompt change attributable — without it there is no way to
               compare before and after, which is the whole reason none of the
               earlier prompt work could be evaluated. */
            fellBack: !!result.fellBack,
            repaired: !!result.repaired,
            /* Both keep the quality numbers honest. infra separates "our
               sandbox died" from "the agent could not do it" — mixing them
               makes every environment blip look like a model regression.
               verified:false marks a device that cannot compile at all, whose
               ok:true is a formality rather than a passing build; counting
               those as successes would flatter every metric computed here. */
            infra: !!result.infra,
            verified: result.verified !== false,
            promptVersion: PROMPT_VERSION,
            model: byok ? (byok.model || byok.provider) : (agentMode === "power" ? "souqi:power" : "souqi:eco"),
            imagesAttached: attachedImages.length
          }
        });
      }
    } catch(e) {}

    if (!result.ok) {
      /* An environment failure is not the agent failing, and saying so
         matters: "the agent could not produce a working build" sends someone
         off to reword a prompt that was never the problem, when the honest
         answer is that the sandbox in their browser did not start and the
         same request will very likely work on a retry. */
      const infra = !!result.infra;
      sseFrame(res, "stage", { id: "propose", state: "done",
        detail: infra ? "The build environment didn't start" : "Could not finish" });
      sseFrame(res, "error", {
        error: infra
          ? "The build environment didn't start in your browser, so nothing was compiled — this is on our side, not your request. Try again."
          : (result.reason || "the agent could not produce a working build"),
        retryable: infra
      });
      return res.end();
    }
    sseFrame(res, "stage", {
      id: "propose", state: "done",
      detail: result.repaired ? "Fixed it after " + result.rounds + " tries" : "Wrote it in one try"
    });

    // Collect file contents from the last successful proposal for persistence
    const fileContents = {};
    for (const c of result.calls) fileContents[c.path] = c.content;
    /* Pages count too. This filtered to src/ back when src/ was the only
       thing the model could write — left alone it would list a multi-page
       site's components and silently drop every page it actually built. */
    const srcFiles = result.calls.map((c) => c.path)
      .filter((f) => f.startsWith("src/") || /^[^/]+\.html$/.test(f));
    /* How much each file actually moved, measured against the tree this turn
       started from. Without it the card shows a fixed typo and a rewritten
       component as the same thing: a filename. */
    const fileStats = diffstat.statsFor(result.calls, srcFilesForEdit);

    if (!project) {
      const createdBuildType = String((req.body && req.body.buildType) || "website");
      /* The plan's title when the confirm step produced one — it read the
         whole request and named it — and a stripped-down version of the
         prompt otherwise. Never the raw prompt: `prompt.slice(0, 60)` cut
         "build me a football staduim woow 3d animation" mid-word and made
         that the app's name everywhere it appears. */
      const planTitle = String((req.body && req.body.planTitle) || "").trim();
      const newTitle = planTitle.slice(0, 60) || projects.titleFromPrompt(prompt);
      /* seedHex too, so a reopen can rebuild the same palette. Without it a
         project whose colours came from an uploaded logo comes back in the
         build type's default scheme instead of its own. */
      project = await projects.create({ title: newTitle, prompt, meta: { kind: "code", buildType: createdBuildType, seedHex: buildSeedHex }, owner });
    }
    /* The moment the images stop being temporary.
       Until now they carry a 24h TTL, because an upload nobody built with is
       litter. A build has just used them, so their URLs can be inside a
       published site or an exported ZIP from here on and must never expire —
       which is also why deleting the project does not delete them. */
    if (attachedImages.length) {
      try { await uploads.attachToProject(attachedImages.map((i) => i.id), project.id); } catch (e) {}
    }
    await projects.addTurn(project.id, {
      role: "user", kind: "text", body: prompt, chatId: chatId,
      /* addTurn builds a fixed row and drops anything it does not know, so
         without this the thumbnails vanish on reload and a replayed
         conversation shows a message that mentions photos nobody can see. */
      images: attachedImages.map((i) => ({ id: i.id, url: i.url, name: i.name }))
    });
    const revision = await projects.addRevision(
      project.id,
      { files: fileContents },
      result.repaired ? "Fixed after " + result.rounds + " tries" : (isFollowUp ? "Follow-up" : "First build")
    );
    // The model's own explanation leads the turn when there is one, with
    // the mechanical file count after it — that ordering is what makes a
    // replayed transcript read like a conversation rather than a build
    // log. Falls back to the summary alone if the model said nothing.
    const buildSummary = summariseCodeBuild(srcFiles.length, result.repaired, result.rounds, fileStats);
    await projects.addTurn(project.id, {
      role: "agent", kind: "result",
      body: result.note ? result.note + "\n\n" + buildSummary : buildSummary,
      // Persisted, so the +/- beside each file survives a reload: the diff is
      // against the tree as it was before THIS turn, and by the time anyone
      // reopens the project that tree is several revisions gone.
      fileStats: fileStats,
      revisionId: revision.id, chatId: chatId
    });
    /* WHAT THIS PROJECT KEEPS GETTING WRONG.

       The loop repaired these and then dropped them, so a project that
       imports a helper it never wrote on every single turn was
       indistinguishable from one that got it right first time — and paid
       for the lesson again on the next message. Only structural failures
       survive the filter; see memory.js for why a type error is not one.

       Written after the revision and the turn on purpose: it is the least
       important thing on this path, and a failure here must not cost
       someone the build that just succeeded. */
    try {
      const learned = codeMemory.merge(project.memory, result.failures);
      if (learned) await projects.patch(project.id, { memory: learned });
    } catch (e) { /* remembering is a nicety; the build is not */ }

    try { await projects.ensureIndexes(); } catch(e) {}
    try { await codeAgentUsage.ensureIndexes(); } catch(e) {}
    try { await uploads.ensureIndexes(); } catch(e) {}

    // Tell the client to start preview (client-side WebContainer handles this, or standalone mobile fallback)
    sseFrame(res, "result", {
      projectId: project.id, slug: project.slug, files: srcFiles, fileContents: fileContents,
      // Sent alongside `files` rather than replacing it, so a client that
      // has not been updated keeps rendering the plain list it knows.
      fileStats: fileStats,
      previewUrl: "__webcontainer__", // signal to client: use local WebContainer preview or mobile srcdoc
      note: result.note || buildSummary, // the model's own explanation or synthesized summary, shown in the chat
      summary: result.note || buildSummary,
      // What it thinks is worth doing next. Sent even when empty so the
      // client can tell "nothing to suggest" from "an older server that
      // does not send this field" and render accordingly.
      suggestions: Array.isArray(result.suggestions) ? result.suggestions.slice(0, 3) : [],
      repaired: !!result.repaired, rounds: result.rounds, costUsd: result.costUsd || 0
    });
    sseFrame(res, "done", {});
    res.end();
  } catch (e) {
    console.error("codeagent build error:", e.message);
    try { sseFrame(res, "error", { error: e.message || "build failed" }); } catch (e2) { /* response may already be gone */ }
    try { res.end(); } catch (e3) { /* already ended */ }
  }
});

/**
 * GET /api/codeagent/:key
 * Replays a code project's transcript on reload — the point of Phase 7.
 * `previewUrl` is always OUR OWN proxy path (see below), never Daytona's
 * raw domain — `sandboxAlive` tells the caller whether that path will
 * actually resolve right now or needs a resume first.
 */
app.get("/api/codeagent/:key", async (req, res, next) => {
  try {
    const owner = appOwnerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });

    /* ?chat=<id> selects one conversation; without it you get the original
       thread, which is what every link to a project has always opened. */
    const wantChat = req.query.chat === undefined ? projects.MAIN_CHAT : String(req.query.chat).slice(0, 40);
    const [turns, chats, revision] = await Promise.all([
      projects.listTurns(project.id, wantChat),
      projects.listChats(project.id),
      projects.head(project.id)
    ]);
    /* Always false since the move to WebContainers, and now honestly so.

       This used to probe a Daytona sandbox. codeAgentLive() could only return
       a handle when the head revision carried a `sandboxId`, and nothing has
       written that field since builds moved into the browser — its cache was
       populated only by the same function succeeding, so it could never warm
       either. The probe was unreachable behind an `if (live)` that was never
       true.

       The field stays in the response rather than being dropped. Nothing in
       public/ reads it, but removing a key from a JSON response is the kind
       of change that breaks something you cannot see, and a hardcoded false
       costs nothing. */
    const sandboxAlive = false;

    const reopenSrc = await projects.materialize(project.id);

    /* THE PREVIEW IS BLACK ON REOPEN WITHOUT THIS.

       materialize() returns the model's files and only those — a revision
       records what the model wrote, never the scaffold. A build gets away
       with that because the build route ALSO sends the generated
       tailwind.config.js, the font tag and the runtime scaffold files in its
       own frame. Reopening sent neither.

       So a reloaded project mounted src/** into a container still holding
       wc-runtime's placeholder tailwind.config.js — `theme: { extend: {} }`,
       no tokens at all. Every bg-surface, text-ink and bg-accent the model
       wrote then compiled to nothing: no background, no colour, a
       transparent page, and the dark device mockup showing straight through
       it. The app was never dark; it was never styled.

       Recomputed rather than stored, and deterministic for that reason —
       forBuild() maps the same inputs to the same palette every time, so a
       reopened project gets the colours it was built with. */
    const reopenTheme = theme.forBuild({
      buildType: String((project.meta || {}).buildType || "website"),
      seedHex: String((project.meta || {}).seedHex || "")
    });
    const reopenFiles = Object.assign({}, reopenSrc.files);
    if (Object.keys(reopenFiles).length) {
      for (const rp of SCAFFOLD_RUNTIME_FILES) {
        if (typeof scaffoldAll[rp] === "string") reopenFiles[rp] = scaffoldAll[rp];
      }
      reopenFiles["tailwind.config.js"] = theme.tailwindConfig(reopenTheme);
      reopenFiles["__souqi_fonts__"] = theme.fontLinkTag(reopenTheme);
    }

    res.json({
      project: { id: project.id, slug: project.slug, title: project.title, prompt: project.prompt, createdAt: project.createdAt, updatedAt: project.updatedAt },
      turns: turns,
      chats: chats,
      chatId: wantChat,
      // The whole tree, not the last diff — otherwise reopening a project
      // after a follow-up edit renders only the files that edit touched.
      // Pages count too — a multi-page site keeps its markup in about.html
      // and the rest, and this list is what the editor shows.
      files: Object.keys(reopenSrc.files).filter((f) => f.startsWith("src/") || /^[^/]+\.html$/.test(f)),
      fileContents: Object.keys(reopenFiles).length ? reopenFiles : null,
      /* __webcontainer__, the same signal a build sends. It used to name
         /api/codeagent/preview/:slug, which has been a 410 stub since
         previews moved into the browser — showPreview() would have pointed
         the iframe at it and rendered the stub's text. */
      previewUrl: "__webcontainer__", sandboxAlive: sandboxAlive
    });
  } catch (e) { next(e); }
});

/**
 * GET /api/codeagent/preview/:key(/*)
 * A same-origin reverse proxy onto the sandbox's signed Daytona preview
 * URL — the actual fix for two real problems found live, not a
 * workaround for either:
 *
 *   1. Embedding Daytona's raw *.daytonaproxy01.eu domain directly in an
 *      iframe got silently blocked by local security software treating
 *      an unfamiliar domain as suspicious ("This content is blocked.").
 *      Same-origin content the visitor is already using isn't unfamiliar
 *      to anything.
 *   2. The signed preview URL never has to reach the browser at all now
 *      — this process fetches it server-side and streams the response
 *      back under Souqi's own origin, so a leaked/inspected iframe src
 *      reveals nothing that grants access on its own.
 *
 * Owner-gated exactly like every other project read — knowing a slug is
 * not authorisation, same rule as everywhere else this session.
 */
// Preview proxy removed — WebContainers serve previews locally in the browser.
// Kept as a stub to avoid 404s from old bookmarks.
app.get("/api/codeagent/preview/:key", (req, res) => res.status(410).send("Preview is now served locally by WebContainers. Open the project in Souqi Code."));
app.get("/api/codeagent/preview/:key/*", (req, res) => res.status(410).send("Preview is now served locally by WebContainers. Open the project in Souqi Code."));

// Total base64 payload kept comfortably under Mongo's 16MB document cap —
// dist/ is model-written text plus whatever assets it references, and
// nothing here bounds what the model could reference, so this is a real
// guard, not a formality.
const PUBLISH_MAX_BYTES = 12 * 1024 * 1024;

/**
 * POST /api/codeagent/:key/publish
 * Builds the project's current files to a static dist/ and stores it
 * directly on the project doc (Phase 8, scoped down: reuse this server as
 * the "CDN" rather than standing up a new object-storage account before
 * one is needed — see docs/CODE-AGENT-PLAN.md §7). Reuses the exact
 * live-check/resume dance POST /build already does, since publishing an
 * idle project needs the same "sandbox may be gone" handling a follow-up
 * does. Once published the site is served by servePublishedSite() below
 * with NO sandbox involved — the whole point of Phase 8.
 */
app.post("/api/codeagent/:key/publish", codeAgentLimiter, express.json({ limit: "12mb" }), async (req, res, next) => {
  try {
    const owner = appOwnerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });

    const distFiles = req.body && req.body.dist;
    if (!Array.isArray(distFiles) || !distFiles.length) {
      return res.status(400).json({ error: "dist files required — build the project first" });
    }

    /* Measured from the PAYLOAD, not from what the payload says about
       itself. This summed f.size — a number the client sends alongside
       the content and can set to anything — so the cap it enforced was
       whatever the uploader claimed, and the only real ceiling was
       express's own 12mb body limit.

       A limit computed from a value the thing being limited supplies is
       not a limit. */
    const totalBytes = distFiles.reduce(function (n, f) {
      return n + (typeof f.base64 === "string" ? f.base64.length : 0);
    }, 0);
    if (totalBytes > PUBLISH_MAX_BYTES) {
      return res.status(413).json({ error: "this app's build is too large to publish (" + (totalBytes / 1024 / 1024).toFixed(1) + " MB) — trim large assets and try again" });
    }

    const publicSlug = (project.published && project.published.publicSlug) || await projects.uniquePublicSlug(project.slug);
    /* A null prototype, because the keys are paths the client chose. On a
       plain object a file called __proto__ assigns the prototype instead
       of a property and vanishes; on this one it is simply a file called
       __proto__. Nothing downstream can be reached either way —
       servePublishedSite reads with hasOwnProperty — but a file that
       disappears without a word is its own small bug. */
    const filesMap = Object.create(null);
    for (const f of distFiles) {
      if (!f || typeof f.path !== "string" || typeof f.base64 !== "string") continue;
      filesMap[f.path] = f.base64;
    }

    await projects.patch(project.id, {
      published: { publicSlug, files: filesMap, publishedAt: new Date().toISOString(), revisionId: project.headRevision }
    });
    await projects.ensureIndexes();

    res.json({ ok: true, url: "/s/" + publicSlug + "/" });
  } catch (e) {
    console.error("codeagent publish error:", e.message);
    next(e);
  }
});

/* =================================================================
   Deployments — the container deploy plane
   -----------------------------------------------------------------
   Publishing to /s/:slug serves a built dist/ out of Mongo. That works
   for a static bundle and cannot work for anything with a server: no
   Node process, no Python, no runtime at all.

   The deploy plane runs the real thing in a container. It lives in
   deploy/ with its own Postgres, and it is not reachable from the
   internet on purpose, so every call goes through here. See
   lib/deployplane.js for why this proxy exists and what it guarantees.

   The mapping between the two worlds is one field. A Souqi project
   (pr_...) gets a deploy-plane project (prj_...) the first time it is
   deployed, and the id is written back to the Mongo doc. Lazily,
   because most projects are never deployed and creating a row for each
   would be waste.
   ================================================================= */

const deployplane = require("./lib/deployplane");

/* Deploys are expensive — each one builds a Docker image. Rate limited
   harder than a read, and per-IP like the other codeagent limiters. */
const deployLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, key: (req) => req.ip || "" });

/**
 * Resolve a Souqi project the caller owns, or answer for us.
 *
 * Every deploy route starts here. A project id is a handle, never a
 * permission — the same rule the rest of the project routes follow.
 * Returns null when it has already responded.
 */
/**
 * Identity for the dashboard.
 *
 * anon.ownerOf() reads the user only from an Authorization header, and no
 * page in this app sends one — the session lives in a cookie. On a
 * signed-in surface that would resolve every request to the anonymous
 * identity, and a user would not see the projects they own.
 *
 * So the cookie session is folded in. This can only WIDEN what matches:
 * ownerFilter ORs the two identities, and the id comes from a JWT this
 * server signed, so a caller can never gain anything but their own. It is
 * also the same token the deploy plane verifies for itself downstream.
 */
/**
 * Who is asking, on Code's own routes.
 *
 * anon.ownerOf() identifies a signed-in user from the Authorization header
 * ONLY — deliberately (see anon.userOf). A browser does not send that
 * header; it sends cookies. So on any route using anon.ownerOf() directly,
 * a signed-in person arrives as userId:null.
 *
 * That was harmless while their projects were anon-owned, because
 * ownerAnonId still matched. It stopped being harmless the moment those
 * projects were claimed: claimAnon() sets ownerUserId and KEEPS
 * ownerAnonId, while owns() ignores the anon id once a user id exists —
 *
 *     if (project.ownerUserId) return !!owner.userId && ...
 *
 * — so a claimed project is still FOUND (the list and resolveProject match
 * on either id) and then refused. GET /api/codeagent/:key answered 403
 * "not your project" to the owner, and the builder rendered that as
 * "That project isn't here — it may have expired".
 *
 * Reading sq_session here is not a weaker proof than the header: it is the
 * same token, signed with the same secret, rejected the same way if it
 * carries a scope. It is a different transport for it, and the transport
 * is the whole problem — /auth/login sets that cookie httpOnly ON PURPOSE
 * ("so browser clients never keep the token in JS-readable storage"), so
 * the alternative fix, having the page hold the token and send the header,
 * is the thing that comment exists to prevent.
 *
 * The /api/projects/* routes used to be left out of this, on the grounds
 * that microclaim-test.js held a real property there: after a claim, a
 * cookie-only read of /api/projects/:key is refused. It did not hold that
 * property. Its browser jar keeps EVERY Set-Cookie, sq_session included,
 * so the request it called "cookie-only" was carrying a valid session and
 * was refused because anon.ownerOf ignores the session cookie — the very
 * thing being tested, asserted as if it were the finding.
 *
 * What that cost: the dashboard sends no Authorization header (no page in
 * public/ sets one), so once a project was claimed its owner got 403 — or
 * 404, from a browser whose anon id had moved on — from their own
 * Rename, Delete, Details and Connect-GitHub. Measured against the
 * running server, not inferred.
 *
 * So those routes resolve through here now, and the test was rewritten to
 * hold the property it meant: a request carrying the anon cookie AND NO
 * SESSION must still be refused. That is strictly stronger, and it is the
 * one this function preserves — sq_anon can never fill in userId, only a
 * scope-free token this server signed can.
 *
 * Claiming stays on anon.ownerOf: /claim and /micro-claim exist to ask
 * "is this the visitor who built it", which is a question about the
 * anonymous identity and nothing else.
 */
function appOwnerOf(req, res) {
  const owner = anon.ownerOf(req, res);
  if (!owner.userId) {
    const s = codeAgentSessionUser(req);
    // A scope-carrying token is an edit/anon grant, not a session — the
    // same check anon.userOf() makes on the header.
    if (s && s.id && !s.scope) { owner.userId = s.id; owner.email = s.email || owner.email; }
  }
  return owner;
}

// The deploy routes' original name for exactly this.
const deployOwnerOf = appOwnerOf;

async function ownedProjectOr404(req, res) {
  const owner = deployOwnerOf(req, res);
  const project = await resolveProject(req.params.key, owner);
  if (!project) { res.status(404).json({ error: "project not found" }); return null; }
  if (!projects.owns(project, owner)) { res.status(403).json({ error: "not your project" }); return null; }
  return project;
}

/* The deploy plane identifies the user from the same session cookie
   this request arrived with, so it is forwarded verbatim. */
const cookieOf = (req) => req.headers.cookie || "";

/** Answer a failed deploy-plane call without leaking its internals. */
function planeError(res, r) {
  return res.status(r.status || 502).json({ error: r.error || "the deployment service failed" });
}

/**
 * GET /api/deploy/overview
 * Everything the dashboard needs for its first paint: the caller's
 * projects, the deploy status of the ones that have been deployed, and
 * host capacity. One request rather than N+1 from the browser.
 */
app.get("/api/deploy/overview", async (req, res, next) => {
  try {
    if (!deployplane.isConfigured()) {
      return res.json({ configured: false, projects: [], capacity: null });
    }
    const owner = deployOwnerOf(req, res);
    const cookie = cookieOf(req);
    const mine = await projects.list(owner, 100);   // list() caps at 100 anyway

    // Only projects that have actually been deployed have anything to
    // ask about, so only those cost a request.
    const rows = await Promise.all(mine.map(async (p) => {
      const row = {
        key: p.slug || p.id, id: p.id, title: p.title, slug: p.slug,
        buildType: (p.meta || {}).buildType || null,
        updatedAt: p.updatedAt,
        deployProjectId: p.deployProjectId || null,
        deploymentId: p.deploymentId || null,
        status: null, url: null, error: null, container: null
      };
      if (!p.deploymentId) return row;
      const s = await deployplane.getStatus(cookie, p.deploymentId);
      if (s.ok && s.body) {
        row.status = s.body.status; row.url = s.body.url;
        row.error = s.body.error; row.container = s.body.container;
      }
      return row;
    }));

    const cap = await deployplane.capacity(cookie);
    res.json({ configured: true, projects: rows, capacity: cap.ok ? cap.body : null });
  } catch (e) { next(e); }
});

/**
 * POST /api/deploy/:key/deploy
 *
 * Creates the deploy-plane project on first use, uploads the current
 * source, and queues a build. Note the deploy plane queues on create —
 * calling its /deploy afterwards answers 409 — so this does not.
 */
app.post("/api/deploy/:key/deploy", deployLimiter, async (req, res, next) => {
  try {
    if (!deployplane.isConfigured()) {
      return res.status(503).json({ error: "deployments are not available in this environment" });
    }
    const project = await ownedProjectOr404(req, res); if (!project) return;

    // Before any work on the deploy plane: a refusal after createProject()
    // would leave an orphan project there for an app that never shipped.
    const refused = await deployAllowance(req, project);
    if (refused) return res.status(refused.status).json(refused.body);
    const cookie = cookieOf(req);

    // The source is the head revision's file map, which is already
    // {path: contents} — the exact shape the deploy plane wants.
    // materialize(), not head(). A revision stores only what the model
    // wrote that turn — it is told to write "every file you create or
    // change", so a follow-up records two files, not twelve. head() is
    // therefore the last diff, and deploying it would ship whichever
    // files happened to change most recently. materialize() replays the
    // revision chain to rebuild the whole tree.
    const src = await projects.materialize(project.id);
    const files = src.files;
    if (!files || !Object.keys(files).length) {
      return res.status(400).json({ error: "this project has no source to deploy yet — build it first" });
    }
    if (!src.complete) {
      // The walk could not reach a root: MAX_REVISIONS pruned an ancestor,
      // and a file written once and never touched again lived only there.
      // Shipping a knowingly partial tree would build the wrong app.
      return res.status(409).json({
        error: "this project's early history has been pruned, so its full source cannot be rebuilt — make an edit that rewrites the app, then deploy"
      });
    }

    // A revision holds only the model's half of the project: it is told
    // not to write index.html, package.json, vite.config.ts or the rest,
    // and PROTECTED_PATHS enforces that. Uploading it alone handed the
    // deploy plane a tree with no package.json and no index.html, and it
    // answered "could not work out how to build this project" — which was
    // correct, because there was nothing there to build. The WebContainer
    // never hit this: it mounts the scaffold and writes the model's files
    // over it, which is the same precedence used here.
    const source = scaffoldFiles.withScaffold(files);

    /* Nothing leaves for the deploy plane before this.
       A deployed app is built and served on a public hostname, so anything
       committed into it is published — and the most likely way that happens
       is the model helpfully inlining a key the user pasted into chat.
       Blocking here rather than after the upload means the credential never
       reaches the plane's object storage, where it would survive the delete
       that the user would reasonably assume undid it.

       It scans `source`, not `files`: the scaffold is what actually ships
       alongside them, and "we scan what we upload" is the only claim worth
       making. secretscan-test.js asserts the scaffold is clean, because a
       rule firing on it would block every deploy on the platform at once. */
    const scanned = secretscan.scan(source);
    if (scanned.blocked) {
      return res.status(422).json({
        error: "this app has a credential in its source, so it was not deployed — " +
          secretscan.summarize(scanned),
        // Masked in the scanner. This body is rendered in a browser and ends
        // up in logs, so it must not carry the secret it is reporting.
        issues: scanned.findings.filter((f) => f.severity === "high").slice(0, 10)
      });
    }

    let deployProjectId = project.deployProjectId;
    if (!deployProjectId) {
      const created = await deployplane.createProject(cookie, project.title || project.slug || "souqi-app");
      if (!created.ok) return planeError(res, created);
      deployProjectId = created.body && created.body.projectId;
      if (!deployProjectId) return res.status(502).json({ error: "the deployment service returned no project id" });
      await projects.patch(project.id, { deployProjectId: deployProjectId });
    }

    // The name the user chose in Configure, if they got that far. The plane
    // falls back to app-<id> when this is absent, so a project that skipped
    // Configure deploys exactly as it did before.
    //
    // Only sent on the FIRST deployment: a hostname is allocated at create
    // and reused by every redeploy, so renaming a live app is a different
    // operation than this one and does not belong here.
    const wantedName = (project.deployConfig && project.deployConfig.subdomain) || null;
    const dep = await deployplane.createDeployment(cookie, deployProjectId, wantedName);
    if (!dep.ok) return planeError(res, dep);
    const deploymentId = dep.body && dep.body.deploymentId;

    const up = await deployplane.uploadSource(cookie, deploymentId, source);
    if (!up.ok) return planeError(res, up);

    // Remember the current deployment so the dashboard and a page
    // reload can both find it without searching.
    /* And it stops expiring. A live container outlives the 30-day TTL, so
       leaving it set means the project record vanishes while the app is
       still serving traffic — source, logs and the only way to redeploy
       it, gone, with the site still up. */
    await projects.patch(project.id, { deploymentId: deploymentId, expiresAt: null });

    res.status(202).json({
      ok: true, deploymentId: deploymentId, status: "QUEUED",
      url: dep.body && dep.body.url,
      detected: up.body && up.body.detected,
      files: up.body && up.body.files
    });
  } catch (e) { next(e); }
});

/**
 * GET /api/deploy/name-available?name=my-shop
 *
 * Live check while the Configure field is being typed. Advisory: the plane's
 * partial unique index on deployments(domain) is what actually decides, since
 * a name can be taken between this answer and the deploy.
 *
 * Declared BEFORE /api/deploy/:key/... — Express matches in order, and
 * "name-available" would otherwise be read as a project key.
 */
app.get("/api/deploy/name-available", async (req, res, next) => {
  try {
    if (!deployplane.isConfigured()) {
      return res.status(503).json({ error: "deployments are not available in this environment" });
    }
    const r = await deployplane.nameAvailable(cookieOf(req), String(req.query.name || ""));
    if (!r.ok) return planeError(res, r);
    res.json(r.body);
  } catch (e) { next(e); }
});

/**
 * PUT /api/deploy/:key/config   { subdomain?, dbMode?, dbUrl? }
 *
 * The choices made in Configure BEFORE anything exists on the deploy plane.
 *
 * They have to live here rather than there: the plane keys env and database
 * off deployProjectId and deployments off deploymentId, and neither id exists
 * until the first deploy — which is exactly the moment these choices need to
 * be known. So they are held on the project document and applied during the
 * deploy call, which creates the plane project first and therefore has the
 * ids by the time they are needed.
 */
app.put("/api/deploy/:key/config", async (req, res, next) => {
  try {
    const project = await ownedProjectOr404(req, res); if (!project) return;
    const body = req.body || {};
    const cfg = Object.assign({}, project.deployConfig || {});

    if (body.subdomain !== undefined) {
      const raw = String(body.subdomain || "").trim().toLowerCase();
      if (!raw) {
        cfg.subdomain = null;                       // back to a generated name
      } else {
        // Shape is checked again on the plane, which owns the reserved list and
        // the uniqueness index. This is the early, friendly copy of that answer.
        if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(raw) || raw.length < 3) {
          return res.status(400).json({ error: "use 3-63 lowercase letters, numbers or hyphens" });
        }
        if (project.deploymentId) {
          return res.status(409).json({
            error: "this app already has an address — a name can only be chosen before the first deploy"
          });
        }
        cfg.subdomain = raw;
      }
    }

    // Accepted and stored, but still read by nothing. External databases do
    // work now — the deploy plane gives each one a one-target forwarder — but
    // the mode that matters is the one on project_databases, set with a
    // connection string through the Database panel. This stays here for the
    // pre-deploy flow that would set both at once, and Configure deliberately
    // does not render it as a choice until then.
    if (body.dbMode !== undefined) {
      if (body.dbMode !== "builtin" && body.dbMode !== "external") {
        return res.status(400).json({ error: "dbMode must be builtin or external" });
      }
      cfg.dbMode = body.dbMode;
    }

    await projects.patch(project.id, { deployConfig: cfg });
    res.json({ ok: true, config: { subdomain: cfg.subdomain || null, dbMode: cfg.dbMode || "builtin" } });
  } catch (e) { next(e); }
});

/**
 * GET /api/deploy/:key/config — what Configure renders from.
 *
 * `locked` says the address can no longer change, which is true the moment a
 * deployment exists. The UI needs that to decide between an editable field and
 * a fact, and answering it here keeps that rule in one place.
 */
app.get("/api/deploy/:key/config", async (req, res, next) => {
  try {
    const project = await ownedProjectOr404(req, res); if (!project) return;
    const cfg = project.deployConfig || {};
    res.json({
      subdomain: cfg.subdomain || null,
      dbMode: cfg.dbMode || "builtin",
      locked: !!project.deploymentId,
      suggestion: projects.slugify(project.title || "my-app").slice(0, 40) || "my-app",
      appDomain: process.env.DEPLOY_APP_DOMAIN || "souqi.site"
    });
  } catch (e) { next(e); }
});

/**
 * Custom domains. All three need a deployment to exist, because the DNS
 * record we ask the customer to create points at the app's generated
 * hostname — which is allocated at create and does not exist before it.
 */
app.put("/api/deploy/:key/domain", async (req, res, next) => {
  try {
    const project = await ownedProjectOr404(req, res); if (!project) return;
    if (!project.deploymentId) {
      return res.status(409).json({ error: "deploy the app once first, so there is an address to point at" });
    }
    const r = await deployplane.attachDomain(cookieOf(req), project.deploymentId,
      String((req.body && req.body.domain) || ""));
    if (!r.ok) return planeError(res, r);
    res.json(r.body);
  } catch (e) { next(e); }
});

app.post("/api/deploy/:key/domain/verify", async (req, res, next) => {
  try {
    const project = await ownedProjectOr404(req, res); if (!project) return;
    if (!project.deploymentId) return res.status(409).json({ error: "no domain is attached" });
    const r = await deployplane.verifyDomain(cookieOf(req), project.deploymentId);
    if (!r.ok) return planeError(res, r);
    res.json(r.body);
  } catch (e) { next(e); }
});

app.delete("/api/deploy/:key/domain", async (req, res, next) => {
  try {
    const project = await ownedProjectOr404(req, res); if (!project) return;
    if (!project.deploymentId) return res.json({ ok: true });
    const r = await deployplane.detachDomain(cookieOf(req), project.deploymentId);
    if (!r.ok) return planeError(res, r);
    res.json(r.body);
  } catch (e) { next(e); }
});

/** GET /api/deploy/:key/status - what the dashboard polls. */
app.get("/api/deploy/:key/status", async (req, res, next) => {
  try {
    const project = await ownedProjectOr404(req, res); if (!project) return;
    if (!project.deploymentId) return res.json({ status: null, deployed: false });
    const r = await deployplane.getStatus(cookieOf(req), project.deploymentId);
    if (!r.ok) return planeError(res, r);
    res.json(Object.assign({ deployed: true, deploymentId: project.deploymentId }, r.body));
  } catch (e) { next(e); }
});

/** GET /api/deploy/:key/logs?phase=build|runtime&tail=N */
app.get("/api/deploy/:key/logs", async (req, res, next) => {
  try {
    const project = await ownedProjectOr404(req, res); if (!project) return;
    if (!project.deploymentId) return res.json({ phase: "build", lines: [] });
    const phase = req.query.phase === "runtime" ? "runtime" : "build";
    const tail = Math.min(Number(req.query.tail) || 500, 2000);
    const r = await deployplane.getLogs(cookieOf(req), project.deploymentId, phase, tail);
    // A 503 here means the worker is down. That is worth showing as-is
    // rather than as an empty log, which would read as "nothing
    // happened" when the truth is "nobody could look".
    if (!r.ok) return planeError(res, r);
    res.json(r.body);
  } catch (e) { next(e); }
});

/**
 * POST /api/deploy/:key/:action  — redeploy | stop | start | restart
 *
 * The action is checked against a fixed list before it goes anywhere
 * near a URL. These answer 202: the deploy plane queues them for the
 * worker that holds the Docker socket, so "accepted" is the honest
 * answer and the client polls for the outcome.
 */
app.post("/api/deploy/:key/:action", deployLimiter, async (req, res, next) => {
  try {
    const name = String(req.params.action || "");
    if (["redeploy", "stop", "start", "restart"].indexOf(name) < 0) {
      return res.status(404).json({ error: "unknown action" });
    }
    const project = await ownedProjectOr404(req, res); if (!project) return;
    if (!project.deploymentId) return res.status(400).json({ error: "this project has not been deployed yet" });

    // A redeploy must ship the CURRENT source, not whatever was staged
    // last time — otherwise the button silently rebuilds a stale tree.
    if (name === "redeploy") {
      // Same reasoning as the first deploy: the head revision is a diff.
      const src = await projects.materialize(project.id);
      const files = src.files;
      if (files && Object.keys(files).length && src.complete) {
        // Same merge as the first deploy — a redeploy shipping only the
        // model's half would fail detection in exactly the same way.
        const source = scaffoldFiles.withScaffold(files);

        // And the same gate. A redeploy publishes exactly as hard as a first
        // deploy; checking only the first one would leave the obvious way
        // round it open.
        const scanned = secretscan.scan(source);
        if (scanned.blocked) {
          return res.status(422).json({
            error: "this app has a credential in its source, so it was not redeployed — " +
              secretscan.summarize(scanned),
            issues: scanned.findings.filter((f) => f.severity === "high").slice(0, 10)
          });
        }

        const up = await deployplane.uploadSource(cookieOf(req), project.deploymentId, source);
        if (!up.ok) return planeError(res, up);
      }
    }

    const r = await deployplane.action(cookieOf(req), project.deploymentId, name);
    if (!r.ok) return planeError(res, r);
    res.status(202).json(Object.assign({ ok: true, action: name, pending: true }, r.body));
  } catch (e) { next(e); }
});

/**
 * DELETE /api/deploy/:key
 * Destructive, so it uses the verified session — the variant that
 * checks sessionEpoch, so a revoked token cannot tear down an app.
 * Same rule the account routes follow.
 */
app.delete("/api/deploy/:key", async (req, res, next) => {
  try {
    if (!codeAgentSessionUserVerified) return res.status(500).json({ error: "session check unavailable" });
    const user = await codeAgentSessionUserVerified(req);
    if (!user) return res.status(401).json({ error: "sign in to delete a deployment" });

    const project = await ownedProjectOr404(req, res); if (!project) return;
    if (!project.deploymentId) return res.status(400).json({ error: "this project has not been deployed yet" });

    const r = await deployplane.destroy(cookieOf(req), project.deploymentId);
    if (!r.ok) return planeError(res, r);
    // The deployment id is cleared here, but deployProjectId is kept:
    // the deploy-plane project survives a deleted deployment and
    // re-creating it would orphan the old one.
    await projects.patch(project.id, { deploymentId: null });
    res.status(202).json({ ok: true, pending: true });
  } catch (e) { next(e); }
});

/* ---- environment variables ---- */

app.get("/api/deploy/:key/env", async (req, res, next) => {
  try {
    const project = await ownedProjectOr404(req, res); if (!project) return;
    if (!project.deployProjectId) return res.json({ env: [] });
    const r = await deployplane.getEnv(cookieOf(req), project.deployProjectId);
    if (!r.ok) return planeError(res, r);
    res.json(r.body);
  } catch (e) { next(e); }
});

app.put("/api/deploy/:key/env", async (req, res, next) => {
  try {
    const project = await ownedProjectOr404(req, res); if (!project) return;
    if (!project.deployProjectId) return res.status(400).json({ error: "deploy this project once before setting variables" });
    const r = await deployplane.putEnv(cookieOf(req), project.deployProjectId, req.body || {});
    if (!r.ok) return planeError(res, r);
    res.json(r.body);
  } catch (e) { next(e); }
});

app.delete("/api/deploy/:key/env/:name", async (req, res, next) => {
  try {
    const project = await ownedProjectOr404(req, res); if (!project) return;
    if (!project.deployProjectId) return res.status(400).json({ error: "nothing to remove" });
    const r = await deployplane.deleteEnvKey(cookieOf(req), project.deployProjectId, req.params.name);
    if (!r.ok) return planeError(res, r);
    res.json(r.body);
  } catch (e) { next(e); }
});

/* ---- the app's database ----
   A project that has never deployed has no database yet, and that is not
   an error — the plane creates one on the first deploy. These answer with
   an honest "not yet" rather than a 400, so the panel can say so. */

app.get("/api/deploy/:key/database", async (req, res, next) => {
  try {
    const project = await ownedProjectOr404(req, res); if (!project) return;
    if (!project.deployProjectId) {
      return res.json({
        database: {
          configured: false,
          mode: "builtin",
          note: "a database will be created for this project on its first deploy"
        }
      });
    }
    const r = await deployplane.getDatabase(cookieOf(req), project.deployProjectId);
    if (!r.ok) return planeError(res, r);
    res.json(r.body);
  } catch (e) { next(e); }
});

app.put("/api/deploy/:key/database", async (req, res, next) => {
  try {
    const project = await ownedProjectOr404(req, res); if (!project) return;
    if (!project.deployProjectId) {
      return res.status(400).json({ error: "deploy this project once before choosing a database" });
    }
    const r = await deployplane.setDatabase(cookieOf(req), project.deployProjectId, req.body || {});
    if (!r.ok) return planeError(res, r);
    res.json(r.body);
  } catch (e) { next(e); }
});

app.post("/api/deploy/:key/database/measure", async (req, res, next) => {
  try {
    const project = await ownedProjectOr404(req, res); if (!project) return;
    if (!project.deployProjectId) return res.status(400).json({ error: "this project has no database yet" });
    const r = await deployplane.measureDatabase(cookieOf(req), project.deployProjectId);
    if (!r.ok) return planeError(res, r);
    res.json(r.body);
  } catch (e) { next(e); }
});

/**
 * GET /api/deploy/:key/database/browse            — the tables
 * GET /api/deploy/:key/database/browse?table=x    — one page of one table
 *
 * The data browser behind the Data tab. Read-only: the query string names
 * a table and a page and cannot express anything else, and the plane
 * resolves the table against its own catalogue before it builds SQL.
 */
app.get("/api/deploy/:key/database/browse", async (req, res, next) => {
  try {
    const project = await ownedProjectOr404(req, res); if (!project) return;
    if (!project.deployProjectId) return res.json({ ok: true, tables: [] });
    const r = await deployplane.browseDatabase(cookieOf(req), project.deployProjectId, {
      table: req.query.table ? String(req.query.table) : null,
      limit: req.query.limit,
      offset: req.query.offset
    });
    if (!r.ok) return planeError(res, r);
    res.json(r.body);
  } catch (e) { next(e); }
});

app.delete("/api/deploy/:key/database", async (req, res, next) => {
  try {
    const project = await ownedProjectOr404(req, res); if (!project) return;
    if (!project.deployProjectId) return res.status(400).json({ error: "this project has no database" });
    const r = await deployplane.dropBuiltinDatabase(cookieOf(req), project.deployProjectId);
    if (!r.ok) return planeError(res, r);
    res.status(202).json(r.body || { ok: true, pending: true });
  } catch (e) { next(e); }
});

/**
 * POST /api/codeagent/:key/export-android
 * Generates a downloadable Capacitor-wrapped Android project ZIP from
 * the published dist/ files. No Android SDK needed on the server — the
 * ZIP contains everything the user needs to build locally with
 * `npx cap sync && npx cap open android` or on CI with Gradle.
 */
app.post("/api/codeagent/:key/export-android", codeAgentLimiter, async (req, res, next) => {
  try {
    const owner = appOwnerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });
    if (!project.published || !project.published.files) {
      return res.status(409).json({ error: "publish this project first, then export as an app" });
    }

    const archiver = require("archiver");
    const appName = project.title || "Souqi App";
    const appId = "com.souqi.app." + (project.slug || "app").replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 30);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="' + (project.slug || "app") + '-android.zip"');

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.pipe(res);

    // package.json with Capacitor deps
    archive.append(JSON.stringify({
      name: appId,
      version: "1.0.0",
      private: true,
      scripts: {
        "cap:init": "npx cap sync android",
        "cap:open": "npx cap open android",
        "cap:build": "cd android && ./gradlew assembleDebug"
      },
      dependencies: {
        "@capacitor/core": "^6.0.0",
        "@capacitor/android": "^6.0.0",
        "@capacitor/cli": "^6.0.0"
      }
    }, null, 2), { name: "package.json" });

    // capacitor.config.ts
    archive.append(`import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: '${appId}',
  appName: ${JSON.stringify(appName)},
  webDir: 'dist',
  server: {
    androidScheme: 'https'
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: '#1aa6df',
      showSpinner: false
    }
  }
};

export default config;
`, { name: "capacitor.config.ts" });

    // tsconfig.json for capacitor.config.ts
    archive.append(JSON.stringify({
      compilerOptions: { target: "ES2020", module: "ESNext", moduleResolution: "node", esModuleInterop: true }
    }, null, 2), { name: "tsconfig.json" });

    // README with build instructions
    archive.append(`# ${appName} — Android App

This is a Capacitor-wrapped Android project generated by Souqi Code.

## Prerequisites

- **Node.js** 18+ (https://nodejs.org)
- **Android Studio** (https://developer.android.com/studio)
- **Java JDK 17** (usually bundled with Android Studio)

## Quick Start

\`\`\`bash
# 1. Install dependencies
npm install

# 2. Add the Android platform
npx cap add android

# 3. Sync web assets to Android
npx cap sync android

# 4. Open in Android Studio (build + run from there)
npx cap open android
\`\`\`

## Build APK from Command Line

\`\`\`bash
cd android
./gradlew assembleDebug
\`\`\`

The APK will be at: \`android/app/build/outputs/apk/debug/app-debug.apk\`

## Build Release APK

1. Generate a keystore: \`keytool -genkey -v -keystore release.keystore -alias app -keyalg RSA -keysize 2048\`
2. Build: \`cd android && ./gradlew assembleRelease\`

---
Generated by [Souqi Code](https://souqi.site)
`, { name: "README.md" });

    // Write the published dist/ files (decode from base64)
    const pubFiles = project.published.files;
    for (const [filePath, base64Content] of Object.entries(pubFiles)) {
      archive.append(Buffer.from(base64Content, "base64"), { name: "dist/" + filePath });
    }

    await archive.finalize();
  } catch (e) {
    console.error("codeagent export-android error:", e.message);
    if (!res.headersSent) next(e);
  }
});
/**
 * POST /api/codeagent/:key/domain
 * Body: { domain: "app.yourbrand.com" | "" }
 * Set or clear a custom domain for an already-published project. Same
 * trust model as Sites' /api/ws/:id/domain (db-adapters.js's
 * findWorkspaceByDomain) — the stored field is the only check, no separate
 * verification flow, see projects.js's findByCustomDomain for why that's
 * fine: setting it is already owner-gated, and a domain not actually
 * pointed at Souqi's DNS sends this server no traffic regardless of what's
 * stored here.
 */
app.post("/api/codeagent/:key/domain", codeAgentLimiter, async (req, res, next) => {
  try {
    const owner = appOwnerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });
    if (!project.published) return res.status(409).json({ error: "publish this project first, then connect a domain" });

    const raw = String((req.body && req.body.domain) || "").toLowerCase().trim();
    if (!raw) {
      await projects.patch(project.id, { published: Object.assign({}, project.published, { customDomain: null }) });
      return res.json({ ok: true, domain: null });
    }
    if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(raw)) {
      return res.status(400).json({ error: "that doesn't look like a valid domain (e.g. app.yourbrand.com)" });
    }
    /* Not a name we already own. Without this a published project could
       claim souqi.site itself and be served in the platform's place. */
    if (isPlatformZone(raw)) {
      return res.status(400).json({ error: "that domain belongs to Souqi — use one you control" });
    }
    const clash = await projects.findByCustomDomain(raw);
    if (clash && clash.id !== project.id) {
      return res.status(409).json({ error: "that domain is already connected to a different project" });
    }
    await projects.patch(project.id, { published: Object.assign({}, project.published, { customDomain: raw }) });
    await projects.ensureIndexes();
    res.json({ ok: true, domain: raw, target: process.env.PLATFORM_HOST || "app.souqi.site" });
  } catch (e) { next(e); }
});

/** GET /api/codeagent/:key/domain/status — a live DNS check, informational
    only (not a security gate, see above) — tells the UI whether the
    domain's DNS has actually started pointing at Souqi yet, for a real
    "waiting for DNS" vs "live" state instead of a static instructions page. */
app.get("/api/codeagent/:key/domain/status", async (req, res, next) => {
  try {
    const owner = appOwnerOf(req, res);
    const project = await resolveProject(req.params.key, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });
    const domain = project.published && project.published.customDomain;
    if (!domain) return res.json({ domain: null, live: false });

    const target = (process.env.PLATFORM_HOST || "app.souqi.site").toLowerCase();
    let live = false;
    try {
      const cnames = await dns.promises.resolveCname(domain).catch(() => []);
      live = cnames.some((r) => r.toLowerCase().replace(/\.$/, "") === target);
      if (!live) {
        // Some DNS providers flatten a CNAME-at-apex into A records instead
        // — compare resolved IPs so a correctly-configured apex domain
        // doesn't read as "not live" just for not literally being a CNAME.
        const [domainIps, targetIps] = await Promise.all([
          dns.promises.resolve4(domain).catch(() => []),
          dns.promises.resolve4(target).catch(() => [])
        ]);
        live = domainIps.length > 0 && targetIps.some((ip) => domainIps.includes(ip));
      }
    } catch (e) { live = false; }
    res.json({ domain, live, target });
  } catch (e) { next(e); }
});

/**
 * GET /s/:slug(/*) — a published Souqi Code app: static files served
 * straight from Mongo, no sandbox involved and no owner check at all —
 * this is the PUBLISHED artifact, same public trust model as Sites'
 * storefront pages (§7: "the published site is static, permanent, and
 * costs ~nothing"). Unknown paths fall back to index.html, matching how
 * a client-side-routed SPA is expected to be served.
 */
const PUBLISHED_MIME = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  // Every generated app is now a PWA (vite-plugin-pwa in the scaffold) — a
  // published site needs the correct manifest MIME or "Add to Home Screen"
  // silently fails to detect it as installable in some browsers.
  ".webmanifest": "application/manifest+json"
};
function mimeForPath(p) {
  const dot = p.lastIndexOf(".");
  return (dot >= 0 && PUBLISHED_MIME[p.slice(dot).toLowerCase()]) || "application/octet-stream";
}
async function servePublishedSite(req, res, subPath, projectOverride) {
  try {
    const project = projectOverride || await projects.findPublished(req.params.slug);
    const files = project && project.published && project.published.files;
    if (!files) return res.status(404).send("Not found");

    let key = subPath || "index.html";
    if (!Object.prototype.hasOwnProperty.call(files, key)) key = "index.html";
    if (!Object.prototype.hasOwnProperty.call(files, key)) return res.status(404).send("Not found");

    res.setHeader("Content-Type", mimeForPath(key));
    res.setHeader("Cache-Control", "public, max-age=300");

    // A published app needs to know which app it IS before it can ask what it
    // sells or start a checkout. Injected at serve time rather than baked in
    // at build time: the id then comes from the project actually being served,
    // so it cannot drift, cannot be stale in a cached bundle, and needs no
    // templating step in the scaffold. src/lib/payments.ts reads this.
    if (key === "index.html") {
      const html = Buffer.from(files[key], "base64").toString("utf8");
      const origin = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "") || (req.protocol + "://" + req.get("host"));
      // JSON.stringify handles the escaping; the two values are a server-minted
      // id and our own origin, never anything a visitor supplied.
      const tag = "<script>window.__SOUQI_APP__=" +
        JSON.stringify({ id: project.id, origin: origin }).replace(/</g, "\\u003c") +
        ";</script>";
      const idx = html.indexOf("</head>");
      res.send(idx >= 0 ? html.slice(0, idx) + tag + html.slice(idx) : tag + html);
      return;
    }
    res.send(Buffer.from(files[key], "base64"));
  } catch (e) {
    console.error("published site serve error:", e.message);
    res.status(500).send("Server error");
  }
}
app.get("/s/:slug", (req, res) => servePublishedSite(req, res, ""));
app.get("/s/:slug/*", (req, res) => servePublishedSite(req, res, req.params[0]));


/* ---- guard: only allow known collections through the generic CRUD ----

   The collection side was always an allowlist. The PAGE fallback under it
   was not: it joined req.params.c straight onto a directory and handed the
   result to sendFile. A route parameter is one path segment in the URL,
   but Express decodes it, and %2f decodes to a slash — so

     GET /..%2fserver%2flib%2fcodeagent%2fscaffold%2findex

   walked out of public/ and served a file from the server tree. Measured,
   not theorised; that request returned the scaffold's index.html.

   Nothing secret is in a .html file today, so the suffix was the only
   thing holding this to "reads the layout of the disk" rather than
   "reads anything". That is not a control, it is a coincidence — and it
   stops being true the first time someone writes a .html file with
   configuration in it, or generalises the extension.

   Two checks, because each catches what the other might not. The pattern
   says what a page name is: letters, digits, dash, underscore, and that
   is all — no dot, no slash, so no traversal can even be spelled. The
   resolve is the belt to that braces: whatever the pattern let through,
   the file must still land inside frontend/. */
const PAGE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function guard(req, res, next) {
  if (!COLLECTIONS.includes(req.params.c)) {
    const name = String(req.params.c || "");
    if (PAGE_NAME.test(name)) {
      const pageFile = path.resolve(PUBLIC_DIR, name + ".html");
      if ((pageFile === PUBLIC_DIR || pageFile.startsWith(PUBLIC_DIR + path.sep)) && fs.existsSync(pageFile)) {
        return res.sendFile(pageFile);
      }
    }
    return res.status(404).json({ error: "unknown collection" });
  }
  next();
}

/* ---- generic CRUD over any allowed collection ----
   Every route is: guard (known collection) → requireSession (valid JWT)
   → tenantScope (server-derived workspace + DB) → authorizeCrud (RBAC).
   The workspace is taken from the signed session (req.ws), never from a
   client header, and record ids are minted server-side. ---- */
const crud = [guard, requireSession, tenantScope, authorizeCrud];

app.get("/:c", crud, async (req, res, next) => {
  try {
    const docs = await dbAdapter.findAll(req.ws, req.params.c);
    res.json(servableAll(docs));
  } catch (e) { next(e); }
});

app.get("/:c/:id", crud, async (req, res, next) => {
  try {
    const doc = await dbAdapter.findOne(req.ws, req.params.c, req.params.id);
    if (!doc) return next(httpError(404, "not_found", "not found"));
    res.json(servable(doc));
  } catch (e) { next(e); }
});

app.post("/:c", crud, async (req, res, next) => {
  try {
    const record = Object.assign({}, req.body);
    // Server-authoritative id + traceability. The client's proposed id is
    // ignored so ids are always globally unique and non-enumerable.
    record.id = idForCollection(req.params.c);
    record.wsId = req.ws.workspaceId;
    record.requestId = req.id;
    const saved = await dbAdapter.insertOne(req.ws, req.params.c, record);
    // insertOne hashes a password on the way in; the echo must not carry it back.
    res.status(201).json(servable(saved));
  } catch (e) { next(e); }
});

app.put("/:c/:id", crud, async (req, res, next) => {
  try {
    const patch = Object.assign({}, req.body);
    // Identity fields are immutable through updates.
    delete patch.id; delete patch.wsId;
    const updated = await dbAdapter.updateOne(req.ws, req.params.c, req.params.id, patch);
    if (!updated) return next(httpError(404, "not_found", "not found"));
    res.json(servable(updated));
  } catch (e) { next(e); }
});

app.delete("/:c/:id", crud, async (req, res, next) => {
  try {
    const ok = await dbAdapter.deleteOne(req.ws, req.params.c, req.params.id);
    res.json({ ok });
  } catch (e) { next(e); }
});

/* ---- security scanner ------------------------------------------------- */
// Rate limiter for upload scans
const securityScanLimiter = rateLimit({ windowMs: 60000, max: 20, message: { error: "too many scans — try again in a minute" } });

// GET /api/security/overview — aggregate scan overview for all user projects
app.get("/api/security/overview", async (req, res, next) => {
  try {
    const owner = appOwnerOf(req, res);
    const mine = await projects.list(owner, 100);
    
    let totalVulnerabilities = { critical: 0, high: 0, moderate: 0, low: 0 };
    const projectSummaries = [];
    const cookie = cookieOf(req);
    
    for (const p of mine) {
      let source = {};
      try {
        const src = await projects.materialize(p.id);
        if (src && src.files) source = scaffoldFiles.withScaffold(src.files);
      } catch (e) { /* ignore if history pruned */ }

      const secretResult = secretscan.scan(source);
      
      let depResult = { findings: [], total: 0, critical: 0, high: 0, moderate: 0, low: 0 };
      if (source["package.json"]) {
        depResult = depscan.scan(source["package.json"], source["package-lock.json"]);
      }
      
      let deployChecks = null;
      if (p.deploymentId && deployplane.isConfigured()) {
        try {
          const r = await deployplane.getChecks(cookie, p.deploymentId);
          if (r.ok) deployChecks = r.body;
        } catch (e) { /* deploy plane unavailable */ }
      }
      
      const vulnCount = secretResult.findings.length + depResult.total;
      totalVulnerabilities.critical += (depResult.critical || 0);
      totalVulnerabilities.high += (depResult.high || 0) + secretResult.findings.filter(f => f.severity === "high").length;
      totalVulnerabilities.moderate += (depResult.moderate || 0);
      totalVulnerabilities.low += (depResult.low || 0) + secretResult.findings.filter(f => f.severity === "medium").length;
      
      projectSummaries.push({
        key: p.slug || p.id,
        title: p.title || p.slug || "Untitled",
        vulnerabilities: vulnCount,
        severity: depResult.critical > 0 || secretResult.blocked ? "critical" : depResult.high > 0 ? "high" : depResult.moderate > 0 ? "moderate" : depResult.low > 0 ? "low" : "none",
        published: !!p.published,
        deployed: !!p.deploymentId,
        lastScan: p.updatedAt || p.createdAt,
        deployChecks: deployChecks,
        secretFindings: secretResult.findings.length,
        depFindings: depResult.total
      });
    }
    
    res.json({
      totalProjects: mine.length,
      totalVulnerabilities,
      clean: Object.values(totalVulnerabilities).every(v => v === 0),
      projects: projectSummaries
    });
  } catch (e) { next(e); }
});

// POST /api/security/scan/:projectKey — rescan a specific project
app.post("/api/security/scan/:projectKey", async (req, res, next) => {
  try {
    const owner = appOwnerOf(req, res);
    const project = await resolveProject(req.params.projectKey, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });
    
    let source = {};
    try {
      const src = await projects.materialize(project.id);
      if (src && src.files) source = scaffoldFiles.withScaffold(src.files);
    } catch (e) {}

    const secretResult = secretscan.scan(source);
    
    let depResult = { findings: [], total: 0, critical: 0, high: 0, moderate: 0, low: 0 };
    if (source["package.json"]) {
      depResult = depscan.scan(source["package.json"], source["package-lock.json"]);
    }
    
    res.json({
      project: project.title || project.slug,
      secrets: secretResult,
      dependencies: depResult,
      scannedAt: new Date().toISOString()
    });
  } catch (e) { next(e); }
});

// POST /api/security/scan/upload — scan an uploaded external project (ephemeral)
app.post("/api/security/scan/upload", securityScanLimiter,
  express.json({ limit: "50mb" }),
  async (req, res, next) => {
  try {
    const files = req.body && req.body.files;
    if (!files || typeof files !== "object") return res.status(400).json({ error: "send { files: { path: content } }" });
    
    const secretResult = secretscan.scan(files);
    
    let depResult = { findings: [], total: 0, critical: 0, high: 0, moderate: 0, low: 0 };
    const pkgPath = Object.keys(files).find(p => p === "package.json" || p.endsWith("/package.json"));
    const lockPath = Object.keys(files).find(p => p === "package-lock.json" || p.endsWith("/package-lock.json"));
    if (pkgPath) {
      depResult = depscan.scan(files[pkgPath], lockPath ? files[lockPath] : null);
    }
    
    res.json({
      secrets: secretResult,
      dependencies: depResult,
      scannedAt: new Date().toISOString(),
      filesScanned: Object.keys(files).length
    });
  } catch (e) { next(e); }
});

// GET /api/security/scan/:projectKey/details — detailed findings for one project
app.get("/api/security/scan/:projectKey/details", async (req, res, next) => {
  try {
    const owner = appOwnerOf(req, res);
    const project = await resolveProject(req.params.projectKey, owner);
    if (!project) return res.status(404).json({ error: "project not found" });
    if (!projects.owns(project, owner)) return res.status(403).json({ error: "not your project" });
    
    let source = {};
    try {
      const src = await projects.materialize(project.id);
      if (src && src.files) source = scaffoldFiles.withScaffold(src.files);
    } catch (e) {}

    const secretResult = secretscan.scan(source);
    
    let depResult = { findings: [], total: 0, critical: 0, high: 0, moderate: 0, low: 0 };
    if (source["package.json"]) {
      depResult = depscan.scan(source["package.json"], source["package-lock.json"]);
    }
    
    let deployChecks = null;
    if (project.deploymentId && deployplane.isConfigured()) {
      try {
        const r = await deployplane.getChecks(cookieOf(req), project.deploymentId);
        if (r.ok) deployChecks = r.body;
      } catch (e) { /* deploy plane unavailable */ }
    }
    
    res.json({
      project: { key: project.slug || project.id, title: project.title || project.slug, published: !!project.published, deployed: !!project.deploymentId },
      secrets: secretResult,
      dependencies: depResult,
      deployChecks: deployChecks,
      scannedAt: new Date().toISOString()
    });
  } catch (e) { next(e); }
});

// Central error handler — turns thrown/next(err) into a safe envelope

// { error: { code, message, requestId } } and keeps 5xx details server-side.
app.use(errorHandler);

/* -----------------------------------------------------------------
   Two ways this file runs, one app.
   - Locally / on any long-lived host: listen on a port, as always.
   - On Vercel: api/index.js require()s this module and hands each
     request to the exported `app`. There is no port to listen on there,
     and calling listen() would both fail and leak a handle per cold
     start — so the listen path is gated on NOT being in a serverless
     runtime rather than being the unconditional default it used to be.
   Mongo is connected lazily either way: on Vercel a cold start must not
   block on a DB round-trip before the first response, and the app
   already tolerates getMasterDb() returning null (it did so every time
   the local Mongo was down this session).
   ----------------------------------------------------------------- */
const IS_SERVERLESS = !!process.env.VERCEL;

let connectOnce = null;
function ensureDb() {
  if (!connectOnce) {
    connectOnce = connect().catch((e) => {
      console.warn("✗ Failed to connect to master MongoDB:", e.message);
      connectOnce = null; // let a later request retry rather than caching the failure forever
    });
  }
  return connectOnce;
}

if (IS_SERVERLESS) {
  ensureDb();
} else {
  const PORT = process.env.PORT || 4000;
  ensureDb().finally(() => {
    app.listen(PORT, () => console.log("✓ Souqi API listening on http://localhost:" + PORT));
  });
}

module.exports = app;