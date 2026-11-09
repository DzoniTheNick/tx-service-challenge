/**
 * MCP client logic (CONTEXT.md §5) — discovery, permission-aware filtering, the
 * 5 s per-call timeout, and graceful degradation. Kept free of the agents-SDK
 * connection so it is fully unit-testable with fakes; the orchestrator supplies
 * the `listTools`/`call` adapters over `this.mcp`.
 *
 * Degradation is first-class: a connect/discovery failure, or a server in
 * error/timeout mode, must never throw across the turn. On failure the MCP tools
 * are simply absent and a `mcp_discovery` trace row records the error outcome —
 * the orchestrator then answers honestly ("policy lookup is unavailable").
 */

import { z } from "zod";
import { LIMITS } from "../config";
import type { SpecialistTool, SpecialistToolMap } from "../llm";
import type { Tracer } from "../trace";
import { TOOL_REGISTRY } from "../permissions/registry";

/** A tool as advertised by a connected MCP server. */
export interface McpToolRef {
  readonly name: string;
  readonly serverId: string;
}

export interface DiscoverMcpDeps {
  /** List the connected server's tools (may reject → degradation). */
  readonly listTools: () => Promise<McpToolRef[]>;
  /** Invoke one tool; the implementation owns the transport + MCP-level timeout. */
  readonly call: (
    ref: McpToolRef,
    args: Record<string, unknown>
  ) => Promise<unknown>;
  readonly tracer: Tracer;
  readonly timeoutMs?: number;
}

export interface McpDiscovery {
  readonly status: "connected" | "unavailable";
  readonly tools: SpecialistToolMap;
  readonly toolCount: number;
}

/** The set of tool names the registry marks as MCP-provided. */
const MCP_TOOL_NAMES = new Set(
  TOOL_REGISTRY.filter((t) => t.kind === "mcp").map((t) => t.name)
);

/** Client-side input schemas for the MCP tools (the server re-validates too). */
const MCP_INPUT_SCHEMAS: Record<string, z.ZodType<unknown>> = {
  search_policies: z.object({ query: z.string() }),
  read_policy: z.object({ id: z.string() }),
  get_equipment_profile: z.object({ role: z.string() }),
  search_it_kb: z.object({ query: z.string() })
};

/** Reject if `promise` has not settled within `ms` (CONTEXT.md §3.3, §5). */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`mcp_timeout after ${ms}ms`)),
      ms
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function buildMcpTool(
  ref: McpToolRef,
  call: DiscoverMcpDeps["call"],
  timeoutMs: number
): SpecialistTool {
  const descriptor = TOOL_REGISTRY.find((t) => t.name === ref.name);
  return {
    description: descriptor?.description ?? `MCP tool ${ref.name}`,
    inputSchema:
      MCP_INPUT_SCHEMAS[ref.name] ?? z.record(z.string(), z.unknown()),
    execute: async (input) =>
      withTimeout(call(ref, input as Record<string, unknown>), timeoutMs)
  };
}

/**
 * Discover the MCP tools and turn the known ones into {@link SpecialistTool}s.
 * Unknown tool names are ignored (discovery never widens the permission surface).
 * Any failure degrades to `unavailable` with an empty tool set.
 */
export async function discoverMcpTools(
  deps: DiscoverMcpDeps
): Promise<McpDiscovery> {
  const timeoutMs = deps.timeoutMs ?? LIMITS.MCP_TIMEOUT_MS;
  try {
    const refs = await deps.listTools();
    const known = refs.filter((r) => MCP_TOOL_NAMES.has(r.name));
    const tools: SpecialistToolMap = {};
    for (const ref of known) {
      tools[ref.name] = buildMcpTool(ref, deps.call, timeoutMs);
    }
    deps.tracer.emit("orchestrator", "mcp_discovery", {
      ok: true,
      toolCount: known.length,
      tools: known.map((r) => r.name)
    });
    return { status: "connected", tools, toolCount: known.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.tracer.emit("orchestrator", "mcp_discovery", {
      ok: false,
      error: message
    });
    return { status: "unavailable", tools: {}, toolCount: 0 };
  }
}

/**
 * Parse an MCP tool result's content into a plain value. MCP returns
 * `{ content: [{ type:"text", text }] }`; we JSON-parse the first text part so
 * the specialist model receives structured data, falling back to raw text.
 */
export function parseMcpContent(result: unknown): unknown {
  const content = (result as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    const first = content.find(
      (c): c is { type: string; text: string } =>
        typeof c === "object" &&
        c !== null &&
        (c as { type?: string }).type === "text"
    );
    if (first) {
      try {
        return JSON.parse(first.text);
      } catch {
        return first.text;
      }
    }
  }
  return result;
}
