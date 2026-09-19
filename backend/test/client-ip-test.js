"use strict";
/* Who the rate limiters think you are.

   Every limiter in index.js keys on this. Before it existed they keyed on
   req.ip, Express only fills that from X-Forwarded-For when `trust proxy`
   is set, and it is set nowhere — so behind Vercel's edge and behind the
   VPS's Caddy every caller shared one counter. Measured on the dev server
   at the time: three POSTs carrying three different client addresses took
   the same bucket, 119 -> 118 -> 117.

   The spoofing cases are the point of this file. A caller who sends their
   own X-Forwarded-For must not get to pick their own bucket. */
const assert = require("assert");
const { clientIp } = require("../middleware/rateLimit");

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok   " + name);
  } catch (e) {
    console.error("  FAIL " + name);
    console.error("       " + e.message);
    process.exitCode = 1;
  }
}
function req(headers, ip) {
  return { headers: headers || {}, ip: ip, socket: { remoteAddress: ip } };
}

console.log("\n── client IP: whose bucket is this ────────");

check("no proxy headers falls back to the socket peer", () => {
  assert.strictEqual(clientIp(req({}, "203.0.113.7")), "203.0.113.7");
});

check("Vercel's own header wins over everything else", () => {
  const r = req({
    "x-vercel-forwarded-for": "203.0.113.7",
    "x-forwarded-for": "9.9.9.9, 8.8.8.8"
  }, "10.0.0.1");
  assert.strictEqual(clientIp(r), "203.0.113.7");
});

check("the LAST forwarded-for entry is the one the proxy saw", () => {
  // Caddy and Vercel both APPEND the peer they actually observed.
  assert.strictEqual(clientIp(req({ "x-forwarded-for": "203.0.113.7" }, "10.0.0.1")), "203.0.113.7");
});

check("a client cannot choose its own bucket by sending X-Forwarded-For", () => {
  /* The caller is 203.0.113.7 and claims to be 1.2.3.4. The proxy appends
     the address it actually saw, so the forged value sits to the LEFT and
     the real one is last. Reading chain[0] — the usual way this gets
     written — would hand every caller an endless supply of fresh buckets. */
  const r = req({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" }, "10.0.0.1");
  assert.strictEqual(clientIp(r), "203.0.113.7");
  assert.notStrictEqual(clientIp(r), "1.2.3.4");
});

check("two different callers get two different keys", () => {
  const a = clientIp(req({ "x-forwarded-for": "203.0.113.7" }, "10.0.0.1"));
  const b = clientIp(req({ "x-forwarded-for": "198.51.100.44" }, "10.0.0.1"));
  assert.notStrictEqual(a, b, "both callers landed in the same bucket");
});

check("the same caller gets the same key however it is spelled", () => {
  assert.strictEqual(clientIp(req({}, "::ffff:203.0.113.7")), "203.0.113.7");
  assert.strictEqual(clientIp(req({}, "203.0.113.7:53124")), "203.0.113.7");
  assert.strictEqual(clientIp(req({}, "[2001:db8::1]:443")), "2001:db8::1");
  assert.strictEqual(clientIp(req({ "x-forwarded-for": " 203.0.113.7 " }, "")), "203.0.113.7");
});

check("an IPv6 address is not mistaken for host:port", () => {
  assert.strictEqual(clientIp(req({}, "2001:db8::1")), "2001:db8::1");
});

check("TRUST_PROXY_HOPS=0 stops trusting the header at all", () => {
  const prev = process.env.TRUST_PROXY_HOPS;
  process.env.TRUST_PROXY_HOPS = "0";
  try {
    assert.strictEqual(clientIp(req({ "x-forwarded-for": "1.2.3.4" }, "203.0.113.7")), "203.0.113.7");
  } finally {
    if (prev === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = prev;
  }
});

check("nothing identifying means one shared bucket, not a free pass", () => {
  assert.strictEqual(clientIp(req({}, "")), "");
});

console.log("\n  all " + passed + " checks passed\n");
