// Access to the local pf2e catalog mirror (D:\TTRPG\The Shards\pf2e-catalog).
// The mirror is a dev-machine resource: builds use it to resolve slugs, names and IDs.
// CI has no mirror; it relies on the committed tools/uuid-map.json and vendor fetch paths
// that local builds record into tools/pf2e-refs.json.
import { readFileSync, existsSync } from "node:fs";

const refs = JSON.parse(readFileSync("tools/pf2e-refs.json", "utf8"));
export const MIRROR = refs.localMirror || "";

export function hasMirror() {
  return !!MIRROR && existsSync(`${MIRROR}/index/summary.json`);
}

let _summary = null;
let _packToFolder = null;
const _indexCache = {};

function summary() {
  _summary ||= JSON.parse(readFileSync(`${MIRROR}/index/summary.json`, "utf8"));
  return _summary;
}

function packToFolder() {
  if (!_packToFolder) {
    _packToFolder = {};
    for (const [folder, v] of Object.entries(summary())) _packToFolder[v.pack] = { folder, kind: v.kind };
  }
  return _packToFolder;
}

export function loadIndex(folder, kind = "items") {
  const key = `${kind}/${folder}`;
  if (!_indexCache[key]) {
    const p = `${MIRROR}/index/${kind}/${folder}.jsonl`;
    _indexCache[key] = existsSync(p)
      ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
  }
  return _indexCache[key];
}

function rowsForPack(packName) {
  const pf = packToFolder()[packName];
  if (!pf) return null;
  return loadIndex(pf.folder, pf.kind === "Actor" ? "actors" : "items");
}

/** Resolve a doc by its display name inside a Foundry pack (for name-based @UUID remap). */
export function findByName(packName, name) {
  const rows = rowsForPack(packName);
  return rows ? rows.find((r) => r.n === name) || null : null;
}

/** True if the pack exists in the index and contains this _id. */
export function idExists(packName, id) {
  const rows = rowsForPack(packName);
  if (!rows) return null; // pack unknown to the index (journals etc.): cannot judge
  return rows.some((r) => r.id === id);
}

/** Resolve a doc by slug inside a mirror pack FOLDER (e.g. "equipment", "bestiary-ability-glossary-srd"). */
export function findBySlug(folder, slug, kind = "items") {
  return loadIndex(folder, kind).find((r) => r.s === slug) || null;
}

/** Load the full raw document for an index row. */
export function loadDoc(row) {
  return JSON.parse(readFileSync(`${MIRROR}/${row.f}`, "utf8"));
}
