/* =================================================================
   scaffold-files.ts — the scaffold as a {path: contents} map
   -----------------------------------------------------------------
   A generated project is the fixed scaffold with the model's files laid
   on top. The model is told not to touch the scaffold's own files —
   model-loop: "Do not write index.html, package.json, vite.config.ts,
   tailwind.config.js, or tsconfig.json — those are fixed and already
   correct" — and PROTECTED_PATHS enforces it. So a revision's file map
   holds only src/**, which is the model's half and not a buildable tree.

   The files come from scaffold-data.json, not from reading the scaffold
   directory, and that is the whole point of this file.

   On Vercel the directory cannot be trusted either way. Excluded in
   .vercelignore, it is absent from the deployment and every deployed app
   ships an index.html pointing at a /src/main.tsx that is not there.
   Included, the function bundler TRANSPILES it: App.tsx becomes App.js
   plus a source map, vite.config.ts becomes vite.config.js — and
   index.html still asks for main.tsx, which is now gone. Both fail, for
   opposite reasons. A .json file is neither compiled nor dropped, and a
   static require() is traced into the bundle.

   Regenerate after changing anything under scaffold/:
     node scripts/build-scaffold-data.js
   ================================================================= */

/* Static require, so the bundler traces it. Do not make this dynamic,
   and do not turn it into an `import` — resolveJsonModule would inline
   280KB of scaffold into the emitted JavaScript instead of leaving it
   as the separate .json file the bundler knows how to trace. */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const DATA = require("./scaffold-data.json") as Record<string, string>;

/** Every scaffold file, keyed by its path relative to the project root. */
export function readScaffold(): Record<string, string> {
  return DATA;
}

/**
 * The complete source tree for a project: scaffold underneath, the
 * model's files on top.
 *
 * The model's half wins on a collision, which matters for src/App.tsx —
 * the scaffold ships a placeholder one and the generated app replaces it.
 * That is the same precedence the WebContainer gets by mounting the
 * scaffold first and writing over it.
 */
export function withScaffold(
  files: Record<string, string> | null | undefined,
  title?: string | null
): Record<string, string> {
  const merged: Record<string, string> = Object.assign({}, DATA);
  for (const [p, content] of Object.entries(files || {})) merged[p] = content;
  return titled(merged, title);
}

/* The scaffold's index.html ships a fixed <title>, so every app anyone
   deployed opened a browser tab called "Souqi Code app" — the builder's
   name on the customer's product, repeated for every tab they had open.

   Only the placeholder is replaced. A static site that wrote its own
   index.html chose that title on purpose, and overwriting it here would
   be this bug again with a different name in it. */
const PLACEHOLDER = "<title>Souqi Code app</title>";

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
}

export function titled(
  files: Record<string, string>,
  title?: string | null
): Record<string, string> {
  const name = String(title || "").trim();
  const html = files["index.html"];
  if (!name || typeof html !== "string" || html.indexOf(PLACEHOLDER) < 0) return files;
  files["index.html"] = html.replace(PLACEHOLDER, "<title>" + escapeHtml(name) + "</title>");
  return files;
}
