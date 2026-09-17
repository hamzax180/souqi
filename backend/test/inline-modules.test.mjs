/* Run: node backend/test/inline-modules.test.mjs
   No framework on purpose — it mirrors deploy/scripts/verify*.js, which
   assert what the code WOULD do rather than needing a browser. */
import assert from "node:assert";
const NEWLINE = String.fromCharCode(10);
import { readFileSync } from "node:fs";
import { inlineModules } from "../../frontend/js/codeagent/inline-modules.js";

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log("  ok   " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); fail++; }
}

// The exact shape the model generates: an App importing six components.
const files = {
  "src/App.tsx": [
    'import React, { useState } from "react";',
    'import Header from "./components/Header";',
    'import Hero from "./components/Hero";',
    'import { formatDate } from "./lib/date";',
    'import "./index.css";',
    'export default function App() {',
    '  return <div><Header /><Hero /></div>;',
    '}'
  ].join("\n"),
  "src/components/Header.tsx": [
    'import { Camera } from "lucide-react";',
    'export default function Header() { return <h1><Camera /></h1>; }'
  ].join("\n"),
  "src/components/Hero.tsx": [
    'import React from "react";',
    'const Hero = () => <section>hero</section>;',
    'export default Hero;'
  ].join("\n"),
  "src/lib/date.ts": 'export function formatDate(d) { return String(d); }',
  "src/index.css": "body{}"
};

const r = inlineModules("src/App.tsx", files);

check("no import statement survives", () =>
  assert.ok(!/(^|\n)\s*import\s/.test(r.code), "an import survived:\n" + r.code));

check("no export statement survives", () =>
  assert.ok(!/(^|\n)\s*export\s/.test(r.code), "an export survived"));

check("every reachable module is included", () => {
  ["src/lib/date.ts", "src/components/Header.tsx", "src/components/Hero.tsx", "src/App.tsx"]
    .forEach((m) => assert.ok(r.modules.includes(m), "missing " + m));
});

check("dependencies come before the module that uses them", () => {
  assert.ok(r.modules.indexOf("src/components/Header.tsx") < r.modules.indexOf("src/App.tsx"));
  assert.ok(r.modules.indexOf("src/lib/date.ts") < r.modules.indexOf("src/App.tsx"));
});

check("react hooks are destructured exactly once", () => {
  const n = (r.code.match(/=\s*React;/g) || []).length;
  assert.strictEqual(n, 1, "expected 1 React destructure, got " + n);
  assert.ok(/useState/.test(r.code), "useState was not collected");
});

check("lucide icons are collected from a nested module", () =>
  assert.ok(/const \{ Camera \} = window\.LucideReact/.test(r.code), r.code.slice(0, 200)));

check("a matching default name is NOT re-declared", () => {
  // Header.tsx declares `function Header`; App imports it as `Header`.
  // Emitting `const Header = ...` too would be a SyntaxError.
  assert.strictEqual((r.code.match(/\bconst Header\b/g) || []).length, 0);
  assert.ok(/function Header\b/.test(r.code));
});

check("an arrow default export is bound and reachable", () => {
  assert.ok(/const Hero = \(\) =>/.test(r.code), "Hero declaration missing");
});

check("the output is valid JS once JSX is compiled away", () => {
  const plain = r.code.replace(/<[^>]*\/>/g, "null").replace(/<(\w+)>[\s\S]*?<\/\1>/g, "null");
  new Function(plain.replace(/\bReact\b/g, "({})").replace(/window\./g, "globalThis."));
});

check("a missing file is reported, not silently empty", () => {
  const r2 = inlineModules("src/App.tsx", { "src/App.tsx": 'import X from "./nope";\nexport default function App(){}' });
  assert.ok(r2.warnings.some((w) => /cannot resolve/.test(w)), JSON.stringify(r2.warnings));
});

check("a circular import is broken and reported", () => {
  const r3 = inlineModules("src/a.tsx", {
    "src/a.tsx": 'import B from "./b";\nexport default function A(){}',
    "src/b.tsx": 'import A from "./a";\nexport default function B(){}'
  });
  assert.ok(r3.warnings.some((w) => /circular/.test(w)), JSON.stringify(r3.warnings));
});

/* This used to assert a WARNING and leave the collision in place, which was
   the wrong contract. Everything lands in one scope, so two `const styles`
   is "Identifier 'styles' has already been declared": the whole bundle fails
   to parse and the preview is a black frame with a stack trace over it.
   Neither one wins, which is what "the later one wins" got wrong.

   Found in production on an 18-file barber booking app — two step components
   each keeping their own tone map. The build passed clean and the preview
   never rendered. */
check("a duplicate top-level name is renamed, not just warned about", () => {
  const r4 = inlineModules("src/App.tsx", {
    "src/App.tsx": [
      'import H from "./h";',
      "const styles = 1;",
      "export default function App(){ return styles; }"
    ].join(NEWLINE),
    "src/h.tsx": [
      "const styles = 2;",
      "export default function H(){ return styles; }"
    ].join(NEWLINE)
  });
  const decls = r4.code.match(/const\s+styles[\w$]*/g) || [];
  assert.strictEqual(new Set(decls).size, decls.length,
    "two modules still declare the same name: " + JSON.stringify(decls));
  assert.ok(r4.renamed.length >= 1,
    "the rename was not reported: " + JSON.stringify(r4.renamed));
});

/* The rename has to be a rename, not a find-and-replace. An identifier-shaped
   run of characters is not a reference to the binding when it sits inside a
   string, inside a comment, after a dot, or as an object key. */
check("renaming leaves strings, properties and keys alone", () => {
  const r = inlineModules("src/App.tsx", {
    "src/App.tsx": [
      'import H from "./h";',
      "const tone = 1;",
      "export default function App(){ return tone; }"
    ].join(NEWLINE),
    "src/h.tsx": [
      "const tone = { a: 1 };",
      'const label = "tone";',
      "const viaProp = theme.tone;",
      "const obj = { tone: 5 };",
      "export default function H(){ return tone.a + label + viaProp + obj.tone; }"
    ].join(NEWLINE)
  });
  assert.ok(/const\s+tone\$\d/.test(r.code), "the colliding declaration was not renamed");
  assert.ok(/=\s*"tone"/.test(r.code), "a string literal was rewritten");
  assert.ok(/theme\.tone\b/.test(r.code), "a property access was rewritten");
  assert.ok(/\{\s*tone:\s*5\s*\}/.test(r.code), "an object key was rewritten");
});

/* A template literal's text is a string; its `${...}` is code. Copying the
   whole thing through left the reference behind while the declaration moved,
   and the bundle threw "me is not defined" on first render — a black preview
   with an empty #root. A Facebook clone whose composer read
   `${me.name.split(' ')[0]}`, four components each with their own `me`. */
check("an identifier inside a template interpolation is renamed with its declaration", () => {
  /* Dependencies are emitted first, so the DEP keeps the name and the
     entry is the one renamed — the template has to live in the entry. */
  const r = inlineModules("src/App.tsx", {
    "src/c.tsx": [
      "const me = { name: 'dep' };",
      "export default function C(){ return me.name; }"
    ].join(NEWLINE),
    "src/App.tsx": [
      'import C from "./c";',
      "const me = { name: 'entry' };",
      "const greet = `hi ${me.name.split(' ')[0]}, ${`deep ${me.name}`}`;",
      'const plain = "hi ${me.name}";',
      "export default function App(){ return greet + plain + me.name + C(); }"
    ].join(NEWLINE)
  });
  const renamed = (/const\s+(me\$\w+)\s*=\s*\{\s*name:\s*'entry'/.exec(r.code) || [])[1];
  assert.ok(renamed, "the colliding declaration was not renamed");
  assert.ok(r.code.includes("`hi ${" + renamed + ".name.split(' ')[0]}"),
    "an interpolation kept the old name");
  assert.ok(r.code.includes("`deep ${" + renamed + ".name}`"),
    "a template nested inside an interpolation kept the old name");
  assert.ok(/=\s*"hi \$\{me\.name\}"/.test(r.code),
    "a quoted string that merely looks like an interpolation was rewritten");
  assert.ok(/return greet \+ plain \+ me\$\w+\.name/.test(r.code),
    "an ordinary reference in the renamed module kept the old name");
});

// Found in production: a generated src/data.ts carried `export interface`
// and `export type`. The strip rule only covered function/class/const/let/
// var, so those survived — and because this output is evaluated as a
// SCRIPT, one surviving export is "Unexpected token 'export'" and the
// whole preview goes blank. Babel's typescript preset would erase them,
// but only after parsing, and it cannot parse an export in a script.
check("every TypeScript export form is stripped", () => {
  const r5 = inlineModules("src/App.tsx", {
    "src/App.tsx": 'import { photos } from "./data";\nexport default function App(){ return null; }',
    "src/data.ts": [
      'export interface Photo { id: string; url: string; }',
      'export type Category = "portrait" | "landscape";',
      'export enum Size { S, M }',
      'export type { Photo as P };',
      'export const photos: Photo[] = [];',
      'export abstract class Base {}',
      'export declare const x: number;'
    ].join("\n")
  });
  const left = r5.code.split("\n").filter((l) => /^\s*(export|import)\b/.test(l));
  assert.strictEqual(left.length, 0, "survived:\n" + left.join("\n"));
});

check("type-only imports are removed", () => {
  const r6 = inlineModules("src/App.tsx", {
    "src/App.tsx": 'import type { Photo } from "./data";\nimport { photos } from "./data";\nexport default function App(){ return null; }',
    "src/data.ts": 'export const photos = [];'
  });
  assert.ok(!/(^|\n)\s*import\s/.test(r6.code), "an import survived");
});

// The regex source itself, because the bug that shipped was an invisible
// backspace where \b belonged — the pattern parsed fine and silently
// matched nothing. Only a behavioural test catches that, but asserting the
// file is free of control characters catches the whole class.
check("no stray control characters in the source", () => {
  const src = readFileSync(new URL("../../frontend/js/codeagent/inline-modules.js", import.meta.url), "utf8");
  const bad = [...src].filter((c) => c.charCodeAt(0) < 32 && !"\n\r\t".includes(c));
  assert.strictEqual(bad.length, 0, "found " + bad.length + " control char(s)");
});

console.log("\n  " + (fail ? "FAILED " + fail + " of " + (pass + fail) : "all " + pass + " checks passed"));
process.exit(fail ? 1 : 0);
