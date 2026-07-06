// Pulls the standard pf2e documents that the champion recipes reference (gear + spells)
// straight from the pinned pf2e-8.2.0 tag into a local, gitignored vendor cache.
// The resolver in build.mjs then embeds them into each actor.
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

const refs = JSON.parse(readFileSync("tools/pf2e-refs.json", "utf8"));
const base = `${refs.raw}/${refs.ref}`;

// Collect the slugs the recipes actually reference.
const need = { equipment: new Set(), spells: new Set() };
if (existsSync("src/actors")) {
  for (const f of readdirSync("src/actors")) {
    if (!f.endsWith(".json")) continue;
    const r = JSON.parse(readFileSync(`src/actors/${f}`, "utf8"));
    for (const g of (r.gear || [])) if (g.slug) need.equipment.add(g.slug);
    if (r.spellcasting?.spells) for (const arr of Object.values(r.spellcasting.spells)) for (const s of arr) need.spells.add(s);
  }
}

async function pull(type, slug, path) {
  const out = `vendor/pf2e/${type}/${slug}.json`;
  if (existsSync(out)) { console.log(`  cached  ${type}/${slug}`); return true; }
  const res = await fetch(`${base}/${path}`);
  if (!res.ok) { console.error(`  FAIL ${res.status}  ${type}/${slug}  (${path})`); return false; }
  mkdirSync(`vendor/pf2e/${type}`, { recursive: true });
  writeFileSync(out, await res.text());
  console.log(`  pulled  ${type}/${slug}`);
  return true;
}

let failed = 0;
console.log(`fetching pf2e docs from ${refs.ref} ...`);
for (const slug of need.equipment) if (!(await pull("equipment", slug, `${refs.dirs.equipment}/${slug}.json`))) failed++;
for (const slug of need.spells) {
  const path = refs.spells[slug];
  if (!path) { console.error(`  MISSING PATH  spells/${slug}  (add it to tools/pf2e-refs.json)`); failed++; continue; }
  if (!(await pull("spells", slug, path))) failed++;
}
if (failed) { console.error(`\nfetch FAILED: ${failed} document(s) could not be pulled.`); process.exit(1); }
console.log("fetch done.");
