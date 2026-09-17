/* =================================================================
   codeagent/dom-snapshot.ts — the screenshot substitute
   -----------------------------------------------------------------
   DeepSeek V3 is text-only (docs/CODE-AGENT-PLAN.md §4) — Replit's
   agent looks at a screenshot; this loop cannot. dom_snapshot proves
   a route rendered real content by executing it in a real browser and
   reading back the text, without needing vision.

   Puppeteer is required lazily so a runtime without a launchable
   Chrome (sandboxed shells, some CI images, missing system deps)
   degrades to `{ok:false, degraded:true}` instead of crashing the
   whole tool surface — every failure here should be something the
   caller can act on, per the §6 failure table.
   ================================================================= */

export interface DomSnapshot {
  ok: boolean;
  degraded: boolean;
  text: string;
  reason?: string;
  consoleErrors?: string[];
  empty?: boolean;
}

/* `any` because puppeteer is an optional dependency: typing it properly
   would make the whole subsystem fail to compile on a machine that chose
   not to install it, which is the exact situation this file degrades for. */
let puppeteer: any = null;
try { puppeteer = require("puppeteer"); } catch { /* not installed — degrade below */ }

export async function domSnapshot(url: string, timeoutMs?: number): Promise<DomSnapshot> {
  if (!puppeteer) {
    return { ok: false, degraded: true, reason: "puppeteer is not installed", text: "" };
  }

  let browser: any;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
    });
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.on("pageerror", (e: unknown) => consoleErrors.push(String((e as Error)?.message || e)));
    page.on("console", (m: any) => { if (m.type() === "error") consoleErrors.push(m.text()); });

    await page.goto(url, { waitUntil: "networkidle0", timeout: timeoutMs || 15000 });
    // This closure runs INSIDE the browser page via Puppeteer, not in this
    // Node process — `document` is real there.
    const text: string = await page.evaluate(() => (globalThis as any).document.body.innerText || "");

    return { ok: true, degraded: false, text: text.trim(), consoleErrors, empty: text.trim().length === 0 };
  } catch (e) {
    return { ok: false, degraded: true, reason: (e as Error).message, text: "" };
  } finally {
    if (browser) { try { await browser.close(); } catch { /* already gone */ } }
  }
}
