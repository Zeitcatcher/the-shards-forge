// Pulls the standard pf2e documents the recipes reference (gear, spells, glossary abilities)
// into the gitignored vendor/ cache. Mirror-first: on the dev machine docs are copied from the
// local pf2e-catalog mirror and their network paths are recorded into tools/pf2e-refs.json so
// CI (no mirror) can fetch the same docs from the pinned tag over HTTP.
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { hasMirror, findBySlug, loadDoc } from "./catalog.mjs";

const REFS_PATH = "tools/pf2e-refs.json";
const refs = JSON.parse(readFileSync(REFS_PATH, "utf8"));
refs.paths ||= {};
const base = `${refs.raw}/${refs.ref}`;
let refsDirty = false;

// vendor group -> mirror pack folder
const GROUPS = {
  equipment: "equipment",
  spells: "spells",
  abilities: "bestiary-ability-glossary-srd",
  actions: "actions",
  effects: "feat-effects",
};

// Collect the slugs the recipes actually reference.
const need = { equipment: new Set(), spells: new Set(), abilities: new Set() };
if (existsSync("src/actors")) {
  for (const f of readdirSync("src/actors")) {
    if (!f.endsWith(".json")) continue;
    const r = JSON.parse(readFileSync(`src/actors/${f}`, "utf8"));
    for (const g of (r.gear || [])) if (g.slug) need.equipment.add(g.slug);
    if (r.spellcasting?.spells) for (const arr of Object.values(r.spellcasting.spells)) for (const s of arr) need.spells.add(s);
    for (const a of (r.standardItems || [])) need[a.group || "abilities"]?.add(a.slug);
  }
}

async function pull(group, slug) {
  const out = `vendor/pf2e/${group}/${slug}.json`;
  if (existsSync(out)) { console.log(`  cached  ${group}/${slug}`); return true; }
  mkdirSync(`vendor/pf2e/${group}`, { recursive: true });

  // 1) local mirror (dev machine): copy + record the network path for CI
  if (hasMirror()) {
    const row = findBySlug(GROUPS[group], slug);
    if (row) {
      writeFileSync(out, JSON.stringify(loadDoc(row), null, 2));
      const netPath = row.f.replace(/^raw\//, "");
      if (refs.paths[`${group}/${slug}`] !== netPath) { refs.paths[`${group}/${slug}`] = netPath; refsDirty = true; }
      console.log(`  mirror  ${group}/${slug}`);
      return true;
    }
    console.error(`  NOT IN CATALOG  ${group}/${slug} (check the slug against the index)`);
    return false;
  }

  // 2) network fallback (CI): recorded path, legacy spell map, or flat-guess
  const path = refs.paths[`${group}/${slug}`]
    || (group === "spells" ? refs.spells?.[slug] : null)
    || `packs/pf2e/${GROUPS[group]}/${slug}.json`;
  const res = await fetch(`${base}/${path}`);
  if (!res.ok) { console.error(`  FAIL ${res.status}  ${group}/${slug}  (${path})`); return false; }
  writeFileSync(out, await res.text());
  console.log(`  pulled  ${group}/${slug}`);
  return true;
}

let failed = 0;
console.log(`resolving pf2e docs (${hasMirror() ? "local mirror" : "network, " + refs.ref}) ...`);
for (const [group, slugs] of Object.entries(need)) {
  for (const slug of slugs) if (!(await pull(group, slug))) failed++;
}
if (refsDirty) {
  writeFileSync(REFS_PATH, JSON.stringify(refs, null, 2) + "\n");
  console.log("updated tools/pf2e-refs.json with recorded fetch paths");
}
if (failed) { console.error(`\nfetch FAILED: ${failed} document(s) could not be resolved.`); process.exit(1); }
console.log("fetch done.");
