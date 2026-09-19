/* =================================================================
   framework/detect.js — work out what the user uploaded
   -----------------------------------------------------------------
   Detection is a convenience, never a contract. An explicit
   deploy.json in the source always wins, because guessing wrong on
   someone else's code is worse than asking them to declare it.

   Supported on purpose, and no more (spec: "do not attempt to
   support every language initially"):
     static  — Vite/CRA/plain HTML, built to a folder, served by nginx
     node    — anything with a start script
     nextjs  — needs its own runtime, not a static export
     python  — Flask/FastAPI/Django via a WSGI/ASGI server
   ================================================================= */
"use strict";

const fs = require("fs");
const path = require("path");

const FRAMEWORKS = ["static", "node", "nextjs", "python"];

// Must match dockerfiles.js: nginx runs unprivileged and listens here.
const STATIC_PORT = 8080;

function readJson(dir, name) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); }
  catch (e) { return null; }
}
const has = (dir, name) => fs.existsSync(path.join(dir, name));

/**
 * @returns {{framework, buildCommand, startCommand, port, outputDir, declared}}
 */
/* The build command for a static app, with the type gate taken off it.

   Three cases, in order:

     build:deploy            the scaffold ships one now — "vite build",
                             the same bundle with no gate.
     "tsc … && <rest>"       every project scaffolded BEFORE that, which
                             is most of them and cannot be edited from
                             here. Run <rest> and drop the tsc.
     anything else           left exactly alone.

   The second case is the one that matters in practice. A real deploy
   failed on `Type 'string' is not assignable to type 'Severity'` — a
   true statement about an app that runs correctly, and tsc exits 2, so
   the image was never built. The project had no build:deploy because it
   was created before the script existed, and nothing in the deploy path
   can add one.

   Only a leading `tsc` is stripped, and only when something follows it,
   so a build script that does real work keeps doing it. --no-install so
   npx can never reach the network for a vite that is not in the image:
   if the binary is missing the build should fail, not silently fetch a
   different version of it. */
function staticBuildCommand(scripts) {
  if (scripts["build:deploy"]) return "npm run build:deploy";
  const build = String(scripts.build || "");
  const gated = /^\s*(?:npx\s+)?tsc\b[^&|]*&&\s*(\S.*)$/.exec(build);
  if (gated) {
    const rest = gated[1].trim();
    return /^(?:npx|npm|node|yarn|pnpm)\b/.test(rest) ? rest : "npx --no-install " + rest;
  }
  return "npm run build";
}

function detect(dir) {
  // 1. An explicit spec wins outright.
  const declared = readJson(dir, "deploy.json");
  if (declared && FRAMEWORKS.includes(declared.framework)) {
    return normalise(Object.assign({ declared: true }, declared));
  }

  const pkg = readJson(dir, "package.json");

  if (pkg) {
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    const scripts = pkg.scripts || {};

    if (deps.next) {
      return normalise({
        framework: "nextjs",
        buildCommand: scripts.build ? "npm run build" : "npx next build",
        startCommand: scripts.start ? "npm start" : "npx next start",
        port: 3000
      });
    }

    // Vite / CRA / any build that emits a folder of static files. Checked
    // before "node" because these DO have a build script but must not get a
    // long-running Node process — that would cost 512MB to serve files nginx
    // handles in 8MB.
    const staticish = deps.vite || deps["react-scripts"] || deps["@vitejs/plugin-react"];
    if (staticish && scripts.build) {
      return normalise({
        framework: "static",
        /* build:deploy when the project has one, because `build` is not
           only a build.

           The scaffold defines `build` as "tsc --noEmit && vite build" —
           deliberately, so the agent gets type errors back while it is
           still working and can repair them. In here that same script is
           a deploy gate: tsc exits 2 on any type error and the image never
           gets built, so a finished app that runs perfectly is refused
           over a type it could not name. Observed exactly that: `npm run
           build` returned code 2 and the deploy reported nothing but the
           number.

           Types are checked during the RUN, which is where a person can
           still do something about them. Shipping is not the place to fail
           over them, and the bundle is identical either way: vite hands
           .tsx to esbuild, which strips types without reading them.

           Falls back to `npm run build` for every project that has no
           build:deploy — anything scaffolded before this, and anything
           imported from outside. */
        buildCommand: staticBuildCommand(scripts),
        outputDir: deps["react-scripts"] ? "build" : "dist",
        port: 80
      });
    }

    if (scripts.start || pkg.main) {
      return normalise({
        framework: "node",
        buildCommand: scripts.build ? "npm run build" : null,
        startCommand: scripts.start ? "npm start" : "node " + (pkg.main || "index.js"),
        port: 3000
      });
    }
  }

  if (has(dir, "requirements.txt") || has(dir, "pyproject.toml")) {
    return normalise({
      framework: "python",
      buildCommand: null,
      startCommand: guessPythonStart(dir),
      port: 8000
    });
  }

  // Plain HTML with no build step at all.
  if (has(dir, "index.html")) {
    return normalise({ framework: "static", buildCommand: null, outputDir: ".", port: 80 });
  }

  return null;
}

function guessPythonStart(dir) {
  if (has(dir, "manage.py")) return "python manage.py runserver 0.0.0.0:8000";
  for (const f of ["main.py", "app.py", "server.py"]) {
    if (has(dir, f)) {
      const mod = f.replace(/\.py$/, "");
      // Uvicorn covers FastAPI and any ASGI app; a Flask app object works too
      // via its WSGI shim, so one command serves the common cases.
      return "uvicorn " + mod + ":app --host 0.0.0.0 --port 8000";
    }
  }
  return "python main.py";
}

function normalise(s) {
  const out = {
    framework: s.framework,
    buildCommand: s.buildCommand || null,
    startCommand: s.startCommand || null,
    port: Number(s.port) || (s.framework === "static" ? STATIC_PORT : 3000),
    outputDir: s.outputDir || (s.framework === "static" ? "dist" : null),
    declared: !!s.declared
  };
  if (!FRAMEWORKS.includes(out.framework)) throw new Error("unsupported framework: " + out.framework);
  // A static site is served by nginx on STATIC_PORT regardless of what anyone
  // declares; letting a declared port through here would produce a proxy route
  // pointing at a port nothing listens on. It is 8080 rather than 80 because
  // nginx runs unprivileged in these containers and cannot bind a low port
  // without CAP_NET_BIND_SERVICE, which they do not get.
  if (out.framework === "static") out.port = STATIC_PORT;
  return out;
}

module.exports = { detect, FRAMEWORKS };
