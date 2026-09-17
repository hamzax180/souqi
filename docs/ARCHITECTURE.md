# Architecture

What Souqi is, as built. For how a build actually runs, read
[HOW-IT-WORKS.md](HOW-IT-WORKS.md). For shipping it, [DEPLOYING.md](DEPLOYING.md).

Souqi is two independent systems that share a git repository and nothing else.

```
                 souqi.site  (Vercel)              148.113.174.192  (a VPS)
        ┌──────────────────────────────┐      ┌──────────────────────────────┐
        │  frontend/  served statically │      │  caddy   :80 :443            │
        │     16 pages, js, styles      │      │    the only published ports  │
        │                               │      │                              │
        │  api/index.js  → backend/     │ HTTP │  api     the control plane   │
        │     one serverless function   │─────▶│  worker  the only holder of  │
        │     /api/* /auth/* /s/*       │      │          the docker socket   │
        │                               │      │  postgres   platform data    │
        │  MongoDB Atlas                │      │  userdb     customer data,   │
        │     projects, users, sessions │      │             separate cluster │
        └──────────────────────────────┘      └──────────────────────────────┘
```

The platform calls the plane over HTTP through `backend/lib/deployplane.js`.
Nothing in `backend/` requires anything in `infra/deploy/`, and nothing in
`infra/deploy/` requires anything in `backend/`. That is deliberate: they are
deployed separately, by different commands, on different schedules.

## The part that catches people

**In production, only three path prefixes reach Express.**

`vercel.json` rewrites `/api/:path*`, `/auth/:path*` and `/s/:path*` to the
function. Everything else is served as a static file out of `frontend/`, and a
path with no file behind it returns 404 at the edge, before Express is asked.

So `backend/index.js` contains routes that **cannot run in production**: the
generic collection CRUD, and the page fallback inside `guard()`. They run when
the server is started directly — locally, or on a self-hosted box. When a probe
against `souqi.site` returns 404, that means "not routed here", not "refused" —
a distinction `backend/test/scope-test.js` handles by asking a live session
which routes the deployment actually serves before asserting anything about
them.

The same split is why `backend/index.js` has both a `listen()` and a bare
`module.exports = app`. `IS_SERVERLESS` is `!!process.env.VERCEL`; under Vercel
it connects the database and exports the app, and otherwise it listens on
`PORT` or 4000.

## The request path

1. **Static.** `frontend/*.html` with `cleanUrls`, so `login.html` is served at
   `/login`. There is no build step. What is in the folder is what is served.
2. **`/api/*`, `/auth/*`.** The Express app. Sessions are a JWT in an
   `sq_session` cookie, shared with the deploy plane so one identity works
   across both.
3. **`/s/:slug`.** A published site, served from stored revision bytes with its
   own Content-Security-Policy and sandboxed into an opaque origin — so a
   generated app cannot reach the platform that generated it.

## Data

| Store | Holds | Where |
|---|---|---|
| MongoDB Atlas | projects, revisions, users, sessions, usage — **and uploaded image bytes when S3 is unset** | the platform |
| Postgres `postgres` | deployments, domains, hosts, per-project env — **and source archives when S3 is unset** | the plane |
| Postgres `userdb` | the customer's own application data | the plane, a **separate cluster** on an internal dead-end network the worker reaches by `docker exec`, never over a network |
| S3 / R2 | uploads and source archives, when configured | external |

The two Postgres clusters are separate on purpose. `infra/deploy/README.md`
has the enforcement table: which rule is enforced, and in which file.

S3 is the preferred backend for both and the only one that scales, but
neither system requires it: each falls back to the database it already
runs on. The fallback's keys and URLs are byte-identical to the S3 ones
and reads check the database first and the bucket second, so **turning S3
on is configuration and needs no backfill** — while turning it back off,
after anything has been written to the bucket, is not reversible. Set
`BLOB_BACKEND=db` / `SOURCE_STORE=pg` to stop writing to a bucket whose
contents must stay readable.

## The code agent

`backend/lib/codeagent/model-loop.js` is the core. The system prompt is
versioned (`PROMPT_VERSION`), effort is a four-step scale that selects both a
token budget and a model tier, and the generated app is built in the browser
with WebContainer — which is why `vercel.json` sets
`Cross-Origin-Embedder-Policy: credentialless` on `/agent`, `/code` and
`/settings`, and why the scaffold ships as a JSON blob rather than a directory.

That last one has a comment block in `.vercelignore` explaining it at length.
The short version: included as a directory, Vercel's bundler transpiles the
TypeScript it finds and the deployed app dies with an empty `dist`; excluded
without the blob, Rollup cannot resolve `/src/main.tsx`. A `.json` is neither
compiled nor dropped, so it is the JSON that ships.

## What is not here

Souqi used to include a storefront product: a block engine, an on-page visual
editor, and a browser-side data layer. Commit `0234221` removed all of it,
about twenty thousand lines. Several documents in `docs/archive/` describe it
in detail; they are history. If a document and the code disagree, the code is
right.
