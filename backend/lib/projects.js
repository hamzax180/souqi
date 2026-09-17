/* =================================================================
   projects.js — the durable object the whole agent hangs off
   -----------------------------------------------------------------
   A Project survives a page reload, has a URL you can come back to,
   remembers its conversation, and keeps every version of the site it
   has ever produced. It is owned by an ANONYMOUS id first (a signed
   cookie) and by a real user later, when it is claimed — the same row,
   re-pointed, so nothing is copied and nothing is lost.

     project  ── turns[]      the conversation, in order
              └─ revisions[]  immutable configs; head is the live one

   Revisions store whole configs rather than diffs. A site config is a
   few hundred KB at worst, and storing complete ones makes restore a
   single assignment instead of a replay — which removes an entire
   class of bug.

   See docs/AGENT-PARITY-PLAN.md §2.
   ================================================================= */
"use strict";

const crypto = require("crypto");

const TTL_UNCLAIMED_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const MAX_REVISIONS = 50;
const MAX_TURNS = 400;

/* ---- in-memory fallback, so the agent works with no Mongo ---- */
const mem = { projects: new Map(), turns: new Map(), revisions: new Map() };

let getMasterDb = () => null;
function init(deps) { getMasterDb = deps.getMasterDb; }

const id = (prefix) => prefix + "_" + crypto.randomBytes(8).toString("base64url");

/* ---- collection helpers ------------------------------------------- */

function col(name) {
  const db = getMasterDb();
  return db ? db.collection(name) : null;
}

async function ensureIndexes() {
  const db = getMasterDb();
  if (!db) return;
  try {
    await db.collection("projects").createIndex({ id: 1 }, { unique: true });
    await db.collection("projects").createIndex({ ownerAnonId: 1, updatedAt: -1 });
    await db.collection("projects").createIndex({ ownerUserId: 1, updatedAt: -1 });
    await db.collection("projects").createIndex({ "published.publicSlug": 1 }, { unique: true, sparse: true });
    await db.collection("projects").createIndex({ "published.customDomain": 1 }, { unique: true, sparse: true });
    // TTL only bites while a project is unclaimed — expiresAt is unset on claim
    await db.collection("projects").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await db.collection("turns").createIndex({ projectId: 1, seq: 1 });
    await db.collection("revisions").createIndex({ projectId: 1, at: -1 });
    await db.collection("revisions").createIndex({ id: 1 }, { unique: true });
    /* Last, and unique, because addTurn upserts on it: a turn named after
       its run is how a retried request stays one message instead of two,
       and without the constraint two concurrent upserts both insert and the
       de-duplication is decorative. Last in the list because a legacy
       duplicate would throw here, and the indexes above are worth more than
       this one. */
    await db.collection("turns").createIndex({ id: 1 }, { unique: true });
  } catch (e) { /* indexes are an optimisation, never a hard dependency */ }
}

/* ---- titles -------------------------------------------------------- */

/* A project was titled `prompt.slice(0, 60)` — the raw first message, verbatim
   and mid-word. So the card said "build me a football staduim woow 3d anim"
   when what it is, is a football stadium. The instruction is not the name.

   This strips the asking and keeps the subject. It is deliberately dumb: no
   model call, no network, no cost, and it runs the same whether or not a
   provider is reachable — the plan's own title is better when there is one,
   and the caller prefers it. This is the floor, not the ceiling. */

/* The lead-in people type before saying what they want, in pieces so
   "can you please make me an" is stripped as readily as "build a". A regex
   literal, not new RegExp: the string form needs every backslash doubled and
   it has been silently flattened to `^s*` twice already. */
const ASK_PREFIX = /^\s*(?:(?:please|pls|plz|hey|hi|hello|yo|ok|okay)[,\s]+)*(?:(?:can|could|would|will)\s+(?:you|u)\s+)?(?:(?:please|pls|plz)\s+)*(?:i\s+(?:want|need|would\s+like)\s+(?:you\s+to\s+)?)?(?:go\s+ahead\s+and\s+)?(?:build|make|create|design|generate|develop|code|write|do)\s+(?:me\s+|us\s+|for\s+me\s+)?(?:(?:an|a|the|my|some)\s+)?/i;

/* Asking for a thing without a verb: "i want a dashboard", "i need an
   invoice app". ASK_PREFIX is anchored on the verb, so on its own it
   matched none of this and the title kept the whole request. */
const WISH_PREFIX = /^\s*(?:(?:please|pls|plz|hey|hi|hello|yo)[,\s]+)*(?:i\s+(?:want|need|would\s+like)|(?:can|could)\s+(?:you|u)\s+(?:get|give)\s+me)\s+(?:(?:an|a|the|my|some)\s+)?/i;

// Noise people type around a request that is not part of what it is.
const FILLER = /\b(?:pls|plz|please|asap|quickly|woow+|wow+|omg|cool|nice|thanks|thx)\b/gi;

// A clause with nothing in it but a greeting is not what the app is called.
const GREETING_ONLY = /^(?:hi|hey|hello+|yo+|sup|ok|okay|test|testing)$/i;

const SMALL_WORDS = new Set(["a", "an", "the", "for", "of", "and", "or", "to", "in", "on", "with", "at", "by", "is", "she", "he", "it"]);

/**
 * A short, human title from a build prompt.
 *
 * Caps at 6 words / 48 chars because this is a card label, not a sentence.
 * Deliberately dumb: no model call, no network, no cost, and identical
 * whether or not a provider is reachable. The plan's title is better when
 * there is one and the caller prefers it; this is the floor.
 */
function titleFromPrompt(prompt) {
  const original = String(prompt || "").replace(/\s+/g, " ").trim();
  if (!original) return "Untitled app";

  // Someone typing in capitals is shouting, not naming an initialism, so the
  // whole thing gets normalised. Otherwise short all-caps words are left
  // alone: API and iOS are how they are spelled.
  const letters = original.replace(/[^A-Za-z]/g, "");
  const shouting = letters.length > 6 && letters === letters.toUpperCase();

  // The first clause that actually says something: "hello. hello. build me a
  // porto for hamza" is named by the third clause, not by "Hello".
  /* A dot ends a sentence only when whitespace or the end follows it -
     "@damndrip.com" and "3.5" are not two clauses. */
  const clauses = original.split(/[.!?;\n]+(?:\s+|$)/).map((c) => c.trim()).filter(Boolean);
  let s = clauses.find((c) => ASK_PREFIX.test(c) || WISH_PREFIX.test(c))
    || clauses.find((c) => !GREETING_ONLY.test(c.replace(/[^\w\s]/g, "").trim()))
    || clauses[0] || original;

  const stripped = s.replace(ASK_PREFIX, "");
  s = (stripped === s ? s.replace(WISH_PREFIX, "") : stripped)
    .replace(FILLER, " ").replace(/\s+/g, " ").trim()
    // Whatever the prefix left behind. "BUILD ,E A MINECRAFT GAME" is
    // "me" mistyped, and it survived as ",e a minecraft game" because a
    // comma is not the letter the prefix was looking for. A stray single
    // character sitting in front of an article is not part of the name.
    .replace(/^[\W_]+/, "")
    .replace(/^\w\s+(?=(?:an|a|the|my|some)\s)/i, "");
  if (!s) return "Untitled app";

  const words = s.split(" ").slice(0, 6);
  // A title ending on "a", "for" or "is" reads as a sentence someone cut off.
  while (words.length > 1 && SMALL_WORDS.has(words[words.length - 1].toLowerCase())) words.pop();
  // ...or on the comma the sentence was going to continue past.
  words[words.length - 1] = words[words.length - 1].replace(/[,;:\u2013\u2014-]+$/, "");
  if (!words[words.length - 1] && words.length > 1) words.pop();

  let out = words.join(" ");
  if (out.length > 48) out = out.slice(0, 48).replace(/\s+\S*$/, "");

  return out.split(" ").map((w, i) => {
    const lower = w.toLowerCase();
    if (i > 0 && SMALL_WORDS.has(lower)) return lower;
    if (!shouting && w.length <= 4 && w === w.toUpperCase() && /[A-Z]/.test(w)) return w;  // API, 3D
    if (!shouting && /[a-z]/.test(w) && /[A-Z]/.test(w.slice(1))) return w;                // camelCase
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(" ") || "Untitled app";
}

/* ---- slugs --------------------------------------------------------- */

function slugify(title) {
  const base = String(title || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "site";
}

/** A slug unique within one owner, so two people can both have "kahve-co". */
async function uniqueSlug(title, ownerKey) {
  const base = slugify(title);
  for (let n = 0; n < 50; n++) {
    const candidate = n ? base + "-" + (n + 1) : base;
    const clash = await findBySlug(candidate, ownerKey);
    if (!clash) return candidate;
  }
  return base + "-" + crypto.randomBytes(2).toString("hex");
}

/* ================= projects ================= */

async function create(fields) {
  const now = new Date();
  const project = {
    id: id("pr"),
    slug: await uniqueSlug(fields.title || "site", fields.owner),
    title: String(fields.title || "Untitled site").slice(0, 80),
    ownerAnonId: fields.owner && fields.owner.anonId ? fields.owner.anonId : null,
    ownerUserId: fields.owner && fields.owner.userId ? fields.owner.userId : null,
    wsId: null,
    headRevision: null,
    // The revision currently live at wsId's storefrontConfig — null until the
    // first publish (which happens at claim time). Lets the client answer
    // "is what I'm looking at actually live" without re-diffing configs.
    publishedRevisionId: null,
    prompt: String(fields.prompt || "").slice(0, 2000),
    meta: fields.meta || {},
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    /* Only genuinely unclaimed work is reaped. Putting a signed-in
       user's project on a 30-day timer means their app deletes itself
       out from under them, which is the one thing TTL_UNCLAIMED_MS is
       named after not doing. */
    expiresAt: fields.owner && fields.owner.userId
      ? null
      : new Date(now.getTime() + TTL_UNCLAIMED_MS)
  };

  const c = col("projects");
  if (c) await c.insertOne(Object.assign({}, project));
  else mem.projects.set(project.id, project);
  return project;
}

async function get(projectId) {
  const c = col("projects");
  if (c) return c.findOne({ id: projectId }, { projection: { _id: 0 } });
  return mem.projects.get(projectId) || null;
}

/**
 * Match EITHER identity, not "userId if logged in, else anonId". A signed-in
 * visitor still carries the anon cookie that made their not-yet-claimed
 * projects, and those must keep resolving by it after login — a user is
 * strictly more identity, never less. Getting this wrong means a logged-in
 * owner can no longer find their own unclaimed project by its own slug.
 */
function ownerFilter(owner) {
  const or = [];
  if (owner && owner.userId) or.push({ ownerUserId: owner.userId });
  if (owner && owner.anonId) or.push({ ownerAnonId: owner.anonId });
  if (!or.length) return { id: "__no_owner__" };   // matches nothing
  return or.length === 1 ? or[0] : { $or: or };
}
function ownerMatches(p, owner) {
  return !!((owner.userId && p.ownerUserId === owner.userId) || (owner.anonId && p.ownerAnonId === owner.anonId));
}

async function findBySlug(slug, owner) {
  const q = Object.assign({ slug: slug }, ownerFilter(owner));
  const c = col("projects");
  if (c) return c.findOne(q, { projection: { _id: 0 } });
  for (const p of mem.projects.values()) {
    if (p.slug === slug && ownerMatches(p, owner || {})) return p;
  }
  return null;
}

/** Published sites are public — no owner context to scope the slug within,
    unlike the per-owner editing slug above. Uniqueness is checked GLOBALLY. */
async function findPublished(publicSlug) {
  const c = col("projects");
  if (c) return c.findOne({ "published.publicSlug": publicSlug }, { projection: { _id: 0 } });
  for (const p of mem.projects.values()) {
    if (p.published && p.published.publicSlug === publicSlug) return p;
  }
  return null;
}

/** Same trust model as Sites' own custom domains (db-adapters.js's
    findWorkspaceByDomain): the stored field is the only check, no separate
    ownership-verification flow. This isn't a security gap — setting the
    field is already owner-gated (only the project's owner can call the
    /domain endpoint), and a domain string that ISN'T actually pointed at
    Souqi's DNS does nothing regardless of what's stored, since traffic for
    that domain never reaches this server in the first place. */
async function findByCustomDomain(domain) {
  const c = col("projects");
  const normalized = String(domain || "").toLowerCase().trim();
  if (!normalized) return null;
  if (c) return c.findOne({ "published.customDomain": normalized }, { projection: { _id: 0 } });
  for (const p of mem.projects.values()) {
    if (p.published && p.published.customDomain === normalized) return p;
  }
  return null;
}

async function uniquePublicSlug(title) {
  const base = slugify(title);
  for (let n = 0; n < 50; n++) {
    const candidate = n ? base + "-" + (n + 1) : base;
    const clash = await findPublished(candidate);
    if (!clash) return candidate;
  }
  return base + "-" + crypto.randomBytes(3).toString("hex");
}

async function list(owner, limit) {
  const n = Math.min(limit || 30, 100);
  const q = ownerFilter(owner);
  const c = col("projects");
  if (c) return c.find(q, { projection: { _id: 0 } }).sort({ updatedAt: -1 }).limit(n).toArray();
  return [...mem.projects.values()]
    .filter((p) => ownerMatches(p, owner))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, n);
}

/**
 * Attach every project owned only by this anonymous cookie to a real account.
 *
 * Called the moment someone signs in or signs up. Without it, anything built
 * before signing in stays tied to a cookie — and the next time that cookie
 * rotates (new device, cleared site data, a different browser) the person's
 * entire history becomes invisible with no way back to it. Signing in did not
 * help, because nothing ever moved ownership across.
 *
 * ownerAnonId is left in place, exactly as finalizeClaim() leaves it: the
 * cookie keeps working, the account is simply a second way in.
 *
 * expiresAt is cleared with it. TTL_UNCLAIMED_MS exists to reap abandoned
 * anonymous work, and this is no longer either of those things.
 */
async function claimAnon(anonId, userId) {
  if (!anonId || !userId) return { claimed: 0 };
  const c = col("projects");
  if (!c) {
    let n = 0;
    for (const p of mem.projects.values()) {
      if (p.ownerAnonId === anonId && !p.ownerUserId) {
        p.ownerUserId = userId; p.expiresAt = null; n++;
      }
    }
    return { claimed: n };
  }
  const r = await c.updateMany(
    { ownerAnonId: anonId, ownerUserId: null },
    { $set: { ownerUserId: userId, expiresAt: null } }
  );
  return { claimed: r.modifiedCount || 0 };
}

async function patch(projectId, fields) {
  fields.updatedAt = new Date().toISOString();
  const c = col("projects");
  if (c) await c.updateOne({ id: projectId }, { $set: fields });
  else Object.assign(mem.projects.get(projectId) || {}, fields);
  return get(projectId);
}

async function remove(projectId) {
  const c = col("projects");
  if (c) {
    await c.deleteOne({ id: projectId });
    await col("turns").deleteMany({ projectId: projectId });
    await col("revisions").deleteMany({ projectId: projectId });
  } else {
    mem.projects.delete(projectId);
    mem.turns.delete(projectId);
    mem.revisions.delete(projectId);
  }
}

/**
 * Ownership. An anonymous cookie owns a project until it is claimed; after
 * that only the user does. Checked on every read AND write — a project id is
 * a handle, never a permission.
 */
function owns(project, owner) {
  if (!project || !owner) return false;
  if (project.ownerUserId) return !!owner.userId && project.ownerUserId === owner.userId;
  return !!owner.anonId && project.ownerAnonId === owner.anonId;
}

/* ================= revisions ================= */

async function addRevision(projectId, config, label) {
  const project = await get(projectId);
  const rev = {
    id: id("rv"),
    projectId: projectId,
    parentId: project ? project.headRevision : null,
    config: config,
    label: String(label || "").slice(0, 60),
    at: new Date().toISOString()
  };

  const c = col("revisions");
  if (c) {
    await c.insertOne(Object.assign({}, rev));
    // keep the history bounded; the oldest go first, head is never touched
    const all = await c.find({ projectId: projectId }, { projection: { id: 1, at: 1 } }).sort({ at: -1 }).toArray();
    if (all.length > MAX_REVISIONS) {
      const drop = all.slice(MAX_REVISIONS).map((r) => r.id);
      await c.deleteMany({ id: { $in: drop } });
    }
  } else {
    const arr = mem.revisions.get(projectId) || [];
    arr.push(rev);
    mem.revisions.set(projectId, arr.slice(-MAX_REVISIONS));
  }

  await patch(projectId, { headRevision: rev.id });
  return rev;
}

async function getRevision(revisionId) {
  const c = col("revisions");
  if (c) return c.findOne({ id: revisionId }, { projection: { _id: 0 } });
  for (const arr of mem.revisions.values()) {
    const hit = arr.find((r) => r.id === revisionId);
    if (hit) return hit;
  }
  return null;
}

async function listRevisions(projectId) {
  const c = col("revisions");
  if (c) {
    return c.find({ projectId: projectId }, { projection: { _id: 0, config: 0 } }).sort({ at: -1 }).toArray();
  }
  return (mem.revisions.get(projectId) || []).slice().reverse()
    .map((r) => ({ id: r.id, projectId: r.projectId, parentId: r.parentId, label: r.label, at: r.at }));
}

async function head(projectId) {
  const project = await get(projectId);
  if (!project || !project.headRevision) return null;
  return getRevision(project.headRevision);
}

/**
 * The project's COMPLETE source, rebuilt by replaying its revisions.
 *
 * A revision stores only what the model wrote that turn — it is told to
 * "call write_file for every file you create or change", so a follow-up
 * writes two files, not twelve. head() therefore returns the last diff,
 * not the project. Reading files off it gave a tree with whichever files
 * happened to change last: one real project here has a head revision of
 * four components, with no App.tsx at all.
 *
 * addRevision records parentId, so the chain is walkable. This follows it
 * back to the root and replays oldest-first, so a later write of a file
 * wins over an earlier one.
 *
 * `complete` is false when the walk could not reach a root. MAX_REVISIONS
 * prunes the oldest revisions of a long-lived project, and a file written
 * once and never touched again lives only in a revision that pruning can
 * delete — so this reports when it cannot promise a whole tree rather than
 * quietly returning a partial one.
 */
async function materialize(projectId) {
  const project = await get(projectId);
  if (!project || !project.headRevision) return { files: {}, complete: false, revisions: 0 };

  const chain = [];
  const seen = new Set();
  let id = project.headRevision;
  while (id && !seen.has(id)) {
    seen.add(id);
    const rev = await getRevision(id);
    if (!rev) break;                 // pruned: the chain stops here
    chain.push(rev);
    id = rev.parentId;
  }

  // Oldest first, so a later revision's version of a file overwrites the
  // earlier one — the same precedence as replaying the edits in order.
  const files = {};
  for (const rev of chain.slice().reverse()) {
    const f = rev.config && rev.config.files;
    if (f) for (const [path, content] of Object.entries(f)) files[path] = content;
  }

  const rootReached = chain.length > 0 && !chain[chain.length - 1].parentId;
  return { files: files, complete: rootReached, revisions: chain.length };
}

/* ================= turns ================= */

async function addTurn(projectId, turn) {
  const existing = await listTurns(projectId);
  const row = {
    /* Usually generated, but a caller may name it — and when it does, the
       write below becomes insert-if-absent rather than insert.

       createRun hands back the EXISTING run on an idempotency hit and the
       caller cannot tell that from a fresh one, so a double-submitted
       message would otherwise be posted into the transcript twice. Naming
       the turn after its run makes the second write a no-op. The durable
       worker's finalizer has always done this (`turn_<runId>`); this is the
       same trick, available to everyone. */
    id: turn.id ? String(turn.id).slice(0, 80) : id("tn"),
    projectId: projectId,
    /* One past the highest, not the count.
       These two agree while seqs are dense, and the finalizer computes its
       own as `lastTurn.seq + 1`. Now that a user turn is written for every
       message, one can land while a worker run is finalizing — and two rows
       claiming the same seq sort arbitrarily, which puts the reply above the
       message that asked for it. */
    seq: existing.length ? Math.max.apply(null, existing.map((t) => Number(t.seq) || 0)) + 1 : 0,
    role: turn.role === "user" ? "user" : "agent",
    kind: turn.kind || "text",
    /* Which conversation inside the project this turn belongs to.
       "" is the original thread: every turn written before projects had
       more than one, and the default for anything that does not say. Read
       it back through chatOf() rather than comparing raw, so old rows and
       new ones sort into the same bucket. */
    chatId: String(turn.chatId || "").slice(0, 40),
    body: String(turn.body === null || turn.body === undefined ? "" : turn.body).slice(0, 4000),
    detail: turn.detail ? String(turn.detail).slice(0, 300) : "",
    revisionId: turn.revisionId || null,
    /* The run that produced this turn, so a reopened chat can fetch the
       steps it took — they live in agent_events and this is the only
       thing linking the two.

       Named here for the same reason `images` and `fileStats` are: this
       row is fixed-shape and drops anything the caller passes that is
       not listed. Turns written by the durable worker's finalizer carry
       the run id inside their own id instead (`turn_<runId>`), which is
       why only in-process turns had no way back to their history. */
    runId: turn.runId ? String(turn.runId).slice(0, 60) : null,
    ms: typeof turn.ms === "number" ? turn.ms : null,
    /* What the turn cost, when the row is the only record of it.

       A turn with a run behind it can be measured from its agent_events;
       a conversational reply has no run, so the count the provider gave
       us lives here or nowhere. Named explicitly for the same reason
       `ms`, `runId` and `images` are: this row is built field by field
       and silently drops anything the caller passes that is not listed. */
    tokens: typeof turn.tokens === "number" && turn.tokens > 0 ? turn.tokens : null,
    /* Photos attached to this message, so a reloaded conversation still
       shows them. Just enough to render a chip — the upload rows are the
       record, this is the transcript.

       This row is deliberately fixed-shape: it is built field by field and
       anything the caller passes that is not named here is dropped. That is
       the right default, and it is also why this line has to exist rather
       than the caller simply spreading turn — without it the thumbnails
       disappear on reload and the message reads as referring to pictures
       nobody can see. */
    images: Array.isArray(turn.images) ? turn.images.slice(0, 8).map((i) => ({
      id: String(i && i.id || ""), url: String(i && i.url || ""), name: String(i && i.name || "").slice(0, 120)
    })).filter((i) => i.url) : [],
    /* What this turn changed, per file. Same reasoning as `images` directly
       above: this row is fixed-shape by design, so a field the caller passes
       and this list does not name is dropped — and a replayed conversation
       then shows a build's file list with no counts beside it, which is the
       one thing that list is for. Recomputing on reload is not an option:
       the diff is against the tree as it was BEFORE that turn, and by the
       time anyone reopens the project that tree is several turns gone. */
    fileStats: Array.isArray(turn.fileStats) ? turn.fileStats.slice(0, 60).map((f) => ({
      path: String(f && f.path || "").slice(0, 200),
      added: Number(f && f.added) || 0,
      removed: Number(f && f.removed) || 0,
      isNew: !!(f && f.isNew)
    })).filter((f) => f.path) : [],
    at: new Date().toISOString()
  };

  const c = col("turns");
  // Insert-if-absent, so a caller-supplied id is a de-duplication key. A row
  // that is already there wins; nothing here ever rewrites a stored turn.
  if (c) await c.updateOne({ id: row.id }, { $setOnInsert: Object.assign({}, row) }, { upsert: true });
  else {
    const arr = mem.turns.get(projectId) || [];
    if (arr.some((t) => t.id === row.id)) return row;
    arr.push(row);
    mem.turns.set(projectId, arr.slice(-MAX_TURNS));
  }
  await patch(projectId, {});     // bump updatedAt so lists sort correctly
  return row;
}

/* One project can hold several conversations. They share the app - the
   files, the revisions, the deployment - and differ only in what has been
   said, which is the point: "start a new chat here" means keep the thing
   you built and stop carrying three days of context into every reply. */
const MAIN_CHAT = "";

function chatOf(turn) { return String((turn && turn.chatId) || MAIN_CHAT); }

/**
 * @param {string} projectId
 * @param {string} [chatId] when given, only that conversation's turns
 */
async function listTurns(projectId, chatId) {
  const c = col("turns");
  const all = c
    ? await c.find({ projectId: projectId }, { projection: { _id: 0 } }).sort({ seq: 1 }).toArray()
    : (mem.turns.get(projectId) || []).slice();
  if (chatId === null || chatId === undefined) return all;
  const want = String(chatId);
  return all.filter((r) => chatOf(r) === want);
}

/**
 * The project's conversations, newest activity first.
 *
 * Titled by the first thing the person said in each, because that is what
 * they would recognise - the same reason a project is titled from its
 * prompt rather than numbered.
 */
async function listChats(projectId) {
  const all = await listTurns(projectId);
  const byId = new Map();
  for (const r of all) {
    const key = chatOf(r);
    let c = byId.get(key);
    if (!c) { c = { id: key, title: "", turns: 0, at: r.at }; byId.set(key, c); }
    c.turns += 1;
    if (r.at > c.at) c.at = r.at;
    if (!c.title && r.role === "user" && r.body) c.title = String(r.body).slice(0, 60);
  }
  // A project with no turns at all still has the one chat you are looking at.
  if (!byId.size) byId.set(MAIN_CHAT, { id: MAIN_CHAT, title: "", turns: 0, at: new Date().toISOString() });
  return [...byId.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
}

module.exports = {
  init, ensureIndexes, owns, slugify,
  create, get, findBySlug, findPublished, findByCustomDomain, uniquePublicSlug, list, patch, remove,
  addRevision, getRevision, listRevisions, head, materialize,
  addTurn, listTurns, listChats, MAIN_CHAT,
  claimAnon,
  titleFromPrompt,
  TTL_UNCLAIMED_MS, MAX_REVISIONS
};
