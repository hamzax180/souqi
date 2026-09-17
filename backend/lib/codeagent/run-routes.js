"use strict";

const crypto = require("crypto");
const { TERMINAL, publicRun } = require("./worker-service");
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

function register(app, { store, ownerOf, limiter, prepare, onQueued }) {
  app.post("/api/codeagent/runs", limiter, wrap(async (req, res) => {
    const owner = await ownerOf(req, res);
    const key = String(req.get("Idempotency-Key") || "");
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(key)) return res.status(400).json({ error: "A valid Idempotency-Key is required" });
    const body = req.body || {};
    const request = {
      prompt: String(body.prompt || "").trim(), projectId: String(body.projectId || "").slice(0, 100),
      mode: String(body.mode || "auto"), effort: String(body.effort || "balanced"),
      chatId: String(body.chatId || "").slice(0, 40), provider: String(body.provider || "souqi"),
      buildType: String(body.buildType || "website").slice(0, 40), confirmed: body.confirmed === true,
      imageIds: Array.isArray(body.imageIds) ? body.imageIds.slice(0, 8).map(String) : [],
      conversation: Array.isArray(body.conversation) ? body.conversation.slice(-12).map(t => ({
        role: t && t.role === "agent" ? "agent" : "user", body: String(t && t.body || "").slice(0, 2000)
      })) : []
    };
    if (!request.prompt || request.prompt.length > 16000) return res.status(400).json({ error: "Prompt must contain 1–16000 characters" });
    if (!["auto", "build", "plan", "power"].includes(request.mode)) return res.status(400).json({ error: "Invalid agent mode" });
    if (request.mode === "plan" && !request.confirmed) return res.status(409).json({ error: "Review the plan before starting this run" });
    const requestHash = crypto.createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const previous = await store.getRunByIdempotency(owner, key, requestHash);
    const accepted = run => res.status(202).json({ runId: run.id, projectId: run.projectId,
      projectSlug: run.context && run.context.projectSlug, status: run.status });
    if (previous) return accepted(previous);
    if (!(await store.getWorkerHealth()).healthy) return res.status(503).json({
      error: "The build worker is unavailable. Your request has not been started. Please try again shortly.", code: "AGENT_WORKER_UNAVAILABLE"
    });
    req.body = request;
    const input = await prepare(req, res, owner);
    if (!input || res.headersSent) return;
    const run = await store.createRun(Object.assign({}, input, { owner, idempotencyKey: key, requestHash }));
    if (onQueued) await onQueued(run);
    return accepted(run);
  }));

  app.get("/api/codeagent/runs/:id", wrap(async (req, res) => {
    const run = await store.getRun(req.params.id, await ownerOf(req, res));
    if (!run) return res.status(404).json({ error: "Run not found" });
    const checkpoint = await store.getLatestCheckpoint(run.id);
    res.setHeader("Cache-Control", "no-store");
    res.json({ run: publicRun(run), projectId: run.projectId, projectSlug: run.context && run.context.projectSlug,
      files: checkpoint && checkpoint.files || {}, fileCount: checkpoint && checkpoint.fileCount || 0 });
  }));

  app.get("/api/codeagent/runs/:id/events", wrap(async (req, res) => {
    const owner = await ownerOf(req, res);
    const run = await store.getRun(req.params.id, owner);
    if (!run) return res.status(404).json({ error: "Run not found" });
    let sequence = Number(req.query.after || req.get("Last-Event-ID") || 0);
    if (!Number.isSafeInteger(sequence) || sequence < 0) return res.status(400).json({ error: "Invalid event cursor" });
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store",
      "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    const until = Date.now() + 45000;
    let closed = false;
    let wake;
    res.on("close", () => { closed = true; if (wake) wake(); });
    try {
      while (!closed && Date.now() < until) {
        const events = await store.getEvents(run.id, sequence);
        for (const event of events) {
          if (closed) break;
          res.write("id: " + event.seq + "\nevent: " + event.type + "\ndata: " +
            JSON.stringify(Object.assign({}, event.payload, { seq: event.seq })) + "\n\n");
          sequence = event.seq;
        }
        const current = await store.getRun(run.id, owner);
        if (!current || TERMINAL.has(current.status)) break;
        if (closed) break;
        res.write(": heartbeat\n\n");
        await new Promise(resolve => { const timer = setTimeout(resolve, 1000); wake = () => { clearTimeout(timer); resolve(); }; });
      }
    } finally { if (!res.writableEnded && !closed) res.end(); }
  }));

  /* A browser can render a preview, but cannot attest a production build. */
  app.post("/api/codeagent/runs/:id/check-result", wrap(async (req, res) => {
    const run = await store.getRun(req.params.id, await ownerOf(req, res));
    if (!run) return res.status(404).json({ error: "Run not found" });
    res.status(409).json({ error: "Verification is performed by the build service" });
  }));

  app.post("/api/codeagent/runs/:id/cancel", wrap(async (req, res) => {
    const owner = await ownerOf(req, res);
    const run = await store.getRun(req.params.id, owner);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const accepted = await store.cancelRun(run.id, owner, "Stopped by user");
    if (!accepted) return res.status(409).json({ error: "This run has already finished" });
    res.status(202).json({ cancelRequested: true });
  }));
}

module.exports = { register };
