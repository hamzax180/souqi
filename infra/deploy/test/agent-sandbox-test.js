/* =================================================================
   agent-sandbox-test.js — the isolation claims, read back as strings
   -----------------------------------------------------------------
   Every claim agent/sandbox.js makes about isolation is an argument in
   the array it builds, so a test can read them without a Docker
   daemon. That matters because the daemon is exactly what is missing
   from a laptop and from CI, and "we could not test it here" is how an
   unhardened container reaches a host.

   What this CANNOT prove: that Docker honours any of it. --network
   none is a string until a daemon reads it. The container behaviour
   needs a run on the host, and nothing here pretends otherwise.

   Run: node deploy/test/agent-sandbox-test.js
   ================================================================= */
"use strict";

const assert = require("assert");
const path = require("path");
const os = require("os");
const fsp = require("fs/promises");

const sandbox = require(path.join(__dirname, "..", "src", "agent", "sandbox.js"));
const runner = require(path.join(__dirname, "..", "src", "agent", "runner.js"));

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  " + name); }
  catch (e) { failures++; console.log("  FAIL " + name + "\n       " + e.message); }
}
async function checkAsync(name, fn) {
  try { await fn(); console.log("  ok  " + name); }
  catch (e) { failures++; console.log("  FAIL " + name + "\n       " + e.message); }
}

const args = sandbox.buildSandboxArgs({ checkId: "chk_abc", cpu: 1, memoryMb: 1024, pids: 256 });
const after = (flag) => args[args.indexOf(flag) + 1];
const has = (flag) => args.indexOf(flag) !== -1;

(async () => {

console.log("\nthe sandbox is bounded");

check("cpu, memory, pids and file descriptors all have ceilings", () => {
  assert.strictEqual(after("--cpus"), "1");
  assert.strictEqual(after("--memory"), "1024m");
  assert.strictEqual(after("--pids-limit"), "256");
  assert.ok(has("--ulimit"), "no nofile ulimit");
});

/* Without this a container at its limit swaps instead of being
   OOM-killed, and drags the whole host down with it. */
check("swap is disabled by pinning memory-swap to memory", () => {
  assert.strictEqual(after("--memory-swap"), after("--memory"));
});

check("the check has a wall clock", () => {
  assert.ok(sandbox.DEFAULTS.timeoutMs > 0 && sandbox.DEFAULTS.timeoutMs <= 600000,
    "timeout is " + sandbox.DEFAULTS.timeoutMs);
  // and the holding command cannot outlive it
  assert.ok(args.join(" ").indexOf("sleep " + Math.ceil(sandbox.DEFAULTS.timeoutMs / 1000)) !== -1);
});

check("output handed to a model is bounded", () => {
  assert.ok(sandbox.DEFAULTS.maxOutputChars > 0 && sandbox.DEFAULTS.maxOutputChars <= 200000);
});

console.log("\nthe sandbox cannot reach anything");

/* The strongest claim in the file. A deployment needs its own network
   because Caddy has to reach it; nothing has to reach a build, and the
   build's dependencies are in the image, so `none` is achievable here
   in a way it is not for an app. */
check("it has no network at all", () => {
  assert.strictEqual(after("--network"), "none");
});

check("nothing is published", () => {
  assert.ok(!has("-p") && !has("--publish"), "a port is published");
});

check("no Docker socket is mounted", () => {
  const joined = args.join(" ");
  assert.ok(joined.indexOf("docker.sock") === -1, "the socket appears in the run args");
  assert.ok(!has("-v") && !has("--volume"), "a volume is bind-mounted");
});

check("it runs as a non-root user", () => {
  const user = after("--user");
  assert.ok(user && user !== "0:0" && user.indexOf("root") === -1, "user is " + user);
});

check("privileges cannot be gained and capabilities are dropped", () => {
  assert.strictEqual(after("--security-opt"), "no-new-privileges");
  assert.strictEqual(after("--cap-drop"), "ALL");
  assert.ok(!has("--privileged"), "the container is privileged");
});

check("the root filesystem is immutable and scratch is not executable", () => {
  assert.ok(has("--read-only"), "root is writable");
  const tmpfs = args.filter((a, i) => args[i - 1] === "--tmpfs");
  assert.ok(tmpfs.length >= 2, "expected tmpfs scratch");
  for (const t of tmpfs) assert.ok(t.indexOf("nosuid") !== -1, "tmpfs without nosuid: " + t);
  // /work is where the build writes; nothing in a build output needs +x
  const work = tmpfs.find((t) => t.startsWith("/work:"));
  assert.ok(work, "no /work scratch");
  assert.ok(work.indexOf("exec") === -1 || work.indexOf("noexec") !== -1, "/work is executable: " + work);
});

/* A build that crashes is a failed check. Docker retrying it forever is
   a held slot and a lie about what happened. */
check("there is no restart policy", () => {
  assert.ok(!has("--restart"), "the sandbox restarts itself");
});

console.log("\na sandbox is not a deployment");

/* capacity.js counts deployments by label AND by the app- prefix. A
   sandbox appearing in that count is the confusion the static reserve
   exists to avoid. */
check("it is not labelled as a deployment and is not named like an app", () => {
  const labels = args.filter((a, i) => args[i - 1] === "--label");
  assert.ok(labels.indexOf("souqi.managed=true") !== -1, "not labelled as ours");
  assert.ok(labels.some((l) => l === "souqi.role=agent-sandbox"), "no agent-sandbox role label");
  assert.ok(!labels.some((l) => l.startsWith("souqi.deployment=")), "labelled as a deployment");
  assert.ok(sandbox.sandboxName("chk_abc").startsWith("sbx-"), "named like an app");
  assert.ok(!sandbox.sandboxName("chk_abc").startsWith("app-"));
});

check("the name is sanitised, so a checkId cannot become a docker flag", () => {
  const nasty = sandbox.sandboxName("../../evil --privileged");
  assert.ok(!/[^a-zA-Z0-9_.-]/.test(nasty.replace(sandbox.NAME_PREFIX, "")), "got " + nasty);
  assert.ok(nasty.indexOf(" ") === -1 && nasty.indexOf("/") === -1, "got " + nasty);
});

console.log("\nthe model chooses none of it");

/* The whole surface the model controls is "please check this". If any
   of these were reachable from a tool call, the isolation above would
   be a suggestion. */
check("image, command and limits are fixed, not parameters of the request", () => {
  const a = sandbox.buildSandboxArgs({ checkId: "x", cpu: 1, memoryMb: 512, pids: 64 });
  assert.ok(a.indexOf(sandbox.IMAGE) !== -1, "the image is not the configured one");
  assert.ok(a.join(" ").indexOf("npm run build") === -1,
    "the build command is baked into the run args rather than exec'd separately");
});

console.log("\nthe command allowlist is on this side of the wire");

check("what a build needs is allowed", () => {
  for (const c of ["npm run build", "npm ci", "npm install", "npx tsc --noEmit", "ls -la", "node --version"]) {
    assert.doesNotThrow(() => sandbox.assertAllowed(sandbox.tokenize(c)), c + " was refused");
  }
});

/* Subcommands, not just binaries: "npm" alone would carry `npm publish`
   and `npm config set`, and the grant is meant to be a bounded set of
   things a build needs rather than a package manager. */
check("the rest of npm is not included by allowing npm", () => {
  for (const c of ["npm publish", "npm config set registry http://evil", "npm adduser", "npm exec -- rm -rf /"]) {
    assert.throws(() => sandbox.assertAllowed(sandbox.tokenize(c)), /is not allowed/, c + " got through");
  }
});

check("a binary that is not on the list is refused whatever it is", () => {
  for (const c of ["rm -rf /", "curl http://evil", "wget http://evil", "sh -c whoami", "bash", "chmod 777 /"]) {
    assert.throws(() => sandbox.assertAllowed(sandbox.tokenize(c)), /not available in the build sandbox/, c);
  }
});

/* Refused rather than escaped. The argv never reaches a shell — it is
   exec'd directly — so a pipe in it is not so much dangerous as a sign
   the model thinks it is talking to one, and letting it through would
   teach it that it is. */
check("shell syntax is refused rather than escaped", () => {
  for (const c of ["npm run build; rm -rf /", "npm run build && curl x", "npm run build | tee /tmp/x",
                   "npm run build > /tmp/out", "echo $(whoami)", "npm run `whoami`"]) {
    assert.throws(() => sandbox.assertAllowed(sandbox.tokenize(c)), /shell syntax is not available/, c);
  }
});

check("an empty command is refused, not run as the default", () => {
  assert.throws(() => sandbox.assertAllowed(sandbox.tokenize("")), /empty command/);
  assert.throws(() => sandbox.assertAllowed([]), /empty command/);
});

check("a quoted argument survives as one argument", () => {
  assert.deepStrictEqual(sandbox.tokenize('npm run "build it"'), ["npm", "run", "build it"]);
});

check("the default is the build, and it is on the allowlist", () => {
  assert.deepStrictEqual(sandbox.DEFAULT_ARGV, ["npm", "run", "build"]);
  assert.doesNotThrow(() => sandbox.assertAllowed(sandbox.DEFAULT_ARGV));
});

console.log("\npaths are re-validated where they become real");

check("a traversal, an absolute path and a null byte are all refused", () => {
  for (const bad of ["../etc/passwd", "/etc/passwd", "src/../../x", "a\u0000b", "", null, undefined]) {
    assert.strictEqual(sandbox.safeRelPath(bad), null, JSON.stringify(bad) + " was accepted");
  }
});

check("an ordinary relative path survives, with separators normalised", () => {
  assert.strictEqual(sandbox.safeRelPath("src/App.tsx"), "src/App.tsx");
  assert.strictEqual(sandbox.safeRelPath("src\\App.tsx"), "src/App.tsx");
  assert.strictEqual(sandbox.safeRelPath("  index.html  "), "index.html");
});

await checkAsync("the staging writer refuses what the validator refuses", async () => {
  const root = path.join(os.tmpdir(), "sbx-test-" + Date.now());
  try {
    await assert.rejects(() => runner.writeTree(root, { "../escape.txt": "x" }));
    await runner.writeTree(root, { "src/App.tsx": "export default 1;" });
    const written = await fsp.readFile(path.join(root, "src", "App.tsx"), "utf8");
    assert.strictEqual(written, "export default 1;");
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

console.log("\nthe hash describes what was actually checked");

check("the same tree hashes the same, and any change moves it", () => {
  const a = sandbox.hashFiles({ "src/App.tsx": "one", "index.html": "two" });
  const b = sandbox.hashFiles({ "index.html": "two", "src/App.tsx": "one" });
  assert.strictEqual(a, b, "key order changed the hash");
  assert.notStrictEqual(a, sandbox.hashFiles({ "src/App.tsx": "one", "index.html": "three" }));
  assert.notStrictEqual(a, sandbox.hashFiles({ "src/App.tsx": "one" }));
});

/* Two trees that concatenate to the same bytes must not collide, or a
   result could describe a tree that was never checked. */
check("moving content between files changes the hash", () => {
  const a = sandbox.hashFiles({ "a.html": "xy", "b.html": "z" });
  const b = sandbox.hashFiles({ "a.html": "x", "b.html": "yz" });
  assert.notStrictEqual(a, b);
});

console.log("\nbusy is an answer, and so is broken");

await checkAsync("a check cannot run when every slot is taken", async () => {
  assert.ok(runner.slots() >= 1);
  assert.strictEqual(runner.state().inFlight, 0);
});

/* The distinction the browser path got wrong: an infrastructure failure
   is not a defect in the user's code, and feeding one back as though it
   were spends repair rounds on something no rewrite fixes. */
await checkAsync("a check that cannot start reports infra, not a code failure", async () => {
  const r = await runner.check({
    checkId: "chk_nodaemon_" + Date.now(), runId: "run_x",
    files: { "src/App.tsx": "export default 1;" }, sourceHash: "abc"
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.infra, true, "a daemonless host reported a code failure: " + JSON.stringify(r));
  assert.strictEqual(r.attested, false, "an unrun check claimed to be attested");
  assert.deepStrictEqual(r.errors, [], "invented compiler errors from an infra failure");
});

console.log("\nthe error shapes match the agent's own parser");

check("tsc, rollup and esbuild diagnostics are all recognised", () => {
  const tsc = runner.parseErrors("src/App.tsx(12,5): error TS2322: Type 'string' is not assignable");
  assert.strictEqual(tsc[0].code, "TS2322");
  assert.strictEqual(tsc[0].line, 12);

  const rollup = runner.parseErrors('Could not resolve "./Hero" from "src/App.tsx"');
  assert.strictEqual(rollup[0].code, "UNRESOLVED_IMPORT");
  assert.strictEqual(rollup[0].file, "src/App.tsx", "blamed the missing file rather than the importer");

  const esbuild = runner.parseErrors("src/App.tsx:15:2: ERROR: Expected \";\" but found \"}\"");
  assert.strictEqual(esbuild[0].line, 15);
});

console.log("\n" + (failures === 0 ? "all sandbox checks passed" : failures + " FAILED"));
process.exit(failures === 0 ? 0 : 1);

})();
