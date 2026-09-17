# Working in this repo

Read [`docs/REPO-MAP.md`](docs/REPO-MAP.md) first if you do not know where
something lives. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the shape,
[`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md) is the agent, and
[`docs/DEPLOYING.md`](docs/DEPLOYING.md) is how anything gets out the door.

## Four things that are true and non-obvious

**`git push` deploys nothing.** Two targets, two commands, neither wired to
git. Reporting something as live because it was pushed has already been wrong
once here.

**Only `/api/*`, `/auth/*` and `/s/*` reach Express in production.** Everything
else is a static file or a 404 at the edge. Routes exist in `backend/index.js`
that can never run on `souqi.site`. A 404 from production means "not routed
here", not "refused" — so calibrate a probe before concluding anything from it.

**`api/` cannot move.** Vercel discovers functions only at `<root>/api/`.

**Verify a deploy against a marker that exists only in the new code.** A route
that answers, a page that loads, a 401 where you expected one — none of these
distinguish the new deploy from the one before it.

## Commits

Look at `git log` before writing one. The style is specific and consistent:

- A complete declarative sentence. Capitalised, **no trailing period**.
- **No prefixes.** Not `feat:`, not `fix:`, not a scope, not a ticket number.
- It states the **observable effect**, or names the bug — not the change.
  Not "refactor auth middleware" but *"A revoked session stops working."*
- Often the defect's epitaph, in past tense: *"The provider was never the limit
  — our own constants were"*, *"A white page was a successful build"*.
- Or the new behaviour, present tense: *"Every route is DeepSeek now"*,
  *"The composer row stops shuffling when the effort changes"*.
- Comma-joined clauses when one change has two visible effects. Em dashes are
  welcome. Specific numbers are welcome — *"173px wider than the phone"*.
- Length is not proportional to the diff. A twenty-thousand-line deletion here
  got one clause.

## Comments

The same voice runs through the code, and it is the repo's most distinctive
habit: **a non-obvious line carries a comment naming the specific incident that
motivated it.** Not what the code does — why it is shaped that way, and what
went wrong when it wasn't. See `.gitattributes`, `.vercelignore`,
`infra/deploy/docker-compose.yml`, `infra/deploy/scripts/ship.sh`.

Match the density of the file you are editing. Do not add narration to code
that does not have any.

## Before you say it works

```bash
cd backend && node test/csp-test.js && npm run lint
```

`test/csp-test.js` is the canary for anything touching routes, `vercel.json`,
or the served directory — it asserts the config and the app agree. Read the
assertion count it prints; a suite that got *shorter* is a suite that started
skipping.

Two things are already failing and are not yours: `npm run lint` exits 1 at 55
warnings against a budget of 50, and some of `npm run ci` has been unreachable
behind a step that threw. Say so rather than fixing them silently into an
unrelated change.

A passing test suite says nothing about rendering. For CSS, compare computed
styles and layout boxes before and after — and control for this codebase's
nondeterminism, which is real: suggestion chips shuffle per load, the login
page types its own text, colours transition over `--dur-chill`, and admin's
auth gate resolves async. Compare a tree against itself first; whatever differs
there is noise.

## Generated files

Do not hand-edit `backend/lib/nlu/industry-model.json` or
`backend/lib/codeagent/scaffold-data.json`. Each has a script beside it, listed
in `docs/REPO-MAP.md`.

**The agent is TypeScript.** Every `.js` under `backend/lib/codeagent/` (and
its `runtimes/`, and `backend/worker/`) is compiled from `backend/agent-src/`
and carries a banner saying so. Edit the `.ts` and run `npm run build:agent`;
editing the `.js` means your change is gone on the next build. `npm run
typecheck` is the same compile without the write, and it is strict — unlike
`npm run lint`, which does not read the generated output at all.

The source tree mirrors the output tree, and has to: a relative import
resolves against the source file at compile time and the emitted file at
runtime, so both trees must agree on what `../ai/client` means.
