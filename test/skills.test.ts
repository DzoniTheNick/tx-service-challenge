import { describe, expect, it } from "vitest";
import { USERS } from "../src/identity";
import { createFakeLlmClient } from "../src/llm";
import { createTracer, type TraceEvent } from "../src/trace";
import {
  loadSkillFor,
  loadSkills,
  parseSkill,
  skillIndex,
  skillsForAgent,
  type Skill
} from "../src/skills/loader";
import { runSpecialist } from "../src/agents/specialists";

const md = (name: string, agents: string, body = "Body here.") =>
  `---\nname: ${name}\ndescription: ${name} desc\nagents: ${agents}\n---\n\n${body}`;

const SKILLS: Skill[] = [
  parseSkill(md("troubleshooting", "[it]")),
  parseSkill(md("device-setup", "[it]")),
  parseSkill(md("leave-request-process", "[hr]"))
];

describe("parseSkill", () => {
  it("extracts frontmatter and body", () => {
    const s = parseSkill(md("troubleshooting", "[it]", "Step 1."));
    expect(s).toMatchObject({
      name: "troubleshooting",
      description: "troubleshooting desc",
      agents: ["it"],
      body: "Step 1."
    });
  });

  it("parses multiple agents and drops unknown ones", () => {
    expect(parseSkill(md("x", "[it, hr]")).agents).toEqual(["it", "hr"]);
    expect(parseSkill(md("x", "[it, legal]")).agents).toEqual(["it"]);
  });

  it("throws without frontmatter", () => {
    expect(() => parseSkill("no frontmatter here")).toThrow();
  });
});

describe("skill scoping (CONTEXT §6)", () => {
  it("the index each agent sees is filtered by frontmatter", () => {
    expect(skillIndex("it", SKILLS).map((s) => s.name)).toEqual([
      "troubleshooting",
      "device-setup"
    ]);
    expect(skillIndex("hr", SKILLS).map((s) => s.name)).toEqual([
      "leave-request-process"
    ]);
    // Index carries no bodies.
    expect(Object.keys(skillIndex("it", SKILLS)[0])).toEqual([
      "name",
      "description"
    ]);
  });

  it("loadSkillFor only loads a skill scoped to the calling agent", () => {
    expect(loadSkillFor("it", "troubleshooting", SKILLS)).toMatchObject({
      ok: true,
      name: "troubleshooting"
    });
    // HR cannot load an IT skill even by exact name.
    expect(loadSkillFor("hr", "troubleshooting", SKILLS)).toMatchObject({
      ok: false
    });
  });
});

describe("loadSkills — KV source of truth with bundled fallback", () => {
  const bundled = [parseSkill(md("bundled-skill", "[it]"))];

  it("returns KV skills when the namespace is seeded", async () => {
    const fakeKv = {
      list: async () => ({ keys: [{ name: "troubleshooting" }] }),
      get: async (k: string) =>
        k === "troubleshooting" ? md("troubleshooting", "[it]") : null
    } as unknown as KVNamespace;
    const skills = await loadSkills({ SKILLS: fakeKv }, bundled);
    expect(skills.map((s) => s.name)).toEqual(["troubleshooting"]);
  });

  it("falls back to bundled when KV is unbound", async () => {
    const skills = await loadSkills({}, bundled);
    expect(skills.map((s) => s.name)).toEqual(["bundled-skill"]);
  });

  it("falls back to bundled when KV is empty", async () => {
    const emptyKv = {
      list: async () => ({ keys: [] })
    } as unknown as KVNamespace;
    const skills = await loadSkills({ SKILLS: emptyKv }, bundled);
    expect(skills.map((s) => s.name)).toEqual(["bundled-skill"]);
  });

  it("falls back to bundled when KV throws", async () => {
    const brokenKv = {
      list: async () => {
        throw new Error("kv down");
      }
    } as unknown as KVNamespace;
    const skills = await loadSkills({ SKILLS: brokenKv }, bundled);
    expect(skills.map((s) => s.name)).toEqual(["bundled-skill"]);
  });
});

describe("runSpecialist — load_skill tool", () => {
  it("exposes load_skill to IT, loads the body, and emits skill_loaded", async () => {
    const rows: TraceEvent[] = [];
    const llm = createFakeLlmClient({
      steps: [
        { tool: "load_skill", input: { name: "troubleshooting" } },
        {
          tool: "submit_result",
          input: {
            status: "ok",
            answer: "done",
            limitations: [],
            toolErrors: []
          }
        }
      ]
    });
    await runSpecialist({
      agent: "it",
      user: USERS.bob,
      task: { taskId: "it1", instruction: "VPN is down." },
      llm,
      modelId: "fake",
      tracer: createTracer("t", (e) => rows.push(e)),
      skills: SKILLS
    });

    expect(llm.lastToolNames).toContain("load_skill");
    const loaded = rows.find((r) => r.event === "skill_loaded");
    expect(loaded?.detail).toMatchObject({ name: "troubleshooting" });
  });

  it("does not expose load_skill to an agent with no skills", async () => {
    const llm = createFakeLlmClient({
      steps: [
        {
          tool: "submit_result",
          input: { status: "ok", answer: "x", limitations: [], toolErrors: [] }
        }
      ]
    });
    // Only HR skills provided; the IT agent has none → no load_skill tool.
    await runSpecialist({
      agent: "it",
      user: USERS.bob,
      task: { taskId: "it1", instruction: "x" },
      llm,
      modelId: "fake",
      tracer: createTracer("t", () => {}),
      skills: [parseSkill(md("leave-request-process", "[hr]"))]
    });
    expect(llm.lastToolNames).not.toContain("load_skill");
  });

  it("load_skill refuses a skill outside the agent's scope", async () => {
    const rows: TraceEvent[] = [];
    const llm = createFakeLlmClient({
      steps: [
        { tool: "load_skill", input: { name: "leave-request-process" } },
        {
          tool: "submit_result",
          input: {
            status: "partial",
            answer: "could not load",
            limitations: ["skill not available"],
            toolErrors: []
          }
        }
      ]
    });
    // IT agent tries to load an HR skill; HR skill is also in the set but out of scope.
    const result = await runSpecialist({
      agent: "it",
      user: USERS.bob,
      task: { taskId: "it1", instruction: "x" },
      llm,
      modelId: "fake",
      tracer: createTracer("t", (e) => rows.push(e)),
      skills: SKILLS
    });
    // No skill_loaded emitted for the out-of-scope skill.
    expect(rows.some((r) => r.event === "skill_loaded")).toBe(false);
    expect(result.status).toBe("partial");
  });
});
