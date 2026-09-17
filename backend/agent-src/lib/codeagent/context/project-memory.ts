/* =================================================================
   context/project-memory.ts — what this project has been told
   -----------------------------------------------------------------
   memory.ts already keeps what a project has got WRONG: structural
   failure kinds, counted rather than listed, and its header argues
   well for why that is almost nothing. This is the other half — what
   the project has been TOLD — and it is a different kind of fact with
   a different failure mode.

   A lesson is derived from a compiler error and is therefore true. A
   rule comes from a sentence, and the sentence was either the user's
   or the model's guess about the user's. Those two must not be stored
   the same way, because a model note that hardens into a rule is how
   a project acquires a constraint nobody ever asked for and everyone
   later obeys. So every entry carries its provenance, and the block
   that goes into the prompt says which is which in words the model
   reads: the user's are requirements, the model's are observations it
   is free to revise.

   Three further rules, each of which is a way this goes wrong:

     - a user rule always beats a model note on the same subject, and
       adding the user's version removes the model's.
     - nothing is stored before it goes through redact(). A rule is
       durable by definition, and "the API key is sk-..." is exactly
       the shape of sentence someone types into a chat box.
     - entries expire. A preference stated twelve builds ago about a
       page that no longer exists is not a requirement, it is noise
       with a timestamp.
   ================================================================= */

import { redact } from "./redact";

export type RuleSource = "user" | "model";

export interface Rule {
  id: string;
  text: string;
  source: RuleSource;
  /** ISO. Used for expiry and for ordering within a source. */
  at: string;
  /** How many times this has been restated. Restating refreshes `at`. */
  hits: number;
}

export interface ProjectRules {
  rules: Rule[];
}

/* Small caps, and for the same reason memory.ts caps lessons at six:
   this is injected into every later turn, and a list long enough to
   skim is a list the model skims. The user gets more room than the
   model because the user's are requirements. */
export const MAX_USER_RULES = 8;
export const MAX_MODEL_RULES = 4;

/** A model note older than this stops being carried. A user rule does
    not expire on a timer — only on being contradicted or removed. */
export const MODEL_NOTE_TTL_MS = 1000 * 60 * 60 * 24 * 14;

export const MAX_RULE_CHARS = 240;

function keyOf(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

function clean(text: unknown): string {
  return redact(String(text ?? "").replace(/\s+/g, " ").trim()).text.slice(0, MAX_RULE_CHARS);
}

export interface RememberInput {
  text: string;
  source: RuleSource;
  at?: string;
}

/**
 * Fold new rules into what the project already knew.
 *
 * Pure: returns a new object and never mutates the one passed in, so a
 * caller that fails to persist it has changed nothing. Returns null
 * when there is nothing worth storing, which keeps a project that has
 * never been told anything free of an empty field.
 */
export function remember(
  existing: ProjectRules | null | undefined,
  incoming: RememberInput[] | null | undefined,
  now: number = Date.now()
): ProjectRules | null {
  const prior: Rule[] = (existing && Array.isArray(existing.rules) ? existing.rules : [])
    .map((r) => ({
      id: String(r.id || keyOf(String(r.text || ""))),
      text: clean(r.text),
      source: (r.source === "user" ? "user" : "model") as RuleSource,
      at: r.at || new Date(now).toISOString(),
      hits: Number(r.hits) || 1
    }))
    .filter((r) => r.text);

  const byKey = new Map<string, Rule>();
  for (const r of prior) byKey.set(r.id, r);

  let changed = false;
  for (const item of incoming || []) {
    const text = clean(item && item.text);
    if (!text) continue;
    const source: RuleSource = item.source === "user" ? "user" : "model";
    const id = keyOf(text);
    if (!id) continue;

    const hit = byKey.get(id);
    if (hit) {
      hit.hits += 1;
      hit.at = item.at || new Date(now).toISOString();
      /* Promotion is one-way. The user saying what the model guessed
         makes it a requirement; the model restating a requirement does
         not demote it back to a guess. */
      if (source === "user" && hit.source === "model") hit.source = "user";
      hit.text = text;
      changed = true;
      continue;
    }
    byKey.set(id, { id, text, source, at: item.at || new Date(now).toISOString(), hits: 1 });
    changed = true;
  }

  if (!changed && !prior.length) return null;

  const all = [...byKey.values()];
  const user = all.filter((r) => r.source === "user")
    .sort((a, b) => b.hits - a.hits || b.at.localeCompare(a.at))
    .slice(0, MAX_USER_RULES);

  const model = all.filter((r) => r.source === "model")
    .filter((r) => now - Date.parse(r.at) < MODEL_NOTE_TTL_MS)
    .sort((a, b) => b.hits - a.hits || b.at.localeCompare(a.at))
    .slice(0, MAX_MODEL_RULES);

  const rules = user.concat(model);
  return rules.length ? { rules } : null;
}

/** Drop one rule by its text. What the user gives, the user can take. */
export function forget(
  existing: ProjectRules | null | undefined,
  text: string
): ProjectRules | null {
  const id = keyOf(clean(text));
  const rules = (existing && existing.rules ? existing.rules : []).filter((r) => r.id !== id);
  return rules.length ? { rules } : null;
}

/**
 * The block a later turn reads. Empty string when there is nothing.
 *
 * The two groups are labelled differently on purpose. The model is
 * told the user's are requirements and its own are observations it may
 * revise — without that, a note it wrote itself six turns ago reads
 * with exactly the authority of something the customer said.
 */
export function promptBlock(memory: ProjectRules | null | undefined): string {
  const rules = (memory && Array.isArray(memory.rules) ? memory.rules : []).filter((r) => r && r.text);
  if (!rules.length) return "";

  const user = rules.filter((r) => r.source === "user");
  const model = rules.filter((r) => r.source === "model");
  const out: string[] = [];

  if (user.length) {
    out.push("Things the user has said about this project. Treat these as requirements:",
      ...user.map((r) => "  - " + r.text + (r.hits > 1 ? "  (said " + r.hits + " times)" : "")));
  }
  if (model.length) {
    if (out.length) out.push("");
    out.push("Notes you made on earlier turns. These are observations, not instructions —" +
      " revise them if this turn shows they were wrong:",
      ...model.map((r) => "  - " + r.text));
  }
  return out.join("\n") + "\n\n";
}
