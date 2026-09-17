/* =================================================================
   context/file-retrieval.ts — which files, and are they still true
   -----------------------------------------------------------------
   buildCodebaseContext already renders a file map into a budgeted
   block, and it is not replaced here — it does the hard part, which
   is deciding what to include whole, what to excerpt, and what to
   list in the manifest. What it does not do is say WHY a file was
   included, or notice that the copy in the request is stale.

   Staleness is the one that actually bites. The candidate tree is in
   memory and the model edits it as it goes, so a file read on turn
   two and summarised on turn nine is being remembered at a version
   that no longer exists. Every selection carries the content hash it
   was taken at, and a later turn can ask which of its memories have
   moved on rather than assuming none of them have.

   Ranking is cheap and deliberately explainable. There is no vector
   database here and there does not need to be: a generated app is a
   few dozen files, the prompt usually names the ones it means, and a
   reason a person can read ("named in the request") is worth more
   than a similarity score nobody can argue with.
   ================================================================= */

import * as crypto from "crypto";

export type InclusionReason =
  | "named in the request"
  | "edited this run"
  | "imported by a file being changed"
  | "the entry point"
  | "recently read"
  | "fills the remaining budget";

export interface Selection {
  path: string;
  /** sha256 of the content at selection time, first 16 hex. */
  hash: string;
  bytes: number;
  reason: InclusionReason;
  /** Higher is more relevant. Only meaningful within one selection. */
  score: number;
}

export interface SelectOpts {
  prompt?: string;
  /** Paths this run has written or edited. */
  touched?: string[];
  /** Paths the model has read this run. */
  read?: string[];
  /** Stop selecting once the running total passes this many bytes. */
  budgetBytes?: number;
  /** Never select more than this many files. */
  maxFiles?: number;
}

export function hashOf(content: string): string {
  return crypto.createHash("sha256").update(String(content ?? ""), "utf8").digest("hex").slice(0, 16);
}

/** Every path in `files`, with its current hash. */
export function hashAll(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, c] of Object.entries(files || {})) out[p] = hashOf(c);
  return out;
}

const ENTRY_POINTS = ["src/App.tsx", "index.html"];

/* Relative imports only. A bare specifier is react or react-dom — the
   dependency list is two entries long (see preflight) — and neither is
   a file in this tree. */
const IMPORT_RE = /^[ \t]*(?:import|export)\b[^\n;]*?\bfrom\s*["'](\.[^"']+)["']/gm;

function importsOf(content: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(content)) !== null) out.push(m[1] as string);
  return out;
}

/** Resolve "./Hero" from "src/App.tsx" onto a real key in `files`. */
function resolveImport(spec: string, from: string, files: Record<string, string>): string | null {
  const dir = from.indexOf("/") === -1 ? "" : from.replace(/\/[^/]*$/, "");
  const parts = (dir ? dir.split("/") : []).concat(spec.split("/"));
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") { stack.pop(); continue; }
    stack.push(part);
  }
  const base = stack.join("/");
  if (files[base] !== undefined) return base;
  for (const ext of [".tsx", ".ts", ".jsx", ".js", ".css", "/index.tsx", "/index.ts"]) {
    if (files[base + ext] !== undefined) return base + ext;
  }
  return null;
}

/**
 * Rank the tree against this turn and take the top of it.
 *
 * The scores are arbitrary in magnitude and meaningful only in order;
 * what matters is that every one of them has a reason attached that
 * says, in words, why the file is in the request.
 */
export function select(files: Record<string, string>, opts: SelectOpts = {}): Selection[] {
  const prompt = String(opts.prompt || "").toLowerCase();
  const touched = new Set(opts.touched || []);
  const read = new Set(opts.read || []);
  const maxFiles = Number(opts.maxFiles) || 40;
  const budgetBytes = Number(opts.budgetBytes) || Infinity;

  // Files reachable in one hop from something being changed.
  const adjacent = new Set<string>();
  for (const p of touched) {
    const content = files[p];
    if (typeof content !== "string") continue;
    for (const spec of importsOf(content)) {
      const hit = resolveImport(spec, p, files);
      if (hit && !touched.has(hit)) adjacent.add(hit);
    }
  }

  const scored: Selection[] = [];
  for (const [path, content] of Object.entries(files || {})) {
    if (typeof content !== "string") continue;

    let score = 0;
    let reason: InclusionReason = "fills the remaining budget";

    /* The filename, and the component name without its extension — a
       request saying "make the hero taller" names src/Hero.tsx without
       ever writing the path. */
    const base = (path.split("/").pop() || "").replace(/\.[^.]+$/, "").toLowerCase();
    if (prompt && (prompt.includes(path.toLowerCase()) || (base.length > 2 && prompt.includes(base)))) {
      score += 100; reason = "named in the request";
    }
    if (touched.has(path)) {
      if (score < 80) reason = "edited this run";
      score += 80;
    }
    if (adjacent.has(path)) {
      if (score < 40) reason = "imported by a file being changed";
      score += 40;
    }
    if (ENTRY_POINTS.includes(path)) {
      if (score < 30) reason = "the entry point";
      score += 30;
    }
    if (read.has(path)) {
      if (score < 10) reason = "recently read";
      score += 10;
    }

    /* A small tie-break toward small files: two equally relevant files
       and only room for one, take the one that leaves room for another. */
    score += Math.max(0, 5 - content.length / 4000);

    scored.push({ path, hash: hashOf(content), bytes: content.length, reason, score });
  }

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const out: Selection[] = [];
  let used = 0;
  for (const s of scored) {
    if (out.length >= maxFiles) break;
    if (used + s.bytes > budgetBytes && out.length) break;
    out.push(s);
    used += s.bytes;
  }
  return out;
}

export interface StaleEntry {
  path: string;
  was: string;
  now: string | null;
}

/**
 * Which of these selections no longer describe the tree.
 *
 * `now: null` means the file is gone, which is a different problem from
 * a file that changed and is worth telling apart at the call site.
 */
export function stale(selections: Selection[], files: Record<string, string>): StaleEntry[] {
  const out: StaleEntry[] = [];
  for (const s of selections || []) {
    const content = files[s.path];
    if (content === undefined) { out.push({ path: s.path, was: s.hash, now: null }); continue; }
    const now = hashOf(content);
    if (now !== s.hash) out.push({ path: s.path, was: s.hash, now });
  }
  return out;
}

/** A line per selection, for the request. Says why, and at what version. */
export function manifest(selections: Selection[]): string {
  if (!selections.length) return "";
  return "Files selected for this turn:\n" +
    selections.map((s) => "  " + s.path + "  [" + s.hash + "]  — " + s.reason).join("\n");
}
