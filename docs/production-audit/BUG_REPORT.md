# Functional bugs found and fixed

Each entry: what was observed, the root cause, the fix, and how it was
verified. Everything here is on `main`.

---

## Deployment engine

### D-1 · P0 · FIXED — a type error refused to deploy an app that runs

**Commits:** `7be64f9`, `2634d27` · **File:** `infra/deploy/src/framework/detect.js`

Reported as a Docker build failing with:

```
tsc --noEmit && vite build
src/components/Demo.tsx(121,15): error TS2345: ...
  Type 'string' is not assignable to type 'Severity'.
The command '/bin/sh -c npm run build' returned a non-zero code: 2
```

**Root cause.** Exit code 2 is `tsc` — Vite exits 1. The scaffold defines
`build` as `tsc --noEmit && vite build`, deliberately, so the agent gets
type errors back while it can still repair them. In the deploy that same
script is a gate: any type error refuses the image for an app that is
finished and runs. The preview never warned, because the preview strips
types without checking them.

**Fix, in two parts.** New projects get `build:deploy` (`vite build`) and
the deploy prefers it. Existing projects cannot be edited from the deploy
path, so a build of the shape `tsc … && <rest>` now runs `<rest>`. Only a
*leading* `tsc`, and only when something follows it, so `tscpaths` keeps
running and post-bundle steps are preserved. `npx --no-install` so a
missing binary fails rather than fetching a different version.

**Verified** inside the running worker after `ship.sh`:

```
existing project -> npx --no-install vite build
new scaffold     -> npm run build:deploy
```

Deploy suite 119 → **122 checks**.

*Process note:* the first version of the regex was broken because a `\b`
in a heredoc became a literal `0x08` byte. Caught because every case fell
through to `npm run build`.

---

## Agent

### A-1 · P1 · FIXED — the agent had no memory of its own conversation

**Commit:** `5d421ed`

Asked what the first message in a chat was, the agent answered — honestly
— that there was nothing before the one line it could see.

**Root cause.** `/api/codeagent/runs` built history only from
`req.body.conversation`, and the browser only keeps `convo`, a
page-session array its own comment calls *"the conversation before a
project exists"*, cleared when a build lands. Every turn after the first
build, and after any reload, ran with empty history. `/build` had read
turns from Mongo all along; the route the UI posts to never learned to.

**Fix.** Read the thread from Mongo when a project exists, scoped to the
chat. Also closes a trust problem — see SECURITY_AUDIT.md S-4.

### A-2 · P2 · FIXED — five minutes of "Thinking" with nothing under it

**Commit:** `4144cf3`

On a reasoning model at high effort the provider sends nothing but
`reasoning_content` for minutes before the first content delta. The
client collected it and deliberately withheld it — *"not for showing to
anyone"* — so a long turn was indistinguishable from a hang.

Now forwarded as its own event the whole way down, capped at 20k chars
per turn on a 1s flush, `redact()`ed like the narration, and rendered as
the last finished clause in the status line. Kept out of the transcript:
it is the model working, not the agent addressing the user.

### A-3 · P2 · NOT FIXED — one model call can eat the whole run budget

A run spent 212,866 ms inside a single call and was cut off by the 5
minute wall (`AGENT_WALL_MS` = `vercel.json`'s `maxDuration: 300`). See
REMAINING_RISKS.md R-4.

---

## Frontend

All verified by measurement in a real browser, not by eye.

| ID | Bug | Root cause | Commit |
| --- | --- | --- | --- |
| F-1 | Send button dropped below the mic on a phone | `.ag-brow` wraps, and flex resolves line-breaking **before** `flex-shrink` — so a shrinkable pill never shrank, it moved. `flex-wrap:nowrap` behind a `:has()` guard, because `.ag-attach-row` needs wrapping only when a file is attached. 320px: 67px → **36px** | `4cfa816` |
| F-2 | Effort pill rendered "Bal" instead of "Balanced" | Both pills were shrinkable; the effort pill is a grid sized to the widest label, so the pill clipped it. Pinned; the model pill absorbs instead. At 320 the mic hides below 360px to make room | `62647d2` |
| F-3 | Long prompts scrolled back to line one on every keystroke | `height:"auto"` (needed to measure) resets `scrollTop`, discarding the caret scroll the browser had just done. Also the JS clamped to 180 while CSS said `max-height:140` — the inline height lied by 40px | `044cf4e` |
| F-4 | 52px empty bar at the top of every phone screen | A solid band plus `.ag{padding-top:52px}` to stop text colliding with fixed buttons. Replaced with a gradient; the greeting is no longer clipped | `3af67dd` |
| F-5 | Rail chat dots started 27px late; loading dots landed elsewhere | An invisible `opacity:0` "Recent" heading still occupied 27px. The skeleton was the last row still centring itself while real rows left-align, so dots jumped sideways **and** up when loading finished | `6213043` |
| F-6 | Stylesheet fixes deployed but not served | `?v=` cache-bust frozen while the file changed. `X-Vercel-Cache: HIT`, `Age: 641` | `cfa22f9` and each bump since |

F-6 is the recurring one and is why every deploy in this pass ended by
checking **served bytes** against local, not just that the deploy
succeeded.
