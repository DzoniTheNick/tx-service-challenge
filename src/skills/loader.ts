/**
 * Skills (CONTEXT.md §6). A skill is a Markdown procedure with frontmatter
 * (`name`, `description`, `agents`). The KV namespace `SKILLS` is the source of
 * truth (seeded from the SKILL.md files); a bundled import is the documented
 * fallback when KV is unavailable. Scoping is by the `agents` frontmatter and is
 * enforced twice using the same field: (1) the index each specialist *sees*, and
 * (2) the `load_skill` check that decides what it may *load*.
 *
 * Specialist prompts contain only the index (name + description) — never bodies.
 */

import type { AgentId } from "../permissions/registry";
import { isAgentId } from "../agents/contract";

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly agents: readonly AgentId[];
  readonly body: string;
}

/** Parse one SKILL.md (frontmatter + body) without a YAML dependency. */
export function parseSkill(md: string): Skill {
  const match = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) throw new Error("skill is missing frontmatter");
  const [, frontmatter, body] = match;
  const field = (key: string): string | undefined =>
    frontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, "m"))?.[1]?.trim();

  const name = field("name");
  const description = field("description");
  if (!name || !description) {
    throw new Error("skill is missing name or description");
  }
  const agents = (field("agents") ?? "")
    .replace(/[[\]]/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is AgentId => s.length > 0 && isAgentId(s));

  return { name, description, agents, body: body.trim() };
}

/** Skills an agent is allowed to see/load (the single scoping rule). */
export function skillsForAgent(
  agent: AgentId,
  skills: readonly Skill[]
): Skill[] {
  return skills.filter((s) => s.agents.includes(agent));
}

/** The prompt-facing index: name + description only, never the body. */
export function skillIndex(
  agent: AgentId,
  skills: readonly Skill[]
): { name: string; description: string }[] {
  return skillsForAgent(agent, skills).map((s) => ({
    name: s.name,
    description: s.description
  }));
}

export type LoadSkillResult =
  | { ok: true; name: string; body: string }
  | { ok: false; error: string };

/** Load a skill body for an agent, enforcing the `agents` scope. */
export function loadSkillFor(
  agent: AgentId,
  name: string,
  skills: readonly Skill[]
): LoadSkillResult {
  const skill = skillsForAgent(agent, skills).find((s) => s.name === name);
  if (!skill) {
    return {
      ok: false,
      error: `no skill '${name}' is available to this agent`
    };
  }
  return { ok: true, name: skill.name, body: skill.body };
}

/**
 * Resolve the skill set for a turn: KV first (source of truth), bundled fallback
 * if KV is unbound, empty, or errors. Never throws — a skills outage degrades to
 * the bundled set rather than failing the turn.
 */
export async function loadSkills(
  env: { SKILLS?: KVNamespace },
  bundled: readonly Skill[]
): Promise<Skill[]> {
  try {
    const kv = env.SKILLS;
    if (kv) {
      const listing = await kv.list();
      if (listing.keys.length > 0) {
        const skills: Skill[] = [];
        for (const key of listing.keys) {
          const md = await kv.get(key.name);
          if (md) skills.push(parseSkill(md));
        }
        if (skills.length > 0) return skills;
      }
    }
  } catch {
    // fall through to bundled
  }
  return [...bundled];
}
