import { describe, expect, it } from "vitest";
import { USERS } from "../src/identity";
import { createFakeLlmClient } from "../src/llm";
import { createTracer, type TraceEvent } from "../src/trace";
import { parsePlan, type Plan } from "../src/orchestration/plan";
import {
  runExecutor,
  type RunTask,
  type RunTaskArgs
} from "../src/orchestration/executor";
import type { SpecialistResult } from "../src/agents/contract";

const bob = USERS.bob;
const llm = createFakeLlmClient(); // never actually invoked when runTask is injected

function fixtures(input: unknown) {
  const parsed = parsePlan(input);
  if (!parsed.ok) throw new Error(`bad fixture plan: ${parsed.error.code}`);
  return parsed;
}

function ok(
  args: RunTaskArgs,
  extra: Partial<SpecialistResult> = {}
): SpecialistResult {
  return {
    taskId: args.task.taskId,
    agent: args.agent,
    status: "ok",
    answer: `${args.task.taskId} done`,
    limitations: [],
    toolErrors: [],
    ...extra
  };
}

function run(
  plan: Plan,
  waves: string[][],
  runTask: RunTask,
  rows: TraceEvent[] = []
) {
  return runExecutor({
    plan,
    waves,
    user: bob,
    llm,
    modelId: "fake",
    tracer: createTracer("turn-exec", (e) => rows.push(e)),
    runTask
  });
}

describe("executor — parallel execution (same wave overlaps)", () => {
  it("runs same-wave tasks concurrently and a dependent task strictly after", async () => {
    const intervals: Record<string, { start: number; end: number }> = {};
    const runTask: RunTask = async (args) => {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, 40));
      const end = Date.now();
      intervals[args.task.taskId] = { start, end };
      return ok(args);
    };

    const { plan, waves } = fixtures({
      tasks: [
        { id: "a", agent: "it", instruction: "x" },
        { id: "b", agent: "hr", instruction: "y" },
        { id: "c", agent: "it", instruction: "z", dependsOn: ["a", "b"] }
      ]
    });
    await run(plan, waves, runTask);

    // a and b share wave 0 → their intervals overlap.
    expect(intervals.a.start).toBeLessThan(intervals.b.end);
    expect(intervals.b.start).toBeLessThan(intervals.a.end);
    // c is in wave 1 → starts only after both wave-0 tasks finished.
    expect(intervals.c.start).toBeGreaterThanOrEqual(
      Math.max(intervals.a.end, intervals.b.end)
    );
  });
});

describe("executor — dependency passing", () => {
  it("injects an upstream result into the dependent task and emits result_passed", async () => {
    const seen: Record<string, RunTaskArgs["task"]["inputs"]> = {};
    const runTask: RunTask = async (args) => {
      seen[args.task.taskId] = args.task.inputs;
      return ok(
        args,
        args.task.taskId === "a" ? { data: { profile: 42 } } : {}
      );
    };
    const rows: TraceEvent[] = [];
    const { plan, waves } = fixtures({
      tasks: [
        { id: "a", agent: "hr", instruction: "x" },
        { id: "b", agent: "it", instruction: "y", dependsOn: ["a"] }
      ]
    });
    const result = await run(plan, waves, runTask, rows);

    expect(seen.a).toBeUndefined(); // no deps → no inputs
    expect(seen.b?.a?.data).toEqual({ profile: 42 }); // a's result injected into b
    expect(rows.find((r) => r.event === "result_passed")?.detail).toMatchObject(
      {
        from: "a",
        to: "b"
      }
    );
    expect(result.allFailed).toBe(false);
  });
});

describe("executor — failure propagation", () => {
  it("fails dependents of a failed task without running them, transitively", async () => {
    const ran: string[] = [];
    const runTask: RunTask = async (args) => {
      ran.push(args.task.taskId);
      if (args.task.taskId === "a") {
        return {
          ...ok(args),
          status: "failed",
          answer: "",
          limitations: ["boom"]
        };
      }
      return ok(args);
    };
    const { plan, waves } = fixtures({
      tasks: [
        { id: "a", agent: "it", instruction: "x" },
        { id: "b", agent: "it", instruction: "y", dependsOn: ["a"] },
        { id: "c", agent: "hr", instruction: "z", dependsOn: ["b"] }
      ]
    });
    const result = await run(plan, waves, runTask);

    expect(ran).toEqual(["a"]); // b and c never run
    expect(result.byId.b.status).toBe("failed");
    expect(result.byId.b.limitations[0]).toMatch(/dependency_failed: a/);
    expect(result.byId.c.status).toBe("failed");
    expect(result.byId.c.limitations[0]).toMatch(/dependency_failed: b/);
  });

  it("one failure does not abort a sibling in the same wave", async () => {
    const runTask: RunTask = async (args) =>
      args.task.taskId === "a"
        ? { ...ok(args), status: "failed", limitations: ["boom"] }
        : ok(args);
    const { plan, waves } = fixtures({
      tasks: [
        { id: "a", agent: "it", instruction: "x" },
        { id: "b", agent: "hr", instruction: "y" }
      ]
    });
    const result = await run(plan, waves, runTask);
    expect(result.byId.a.status).toBe("failed");
    expect(result.byId.b.status).toBe("ok");
    expect(result.allFailed).toBe(false);
  });
});

describe("executor — all-failed guard", () => {
  it("sets guardNotice and emits guard_applied when every task fails", async () => {
    const runTask: RunTask = async (args) => ({
      ...ok(args),
      status: "failed",
      limitations: ["boom"]
    });
    const rows: TraceEvent[] = [];
    const { plan, waves } = fixtures({
      tasks: [
        { id: "a", agent: "it", instruction: "x" },
        { id: "b", agent: "hr", instruction: "y" }
      ]
    });
    const result = await run(plan, waves, runTask, rows);

    expect(result.allFailed).toBe(true);
    expect(result.guardNotice).toMatch(/do not claim/i);
    expect(rows.some((r) => r.event === "guard_applied")).toBe(true);
  });

  it("does not guard when at least one task succeeds", async () => {
    const runTask: RunTask = async (args) =>
      args.task.taskId === "a"
        ? { ...ok(args), status: "failed", limitations: ["boom"] }
        : ok(args);
    const { plan, waves } = fixtures({
      tasks: [
        { id: "a", agent: "it", instruction: "x" },
        { id: "b", agent: "hr", instruction: "y" }
      ]
    });
    const result = await run(plan, waves, runTask);
    expect(result.allFailed).toBe(false);
    expect(result.guardNotice).toBeUndefined();
  });
});

describe("executor — a stray throw becomes a failed result, not a turn abort", () => {
  it("captures a thrown runTask error", async () => {
    const runTask: RunTask = async (args) => {
      if (args.task.taskId === "a") throw new Error("kaboom");
      return ok(args);
    };
    const { plan, waves } = fixtures({
      tasks: [
        { id: "a", agent: "it", instruction: "x" },
        { id: "b", agent: "hr", instruction: "y" }
      ]
    });
    const result = await run(plan, waves, runTask);
    expect(result.byId.a.status).toBe("failed");
    expect(result.byId.a.limitations[0]).toMatch(/executor error: kaboom/);
    expect(result.byId.b.status).toBe("ok");
  });
});
