# The code agent's durable worker

A third stack, beside `infra/deploy/`. One process, no ports, no volumes,
no Docker socket.

## Why it is not in `infra/deploy/`

The container plane holds the Docker socket — it is the only thing on the
platform that may create a container. This worker needs `MONGODB_URI`,
because agent runs live in the platform database alongside projects and
revisions.

Putting them together would give a Docker-socket-holding service write
access to every customer's projects. So they are separate stacks with
separate `.env` files and separate deploy commands, and this one can be
removed without touching anything the plane owns.

`docs/DYNAMIC-AGENT-PLAN.md` §11 specifies exactly this: *"separate worker
packaging under `infra/agent/`"*.

## Why it exists at all

`POST /api/codeagent/runs` answers 202 and then keeps working in a detached
promise. On Vercel that work is not guaranteed to continue past the response,
and if it does the invocation is terminated at `maxDuration: 300`. The loop's
own arithmetic exceeds that at **every** effort level — sixteen turns at a
90-second provider timeout is twenty-four minutes.

The serverless path now handles that honestly: it carries a deadline, finishes
`partial` with its files, and a sweep releases the owner's lock. But finishing
early is not the same as finishing. A build that genuinely needs eight minutes
cannot have them inside a 300-second function.

Here it can. `CODEAGENT_MAX_RUN_MS` defaults to thirty minutes.

## What it does

Claims a queued run from `agent_runs` with a lease, runs the agent loop,
renews the lease while it works, and finalises in a transaction that
compare-and-swaps the project's `headRevision`. If it dies mid-run the lease
expires and `recoverExpiredRuns()` recovers the row — that sweep matches on
`leaseExpiresAt`, which is exactly why it works for this worker and does not
work for the leaseless in-process path.

It does **not** create containers. Build verification is an HTTP call to the
deploy plane's `/internal/agent/check`, which is the only thing that may.

## Deploying

```bash
cp infra/agent/.env.example infra/agent/.env    # then fill it in
SSH_USER=ubuntu bash infra/agent/scripts/ship.sh 148.113.174.192
```

`ship.sh` refuses before touching the server if `MONGODB_URI` or either
verifier token is empty, if `AGENT_VERIFIER_URL` has no trailing slash, or if
`npm run typecheck` fails — the worker runs `backend/lib/codeagent`, which is
generated from `backend/agent-src`, and shipping a stale `lib/` is shipping
code nobody has looked at since the sources changed.

"The container is up" proves nothing: a worker that cannot reach Mongo exits
and compose restarts it. `ship.sh` waits for the worker's own log line
instead.

## Turning it on

Deploying the worker changes nothing by itself. The API still runs every job
in-process until it is told otherwise:

```
CODEAGENT_DURABLE_RUNS=1     # on the Vercel app
```

With it set, `POST /runs` enqueues and returns, and the worker picks the job
up. With it unset — or if the worker's heartbeat is stale — the API runs the
job in-process exactly as it does today. That is the rollback: unset the
variable, and nothing is left behind but an idle container.

## Health

```bash
ssh ubuntu@<host> 'cd /opt/platform/agent/infra/agent && docker compose logs --tail 40 agent-worker'
```

The worker writes a heartbeat to `agent_workers` every ten seconds. That row
is what `getWorkerHealth()` reads and what `run-routes.js` refuses a build
without, so a stale heartbeat is the signal that matters — not whether the
process is running.
