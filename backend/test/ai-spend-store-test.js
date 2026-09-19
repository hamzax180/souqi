"use strict";
/* The monthly AI budget, and whether it is actually a budget.

   AI_MONTHLY_BUDGET_USD is the platform's last line of defence against a
   runaway DeepSeek bill. It was enforced against a plain object in
   lib/ai/client.js and nothing ever supplied the hook that was meant to
   persist it — init's docstring still said "plug in the audit collection
   later". Production is Vercel: many lambdas, recycled constantly, each
   counting its own spend from zero, so the cap was reached by nobody.

   The test that matters is the last one: a SECOND process must see what
   the first one spent. Everything above it is scaffolding for that. */
const assert = require("assert");
const client = require("../lib/ai/client");

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ok   " + name);
  } catch (e) {
    console.error("  FAIL " + name);
    console.error("       " + e.message);
    process.exitCode = 1;
  }
}

/* A stand-in for the Mongo collection: one shared object, which is
   exactly what "shared across instances" means from the client's side. */
function fakeStore() {
  const months = {};
  const store = {
    calls: { add: 0, total: 0 },
    fail: false,
    async add(month, route, usd) {
      store.calls.add++;
      if (store.fail) throw new Error("store down");
      months[month] = (months[month] || 0) + usd;
      return true;
    },
    async total(month) {
      store.calls.total++;
      if (store.fail) throw new Error("store down");
      return months[month] || 0;
    },
    _set(month, usd) { months[month] = usd; },
    _months: months
  };
  return store;
}

const ROUTES = {
  prose: { baseUrl: "https://x.test", model: "m", key: "k" },
  json: { baseUrl: "https://x.test", model: "m", key: "k" },
  vision: { baseUrl: "https://x.test", model: "m", key: "k" }
};

/* A provider that always answers, cheaply and identically. */
function okFetch() {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1000, completion_tokens: 1000 }
    }),
    text: async () => ""
  });
}

async function main() {
  console.log("\n── the monthly AI budget is shared ────────");

  await check("with no store the budget still works inside one process", async () => {
    client.init({ enabled: true, routes: ROUTES, budgetUsd: 0.0000001, fetchImpl: okFetch() });
    const first = await client.chat({ route: "prose", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(first.ok, true, "the first call should go through");
    const second = await client.chat({ route: "prose", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.budgetExceeded, true, "in-process budget did not trip: " + second.reason);
  });

  await check("spend is written through to the store", async () => {
    const store = fakeStore();
    client.init({ enabled: true, routes: ROUTES, budgetUsd: 1000, fetchImpl: okFetch(), spendStore: store });
    await client.chat({ route: "prose", messages: [{ role: "user", content: "hi" }] });
    assert.ok(store.calls.add >= 1, "nothing was booked to the store");
    const month = Object.keys(store._months)[0];
    assert.ok(/^\d{4}-\d{2}$/.test(month), "month key looks wrong: " + month);
    assert.ok(store._months[month] > 0, "a zero amount was booked");
  });

  await check("A SECOND PROCESS SEES WHAT THE FIRST ONE SPENT", async () => {
    /* The whole point. The store already holds a month's worth of spend
       from instances that are long gone; this process has an empty map
       and must still refuse. Before the store existed it happily spent
       another full budget, and so did every lambda after it. */
    const store = fakeStore();
    const month = new Date().toISOString().slice(0, 7);
    store._set(month, 500);                       // spent by other instances
    client.init({ enabled: true, routes: ROUTES, budgetUsd: 100, fetchImpl: okFetch(), spendStore: store });

    const res = await client.chat({ route: "prose", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(res.ok, false, "a fresh process spent past a budget another instance had already used up");
    assert.strictEqual(res.budgetExceeded, true, "wrong refusal: " + res.reason);
  });

  await check("a burst inside one cache window still counts", async () => {
    /* The shared total is cached for a few seconds so the check is not a
       database read per call. Without the local write-through below, a
       burst arriving inside that window would all see the same stale
       total and sail past the cap together. */
    const store = fakeStore();
    client.init({ enabled: true, routes: ROUTES, budgetUsd: 0.005, fetchImpl: okFetch(), spendStore: store });
    let allowed = 0;
    for (let i = 0; i < 40; i++) {
      const r = await client.chat({ route: "prose", messages: [{ role: "user", content: "hi" }] });
      if (r.ok) allowed++; else break;
    }
    assert.ok(allowed < 40, "every call in the burst was allowed — the cap did nothing");
  });

  await check("a store that is down does not reopen the budget", async () => {
    /* Falling back to zero here would mean a database blip hands out an
       unlimited budget. The last known total stands instead. */
    const store = fakeStore();
    const month = new Date().toISOString().slice(0, 7);
    store._set(month, 500);
    client.init({ enabled: true, routes: ROUTES, budgetUsd: 100, fetchImpl: okFetch(), spendStore: store });
    await client.refreshSharedSpend(true);        // learn the real total
    store.fail = true;                            // now the database goes away
    const res = await client.chat({ route: "prose", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(res.budgetExceeded, true, "a store outage reopened the budget: " + res.reason);
  });

  await check("a store that is down does not break a call under budget", async () => {
    const store = fakeStore();
    store.fail = true;
    client.init({ enabled: true, routes: ROUTES, budgetUsd: 1000, fetchImpl: okFetch(), spendStore: store });
    const res = await client.chat({ route: "prose", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(res.ok, true, "metering broke a call it was only supposed to measure: " + res.reason);
  });

  await check("no budget configured means no ceiling", async () => {
    const store = fakeStore();
    const month = new Date().toISOString().slice(0, 7);
    store._set(month, 99999);
    client.init({ enabled: true, routes: ROUTES, budgetUsd: 0, fetchImpl: okFetch(), spendStore: store });
    const res = await client.chat({ route: "prose", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(res.ok, true, "an unset budget refused a call");
  });

  console.log("\n  all " + passed + " checks passed\n");
}

main();
