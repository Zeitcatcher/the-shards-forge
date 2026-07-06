// Writes the pushed git tag (minus a leading "v") into module.json's version field.
// Run by the release workflow before building.
import { readFileSync, writeFileSync } from "node:fs";

const version = (process.env.GITHUB_REF_NAME || process.argv[2] || "0.0.0").replace(/^v/, "");
const manifest = JSON.parse(readFileSync("module.json", "utf8"));
manifest.version = version;
writeFileSync("module.json", JSON.stringify(manifest, null, 2) + "\n");
console.log("module.json version =", version);
