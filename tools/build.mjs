// Builds the module's LevelDB compendium packs.
// - Actors live in src/actors as compact "recipes": stats + strikes + actions + gear/spell
//   slugs. The resolver here embeds the real pf2e docs (pulled by fetch-pf2e.mjs into vendor/)
//   and writes a full, self-contained npc actor, then compiles it.
// - Items, spells, and abilities are already full docs and compile directly.
import { compilePack } from "@foundryvtt/foundryvtt-cli";
import { readdirSync, existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const mkid = (seed) => createHash("md5").update(seed).digest("hex").slice(0, 16);
const loadVendor = (type, slug) => {
  const p = `vendor/pf2e/${type}/${slug}.json`;
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};
const strip = (d) => { delete d.folder; delete d.sort; delete d.ownership; delete d._stats; return d; };

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
      system: { bonus: { value: s.bonus || 0 }, damageRolls: dmg, traits: { value: s.traits || [], otherTags: [] }, attackEffects: { value: [] },
        description: { value: s.text || "", gm: "" }, rules: s.rules || [], slug: null, action: "strike", subjectToMAP: true, range: s.range ? { value: s.range } : null, area: null } });
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
    keyify(doc, p.collection);
    writeFileSync(`${stage}/${f}`, JSON.stringify(doc, null, 2));
    n++;
  }
  await compilePack(stage, `packs/${p.name}`, {});
  console.log(`✓ built ${p.name} (${n} doc(s))`);
}

if (warnings.length) { console.error("\nRESOLVER WARNINGS:\n" + warnings.join("\n")); process.exit(1); }
console.log("done.");
