/* =================================================================
   inline-modules.js — flatten a small ES module graph into one script
   -----------------------------------------------------------------
   The builder previews an app one of two ways. On a cross-origin
   isolated desktop it boots a WebContainer and runs the real Vite dev
   server, which handles any number of files. Everywhere else — every
   phone, and any browser without SharedArrayBuffer — it falls back to
   rendering into an iframe srcdoc with React and Babel from a CDN.

   That fallback used to inline src/App.tsx and nothing else, which is
   fine for a single-file app and useless for anything the model
   actually generates: a photography portfolio arrives as App.tsx plus
   six components. Its import statements survived into a plain inline
   <script>, and one surviving import is a hard parse error — "Cannot
   use import statement outside a module" — so nothing rendered at all.

   This walks the local import graph and concatenates every reachable
   module into one script, dependencies first. It is deliberately NOT a
   general bundler: it handles the shapes a React component file takes
   and reports what it could not do rather than guessing.

   Not supported, on purpose, and reported in `warnings`:
     - circular imports (the cycle is broken, order may be wrong)
     - `export * from`, namespace imports, dynamic import()

   Repaired rather than reported, and listed in `renamed`:
     - two modules declaring the same top-level name. This used to be a
       warning saying "the later one wins", which was never true: one
       scope, two consts, SyntaxError, nothing renders. See renameTopLevel.
   ================================================================= */
"use strict";

/** Extensions tried when an import has none, in resolution order. */
const EXTS = [".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"];

/** Normalise "src/a/../b" to "src/b" so keys match `files`. */
function normalize(p) {
  const out = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/**
 * Resolve a relative specifier against the importing file's directory.
 * Returns the matching key in `files`, or null when nothing matches —
 * a missing file is reported, never silently treated as empty.
 */
function resolve(spec, fromPath, files) {
  const dir = fromPath.indexOf("/") === -1 ? "" : fromPath.replace(/\/[^/]*$/, "");
  const base = normalize((dir ? dir + "/" : "") + spec);
  if (files[base] != null) return base;
  for (const ext of EXTS) {
    if (files[base + ext] != null) return base + ext;
  }
  return null;
}

/** Every top-level binding a module introduces, so collisions are visible. */
function declaredNames(code) {
  const names = new Set();
  const re = /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(code))) names.add(m[1]);
  return names;
}

/**
 * Rename one top-level identifier throughout a single module's source.
 *
 * Everything lands in one shared scope, so two modules that both declare
 * `const toneClasses` produce `Identifier 'toneClasses' has already been
 * declared` — a hard parse error, which in the preview is a black frame with
 * a stack trace printed over it. Not hypothetical: an 18-file barber booking
 * app failed exactly this way, two step components each keeping their own
 * little tone map.
 *
 * Scanned rather than regexed, because a blind replace corrupts the places an
 * identifier-shaped run of characters is not a reference to that binding:
 * inside a string, inside a comment, after a dot, or as an object key.
 */
/**
 * Index of the `}` that closes the `${` opening at `openIdx`.
 *
 * Braces are counted, and quotes and nested templates are stepped over
 * whole so that a `}` sitting in text cannot close the expression early.
 * An unterminated one returns the end of the source, which renames what
 * is there rather than dropping the tail.
 */
function endOfInterpolation(code, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < code.length) {
    const c = code[i];
    if (c === "\\") { i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < code.length) {
        if (code[i] === "\\") { i += 2; continue; }
        if (code[i] === quote) { i++; break; }
        // A template inside the expression may interpolate again.
        if (quote === "`" && code[i] === "$" && code[i + 1] === "{") {
          i = endOfInterpolation(code, i + 1) + 1;
          continue;
        }
        i++;
      }
      continue;
    }
    if (c === "{") { depth++; i++; continue; }
    if (c === "}") { depth--; if (!depth) return i; i++; continue; }
    i++;
  }
  return code.length;
}

function renameTopLevel(code, from, to) {
  const isWord = (ch) => /[\w$]/.test(ch);
  const NL = String.fromCharCode(10);
  let out = "";
  let i = 0;
  while (i < code.length) {
    const ch = code[i];

    // quoted strings: copied through untouched
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ch;
      i++;
      while (i < code.length) {
        if (code[i] === "\\") { out += code.slice(i, i + 2); i += 2; continue; }
        out += code[i];
        if (code[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }

    /* Template literals: the text is left alone, but `${...}` is code and
       has to be renamed like any other.

       It used to be copied through whole, with the quoted strings. So a
       component that declared `const me` and read it back inside a
       template kept the reference while the declaration was renamed
       around it, and the bundle threw "me is not defined" on the first
       render — a black preview with nothing in #root. Found in a Facebook
       clone whose composer said `${me.name.split(' ')[0]}`, where four
       components each had their own `me` and three of them were renamed. */
    if (ch === "`") {
      out += ch;
      i++;
      while (i < code.length) {
        if (code[i] === "\\") { out += code.slice(i, i + 2); i += 2; continue; }
        if (code[i] === "`") { out += code[i]; i++; break; }
        if (code[i] === "$" && code[i + 1] === "{") {
          const end = endOfInterpolation(code, i + 1);
          // Recursive, so a template nested inside an interpolation works too.
          out += "${" + renameTopLevel(code.slice(i + 2, end), from, to) + "}";
          i = end + 1;
          continue;
        }
        out += code[i];
        i++;
      }
      continue;
    }

    // comments: likewise
    if (ch === "/" && code[i + 1] === "/") {
      const nlAt = code.indexOf(NL, i);
      const end = nlAt === -1 ? code.length : nlAt;
      out += code.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      const close = code.indexOf("*/", i + 2);
      const end = close === -1 ? code.length : close + 2;
      out += code.slice(i, end);
      i = end;
      continue;
    }

    if (isWord(ch)) {
      let j = i;
      while (j < code.length && isWord(code[j])) j++;
      const word = code.slice(i, j);
      const prev = code.slice(0, i).replace(/\s+$/, "").slice(-1);
      let k = j;
      while (k < code.length && /\s/.test(code[k])) k++;
      const isProperty = prev === ".";
      // `{ toneClasses: x }` is a key. `cond ? toneClasses : y` is not.
      const isObjectKey = code[k] === ":" && prev !== "?";
      out += (word === from && !isProperty && !isObjectKey) ? to : word;
      i = j;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * One module's source, rewritten to live in a shared top-level scope.
 *
 * `defaultName` comes back so the importer can bind its own local name
 * to it. React and lucide imports are not rewritten here — their names
 * are collected and emitted once in the prelude, because a per-module
 * `const { useState } = React` in every file is a redeclaration error
 * the moment there is more than one file.
 */
function transformModule(src, path, index, ctx) {
  let code = src;
  const localBindings = [];   // { local, from } — resolved after all modules are in

  // ---- type-only imports vanish; they have no runtime meaning ----
  code = code.replace(/import\s+type\s+[\s\S]*?from\s+['"][^'"]*['"];?/g, "");

  // ---- react ----
  code = code.replace(
    /import\s+(?:React\s*,?\s*)?(\{[\s\S]*?\})?\s*from\s+['"]react['"];?/g,
    (m, named) => {
      if (named) {
        named.replace(/[{}]/g, "").split(",").forEach((n) => {
          const t = n.trim().split(/\s+as\s+/)[0].trim();
          if (t) ctx.reactNames.add(t);
        });
      }
      return "";
    }
  );

  // ---- lucide-react ----
  code = code.replace(/import\s+\{([^}]*)\}\s+from\s+['"]lucide-react['"];?/g, (m, icons) => {
    icons.split(",").forEach((n) => {
      const t = n.trim().split(/\s+as\s+/)[0].trim();
      if (t) ctx.lucideNames.add(t);
    });
    return "";
  });

  // ---- local imports: recorded, then erased. The module they name is
  //      inlined above this one, so its bindings are already in scope. ----
  code = code.replace(/import\s+([\s\S]*?)\s+from\s+['"](\.[^'"]*)['"];?/g, (m, clause, spec) => {
    const target = resolve(spec, path, ctx.files);
    if (!target) {
      ctx.warnings.push(path + ': cannot resolve "' + spec + '" — its bindings will be undefined');
      return "";
    }
    const c = clause.trim();
    if (/^\*\s+as\s+/.test(c)) {
      ctx.warnings.push(path + ": namespace import of " + spec + " is not supported");
      return "";
    }
    // default import, with or without a named list beside it
    const def = c.match(/^([A-Za-z_$][\w$]*)\s*(?:,\s*\{([\s\S]*)\})?$/);
    if (def) {
      localBindings.push({ local: def[1], target: target, kind: "default" });
      if (def[2]) aliasNamed(def[2], localBindings, target);
      return "";
    }
    const only = c.match(/^\{([\s\S]*)\}$/);
    if (only) { aliasNamed(only[1], localBindings, target); return ""; }
    return "";
  });

  // ---- side-effect imports of local files (e.g. "./index.css") ----
  code = code.replace(/import\s+['"][^'"]*['"];?/g, "");

  // ---- remaining bare-package imports cannot be satisfied ----
  code = code.replace(/import\s+([\s\S]*?)\s+from\s+['"]([^.'"][^'"]*)['"];?/g, (m, clause, pkg) => {
    ctx.warnings.push(path + ": dropped import from \"" + pkg + "\" — not available in the CDN preview");
    return "";
  });

  // ---- exports ----
  let defaultName = null;

  // export default function Name / class Name  -> keep the declaration
  code = code.replace(
    /export\s+default\s+(async\s+)?(function|class)\s+([A-Za-z_$][\w$]*)/,
    (m, asy, kind, name) => { defaultName = name; return (asy || "") + kind + " " + name; }
  );

  if (!defaultName) {
    // export default <anything else> -> bind it to a synthetic name
    const synth = "__mod" + index + "_default";
    const before = code;
    code = code.replace(/export\s+default\s+/, "const " + synth + " = ");
    if (code !== before) defaultName = synth;
  }

  // `export default Name;` above became `const __modN_default = Name;`,
  // which is correct and needs nothing further.

  // Strip the `export` keyword from every declaration form, including the
  // TypeScript-only ones. Missing those was a real failure in production:
  // a generated src/data.ts carried `export interface` and `export type`,
  // and since this output is evaluated as a SCRIPT, one surviving export
  // is "Unexpected token 'export'" and the whole preview goes blank.
  // Babel's typescript preset would erase them happily — but only after
  // parsing, and it cannot parse an export in a script.
  code = code.replace(
    /export\s+(?=(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\b)/g,
    ""
  );
  // `export { a, b }` and `export type { a }`. Type-only re-exports have
  // no runtime meaning at all, so both simply go.
  code = code.replace(/export\s+type\s*\{[^}]*\}\s*;?/g, "");
  code = code.replace(/export\s*\{[^}]*\}\s*;?/g, "");
  code = code.replace(/export\s+\*\s+from\s+['"][^'"]*['"];?/g, (m) => {
    ctx.warnings.push(path + ": `export * from` is not supported");
    return "";
  });

  return { code: code, defaultName: defaultName, localBindings: localBindings };
}

/**
 * `A, B as C` -> binding entries.
 *
 * A plain name used to record nothing, on the reasoning that the
 * declaration is already in scope under that very name so there is
 * nothing to bind. True right up until the declaration gets RENAMED:
 * two modules both exporting `pulse` means the second becomes `pulse$1`,
 * and an importer that said `import { pulse } from './Finger'` was left
 * pointing at the FIRST module's pulse — a different object, silently,
 * with no error until something read a property off it. Plain names are
 * recorded now so that rename can find them.
 */
function aliasNamed(inner, out, target) {
  inner.split(",").forEach((n) => {
    const parts = n.trim().split(/\s+as\s+/);
    if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
      out.push({ local: parts[1].trim(), source: parts[0].trim(), kind: "alias", target: target });
    } else {
      const only = n.trim();
      if (only) out.push({ local: only, source: only, kind: "named", target: target });
    }
  });
}

/**
 * Flatten the graph reachable from `entry`.
 *
 * @param {string} entry  key into `files`, e.g. "src/App.tsx"
 * @param {Object<string,string>} files  every file the build produced
 * @returns {{code:string, modules:string[], warnings:string[]}}
 */
export function inlineModules(entry, files) {
  const ctx = {
    renamed: [],
    files: files,
    reactNames: new Set(),
    lucideNames: new Set(),
    warnings: []
  };

  const state = new Map();     // path -> "visiting" | "done"
  const pieces = [];
  const order = [];
  const defaults = new Map();  // path -> the name holding its default export
  const pending = [];          // { local, target, kind } to bind after everything is in
  const seenNames = new Set();
  // path -> Map(original export name -> the name it ended up with), so an
  // importer can be pointed at the rename instead of silently resolving to
  // whichever other module declared that word first.
  const renames = new Map();
  let index = 0;

  function visit(path) {
    const s = state.get(path);
    if (s === "done") return;
    if (s === "visiting") {
      ctx.warnings.push("circular import involving " + path + " — module order may be wrong");
      return;
    }
    state.set(path, "visiting");

    const src = files[path];
    if (src == null) {
      ctx.warnings.push("missing file: " + path);
      state.set(path, "done");
      return;
    }

    // Dependencies first, so a component is defined before it is used.
    const deps = [];
    const re = /import\s+[\s\S]*?from\s+['"](\.[^'"]*)['"];?/g;
    let m;
    while ((m = re.exec(src))) {
      const t = resolve(m[1], path, files);
      if (t) deps.push(t);
    }
    deps.forEach(visit);

    const out = transformModule(src, path, index++, ctx);
    defaults.set(path, out.defaultName);

    /* Deps are visited before their importers, so by the time this module
       is transformed every module it imports from has already been through
       the collision rename below. Point this module's references at the
       names those modules actually ended up using. */
    out.localBindings.forEach((b) => {
      if (!b.target) return;
      const map = renames.get(b.target);
      const to = map && map.get(b.source);
      if (!to) return;
      if (b.kind === "named") {
        out.code = renameTopLevel(out.code, b.local, to);
        b.local = to;
      }
      b.source = to;          // an `as` alias binds to the new name instead
    });

    /* "the later one wins" was never true. Two const declarations in one
       scope is a SyntaxError, not a shadow — the whole bundle fails to
       parse, so neither one wins and the preview renders nothing at all.
       Rename the later one instead of narrating the collision. */
    declaredNames(out.code).forEach((n) => {
      if (seenNames.has(n)) {
        let renamed = n + "$" + (index - 1);
        while (seenNames.has(renamed)) renamed += "_";
        out.code = renameTopLevel(out.code, n, renamed);
        if (out.defaultName === n) { out.defaultName = renamed; defaults.set(path, renamed); }
        out.localBindings.forEach((b) => { if (b.local === n) b.local = renamed; });
        /* So an importer of THIS module can be pointed at the new name —
           see the rewrite above. Keyed by module, because two modules
           renaming the same word rename it to different things. */
        if (!renames.has(path)) renames.set(path, new Map());
        renames.get(path).set(n, renamed);
        ctx.renamed.push(path + ': "' + n + '" renamed to "' + renamed + '" - already declared elsewhere');
        seenNames.add(renamed);
        return;
      }
      seenNames.add(n);
    });

    out.localBindings.forEach((b) => pending.push(b));
    pieces.push("/* ---- " + path + " ---- */\n" + out.code.trim());
    order.push(path);
    state.set(path, "done");
  }

  visit(entry);

  // Bind each default import to whatever name its module ended up using.
  // Skipped when the names already match — the module declared `function
  // Header` and the importer called it `Header`, so re-declaring it would
  // be a redeclaration error rather than a binding.
  const aliases = [];
  pending.forEach((b) => {
    if (b.kind === "default") {
      const dn = defaults.get(b.target);
      if (!dn) {
        ctx.warnings.push(b.target + " has no default export, but " + b.local + " imports one");
      } else if (dn !== b.local && !seenNames.has(b.local)) {
        aliases.push("const " + b.local + " = " + dn + ";");
        seenNames.add(b.local);
      }
    } else if (b.kind === "alias" && !seenNames.has(b.local)) {
      aliases.push("const " + b.local + " = " + b.source + ";");
      seenNames.add(b.local);
    }
  });

  const prelude = [];
  if (ctx.reactNames.size) {
    prelude.push("const { " + Array.from(ctx.reactNames).join(", ") + " } = React;");
  }
  if (ctx.lucideNames.size) {
    prelude.push(
      "const { " + Array.from(ctx.lucideNames).join(", ") +
      " } = window.LucideReact || window.lucide || {};"
    );
  }

  return {
    code: prelude.concat(pieces, aliases).join("\n\n"),
    modules: order,
    warnings: ctx.warnings,
    renamed: ctx.renamed
  };
}

export default inlineModules;
