# How Souqi Code works

A description of the system as it is, not as it was planned. The files in
`docs/*-PLAN.md` are proposals; this one is the map. Where a number appears
below it was read out of the running code, not remembered.

Last verified against `PROMPT_VERSION = "v9"`.

---

## 1. The single most important operational fact

**`git push` deploys nothing.** There are two independent deploy targets and
pushing to GitHub is neither of them.

| Target | What lives there | How to deploy |
|---|---|---|
| **Vercel** (project `sapone`) | the platform: `backend/`, `frontend/`, the code agent, the scaffold | `npx vercel --prod --yes` |
| **VPS** `148.113.174.192` | the container plane: `infra/deploy/` — Caddy, the deploy API, the worker, users' running apps | `cd infra/deploy && SSH_USER=ubuntu bash scripts/ship.sh 148.113.174.192` |

They share a git repository and nothing else. A change under `backend/` or
`frontend/` needs Vercel; a change under `infra/deploy/` needs the VPS; a change to
both needs both.

On Vercel, **only `/api/*`, `/auth/*` and `/s/*` reach Express.** Everything
else is served statically from `frontend/`. A route added outside those three
prefixes exists locally and 404s in production.

---

## 2. What happens when someone asks for an app

```
  browser                     server                        browser again
  ───────                     ──────                        ─────────────
  prompt ──────────────────▶  assessPrompt
                              (build? ask? chat?)
                              │
                              ├─ buildPlan ─────────────▶   plan card (plan mode)
                              │
                              ▼
                              compose the prompt
                                theme block
                                + codebase context
                                + uploaded images
                                + the request
                                + the language rule
                              │
                              ▼
                              proposeWithClientBuild ──▶    SSE: stage / proposal
                                │  model writes files
                                ▼
                                onFiles(allCalls) ─────▶    WebContainer
                                                            npm install
                                                            tsc --noEmit && vite build
                                                            render check
                                ◀──────────────────────     build-feedback
                                │
                                ├─ errors? repair round (2 eco / 3 power)
                                │
                                ▼
                              persist revision ────────▶    preview + file card
```

The compiler runs **in the user's browser**, not on the server. That is
deliberate: it is free, it scales with users rather than with the host, and
it is the same toolchain the published site is built with.

### The step log

Everything the user sees during a build arrives over SSE as `stage`,
`proposal`, `files` and `result` frames, which `code.html` renders into the
thinking panel. Files are reported as they are written rather than in one
lump at the end.

---

## 3. The code agent

`backend/lib/codeagent/model-loop.js` is the core. Everything below is in it
unless stated otherwise.

### Tools

Four, and all four are inert — none of them can execute anything.

| Tool | What it does |
|---|---|
| `write_file` | create or replace a file |
| `edit_file` | exact-match find/replace inside an existing file |
| `read_file` | read a file the context budget left out |
| `suggest_next` | 2-3 follow-up ideas, shown as chips |

`read_file` resolves against the **in-memory tree the prompt was built from**,
never the filesystem — there is nothing on the host for a path traversal to
reach even if `validateReadPath` were bypassed. It is still refused outside
`src/`, because this process holds `JWT_SECRET` and `MONGODB_URI` in its
environment and the check should not depend on today's storage happening to
be a plain object.

### What the model may write

```
src/**.{ts,tsx,css}      an app's source
*.html   (project root)  a site's pages
```

Everything else is refused, including `src/page.html` — `vite.config.ts`
discovers pages by reading the project root rather than recursing, so a
nested page would be written, reported as written, and never built.

`PROTECTED_PATHS` additionally refuses `src/main.tsx`, `src/vite-env.d.ts`
and `src/lib/payments.ts`.

### Apps and sites

The model chooses, and the choice changes what it writes:

- **A website** — restaurant, barber, portfolio, a landing page with an About
  and a Contact — gets real pages. `index.html`, `about.html`, `menu.html` at
  the project root, linked with ordinary `<a href="about.html">`. Vite builds
  each one. Writing the file *is* adding the page.
- **An app** — dashboard, tracker, calculator, game — gets one React page:
  `src/App.tsx` plus components under `src/`.

Static pages rather than a router, and that is forced rather than preferred.
The same build is served at three different path prefixes (§5) and
`vite.config.ts` sets `base: "./"` for that reason. With relative assets, a
client-side route like `/s/slug/shop/item` resolves `./assets/x.js` to
`/s/slug/shop/assets/x.js`, which hits the index.html fallback and hands the
browser HTML where it asked for JavaScript. An absolute base cannot fix it
either, because one build has to work at all three mounts.

### The context budget

The model's window is finite and the conversation only ever grows, so both
ends are bounded.

| | fast | balanced | smart | max |
|---|---|---|---|---|
| reply budget (`max_tokens`) | 16,000 | 32,000 | 48,000 | 64,000 |
| repair rounds | 1 | 2 | 3 | 4 |
| tier | eco | eco | power | power |

`balanced` is the default. The two tiers still exist underneath — they are
what picks the model — but the person sees four steps, not two, and `mode`
stays a separate axis because how hard to think and whether to ask first are
different questions. The list is `EFFORT` in `model-loop.js`, and its order
is the order of the slider.

The codebase budget is **computed from the model's context window**, not
fixed. `codeBudgetChars()` subtracts the system prompt, the tool schemas, the
history, the errors, one reply and one accumulated attempt from the window.
The upper levels get less because they reserve a larger reply.

`fitConversation()` keeps it there. It drops the **oldest repair exchanges**,
in whole groups, never single messages — an assistant message carrying
`tool_calls` must keep its tool replies or the request is a 400 for a
different reason. The system prompt, the request (which carries the codebase)
and the most recent attempt are never dropped. History goes only after every
superseded attempt is gone.

`client.chat()` is the backstop: a request that still cannot fit is refused
locally, with the numbers, rather than paying a round trip to be told so.

**On the `/runs` engine, dropping is now the last resort rather than the
only one.** `context/context-manager.ts` runs four steps before every call,
cheapest first, each only when the one before it was not enough:

| | what it does | what it costs |
|---|---|---|
| measure | pressure as a fraction of the usable window | nothing |
| micro-compact | clears old bulky **tool results**, leaving a pointer | nothing — `agent_steps` still has the raw row |
| auto-compact | replaces the middle with a structured summary | one provider call, and detail |
| `fitConversation` | drops whole groups | whole turns |

Thresholds are fractions of the window (0.60 and 0.85), not message counts:
forty short turns fit comfortably and three turns carrying a 24,000-character
`read_file` do not. In the 100-turn test, clearing tool output alone holds the
request at 58% and the summary never runs — the expensive rung only engages
when the bulk is the conversation itself.

The summary is built from facts the runner tracked as they happened, not by
reading the transcript back, because by then the transcript is what is being
discarded. It quotes the user's request verbatim, keeps a pending question
pending, and records an unattested browser check **as** unattested — a summary
saying "passed" would launder a client's claim into a verified result.

Nothing durable is written without `context/redact.ts` first. A summary and a
project rule both outlive the turn that made them.

Other limits: history 12 turns / 6,000 chars; `read_file` truncates at 24,000
chars and says so; three tool rounds before the model is told to write; a
truncated reply retries at double the budget, capped at 32,000.

### The repair loop

1. The model writes files.
2. **Entry check, before any compile.** A build with no `src/App.tsx` and no
   `index.html` is asked for one. The scaffold ships a placeholder `App.tsx`,
   so a tree of leaf files compiles cleanly and renders the words "Souqi
   Code" — checking `written` first saves a full WebContainer install on a
   question already answered.
3. `onFiles(allCalls)` sends the accumulated tree to the browser to compile.
4. Build errors come back and become a repair round.
5. Rounds exhausted → `getFallbackAppCode()`, a starter template, recorded as
   `fellBack: true`.

Infrastructure failures (a WebContainer that would not boot, the server's own
timeout) are **not** fed back as code defects. No rewrite fixes them, and
doing so burned repair rounds on nothing.

### Model routing

| Route | Provider | Used for |
|---|---|---|
| `json` | `deepseek-flash`, or `deepseek-v4-pro` on smart and max | all code generation |
| `prose` | `deepseek-flash` | chat, replies, plan cards |
| `vision` | `deepseek-flash` | describing uploaded photos |

Every route is DeepSeek. Prose and vision were on Gemini for its multilingual
range — that is what `archive/AI-PROVIDER-PLAN.md` describes — until `d48f2f4`
moved them. The three-route *shape* was kept rather than collapsed, because it
is what makes going back a configuration change: each route still has its own
base URL, model, key, breaker and spend line.

Vision is `deepseek-flash` and not the stronger model on purpose. Checked
against the live API, `deepseek-flash` described a logo correctly where
`deepseek-v4-pro` answered "NO IMAGE" to the same picture.

Vision never falls back. A text-only model handed an image does not decline —
it writes a fluent description of a photo it never received, which then gets
cached on the upload row and used to place that photo on someone's site.

**The circuit breaker counts outages only.** Five failures opens a route for
ten minutes, per route and shared by every user, so a 400 caused by our own
oversized request must not count toward it — a handful of large builds would
take the route down for everyone. `429` counts (it means back off); `400`,
`401`, `403` and `404` do not.

### Prompts

`PROMPT_VERSION` is folded into the design cache key, so bumping it retires
every entry written under the old wording. Bump it whenever the prompt
changes meaning.

Two rules worth knowing about, because both were bugs:

- **Language.** The rule names no language as an example. It used to say
  "Turkish in, Turkish out" and "a Turkish bakery has a Turkish menu" — four
  mentions in the one paragraph governing UI copy — and English requests came
  back as Turkish sites. A named example is what the model reaches for when
  it is unsure. The rule is also repeated *after* the request, because the
  system prompt sits tens of thousands of characters away behind the whole
  codebase. A test fails if any language other than English (the stated
  fallback) is named again.
- **One response.** The model is told there is no second turn and that the
  entry point goes in the same batch as everything else. Without it, it wrote
  the types, helpers and data and stopped, expecting to be asked to continue.

---

## 4. The scaffold

`backend/lib/codeagent/scaffold/` — 12 files, frozen into `scaffold-data.json`
at build time.

**Regenerate after changing anything under `scaffold/`:**

```bash
node backend/scripts/build-scaffold-data.js
```

The directory is not read at runtime, and on Vercel it cannot be: excluded,
the files are missing; included, the function bundler transpiles `App.tsx` to
`App.js` while `index.html` still points at `main.tsx`. A `.json` file is
neither compiled nor dropped.

**There are two copies of the dependency list** — `scaffold/package.json` and
the one `frontend/js/codeagent/wc-runtime.js` mounts into the WebContainer.
They must agree. `backend/test/scaffold-contract-test.js` enforces the rule *if the
prompt tells the model to import it, the build container must have it*, which
is the test that would have caught `payments.ts` being mandated by the prompt
and absent from the container.

The browser build runs `tsc --noEmit && vite build`. The `tsc` half is
load-bearing: `vite build` is esbuild, which strips types without checking
them, so a type error bundles cleanly and throws at runtime — a blank page
reported as a successful build.

---

## 5. Preview and publishing

A generated app is served at **three different base paths**, which is why
`base: "./"` is not optional:

1. the WebContainer preview (cross-origin, `webcontainer-api.io`)
2. `/s/:slug/` — the share link
3. a custom domain root — `projects.findByCustomDomain(host)`

`servePublishedSite()` serves the built `dist/` straight out of Mongo and
falls back to `index.html` for unknown paths, the way a client-routed SPA
expects. It injects `window.__SOUQI_APP__` (the project id and origin) into
`index.html` at serve time rather than at build time, so the id cannot drift
or be stale in a cached bundle.

---

## 6. The container plane (`infra/deploy/`)

A separate application on the VPS. It takes a built project and runs it as a
real Docker container on a subdomain, with its own database, network and TLS
certificate.

```
  api ──▶ deployments table ──▶ worker ──▶ pipeline.deploy()
                                             admission
                                             detect framework
                                             generate Dockerfile
                                             build image (in a container)
                                             swap the container
                                             health check
                                             Caddy route
```

Two invariants, both learned the hard way:

- **A redeploy is not an extra app.** It removes one container and starts
  one, so the host ends with what it began with. Counted as an addition, the
  app already running was itself the reason its own redeploy was refused, and
  a full host could never update anything.
- **Refusing to act must not be more destructive than acting.** `fail()` only
  removes a container once the attempt owns the name — a redeploy reuses the
  deployment id, so before the swap that name belongs to the *live* revision.
  It used to remove it unconditionally, which meant a deploy refused at
  admission deleted the working site and left a Caddy route pointing at
  nothing. That is where every 502 on an `app-*.souqi.site` subdomain came
  from.

A **stopped container still holds an admission slot** (`total`, not
`running`). That is deliberate — a stopped app can be started again, and
counting only running ones lets a host oversubscribe the moment they all come
back — but it does mean dead weight fills a host. `MAX_CONTAINERS` defaults
to 40 in code; the production host sets 10.

---

## 7. Images

Upload → R2 (S3-compatible) → the vision route describes it → the description goes into
the build prompt.

```
POST /api/uploads/sign          presigned PUT, SigV4 query-string signed
PUT  <r2>                       browser uploads directly, never through us
POST /api/uploads/:id/complete  magic-byte sniff, SVG refused
GET  /api/img/*                 signed read-through
```

The **description** is the point. The build model cannot see; it is reading a
paragraph written by something that could, and that paragraph turns "a file
called IMG_4821.jpg" into "a wide, dark photo of a café interior with space
for text on the left". Without a vision key it degrades to filename and
dimensions, which still tells you a landscape image is a hero candidate and a
square one is a tile.

Images live in the **user** prompt, not the system prompt: the system prompt
is byte-identical across builds and gets the provider's prefix-cache
discount, and `cacheKey()` folds the user prompt in, so two different sets of
photos cannot collide in the design cache.

`validateWriteFileArgs` repairs a mistyped image URL back to the real one and
replaces any other remote `<img>` with a gradient placeholder. An invented
URL is a torn-page icon on a customer's site, and neither `tsc` nor Vite
objects to a string.

---

## 8. The design system

`backend/lib/codeagent/theme.js` and `backend/lib/design/palette.js`.

Every build gets a palette computed from a seed — the uploaded logo's
dominant colour when there is one, otherwise the build type. It is generated
in OKLCH, and **WCAG AA is proven by computation rather than judgement**: if a
pairing fails, the fill moves until it passes. `backend/test/theme-test.js` runs
every palette the module can produce and asserts the measured contrast rather
than spot-checking one.

The palette is written into a generated `tailwind.config.js` and named in the
prompt as concrete tokens (`bg-surface`, `text-ink`, `bg-accent`,
`text-on-accent`). The model cannot overwrite it — `tailwind.config.js` is
outside `src/`.

Fonts arrive as a pseudo-file `__souqi_fonts__`, which `wc-runtime.js` injects
into **every** `.html` page, so a multi-page site does not change typeface as
you navigate it.

---

## 9. Tests

```bash
node backend/test/model-loop-test.js         # the agent: 91 cases
node backend/test/ai-client-test.js          # routes, breaker, budget: 19
node backend/test/diffstat-test.js           # the build card's +/- numbers: 13
node backend/test/theme-test.js              # measured contrast: 12
node backend/test/scaffold-contract-test.js  # prompt/container agreement: 4
node infra/deploy/test/admission-test.js     # redeploy admission: 5
```

Everything under `backend/test/` runs without network or a key —
`fetchImpl` is injected. Two need a local mongod on `127.0.0.1:27017` and
fail without one: `sse-test.js` and `smoke-test.js` (the latter fails by
**timing out** rather than saying so, which its own header warns about).

A convention worth keeping: several of these assert an **exact set** rather
than a subset — `TOOLS_SCHEMA`, the write-path boundary — so widening the
model's surface cannot happen quietly. Both times a tool was added, that
assertion is what caught it.

---

## 10. Operations

### Environment

| Variable | What it does |
|---|---|
| `AI_ENABLED` | `1`, or the whole agent returns `{disabled:true}` without touching the network |
| `AI_JSON_{BASE_URL,MODEL,KEY}` | the coding route (DeepSeek) |
| `AI_PROSE_{BASE_URL,MODEL,KEY}` | chat and plans (DeepSeek) |
| `AI_VISION_{BASE_URL,MODEL,KEY}` | photo descriptions (DeepSeek) |
| `AI_JSON_POWER_MODEL` | the smart/max model, `deepseek-v4-pro`. Unset means those levels run the same model as the lower two and their extra effort is only a longer budget |
| `AI_<ROUTE>_CONTEXT_TOKENS` | override a context window the table does not know |
| `AI_MONTHLY_BUDGET_USD` | hard stop across all routes; `0` means unlimited |
| `CODEAGENT_MAX_CODE_CHARS` | caps the computed codebase budget (cannot raise it past the window) |
| `S3_{ENDPOINT,BUCKET,ACCESS_KEY,SECRET_KEY,REGION,PUBLIC_BASE_URL}` | R2 uploads |
| `MAX_CONTAINERS` | VPS admission limit (code default 40) |

### Checking on things

```bash
curl -sL https://souqi.site/code | grep -c 'a-string-from-your-change'
```

```bash
ssh ubuntu@148.113.174.192 'docker ps -a --format "{{.Names}}\t{{.Status}}"'
```

```bash
ssh ubuntu@148.113.174.192 'docker logs stack-worker-1 --tail 2000 | grep dep_xxxx'
```

```bash
cd infra/deploy && bash scripts/ship.sh 148.113.174.192 --logs
```

### Measuring the agent

Every build writes an audit row with `{ok, fellBack, repaired, rounds, mode,
model, promptVersion, imagesAttached, infra, verified}`. `promptVersion` is
what makes a prompt change answerable: compare `rounds` and `fellBack` across
versions rather than arguing about whether a wording change helped.

---

## 11. Things that look like bugs and are not

- **The composer is glass only when docked.** The new-chat hero centres the
  same box over empty paper, where transparency has nothing to reveal.
- **The aurora bloom is off when docked.** `::before` sits at `z-index:-1`, so
  the moment the fill stops being opaque the gradient paints through it onto
  the message underneath.
- **`sandboxAlive` is always `false`.** Daytona is gone; the field is kept
  because the client still reads it.
- **A build that writes no `App.tsx` still compiles.** The scaffold ships a
  placeholder. That is exactly why the entry guard exists.
