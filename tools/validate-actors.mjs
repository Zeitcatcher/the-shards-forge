// Pre-flight validator: checks every RESOLVED actor's abilities against their real
// requirements before anything is packed or released. Runs automatically inside
// `npm run build`; run `node tools/validate-actors.mjs --fix` to apply the safe,
// recipe-level autofixes (each fix is a reviewable git diff in src/actors/).
//
// Philosophy: an ability's Requirements line is a dependency declaration. Known
// requirements map to machine checks (see TABLE). An ability with a Requirements line
// the table does not know FAILS the build, so new abilities cannot ship unexamined.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { MIRROR, hasMirror, findBySlug } from "./catalog.mjs";
import { resolveActor, loadVendor } from "./resolve-actor.mjs";

export const validationErrors = [];
export const validationWarnings = [];

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
let _lang = null;
function localize(text) {
  // Expand @Localize[PF2E....] tokens through the mirror's en.json (dev machine only).
  if (!hasMirror() || !text.includes("@Localize[")) return text;
  if (!_lang) _lang = JSON.parse(readFileSync(`${MIRROR}/raw/static/lang/en.json`, "utf8"));
  return text.replace(/@Localize\[([\w.]+)\]/g, (m, path) => {
    const v = path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), _lang);
    return typeof v === "string" ? v : m;
  });
}

// ---- The requirements table -------------------------------------------------------
// key: sluggified ability name on the actor. check(ctx) returns an error string or null.
// runtime: true = the requirement is an in-play state (grabbed target, last action...),
// nothing to verify structurally. fix: a recipe-level autofix for --fix mode.
const RAISE_GUARD_SELF_EFFECT = {
  name: "Effect: Raise Guard",
  uuid: "Compendium.pf2e.bestiary-effects.Item.Effect: Raise Guard",
};

const TABLE = {
  "shield-block": {
    check: (c) => {
      if (!c.shields.length) return "Shield Block present but no shield in inventory";
      if (!c.names.has("raise-a-shield")) return "Shield Block present but the actor has no Raise a Shield action (its requirement is a raised shield)";
      return null;
    },
    fix: (recipe) => {
      recipe.standardItems ||= [];
      if (!recipe.standardItems.some((s) => s.slug === "raise-a-shield"))
        recipe.standardItems.push({ group: "actions", slug: "raise-a-shield", selfEffect: RAISE_GUARD_SELF_EFFECT });
      return "added Raise a Shield (actionspf2e) with Effect: Raise Guard selfEffect";
    },
  },
  "raise-a-shield": {
    check: (c) => (c.shields.length ? null : "Raise a Shield present but no shield in inventory"),
  },
  "grab": { check: (c) => strikeListsCheck(c, "grab") , fix: (r) => addStrikeEffect(r, "grab") },
  "improved-grab": { check: (c) => strikeListsCheck(c, "improved-grab"), fix: (r) => addStrikeEffect(r, "improved-grab") },
  "knockdown": { check: (c) => strikeListsCheck(c, "knockdown"), fix: (r) => addStrikeEffect(r, "knockdown") },
  "improved-knockdown": { check: (c) => strikeListsCheck(c, "improved-knockdown"), fix: (r) => addStrikeEffect(r, "improved-knockdown") },
  "push": { check: (c) => strikeListsCheck(c, "push"), fix: (r) => addStrikeEffect(r, "push") },
  "improved-push": { check: (c) => strikeListsCheck(c, "improved-push"), fix: (r) => addStrikeEffect(r, "improved-push") },
  "pull": { check: (c) => strikeListsCheck(c, "pull"), fix: (r) => addStrikeEffect(r, "pull") },
  "reactive-strike": {
    check: (c) => (c.strikes.some((s) => !s.system.range?.value && !s.system.range?.max) ? null : "Reactive Strike present but the actor has no melee Strike"),
  },
  "attack-of-opportunity": {
    check: (c) => (c.strikes.some((s) => !s.system.range?.value && !s.system.range?.max) ? null : "Attack of Opportunity present but the actor has no melee Strike"),
  },
  "counterspell": {
    check: (c) => {
      if (!c.entries.length) return "Counterspell present but the actor has no spellcasting entry";
      const prep = c.entries[0].system.prepared?.value;
      const text = c.abilityText("counterspell").toLowerCase();
      if (prep === "prepared" && !text.includes("prepared")) return "Counterspell wording does not match the prepared caster (should reference prepared spells)";
      if (prep === "spontaneous" && !(text.includes("repertoire") || text.includes("spell slot"))) return "Counterspell wording does not match the spontaneous caster (should reference repertoire/slots)";
      return null;
    },
  },
  // Runtime-state requirements: nothing structural to verify.
  "bone-crushing-squeeze": { runtime: true },
  "ferocity": { runtime: true },
  "nimble-dodge": { runtime: true }, // "you are not encumbered": an in-play carry-load state
};

function strikeListsCheck(c, slug) {
  return c.strikes.some((s) => (s.system.attackEffects?.value || []).includes(slug))
    ? null
    : `${slug} ability present but no Strike lists "${slug}" in its attackEffects`;
}
function addStrikeEffect(recipe, slug) {
  const melee = (recipe.strikes || []).filter((s) => !s.range);
  if (melee.length !== 1) return null; // ambiguous: which strike? leave it to a human
  (melee[0].effects ||= []).includes(slug) || melee[0].effects.push(slug);
  return `listed "${slug}" in the ${melee[0].name} strike's attackEffects`;
}

// ---- The validator ---------------------------------------------------------------
export function validateResolvedActor(doc, ctx) {
  const items = doc.items || [];
  const actions = items.filter((i) => i.type === "action");
  const strikes = items.filter((i) => i.type === "melee");
  const shields = items.filter((i) => i.type === "shield");
  const entries = items.filter((i) => i.type === "spellcastingEntry");
  const names = new Set(actions.map((a) => slugify(a.name)));
  const c = {
    actions, strikes, shields, entries, names,
    abilityText: (slug) => {
      const a = actions.find((x) => slugify(x.name) === slug);
      return a ? localize(a.system.description?.value || "") : "";
    },
  };
  const failures = [];

  // 1) Table-driven checks for every ability the actor carries.
  for (const a of actions) {
    const slug = slugify(a.name);
    const rule = TABLE[slug];
    if (rule?.check) { const err = rule.check(c); if (err) failures.push(err); }
  }

  // 2) Reverse check: every attackEffects slug has a matching ability item.
  for (const s of strikes) {
    for (const slug of (s.system.attackEffects?.value || [])) {
      if (!names.has(slug)) failures.push(`Strike "${s.name}" lists "${slug}" in attackEffects but the actor has no such ability`);
    }
  }

  // 3) Inventory backing for consumable-throwing strikes (bombs, thrown weapons).
  for (const s of strikes) {
    const traits = s.system.traits?.value || [];
    if (!(traits.includes("bomb") || traits.includes("thrown"))) continue;
    const sslug = slugify(s.name);
    const backing = items.filter((i) => ["consumable", "weapon"].includes(i.type))
      .find((i) => { const islug = slugify(i.name); return sslug.includes(islug) || islug.includes(sslug); });
    if (!backing) failures.push(`Strike "${s.name}" throws a consumable but no matching inventory item backs it`);
    else if ((backing.system.quantity ?? 1) < 1) failures.push(`Strike "${s.name}": backing item "${backing.name}" has quantity 0`);
  }

  // 4) Unknown Requirements lines = unexamined dependency -> fail (mirror only: the
  //    scan needs @Localize expansion; CI still runs checks 1-3).
  if (hasMirror()) {
    for (const a of actions) {
      const slug = slugify(a.name);
      if (TABLE[slug]) continue; // known, already handled
      const text = localize(a.system.description?.value || "");
      const m = /<strong>\s*Requirements?\s*<\/strong>([^<]{0,200})/i.exec(text);
      if (m) failures.push(`"${a.name}" has a Requirements line the validator does not know ("${m[1].trim().slice(0, 80)}..."): add a rule to tools/validate-actors.mjs TABLE`);
    }
  }

  // 5) Advisory: shield in inventory but no shield actions at all.
  if (shields.length && !names.has("shield-block") && !names.has("raise-a-shield"))
    validationWarnings.push(`${ctx}: carries a shield but has neither Raise a Shield nor Shield Block (intentional?)`);

  for (const f of failures) validationErrors.push(`${ctx}: ${f}`);
  return failures.length === 0;
}

// ---- CLI: validate all recipes, optionally autofix --------------------------------
const isCLI = process.argv[1]?.replace(/\\/g, "/").endsWith("validate-actors.mjs");
if (isCLI) {
  const FIX = process.argv.includes("--fix");
  let anyFixed = false;
  for (const f of readdirSync("src/actors")) {
    if (!f.endsWith(".json")) continue;
    const path = `src/actors/${f}`;
    const recipe = JSON.parse(readFileSync(path, "utf8"));
    const before = validationErrors.length;
    validateResolvedActor(resolveActor(recipe), f);
    const errs = validationErrors.slice(before);
    if (!errs.length) { console.log(`ok    ${f}`); continue; }
    for (const e of errs) console.error(`FAIL  ${e}`);
    if (FIX) {
      let fixedHere = [];
      // Apply fixes for the failures we know how to fix, by re-running table rules on the recipe.
      const resolved = resolveActor(recipe);
      const items = resolved.items || [];
      const ctx2 = {
        actions: items.filter((i) => i.type === "action"),
        strikes: items.filter((i) => i.type === "melee"),
        shields: items.filter((i) => i.type === "shield"),
        entries: items.filter((i) => i.type === "spellcastingEntry"),
        names: new Set(items.filter((i) => i.type === "action").map((a) => slugify(a.name))),
        abilityText: () => "",
      };
      for (const a of ctx2.actions) {
        const rule = TABLE[slugify(a.name)];
        if (rule?.check && rule.fix && rule.check(ctx2)) {
          const note = rule.fix(recipe);
          if (note) { fixedHere.push(note); }
        }
      }
      if (fixedHere.length) {
        writeFileSync(path, JSON.stringify(recipe, null, 2) + "\n");
        anyFixed = true;
        for (const n of fixedHere) console.log(`fixed ${f}: ${n}`);
      } else {
        console.error(`      ${f}: no safe autofix, resolve by hand`);
      }
    }
  }
  for (const w of validationWarnings) console.warn(`warn  ${w}`);
  if (anyFixed) console.log("\nautofixes applied to recipes; rerun `npm run build` to verify and pack.");
  process.exit(validationErrors.length && !anyFixed ? 1 : 0);
}
