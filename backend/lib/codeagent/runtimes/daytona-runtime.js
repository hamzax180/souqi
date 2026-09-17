"use strict";
/* =================================================================
   codeagent/runtimes/daytona-runtime.js — the REAL sandbox
   -----------------------------------------------------------------
   docs/CODE-AGENT-PLAN.md Phase 1 + §9. This is what local-runtime.js
   is not: an actually isolated Firecracker-class microVM, with the
   ONE non-negotiable control from §9 applied at creation time —
   `domainAllowList` — so a sandbox cannot reach anything but the npm
   registry by default (confirmed live: `networkBlockAll` and
   `domainAllowList` are mutually exclusive on this API; the allowlist
   alone already means deny-by-default-except).

   Implements the exact same five-verb contract as local-runtime.js
   (see ../runtime.js) — that contract is what makes this a drop-in
   replacement rather than a rewrite. The one deliberate difference:
   `run()`'s argv is joined back into a command string, because
   Daytona's executeCommand runs it inside the isolated sandbox, not
   on this host — the injection concern that ruled out shell:true in
   local-runtime.js was specifically about THIS process sharing a
   kernel with production secrets. Inside the sandbox there is no such
   sharing; the allowlist in tools.js still applies regardless, as
   defense in depth against a wrong command reaching either runtime.

   PROJECT_DIR — found the hard way (see codeagent-phase1-demo.js's
   history): a sandbox's working directory is its user's HOME, which
   already contains real content of its own (.bashrc, .face, and after
   the first `npm install`, ~/.npm/_cacache — hundreds of hashed cache
   files). Uploading the scaffold to that same root meant listFiles()
   had no way to tell "the project" from "everything else in $HOME"
   short of an ever-growing denylist of sandbox internals we'd have to
   keep discovering one slow run at a time. A dedicated subdirectory
   makes it a clean boundary instead: every fs/run call is scoped to
   PROJECT_DIR, and listFiles never has a reason to look outside it.
   ================================================================= */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PREVIEW_PORT = void 0;
exports.create = create;
exports.attach = attach;
exports.writeFile = writeFile;
exports.writeBinaryFile = writeBinaryFile;
exports.readFile = readFile;
exports.listFiles = listFiles;
exports.run = run;
exports.snapshot = snapshot;
exports.destroy = destroy;
exports.startPreview = startPreview;
exports.domSnapshot = domSnapshot;
exports.extractBodyText = extractBodyText;
exports.getPublicPreviewUrl = getPublicPreviewUrl;
exports.readDist = readDist;
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const runtime_1 = require("../runtime");
/* eslint-disable @typescript-eslint/no-explicit-any */
const SCAFFOLD_DIR = path.join(__dirname, "..", "scaffold");
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", ".cache"]);
const PROJECT_DIR = "app";
// npm install needs the registry only. Widen this list deliberately, one
// host at a time, if a real build fails on a blocked domain — never widen
// it to "allow everything", which is the exact control this file exists
// to keep in place.
const DEFAULT_DOMAIN_ALLOWLIST = "registry.npmjs.org";
let daytonaClient = null;
function client() {
    if (daytonaClient)
        return daytonaClient;
    /* Lazy and untyped on purpose: @daytona/sdk is not installed, and
       Daytona is gone anyway (docs/HOW-IT-WORKS.md §11 — sandboxAlive is
       hardcoded false). A static import would make the whole subsystem
       fail to compile for a dependency nothing reaches. */
    const { Daytona } = require("@daytona/sdk");
    const apiKey = process.env.DAYTONA_API_KEY;
    if (!apiKey)
        throw new Error("DAYTONA_API_KEY is not set — daytona-runtime cannot create sandboxes without it");
    daytonaClient = new Daytona({ apiKey });
    return daytonaClient;
}
function localScaffoldFiles() {
    const out = [];
    (function walk(dir, rel) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (IGNORE_DIRS.has(entry.name))
                continue;
            const full = path.join(dir, entry.name);
            const relPath = rel ? rel + "/" + entry.name : entry.name;
            if (entry.isDirectory())
                walk(full, relPath);
            else
                out.push({ localPath: full, remotePath: relPath });
        }
    })(SCAFFOLD_DIR, "");
    return out;
}
async function create() {
    const daytona = client();
    const sandbox = await daytona.create({
        language: "typescript",
        domainAllowList: process.env.CODEAGENT_DOMAIN_ALLOWLIST || DEFAULT_DOMAIN_ALLOWLIST,
        // A short auto-stop, but not TOO short: idle sandboxes are the #1 way
        // this loses money (docs/CODE-AGENT-PLAN.md §5), yet Phase 6 keeps a
        // sandbox alive between messages so a follow-up can reuse it — 10
        // minutes was tight enough that someone reading their new app for a
        // bit before typing a change could lose it. This is still a real cost
        // ceiling per sandbox, just not one that fights the product it backs.
        autoStopInterval: 20,
        labels: { app: "souqi-codeagent" }
    }, { timeout: 120 });
    const files = localScaffoldFiles().map((f) => ({
        source: fs.readFileSync(f.localPath),
        destination: PROJECT_DIR + "/" + f.remotePath
    }));
    await sandbox.fs.uploadFiles(files);
    return { id: sandbox.id, kind: "daytona", sandbox };
}
/**
 * Rebuilds a workspace handle from a sandbox id alone, with no reliance on
 * this process having created it. `create()` returns a live SDK object that
 * index.js used to have to keep in an in-memory Map for the life of the
 * process — which works on one long-lived server and breaks completely on
 * serverless, where a follow-up edit or a preview request can land on a
 * different instance than the build did.
 *
 * The id is already persisted on every revision (`sandboxId`), so nothing
 * new has to be stored — this is purely "look it back up instead of
 * remembering it". Returns null when the sandbox is gone (Daytona's
 * autoStopInterval reaped it, or it was destroyed), which callers treat
 * exactly like the old "not in the Map" case: resume from the last
 * persisted files onto a fresh sandbox.
 */
async function attach(sandboxId) {
    if (!sandboxId)
        return null;
    try {
        const sandbox = await client().get(sandboxId);
        if (!sandbox)
            return null;
        return { id: sandbox.id, kind: "daytona", sandbox };
    }
    catch (e) {
        return null; // deleted/expired/unknown id — indistinguishable and handled the same way
    }
}
async function writeFile(ws, relPath, content) {
    await ws.sandbox.fs.uploadFile(Buffer.from(content, "utf8"), PROJECT_DIR + "/" + relPath);
}
/** Binary sibling of writeFile — decodes base64 instead of treating
    content as utf8 text, which would corrupt anything that isn't. Not
    exposed through tools.js/makeTools: this is for the ONE orchestrator-
    side write of an uploaded logo before the model's own turn starts
    (see POST /api/codeagent/build), the same "server writes, model never
    gets a raw-bytes tool" boundary readDist already draws for publish. */
async function writeBinaryFile(ws, relPath, base64) {
    await ws.sandbox.fs.uploadFile(Buffer.from(base64, "base64"), PROJECT_DIR + "/" + relPath);
}
async function readFile(ws, relPath, fromLine, toLine) {
    const buf = await ws.sandbox.fs.downloadFile(PROJECT_DIR + "/" + relPath);
    const text = buf.toString("utf8");
    if ((fromLine === null || fromLine === undefined) && (toLine === null || toLine === undefined))
        return text;
    const lines = text.split("\n");
    const from = Math.max(1, fromLine || 1);
    const to = Math.min(lines.length, toLine || lines.length);
    return lines.slice(from - 1, to).join("\n");
}
/** Walks ONE level at a time, rooted at PROJECT_DIR, and skips an ignored
    directory name BEFORE recursing into it — never after. Depth-1 calls
    also keep each individual listFiles() request small and fast, which
    matters once node_modules exists as a SIBLING we simply never visit,
    rather than something to filter out after the fact. */
async function listFiles(ws, dir) {
    const out = [];
    async function walk(relDir) {
        const infos = await ws.sandbox.fs.listFiles(PROJECT_DIR + (relDir ? "/" + relDir : ""), { depth: 1 });
        for (const f of infos) {
            if (IGNORE_DIRS.has(f.name))
                continue;
            const rel = relDir ? relDir + "/" + f.name : f.name;
            if (f.isDir)
                await walk(rel);
            else
                out.push(rel);
        }
    }
    await walk(dir || "");
    return out.sort();
}
/** argv is joined into a command string here — see file header for why
    that is safe in THIS runtime specifically, unlike local-runtime.js. */
async function run(ws, argv, timeoutMs) {
    const command = argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ");
    const timeoutSec = Math.max(1, Math.ceil((timeoutMs || 120000) / 1000));
    try {
        const res = await ws.sandbox.process.executeCommand(command, PROJECT_DIR, undefined, timeoutSec);
        // Daytona's ExecuteResponse has no separate stderr stream — `result` is
        // the command's full output. build-parser.js already concatenates
        // stdout+stderr, so putting everything in stdout is a faithful mapping,
        // not a workaround.
        return { code: res.exitCode, stdout: res.result || "", stderr: "", timedOut: false };
    }
    catch (e) {
        const timedOut = /timeout/i.test(e.message || "");
        /* -1, not null. runtime.ts's contract says `code` is a number and
           every caller compares it against 0; null passed that comparison as
           "not zero" by accident rather than by contract. Typing the seam is
           what made the difference visible. */
        return { code: -1, stdout: "", stderr: e.message || String(e), timedOut };
    }
}
async function snapshot(ws) {
    // A simple content manifest, matching local-runtime.js's return shape
    // exactly (see ../runtime.js) rather than Daytona's own native
    // fork()/snapshot service — the native path is more efficient (no
    // per-file download) and is worth switching to when Phase 7 (checkpoints)
    // needs real speed, but the interface contract stays the same either way.
    const files = await listFiles(ws, undefined);
    const hashed = [];
    for (const rel of files) {
        const buf = await ws.sandbox.fs.downloadFile(PROJECT_DIR + "/" + rel);
        hashed.push({ path: rel, sha256: crypto.createHash("sha256").update(buf).digest("hex") });
    }
    return { files: hashed, at: new Date().toISOString() };
}
async function destroy(ws) {
    const daytona = client();
    await daytona.delete(ws.sandbox);
}
/** Reads the built dist/ folder wholesale, base64-encoded — unlike
    readFile/writeFile (utf8-text only, safe there because the model itself
    only ever writes text through write_file), a Vite build can still emit
    binary assets (referenced images, fonts, favicons) that a text decode
    would corrupt. Used only for publish (index.js), never by the model's
    own tools — dist/ is deliberately outside listFiles' reach (§ IGNORE_DIRS)
    since it's a build artifact, not source the agent edits. */
async function readDist(ws) {
    const out = [];
    async function walk(relDir) {
        const infos = await ws.sandbox.fs.listFiles(PROJECT_DIR + "/dist" + (relDir ? "/" + relDir : ""), { depth: 1 });
        for (const f of infos) {
            const rel = relDir ? relDir + "/" + f.name : f.name;
            if (f.isDir) {
                await walk(rel);
                continue;
            }
            const buf = await ws.sandbox.fs.downloadFile(PROJECT_DIR + "/dist/" + rel);
            out.push({ path: rel, base64: buf.toString("base64"), size: buf.length });
        }
    }
    await walk("");
    return out;
}
const PREVIEW_PORT = 4173;
exports.PREVIEW_PORT = PREVIEW_PORT;
const PREVIEW_SESSION = "preview";
/** Starts `npm run preview` as a genuinely long-running background process
    and waits until it actually answers. Found the hard way: a trailing `&`
    on a plain executeCommand() does NOT background it the way an
    interactive shell would — the call just blocks until its own timeout,
    taking the child down with it. Daytona's session API
    (createSession + executeSessionCommand with runAsync:true) is the real
    mechanism for this; sessions outlive the individual command that
    started them.

    A follow-up build reuses the SAME sandbox (index.js's codeBuilds
    registry), so this gets called a second time with a session that
    already exists — found live, via Phase 6's own first real UI test:
    createSession() throws "conflict: session already exists" rather than
    being a no-op. The fix is cheaper than it looks: `vite preview` is a
    static file server that reads dist/ per request rather than caching a
    snapshot at startup, so a rebuild's new output is picked up by the
    SAME still-running server — there is no reason to restart it at all.
    Checking the port first turns the common case (server's still healthy)
    into a fast no-op, and the createSession conflict is now an expected,
    swallowed outcome rather than a crash. */
async function startPreview(ws, timeoutMs) {
    const already = await run(ws, ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "2", "http://localhost:" + PREVIEW_PORT], 5000);
    if (already.stdout.trim() === "200")
        return { ok: true, url: "http://localhost:" + PREVIEW_PORT };
    try {
        await ws.sandbox.process.createSession(PREVIEW_SESSION);
    }
    catch (e) {
        if (!/exists|conflict/i.test(e.message || ""))
            throw e;
        // Session exists but the port isn't answering (e.g. the previous
        // preview process died) — reuse the session and (re)issue the start
        // command in it rather than failing on a stale conflict.
    }
    await ws.sandbox.process.executeSessionCommand(PREVIEW_SESSION, {
        command: "cd " + PROJECT_DIR + " && npm run preview", runAsync: true
    });
    const deadline = Date.now() + (timeoutMs || 15000);
    while (Date.now() < deadline) {
        const check = await run(ws, ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "2", "http://localhost:" + PREVIEW_PORT], 5000);
        if (check.stdout.trim() === "200")
            return { ok: true, url: "http://localhost:" + PREVIEW_PORT };
        await new Promise((r) => setTimeout(r, 500));
    }
    return { ok: false, reason: "preview server did not respond within " + (timeoutMs || 15000) + "ms" };
}
/** A URL a BROWSER can load directly — no custom header required. Verified
    live against both of Daytona's options before picking one:
    `getPreviewLink()`'s plain URL 401s without an `x-daytona-preview-token`
    header attached, which an <iframe src="…"> has no way to send.
    `getSignedPreviewUrl()` bakes the token into the URL/host itself and
    returns 200 with zero headers — the one an iframe (docs/CODE-AGENT-PLAN.md
    §7, Phase 6) can actually use. Defaults to 30 minutes: long enough to
    watch one build and keep looking at the result, short enough that a
    leaked link doesn't stay live indefinitely. */
async function getPublicPreviewUrl(ws, port, expiresInSeconds) {
    const signed = await ws.sandbox.getSignedPreviewUrl(port || PREVIEW_PORT, expiresInSeconds || 1800);
    return signed.url;
}
/** Everything before the real "<!DOCTYPE html>" is Chromium's own stderr
    (D-Bus-not-available warnings, harmless in a minimal container — this
    is log noise from the browser itself, not from the page) landing in
    the same stdout stream as the actual dump, because Daytona's
    executeCommand has no separate stderr channel (see run()'s own note
    on this). Slicing from the real doctype is what separates "browser
    startup noise" from "the page we asked about". */
function extractBodyText(html) {
    const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
    const bodyHtml = bodyMatch ? bodyMatch[1] : html;
    return bodyHtml
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
}
/** The screenshot substitute, run WHERE it actually works: Chromium is
    pre-installed in this sandbox's base image, so this runs entirely
    inside the isolated Linux sandbox rather than depending on a browser
    stack on whatever host the orchestrator happens to be running on. This
    is what proves a route actually rendered content, not just that the
    build succeeded — a blank white page compiles clean, and this is the
    check that catches it (docs/CODE-AGENT-PLAN.md §4). */
async function domSnapshot(ws, url, timeoutMs) {
    const budgetMs = Math.min(15000, timeoutMs || 15000);
    const result = await run(ws, [
        "chromium", "--headless=new", "--disable-gpu", "--no-sandbox",
        "--virtual-time-budget=" + budgetMs, "--dump-dom", url
    ], timeoutMs || 15000);
    const htmlStart = result.stdout.indexOf("<!DOCTYPE html>");
    if (result.code !== 0 || htmlStart < 0) {
        return { ok: false, degraded: true, reason: "chromium dump-dom failed (code " + result.code + (result.timedOut ? ", timed out" : "") + ")", text: "" };
    }
    const html = result.stdout.slice(htmlStart);
    const text = extractBodyText(html);
    return { ok: true, degraded: false, text, empty: text.length === 0 };
}
(0, runtime_1.registerRuntime)("daytona", { create, attach, writeFile, writeBinaryFile, readFile, listFiles, run, snapshot, destroy, startPreview, domSnapshot, getPublicPreviewUrl, readDist });
