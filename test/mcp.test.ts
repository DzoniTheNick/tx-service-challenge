import { describe, expect, it } from "vitest";
import { USERS } from "../src/identity";
import { createFakeLlmClient } from "../src/llm";
import { createTracer, type TraceEvent } from "../src/trace";
import {
  discoverMcpTools,
  parseMcpContent,
  withTimeout,
  type McpToolRef
} from "../src/mcp/client";
import { runSpecialist } from "../src/agents/specialists";

const tracerInto = (rows: TraceEvent[]) =>
  createTracer("turn-mcp", (e) => rows.push(e));

const refs = (...names: string[]): McpToolRef[] =>
  names.map((name) => ({ name, serverId: "acme" }));

describe("withTimeout", () => {
  it("resolves a fast promise", async () => {
    await expect(withTimeout(Promise.resolve(7), 50)).resolves.toBe(7);
  });
  it("rejects a slow promise", async () => {
    const slow = new Promise((r) => setTimeout(r, 100));
    await expect(withTimeout(slow, 20)).rejects.toThrow(/mcp_timeout/);
  });
});

describe("discoverMcpTools — filtering", () => {
  it("keeps only known MCP tools and ignores the rest", async () => {
    const rows: TraceEvent[] = [];
    const disc = await discoverMcpTools({
      tracer: tracerInto(rows),
      listTools: async () =>
        refs("search_policies", "read_policy", "ping", "evil_tool"),
      call: async () => ({ ok: true })
    });
    expect(disc.status).toBe("connected");
    expect(Object.keys(disc.tools).sort()).toEqual([
      "read_policy",
      "search_policies"
    ]);
    const ev = rows.find((r) => r.event === "mcp_discovery");
    expect(ev?.detail).toMatchObject({ ok: true, toolCount: 2 });
  });
});

describe("discoverMcpTools — graceful degradation (scenario 7)", () => {
  it("returns an empty tool set and traces an error when listing fails", async () => {
    const rows: TraceEvent[] = [];
    const disc = await discoverMcpTools({
      tracer: tracerInto(rows),
      listTools: async () => {
        throw new Error("connection refused");
      },
      call: async () => ({})
    });
    expect(disc.status).toBe("unavailable");
    expect(disc.tools).toEqual({});
    const ev = rows.find((r) => r.event === "mcp_discovery");
    expect(ev?.detail).toMatchObject({ ok: false });
    expect(String(ev?.detail.error)).toMatch(/connection refused/);
  });
});

describe("discoverMcpTools — per-call timeout surfaces as a tool error", () => {
  it("an MCP tool that hangs past the timeout becomes a specialist tool error", async () => {
    // HR specialist gets a discovered search_policies whose call never resolves.
    const disc = await discoverMcpTools({
      tracer: createTracer("t", () => {}),
      timeoutMs: 20,
      listTools: async () => refs("search_policies"),
      call: () => new Promise(() => {}) // never settles
    });

    const llm = createFakeLlmClient({
      steps: [
        { tool: "search_policies", input: { query: "leave" } },
        {
          tool: "submit_result",
          input: {
            status: "partial",
            answer: "Policy lookup is currently unavailable.",
            limitations: ["policy search timed out"],
            toolErrors: []
          }
        }
      ]
    });

    const result = await runSpecialist({
      agent: "hr",
      user: USERS.alice,
      task: { taskId: "hr1", instruction: "Find the leave policy." },
      llm,
      modelId: "fake",
      tracer: createTracer("t", () => {}),
      mcpTools: disc.tools
    });

    expect(result.toolErrors.join(" ")).toMatch(
      /search_policies:.*mcp_timeout/
    );
    expect(result.status).toBe("partial");
  });

  it("exposes discovered MCP tools to HR but not IT (permission scope)", async () => {
    const disc = await discoverMcpTools({
      tracer: createTracer("t", () => {}),
      listTools: async () => refs("search_policies", "search_it_kb"),
      call: async () => ({ ok: true, results: [] })
    });

    const hr = createFakeLlmClient({
      steps: [
        {
          tool: "submit_result",
          input: { status: "ok", answer: "x", limitations: [], toolErrors: [] }
        }
      ]
    });
    await runSpecialist({
      agent: "hr",
      user: USERS.alice,
      task: { taskId: "hr1", instruction: "x" },
      llm: hr,
      modelId: "fake",
      tracer: createTracer("t", () => {}),
      mcpTools: disc.tools
    });
    // HR may use search_policies (its scope) but not search_it_kb (IT scope).
    expect(hr.lastToolNames).toContain("search_policies");
    expect(hr.lastToolNames).not.toContain("search_it_kb");
  });
});

describe("parseMcpContent", () => {
  it("JSON-parses the first text content part", () => {
    const result = {
      content: [{ type: "text", text: JSON.stringify({ ok: true, n: 1 }) }]
    };
    expect(parseMcpContent(result)).toEqual({ ok: true, n: 1 });
  });
  it("falls back to raw text when not JSON", () => {
    expect(parseMcpContent({ content: [{ type: "text", text: "pong" }] })).toBe(
      "pong"
    );
  });
});
