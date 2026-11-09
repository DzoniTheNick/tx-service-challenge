import { describe, expect, it } from "vitest";
import { USERS } from "../src/identity";
import { createFakeLlmClient, type LlmClient } from "../src/llm";
import { runSpecialist, type SpecialistTask } from "../src/agents/specialists";
import { createTracer, type TraceEvent } from "../src/trace";
import type { AgentId } from "../src/permissions/registry";

const alice = USERS.alice; // employee
const bob = USERS.bob; // it_admin

function tracerInto(rows: TraceEvent[]) {
  return createTracer("turn-test", (e) => rows.push(e));
}

function task(overrides: Partial<SpecialistTask> = {}): SpecialistTask {
  return { taskId: "it1", instruction: "Help the user.", ...overrides };
}

describe("runSpecialist — ok path", () => {
  it("uses a native tool then returns a structured ok result", async () => {
    const rows: TraceEvent[] = [];
    const llm = createFakeLlmClient({
      steps: [
        { tool: "get_service_status", input: { service: "vpn" } },
        {
          tool: "submit_result",
          input: {
            status: "ok",
            answer: "The VPN is operational.",
            limitations: [],
            toolErrors: []
          }
        }
      ]
    });

    const result = await runSpecialist({
      agent: "it",
      user: bob,
      task: task(),
      llm,
      modelId: "fake",
      tracer: tracerInto(rows)
    });

    expect(result).toMatchObject({
      taskId: "it1",
      agent: "it",
      status: "ok",
      answer: "The VPN is operational.",
      toolErrors: []
    });

    // Identity fields are stamped by code, never taken from the model input.
    expect(result.agent).toBe("it");

    const events = rows.map((r) => r.event);
    expect(events).toContain("specialist_start");
    expect(events).toContain("permission_check");
    expect(events).toContain("specialist_end");
    const toolCall = rows.find((r) => r.event === "tool_call");
    expect(toolCall?.detail).toMatchObject({
      name: "get_service_status",
      ok: true
    });
    expect(toolCall?.detail.duration_ms).toBeTypeOf("number");
  });
});

describe("runSpecialist — denied tool", () => {
  it("does not expose reset_password to an employee (user_role deny)", async () => {
    const rows: TraceEvent[] = [];
    const llm = createFakeLlmClient({
      steps: [
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
      user: alice,
      task: task(),
      llm,
      modelId: "fake",
      tracer: tracerInto(rows)
    });

    // The model was never handed reset_password.
    expect(llm.lastToolNames).not.toContain("reset_password");
    expect(llm.lastToolNames).toContain("get_service_status");
    expect(llm.lastToolNames).toContain("submit_result");

    const check = rows.find((r) => r.event === "permission_check");
    const denied = check?.detail.denied as { name: string; reason: string }[];
    expect(denied).toContainEqual({
      name: "reset_password",
      reason: "user_role"
    });
  });

  it("exposes reset_password to an it_admin", async () => {
    const llm = createFakeLlmClient({
      steps: [
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
      user: bob,
      task: task(),
      llm,
      modelId: "fake",
      tracer: createTracer("t", () => {})
    });
    expect(llm.lastToolNames).toContain("reset_password");
  });

  it("surfaces a tool error when the model calls an unavailable tool", async () => {
    // Employee on IT: the model (mis)fires reset_password, which is not exposed.
    const llm = createFakeLlmClient({
      steps: [
        { tool: "reset_password", input: { user: "alice" } },
        {
          tool: "submit_result",
          input: {
            status: "partial",
            answer: "I could not reset the password.",
            limitations: ["password reset is not available to this user"],
            toolErrors: []
          }
        }
      ]
    });
    const result = await runSpecialist({
      agent: "it",
      user: alice,
      task: task(),
      llm,
      modelId: "fake",
      tracer: createTracer("t", () => {})
    });
    // The unavailable call is recorded by the fake as an error tool call; the
    // specialist still returns the model's honest partial result.
    expect(result.status).toBe("partial");
    expect(result.limitations.join(" ")).toMatch(/not available/i);
  });
});

describe("runSpecialist — timeout", () => {
  it("returns a failed result when the model hangs past the timeout", async () => {
    const rows: TraceEvent[] = [];
    const llm = createFakeLlmClient({ hang: true });

    const result = await runSpecialist({
      agent: "hr",
      user: alice,
      task: { taskId: "hr1", instruction: "Look up the leave policy." },
      llm,
      modelId: "fake",
      tracer: tracerInto(rows),
      timeoutMs: 20
    });

    expect(result.status).toBe("failed");
    expect(result.limitations.join(" ")).toMatch(/timed out/i);
    const end = rows.find((r) => r.event === "specialist_end");
    expect(end?.detail.status).toBe("failed");
  });

  it("returns a failed result when the model errors", async () => {
    const llm = createFakeLlmClient({ error: new Error("provider exploded") });
    const result = await runSpecialist({
      agent: "it",
      user: bob,
      task: task(),
      llm,
      modelId: "fake",
      tracer: createTracer("t", () => {})
    });
    expect(result.status).toBe("failed");
    expect(result.limitations.join(" ")).toMatch(/provider exploded/);
  });
});

describe("runSpecialist — retries (allow retries)", () => {
  const ok = {
    status: "ok",
    answer: "recovered",
    limitations: [],
    toolErrors: []
  };

  it("retries a transient error and succeeds on the next attempt", async () => {
    let calls = 0;
    const llm: LlmClient = {
      async complete(params) {
        calls++;
        if (calls === 1) throw new Error("transient boom");
        await params.tools.submit_result.execute(ok);
        return { text: "", toolCalls: [], finishReason: "stop" };
      }
    };
    const rows: TraceEvent[] = [];
    const result = await runSpecialist({
      agent: "it",
      user: bob,
      task: task(),
      llm,
      modelId: "fake",
      tracer: tracerInto(rows)
    });
    expect(calls).toBe(2);
    expect(result.status).toBe("ok");
    expect(result.answer).toBe("recovered");
    expect(rows.some((r) => r.event === "specialist_retry")).toBe(true);
  });

  it("does NOT retry a model-returned failure (a decision, not transient)", async () => {
    let calls = 0;
    const llm: LlmClient = {
      async complete(params) {
        calls++;
        await params.tools.submit_result.execute({
          status: "failed",
          answer: "",
          limitations: ["no can do"],
          toolErrors: []
        });
        return { text: "", toolCalls: [], finishReason: "stop" };
      }
    };
    const result = await runSpecialist({
      agent: "it",
      user: bob,
      task: task(),
      llm,
      modelId: "fake",
      tracer: createTracer("t", () => {})
    });
    expect(calls).toBe(1);
    expect(result.status).toBe("failed");
  });

  it("honors maxAttempts=1 (retries off)", async () => {
    let calls = 0;
    const llm: LlmClient = {
      async complete() {
        calls++;
        throw new Error("boom");
      }
    };
    const result = await runSpecialist({
      agent: "it",
      user: bob,
      task: task(),
      llm,
      modelId: "fake",
      maxAttempts: 1,
      tracer: createTracer("t", () => {})
    });
    expect(calls).toBe(1);
    expect(result.status).toBe("failed");
  });
});

describe("runSpecialist — no structured result", () => {
  it("wraps a plain-text finish as partial", async () => {
    const llm = createFakeLlmClient({ finalText: "here is some prose" });
    const result = await runSpecialist({
      agent: "it",
      user: bob,
      task: task(),
      llm,
      modelId: "fake",
      tracer: createTracer("t", () => {})
    });
    expect(result.status).toBe("partial");
    // The free-text answer is surfaced rather than dropped.
    expect(result.answer).toBe("here is some prose");
    expect(result.limitations).toContain(
      "specialist answered in free text without calling submit_result"
    );
  });
});

describe("runSpecialist — dependency inputs", () => {
  it("folds upstream structured inputs into the prompt", async () => {
    const llm = createFakeLlmClient({
      steps: [
        {
          tool: "submit_result",
          input: { status: "ok", answer: "ok", limitations: [], toolErrors: [] }
        }
      ]
    });
    const agent: AgentId = "it";
    await runSpecialist({
      agent,
      user: bob,
      task: {
        taskId: "it1",
        instruction: "Recommend an upgrade.",
        inputs: {
          hr1: {
            taskId: "hr1",
            agent: "hr",
            status: "ok",
            answer: "profile attached",
            data: { role: "engineer", laptop: { model: "X1" } },
            limitations: [],
            toolErrors: []
          }
        }
      },
      llm,
      modelId: "fake",
      tracer: createTracer("t", () => {})
    });
    const prompt = llm.calls[0].prompt;
    expect(prompt).toMatch(/Recommend an upgrade/);
    expect(prompt).toMatch(/engineer/);
    expect(prompt).toMatch(/X1/);
  });
});
