import { describe, expect, it } from "vitest";
import { computeWaves, parsePlan } from "../src/orchestration/plan";

const task = (id: string, dependsOn?: string[]) => ({
  id,
  agent: "it" as const,
  instruction: `do ${id}`,
  ...(dependsOn ? { dependsOn } : {})
});

describe("parsePlan — valid plans", () => {
  it("accepts a single-task plan with one wave", () => {
    const r = parsePlan({ tasks: [task("a")] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.waves).toEqual([["a"]]);
  });

  it("groups independent tasks into one wave, dependents into later waves", () => {
    const r = parsePlan({
      tasks: [task("a"), task("b"), task("c", ["a", "b"])]
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.waves).toEqual([["a", "b"], ["c"]]);
  });

  it("builds a 3-wave chain (scenario 8 shape: hr -> it -> hr)", () => {
    const r = parsePlan({
      tasks: [
        { id: "hr1", agent: "hr", instruction: "profile" },
        { id: "it1", agent: "it", instruction: "upgrade", dependsOn: ["hr1"] },
        { id: "hr2", agent: "hr", instruction: "validate", dependsOn: ["it1"] }
      ]
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.waves).toEqual([["hr1"], ["it1"], ["hr2"]]);
  });
});

describe("parsePlan — rejections", () => {
  it("rejects an empty task list (schema)", () => {
    const r = parsePlan({ tasks: [] });
    expect(r).toMatchObject({ ok: false, error: { code: "schema" } });
  });

  it("rejects more than MAX_TASKS (schema)", () => {
    const r = parsePlan({
      tasks: ["a", "b", "c", "d", "e"].map((i) => task(i))
    });
    expect(r).toMatchObject({ ok: false, error: { code: "schema" } });
  });

  it("rejects an unknown agent (schema)", () => {
    const r = parsePlan({
      tasks: [{ id: "a", agent: "legal", instruction: "x" }]
    });
    expect(r).toMatchObject({ ok: false, error: { code: "schema" } });
  });

  it("rejects duplicate ids", () => {
    const r = parsePlan({ tasks: [task("a"), task("a")] });
    expect(r).toMatchObject({ ok: false, error: { code: "duplicate_id" } });
  });

  it("rejects a dependency on an unknown task", () => {
    const r = parsePlan({ tasks: [task("a", ["ghost"])] });
    expect(r).toMatchObject({
      ok: false,
      error: { code: "unknown_dependency" }
    });
  });

  it("rejects a self-dependency", () => {
    const r = parsePlan({ tasks: [task("a", ["a"])] });
    expect(r).toMatchObject({ ok: false, error: { code: "self_dependency" } });
  });

  it("rejects a dependency cycle", () => {
    const r = parsePlan({ tasks: [task("a", ["b"]), task("b", ["a"])] });
    expect(r).toMatchObject({ ok: false, error: { code: "cycle" } });
  });
});

describe("computeWaves", () => {
  it("returns null on a cycle", () => {
    expect(computeWaves([task("a", ["b"]), task("b", ["a"])])).toBeNull();
  });
});
