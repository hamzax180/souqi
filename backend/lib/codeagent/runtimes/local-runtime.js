"use strict";
/* =================================================================
   codeagent/runtimes/local-runtime.js — Phase 2 ONLY, never Phase 3+
   -----------------------------------------------------------------
   Runs the scaffold in a plain OS temp directory with a plain child
   process. This is the SAME machine, SAME kernel, SAME filesystem as
   the API process that holds JWT_SECRET and MONGODB_URI — there is
   NO isolation here (docs/CODE-AGENT-PLAN.md §5, §9: "plain Docker on
   your box: shared kernel... No.").

   This exists to prove the seven-tool substrate against a hardcoded,
   non-adversarial script — the whole point of Phase 2 is to find out
   whether the plumbing works BEFORE anything untrusted (a model, a
   stranger's prompt) can reach it. Once Phase 1 lands a real sandbox
   provider, the code-generating agent (Phase 3+) must run ONLY there.
   `assertDevOnly()` is a deliberate tripwire against that mistake.
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
exports.WORKSPACES_ROOT = exports.PREVIEW_PORT = void 0;
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
exports.stopPreview = stopPreview;
exports.getPublicPreviewUrl = getPublicPreviewUrl;
exports.readDist = readDist;
exports.killTree = killTree;
exports.childEnv = childEnv;
const fs = __importStar(require("fs"));
const fsp = fs.promises;
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const net = __importStar(require("net"));
const crypto = __importStar(require("crypto"));
// cross-spawn resolves Windows .cmd/.bat shims (npm, npx) WITHOUT going
// through shell:true — Node's own spawn can't run those on Windows unless
// shell:true is set, and shell:true + an args array is a real injection
// risk (Node emits DEP0190 for exactly this) because args stop being
// individually escaped. This is the one dependency worth taking to keep
// run() genuinely shell-free even on Windows.
const spawn = require("cross-spawn");
const runtime_1 = require("../runtime");
/* eslint-disable @typescript-eslint/no-explicit-any */
const SCAFFOLD_DIR = path.join(__dirname, "..", "scaffold");
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", ".cache"]);
function assertDevOnly() {
    if (process.env.NODE_ENV === "production" && process.env.CODEAGENT_ALLOW_LOCAL_IN_PROD !== "1") {
        throw new Error("local-runtime refuses to run with NODE_ENV=production — it has no sandboxing. " +
            "Use the e2b/daytona runtime for anything reachable by a real user.");
    }
}
/** Resolves a workspace-relative path and refuses to leave the workspace
    root — the one traversal check that matters even for a hardcoded
    script, because it is free and it is the check Phase 3 will lean on
    hardest once the caller is a model instead of a fixed sequence. */
function resolveInWorkspace(ws, relPath) {
    const clean = String(relPath || "").replace(/^[/\\]+/, "");
    const full = path.resolve(ws.root, clean);
    if (full !== ws.root && !full.startsWith(ws.root + path.sep)) {
        throw new Error("path escapes the workspace: " + relPath);
    }
    return full;
}
async function copyDir(src, dest) {
    await fsp.mkdir(dest, { recursive: true });
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
        if (IGNORE_DIRS.has(entry.name))
            continue;
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory())
            await copyDir(s, d);
        else
            await fsp.copyFile(s, d);
    }
}
async function walk(dir, root, out) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (IGNORE_DIRS.has(entry.name))
            continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory())
            await walk(full, root, out);
        else
            out.push(path.relative(root, full).split(path.sep).join("/"));
    }
}
/**
 * Where client projects live. Deliberately OUTSIDE the repo and outside
 * os.tmpdir(): inside the repo, a stray client write could land on
 * platform source; in tmpdir, the OS is free to sweep it and a project
 * would silently lose its files between sessions. Overridable so a
 * deployment can point it at a dedicated volume.
 */
const WORKSPACES_ROOT = process.env.CODEAGENT_WORKSPACES_DIR
    || path.join(os.homedir(), ".souqi", "workspaces");
exports.WORKSPACES_ROOT = WORKSPACES_ROOT;
function workspaceRoot(id) {
    // id is generated here, never client-supplied — but this is the path
    // that becomes a filesystem location, so it gets validated anyway
    // rather than trusting that invariant to hold as callers change.
    if (!/^ws_[a-z0-9]+$/i.test(id))
        throw new Error("invalid workspace id: " + id);
    return path.join(WORKSPACES_ROOT, id);
}
async function create() {
    assertDevOnly();
    const id = "ws_" + crypto.randomBytes(8).toString("hex");
    const root = workspaceRoot(id);
    await copyDir(SCAFFOLD_DIR, root);
    return { id, kind: "local", root };
}
/**
 * Re-opens an existing workspace by id, with no reliance on this process
 * having created it — the local mirror of daytona-runtime's attach().
 * Returns null when the directory is gone, which callers already treat
 * as "resume from the persisted files onto a fresh workspace".
 */
async function attach(id) {
    if (!id)
        return null;
    let root;
    try {
        root = workspaceRoot(id);
    }
    catch (e) {
        return null;
    }
    try {
        const st = await fsp.stat(root);
        if (!st.isDirectory())
            return null;
    }
    catch (e) {
        return null;
    }
    return { id, kind: "local", root };
}
async function writeFile(ws, relPath, content) {
    const full = resolveInWorkspace(ws, relPath);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content, "utf8");
}
async function readFile(ws, relPath, fromLine, toLine) {
    const full = resolveInWorkspace(ws, relPath);
    const text = await fsp.readFile(full, "utf8");
    if ((fromLine === null || fromLine === undefined) && (toLine === null || toLine === undefined))
        return text;
    const lines = text.split("\n");
    const from = Math.max(1, fromLine || 1);
    const to = Math.min(lines.length, toLine || lines.length);
    return lines.slice(from - 1, to).join("\n");
}
async function listFiles(ws, dir) {
    const base = dir ? resolveInWorkspace(ws, dir) : ws.root;
    const out = [];
    await walk(base, ws.root, out);
    return out.sort();
}
/** child.kill() only signals the ONE process it points at. npm/vite/tsc
    routinely spawn their own native binaries underneath (esbuild is the one
    that bit us here) — on Windows those don't die with their parent unless
    the whole tree is killed explicitly, which is what left an orphaned
    esbuild.exe holding a file lock after the first version of this function
    shipped. `taskkill /t` kills the process tree; POSIX SIGKILL already
    covers the tree via the process group. This is exactly the kind of bug
    Phase 2 exists to surface before a repair loop hits timeouts routinely
    and leaks a process per retry. */
function killTree(child) {
    if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
    }
    else {
        try {
            process.kill(-child.pid, "SIGKILL");
        }
        catch (e) {
            child.kill("SIGKILL");
        }
    }
}
/**
 * The environment a client's own code and `npm install` are allowed to
 * see. An ALLOWLIST, never a denylist: process.env here holds
 * AI_JSON_KEY, JWT_SECRET, MONGODB_URI and DAYTONA_API_KEY, and the
 * default spawn behaviour is to hand a child ALL of it. Anything not
 * named below simply never reaches client code.
 *
 * This is the single most important line of defence this runtime has,
 * and it is also NOT a sandbox — see the header. A child process still
 * runs as this OS user and can read the platform's files off disk if it
 * goes looking. Scrubbing the environment removes the trivial path
 * (`process.env.AI_JSON_KEY`), not the determined one.
 */
function childEnv() {
    const keep = process.platform === "win32"
        // npm/node genuinely need these on Windows; without SystemRoot,
        // spawning node fails outright rather than running unprivileged.
        ? ["PATH", "Path", "SystemRoot", "windir", "TEMP", "TMP", "COMSPEC", "PATHEXT", "NUMBER_OF_PROCESSORS", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "ProgramFiles", "ProgramData"]
        : ["PATH", "HOME", "TMPDIR", "LANG", "SHELL"];
    const env = {};
    for (const k of keep)
        if (process.env[k] != null)
            env[k] = process.env[k];
    // Deliberately set, not inherited: keeps npm quiet and non-interactive
    // and stops it writing to the platform user's global npm config.
    env.NODE_ENV = "development";
    env.CI = "1";
    env.npm_config_fund = "false";
    env.npm_config_audit = "false";
    env.npm_config_update_notifier = "false";
    return env;
}
/** argv only — never a shell string. See runtime.js header. */
function run(ws, argv, timeoutMs) {
    return new Promise((resolve) => {
        const [cmd, ...args] = argv;
        const child = spawn(cmd, args, {
            cwd: ws.root, windowsHide: true,
            env: childEnv(), // never process.env — see childEnv()
            detached: process.platform !== "win32" // POSIX: own process group, so killTree can target -pid
        });
        let stdout = "", stderr = "", timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            killTree(child);
        }, timeoutMs || 120000);
        child.stdout.on("data", (d) => { stdout += d.toString(); });
        child.stderr.on("data", (d) => { stderr += d.toString(); });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code: timedOut ? null : code, stdout, stderr, timedOut });
        });
        child.on("error", (e) => {
            clearTimeout(timer);
            resolve({ code: null, stdout, stderr: stderr + "\n" + e.message, timedOut: false });
        });
    });
}
/* ---------- preview: the client's own app, running ----------
   One long-lived `npm run dev` per workspace, on its own port, bound to
   127.0.0.1 ONLY. Binding to loopback rather than 0.0.0.0 means a
   client's dev server is not reachable from the network directly — the
   platform's own authenticated proxy route is the only way in, so the
   existing owner check still gates every preview request. */
const PREVIEW_PORT = 5173; // vite's default; the base of the search
exports.PREVIEW_PORT = PREVIEW_PORT;
const previews = new Map(); // wsId -> { child, port, startedAt }
/** A free TCP port, found by actually binding one rather than guessing —
    two projects starting at once can't be handed the same number. */
function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const p = srv.address().port;
            srv.close(() => resolve(p));
        });
    });
}
/** Resolves once the dev server answers, so callers never hand out a URL
    that 404s because vite is still booting. */
async function waitForPort(port, deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        const ok = await new Promise((resolve) => {
            const sock = net.connect({ port, host: "127.0.0.1" }, () => { sock.end(); resolve(true); });
            sock.on("error", () => resolve(false));
            sock.setTimeout(800, () => { sock.destroy(); resolve(false); });
        });
        if (ok)
            return true;
        await new Promise((r) => setTimeout(r, 300));
    }
    return false;
}
async function startPreview(ws, timeoutMs) {
    assertDevOnly();
    const existing = previews.get(ws.id);
    // Still listening? Reuse it — restarting would drop vite's HMR state
    // and make every follow-up edit cost a full cold boot.
    if (existing && await waitForPort(existing.port, 1)) {
        return { ok: true, url: "http://127.0.0.1:" + existing.port, port: existing.port };
    }
    if (existing)
        await stopPreview(ws);
    const port = await freePort();
    const child = spawn("npm", ["run", "dev", "--", "--port", String(port), "--host", "127.0.0.1", "--strictPort"], {
        cwd: ws.root, windowsHide: true,
        env: childEnv(),
        detached: process.platform !== "win32"
    });
    // Kept for diagnostics only — a dev server that fails to boot is a
    // real error the agent should see, so the tail is surfaced below.
    let log = "";
    child.stdout.on("data", (d) => { log = (log + d).slice(-4000); });
    child.stderr.on("data", (d) => { log = (log + d).slice(-4000); });
    child.on("error", (e) => { log += "\n" + e.message; });
    previews.set(ws.id, { child, port, startedAt: Date.now() });
    const up = await waitForPort(port, timeoutMs || 60000);
    if (!up) {
        await stopPreview(ws);
        return { ok: false, reason: "the dev server did not start listening in time", log: log.slice(-1500) };
    }
    return { ok: true, url: "http://127.0.0.1:" + port, port };
}
async function stopPreview(ws) {
    const p = previews.get(ws.id);
    if (!p)
        return;
    previews.delete(ws.id);
    try {
        killTree(p.child);
    }
    catch (e) { /* already gone */ }
    // Give the OS a beat to release the port and any file handles before a
    // caller (destroy, or a restart) tries to reuse them.
    await new Promise((r) => setTimeout(r, 300));
}
/** The local analogue of Daytona's signed preview URL. There is no
    external domain here — the platform proxies this loopback address
    under its own origin, so this is only ever consumed server-side. */
async function getPublicPreviewUrl(ws) {
    const p = previews.get(ws.id);
    if (!p)
        throw new Error("no preview is running for this workspace");
    return "http://127.0.0.1:" + p.port;
}
/** Binary-safe write, for an uploaded logo. Mirrors daytona-runtime's
    writeBinaryFile — kept off the model's own tool surface deliberately. */
async function writeBinaryFile(ws, relPath, base64) {
    const full = resolveInWorkspace(ws, relPath);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, Buffer.from(base64, "base64"));
}
/** Reads the built dist/ for publishing. base64 for every file so a
    binary asset survives the round-trip intact. */
async function readDist(ws) {
    const distRoot = path.join(ws.root, "dist");
    const out = {};
    async function walkDist(dir) {
        let entries;
        try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
        }
        catch (e) {
            return;
        }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                await walkDist(full);
                continue;
            }
            const rel = path.relative(distRoot, full).split(path.sep).join("/");
            out[rel] = (await fsp.readFile(full)).toString("base64");
        }
    }
    await walkDist(distRoot);
    return out;
}
async function snapshot(ws) {
    const files = await listFiles(ws, undefined);
    const hashed = await Promise.all(files.map(async (rel) => {
        const buf = await fsp.readFile(resolveInWorkspace(ws, rel));
        return { path: rel, sha256: crypto.createHash("sha256").update(buf).digest("hex") };
    }));
    return { files: hashed, at: new Date().toISOString() };
}
/** A file recently released by a killed child process (esbuild's native
    binary, in particular) can stay locked on Windows for a beat after the
    process is gone. `fs.rm`'s own maxRetries handles most of that, but it
    only retries ENOENT/EBUSY races on the SAME call — this adds one outer
    retry so a slow-to-release handle doesn't leak the whole workspace. */
async function destroy(ws) {
    // Kill the dev server FIRST — on Windows an running esbuild/vite holds
    // handles inside the tree, and rm would fail or half-delete otherwise.
    await stopPreview(ws);
    const attempt = () => fsp.rm(ws.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    try {
        await attempt();
    }
    catch (e) {
        await new Promise((r) => setTimeout(r, 500));
        await attempt();
    }
}
(0, runtime_1.registerRuntime)("local", {
    create, attach, writeFile, writeBinaryFile, readFile, listFiles, run, snapshot, destroy,
    startPreview, stopPreview, getPublicPreviewUrl, readDist
});
