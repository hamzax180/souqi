/* =================================================================
   preflight.ts — the checks a compiler cannot make, made before it runs
   -----------------------------------------------------------------
   The loop's only judge of its own work is the WebContainer compile, and
   a compile answers exactly one question: does this parse and type-check.
   Two of the ways a generated app actually reaches someone broken are
   invisible to it.

   A nav link to a page nobody wrote compiles perfectly. So does a site
   whose every other page is missing — the hrefs are strings, and no
   compiler has an opinion about strings. The user clicks About and gets
   a 404, and the build was green.

   The other half is timing rather than blindness. An import of a file
   the model forgot to write DOES fail the compile — build-parser-client
   calls it "the single most common way a generated app fails to build" —
   but it fails it after npm install and tsc, thirteen seconds of a
   three-minute round, to report something answerable from the file map
   in under a millisecond. The entry guard above it already makes this
   argument and skips the compile for the same reason.

   And on a phone none of it applies: no SharedArrayBuffer means no
   WebContainer, so the srcdoc fallback runs with no compile and no
   diagnostics at all. code.html reports ok:true, verified:false
   whatever it just rendered. A server-side check is the only check that
   path can ever have.

   HARD vs SOFT, and why the distinction is load-bearing:

     hard — the compile is guaranteed to fail, so running it proves
            nothing and costs the round. Skipped, exactly like NO_ENTRY.
     soft — the compile passes and the app is still wrong. It must NOT
            pre-empt the compile (a type error is the more urgent news)
            and must never be the reason a run exhausts its rounds: at
            the cap, a site with one dead nav link is shipped, because
            the alternative there is replacing the whole thing with a
            starter template.

   Deliberately NOT checked: two modules declaring the same top-level
   name. Under Vite those are separate module scopes and legal; only the
   srcdoc flattener ever had a problem with it, and it now renames them
   itself rather than reporting them. Asking the model to fix a name
   collision that is not a defect would spend a round on nothing.
   ================================================================= */

import * as scaffoldFiles from "./scaffold-files";

export interface PreflightError {
  file: string;
  line: number;
  col: number;
  code: "UNRESOLVED_IMPORT" | "PACKAGE_NOT_INSTALLED" | "MISSING_PAGE";
  message: string;
}

export interface PreflightResult {
  hard: PreflightError[];
  soft: PreflightError[];
}

/** Tried in order when an import carries no extension, mirroring Vite. */
const EXTS = [
  ".tsx", ".ts", ".jsx", ".js", ".mjs", ".json", ".css",
  "/index.tsx", "/index.ts", "/index.jsx", "/index.js"
];

/* The whole runtime dependency list, and it is two entries long.

   SYSTEM_PROMPT states it ("ONLY import from 'react' or 'react-dom'")
   and nothing enforced it, so an invented lucide-react import reached
   the container and came back as a Rollup resolve failure — correct, but
   phrased as a module resolution problem rather than "that package is
   not installed and cannot be", which is the fact the model needs. */
export const ALLOWED_PACKAGES = new Set(["react", "react-dom"]);

/** Source files whose imports are worth resolving. */
const CODE_RE = /\.(tsx|ts|jsx|js|mjs)$/;

/* Anchored to the start of a line on purpose. An unanchored `from "..."`
   also matches inside a template literal, a comment, or a sentence in a
   docstring — and a FALSE unresolved-import error is worse than a missed
   one, because it spends a repair round demanding a fix to code that is
   already correct. Real import statements begin their line. */
const FROM_RE = /^[ \t]*(?:import|export)\b[^\n;]*?\bfrom\s*["']([^"']+)["']/gm;
const SIDE_EFFECT_RE = /^[ \t]*import\s*["']([^"']+)["']/gm;
const HREF_RE = /<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi;

/** 1-based line number of an index into a string. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/** Resolve "./a/../b" against the directory of `fromPath`. */
function resolvePath(spec: string, fromPath: string): string {
  const dir = fromPath.indexOf("/") === -1 ? "" : fromPath.replace(/\/[^/]*$/, "");
  const parts = (dir ? dir.split("/") : []).concat(spec.split("/"));
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") { out.pop(); continue; }
    out.push(part);
  }
  return out.join("/");
}

/** Does `spec`, imported from `fromPath`, land on a file that exists? */
function importResolves(spec: string, fromPath: string, known: Set<string>): boolean {
  const base = resolvePath(spec, fromPath);
  if (known.has(base)) return true;
  for (const ext of EXTS) {
    if (known.has(base + ext)) return true;
  }
  return false;
}

/**
 * Check a file tree the way the browser is about to, minus the compiler.
 *
 * `files` is {path: contents} — the model's writes over whatever the
 * project already had. The scaffold is folded in here rather than passed
 * by the caller, because forgetting to pass it is a bug that looks like
 * a real error: src/lib/payments.ts is a file the prompt MANDATES
 * importing and forbids writing, so without it every shop the model
 * builds fails preflight on an import that is entirely correct.
 */
export function preflight(files: Record<string, string> | null | undefined): PreflightResult {
  const tree: Record<string, string> = Object.assign({}, scaffoldFiles.readScaffold(), files || {});
  const known = new Set(Object.keys(tree));
  const scaffoldOwned = new Set(Object.keys(scaffoldFiles.readScaffold()));
  const hard: PreflightError[] = [];
  const soft: PreflightError[] = [];
  const seen = new Set<string>();

  const add = (list: PreflightError[], err: PreflightError): void => {
    const key = err.file + "|" + err.code + "|" + err.message;
    if (seen.has(key)) return;
    seen.add(key);
    list.push(err);
  };

  for (const [path, contents] of Object.entries(tree)) {
    if (typeof contents !== "string") continue;
    /* A defect inside a scaffold file is not the model's to fix — it
       cannot write those paths, PROTECTED_PATHS refuses them. Reporting
       one would be asking for a round it can only fail. */
    if (scaffoldOwned.has(path) && !(files && Object.prototype.hasOwnProperty.call(files, path))) continue;

    if (CODE_RE.test(path)) {
      const specs: Array<[string, number]> = [];
      let m: RegExpExecArray | null;
      FROM_RE.lastIndex = 0;
      while ((m = FROM_RE.exec(contents)) !== null) specs.push([m[1] as string, m.index]);
      SIDE_EFFECT_RE.lastIndex = 0;
      while ((m = SIDE_EFFECT_RE.exec(contents)) !== null) specs.push([m[1] as string, m.index]);

      for (const [spec, at] of specs) {
        const line = lineAt(contents, at);
        if (spec.startsWith(".")) {
          if (!importResolves(spec, path, known)) {
            add(hard, {
              file: path, line: line, col: 1, code: "UNRESOLVED_IMPORT",
              message: 'Cannot resolve "' + spec + '" — that file does not exist. ' +
                "Either write it, or change the import to a file you have written."
            });
          }
          continue;
        }
        if (spec.startsWith("/") || spec.indexOf(":") !== -1) continue;
        // "react-dom/client" and "react/jsx-runtime" are the same package.
        const pkg = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : (spec.split("/")[0] as string);
        if (!ALLOWED_PACKAGES.has(pkg)) {
          add(hard, {
            file: path, line: line, col: 1, code: "PACKAGE_NOT_INSTALLED",
            message: '"' + pkg + '" is not installed and cannot be — the dependency list is ' +
              "fixed at react and react-dom. Use inline SVG, emoji or Tailwind-styled " +
              "elements instead, and remove the import."
          });
        }
      }
    }

    /* Pages, and the links between them. Root-level .html only: that is
       what "write one .html file per page at the project root" produces,
       and a .html under src/ is not a page the router serves. */
    if (/^[^/]+\.html$/.test(path)) {
      let m: RegExpExecArray | null;
      HREF_RE.lastIndex = 0;
      while ((m = HREF_RE.exec(contents)) !== null) {
        let href = (m[1] as string).trim();
        if (!href || href.startsWith("#")) continue;
        if (href.indexOf("://") !== -1) continue;
        if (/^(mailto|tel|javascript|data):/i.test(href)) continue;
        href = (href.split("#")[0] as string).split("?")[0] as string;
        if (!/\.html$/i.test(href)) continue;
        const target = href.replace(/^\//, "");
        if (!known.has(target)) {
          add(soft, {
            file: path, line: lineAt(contents, m.index), col: 1, code: "MISSING_PAGE",
            message: 'The nav links to "' + target + '" and that page was never written. ' +
              "Write it, or drop the link — a menu item that 404s is worse than one that is not there."
          });
        }
      }
    }
  }

  return { hard: hard.slice(0, 10), soft: soft.slice(0, 10) };
}
