/* =================================================================
   uploads.js — images a person attached, and what we know about them
   -----------------------------------------------------------------
   An upload is NOT a project file, and that distinction is the whole
   design. A revision is a {path: string} map and every consumer of it
   assumes UTF-8 — wc-runtime reads source back with readFile(…,'utf-8')
   and skips whatever throws, and both deploy writers force
   String(…) + "utf8". Binary cannot survive that contract, so the bytes
   live in object storage and the generated code carries a URL, which is
   a string and rides through untouched.

   This row is therefore metadata, never a build dependency: it backs the
   composer chips, the transcript thumbnails and the description cache.
   materialize(), addRevision(), withScaffold(), publish and deploy are
   all unaffected by its existence.

   Owned anonymously first and claimed later, exactly like projects.js —
   an upload happens BEFORE the project exists on a first build
   (projects.create does not run until the build has already succeeded),
   so it cannot be keyed on a project and must stand on its own.
   ================================================================= */
"use strict";

const crypto = require("crypto");

/* An upload nobody ever built with is litter — a signed URL was minted, the
   browser may never have PUT anything, and no project points at it. 24h is
   long enough to survive a slow session and short enough that abandoned
   uploads do not accumulate.

   Cleared the moment the image is used in a build (see attachToProject),
   the same way projects.js drops expiresAt on claim. */
const TTL_PENDING_MS = 24 * 60 * 60 * 1000;

/* Description is cached on the row forever, so vision is paid once per
   image ever rather than once per turn — that is the entire cost story for
   the feature. This caps what one description can occupy in a prompt. */
const MAX_DESCRIPTION = 900;

/* ---- in-memory fallback, so uploads work with no Mongo ---- */
const mem = { uploads: new Map() };

let getMasterDb = () => null;
/* Fired by attachToProject, so whatever stores the BYTES can make them
   permanent at the same instant this row does. A hook rather than a call
   beside each call site: there are two today and the third one to be
   written would silently produce images that work for 24 hours and then
   disappear from a published site. */
let onPersist = null;
function init(deps) {
  getMasterDb = deps.getMasterDb;
  onPersist = typeof deps.onPersist === "function" ? deps.onPersist : null;
}

const id = (prefix) => prefix + "_" + crypto.randomBytes(8).toString("base64url");

function col() {
  const db = getMasterDb();
  return db ? db.collection("uploads") : null;
}

async function ensureIndexes() {
  const db = getMasterDb();
  if (!db) return;
  try {
    await db.collection("uploads").createIndex({ id: 1 }, { unique: true });
    await db.collection("uploads").createIndex({ ownerAnonId: 1, createdAt: -1 });
    await db.collection("uploads").createIndex({ ownerUserId: 1, createdAt: -1 });
    await db.collection("uploads").createIndex({ projectId: 1 });
    // Only bites while the upload is unused — expiresAt is unset on first use.
    await db.collection("uploads").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  } catch (e) { /* indexes are an optimisation, never a hard dependency */ }
}

/* ---- ownership ------------------------------------------------------
   Same shape as projects.owns: either identity is sufficient, because a
   claimed row keeps its anon id and the cookie must keep working. */
function owns(row, owner) {
  if (!row || !owner) return false;
  if (owner.userId && row.ownerUserId && row.ownerUserId === owner.userId) return true;
  if (owner.anonId && row.ownerAnonId && row.ownerAnonId === owner.anonId) return true;
  return false;
}

/**
 * Reserve a row BEFORE the bytes exist.
 *
 * status is "pending" and stays that way until complete() has looked at
 * what actually landed in the bucket. Nothing may use a pending row: the
 * client controls the PUT, so between here and there the object is
 * whatever the browser chose to send, and only the completion check
 * establishes that it is the image it claimed to be.
 */
async function create(fields) {
  const now = new Date();
  const row = {
    id: id("img"),
    ownerUserId: (fields.owner && fields.owner.userId) || null,
    ownerAnonId: (fields.owner && fields.owner.anonId) || null,
    projectId: null,
    key: String(fields.key || ""),
    url: String(fields.url || ""),
    name: String(fields.name || "image").slice(0, 120),
    mime: String(fields.mime || ""),
    ext: String(fields.ext || ""),
    bytes: Number(fields.bytes) || 0,
    // Client-reported and advisory only until complete() measures them.
    width: Number(fields.width) || 0,
    height: Number(fields.height) || 0,
    status: "pending",
    description: "",
    describedAt: null,
    describeCostUsd: 0,
    // Dominant colour, for seeding the generated site's palette from the
    // logo (lib/design/palette.js turns one seed into a whole AA-checked
    // system). Advisory, client-extracted, never required.
    seedHex: String(fields.seedHex || "").slice(0, 7),
    createdAt: now.toISOString(),
    lastUsedAt: null,
    expiresAt: new Date(now.getTime() + TTL_PENDING_MS)
  };
  const c = col();
  if (c) await c.insertOne(Object.assign({}, row));
  else mem.uploads.set(row.id, row);
  return row;
}

async function get(uploadId) {
  const c = col();
  if (c) return c.findOne({ id: uploadId }, { projection: { _id: 0 } });
  return mem.uploads.get(uploadId) || null;
}

async function patch(uploadId, fields) {
  const c = col();
  if (c) await c.updateOne({ id: uploadId }, { $set: fields });
  else Object.assign(mem.uploads.get(uploadId) || {}, fields);
  return get(uploadId);
}

/**
 * Take the row from "pending" to "verifying", once, atomically.
 *
 * /complete used to guard with a plain `if (row.status === "ready")`,
 * which is a read followed by a write and therefore a race. Against a
 * bucket a lost race was harmless — both callers re-read the same object
 * and reached the same answer. Against the database it destroys the
 * upload: the winner stitches the parts and deletes them, and the loser
 * then finds no parts and marks a perfectly good image failed. A
 * double-clicked button was enough.
 *
 * "verifying" is inert to every consumer, because listForOwner already
 * filters on status === "ready".
 */
async function claimForVerify(uploadId) {
  const c = col();
  if (c) {
    const r = await c.updateOne({ id: uploadId, status: "pending" }, { $set: { status: "verifying" } });
    return (r.modifiedCount || 0) === 1;
  }
  const row = mem.uploads.get(uploadId);
  if (!row || row.status !== "pending") return false;
  row.status = "verifying";
  return true;
}

/** The object was fetched back, sniffed and measured — it is what it said. */
async function markReady(uploadId, measured) {
  return patch(uploadId, {
    status: "ready",
    bytes: Number(measured && measured.bytes) || 0,
    mime: String((measured && measured.mime) || ""),
    width: Number(measured && measured.width) || 0,
    height: Number(measured && measured.height) || 0
  });
}

/** It was not. The object is deleted by the caller; the row stays as a record. */
async function markFailed(uploadId, reason) {
  return patch(uploadId, { status: "failed", failReason: String(reason || "").slice(0, 200) });
}

/**
 * Cache what the vision model saw.
 *
 * A property of the IMAGE, not of the turn — so it is written once and read
 * on every subsequent build and edit. An empty description is a legitimate
 * cached result (vision unavailable, or it declined): describedAt is what
 * says "already asked", so a failure is not retried on every keystroke.
 */
async function setDescription(uploadId, description, costUsd) {
  return patch(uploadId, {
    description: String(description || "").slice(0, MAX_DESCRIPTION),
    describedAt: new Date().toISOString(),
    describeCostUsd: Number(costUsd) || 0
  });
}

/**
 * Resolve ids the client sent, keeping only rows this person owns and that
 * actually made it to "ready".
 *
 * Order follows the ids as given, because the prompt numbers them ([1], [2])
 * and "use the second one as the hero" has to mean what the person saw in
 * the composer. A Mongo $in returns whatever order it likes.
 */
async function listForOwner(uploadIds, owner) {
  const ids = (Array.isArray(uploadIds) ? uploadIds : []).filter(Boolean).slice(0, 12);
  if (!ids.length) return [];
  let rows;
  const c = col();
  if (c) rows = await c.find({ id: { $in: ids } }, { projection: { _id: 0 } }).toArray();
  else rows = ids.map((i) => mem.uploads.get(i)).filter(Boolean);

  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((i) => byId.get(i))
    .filter((r) => r && r.status === "ready" && owns(r, owner));
}

/**
 * Mark images as used by a project, which is also what makes them permanent.
 *
 * expiresAt is cleared here and never restored. Once an image is in a build
 * its URL can be inside a published site or an exported ZIP, and those must
 * not break — which is also why project deletion does NOT remove uploads.
 * "Delete my images" is a deliberate, separate action, not a side effect.
 */
async function attachToProject(uploadIds, projectId) {
  const ids = (Array.isArray(uploadIds) ? uploadIds : []).filter(Boolean);
  if (!ids.length || !projectId) return { attached: 0, keys: [] };
  const set = { projectId: projectId, expiresAt: null, lastUsedAt: new Date().toISOString() };
  const c = col();
  let attached = 0;
  let keys = [];
  if (c) {
    // projectId is set only if unset: the first project to use an image owns
    // the association, so re-using one in a second project cannot silently
    // re-point the first project's record.
    const r = await c.updateMany({ id: { $in: ids }, projectId: null }, { $set: set });
    await c.updateMany({ id: { $in: ids } }, { $set: { expiresAt: null, lastUsedAt: set.lastUsedAt } });
    attached = r.modifiedCount || 0;
    const rows = await c.find({ id: { $in: ids } }, { projection: { _id: 0, key: 1 } }).toArray();
    keys = rows.map((x) => x.key).filter(Boolean);
  } else {
    for (const i of ids) {
      const row = mem.uploads.get(i);
      if (!row) continue;
      if (!row.projectId) { row.projectId = projectId; attached++; }
      row.expiresAt = null; row.lastUsedAt = set.lastUsedAt;
      if (row.key) keys.push(row.key);
    }
  }
  /* The bytes have to outlive the sweep too, and this is the one moment
     both facts are known. Soft: an image whose blob expiry could not be
     cleared is a problem for tomorrow, not a reason to fail the build the
     person is waiting on. */
  if (onPersist && keys.length) {
    try { await onPersist(keys); } catch (e) { /* see above */ }
  }
  return { attached: attached, keys: keys };
}

/**
 * Signing in must not lose the images attached moments earlier.
 *
 * projects.claimAnon re-points projects the same way at the same moment; an
 * upload that kept only its anon id would become invisible to the account
 * that just claimed the project it belongs to.
 */
async function claimAnon(anonId, userId) {
  if (!anonId || !userId) return { claimed: 0 };
  const c = col();
  if (!c) {
    let n = 0;
    for (const row of mem.uploads.values()) {
      if (row.ownerAnonId === anonId && !row.ownerUserId) { row.ownerUserId = userId; n++; }
    }
    return { claimed: n };
  }
  const r = await c.updateMany(
    { ownerAnonId: anonId, ownerUserId: null },
    { $set: { ownerUserId: userId } }
  );
  return { claimed: r.modifiedCount || 0 };
}

/** How many images this owner has made this month — the quota input. */
async function countSince(owner, sinceIso) {
  const c = col();
  const q = owner && owner.userId ? { ownerUserId: owner.userId } : { ownerAnonId: (owner && owner.anonId) || "" };
  q.createdAt = { $gte: sinceIso };
  if (c) return c.countDocuments(q);
  let n = 0;
  for (const row of mem.uploads.values()) {
    const match = owner && owner.userId ? row.ownerUserId === owner.userId : row.ownerAnonId === (owner && owner.anonId);
    if (match && row.createdAt >= sinceIso) n++;
  }
  return n;
}

async function listForProject(projectId) {
  const c = col();
  if (c) return c.find({ projectId: projectId }, { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray();
  return Array.from(mem.uploads.values()).filter((r) => r.projectId === projectId);
}

async function remove(uploadId) {
  const c = col();
  if (c) await c.deleteOne({ id: uploadId });
  else mem.uploads.delete(uploadId);
}

module.exports = {
  init, ensureIndexes, owns,
  create, get, patch, claimForVerify, markReady, markFailed, setDescription,
  listForOwner, listForProject, attachToProject, claimAnon, countSince, remove,
  TTL_PENDING_MS, MAX_DESCRIPTION
};
