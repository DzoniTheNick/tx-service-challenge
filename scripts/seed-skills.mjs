// Generate scripts/skills-kv.json from the SKILL.md files, then seed with:
//   yarn seed   (wrangler kv bulk put --binding SKILLS --local ./scripts/skills-kv.json)
//
// KV is the source of truth at runtime (CONTEXT.md §6); the value stored for each
// skill is the raw Markdown (the loader parses it). Run this whenever a SKILL.md
// changes: `node scripts/seed-skills.mjs`.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(here, "..", "skills");

/** Minimal frontmatter name extractor (keeps the script dependency-free). */
function skillName(md) {
  const fm = md.match(/^---\s*\n([\s\S]*?)\n---/);
  const name = fm?.[1].match(/^name:\s*(.*)$/m)?.[1]?.trim();
  if (!name) throw new Error("SKILL.md missing `name` frontmatter");
  return name;
}

const entries = readdirSync(skillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => {
    const md = readFileSync(join(skillsDir, d.name, "SKILL.md"), "utf8");
    return { key: skillName(md), value: md };
  })
  .sort((a, b) => a.key.localeCompare(b.key));

const out = join(here, "skills-kv.json");
writeFileSync(out, JSON.stringify(entries, null, 2) + "\n");
console.log(`Wrote ${entries.length} skills to ${out}:`);
for (const e of entries) console.log(`  - ${e.key}`);
