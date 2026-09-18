import { WebContainer } from 'https://cdn.jsdelivr.net/npm/@webcontainer/api@1/+esm';

const packageJson = {
  "name": "souqi-code-app",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    /* tsc --noEmit, matching the canonical scaffold. Its absence here was the
       single largest correctness hole in the product.

       vite build is esbuild, and esbuild STRIPS types without checking them.
       So the only signal the agent ever got was "did it bundle" — which a
       type error passes cleanly, before throwing at runtime and rendering a
       blank page that nothing else checks either. The prompt requires the app
       to "compile under TypeScript strict mode" and nothing was verifying it;
       both build parsers carry a TSC_RE branch for diagnostics that could not
       be produced.

       typescript is already in devDependencies below, so this costs a few
       seconds of build time and no new install. Expect the measured failure
       rate to RISE at first: those builds were failing before, silently and
       later, in the user's browser instead of in the repair loop. Surfacing
       them is what lets the loop fix them.

       tsconfig sets strict:true but leaves noUnusedLocals/Parameters off,
       which is the right calibration — real type errors fail, tidiness
       complaints do not. */
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview --port 4173 --strictPort"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "autoprefixer": "^10.4.19",
    "postcss": "^8.4.39",
    "tailwindcss": "^3.4.4",
    "typescript": "^5.5.3",
    "vite": "^5.3.1"
  }
};

const viteConfigTs = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { host: true, strictPort: true },
  base: "./"
});`;

const tsconfigJson = {
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
};

const tailwindConfigJs = `export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: []
};`;

const postcssConfigJs = `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {}
  }
};`;

/* THE PREVIEW IS A DEVICE, AND A DEVICE HAS NO SCROLLBAR.

   The scaffold document carries this already, but a static site writes its
   OWN index.html and never got it — so the mockup showed a scrollbar track
   down the side of the page. On an Arabic build it is worse than untidy:
   dir="rtl" moves the scrollbar to the LEFT, where it reads as a broken
   edge rather than as chrome.

   Injected into every page the build writes, for the same reason the font
   links are: a multi-page site is about.html and menu.html too, and one
   page without it is one page that jumps. */
const NO_CHROME_MARK = "souqi-no-chrome";
const noChromeStyle = '<style id="' + NO_CHROME_MARK + '">' +
  'html,body,*{scrollbar-width:none;-ms-overflow-style:none}' +
  'html::-webkit-scrollbar,body::-webkit-scrollbar,*::-webkit-scrollbar{display:none;width:0;height:0}' +
  '</style>';

const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Souqi Code app</title>
    <style>
      /* This preview is framed as an iPhone/iPad/monitor mockup — a real
         device doesn't show OS scrollbar chrome, so this shouldn't either.
         Baked into the scaffold itself (not injected from the parent page)
         because the WebContainer dev server is served from its own origin;
         nothing outside this document can reach in to style it. Scrolling
         still works via wheel/touch, only the bar is hidden. */
      html, body, * { scrollbar-width: none; -ms-overflow-style: none; }
      html::-webkit-scrollbar, body::-webkit-scrollbar, *::-webkit-scrollbar { display: none; width: 0; height: 0; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>
      /* DOES IT ACTUALLY RENDER?
         ----------------------------------------------------------------
         Until this existed the agent's only signal was "did it bundle",
         which a component that throws at mount, returns null, or renders an
         empty shell passes cleanly — shipping a white page reported as a
         successful build. tsc closed the type half of that; this closes the
         other half, because a correctly-typed component can still render
         nothing.

         It has to live HERE, inside the app's own document. The preview is
         served from webcontainer-api.io, a different origin from the
         builder, so the parent page cannot read this DOM or catch these
         errors — every attempt to reach in is blocked, and the one place
         that tried has a catch around it saying so. postMessage is the one
         channel that does cross an origin, so the app reports on itself.

         Errors are captured from the first line rather than at report time:
         a throw during mount happens long before the timer below fires, and
         by then the only trace left is an empty #root. */
      (function () {
        var errors = [];
        var push = function (m) { if (m && errors.length < 5) errors.push(String(m).slice(0, 300)); };
        window.addEventListener("error", function (e) {
          push(e && e.message ? e.message : "script error");
        });
        window.addEventListener("unhandledrejection", function (e) {
          push("unhandled promise rejection: " + ((e && e.reason && e.reason.message) || e.reason || "unknown"));
        });

        /* DOES IT SURVIVE BEING USED?
           --------------------------------------------------------------
           Everything above this answers "did it paint", and an app can pass
           that and still be broken the first time anybody touches it. A
           handler reading a property off something undefined renders
           perfectly, compiles perfectly, and throws the moment someone
           clicks Add to cart. Nothing in the loop could see that, because
           every check ran at mount and then stopped watching.

           So: press one thing, and see what happens.

           The selection is deliberately timid, because this runs in the
           SAME iframe the person is about to look at.
             - No anchors. A link navigates, and the preview would be
               sitting on another page by the time they saw it. Nav links
               are preflight's job anyway.
             - Nothing that reads as paying, ordering or deleting. checkout()
               in the scaffold's payments.ts genuinely navigates to Stripe;
               a smoke test that buys something is not a smoke test.
             - Nothing hidden or disabled: a zero-size button is usually
               inside a closed menu, and clicking it proves nothing.

           preventDefault on the capture phase stops navigation and form
           submission without stopping React, which delegates from the root
           on the bubble phase and never sees the difference. */
        function smoke(done) {
          var all, safe, el, label, before;
          try {
            all = [].slice.call(document.querySelectorAll("button, [role=button], input[type=button]"));
          } catch (e) { return done({ found: 0 }); }
          safe = all.filter(function (c) {
            if (c.disabled) return false;
            var t = ((c.innerText || c.value || "") + " " + (c.getAttribute("aria-label") || "")).trim();
            if (/pay|checkout|buy|order|purchase|donate|subscrib|delet|remove|sign out|log ?out/i.test(t)) return false;
            var cs = window.getComputedStyle(c);
            if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false;
            var r = c.getBoundingClientRect();
            /* A zero-width test is not enough, and NO BACKTICKS IN HERE:
               this whole document is a template literal, so one closes it and
               the comment becomes live JS. That shipped once, as
               "Unexpected token !" at load, which takes out the runtime and
               leaves the agent sitting there with no thinking animation.

               A button styled width:0;height:0 still reports a non-zero
               rect, because the UA stylesheet's border and padding sit outside
               the content box — so the first version of this cheerfully
               clicked a hidden button and reported the app fine. A control a
               person could actually hit is bigger than this. */
            if (r.width < 12 || r.height < 12) return false;
            var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false;
            /* And it has to be the thing at that point. Inside a closed
               drawer, or under a modal backdrop, an element is the right size
               and the right shape and still unreachable. */
            var top = document.elementFromPoint(cx, cy);
            return !!top && (top === c || c.contains(top));
          });
          if (!safe.length) return done({ found: 0 });
          /* The biggest one, not the first. Document order hands back the
             hamburger and the skip link; the primary action on a generated
             page is almost always the largest control on it. */
          safe.sort(function (a, b) {
            var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
            return (rb.width * rb.height) - (ra.width * ra.height);
          });
          el = safe[0];
          label = ((el.innerText || el.value || "").trim() || "a button").slice(0, 40);
          before = errors.length;
          var guard = function (e) { e.preventDefault(); };
          document.addEventListener("click", guard, true);
          try { el.click(); } catch (e) { push(e && e.message ? e.message : "the click threw"); }
          document.removeEventListener("click", guard, true);
          /* A handler that sets state throws on the render that follows, not
             on the click, so the report has to wait for that render. */
          setTimeout(function () {
            done({ found: safe.length, clicked: label, threw: errors.slice(before) });
          }, 250);
        }

        function report() {
          var root = document.getElementById("root");
          var text = (document.body.innerText || "").trim();
          /* Two ways to look busy, and a real app passes both. Text alone
             misses an app that is entirely images or canvas; element count
             alone passes a root containing one empty wrapper div. */
          var nodes = root ? root.querySelectorAll("*").length : 0;
          /* Read BEFORE the click, so a button that legitimately empties the
             screen — clearing a list, closing a panel — is not reported as an
             app that renders nothing. */
          var empty = text.length === 0 && nodes < 3;
          /* Frozen before the click, because the two kinds of failure want
             two different messages. Everything here happened at MOUNT — the
             page is broken before anyone touches it. What the click adds is
             reported separately as interactive.threw, and sending one merged
             list made a handler bug read as "it threw when it loaded", which
             sends the model looking in the wrong place entirely. */
          var mountErrors = errors.slice();
          smoke(function (interactive) {
            try {
              parent.postMessage({
                source: "souqi:render",
                empty: empty,
                textLength: text.length,
                nodes: nodes,
                errors: mountErrors,
                interactive: interactive
              }, "*");
            } catch (e) { /* nothing we can do from in here */ }
          });
        }

        /* React mounts in a microtask after load, and an app that fetches on
           mount paints its first real content a frame or two later. 600ms is
           long enough to let that settle without becoming part of how long a
           build takes. Reported once either way — a second report would race
           the parent's own timeout. */
        window.addEventListener("load", function () { setTimeout(report, 600); });
      })();
    </script>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`;

const srcMainTsx = `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);`;

const srcAppTsx = `export default function App() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <h1 className="text-2xl font-semibold">Souqi Code</h1>
    </div>
  );
}`;

const srcIndexCss = `@tailwind base;
@tailwind components;
@tailwind utilities;`;

const publicPwaIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="#1aa6df"/>
  <path d="M180 336V176h72c39.8 0 66 24.3 66 61.5 0 22.6-11 40.2-29 49.6L336 336h-46l-40-70h-30v70h-40zm40-104h28c17.7 0 27-8.4 27-23.6 0-15.2-9.3-23.6-27-23.6h-28v47.3z" fill="#fff"/>
</svg>`;

const scaffoldFiles = {
  'package.json': { file: { contents: JSON.stringify(packageJson, null, 2) } },
  'vite.config.ts': { file: { contents: viteConfigTs } },
  'tsconfig.json': { file: { contents: JSON.stringify(tsconfigJson, null, 2) } },
  'tailwind.config.js': { file: { contents: tailwindConfigJs } },
  'postcss.config.js': { file: { contents: postcssConfigJs } },
  'index.html': { file: { contents: indexHtml } },
  'src': {
    directory: {
      'main.tsx': { file: { contents: srcMainTsx } },
      'App.tsx': { file: { contents: srcAppTsx } },
      'index.css': { file: { contents: srcIndexCss } }
    }
  },
  'public': {
    directory: {
      'pwa-icon.svg': { file: { contents: publicPwaIconSvg } }
    }
  }
};

let webcontainerInstance = null;

class WCRuntime {
  async boot(onLog) {
    if (webcontainerInstance) {
      if (onLog) onLog("WebContainer already booted.");
      return;
    }
    
    if (onLog) onLog("Booting WebContainer...");
    try {
      webcontainerInstance = await WebContainer.boot();
      if (onLog) onLog("WebContainer booted successfully. Mounting files...");
      await webcontainerInstance.mount(scaffoldFiles);
      if (onLog) onLog("Files mounted.");
    } catch (err) {
      throw new Error("Failed to boot WebContainer: " + err.message);
    }
  }

  async _runCommand(cmd, args, onLog) {
    if (!webcontainerInstance) throw new Error("WebContainer not booted");
    
    const process = await webcontainerInstance.spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    
    process.output.pipeTo(new WritableStream({
      write(data) {
        if (onLog) onLog(data);
        stdout += data;
      }
    }));
    
    const exitCode = await process.exit;
    return { ok: exitCode === 0, code: exitCode, stdout, stderr };
  }

  async install(onLog) {
    if (onLog) onLog("Running npm install...");
    const res = await this._runCommand('npm', ['install', '--no-audit', '--no-fund'], onLog);
    return { ok: res.ok, output: res.stdout };
  }

  /**
   * Boot and install, once, and let anyone wait for it.
   *
   * isBooted() only says a WebContainer exists — it says nothing about
   * whether node_modules does. The two were being conflated: boot+install
   * ran detached in the background while startPreview() gated on
   * isBooted(), so `npm run preview` could fire while npm install was
   * still unpacking, or after it had failed. Either way vite was not on
   * disk yet and the command died with 127, which reads as a broken
   * scaffold rather than a race.
   *
   * Cached, so calling it per preview costs nothing after the first.
   * Never rejects: callers ask isReady() and get installError() for the
   * reason, because "install failed" is a state to render, not an
   * exception to unwind through a UI event handler.
   */
  prepare(onLog) {
    if (!this._prepare) {
      this._prepare = (async () => {
        try {
          await this.boot(onLog);
          const res = await this.install(onLog);
          this._installed = res.ok;
          if (!res.ok) this._installError = (res.output || "").slice(-2000);
        } catch (e) {
          this._installed = false;
          this._installError = e.message;
        }
        return this._installed === true;
      })();
    }
    return this._prepare;
  }

  /** True only when npm install has finished successfully. */
  isReady() { return this._installed === true; }

  /** Why prepare() failed, when it did. */
  installError() { return this._installError || ""; }

  /* The app's own name, for the browser tab.

     The scaffold document ships a fixed <title>, so a preview and anything
     built from it opened a tab called "Souqi Code app" - the builder's name
     on the customer's product. It is set here rather than at boot because
     the container starts before the page knows what is being built: a new
     chat has no project yet, and the head start on npm install is worth more
     than waiting for a name. */
  setAppName(name) { this._appName = String(name || "").trim(); return this; }

  _titled(html) {
    const P = "<title>Souqi Code app</title>";
    if (!this._appName || html.indexOf(P) < 0) return html;
    const esc = String(this._appName).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    return html.replace(P, "<title>" + esc + "</title>");
  }

  async writeFiles(files) {
    if (!webcontainerInstance) throw new Error("WebContainer not booted");

    /* Before anything else touches them, and independent of the font block
       below — that one only runs when the server sent a typeface, and a
       page without one still must not show a scrollbar. */
    files = Object.assign({}, files);
    for (const key of Object.keys(files)) {
      if (!/^[^/]+.html$/.test(key)) continue;
      if (typeof files[key] !== "string") continue;
      if (files[key].indexOf(NO_CHROME_MARK) >= 0) continue;
      files[key] = files[key].indexOf("</head>") >= 0
        ? files[key].replace("</head>", "    " + noChromeStyle + "
  </head>")
        : files[key].replace(/<head([^>]*)>/i, "<head$1>
    " + noChromeStyle);
    }

    /* The build's typeface, which has to be fetched by the document itself —
       a font cannot be delivered through the Tailwind config. The server
       sends it as a pseudo-file rather than a rewritten index.html, so this
       stays the only copy of that document and there is no third scaffold to
       drift.

       Rewritten from the template each time, not appended, so switching build
       type does not leave the previous build's font links behind. */
    if (typeof files.__souqi_fonts__ === "string") {
      const fontTag = files.__souqi_fonts__;
      files = Object.assign({}, files);
      delete files.__souqi_fonts__;

      /* EVERY page gets the font links, not just index.html.
         A multi-page site keeps its markup in about.html, menu.html and the
         rest, and a typeface loaded on the home page alone is a site that
         changes font as you walk through it. */
      for (const key of Object.keys(files)) {
        if (!/^[^/]+\.html$/.test(key)) continue;
        if (files[key].indexOf(fontTag) >= 0) continue;
        files[key] = files[key].indexOf("<title>") >= 0
          ? files[key].replace("<title>", fontTag + "\n    <title>")
          : files[key].replace(/<head([^>]*)>/i, "<head$1>\n    " + fontTag);
      }

      /* Only fall back to the scaffold document when the build did not write
         its own. Writing it unconditionally was safe while index.html could
         not be written at all; now that a static site supplies its own home
         page, it would mount the React shell and the loop below would
         overwrite it straight back — the file flipping twice a build and
         landing correct by luck rather than by design. */
      if (!Object.prototype.hasOwnProperty.call(files, "index.html")) {
        await webcontainerInstance.fs.writeFile(
          "index.html", this._titled(indexHtml).replace("<title>", fontTag + "\n    <title>"));
      }
    }

    for (const [path, content] of Object.entries(files)) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        try {
          await webcontainerInstance.fs.mkdir(dir);
        } catch(e) {
          // ignore if exists
        }
      }
      await webcontainerInstance.fs.writeFile(path, content);
    }
  }

  /**
   * One build at a time.
   *
   * Two concurrent builds share one container: both spawn `npm run build`,
   * both write dist/, and the one that finishes second decides what the
   * preview serves regardless of which had the newer files. That became
   * reachable when reopening a project started warming the container in the
   * background — an edit can now land on top of a warm-up that is still
   * running. Waiting is right rather than skipping: the second caller has
   * newer files and still needs them built.
   */
  async build(onLog) {
    while (this._buildInFlight) {
      try { await this._buildInFlight; } catch (e) { /* its caller owns that failure */ }
    }
    this._buildInFlight = this._build(onLog);
    try { return await this._buildInFlight; }
    finally { this._buildInFlight = null; }
  }

  async _build(onLog) {
    // Both build and preview need node_modules, and three separate callers
    // invoked this without waiting for the install — two of them inside a
    // catch that swallowed the result. Ensuring it here fixes all of them
    // at once, and cannot be forgotten by the next caller. Free once warm.
    await this.prepare(onLog);
    if (!this.isReady()) {
      const why = this.installError() || "dependencies are not installed";
      if (onLog) onLog("Cannot build: " + why);
      // Same shape _runCommand returns, so callers that read .stdout to
      // parse build errors still work and report something true rather
      // than a confusing "command not found: vite".
      return { ok: false, code: 127, stdout: "", stderr: why };
    }
    if (onLog) onLog("Running npm run build...");
    return await this._runCommand('npm', ['run', 'build'], onLog);
  }

  async startPreview(iframeEl) {
    if (!webcontainerInstance) throw new Error("WebContainer not booted");

    /* ONE preview server, reused for the life of the container.

       `npm run preview` is `vite preview --port 4173 --strictPort`. Spawning
       it a second time cannot work: the first one still holds 4173, so vite
       exits 1 with "Port 4173 is already in use" and the UI reports "the
       preview server did not start" — on a build that succeeded. That is the
       "first edit previewed, every edit after it went blank" failure, and
       nothing about the build was ever wrong.

       Reusing is not just a workaround, it is the correct behaviour: vite
       preview serves the static dist directory, so the server already running
       is serving the new build the moment it is written. The iframe only
       needs pointing at it again — with a cache-buster, because assigning the
       identical src does not reload. */
    if (this._previewUrl) {
      if (iframeEl) {
        iframeEl.src = this._previewUrl +
          (this._previewUrl.indexOf("?") > -1 ? "&" : "?") + "r=" + Date.now();
      }
      return { ok: true, url: this._previewUrl, reused: true };
    }

    return new Promise((resolve, reject) => {
      // Register listener BEFORE spawning to avoid race condition
      const onReady = (port, url) => {
        if (port === 4173) {
          this._previewUrl = url;
          if (iframeEl) iframeEl.src = url;
          unsubscribe();
          resolve({ ok: true, url });
        }
      };
      // WebContainer's on() RETURNS the unsubscribe function; there is no
      // off() on the instance. Calling one threw "webcontainerInstance.off
      // is not a function" — and it threw from inside the exit and catch
      // handlers, which are exactly the paths that run when the preview
      // fails. So a failed preview never resolved or rejected: the promise
      // hung, the iframe stayed blank, and the only visible symptom was a
      // TypeError naming a line that was itself the error handler.
      const unsubscribe = webcontainerInstance.on('server-ready', onReady);

      // Capture the output instead of discarding it. When the command
      // fails, its stderr is the only thing that says why, and it was
      // being written into a sink that dropped every byte.
      let output = "";

      webcontainerInstance.spawn('npm', ['run', 'preview']).then(process => {
        process.output.pipeTo(new WritableStream({
          write(chunk) { if (output.length < 4000) output += chunk; }
        })).catch(() => {});
        process.exit.then(code => {
          this._previewUrl = null;
          if (code !== 0) {
            unsubscribe();
            resolve({ ok: false, url: '', code: code, output: output.trim() });
          }
        });
      }).catch(err => {
        unsubscribe();
        reject(err);
      });
    });
  }

  async readFile(path) {
    if (!webcontainerInstance) throw new Error("WebContainer not booted");
    return await webcontainerInstance.fs.readFile(path, 'utf-8');
  }

  async listFiles(dir) {
    if (!webcontainerInstance) throw new Error("WebContainer not booted");
    return await webcontainerInstance.fs.readdir(dir);
  }

  async readDist() {
    if (!webcontainerInstance) throw new Error("WebContainer not booted");
    const results = [];
    
    const walk = async (relDir) => {
      const absDir = relDir ? 'dist/' + relDir : 'dist';
      const entries = await webcontainerInstance.fs.readdir(absDir, { withFileTypes: true });
      for (const entry of entries) {
        const relPath = relDir ? relDir + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
          await walk(relPath);
        } else {
          const content = await webcontainerInstance.fs.readFile('dist/' + relPath);
          let binary = '';
          for (let i = 0; i < content.byteLength; i++) {
            binary += String.fromCharCode(content[i]);
          }
          results.push({ path: relPath, base64: btoa(binary), size: content.byteLength });
        }
      }
    };
    
    try { await walk(''); } catch (e) { console.warn('Could not read dist directory:', e); }
    return results;
  }

  async writeFile(path, content) {
    if (!webcontainerInstance) throw new Error("WebContainer not booted");
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      try { await webcontainerInstance.fs.mkdir(dir); } catch(e) { /* exists */ }
    }
    await webcontainerInstance.fs.writeFile(path, content);
  }

  async readAllSrcFiles() {
    if (!webcontainerInstance) throw new Error("WebContainer not booted");
    const files = {};
    const walk = async (dir) => {
      const entries = await webcontainerInstance.fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const path = dir + '/' + entry.name;
        if (entry.isDirectory()) {
          await walk(path);
        } else {
          try { files[path] = await webcontainerInstance.fs.readFile(path, 'utf-8'); } catch(e) { /* skip binary */ }
        }
      }
    };
    await walk('src');
    return files;
  }

  async restoreFiles(files) {
    await this.writeFiles(files);
  }

  destroy() {
    if (webcontainerInstance) {
      webcontainerInstance.teardown();
      webcontainerInstance = null;
      this._previewUrl = null;
    }
  }

  isBooted() {
    return webcontainerInstance !== null;
  }

  /**
   * Did the built app actually put something on screen?
   *
   * Compiling is not rendering. A component that throws at mount, returns
   * null, or renders an empty wrapper type-checks, bundles, and produces a
   * white page — which the loop has always recorded as a success, because
   * `npm run build` exiting 0 was the entire correctness signal.
   *
   * The answer has to come FROM the preview document (see the reporter in
   * index.html): it is served from a different origin, so nothing out here
   * can read its DOM. This starts the preview, listens for that one message,
   * and gives up quietly if it never arrives.
   *
   * Never throws and never reports "broken" on its own uncertainty. A
   * timeout means we could not tell, and a build that works must not be
   * failed because a preview server was slow — so an unknown answer is
   * treated as fine. The only thing this can do is turn a blank page into a
   * repair round.
   */
  async verifyRender(iframeEl, timeoutMs) {
    let onMsg = null;
    try {
      const started = await this.startPreview(iframeEl);
      if (!started || started.ok === false) return { known: false, reason: "preview did not start" };

      return await new Promise((resolve) => {
        const done = (v) => { if (onMsg) window.removeEventListener("message", onMsg); clearTimeout(timer); resolve(v); };
        const timer = setTimeout(() => done({ known: false, reason: "no report from the preview" }), timeoutMs || 9000);
        onMsg = (e) => {
          const d = e && e.data;
          if (!d || d.source !== "souqi:render") return;
          done({ known: true, empty: !!d.empty, errors: d.errors || [], textLength: d.textLength || 0, nodes: d.nodes || 0, interactive: d.interactive || null });
        };
        window.addEventListener("message", onMsg);
      });
    } catch (e) {
      return { known: false, reason: e && e.message ? e.message : "render check failed" };
    }
  }
}

export { WCRuntime };
