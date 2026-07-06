// One-command release. After adding a source file (an item, a spell, an actor recipe,
// or an ability), run:  node tools/release.mjs "Add <name>"
// It commits, bumps the patch version from the latest tag, and pushes the tag.
// The GitHub Action then builds the packs and publishes the release; in Foundry you
// click Update to pull it.
import { execSync } from "node:child_process";

const message = process.argv[2] || "Add content";
const sh = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();

sh("git add -A");

let hasStaged = true;
try { execSync("git diff --cached --quiet"); hasStaged = false; } catch { hasStaged = true; }
if (hasStaged) sh(`git commit -q -m "${message.replace(/"/g, "'")}"`);
else console.log("(no file changes to commit; releasing current HEAD)");

let latest = "v0.0.0";
try { latest = sh("git describe --tags --abbrev=0"); } catch {}
const m = latest.match(/v(\d+)\.(\d+)\.(\d+)/);
const next = m ? `v${m[1]}.${m[2]}.${Number(m[3]) + 1}` : "v0.1.0";

sh(`git tag ${next}`);
sh("git push");
sh(`git push origin ${next}`);
console.log(`pushed ${next}. GitHub Actions is building and publishing it; click Update in Foundry once it finishes.`);
