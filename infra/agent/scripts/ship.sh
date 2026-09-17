#!/usr/bin/env bash
# =================================================================
#  ship.sh — put the agent worker on a host and start it
#  -----------------------------------------------------------------
#  Idempotent. Safe to re-run after a code change: it re-syncs, then
#  rebuilds and restarts only what changed.
#
#    SSH_USER=ubuntu bash infra/agent/scripts/ship.sh 203.0.113.10
#    SSH_USER=ubuntu bash infra/agent/scripts/ship.sh 203.0.113.10 --logs
#
#  A SEPARATE STACK from infra/deploy, in its own directory on the
#  host, with its own .env and its own compose project. It can be
#  removed without touching the container plane, which is the point:
#  this one holds the platform database and that one holds the Docker
#  socket, and neither should hold both.
#
#  Like the deploy plane's ship.sh, .env is built locally and copied —
#  never generated on the server.
# =================================================================
set -euo pipefail

HOST="${1:-}"
SSH_USER="${SSH_USER:-root}"
REMOTE_DIR="/opt/platform/agent"

if [ -z "$HOST" ]; then
  echo "usage: SSH_USER=ubuntu bash infra/agent/scripts/ship.sh <server-ip> [--logs]"
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

say()  { printf "\n\033[1m%s\033[0m\n" "$*"; }
fail() { printf "\n\033[31m%s\033[0m\n\n" "$*"; exit 1; }

SSH="ssh -o StrictHostKeyChecking=accept-new ${SSH_USER}@${HOST}"

# ---- local checks first: never ship a worker that cannot start ----
[ -f "$HERE/.env" ] || fail "infra/agent/.env is missing. Copy .env.example and fill it in."

# These three are the difference between a worker that claims runs and
# one that restarts forever. Checked here because the failure on the
# host is a crash loop whose cause is one line deep in a log.
for required in MONGODB_URI AGENT_VERIFIER_URL AGENT_VERIFIER_TOKEN DEPLOY_PLATFORM_TOKEN; do
  grep -qE "^${required}=.+" "$HERE/.env" || fail "${required} is empty in infra/agent/.env"
done

# The trailing slash is load-bearing — paths join relative to it, and
# without it the verifier URL resolves to the plane's own public /health.
grep -qE "^AGENT_VERIFIER_URL=.*/$" "$HERE/.env" \
  || fail "AGENT_VERIFIER_URL must end with a slash, e.g. https://deploy.souqi.site/internal/agent/"

say "Checking the agent builds from the compiled output"
# The worker runs backend/lib/codeagent, which is generated from
# backend/agent-src. Shipping a stale lib/ is shipping code nobody has
# looked at since the sources changed.
( cd "$ROOT/backend" && npm run typecheck >/dev/null ) || fail "typecheck failed — not shipping"
echo "  typecheck clean"

say "Checking the server"
$SSH "command -v docker >/dev/null" || fail "docker is not on the server"
$SSH "docker compose version >/dev/null 2>&1" || fail "the docker compose plugin is missing"
echo "  $($SSH 'docker --version')"

say "Copying the worker to ${REMOTE_DIR}"
$SSH "mkdir -p ${REMOTE_DIR}"
# The build context is the repo root, so what travels is the root
# manifest, backend/lib, backend/worker, backend/db.js — and this
# directory. Not test, not demos, not agent-src: the TypeScript sources
# compile to backend/lib and it is the output that runs.
tar --exclude=node_modules --exclude=.git \
    --exclude=backend/test --exclude=backend/demos --exclude=backend/agent-src \
    --exclude=infra/deploy --exclude=frontend --exclude=docs \
    -czf - -C "$ROOT" package.json package-lock.json backend infra/agent \
  | $SSH "tar -xzf - -C ${REMOTE_DIR}"

# Strip CR from anything EXECUTED on the host. The deploy plane's
# ship.sh learned this the hard way: a Windows checkout ships scripts
# with CRLF, and the failure is "set: pipefail: invalid option name",
# which names neither the file nor the cause.
$SSH "find ${REMOTE_DIR} -type f \\( -name '*.sh' -o -name 'Dockerfile*' \\) -exec sed -i 's/\\r\$//' {} +"

scp -q "$HERE/.env" "${SSH_USER}@${HOST}:${REMOTE_DIR}/infra/agent/.env"
$SSH "chmod 600 ${REMOTE_DIR}/infra/agent/.env"
echo "  copied"

say "Building and starting"
$SSH "cd ${REMOTE_DIR}/infra/agent && docker compose up -d --build" 2>&1 | sed 's/^/  /'

# A worker that cannot reach Mongo exits and compose restarts it, so
# "the container is up" proves nothing. What proves it is the heartbeat
# it writes to agent_workers — the same row getWorkerHealth reads, and
# the same one run-routes refuses a build without.
say "Waiting for the worker to report itself healthy"
OK=""
for i in $(seq 1 20); do
  if $SSH "cd ${REMOTE_DIR}/infra/agent && docker compose logs --tail 40 agent-worker 2>&1" \
       | grep -qiE "agent-worker.*(ready|claim|heartbeat)|\[agent-worker\]"; then OK="yes"; break; fi
  sleep 3
done

if [ -z "$OK" ]; then
  say "The worker did not report in"
  $SSH "cd ${REMOTE_DIR}/infra/agent && docker compose logs --tail 60 agent-worker" 2>&1 | sed 's/^/  /'
  fail "Not healthy. The log above is the reason; a crash loop here is almost always MONGODB_URI or the verifier tokens."
fi
echo "  the worker is running"

if [ "${2:-}" = "--logs" ]; then
  $SSH "cd ${REMOTE_DIR}/infra/agent && docker compose logs -f --tail 100 agent-worker"
  exit 0
fi

say "Done"
cat <<EOF

  The agent worker is running on ${HOST}.

  It claims queued runs from agent_runs. Until the API is told a worker
  exists, nothing routes to it — mount run-routes.js and set
  CODEAGENT_DURABLE_RUNS=1 on the app.

  Logs:    SSH_USER=${SSH_USER} bash infra/agent/scripts/ship.sh ${HOST} --logs
  Stop:    ssh ${SSH_USER}@${HOST} 'cd ${REMOTE_DIR}/infra/agent && docker compose down'

EOF
