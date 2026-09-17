/* =================================================================
   agent/runner.js — run one build in one sandbox, then destroy it
   -----------------------------------------------------------------
   Lives in the WORKER, not the api. The api has no Docker socket on
   purpose (see the note at the top of api/server.js), and a verifier
   that cannot create a container would report every check as a
   failure of the user's code rather than of its own permissions —
   which is the exact mistake `docker logs` already made here once.

   Concurrency is capped at the slots capacity.js holds back, so the
   agent cannot take the whole host either. Over the cap the answer is
   an honest "busy", not a queue: the agent's turn budget is measured
   in tens of seconds and a build that starts in four minutes has
   already failed the thing it was for.
   ================================================================= */
"use strict";

const fsp = require("fs/promises");
const path = require("path");
const engine = require("../docker/engine");
const capacity = require("../monitor/capacity");
const { cfg } = require("../config");
const sandbox = require("./sandbox");

/* In-flight checks by checkId. One process holds the socket, so an
   in-memory count IS the truth here — there is no second worker to
   disagree with it. */
const inFlight = new Map();

function slots() {
  return Math.max(1, capacity.reservedSandboxes());
}

/** Write the tree to a staging directory. Paths were validated by the
    caller AND re-validated here: this is the step that turns a string
    into a real filesystem path, so it is the last place a traversal
    could matter. */
async function writeTree(root, files) {
  await fsp.mkdir(root, { recursive: true });
  for (const [rel, contents] of Object.entries(files || {})) {
    const safe = sandbox.safeRelPath(rel);
    if (!safe) throw new Error("unsafe path reached the sandbox writer: " + rel);
    const full = path.join(root, safe);
    const resolvedRoot = path.resolve(root) + path.sep;
    if (!path.resolve(full).startsWith(resolvedRoot)) {
      throw new Error("path escaped the staging directory: " + rel);
    }
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, String(contents ?? ""), "utf8");
  }
  return root;
}

/** Structured errors from the build output, same shape the agent's own
    parser produces so both paths feed the repair loop identically. */
function parseErrors(output) {
  const lines = String(output || "").split("\n");
  const errors = [];
  const TSC = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/;
  const ROLLUP = /Could not resolve\s+["']([^"']+)["']\s+from\s+["']([^"']+)["']/;
  const ESBUILD = /^\s*(\S+\.[tj]sx?):(\d+):(\d+):\s*(?:ERROR:\s*)?(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i]).trim();
    if (!line) continue;
    let m = TSC.exec(line);
    if (m) { errors.push({ file: m[1], line: Number(m[2]), col: Number(m[3]), code: m[4], message: m[5] }); continue; }
    m = ROLLUP.exec(line);
    if (m) {
      errors.push({
        file: m[2], line: 0, col: 0, code: "UNRESOLVED_IMPORT",
        message: 'Could not resolve "' + m[1] + '". That file does not exist - either write it or drop the import.'
      });
      continue;
    }
    m = ESBUILD.exec(line);
    if (m) {
      let message = m[4];
      if (!message) {
        const next = String(lines[i + 1] || "").trim();
        if (next && !ESBUILD.test(next)) message = next;
      }
      errors.push({ file: m[1], line: Number(m[2]), col: Number(m[3]), code: "", message: message || "(see raw output)" });
    }
  }
  return errors;
}

/**
 * Check one tree.
 *
 * Always resolves. A check that cannot run is `ok:false` with
 * `infra:true`, and that distinction is the point: an infrastructure
 * failure must never be fed back to a model as a defect in the code,
 * because no rewrite fixes it and the repair rounds spent trying are
 * spent on nothing. The browser path learned this the hard way.
 */
async function check({ checkId, runId, files, sourceHash }) {
  if (inFlight.size >= slots()) {
    return {
      ok: false, infra: true, attested: false,
      reason: "all " + slots() + " build sandboxes are busy", errors: [], raw: ""
    };
  }
  if (inFlight.has(checkId)) {
    return { ok: false, infra: true, attested: false, reason: "that check is already running", errors: [], raw: "" };
  }

  const name = sandbox.sandboxName(checkId);
  inFlight.set(checkId, Date.now());
  let created = false;
  let staging = null;

  try {
    const args = sandbox.buildSandboxArgs({
      checkId,
      cpu: sandbox.DEFAULTS.cpu,
      memoryMb: sandbox.DEFAULTS.memoryMb,
      pids: sandbox.DEFAULTS.pids
    });
    /* engine.docker() RESOLVES on failure rather than rejecting — see
       its own body, which turns every error into {ok:false}. Checking
       `.ok` is the difference between an honest "could not start the
       sandbox" and a check that reports the user's code as broken
       because nothing ever ran. */
    const started = await engine.docker(args, { timeoutMs: 60000 });
    if (!started.ok) {
      throw new Error("could not start the sandbox: " + (started.stderr || "").slice(0, 300));
    }
    created = true;

    /* Staged to disk and copied in, rather than bind-mounted.

       A bind mount would put a host path inside a container whose whole
       isolation argument is that it has no route to anything, and it
       would be writable by the build. `docker cp` is a one-way
       snapshot: what goes in is what we wrote, and nothing the build
       does reaches back out. The staging directory is removed in the
       finally below whatever happens. */
    staging = path.join(cfg.buildRoot, "agent-check-" + name);
    await writeTree(staging, files);
    const copied = await engine.docker(["cp", staging + "/.", name + ":/work"], { timeoutMs: 60000 });
    if (!copied.ok) throw new Error("could not copy the source in: " + (copied.stderr || "").slice(0, 300));

    const beganAt = Date.now();
    const run = await engine.docker(
      ["exec", name, "sh", "-lc", "npm run build"],
      { timeoutMs: sandbox.DEFAULTS.timeoutMs }
    );
    const ms = Date.now() - beganAt;

    const raw = String((run.stdout || "") + "\n" + (run.stderr || "")).slice(-sandbox.DEFAULTS.maxOutputChars);
    const passed = run.code === 0;

    return {
      ok: passed,
      /* The word the browser path could never honestly use. This ran on
         a host we control, on a tree whose hash we computed ourselves. */
      attested: true,
      infra: false,
      timedOut: !!run.timedOut,
      sourceHash,
      ms,
      errors: passed ? [] : parseErrors(raw),
      raw: passed ? "" : raw
    };
  } catch (e) {
    return {
      ok: false, infra: true, attested: false,
      reason: String((e && e.message) || e), errors: [], raw: ""
    };
  } finally {
    inFlight.delete(checkId);
    if (staging) {
      try { await fsp.rm(staging, { recursive: true, force: true }); }
      catch (_) { /* best effort; the janitor sweeps buildRoot anyway */ }
    }
    /* In a finally, and swallowing its own failure: a sandbox that
       survives its check is one of two slots the next check cannot
       have, and --rm only fires if the container actually stops. */
    if (created) {
      try { await engine.docker(["rm", "--force", "--volumes", name], { timeoutMs: 30000 }); }
      catch (_) { /* already gone, or the daemon took it with --rm */ }
    }
  }
}

/** Sandboxes left behind by a worker that died mid-check. Reaped on the
    same sweep the janitor already runs, because nothing else will. */
async function reapOrphans(maxAgeMs) {
  const cutoff = Date.now() - (Number(maxAgeMs) || sandbox.DEFAULTS.timeoutMs * 2);
  let reaped = 0;
  try {
    const out = await engine.docker(
      ["ps", "-a", "--filter", "label=souqi.role=agent-sandbox", "--format", "{{.Names}}|{{.CreatedAt}}"],
      { timeoutMs: 15000 }
    );
    for (const line of String(out.stdout || "").trim().split("\n")) {
      if (!line) continue;
      const [name, createdAt] = line.split("|");
      if (!name || inFlight.has(String(name).replace(sandbox.NAME_PREFIX, ""))) continue;
      const at = Date.parse(createdAt);
      if (Number.isFinite(at) && at > cutoff) continue;
      try { await engine.docker(["rm", "--force", "--volumes", name], { timeoutMs: 30000 }); reaped++; }
      catch (_) { /* raced with something else */ }
    }
  } catch (_) { /* no daemon, nothing to reap */ }
  return reaped;
}

function state() {
  return { inFlight: inFlight.size, slots: slots() };
}

module.exports = { check, reapOrphans, state, parseErrors, slots, writeTree };
