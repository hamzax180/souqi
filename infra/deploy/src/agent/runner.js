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
const { spawn } = require("child_process");
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

/**
 * Stream a staged directory into the sandbox's /work.
 *
 * `tar -cf -` on this side, `tar -xf -` inside the container, joined by
 * a pipe. spawn without a shell on both ends: the container name and
 * the staging path are arguments, never a command line.
 */
function copyTreeInto(name, staging) {
  return new Promise((resolve, reject) => {
    const src = spawn("tar", ["-cf", "-", "-C", staging, "."], { stdio: ["ignore", "pipe", "pipe"] });
    const dst = spawn("docker", ["exec", "-i", name, "tar", "-xf", "-", "-C", "/work"],
      { stdio: ["pipe", "ignore", "pipe"] });

    let err = "";
    src.stderr.on("data", (b) => { err += String(b); });
    dst.stderr.on("data", (b) => { err += String(b); });

    const timer = setTimeout(() => {
      try { src.kill("SIGKILL"); } catch (_) { /* gone */ }
      try { dst.kill("SIGKILL"); } catch (_) { /* gone */ }
      reject(new Error("timed out copying the source in"));
    }, 60000);

    src.on("error", reject);
    dst.on("error", reject);
    src.stdout.pipe(dst.stdin);

    dst.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error("could not copy the source in: " + err.slice(0, 300)));
    });
  });
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

    /* Staged to disk, then streamed in as a tar. Not bind-mounted, and
       not `docker cp` either.

       A bind mount would put a host path inside a container whose whole
       isolation argument is that it has no route to anything.

       `docker cp` was the obvious alternative and it does not work
       here: the daemon refuses it outright for a container with a
       read-only rootfs — "container rootfs is marked read-only" — even
       when the destination is a writable tmpfs. That is only
       discoverable by running it against a real daemon, which is what
       happened. A tar over `docker exec -i` writes through the
       container's own filesystem view instead, so the tmpfs accepts it
       and the rootfs stays immutable.

       Piped process-to-process with no shell, so nothing in a path can
       be read as a command. The staging directory is removed in the
       finally below whatever happens. */
    staging = path.join(cfg.buildRoot, "agent-check-" + name);
    await writeTree(staging, files);
    await copyTreeInto(name, staging);

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

module.exports = { check, reapOrphans, state, parseErrors, slots, writeTree, copyTreeInto };
