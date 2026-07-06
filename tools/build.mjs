// Builds the module's LevelDB compendium packs.
// - Actors live in src/actors as compact "recipes": stats + strikes + actions + gear/spell
//   slugs. The resolver here embeds the real pf2e docs (pulled by fetch-pf2e.mjs into vendor/)
//   and writes a full, self-contained npc actor, then compiles it.
// - Items, spells, and abilities are already full docs and compile directly.
import { compilePack } from "@foundryvtt/foundryvtt-cli";
import { readdirSync, existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hasMirror, findByName, idExists } from "./catalog.mjs";
import { resolveActor, warnings } from "./resolve-actor.mjs";
import { validateResolvedActor, validationErrors } from "./validate-actors.mjs";

// ---- UUID remap: name-based pf2e compendium links -> IDs (same as the official pipeline) ----
// Source docs and our own texts may say Compendium.pf2e.<pack>.Item.<Name>. Foundry v14 only
// resolves IDs, so every such link is remapped here. Resolution order: committed uuid-map.json
// (works in CI), then the local catalog mirror (dev machine; new hits are saved back to the map).
const UUID_MAP_PATH = "tools/uuid-map.json";
const uuidMap = existsSync(UUID_MAP_PATH) ? JSON.parse(readFileSync(UUID_MAP_PATH, "utf8")) : {};
let uuidMapDirty = false;
const unresolved = new Set();
const badIds = new Set();
const ID_RE = /^[a-zA-Z0-9]{16}$/;
const REF_RE = /Compendium\.pf2e\.([A-Za-z0-9-]+)\.(Item|Actor)\.([^\]"{}\r\n]+)/g;

function remapString(s, ctx) {
  return s.replace(REF_RE, (m, pack, type, tail) => {
    if (ID_RE.test(tail)) {
      if (hasMirror() && idExists(pack, tail) === false) badIds.add(`${ctx}: ${m}`);
      return m;
    }
    const key = `Compendium.pf2e.${pack}.${type}.${tail}`;
    let id = uuidMap[key];
    if (!id && hasMirror()) {
      const row = findByName(pack, tail);
      if (row) { id = row.id; uuidMap[key] = id; uuidMapDirty = true; }
    }
    if (!id) { unresolved.add(`${ctx}: ${key}`); return m; }
    return `Compendium.pf2e.${pack}.${type}.${id}`;
  });
}

function remapDoc(node, ctx) {
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (typeof v === "string" && v.includes("Compendium.pf2e.")) node[k] = remapString(v, ctx);
    else if (v && typeof v === "object") remapDoc(v, ctx);
  }
}

// Self-references (Compendium.the-shards-forge.*) are verified after staging, against the
// set of _ids this build actually produced.
const SELF_RE = /Compendium\.the-shards-forge\.([A-Za-z0-9-]+)\.(Item|Actor)\.([a-zA-Z0-9]{16})/g;
const stagedIds = new Set();
const selfRefs = [];
function collectSelfRefs(node, ctx) {
  for (const v of Object.values(node)) {
    if (typeof v === "string" && v.includes("Compendium.the-shards-forge.")) {
      for (const m of v.matchAll(SELF_RE)) selfRefs.push({ ref: m[0], id: m[3], ctx });
    } else if (v && typeof v === "object") collectSelfRefs(v, ctx);
  }
}

// LevelDB keys, mirroring foundryvtt-cli: primary "!<collection>!<id>", embedded
// "!<parent>.<child>!<parentId>.<childId>". The CLI skips any doc lacking _key.
const HIERARCHY = { actors: ["items", "effects"], items: ["effects"], journal: ["pages"] };
const keyJoin = (...a) => a.filter(Boolean).join(".");
function keyify(doc, collection, subPrefix, idPrefix) {
  const sub = keyJoin(subPrefix, collection);
  const id = keyJoin(idPrefix, doc._id);
  doc._key = `!${sub}!${id}`;
  for (const emb of (HIERARCHY[collection] || [])) {
    if (Array.isArray(doc[emb])) for (const e of doc[emb]) keyify(e, emb, sub, id);
  }
}

rmSync("packs", { recursive: true, force: true });
rmSync(".build", { recursive: true, force: true });
mkdirSync("packs", { recursive: true });

// The Foundry CLI SKIPS any doc without a LevelDB `_key` ("!<collection>!<id>"), so every
// primary doc is staged with its key before compiling. Actors are resolved from recipes first.
const PACKS = [
  { name: "shards-actors", src: "src/actors", collection: "actors", resolve: true },
  { name: "shards-items", src: "src/items", collection: "items" },
  { name: "shards-spells", src: "src/spells", collection: "items" },
  { name: "shards-abilities", src: "src/abilities", collection: "items" },
];

for (const p of PACKS) {
  if (!existsSync(p.src) || !readdirSync(p.src).some((f) => f.endsWith(".json"))) { console.log(`· skip ${p.name} (no source)`); continue; }
  const stage = `.build/${p.name}`;
  mkdirSync(stage, { recursive: true });
  let n = 0;
  for (const f of readdirSync(p.src)) {
    if (!f.endsWith(".json")) continue;
    let doc = JSON.parse(readFileSync(`${p.src}/${f}`, "utf8"));
    if (p.resolve) doc = resolveActor(doc);
    if (!doc._id) { warnings.push(`${p.name}/${f}: missing _id`); continue; }
    if (p.resolve) validateResolvedActor(doc, `${p.name}/${f}`);
    remapDoc(doc, `${p.name}/${f}`);
    collectSelfRefs(doc, `${p.name}/${f}`);
    stagedIds.add(doc._id);
    for (const it of (doc.items || [])) stagedIds.add(it._id);
    keyify(doc, p.collection);
    writeFileSync(`${stage}/${f}`, JSON.stringify(doc, null, 2));
    n++;
  }
  await compilePack(stage, `packs/${p.name}`, {});
  console.log(`✓ built ${p.name} (${n} doc(s))`);
}

if (uuidMapDirty) {
  const sorted = Object.fromEntries(Object.entries(uuidMap).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(UUID_MAP_PATH, JSON.stringify(sorted, null, 2) + "\n");
  console.log(`updated ${UUID_MAP_PATH} (commit it: CI resolves links from it)`);
}
const danglingSelf = selfRefs.filter((r) => !stagedIds.has(r.id));
if (unresolved.size) console.error("\nUNRESOLVED pf2e LINKS (name not found in pack):\n" + [...unresolved].join("\n"));
if (badIds.size) console.error("\nBAD pf2e IDs (not present in the catalog index):\n" + [...badIds].join("\n"));
if (danglingSelf.length) console.error("\nDANGLING self-references (no such _id in this build):\n" + danglingSelf.map((r) => `${r.ctx}: ${r.ref}`).join("\n"));
if (warnings.length) console.error("\nRESOLVER WARNINGS:\n" + warnings.join("\n"));
if (validationErrors.length) console.error("\nPRE-FLIGHT VALIDATION FAILED (fix the recipes, or run: node tools/validate-actors.mjs --fix):\n" + validationErrors.join("\n"));
if (warnings.length || unresolved.size || badIds.size || danglingSelf.length || validationErrors.length) process.exit(1);
console.log("done.");
