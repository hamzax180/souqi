/* =================================================================
   config.js — one place that reads the environment
   -----------------------------------------------------------------
   Everything else imports from here, so a missing variable surfaces
   as one clear startup failure rather than `undefined` leaking into
   a docker command line halfway through a build.
   ================================================================= */
"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
}

const cfg = {
  databaseUrl: process.env.DATABASE_URL || "postgres://souqi:souqi@localhost:5432/souqi_deploy",

  appDomain: (process.env.APP_DOMAIN || "localhost").toLowerCase(),

  // The one hostname that reaches THIS api from outside the box. Deployed
  // apps are app-<id>.<appDomain>; this is a sibling of those, never a
  // parent, and generated names are always "app-" prefixed so the two
  // cannot collide. Unset means the api is not reachable from the internet
  // at all — the correct state on a laptop, and for a single-machine
  // install driven over ssh.
  controlDomain: (process.env.CONTROL_DOMAIN || "").toLowerCase(),

  acmeEmail: process.env.ACME_EMAIL || "",
  caddyAdmin: (process.env.CADDY_ADMIN || "http://localhost:2019").replace(/\/+$/, ""),

  buildRoot: process.env.BUILD_ROOT || "/opt/platform/builds",

  // Defaults only. Each deployment row stores its own limits, so changing
  // these never resizes anything already running.
  defaults: {
    cpu: num("DEFAULT_CPU", 0.5),
    memoryMb: num("DEFAULT_MEMORY_MB", 512),
    pids: num("DEFAULT_PIDS", 100)
  },

  admission: {
    maxContainers: num("MAX_CONTAINERS", 40),
    maxMemoryPct: num("MAX_MEMORY_PCT", 80),
    maxDiskPct: num("MAX_DISK_PCT", 80),

    /* Slots held back for the code agent's build sandboxes, so a busy
       host cannot leave it with nowhere to verify anything. Deployments
       admit against maxContainers MINUS this.

       Subtracted rather than counted, and that is not laziness.
       engine.listManaged() filters on label=souqi.deployment AND a name
       starting "app-", so a sandbox is invisible to it; counting them
       would need the Docker socket, which the api does not have on
       purpose — it always takes the database branch, and a sandbox is
       not a deployments row. Static subtraction is the only version
       that is correct from both callers.

       Set to 0 to restore the arithmetic exactly as it was. */
    agentSandboxes: num("AGENT_SANDBOX_CONTAINERS", 2),
    agentSandboxMemoryMb: num("AGENT_SANDBOX_MEMORY_MB", 1024)
  },

  secretKey: process.env.SECRET_KEY || "",

  // Sessions. Shared with the main app on purpose: same sq_session JWT,
  // same secret, so being signed in to Souqi means being signed in here.
  jwtSecret: process.env.JWT_SECRET || "dev-insecure-secret",
  // Where to ask whether a session has been revoked. The main app owns the
  // sessionEpoch that answers it; this service cannot read that store.
  authIntrospectUrl: process.env.AUTH_INTROSPECT_URL || "",
  // Shared secret for platform-to-platform calls that have no user behind
  // them (the Caddy TLS ask endpoint, health probes).
  internalToken: process.env.INTERNAL_TOKEN || "",
  // A coarser gate than a session, and a different claim: every request
  // arriving on controlDomain must carry this, whoever the user is. It is
  // what stops the deploy api sitting on the internet behind session auth
  // alone — "is a valid Souqi user" is not "is the Souqi platform", and
  // every signed-in user holds the first.
  platformToken: process.env.DEPLOY_PLATFORM_TOKEN || "",
  // Trusts an x-user-id header. Refuses to boot alongside NODE_ENV=production.
  allowDevAuth: process.env.ALLOW_DEV_AUTH === "1",

  s3: {
    endpoint: process.env.S3_ENDPOINT || "",
    bucket: process.env.S3_BUCKET || "",
    accessKey: process.env.S3_ACCESS_KEY || "",
    secretKey: process.env.S3_SECRET_KEY || ""
  },
  // auto | s3 | pg. "pg" is the reversible switch: it stops writing to the
  // bucket while reads still fall through to it. Unsetting the credentials
  // is the destructive operation, not this.
  sourceStore: process.env.SOURCE_STORE || "auto",

  hetzner: {
    token: process.env.HETZNER_TOKEN || "",
    location: process.env.HETZNER_LOCATION || "nbg1",
    serverType: process.env.HETZNER_SERVER_TYPE || "cx32",
    image: process.env.HETZNER_IMAGE || "docker-ce",
    sshKeyId: process.env.HETZNER_SSH_KEY_ID || ""
  },

  // Caddy's shared network. User containers are NOT placed here — each gets
  // its own --internal network (see docker/engine.js) so that no two user
  // containers ever share one.
  appNetwork: "souqi_apps",

  // The proxy container the worker attaches to each per-deployment network.
  // Compose names it <project>-caddy-1; override when the project name differs.
  // Must match container_name in docker-compose.yml, not the name Compose
  // would derive from whatever directory the stack happens to live in.
  proxyContainer: process.env.PROXY_CONTAINER || "souqi-caddy",

  // The customer-data Postgres. Like the proxy, it is attached to each
  // app's network at deploy time and is otherwise on none — see the
  // userdb service comment in docker-compose.yml for why it must never
  // join souqi_platform.
  userDbContainer: process.env.USERDB_CONTAINER || "souqi-userdb",

  // The worker's internal HTTP endpoint. It exists for one reason: some reads
  // genuinely need the Docker socket (runtime logs), and the api must never
  // have one. Never published — platform network only, internal token required.
  workerPort: num("WORKER_PORT", 4600),
  workerUrl: (process.env.WORKER_URL || "http://worker:4600").replace(/\/+$/, ""),
  hostId: process.env.HOST_ID || "local",
  apiPort: num("API_PORT", 4500)
};

/** Fails loudly at boot rather than at the first encrypted write. */
function assertProductionReady() {
  const problems = [];
  if (!/^[0-9a-fA-F]{64}$/.test(cfg.secretKey)) {
    problems.push("SECRET_KEY must be 64 hex chars (openssl rand -hex 32)");
  }
  if (cfg.appDomain === "localhost") {
    problems.push("APP_DOMAIN is still localhost — HTTPS certificates cannot be issued");
  }
  if (!cfg.acmeEmail) {
    problems.push("ACME_EMAIL is unset — Let's Encrypt needs a contact address");
  }
  if (cfg.controlDomain && !cfg.platformToken) {
    problems.push("CONTROL_DOMAIN is set without DEPLOY_PLATFORM_TOKEN — the api would be exposed behind session auth alone");
  }
  if (cfg.controlDomain && cfg.controlDomain.startsWith("app-")) {
    problems.push("CONTROL_DOMAIN starts with app- and could collide with a generated deployment hostname");
  }
  if (!cfg.s3.bucket) {
    /* No longer "only on the VM" — with no bucket the archive goes into
       Postgres, which the nightly backup already covers. Still worth
       saying, because it moves a cost rather than removing one: the dump
       now carries every customer's source, so its size and its
       sensitivity both change category. */
    problems.push("S3_BUCKET is unset — source archives fall back to Postgres, so they share the database's backup, its size and its access");
  }
  return problems;
}

module.exports = { cfg, assertProductionReady };
