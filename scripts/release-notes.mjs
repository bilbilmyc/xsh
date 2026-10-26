import { readFileSync, writeFileSync } from "node:fs";

const [tag, outputPath] = process.argv.slice(2);
if (!tag || !outputPath) {
  throw new Error("Usage: node scripts/release-notes.mjs <tag> <output-path>");
}

const lines = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").split(/\r?\n/);
const start = lines.findIndex((line) => line.startsWith("## ") && line.split(/\s+/)[1] === tag);
if (start === -1) {
  throw new Error(`CHANGELOG.md has no release notes for ${tag}`);
}
const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
const notes = lines.slice(start + 1, next === -1 ? undefined : next).join("\n").trim();
if (!notes) {
  throw new Error(`Release notes for ${tag} are empty`);
}
writeFileSync(outputPath, `${notes}\n`);
