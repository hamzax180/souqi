/* =================================================================
   agent/sandbox.js — a disposable container that builds one thing
   -----------------------------------------------------------------
   The code agent's only judge of its own work has been the user's
   browser: it ships the candidate files down, a WebContainer compiles
   them, and the browser reports back. That is a CLIENT CLAIM. It is
   also absent on a phone, where there is no SharedArrayBuffer and so
   no WebContainer at all, and it counts a check that merely timed out
   as a pass.

   This is the other thing: a container on a host we control, running
   the same `npm run build` the scaffold defines, returning errors
   keyed to the exact source hash it was given.

   WHAT IT IS NOT. It does not deploy, serve, or outlive its check. It
   is created, given files, run once, read, and destroyed — and the
   destroy is in a finally, because a sandbox that survives its check
   is a slot the next one cannot have.

   WHY IT IS NOT runApp(). A deployment is a long-lived container on
   its own --internal network with a restart policy, addressable
   through Caddy. None of that is wanted here and the restart policy is
   actively wrong: a build that crashes should be a failed check, not
   something Docker keeps retrying. The hardening is the same, and is
   deliberately a little tighter — see buildSandboxArgs.

   THE MODEL NEVER CHOOSES ANY OF THIS. It asks for "a check". The
   image, the command, the limits and the network are fixed here. There
   is no path from a tool call to an argument in this file.
   ================================================================= */
"use strict";

const path = require("path");
const crypto = require("crypto");
const { cfg } = require("../config");
const engine = require("../docker/engine");

/** Disposable and clearly not an app: the janitor and capacity both key
    off the `app-` prefix, and a sandbox must never be mistaken for a
    deployment by either of them. */
const NAME_PREFIX = "sbx-";

/* Node, because the scaffold is a Vite project and `npm run build`
   is `tsc --noEmit && vite build`. Pinned by tag rather than floating:
   a check that passes on Tuesday and fails on Wednesday because the
   base image moved is worse than no check. */
const IMAGE = process.env.AGENT_SANDBOX_IMAGE || "node:20-alpine";

const DEFAULTS = {
  cpu: Number(process.env.AGENT_SANDBOX_CPU || 1),
  memoryMb: Number(cfg.admission.agentSandboxMemoryMb || 1024),
  pids: Number(process.env.AGENT_SANDBOX_PIDS || 256),
  /* Wall clock for the whole check. A build that has not finished in
     three minutes is not going to, and holding one of two slots open
     for it starves everybody else. */
  timeoutMs: Number(process.env.AGENT_SANDBOX_TIMEOUT_MS || 180000),
  /* Output is fed to a model, so it is bounded twice: here, and again
     by whatever formats it. */
  maxOutputChars: 60000
};

/* ── what the agent may run in there ─────────────────────────────
   The allowlist is HERE, on the plane, not in the tool that asks. The
   tool is a description the model reads; this is the thing holding the
   Docker socket, and it does not get to assume the caller validated
   anything. Both check, and this one is the one that counts.

   Subcommands, not just binaries: "npm" alone would include `npm
   publish` and `npm config set`, and the point is a bounded set of
   things a build needs rather than a package manager. */
const ALLOWED_COMMANDS = {
  npm: new Set(["run", "install", "ci", "ls", "test"]),
  npx: new Set(["tsc", "vite", "eslint"]),
  node: new Set(["--version", "-v"]),
  ls: null,      // null = no subcommand constraint; the binary itself is the whole grant
  cat: null,
  pwd: null
};

/** Quote-aware, so a path with a space does not silently become two
    arguments. The same shape backend/lib/codeagent/tools.ts uses, and
    for the same reason it gives. */
function tokenize(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(cmd || "")))) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

/**
 * Throws unless every part of this command is allowed.
 *
 * Shell metacharacters are refused outright rather than escaped. The
 * argv never reaches a shell — it is exec'd directly — so a pipe or a
 * semicolon in it is not dangerous so much as a sign the model thinks
 * it is talking to one, and letting it through would teach it that it
 * is. Refusing says what it can have instead.
 */
function assertAllowed(argv) {
  if (!argv.length) throw new Error("empty command");
  const joined = argv.join(" ");
  if (/[;&|`$><\n\r]|\$\(/.test(joined)) {
    throw new Error("shell syntax is not available here — commands are run directly, " +
      "one at a time, with no shell to pipe or chain through");
  }
  const [bin, sub] = argv;
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_COMMANDS, bin)) {
    throw new Error('"' + bin + '" is not available in the build sandbox (allowed: ' +
      Object.keys(ALLOWED_COMMANDS).join(", ") + ")");
  }
  const subs = ALLOWED_COMMANDS[bin];
  if (subs && !subs.has(sub)) {
    throw new Error('"' + bin + " " + (sub || "") + '" is not allowed (allowed: ' +
      [...subs].map((x) => bin + " " + x).join(", ") + ")");
  }
  return argv;
}

/** The default, and what check_project has always meant. */
const DEFAULT_ARGV = ["npm", "run", "build"];

function sandboxName(checkId) {
  return NAME_PREFIX + String(checkId).replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 48);
}

/**
 * The run arguments. Split out from run() so the limits can be asserted
 * without a Docker daemon — every claim this file's header makes about
 * isolation is a string in this array, and a test can read it.
 */
function buildSandboxArgs({ checkId, cpu, memoryMb, pids, network }) {
  return [
    "run", "--rm", "--detach",
    "--name", sandboxName(checkId),

    // Same ceilings a deployment gets. memory-swap EQUAL to memory so a
    // build at its limit is OOM-killed in isolation rather than swapping
    // and dragging the host down with it.
    "--cpus", String(cpu),
    "--memory", memoryMb + "m",
    "--memory-swap", memoryMb + "m",
    "--pids-limit", String(pids),
    "--ulimit", "nofile=1024:2048",

    "--security-opt", "no-new-privileges",
    "--cap-drop", "ALL",

    /* NON-ROOT. A deployment's image chooses its own user; here the
       image is ours, so the user is not left to it. node:alpine ships
       uid 1000 as `node`. */
    "--user", "1000:1000",

    /* NO NETWORK AT ALL by default.

       A deployment needs its own --internal network because Caddy has
       to reach it. Nothing has to reach a build, and the build has to
       reach nothing: dependencies are baked into the image, so `none`
       is achievable here in a way it is not for an app. That closes
       package-install-time execution, exfiltration of whatever the
       model wrote, and any route to the Docker API in one line. */
    "--network", network || "none",

    // Nothing is published. There is no -p flag in this file either.

    /* No restart policy, deliberately. A build that crashes is a failed
       check; Docker retrying it forever is a held slot and a lie. */

    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000",
    /* The build writes here — node_modules/.vite, dist.

       uid/gid are NOT optional, and a real run is what proved it: a
       tmpfs is mounted root-owned by default, so with --user 1000 the
       container could not write to its own working directory and the
       extract failed silently, leaving an empty /work and a build that
       complained it could not find package.json.

       noexec is deliberately NOT set here, unlike /tmp. `npm run build`
       execs binaries out of node_modules/.bin — vite and tsc are the
       whole point — so a noexec /work is a build that cannot run at
       all. /tmp gets it because nothing legitimate execs from there. */
    "--tmpfs", "/work:rw,nosuid,size=512m,uid=1000,gid=1000",

    "--workdir", "/work",

    /* Labelled so the janitor can reap an orphan, and pointedly NOT
       with souqi.deployment — engine.listManaged() filters on that, and
       a sandbox appearing in the deployment count is the confusion the
       static reserve in capacity.js exists to avoid. */
    "--label", "souqi.managed=true",
    "--label", "souqi.role=agent-sandbox",
    "--label", "souqi.check=" + checkId,

    IMAGE,
    // Held open by the runner, which execs the real work in.
    "sh", "-c", "sleep " + Math.ceil(DEFAULTS.timeoutMs / 1000)
  ];
}

/** Content hash of the exact tree that was checked, so a result can be
    tied to the source it describes and not to "whatever was there". */
function hashFiles(files) {
  const h = crypto.createHash("sha256");
  for (const p of Object.keys(files || {}).sort()) {
    h.update(p, "utf8");
    h.update("\u0000", "utf8");
    h.update(String(files[p] ?? ""), "utf8");
    h.update("\u0000", "utf8");
  }
  return h.digest("hex").slice(0, 32);
}

/** Refuse anything that is not a plain relative path inside the tree.
    The model's own write boundary already refuses these, but this is a
    different process reading a payload off the network, and it does not
    get to assume the sender was the one that validated it. */
function safeRelPath(p) {
  const clean = String(p || "").replace(/\\/g, "/").trim();
  if (!clean || clean.startsWith("/") || clean.includes("..")) return null;
  if (clean.includes("\u0000")) return null;
  if (path.isAbsolute(clean)) return null;
  return clean;
}

module.exports = {
  NAME_PREFIX, IMAGE, DEFAULTS, DEFAULT_ARGV, ALLOWED_COMMANDS,
  sandboxName, buildSandboxArgs, hashFiles, safeRelPath, tokenize, assertAllowed
};
