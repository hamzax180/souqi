/* =================================================================
   scripts/verify.js — assert the security properties, no Docker needed
   -----------------------------------------------------------------
   These are the invariants the spec is actually about. They are
   checked by reading what the code WOULD do rather than by running
   containers, so they pass in CI, on a laptop with no Docker, and
   before anything is deployed.

   A test that only passes when the whole stack is up is a test
   nobody runs.
   ================================================================= */
"use strict";

process.env.SECRET_KEY = process.env.SECRET_KEY || "a".repeat(64);

const assert = require("assert");
const engine = require("../src/docker/engine");
const dockerfiles = require("../src/framework/dockerfiles");
const detect = require("../src/framework/detect");
const secrets = require("../src/secrets");
const caddy = require("../src/proxy/caddy");
const domains = require("../src/domains");
const providers = require("../src/providers");
const auth = require("../src/api/auth");
const objects = require("../src/storage/objects");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log("  ok   " + name); passed++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); failed++; }
}

/* The argv builder is a pure function, so this needs no Docker daemon and no
   stubbing — it asks the code exactly what it would run. */
function captureRunArgs(opts) {
  const built = engine.buildRunArgs(opts);
  return Promise.resolve({ cmd: "docker", args: built.args, name: built.name });
}

async function main() {
  console.log("\n── container hardening ──────────────────────────────");

  const run = await captureRunArgs({
    deploymentId: "dep_test", port: 3000, cpu: 0.5, memoryMb: 512, pids: 100,
    env: { API_KEY: "secret-value" }
  });
  const a = run.args;
  const argstr = a.join(" ");

  check("no --privileged", () => assert.ok(!a.includes("--privileged")));
  check("no docker socket mount", () => assert.ok(!argstr.includes("docker.sock")));
  check("no host network", () => assert.ok(!argstr.includes("--network host") && !a.includes("host")));
  check("no host filesystem bind mount", () => {
    const vols = a.filter((x, i) => a[i - 1] === "--volume" || a[i - 1] === "-v");
    assert.deepStrictEqual(vols, [], "found volume mounts: " + vols.join(", "));
  });
  check("no published ports", () => {
    assert.ok(!a.includes("-p") && !a.includes("--publish"), "a port was published");
  });
  check("all capabilities dropped", () => {
    const i = a.indexOf("--cap-drop");
    assert.ok(i >= 0 && a[i + 1] === "ALL");
  });
  check("no-new-privileges set", () => assert.ok(argstr.includes("no-new-privileges")));
  check("cpu limit applied", () => {
    const i = a.indexOf("--cpus"); assert.ok(i >= 0 && a[i + 1] === "0.5");
  });
  check("memory limit applied", () => {
    const i = a.indexOf("--memory"); assert.ok(i >= 0 && a[i + 1] === "512m");
  });
  check("swap disabled (memory-swap == memory)", () => {
    const i = a.indexOf("--memory-swap"); assert.ok(i >= 0 && a[i + 1] === "512m");
  });
  check("pids limit applied", () => {
    const i = a.indexOf("--pids-limit"); assert.ok(i >= 0 && a[i + 1] === "100");
  });
  check("joins its OWN internal network, not a shared one", () => {
    const i = a.indexOf("--network");
    assert.ok(i >= 0, "no --network flag");
    assert.strictEqual(a[i + 1], "souqi_app_dep_test",
      "the container is on a shared network, so it can reach other user containers");
  });
  check("two deployments never share a network", () => {
    const other = engine.buildRunArgs({
      deploymentId: "dep_other", port: 3000, cpu: 0.5, memoryMb: 512, pids: 100, env: {}
    }).args;
    const netA = a[a.indexOf("--network") + 1];
    const netB = other[other.indexOf("--network") + 1];
    assert.notStrictEqual(netA, netB, "both deployments landed on " + netA);
  });
  check("read-only root filesystem", () => assert.ok(a.includes("--read-only")));
  check("writable tmpfs is noexec", () => assert.ok(argstr.includes("noexec")));
  check("nginx has somewhere to write its cache", () => {
    // Without this a read-only root kills every static deployment at boot:
    // nginx mkdir()s /var/cache/nginx/client_temp before it binds.
    assert.ok(argstr.includes("/var/cache/nginx"),
      "static sites cannot start: nginx has no writable cache dir");
  });
  check("labelled as managed", () => assert.ok(argstr.includes("souqi.managed=true")));
  check("env passed as one argv element (no shell splitting)", () => {
    assert.ok(a.includes("API_KEY=secret-value"));
  });

  console.log("\n── injection resistance ─────────────────────────────");

  const evil = await captureRunArgs({
    deploymentId: "dep_x; rm -rf /", port: 3000, cpu: 0.5, memoryMb: 512, pids: 100,
    env: { "X": "a\"; docker run --privileged evil; #" }
  });
  check("deployment id is sanitised into the container name", () => {
    const i = evil.args.indexOf("--name");
    assert.strictEqual(evil.args[i + 1], "app-dep_xrm-rf");
  });
  check("a shell metacharacter in an env value stays one argument", () => {
    const bad = evil.args.filter((x) => x === "--privileged");
    assert.strictEqual(bad.length, 0, "injection produced a --privileged flag");
  });
  check("docker is invoked as an argv array, never a shell string", () => {
    assert.strictEqual(evil.cmd, "docker");
    assert.ok(Array.isArray(evil.args));
  });

  console.log("\n── build isolation ──────────────────────────────────");

  check("a newline in buildCommand is refused", () => {
    assert.throws(() => dockerfiles.assertSafeCommand("npm run build\nUSER root", "buildCommand"));
  });
  check("static build ships nginx, not the toolchain", () => {
    const d = dockerfiles.generate({ framework: "static", buildCommand: "npm run build", outputDir: "dist", port: 80 });
    assert.ok(d.dockerfile.includes("FROM nginx"), "runtime stage is not nginx");
    assert.ok(d.dockerfile.includes("COPY --from=build"), "not multi-stage");
  });
  check("node runtime runs as a non-root user", () => {
    const d = dockerfiles.generate({ framework: "node", startCommand: "npm start", port: 3000 });
    assert.ok(d.dockerfile.includes("USER node"));
  });
  check("python runtime runs as a non-root user", () => {
    const d = dockerfiles.generate({ framework: "python", startCommand: "python main.py", port: 8000 });
    assert.ok(d.dockerfile.includes("USER app"));
  });
  check("a python app with no dependencies still builds", () => {
    // pip --user only creates /root/.local when it installs something, so
    // without the mkdir the runtime stage's COPY --from=build fails on
    // every dependency-free app.
    const d = dockerfiles.generate({ framework: "python", startCommand: "python main.py", port: 8000 });
    assert.ok(/mkdir -p \/root\/\.local/.test(d.dockerfile),
      "COPY --from=build /root/.local will fail when nothing was installed");
    assert.ok(!/\|\| true/.test(d.dockerfile),
      "a failing pip install is being swallowed, so missing deps surface as a crash loop instead");
  });
  check("secrets are excluded from every build context", () => {
    const ig = dockerfiles.dockerignore();
    assert.ok(ig.includes(".env"), ".env is not ignored");
  });

  console.log("\n── secrets ──────────────────────────────────────────");

  check("round-trips", () => {
    const v = "sk-live-abc123";
    assert.strictEqual(secrets.decrypt(secrets.encrypt(v)), v);
  });
  check("ciphertext does not contain the plaintext", () => {
    assert.ok(!secrets.encrypt("hunter2").includes("hunter2"));
  });
  check("two encryptions of the same value differ (random IV)", () => {
    assert.notStrictEqual(secrets.encrypt("x"), secrets.encrypt("x"));
  });
  check("mask reveals at most the last four characters", () => {
    assert.strictEqual(secrets.mask("supersecretvalue"), "••••alue");
  });
  check("platform-controlled env names are refused", () => {
    assert.ok(secrets.validateKey("PATH"));
    assert.ok(secrets.validateKey("LD_PRELOAD"));
    assert.strictEqual(secrets.validateKey("DATABASE_URL"), null);
  });

  console.log("\n── framework detection ──────────────────────────────");

  check("a declared spec wins over guessing", () => {
    const fs = require("fs"), os = require("os"), path = require("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "det-"));
    fs.writeFileSync(path.join(dir, "deploy.json"), JSON.stringify({ framework: "python", startCommand: "python x.py", port: 9000 }));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "14" } }));
    const spec = detect.detect(dir);
    assert.strictEqual(spec.framework, "python");
    assert.strictEqual(spec.declared, true);
  });
  check("a vite app is static, not a long-running node process", () => {
    const fs = require("fs"), os = require("os"), path = require("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "det-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      dependencies: { vite: "5" }, scripts: { build: "vite build", start: "vite preview" }
    }));
    assert.strictEqual(detect.detect(dir).framework, "static");
  });
  check("a type error does not stop an app from shipping", () => {
    /* The scaffold's `build` is "tsc --noEmit && vite build", so that the
       agent gets type errors back while it is still working. Here that
       same script is a gate: tsc exits 2 on any type error and the image
       is never built — a finished, running app refused over a type.
       build:deploy is the same bundle without the gate. */
    const fs = require("fs"), os = require("os"), path = require("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "det-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      dependencies: { vite: "5" },
      scripts: { build: "tsc --noEmit && vite build", "build:deploy": "vite build" }
    }));
    assert.strictEqual(detect.detect(dir).buildCommand, "npm run build:deploy");
  });
  check("a project without build:deploy still builds the way it always did", () => {
    const fs = require("fs"), os = require("os"), path = require("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "det-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      dependencies: { vite: "5" }, scripts: { build: "vite build" }
    }));
    assert.strictEqual(detect.detect(dir).buildCommand, "npm run build");
  });
  check("a colon in the build command survives the Dockerfile writer", () => {
    // assertSafeCommand refuses newlines; it must not refuse `build:deploy`.
    const d = dockerfiles.generate({
      framework: "static", buildCommand: "npm run build:deploy", outputDir: "dist", port: 80
    });
    assert.ok(d.dockerfile.includes("npm run build:deploy"), d.dockerfile);
  });
  check("a static app is always served on the port nginx actually binds", () => {
    // 8080, not 80: nginx runs unprivileged in these containers and cannot
    // bind a low port without CAP_NET_BIND_SERVICE. A declared port would
    // point the proxy at something nothing listens on.
    const fs = require("fs"), os = require("os"), path = require("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "det-"));
    fs.writeFileSync(path.join(dir, "deploy.json"), JSON.stringify({ framework: "static", port: 4173 }));
    assert.strictEqual(detect.detect(dir).port, 8080);
  });
  check("the static image serves as a non-root user", () => {
    const d = dockerfiles.generate({ framework: "static", outputDir: ".", port: 8080 });
    assert.ok(/^USER 101$/m.test(d.dockerfile), "nginx would start as root and need CAP_CHOWN");
    assert.ok(/listen 8080/.test(d.extraFiles["nginx.conf"]), "nginx is not listening where the proxy dials");
    assert.ok(/\/tmp\//.test(d.extraFiles["nginx.conf"]), "nginx writes outside the tmpfs on a read-only root");
  });

  console.log("\n── proxy ────────────────────────────────────────────");

  check("a route dials the container by name, never an IP", () => {
    const c = caddy.baseConfig("http://api:4500/internal/tls-ask");
    assert.ok(c.apps.tls.automation.on_demand.permission.endpoint.includes("tls-ask"),
      "on-demand TLS has no ask endpoint — anyone could make this server request certificates");
  });
  check("admin API is not bound to a published port anywhere in compose", () => {
    const fs = require("fs"), path = require("path");
    const y = fs.readFileSync(path.join(__dirname, "..", "docker-compose.yml"), "utf8");
    assert.ok(!/["']2019:2019["']/.test(y), "the Caddy admin API is published to the host");
  });
  check("admin API does not listen on a wildcard address", () => {
    // Caddy is a member of every app network in order to proxy to the
    // containers, so 0.0.0.0 would expose the admin API — and with it the
    // power to re-route any hostname — to every untrusted user container.
    const listen = caddy.baseConfig("http://api:4500/internal/tls-ask").admin.listen;
    assert.ok(!/^(0\.0\.0\.0|::|\[::\]):/.test(listen),
      "admin listens on " + listen + ", which every user container can reach");
    const fs = require("fs"), path = require("path");
    const boot = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "caddy", "caddy.json"), "utf8"));
    assert.ok(!/^(0\.0\.0\.0|::|\[::\]):/.test(boot.admin.listen),
      "the bootstrap config still binds " + boot.admin.listen);
  });

  console.log("\n── compose boundaries ───────────────────────────────");

  const fs = require("fs"), path = require("path");
  const compose = fs.readFileSync(path.join(__dirname, "..", "docker-compose.yml"), "utf8");
  check("only the worker mounts the docker socket", () => {
    const services = compose.split(/^  (?=\w)/m);
    const withSocket = services.filter((s) => s.includes("docker.sock")).map((s) => s.split(":")[0].trim());
    assert.deepStrictEqual(withSocket, ["worker"], "socket mounted in: " + withSocket.join(", "));
  });
  check("only caddy publishes ports", () => {
    const services = compose.split(/^  (?=\w)/m);
    const withPorts = services.filter((s) => /^\s+ports:/m.test(s)).map((s) => s.split(":")[0].trim());
    assert.deepStrictEqual(withPorts, ["caddy"], "ports published by: " + withPorts.join(", "));
  });
  check("the app network is internal", () => {
    assert.ok(/souqi_apps[\s\S]*?internal: true/.test(compose));
  });
  check("postgres publishes no port", () => {
    const pg = compose.split("postgres:")[1].split(/^  \w/m)[0];
    assert.ok(!/^\s+ports:/m.test(pg));
  });

  console.log("\n── source archives ──────────────────────────────────");

  check("object storage is optional, not assumed", () => {
    // Asserting isConfigured() === false here would only be testing whose
    // machine this ran on. What matters is that both callers ASK before
    // they use storage, so a host without a bucket still deploys.
    //
    // The question they ask MOVED: isConfigured() still means exactly "S3
    // is configured", and the archive no longer needs S3 — without it the
    // source goes to Postgres. So the api must gate on available(), and
    // gating it on isConfigured() again would silently put the source back
    // on one disk while this test carried on passing.
    assert.strictEqual(typeof objects.isConfigured, "function");
    assert.strictEqual(typeof objects.available, "function");
    const api = fs.readFileSync(path.join(__dirname, "..", "src", "api", "server.js"), "utf8");
    assert.ok(/objects\.available\(\)/.test(api),
      "the archive step is gated on isConfigured(), so a host without a bucket never archives at all");
    const pipe = fs.readFileSync(path.join(__dirname, "..", "src", "worker", "pipeline.js"), "utf8");
    assert.ok(/skipped/.test(pipe) || /source_key/.test(pipe),
      "the worker assumes an archive exists");
  });
  check("an archive can be read back from either store", () => {
    // getSource falling through to the bucket is the entire migration
    // story: once S3 is turned on, everything written to Postgres before
    // it must still restore, or old deployments become unrebuildable.
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "storage", "objects.js"), "utf8");
    const from = src.indexOf("async function getSource");
    const body = src.slice(from, src.indexOf("async function deleteSource"));
    assert.ok(/source_archives/.test(body), "getSource cannot read the Postgres archive");
    assert.ok(/signedFetch\("GET"/.test(body), "getSource no longer falls through to the bucket");
  });
  check("both containers agree on where archives go", () => {
    // The api writes the archive and the worker reads it back. If only one
    // of them is told SOURCE_STORE they can disagree, and the restore looks
    // in a store that was never written to — same failure the S3 credentials
    // check below exists for.
    const y = fs.readFileSync(path.join(__dirname, "..", "docker-compose.yml"), "utf8");
    const hits = (y.match(/SOURCE_STORE:/g) || []).length;
    assert.ok(hits >= 2, "SOURCE_STORE reaches " + hits + " service(s); the api and the worker both need it");
  });
  check("the source archive table is in the schema, and cascades", () => {
    const sql = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
    assert.ok(/CREATE TABLE IF NOT EXISTS source_archives/.test(sql), "source_archives is missing");
    assert.ok(/data\s+BYTEA NOT NULL/.test(sql), "the archive column is not BYTEA");
    const block = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS source_archives"));
    assert.ok(/ON DELETE CASCADE/.test(block.slice(0, block.indexOf(");"))),
      "without the cascade, deleting a project leaves that customer's source in the database");
  });
  check("archive keys cannot escape their prefix", () => {
    assert.strictEqual(objects.keyFor("dep_x; rm -rf /"), "sources/dep_xrm-rf.json.gz");
    assert.ok(objects.keyFor("../../etc/passwd").startsWith("sources/"));
  });
  check("the S3 credentials actually reach the containers", () => {
    // They lived in .env.example and config.js but were never passed
    // through compose, so the feature could not have worked at all.
    const y = fs.readFileSync(path.join(__dirname, "..", "docker-compose.yml"), "utf8");
    for (const svc of ["S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_ENDPOINT"]) {
      const hits = (y.match(new RegExp(svc + ":", "g")) || []).length;
      assert.ok(hits >= 2, svc + " reaches " + hits + " services; the api and the worker both need it");
    }
  });
  check("a deleted deployment takes its archive with it", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "worker", "pipeline.js"), "utf8");
    const destroy = src.slice(src.indexOf("async function destroy"));
    assert.ok(/deleteSource/.test(destroy),
      "a deleted customer's source would stay in object storage");
  });
  check("a missing build directory is restored, not blamed on the user", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "worker", "pipeline.js"), "utf8");
    assert.ok(/ensureSource/.test(src), "the pipeline never tries to restore an archived source");
    assert.ok(/source_key/.test(src), "the pipeline ignores the archive key");
  });

  console.log("\n── the api never runs docker ────────────────────────");

  check("the api does not import the docker engine at all", () => {
    // The strongest form of the rule: if the module is not reachable from
    // server.js, no handler can grow a silent docker call later.
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "api", "server.js"), "utf8");
    assert.ok(!/^\s*const\s+engine\s*=\s*require\(/m.test(src),
      "server.js imports docker/engine, which it has no socket to use");
    assert.ok(!/\bengine\.\w+\(/.test(src), "server.js still calls engine.*()");
  });
  check("runtime logs are fetched from the worker, not from docker", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "api", "server.js"), "utf8");
    assert.ok(/internal\/logs/.test(src), "the api does not ask the worker for runtime logs");
    const worker = fs.readFileSync(path.join(__dirname, "..", "src", "worker", "index.js"), "utf8");
    assert.ok(/internal\/logs/.test(worker), "the worker exposes no logs endpoint");
    assert.ok(/timingSafeEqual/.test(worker), "the worker's internal API is not authenticated");
  });
  check("the worker's internal API is never published to the host", () => {
    const y = fs.readFileSync(path.join(__dirname, "..", "docker-compose.yml"), "utf8");
    assert.ok(!/["']\d+:4600["']/.test(y), "the worker's internal API is published");
  });

  check("no API route calls a docker-touching pipeline action", () => {
    // The api container has no Docker socket, so any docker command issued
    // from a request handler fails silently and the caller is told the
    // opposite of the truth. These belong to the worker.
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "api", "server.js"), "utf8");
    for (const fn of ["stop", "start", "restart", "destroy"]) {
      const re = new RegExp("pipeline\\." + fn + "\\s*\\(");
      assert.ok(!re.test(src),
        "server.js calls pipeline." + fn + "(), which shells out to docker without a socket");
    }
  });
  check("lifecycle routes queue an action for the worker", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "api", "server.js"), "utf8");
    assert.ok(/pending_action/.test(src), "no route queues a pending_action");
  });
  check("the worker claims and runs those actions", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "worker", "index.js"), "utf8");
    assert.ok(/pending_action IS NOT NULL/.test(src), "the worker never claims queued actions");
    assert.ok(/SKIP LOCKED/.test(src.slice(src.indexOf("claimNextAction"))),
      "action claiming is not concurrency-safe");
    for (const fn of ["stop", "start", "restart", "destroy"]) {
      assert.ok(new RegExp("pipeline\\." + fn + "\\(").test(src), "the worker cannot run " + fn);
    }
  });
  check("deleting a deployment also removes its network", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "worker", "pipeline.js"), "utf8");
    const destroy = src.slice(src.indexOf("async function destroy"));
    assert.ok(/removeDeploymentNetwork/.test(destroy),
      "destroy() leaves a dead network behind for every deleted deployment");
  });

  console.log("\n── provider abstraction ─────────────────────────────");

  check("hetzner and local both satisfy the interface", () => {
    for (const name of ["local", "hetzner"]) {
      const p = providers.get(name);
      for (const m of ["createServer", "deleteServer", "getServer", "getServerResources"]) {
        assert.strictEqual(typeof p[m], "function", name + " is missing " + m);
      }
    }
  });
  check("nothing outside providers/ mentions hetzner", () => {
    const root = path.join(__dirname, "..", "src");
    const offenders = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== "providers") walk(full); continue; }
        if (!e.name.endsWith(".js")) continue;
        const body = fs.readFileSync(full, "utf8");
        // config.js holds the env block for every provider; that is the one
        // place a name is allowed outside providers/.
        if (/hetzner/i.test(body) && !full.endsWith("config.js")) offenders.push(full);
      }
    })(root);
    assert.deepStrictEqual(offenders, [], "hetzner leaked into: " + offenders.join(", "));
  });

  console.log("\n── operational scripts (phase 2) ──────────────────");

  const scriptSrc = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
  const provisionSrc = scriptSrc("provision.js");
  const shipSrc = scriptSrc("ship.sh");
  const backupSrc = scriptSrc("backup.sh");
  const preflightSrc = scriptSrc("preflight.js");

  check("no script hard-codes a credential", () => {
    for (const [name, body] of [["provision.js", provisionSrc], ["ship.sh", shipSrc],
                                ["backup.sh", backupSrc], ["preflight.js", preflightSrc]]) {
      // A Hetzner token is 64 chars of base62. Anything that long sitting in a
      // quoted literal is a credential somebody pasted in.
      const literal = body.match(/["'][A-Za-z0-9]{40,}["']/);
      assert.ok(!literal, name + " contains a hard-coded secret: " + literal);
    }
  });

  check("provisioning creates nothing without an explicit flag", () => {
    const main = provisionSrc.slice(provisionSrc.indexOf("async function main"));
    assert.ok(/has\("--create"\)/.test(main), "no --create guard");
    assert.ok(/await plan\(\)/.test(main), "the default path does not fall through to plan()");
    const planBody = provisionSrc.slice(provisionSrc.indexOf("async function plan"),
                                        provisionSrc.indexOf("async function create"));
    assert.ok(!/createServer|ensureFirewall/.test(planBody), "plan() mutates cloud state");
  });

  check("provisioning refuses a server with no SSH key", () => {
    assert.ok(/if \(!keys\.length\)/.test(provisionSrc),
      "a host reachable only by an emailed root password would be created");
  });

  check("ship refuses to run until every check passes", () => {
    for (const gate of ["preflight.js", "verify.js", "verify-auth.js"]) {
      assert.ok(shipSrc.includes(gate), "ship.sh does not gate on " + gate);
    }
    assert.ok(/PREFLIGHT_TARGET=server/.test(shipSrc),
      "ship.sh runs preflight in local mode, so NODE_ENV would only warn");
  });

  check("ship never puts .env in the archive", () => {
    const tar = shipSrc.split("\n").find((l) => l.includes("tar --exclude"));
    assert.ok(tar && tar.includes("--exclude=.env"), "the tar would carry .env world-readable");
    assert.ok(/chmod 600 \$\{REMOTE_DIR\}\/\.env/.test(shipSrc), "the copied .env is not locked down");
  });

  check("ship never generates secrets on the server", () => {
    assert.ok(!/openssl rand|randomBytes/.test(shipSrc),
      "secrets minted on the host are lost when the host is rebuilt");
  });

  check("backup keeps the password off the command line", () => {
    // ps output is readable by every process on the box, so a password in
    // argv is a password leaked to anything that can shell out.
    assert.ok(!/PGPASSWORD=/.test(backupSrc), "PGPASSWORD appears in a command");
    assert.ok(!/--password|-W\b/.test(backupSrc), "a password flag appears");
    assert.ok(/compose exec -T postgres pg_dump/.test(backupSrc),
      "the dump does not run inside the container, where the password already lives");
  });

  check("backup validates a dump before adopting it", () => {
    assert.ok(/\.partial/.test(backupSrc), "the dump is written straight to its final name");
    assert.ok(/gzip -t/.test(backupSrc), "the gzip stream is never verified");
    assert.ok(/dump complete/.test(backupSrc), "truncation is never detected");
  });

  check("preflight blocks the settings that make a host open", () => {
    for (const [needle, why] of [
      ["ALLOW_DEV_AUTH", "anyone could deploy as anyone"],
      ["localhost", "TLS would fail for every app"],
      ["JWT_SECRET", "sessions would not verify"]
    ]) {
      assert.ok(preflightSrc.includes(needle), "preflight does not check " + needle + " -- " + why);
    }
  });

  check("preflight never overwrites a live secret", () => {
    const gen = preflightSrc.slice(preflightSrc.indexOf("function generate"));
    assert.ok(/if \(env\[key\]\) continue;/.test(gen),
      "generate() would rotate a live SECRET_KEY, making stored env vars undecryptable");
    assert.ok(!/\["JWT_SECRET",\s*\d+\]/.test(gen),
      "generate() mints a JWT_SECRET, which would reject every main-app session");
  });

  console.log("\n── deployment checks ────────────────────────────────");

  /* These report on software that has already shipped. The moment one can
     fail a deployment, a slow registry or an unreachable probe starts marking
     working apps broken — so "advisory" is a property to assert, not a
     comment to write. */
  check("no check can fail a deployment", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "worker", "pipeline.js"), "utf8");
    for (const fn of ["auditDependencies", "checkResponse"]) {
      const call = new RegExp("await\\s+" + fn + "\\([^;]*?;", "s");
      const m = call.exec(src);
      assert.ok(m, fn + " is never called");
      assert.ok(/\.catch\(/.test(m[0]),
        fn + " is awaited without a .catch, so a thrown check fails the deploy");
    }
    // And none of them reaches for the one function that marks a deploy dead.
    const bodies = /async function (?:auditDependencies|checkResponse)[\s\S]*?\n}/g;
    let b, seen = 0;
    while ((b = bodies.exec(src)) !== null) {
      seen++;
      assert.ok(!/return fail\(/.test(b[0]), "a check calls fail() and can kill the deployment");
    }
    assert.strictEqual(seen, 2, "expected both check functions, found " + seen);
  });

  check("the dependency audit runs in a container, not on the host", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "docker", "engine.js"), "utf8");
    const m = /async function runNpmAudit[\s\S]*?\n}/.exec(src);
    assert.ok(m, "runNpmAudit is gone");
    const body = m[0];
    assert.ok(/"run", "--rm"/.test(body), "the audit does not run in a throwaway container");
    // The host has no npm and must never execute anything out of a customer's
    // tree; and the audit must not be able to edit what it is auditing.
    assert.ok(/:ro"/.test(body), "the build context is mounted writable into the audit container");
    assert.ok(/"--cap-drop", "ALL"/.test(body), "the audit container keeps capabilities");
    assert.ok(/no-new-privileges/.test(body), "the audit container can gain privileges");
    assert.ok(/"--user", "65534:65534"/.test(body), "the audit container runs as root");
    assert.ok(!/--privileged/.test(body), "the audit container is privileged");
  });

  check("the checks table is keyed so a redeploy overwrites", () => {
    const sql = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
    const m = /CREATE TABLE IF NOT EXISTS deployment_checks[\s\S]*?\);/.exec(sql);
    assert.ok(m, "deployment_checks is not in the schema");
    assert.ok(/PRIMARY KEY \(deployment_id, check_id\)/.test(m[0]),
      "without that key the upsert has nothing to conflict on and history piles up");
    assert.ok(/REFERENCES deployments\(id\) ON DELETE CASCADE/.test(m[0]),
      "check rows outlive the deployment they describe");
  });

  check("recording a check cannot break a deploy either", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "worker", "pipeline.js"), "utf8");
    const m = /async function recordCheck[\s\S]*?\n}/.exec(src);
    assert.ok(m, "recordCheck is gone");
    assert.ok(/catch \(e\)/.test(m[0]),
      "a failed INSERT propagates, so a check nobody asked for can fail a deployment");
  });

  console.log("\n── custom domains ───────────────────────────────────");

  /* The certificate gate. This is the only thing between "anyone with an
     account" and "Souqi asks Let's Encrypt for a certificate on a name that
     is not ours", so it is asserted at the source: the query must not be
     satisfiable by an unverified row. */
  check("tls-ask will not issue for an unverified custom domain", () => {
    const api = fs.readFileSync(path.join(__dirname, "..", "src", "api", "server.js"), "utf8");
    const m = api.match(/tls-ask[\s\S]{0,1800}?res\.status\(404\)\.end\(\)/);
    assert.ok(m, "could not find the tls-ask handler");
    const body = m[0];
    assert.ok(/custom_domain/.test(body),
      "tls-ask ignores custom_domain, so a custom domain can never get a certificate");
    assert.ok(/custom_domain\s*=\s*\$1\s+AND\s+custom_domain_verified/.test(body),
      "tls-ask matches custom_domain WITHOUT requiring custom_domain_verified - " +
      "attaching any name would be enough to have a certificate issued for it");
    assert.ok(/status\s*<>\s*'DELETED'/.test(body),
      "tls-ask would issue for a deleted deployment's hostname");
  });

  check("an unverified custom domain is not routed", () => {
    assert.deepStrictEqual(
      domains.hostnamesFor({ domain: "app-1.souqi.site", custom_domain: "shop.example.com",
                             custom_domain_verified: false }),
      ["app-1.souqi.site"],
      "an unverified custom domain would be served over plain HTTP with no certificate");
  });

  check("a verified custom domain is routed beside the generated one", () => {
    assert.deepStrictEqual(
      domains.hostnamesFor({ domain: "app-1.souqi.site", custom_domain: "shop.example.com",
                             custom_domain_verified: true }),
      ["app-1.souqi.site", "shop.example.com"],
      "a verified custom domain is not routed, or it replaces the generated hostname");
  });

  /* Six call sites add or remove routes. The invariant holds only if every
     one asks hostnamesFor instead of reading dep.domain, so that is checked
     directly - a new site that forgets is the failure mode. */
  check("no route site reads dep.domain directly", () => {
    for (const f of ["worker/pipeline.js", "worker/index.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
      assert.ok(!/(add|remove)Route\(\s*dep\.domain/.test(src),
        f + " routes dep.domain directly, so a custom domain silently stops being served");
    }
  });

  check("a custom domain cannot claim the platform's own zone", () => {
    for (const bad of ["souqi.site", "app-1.souqi.site", "anything.souqi.site"]) {
      assert.ok(!domains.validateCustomDomain(bad, "souqi.site").ok,
        bad + " was accepted, a second unverified route to a name we already own");
    }
    assert.ok(domains.validateCustomDomain("shop.example.com", "souqi.site").ok,
      "a genuine custom domain was refused");
  });

  console.log("\n── external database forwarder ──────────────────────");

  /* Phase 3 exists to make an external database reachable WITHOUT weakening
     the isolation the rest of this file asserts. If the forwarder is not
     hardened, "the app can only reach one address" becomes "the app can
     reach one address through a container that can reach anything". */
  const fwd = engine.buildDbProxyArgs({
    deploymentId: "dep_x", host: "db.example.com", targetIp: "203.0.113.7", port: 5432
  });

  check("the forwarder is hardened like an app container", () => {
    const a = fwd.args;
    assert.ok(a.includes("--cap-drop") && a[a.indexOf("--cap-drop") + 1] === "ALL",
      "the forwarder keeps Linux capabilities");
    assert.ok(a.includes("no-new-privileges"), "the forwarder can gain privileges via setuid");
    assert.ok(a.includes("--read-only"), "the forwarder's root filesystem is writable");
    assert.ok(a.includes("--user") && a[a.indexOf("--user") + 1] === "65534:65534",
      "the forwarder runs as root");
    assert.ok(!a.includes("--privileged"), "the forwarder is privileged");
    assert.ok(!a.some((x) => /docker\.sock/.test(String(x))), "the forwarder mounts the Docker socket");
    assert.ok(!a.includes("-p") && !a.includes("--publish"),
      "the forwarder publishes a port to the host");
    assert.ok(!a.some((x) => String(x) === "host"), "the forwarder uses host networking");
  });

  check("the forwarder dials exactly one literal address", () => {
    const spec = fwd.args[fwd.args.length - 1];
    assert.strictEqual(spec, "TCP:203.0.113.7:5432",
      "the forwarder's target is not a single fixed address");
    /* A hostname here would be resolved by Docker's embedded DNS, which on
       the app network answers with this container's own alias — the
       forwarder would dial itself and the app would hang. */
    assert.ok(/^TCP:\d+\.\d+\.\d+\.\d+:\d+$/.test(spec),
      "the forwarder targets a name rather than a resolved address");
    const listen = fwd.args[fwd.args.length - 2];
    assert.ok(/^TCP-LISTEN:\d+,fork,reuseaddr$/.test(listen),
      "the forwarder's listener is not a single fixed port");
    assert.strictEqual(fwd.args.filter((x) => /^TCP:/.test(String(x))).length, 1,
      "the forwarder has more than one target");
  });

  check("the forwarder is never on the platform network", () => {
    // The failure this prevents is the same one the userdb check describes:
    // a container on both an app network and souqi_platform gives every app
    // a two-hop route to the platform database and the Caddy admin API.
    const nets = fwd.args.filter((x, i) => fwd.args[i - 1] === "--network");
    assert.deepStrictEqual(nets, [engine.egressNetworkName("dep_x")],
      "the forwarder starts on " + nets.join(", ") + "; it must start on its own egress network alone");
    assert.ok(!fwd.args.includes("souqi_platform"), "the forwarder is on the platform network");
  });

  check("each deployment's egress network is its own", () => {
    assert.notStrictEqual(engine.egressNetworkName("dep_a"), engine.egressNetworkName("dep_b"),
      "two tenants' forwarders would share one L2");
    assert.notStrictEqual(engine.dbProxyName("dep_a"), engine.dbProxyName("dep_b"));
  });

  check("only the egress network is allowed off the box", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "docker", "engine.js"), "utf8");
    const egress = /async function ensureEgressNetwork[\s\S]*?\n}/.exec(src);
    const appnet = /async function ensureDeploymentNetwork[\s\S]*?\n}/.exec(src);
    assert.ok(egress && appnet, "could not find the network helpers");
    assert.ok(!/--internal/.test(egress[0]),
      "the egress network is --internal, so the forwarder cannot reach the database either");
    assert.ok(/--internal/.test(appnet[0]),
      "the app network is no longer --internal, so every app now has unrestricted egress");
  });

  check("the app container itself gained no egress", () => {
    // The point of the forwarder is that THIS did not have to change.
    const app = engine.buildRunArgs({
      deploymentId: "dep_x", port: 3000, cpu: 1, memoryMb: 512, pids: 128, env: {}
    });
    const nets = app.args.filter((x, i) => app.args[i - 1] === "--network");
    assert.deepStrictEqual(nets, [engine.networkName("dep_x")],
      "the app container is on " + nets.join(", ") + "; it must be on its own internal network alone");
    assert.ok(!app.args.includes(engine.egressNetworkName("dep_x")),
      "the app container was put on the egress network, which gives it the whole internet");
  });

  check("teardown detaches the forwarder before dropping the network", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "docker", "engine.js"), "utf8");
    const rm = /async function removeDeploymentNetwork[\s\S]*?\n}/.exec(src);
    assert.ok(rm, "could not find removeDeploymentNetwork");
    const body = rm[0];
    const disconnect = body.indexOf("dbProxyName");
    const drop = body.indexOf('"network", "rm"');
    assert.ok(disconnect > -1,
      "the forwarder is never disconnected, so `network rm` is refused and a dead network leaks per deployment");
    assert.ok(disconnect < drop, "the network is dropped before the forwarder is detached");
  });

  console.log("\n── user databases ───────────────────────────────────");

  const dbproviders = require("../src/dbproviders");
  const builtinDb = require("../src/dbproviders/builtin");
  const externalDb = require("../src/dbproviders/external");

  const srcOf = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
  /* Several checks below ask whether some code does a thing — and the comment
     above that code usually uses the same words while explaining why it does
     NOT. Three of these checks failed on their own prose before this existed. */
  const codeOnly = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const schemaSrc = srcOf("db", "schema.sql");
  const builtinSrc = srcOf("src", "dbproviders", "builtin.js");
  const externalSrc = srcOf("src", "dbproviders", "external.js");
  const pipelineSrc = srcOf("src", "worker", "pipeline.js");
  const apiSrc = srcOf("src", "api", "server.js");
  const workerSrc = srcOf("src", "worker", "index.js");
  const engineSrc = srcOf("src", "docker", "engine.js");
  const cleanupSrc = srcOf("src", "monitor", "cleanup.js");
  const userdbSvc = (() => {
    const from = compose.indexOf("\n  userdb:");
    const to = compose.indexOf("\n  caddy:");
    return from === -1 ? "" : compose.slice(from, to === -1 ? undefined : to);
  })();

  check("builtin and external both satisfy the interface", () => {
    for (const name of ["builtin", "external"]) {
      const p = dbproviders.get(name);
      assert.strictEqual(p.mode, name, "get(" + name + ") returned " + p.mode);
      for (const m of ["provision", "destroy", "inspect", "ready"]) {
        assert.strictEqual(typeof p[m], "function", name + " is missing " + m);
      }
    }
  });

  check("an unknown mode falls back instead of throwing mid-deploy", () => {
    // A bad value in one row must not be able to fail a deployment.
    assert.strictEqual(dbproviders.get("neon-someday").mode, "builtin");
    assert.strictEqual(dbproviders.get(null).mode, "builtin");
  });

  check("the customer database container is never on the platform network", () => {
    // The load-bearing line of the whole design. souqi-userdb joins each
    // app's --internal network at deploy time; if it ALSO sat on
    // souqi_platform, every user container would have a two-hop route to
    // the platform database and the Caddy admin API through it.
    assert.ok(userdbSvc, "there is no userdb service in compose");
    const nets = /networks:\s*\[([^\]]*)\]/.exec(codeOnly(userdbSvc.replace(/^\s*#.*$/gm, "")));
    assert.ok(nets, "userdb does not declare its networks as an explicit list");
    const names = nets[1].split(",").map((n) => n.trim()).filter(Boolean);
    /* Exactly one, and it is the dead-end network. `networks: []` reads like
       the right answer and is not: compose ignores it, invents a default
       bridge, and puts the container on that — with a gateway. This check
       exists because that is what actually happened. */
    assert.deepStrictEqual(names, ["userdbhome"],
      "userdb is on " + names.join(", ") + " at boot; it must be on the dead-end network alone");
    assert.ok(/^\s{2}userdbhome:[\s\S]*?internal:\s*true/m.test(
      compose.slice(compose.indexOf("\nnetworks:"))),
      "souqi_userdb_home is not internal, so the customer data cluster has egress");
  });

  check("the customer database is never published to the host", () => {
    assert.ok(!/^\s{4}ports:/m.test(userdbSvc), "userdb publishes a port to the host");
  });

  check("maintenance databases are closed to tenant roles", () => {
    // Without this a tenant connects to `postgres`, which every role can
    // reach by default, and works from there — reading pg_database, seeing
    // every other customer's database name, and probing them one by one.
    const init = srcOf("db", "userdb-init.sql");
    assert.ok(/REVOKE\s+CONNECT\s+ON\s+DATABASE\s+postgres/i.test(init),
      "PUBLIC can still connect to the postgres database");
    assert.ok(/template1/i.test(init), "template1 is left open to PUBLIC");
  });

  check("a tenant role cannot grant itself what it lacks", () => {
    for (const attr of ["NOSUPERUSER", "NOCREATEDB", "NOCREATEROLE", "NOBYPASSRLS"]) {
      assert.ok(builtinSrc.includes(attr), "tenant roles are not " + attr);
    }
    assert.ok(/REVOKE ALL ON DATABASE/.test(builtinSrc),
      "PUBLIC keeps CONNECT on every tenant database, which makes the per-role grants decoration");
  });

  check("one tenant cannot exhaust the cluster for the others", () => {
    assert.ok(/CONNECTION LIMIT/.test(builtinSrc), "no per-role connection limit");
    assert.ok(/statement_timeout/.test(builtinSrc), "no statement timeout");
    assert.ok(/idle_in_transaction_session_timeout/.test(builtinSrc),
      "an idle transaction can pin a backend open for ever");
  });

  check("database identifiers can never carry user text", () => {
    // Identifiers cannot be parameterized in Postgres, so these names are
    // built by concatenation — the one place the "argv array, never a shell
    // string" guarantee does not carry over. The defence is that they derive
    // from the project id and nothing else, through a sanitiser.
    const nasty = 'p"; DROP DATABASE souqi_deploy; --';
    const name = builtinDb.dbNameFor(nasty);
    assert.ok(/^db_[a-z0-9_]+$/.test(name), "a hostile project id survived as: " + name);
    assert.ok(builtinDb.roleNameFor("x".repeat(200)).length <= 63,
      "an identifier exceeds Postgres's 63-byte limit, where a silent truncation collides two projects");
  });

  check("an empty project id is refused rather than collapsing to a shared name", () => {
    // "" and "!!!" both sanitise to nothing, and returning db_ for both
    // would point two different projects at one database.
    assert.throws(() => builtinDb.dbNameFor(""), /empty project id/);
    assert.throws(() => builtinDb.dbNameFor("!!!"), /empty project id/);
  });

  check("the generated password never reaches a command line", () => {
    // ps output is readable across the box, and souqi-userdb is a container
    // that customer code can reach over its own network. Same rule backup.sh
    // already follows for pg_dump.
    assert.ok(/child\.stdin\.end\(sql\)/.test(builtinSrc), "SQL is not written to stdin");
    assert.ok(!/"-c"/.test(builtinSrc), "psql is invoked with -c, which puts the statement in argv");
  });

  check("a failed DDL cannot echo the password into a log", () => {
    assert.ok(/function scrub/.test(builtinSrc), "stderr is passed through unscrubbed");
    assert.ok(/PASSWORD/.test(builtinSrc.slice(builtinSrc.indexOf("function scrub"))),
      "scrub() does not target PASSWORD literals, which is what a failing CREATE ROLE echoes");
  });

  check("external URLs are validated before they are stored", () => {
    assert.ok(!externalDb.parse("mysql://u:p@host/db").ok, "a mysql URL was accepted");
    assert.ok(!externalDb.parse("https://example.com/db").ok, "an http URL was accepted");
    assert.ok(!externalDb.parse("postgres://u:p@host").ok, "a URL with no database name was accepted");
    assert.ok(!externalDb.parse("not a url").ok, "a non-URL was accepted");
    assert.ok(externalDb.parse("postgres://u:p@db.example.com:5432/app").ok, "a valid URL was rejected");
  });

  check("an external URL pointing at localhost is refused", () => {
    // The app container's network is --internal, so localhost in there is
    // the container itself; from the validator it is the platform host.
    // Neither is what the customer meant, and one of them is ours.
    for (const h of ["localhost", "127.0.0.1", "0.0.0.0"]) {
      assert.ok(!externalDb.parse("postgres://u:p@" + h + ":5432/app").ok, h + " was accepted");
    }
  });

  check("deleting a project never drops a database on someone else's account", () => {
    // We did not create it, so we do not delete it. A project delete here
    // must not take out a customer's Neon or RDS instance.
    const destroy = externalSrc.slice(externalSrc.indexOf("async function destroy"));
    assert.ok(!/DROP\s+DATABASE/i.test(destroy), "the external provider issues a DROP");
    assert.ok(/skipped: true/.test(destroy), "destroy() does not report itself as a no-op");
  });

  check("a redeploy does not rotate a live credential", () => {
    // The running container is holding the old password. Reissuing one on
    // every deploy would break the app that is already connected.
    const provision = builtinSrc.slice(builtinSrc.indexOf("async function provision"));
    assert.ok(/existing && existing\.secret/.test(provision),
      "provision() ignores the stored credential and mints a new one every time");
  });

  check("the database is keyed to the project, not the deployment", () => {
    // A redeploy is a new deployment id on a new network. Keying data to it
    // would empty the database on every publish.
    assert.ok(/project_databases \(\s*[\r\n]+\s*project_id\s+TEXT PRIMARY KEY/.test(schemaSrc),
      "project_databases is not keyed by project");
    const fn = pipelineSrc.slice(pipelineSrc.indexOf("async function ensureDatabase"));
    assert.ok(/dep\.project_id/.test(fn), "ensureDatabase does not key on the project");
  });

  check("a database that cannot be provisioned does not fail the deploy", () => {
    // An app with no database should still ship, and an app that needs one
    // says so far more clearly in its own logs than a deploy failure does.
    const fn = pipelineSrc.slice(pipelineSrc.indexOf("async function ensureDatabase"),
                                 pipelineSrc.indexOf("/* ---------- the pipeline"));
    assert.ok(fn.length > 200, "ensureDatabase was not found where expected");
    assert.ok(!/return fail\(/.test(fn), "ensureDatabase can fail a deployment");
    assert.ok(/WARNING/.test(fn), "a provisioning failure is silent");
  });

  check("DATABASE_URL never overwrites a value the user set", () => {
    assert.ok(/if \(!env\.DATABASE_URL\) env\.DATABASE_URL/.test(pipelineSrc),
      "the platform clobbers a DATABASE_URL the customer set deliberately");
    assert.ok(/env\.SOUQI_DATABASE_URL = database\.url/.test(pipelineSrc),
      "SOUQI_DATABASE_URL is not set, so an app has no name that always means ours");
  });

  check("deleting a deployment detaches the database before removing the network", () => {
    // network rm is refused while any member is still attached, and the
    // failure is silent from there — one leaked network per delete, against
    // a default address pool of about thirty.
    const destroy = pipelineSrc.slice(pipelineSrc.indexOf("async function destroy"));
    const dis = destroy.indexOf("disconnectUserDb");
    const rm = destroy.indexOf("removeDeploymentNetwork");
    assert.ok(dis !== -1, "destroy() never disconnects the database container");
    assert.ok(dis < rm, "the network is removed before the database container has left it");
  });

  check("deleting one deployment does not drop the project's data", () => {
    const destroy = codeOnly(pipelineSrc.slice(pipelineSrc.indexOf("async function destroy"),
                                               pipelineSrc.indexOf("project-level database actions")));
    assert.ok(!/deleteProjectDatabase\s*\(/.test(destroy),
      "destroy() drops the database, so every redeploy would start from empty");
  });

  check("the api cannot reach the builtin provider at all", () => {
    // Provisioning is `docker exec`, and this container has no socket. The
    // strongest form of the rule is that the module is not reachable from
    // server.js, so no handler can grow a silent call to it later.
    assert.ok(!/require\("\.\.\/dbproviders"\)/.test(apiSrc),
      "server.js imports dbproviders/index, which pulls in the docker-shelling builtin provider");
    assert.ok(!/dbproviders\/builtin/.test(codeOnly(apiSrc)), "server.js reaches the builtin provider");
    for (const fn of ["deleteProjectDatabase", "measureProjectDatabase", "ensureDatabase"]) {
      assert.ok(!new RegExp("pipeline\\." + fn + "\\s*\\(").test(apiSrc),
        "server.js calls pipeline." + fn + "(), which shells out to docker without a socket");
    }
  });

  check("project actions are queued for the worker and claimed safely", () => {
    assert.ok(/pending_action='delete'/.test(apiSrc), "deleting a project does not queue anything");
    const claim = workerSrc.slice(workerSrc.indexOf("async function claimNextProjectAction"));
    assert.ok(/pending_action IS NOT NULL/.test(claim), "the worker never claims project actions");
    assert.ok(/SKIP LOCKED/.test(claim), "project action claiming is not concurrency-safe");
    assert.ok(/pending_action TEXT/.test(schemaSrc.slice(schemaSrc.indexOf("ALTER TABLE projects"))),
      "the projects table has no queue column");
  });

  check("a project row outlives the containers it owns", () => {
    // projects -> deployments is ON DELETE CASCADE. Deleting the row in the
    // handler would remove every deployment row while their containers were
    // still running, with nothing left that knew their names.
    assert.ok(!/DELETE FROM projects/.test(apiSrc),
      "the api deletes the project row, cascading its deployments away before anything stops them");
    const fn = workerSrc.slice(workerSrc.indexOf("async function deleteProject"));
    const destroyAt = fn.indexOf("pipeline.destroy");
    const rowAt = fn.indexOf("DELETE FROM projects");
    assert.ok(destroyAt !== -1 && rowAt !== -1 && destroyAt < rowAt,
      "the project row is deleted before its deployments are torn down");
  });

  check("switching to an external database keeps the built-in one", () => {
    // "I changed a setting" must never mean "my data is gone".
    assert.ok(/builtin_kept/.test(schemaSrc), "the schema cannot record a kept database");
    const route = codeOnly(apiSrc.slice(apiSrc.indexOf('app.put("/projects/:id/database"'),
                                        apiSrc.indexOf('app.post("/projects/:id/database/measure"')));
    assert.ok(/builtin_kept/.test(route), "switching modes does not preserve the built-in database");
    assert.ok(!/DROP\s+(DATABASE|ROLE)/i.test(route), "switching modes issues a DROP");
    assert.ok(!/deleteProjectDatabase\s*\(/.test(route), "switching modes destroys the database directly");
    // Clearing a queued drop is fine — SETTING one is what would be wrong.
    assert.ok(!/SET\s+pending_action='drop-db'/.test(route),
      "switching modes queues the built-in database for removal");
    assert.ok(/pending_action=NULL[\s\S]{0,80}'drop-db'/.test(route),
      "switching BACK to built-in leaves a queued removal of that same database in flight");
  });

  check("the worker re-checks before it drops a kept database", () => {
    /* The api's 409 is a check at request time, and the drop happens later
       in another process. In between, the customer can switch back to
       built-in — and then the queued work deletes the database their app is
       now using. That is not hypothetical: it happened in testing, and the
       database was gone. The decision has to be re-read at the moment of
       the destructive act. */
    const fn = workerSrc.slice(workerSrc.indexOf('"drop-db"'), workerSrc.indexOf("async function tickProjectAction"));
    assert.ok(fn.length > 200, "the drop-db handler was not found where expected");
    const readAt = fn.indexOf("SELECT mode");
    const dropAt = fn.indexOf("deleteProjectDatabase");
    assert.ok(readAt !== -1 && readAt < dropAt,
      "drop-db acts on the state that queued it, not the state at the moment it runs");
    assert.ok(/row\.mode === "builtin"/.test(fn),
      "drop-db will delete a database the project has switched back to using");
  });

  check("removing a live built-in database is refused", () => {
    // There is no undo and no fallback: the next deploy would create an
    // empty database of the same name, so the only visible result would be
    // that the data is gone.
    const route = apiSrc.slice(apiSrc.indexOf('app.delete("/projects/:id/database"'));
    assert.ok(/409/.test(route), "the delete route never refuses");
    assert.ok(/row\.mode === "builtin"/.test(route),
      "the database an app is actively using can be dropped from a settings screen");
  });

  check("the connection string is never returned to a browser", () => {
    // It carries a password. The app is handed it through the environment;
    // a human never needs to read it, so there is no reveal and no copy.
    const view = apiSrc.slice(apiSrc.indexOf("function databaseView"),
                              apiSrc.indexOf("async function ownedProject"));
    assert.ok(view.length > 200, "databaseView was not found where expected");
    assert.ok(/secrets\.mask/.test(view), "databaseView does not mask the credential");
    assert.ok(!/\burl\s*:/.test(view), "databaseView returns a url field");
  });

  check("the shared database container is not counted as an app", () => {
    // capacity counts docker labels in the worker and deployments rows in
    // the api. One extra member in the docker count silently desyncs
    // admission between the two.
    assert.ok(/label=souqi\.deployment/.test(engineSrc),
      "listManaged() has no filter that excludes the userdb container");
    assert.ok(/startsWith\("app-"\)/.test(engineSrc),
      "listManaged() can return a container whose name is not app-<id>");
  });

  check("the janitor cannot sweep the customer data cluster", () => {
    // sweepOrphanContainers treats every managed container without a live
    // deployment row as an orphan and removes it under a name derived from
    // the id. userdb has no deployment row and never will.
    const sweep = cleanupSrc.slice(cleanupSrc.indexOf("async function sweepOrphanContainers"));
    assert.ok(/engine\.listManaged\(\)/.test(sweep),
      "the sweep enumerates containers by some route other than listManaged");
  });

  check("customer data is in the backup", () => {
    assert.ok(/compose exec -T userdb/.test(backupSrc), "the customer cluster is not dumped at all");
    assert.ok(/pg_dumpall/.test(backupSrc),
      "the customer cluster is dumped per-database, which loses the roles that own the tables — " +
      "and the roles ARE the isolation");
    assert.ok(/USERDB_NAME/.test(backupSrc),
      "customer dumps are not named distinctly, so retention cannot see them");
    assert.ok(/do_restore_userdb/.test(backupSrc), "there is no way to restore the customer dump");
    /* pg_dumpall signs off with "database CLUSTER dump complete"; pg_dump
       writes "database dump complete". Checking for the pg_dump wording
       discarded every good customer dump as truncated. */
    assert.ok(/PostgreSQL database cluster dump complete/.test(backupSrc),
      "the customer dump's truncation check looks for pg_dump's marker, which pg_dumpall never writes");
    assert.ok(/find "\$BACKUP_DIR" -name "\$\{USERDB_NAME\}/.test(backupSrc),
      "customer dumps are never pruned, so they accumulate until the disk fills");
  });

  console.log("\n" + (failed === 0
    ? "✓ ALL " + passed + " CHECKS PASSED"
    : "✗ " + failed + " FAILED, " + passed + " passed"));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
