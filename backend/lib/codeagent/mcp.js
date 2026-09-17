/* =================================================================
   codeagent/mcp.js — Model Context Protocol client (Powered Souqi)
   -----------------------------------------------------------------
   Gives the agent tools it does not own: docs lookups, design token
   servers, component registries, an issue tracker — whatever the
   operator has configured. Powered Souqi mode only. Eco Souqi is
   defined by being the fast, cheap, no-side-effects path, and an
   agent that stops mid-generation to round-trip an external server
   is neither.

   Hand-rolled JSON-RPC rather than @modelcontextprotocol/sdk on
   purpose: that package is ESM-only and this server is CommonJS, so
   pulling it in means either a dynamic-import shim in a hot path or
   converting the server. The client half of MCP that we actually
   use is four methods, and they are specified precisely.

   TRUST BOUNDARY — the important part of this file:
   An MCP server is a third party. Everything that comes back from
   one (tool names, descriptions, tool results) is DATA that gets
   shown to a model, never instructions this process obeys. Two
   consequences enforced below:
     • tool names are namespaced and re-validated, so a server
       cannot claim the name `write_file` and hijack the one tool
       that actually writes to the user's project;
     • results are size-capped, so a server cannot exhaust the
       model's context (or this process's memory) with one reply.

   Configured by server/mcp.json (see mcp.example.json) or the
   MCP_SERVERS env var. No servers configured is the default and is
   NOT an error — Powered Souqi then simply runs without MCP tools.
   ================================================================= */
"use strict";
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
exports.EMPTY = exports.McpRegistry = exports.NAME_RE = exports.McpServer = void 0;
exports.loadConfig = loadConfig;
exports.normaliseConfig = normaliseConfig;
exports.qualify = qualify;
exports.connectAll = connectAll;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const spawn = require("cross-spawn");
const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "souqi-codeagent", version: "1.0.0" };
const CONNECT_TIMEOUT_MS = 15000;
const CALL_TIMEOUT_MS = 30000;
// One tool result, capped. 24k chars is roughly 6k tokens — generous for a
// docs lookup, and small enough that a server returning a 10MB blob costs a
// truncation notice instead of the whole build.
const MAX_RESULT_CHARS = 24000;
const MAX_TOOLS_PER_SERVER = 40;
/* ---------- configuration ---------- */
function loadConfig() {
    const raw = (process.env.MCP_SERVERS || "").trim();
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            return normaliseConfig(parsed);
        }
        catch (e) {
            console.warn("[mcp] MCP_SERVERS is not valid JSON — ignoring:", e.message);
            return [];
        }
    }
    const file = path.join(__dirname, "..", "..", "mcp.json");
    if (!fs.existsSync(file))
        return [];
    try {
        return normaliseConfig(JSON.parse(fs.readFileSync(file, "utf8")));
    }
    catch (e) {
        console.warn("[mcp] mcp.json is not valid JSON — ignoring:", e.message);
        return [];
    }
}
/** Accepts either {mcpServers:{name:{...}}} (Claude Desktop's shape) or a plain array. */
function normaliseConfig(parsed) {
    const servers = [];
    const src = parsed && parsed.mcpServers ? parsed.mcpServers : parsed;
    if (Array.isArray(src)) {
        for (const s of src)
            if (s && s.name)
                servers.push(s);
    }
    else if (src && typeof src === "object") {
        for (const [name, s] of Object.entries(src)) {
            if (s && typeof s === "object")
                servers.push(Object.assign({ name }, s));
        }
    }
    return servers.filter((s) => s.enabled !== false && (s.command || s.url));
}
/* ---------- transports ---------- */
/**
 * stdio transport: newline-delimited JSON-RPC over a child process's stdin
 * and stdout. Note stderr is NOT parsed — MCP servers use it for logging,
 * and treating a log line as a protocol frame is a classic way to hang.
 */
function stdioTransport(cfg) {
    const child = spawn(cfg.command, cfg.args || [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: Object.assign({}, process.env, cfg.env || {}),
        cwd: cfg.cwd || undefined
    });
    const pending = new Map();
    let buf = "";
    let closed = false;
    let closeReason = "";
    child.stdout.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line)
                continue;
            let msg;
            try {
                msg = JSON.parse(line);
            }
            catch (e) {
                continue;
            } // non-JSON on stdout is noise, not a frame
            if (msg.id !== undefined && pending.has(msg.id)) {
                const { resolve } = pending.get(msg.id);
                pending.delete(msg.id);
                resolve(msg);
            }
        }
    });
    child.stderr.on("data", (c) => {
        const s = c.toString("utf8").trim();
        if (s)
            console.warn("[mcp:" + cfg.name + "] " + s.slice(0, 400));
    });
    function fail(reason) {
        closed = true;
        closeReason = reason;
        for (const [, { resolve }] of pending)
            resolve({ error: { message: reason } });
        pending.clear();
    }
    child.on("error", (e) => fail("failed to start \"" + cfg.command + "\": " + e.message));
    child.on("exit", (code) => fail("server exited with code " + code));
    return {
        kind: "stdio",
        send(msg, timeoutMs) {
            if (closed)
                return Promise.resolve({ error: { message: closeReason || "transport closed" } });
            if (msg.id === undefined) { // notification: no reply expected
                try {
                    child.stdin.write(JSON.stringify(msg) + "\n");
                }
                catch (e) { /* closed under us */ }
                return Promise.resolve(null);
            }
            return new Promise((resolve) => {
                const timer = setTimeout(() => {
                    pending.delete(msg.id);
                    resolve({ error: { message: "timed out after " + timeoutMs + "ms" } });
                }, timeoutMs);
                pending.set(msg.id, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
                try {
                    child.stdin.write(JSON.stringify(msg) + "\n");
                }
                catch (e) {
                    clearTimeout(timer);
                    pending.delete(msg.id);
                    resolve({ error: { message: "write failed: " + e.message } });
                }
            });
        },
        close() { closed = true; try {
            child.kill();
        }
        catch (e) { /* already gone */ } }
    };
}
/**
 * Streamable HTTP transport. One POST per request; the server may answer
 * with JSON or with an SSE stream, so both are handled. `Mcp-Session-Id`
 * from the initialize response is echoed on every later request — servers
 * that keep session state reject requests without it.
 */
function httpTransport(cfg) {
    let sessionId = null;
    let closed = false;
    return {
        kind: "http",
        async send(msg, timeoutMs) {
            if (closed)
                return { error: { message: "transport closed" } };
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const headers = Object.assign({ "Content-Type": "application/json", "Accept": "application/json, text/event-stream" }, cfg.headers || {});
                if (sessionId)
                    headers["Mcp-Session-Id"] = sessionId;
                const res = await fetch(cfg.url, {
                    method: "POST", headers: headers, body: JSON.stringify(msg), signal: controller.signal
                });
                clearTimeout(timer);
                const sid = res.headers.get("mcp-session-id");
                if (sid)
                    sessionId = sid;
                if (msg.id === undefined)
                    return null; // notification
                if (!res.ok)
                    return { error: { message: "HTTP " + res.status } };
                const ctype = res.headers.get("content-type") || "";
                if (ctype.includes("text/event-stream")) {
                    // Read frames until the one carrying our id shows up. A server may
                    // interleave notifications and progress events ahead of the reply.
                    const text = await res.text();
                    for (const block of text.split("\n\n")) {
                        const line = block.split("\n").find((l) => l.startsWith("data:"));
                        if (!line)
                            continue;
                        try {
                            const parsed = JSON.parse(line.slice(5).trim());
                            if (parsed.id === msg.id)
                                return parsed;
                        }
                        catch (e) { /* keep scanning */ }
                    }
                    return { error: { message: "no response frame in event stream" } };
                }
                return await res.json();
            }
            catch (e) {
                clearTimeout(timer);
                return { error: { message: e.name === "AbortError" ? "timed out after " + timeoutMs + "ms" : e.message } };
            }
        },
        close() { closed = true; }
    };
}
/* ---------- one connected server ---------- */
class McpServer {
    cfg;
    name;
    transport;
    tools;
    ready;
    error;
    _nextId;
    constructor(cfg) {
        this.cfg = cfg;
        this.name = cfg.name;
        this.transport = null;
        this.tools = [];
        this.ready = false;
        this.error = null;
        this._nextId = 1;
    }
    async connect() {
        try {
            this.transport = this.cfg.url ? httpTransport(this.cfg) : stdioTransport(this.cfg);
            const init = await this._rpc("initialize", {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: CLIENT_INFO
            }, CONNECT_TIMEOUT_MS);
            if (init.error)
                throw new Error(init.error.message);
            // Required by the spec: the server may not serve requests until it has
            // seen this. Omitting it works against lenient servers and hangs
            // against strict ones, which is the worst kind of bug to debug.
            await this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" }, 1000);
            const listed = await this._rpc("tools/list", {}, CONNECT_TIMEOUT_MS);
            if (listed.error)
                throw new Error(listed.error.message);
            this.tools = ((listed.result && listed.result.tools) || []).slice(0, MAX_TOOLS_PER_SERVER);
            this.ready = true;
            return true;
        }
        catch (e) {
            this.error = e.message;
            this.close();
            return false;
        }
    }
    async _rpc(method, params, timeoutMs) {
        const msg = { jsonrpc: "2.0", id: this._nextId++, method: method, params: params || {} };
        const reply = await this.transport.send(msg, timeoutMs || CALL_TIMEOUT_MS);
        return reply || { error: { message: "no reply" } };
    }
    async callTool(toolName, args) {
        if (!this.ready)
            return { ok: false, text: "MCP server \"" + this.name + "\" is not connected" };
        const reply = await this._rpc("tools/call", { name: toolName, arguments: args || {} }, CALL_TIMEOUT_MS);
        if (reply.error)
            return { ok: false, text: "MCP error: " + reply.error.message };
        const result = reply.result || {};
        // MCP returns a content-block array; flatten to the plain text a
        // chat-completions tool result has to be.
        const parts = [];
        for (const block of result.content || []) {
            if (block.type === "text")
                parts.push(block.text);
            else if (block.type === "resource" && block.resource) {
                parts.push(block.resource.text || ("[resource " + (block.resource.uri || "") + "]"));
            }
            else if (block.type === "image")
                parts.push("[image omitted]");
        }
        let text = parts.join("\n").trim() || "(no output)";
        if (text.length > MAX_RESULT_CHARS) {
            text = text.slice(0, MAX_RESULT_CHARS) + "\n…[truncated " + (text.length - MAX_RESULT_CHARS) + " chars]";
        }
        // isError is a TOOL-level failure (bad args, upstream 404), not a
        // transport failure. It goes back to the model as a readable result so
        // it can correct itself, rather than aborting the build.
        return { ok: !result.isError, text: text };
    }
    close() {
        if (this.transport) {
            try {
                this.transport.close();
            }
            catch (e) { /* best effort */ }
        }
        this.ready = false;
    }
}
exports.McpServer = McpServer;
/* ---------- the registry the model loop talks to ---------- */
// Tool names are namespaced `mcp__<server>__<tool>` so that:
//   1. an MCP server can never collide with write_file (the only tool that
//      touches the user's project), and
//   2. a returning call can be routed back to the right server by name alone.
exports.NAME_RE = /^mcp__([a-zA-Z0-9_-]+)__([a-zA-Z0-9_.-]+)$/;
function qualify(serverName, toolName) {
    return "mcp__" + String(serverName).replace(/[^a-zA-Z0-9_-]/g, "_") + "__" + String(toolName).replace(/[^a-zA-Z0-9_.-]/g, "_");
}
class McpRegistry {
    servers;
    byQualified;
    constructor(servers) {
        this.servers = servers;
        this.byQualified = new Map();
        for (const s of servers) {
            for (const t of s.tools)
                this.byQualified.set(qualify(s.name, t.name), { server: s, tool: t });
        }
    }
    get size() { return this.byQualified.size; }
    /** OpenAI function-tool schemas, ready to concatenate onto write_file. */
    toolSchemas() {
        const out = [];
        for (const [qualified, { server, tool }] of this.byQualified) {
            out.push({
                type: "function",
                function: {
                    name: qualified,
                    // The server's own description is third-party text shown to the
                    // model. Prefixing the server name makes its provenance legible in
                    // the transcript instead of letting it read as a first-party tool.
                    description: "[" + server.name + "] " + String(tool.description || tool.name).slice(0, 600),
                    parameters: tool.inputSchema || tool.input_schema || { type: "object", properties: {} }
                }
            });
        }
        return out;
    }
    isMcpTool(name) { return exports.NAME_RE.test(String(name || "")) && this.byQualified.has(name); }
    async call(qualifiedName, args) {
        const entry = this.byQualified.get(qualifiedName);
        if (!entry)
            return { ok: false, text: "no such MCP tool: " + qualifiedName };
        try {
            return await entry.server.callTool(entry.tool.name, args);
        }
        catch (e) {
            return { ok: false, text: "MCP call failed: " + e.message };
        }
    }
    summary() {
        return this.servers.map((s) => ({ name: s.name, tools: s.tools.length }));
    }
    close() { for (const s of this.servers)
        s.close(); }
}
exports.McpRegistry = McpRegistry;
exports.EMPTY = new McpRegistry([]);
/**
 * Connect to every configured server and return a registry of their tools.
 *
 * Never throws and never blocks a build: a server that fails to start is
 * logged and skipped. MCP is an enhancement to Powered Souqi, so "the docs
 * server is down" must degrade to "no docs tool this run", not to a failed
 * build — the model can still write the app without it.
 */
async function connectAll() {
    const cfgs = loadConfig();
    if (!cfgs.length)
        return exports.EMPTY;
    const servers = [];
    const results = await Promise.all(cfgs.map(async (cfg) => {
        const s = new McpServer(cfg);
        const ok = await s.connect();
        return { s, ok };
    }));
    for (const { s, ok } of results) {
        if (ok)
            servers.push(s);
        else
            console.warn("[mcp] server \"" + s.name + "\" unavailable: " + s.error);
    }
    return new McpRegistry(servers);
}
