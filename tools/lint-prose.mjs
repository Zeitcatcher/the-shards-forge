// Fails the build if AI typographic tells appear in module text.
// Scanned: module.json, README.md, and every JSON doc under src/.
// Bans: em dash, en dash, curly quotes, and the warning sign used as a marker.
import { readFileSync, readdirSync, existsSync } from "node:fs";

const BAD = [
  [/—/, "em dash (—) — restructure with a period, comma, colon, or parentheses"],
  [/–/, "en dash (–) — use a plain hyphen or reword"],
  [/[“”]/, "curly double quote — use a straight quote"],
  [/[‘’]/, "curly single quote / apostrophe — use a straight one"],
  [/⚠/, "warning sign — write the caution in words"],
];

const files = ["module.json", "README.md"];
for (const dir of ["src/items", "src/abilities", "src/actors", "src/spells"]) {
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.endsWith(".json")) files.push(`${dir}/${f}`);
}

let hits = 0;
for (const file of files) {
  if (!existsSync(file)) continue;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [re, msg] of BAD) {
      if (re.test(line)) { console.error(`  ${file}:${i + 1}  ${msg}`); hits++; }
    }
  });
}

if (hits) {
  console.error(`\nprose lint FAILED: ${hits} AI typographic tell(s). Fix them, then build.`);
  process.exit(1);
}
console.log("prose lint clean.");
