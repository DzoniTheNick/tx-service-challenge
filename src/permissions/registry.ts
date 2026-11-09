/**
 * Tool registry: the single declarative source of which tools exist and who may
 * use them (CONTEXT.md §4 "Capability matrix"). Each descriptor declares the
 * user `roles` and the `agents` that expose it; `allowedTools()` (see
 * ./allowed.ts) is the only place this is interpreted. Discovery of MCP tools
 * runs this same filter — discovery never bypasses permissions.
 */

import type { Role } from "../identity";

/** The two specialist agents. The orchestrator itself is not an AgentId. */
export type AgentId = "it" | "hr";

export const AGENT_IDS: readonly AgentId[] = ["it", "hr"];

/** Where a tool comes from — used for wiring, not for permission logic. */
export type ToolKind = "native" | "mcp" | "load_skill";

export interface ToolDescriptor {
  readonly name: string;
  readonly kind: ToolKind;
  /** User roles permitted to use the tool (user-level gate). */
  readonly roles: readonly Role[];
  /** Agents that expose the tool (agent-scope gate). */
  readonly agents: readonly AgentId[];
  /** One-line description, surfaced to specialists and the trace. */
  readonly description: string;
}

const ALL_ROLES: readonly Role[] = ["employee", "it_admin"];

/**
 * The capability matrix as data. Exactly mirrors the table in CONTEXT.md §4:
 *
 *   capability            kind    employee it_admin  IT   HR
 *   get_service_status    native     ✓        ✓       ✓    ✗
 *   reset_password        native     ✗        ✓       ✓    ✗
 *   load_skill            native     ✓        ✓       ✓    ✓
 *   search_policies       mcp        ✓        ✓       ✗    ✓
 *   read_policy           mcp        ✓        ✓       ✗    ✓
 *   get_equipment_profile mcp        ✓        ✓       ✗    ✓
 *   search_it_kb          mcp        ✓        ✓       ✓    ✗
 *
 * Two kinds of difference are deliberately encoded: a user-level one
 * (`reset_password`, it_admin only) and agent-level ones (policy/equipment
 * tools HR-only vs `get_service_status`/`search_it_kb` IT-only).
 */
export const TOOL_REGISTRY: readonly ToolDescriptor[] = [
  {
    name: "get_service_status",
    kind: "native",
    roles: ALL_ROLES,
    agents: ["it"],
    description: "Get the operational status of an internal IT service."
  },
  {
    name: "reset_password",
    kind: "native",
    roles: ["it_admin"],
    agents: ["it"],
    description: "Reset a user's password (mock; no approval flow in the MVP)."
  },
  {
    name: "load_skill",
    kind: "load_skill",
    roles: ALL_ROLES,
    agents: ["it", "hr"],
    description:
      "Load an agent-scoped skill (procedure) by name before answering."
  },
  {
    name: "search_policies",
    kind: "mcp",
    roles: ALL_ROLES,
    agents: ["hr"],
    description: "Search company HR/policy documents by keyword and tag."
  },
  {
    name: "read_policy",
    kind: "mcp",
    roles: ALL_ROLES,
    agents: ["hr"],
    description: "Read the full text of a policy document by id."
  },
  {
    name: "get_equipment_profile",
    kind: "mcp",
    roles: ALL_ROLES,
    agents: ["hr"],
    description: "Get the standard equipment profile for a given role."
  },
  {
    name: "search_it_kb",
    kind: "mcp",
    roles: ALL_ROLES,
    agents: ["it"],
    description: "Search the IT knowledge base for troubleshooting articles."
  }
] as const;

/** Look up a descriptor by tool name (e.g. to re-check before executing). */
export function findTool(name: string): ToolDescriptor | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name);
}
