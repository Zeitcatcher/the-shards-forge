// Builds the module's LevelDB compendium packs.
// - Actors live in src/actors as compact "recipes": stats + strikes + actions + gear/spell
//   slugs. The resolver here embeds the real pf2e docs (pulled by fetch-pf2e.mjs into vendor/)
//   and writes a full, self-contained npc actor, then compiles it.
// - Items, spells, and abilities are already full docs and compile directly.
import { compilePack } from "@foundryvtt/foundryvtt-cli";
import { readdirSync, existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { hasMirror, findByName, idExists } from "./catalog.mjs";

const mkid = (seed) => createHash("md5").update(seed).digest("hex").slice(0, 16);
const loadVendor = (type, slug) => {
  const p = `vendor/pf2e/${type}/${slug}.json`;
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};
const strip = (d) => { delete d.folder; delete d.sort; delete d.ownership; delete d._stats; return d; };

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

const AIMG = {
  passive: "systems/pf2e/icons/actions/Passive.webp", reaction: "systems/pf2e/icons/actions/Reaction.webp",
  free: "systems/pf2e/icons/actions/FreeAction.webp", a1: "systems/pf2e/icons/actions/OneAction.webp",
  a2: "systems/pf2e/icons/actions/TwoActions.webp", a3: "systems/pf2e/icons/actions/ThreeActions.webp",
};
const warnings = [];

function resolveActor(A) {
  const items = [];

  for (const s of (A.strikes || [])) {
    const dmg = {}; (s.damage || []).forEach((x, i) => (dmg["d" + i] = { damage: x.dice, damageType: x.type, category: x.category || null }));
    items.push({ _id: mkid(A._id + ":strike:" + s.name), name: s.name, type: "melee", img: "systems/pf2e/icons/default-icons/melee.svg",
      // attackEffects wires the Strike's chat card to follow-up abilities (Grab, Knockdown...):
      // list the ability slugs in the recipe as effects: ["grab"].
      system: { bonus: { value: s.bonus || 0 }, damageRolls: dmg, traits: { value: s.traits || [], otherTags: [] }, attackEffects: { value: s.effects || [] },
        description: { value: s.text || "", gm: "" }, rules: s.rules || [], slug: null, action: "strike", subjectToMAP: true, range: s.range ? { value: s.range } : null, area: null } });
  }

  // Standard pf2e docs embedded as-is (bestiary glossary abilities, standard actions...).
  // Recipe: standardItems: [{slug, group?: "abilities"|"actions"|"effects", name?, text?, rules?}]
  // name/text/rules override the standard doc (e.g. Sneak Attack dice scaled to level).
  for (const st of (A.standardItems || [])) {
    const doc = loadVendor(st.group || "abilities", st.slug);
    if (!doc) { warnings.push(`${A.name}: standard item not vendored: ${st.slug}`); continue; }
    strip(doc);
    doc._id = mkid(A._id + ":std:" + st.slug);
    if (st.name) doc.name = st.name;
    if (st.text) doc.system.description = { value: st.text, gm: "" };
    if (st.rules) doc.system.rules = st.rules;
    items.push(doc);
  }

  for (const a of (A.actions || [])) {
    const t = a.type || "passive";
    const img = t === "action" ? (AIMG["a" + (a.actions || 1)] || AIMG.a1) : (AIMG[t] || AIMG.passive);
    items.push({ _id: mkid(A._id + ":action:" + a.name), name: a.name, type: "action", img,
      system: { actionType: { value: t === "action" ? "action" : t }, actions: { value: t === "action" ? (a.actions || 1) : null },
        description: { value: a.text || "", gm: "" }, traits: { value: a.traits || [], otherTags: [] }, rules: a.rules || [], slug: null, category: null } });
  }

  for (const [gi, g] of (A.gear || []).entries()) {
    let doc;
    if (g.item) { doc = JSON.parse(JSON.stringify(g.item)); }
    else { doc = loadVendor("equipment", g.slug); if (!doc) { warnings.push(`${A.name}: gear not vendored: ${g.slug}`); continue; } }
    strip(doc);
    doc._id = mkid(A._id + ":gear:" + gi + ":" + (g.slug || (g.item && g.item.name) || "x"));
    doc.system = doc.system || {};
    if (g.qty) doc.system.quantity = g.qty;
    if (g.runes) doc.system.runes = Object.assign({}, doc.system.runes || {}, g.runes);
    const eq = (doc.system.equipped = doc.system.equipped || {});
    const invested = (((doc.system.traits && doc.system.traits.value) || []).includes("invested"));
    const mode = g.equip || "worn";
    if (mode === "held" || mode === "held1") { eq.carryType = "held"; eq.handsHeld = 1; }
    else if (mode === "held2") { eq.carryType = "held"; eq.handsHeld = 2; }
    else if (mode === "stowed") { eq.carryType = "stowed"; eq.handsHeld = 0; }
    else { eq.carryType = "worn"; eq.handsHeld = 0; if (doc.type === "armor") eq.inSlot = true; }
    if (invested) eq.invested = (g.invested !== false);
    items.push(doc);
  }

  if (A.spellcasting?.spells) {
    const sc = A.spellcasting;
    const entryId = mkid(A._id + ":sce");
    const slots = {};
    for (const [rank, slugs] of Object.entries(sc.spells)) slots["slot" + rank] = { prepared: [], value: 0, max: slugs.length };
    const spellItems = [];
    for (const [rank, slugs] of Object.entries(sc.spells)) {
      const r = Number(rank);
      for (const slug of slugs) {
        const doc = loadVendor("spells", slug);
        if (!doc) { warnings.push(`${A.name}: spell not vendored: ${slug}`); continue; }
        strip(doc);
        doc._id = mkid(A._id + ":spell:" + slug);
        doc.system = doc.system || {};
        doc.system.location = { value: entryId };
        if (r > 0 && doc.system.level && doc.system.level.value !== r) doc.system.location.heightenedLevel = r;
        spellItems.push({ doc, r });
      }
    }
    if (sc.type !== "spontaneous" && sc.type !== "innate") {
      for (const { doc, r } of spellItems) { const k = "slot" + r; (slots[k] ||= { prepared: [], value: 0, max: 0 }); slots[k].prepared.push({ id: doc._id }); slots[k].max = slots[k].prepared.length; }
    }
    items.push({ _id: entryId, name: sc.name || "Spells", type: "spellcastingEntry", img: "systems/pf2e/icons/default-icons/spellcastingEntry.svg",
      system: { ability: { value: sc.ability || "cha" }, spelldc: { dc: sc.dc || 0, value: sc.attack || 0, mod: 0 }, tradition: { value: sc.tradition || "arcane" },
        prepared: { value: sc.type || "prepared", flexible: false }, showSlotlessLevels: { value: false }, proficiency: { value: 0 }, slots, traits: { otherTags: [] } } });
    for (const { doc } of spellItems) items.push(doc);
  }

  const ab = A.abilities || {}; const speeds = A.speeds || { land: 25 };
  const system = {
    abilities: Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"].map((k) => [k, { mod: ab[k] ?? 0 }])),
    attributes: { hp: { value: A.hp || 1, max: A.hp || 1, temp: 0 }, ac: { value: A.ac || 10 },
      speed: { value: speeds.land ?? 25, otherSpeeds: Object.entries(speeds).filter(([k]) => k !== "land").map(([type, value]) => ({ type, value })) },
      immunities: A.immunities || [], weaknesses: A.weaknesses || [], resistances: A.resistances || [] },
    perception: { mod: A.perception || 0, senses: (A.senses || []).map((s) => (typeof s === "string" ? { type: s } : s)) },
    saves: { fortitude: { value: A.saves?.fort || 0 }, reflex: { value: A.saves?.ref || 0 }, will: { value: A.saves?.will || 0 } },
    skills: Object.fromEntries(Object.entries(A.skills || {}).map(([k, v]) => [k.toLowerCase(), { base: v }])),
    details: { level: { value: A.level || 0 }, languages: { value: A.languages || [] }, publicNotes: A.notes || "" },
    traits: { value: A.traits || [], rarity: A.rarity || "unique", size: { value: A.size || "med" } },
    initiative: { statistic: "perception" },
  };

  return { _id: A._id, name: A.name, type: "npc", img: A.img || "systems/pf2e/icons/default-icons/npc.svg",
    prototypeToken: { name: A.name, texture: { src: A.token || A.img || "systems/pf2e/icons/default-icons/npc.svg" }, disposition: -1, actorLink: false, sight: { enabled: true } },
    system, items };
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
if (warnings.length || unresolved.size || badIds.size || danglingSelf.length) process.exit(1);
console.log("done.");
