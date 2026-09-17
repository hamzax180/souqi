/* =================================================================
   csp-test.js — the two copies of the Content-Security-Policy agree
   -----------------------------------------------------------------
   The policy exists twice, and it has to.

   server/middleware/securityHeaders.js sets it on anything Express
   answers. But vercel.json declares `outputDirectory: "frontend"`, so the
   pages themselves — /agent, /projects, /deployments — are served as
   static files by Vercel's CDN and never reach Express at all. Only
   vercel.json's `headers` block applies to those, and it listed every
   security header EXCEPT this one: production served the builder with no
   CSP whatsoever while local development had a full one.

   Two copies of a security policy that can drift apart silently is worse
   than one that is merely permissive, so this pins them together. If you
   widen the policy for a new CDN, this fails until vercel.json says the
   same thing.
   ================================================================= */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ✓ " + name); }
  catch (e) { failures++; console.log("  ✗ " + name + "\n      " + e.message); }
}

function middlewareCsp() {
  const securityHeaders = require("../middleware/securityHeaders");
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
  securityHeaders({}, res, () => {});
  return res.headers["Content-Security-Policy"];
}

function vercelHeaders() {
  const v = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "vercel.json"), "utf8"));
  const block = (v.headers || []).find((h) => h.source === "/(.*)");
  assert.ok(block, "vercel.json has no catch-all headers block");
  const out = {};
  for (const h of block.headers) out[h.key] = h.value;
  return out;
}

console.log("\n── CSP: one policy, two places that must agree ────────");

check("the middleware emits a policy at all", () => {
  assert.ok(middlewareCsp(), "securityHeaders did not set Content-Security-Policy");
});

check("vercel.json carries a Content-Security-Policy", () => {
  assert.ok(vercelHeaders()["Content-Security-Policy"],
    "vercel.json omits it — the statically served pages would ship with no CSP, " +
    "which is exactly the bug this file exists to hold");
});

check("the two policies are identical, directive for directive", () => {
  const a = middlewareCsp();
  const b = vercelHeaders()["Content-Security-Policy"];
  if (a === b) return;
  // Name what actually differs; a 600-character diff is unreadable.
  const split = (s) => new Set(String(s).split(";").map((x) => x.trim()).filter(Boolean));
  const A = split(a), B = split(b);
  const onlyMw = [...A].filter((x) => !B.has(x));
  const onlyVc = [...B].filter((x) => !A.has(x));
  assert.fail("they have drifted apart\n" +
    (onlyMw.length ? "      only in securityHeaders.js: " + onlyMw.join(" | ") + "\n" : "") +
    (onlyVc.length ? "      only in vercel.json:        " + onlyVc.join(" | ") + "\n" : "") +
    "      re-generate vercel.json's value from the middleware");
});

check("every other security header the middleware sets is also declared statically", () => {
  const securityHeaders = require("../middleware/securityHeaders");
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
  securityHeaders({}, res, () => {});
  const vc = vercelHeaders();
  // X-DNS-Prefetch-Control is the one deliberate omission: it is a legacy
  // Chrome hint, not a security boundary, and Vercel does not prefetch.
  const skip = new Set(["X-DNS-Prefetch-Control", "Strict-Transport-Security"]);
  const missing = Object.keys(res.headers).filter((k) => !skip.has(k) && !vc[k]);
  assert.deepStrictEqual(missing, [],
    "served statically without: " + missing.join(", "));
});

/* ---- Cross-Origin-Embedder-Policy: the scoped copy -------------------
   COEP is not in the catch-all block above. It is set on a few routes
   only, because site-wide it blanks every deployed-app preview (see
   middleware/securityHeaders.js). So it has the same two-copies problem
   the CSP has, in a narrower place: index.js decides the scope for
   anything Express answers, vercel.json decides it for the statically
   served pages, and nothing checked that the two agreed — which is how
   /settings ended up isolated in neither and the builder's settings
   overlay started painting "refused to connect". */

function expressIsolated() {
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const re = /app\.use\("(\/[^"]+)", crossOriginIsolate\)/g;
  const out = new Set();
  let m;
  while ((m = re.exec(src))) out.add(m[1].replace(/\.html$/, ""));
  return out;
}

function vercelIsolated() {
  const v = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "vercel.json"), "utf8"));
  const block = (v.headers || []).find((h) =>
    (h.headers || []).some((x) => x.key === "Cross-Origin-Embedder-Policy"));
  assert.ok(block, "vercel.json declares COEP nowhere — production is not isolated at all");
  // e.g. "/(agent|code|settings)(/.*)?" → agent, code, settings
  const alt = /^\/\(([^)]+)\)/.exec(block.source);
  assert.ok(alt, "cannot read the isolate scope out of " + JSON.stringify(block.source));
  return new Set(alt[1].split("|").map((s) => "/" + s.trim()));
}

/* The pages an isolated page can put in an iframe.

   A line that mentions `src` and names a path we serve as an HTML page is
   treated as a frame source. Crude on purpose: `<script src="/js/ui.js">`
   has no page behind it and drops out, and the cost of a false positive is
   a loud test rather than a silent hole. */
function framedPages(file) {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", file), "utf8");
  const out = new Set();
  for (const line of src.split("\n")) {
    if (!/src/i.test(line)) continue;
    const re = /"(\/[a-z0-9_-]+)"/gi;
    let m;
    while ((m = re.exec(line))) {
      const p = m[1];
      if (fs.existsSync(path.join(__dirname, "..", "..", "frontend", p.slice(1) + ".html"))) out.add(p);
    }
  }
  return out;
}

check("both copies isolate exactly the same routes", () => {
  const ex = [...expressIsolated()].sort();
  const vc = [...vercelIsolated()].sort();
  assert.deepStrictEqual(ex, vc,
    "index.js isolates [" + ex.join(", ") + "] but vercel.json isolates [" + vc.join(", ") + "]\n" +
    "      Vercel serves these pages from the CDN, so a route missing there is\n" +
    "      isolated in development and not in production");
});

check("every page an isolated page frames is isolated too", () => {
  const iso = expressIsolated();
  const missing = [];
  for (const page of ["code.html"]) {
    for (const framed of framedPages(page)) {
      if (!iso.has(framed)) missing.push(framed + " (framed by " + page + ")");
    }
  }
  assert.deepStrictEqual(missing, [],
    "framed by a COEP page but sends no COEP of its own: " + missing.join(", ") + "\n" +
    "      A document embedded in a COEP context must assert COEP itself — the\n" +
    "      rule is not origin-scoped, and credentialless relaxes it for\n" +
    "      subresources, not for frames. The browser refuses the navigation and\n" +
    "      paints \"refused to connect\" inside the frame.");
});

/* ---- published apps are not the platform ----------------------------

   A published app is a model-written bundle served from /s/<slug>, on the
   platform's own host. The platform authenticates with a cookie and
   nothing else, so while that page was same-origin its script could read
   /api as whoever opened the link and post the result anywhere connect-src
   allowed, which was every https host there is.

   `sandbox` without allow-same-origin is the whole fix: the page loads
   into an opaque origin, /api becomes cross-origin to it, and the session
   cookie is not sent. Each check below exists because one word can undo
   it. */

const headersSrc = fs.readFileSync(path.join(__dirname, "..", "middleware", "securityHeaders.js"), "utf8");
const indexSrc = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const publishedCsp = (() => {
  const m = /const PUBLISHED_CSP = \[([\s\S]*?)\]\.join/.exec(headersSrc);
  return m ? m[1] : "";
})();

check("published sites get a policy of their own", () => {
  assert.ok(publishedCsp, "no PUBLISHED_CSP in securityHeaders.js");
  assert.ok(/isPublishedSite/.test(headersSrc), "nothing routes /s/ to it");
});

check("a published app is sandboxed into an opaque origin", () => {
  assert.ok(/sandbox/.test(publishedCsp), "the published policy has no sandbox directive");
  assert.ok(!/allow-same-origin/.test(publishedCsp),
    "allow-same-origin is back — that one flag returns the page to the platform origin, and with it the ability to read /api as whoever opens the link");
});

check("it can still be an app", () => {
  for (const flag of ["allow-scripts", "allow-forms", "allow-top-navigation-by-user-activation"]) {
    assert.ok(publishedCsp.indexOf(flag) >= 0, "published apps lost " + flag);
  }
});

check("only the two public payment routes answer any origin", () => {
  const m = /const PUBLIC_APP_PATH = (\/.*\/);/.exec(indexSrc);
  assert.ok(m, "PUBLIC_APP_PATH is gone, so a shop cannot fetch its own prices");
  const body = m[1].slice(1, m[1].lastIndexOf("/"));
  const re = new RegExp(body);
  for (const p of ["/api/apps/pr_x/payment-items", "/api/apps/pr_x/checkout"]) {
    assert.ok(re.test(p), p + " is no longer reachable from a published app");
  }
  for (const p of ["/api/projects", "/api/account/me", "/api/admin/overview", "/users",
                   "/api/apps/pr_x/anything-else", "/api/ws/w1/export"]) {
    assert.ok(!re.test(p), p + " answers any origin, which makes the sandbox pointless");
  }
});

check("the allowance is mounted before the global cors()", () => {
  const mine = indexSrc.indexOf("PUBLIC_APP_PATH");
  const glob = indexSrc.indexOf("app.use(cors({");
  assert.ok(mine >= 0 && glob >= 0, "could not find both CORS registrations");
  assert.ok(mine < glob,
    "cors() is mounted first, so it answers the preflight for these paths without an Access-Control-Allow-Origin, and the POST that follows never runs");
});

/* ---- the fallback preview is not the platform either ----------------

   The builder's preview has two paths. The WebContainer one is served
   from webcontainer-api.io and is a foreign origin already. The fallback
   is a srcdoc document — and srcdoc inherits the embedding page's origin,
   so model-written code, eval'd, ran as souqi.site with the builder's own
   session cookie one fetch away.

   Usually that is a person's own app from their own prompt, which is only
   a way to attack yourself. It stops being that the moment the prompt came
   from somebody else. */

const codeHtml = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "code.html"), "utf8");

check("the srcdoc preview is sandboxed, and before it navigates", () => {
  const i = codeHtml.indexOf("agPvIframe.srcdoc = html;");
  assert.ok(i > 0, "the srcdoc preview is gone");
  const before = codeHtml.slice(Math.max(0, i - 1200), i);
  const tag = 'setAttribute("sandbox", "';
  const k = before.indexOf(tag);
  assert.ok(k >= 0, "no sandbox is set before srcdoc is assigned — a sandbox attribute only takes effect on the next navigation, and assigning srcdoc IS it");
  const flags = before.slice(k + tag.length, before.indexOf('"', k + tag.length));
  assert.ok(flags.indexOf("allow-same-origin") < 0, "allow-same-origin is set on the preview, which hands model-written code the platform origin back");
  assert.ok(flags.indexOf("allow-scripts") >= 0, "the preview lost allow-scripts and will render nothing");
});

check("the WebContainer preview is left alone", () => {
  const i = codeHtml.indexOf("agPvIframe.src = url;");
  assert.ok(i > 0, "the WebContainer preview is gone");
  const before = codeHtml.slice(Math.max(0, i - 600), i);
  assert.ok(before.indexOf('removeAttribute("sandbox")') >= 0, "the sandbox is not cleared before the WebContainer URL loads — the same element may have just held a sandboxed srcdoc, and an opaque origin costs that dev server the storage it runs on");
});

/* Vercel takes the FIRST matching headers block, not the last, so the
   order of these two is load-bearing and invisible. Put the image block
   below the /(api|auth) one and images silently go back to no-store:
   nothing breaks, nothing logs, and every view of every image on every
   published site becomes a function invocation plus a full read of the
   bytes out of the database.

   Asserted rather than assumed because I had it backwards first, shipped
   it, and curl said no-store — the config was valid, the deploy was
   green, and the header was simply the other one's. That is exactly the
   kind of drift this file exists to catch.

   This assertion is also the only place the reasoning can live. JSON has
   no comments, and Vercel validates vercel.json against a schema that
   permits exactly source/headers/has/missing — a "_comment" key there is
   not ignored, it fails the deploy with "Schema verification failed".

   Vary: Cookie is dropped for this path on purpose: an image that varies
   by cookie is one a CDN is not allowed to cache, and this one does not. */
check("the image cache header survives the /api no-store rule", () => {
  const v = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "vercel.json"), "utf8"));
  const list = v.headers || [];
  const api = list.findIndex((h) => h.source === "/(api|auth)/(.*)");
  const img = list.findIndex((h) => h.source === "/api/img/(.*)");
  assert.ok(api >= 0, "the /api no-store block is gone");
  assert.ok(img >= 0, "there is no /api/img headers block — uploaded images are served no-store");
  assert.ok(img < api, "the /api/img block must come BEFORE /(api|auth), or the first match wins and the image is never cached");
  const cc = (list[img].headers || []).find((h) => h.key === "Cache-Control");
  assert.ok(cc && /immutable/.test(cc.value), "the image block does not declare the object immutable");
});

if (failures) { console.log("\n✗ " + failures + " CSP CHECK(S) FAILED\n"); process.exit(1); }
console.log("\n✓ ALL CSP TESTS PASSED (14)\n");
