/**
 * `allowedTools()` — the single pure permission function (CONTEXT.md §4).
 *
 * A tool is exposed to a specialist only if BOTH gates pass:
 *   user.role ∈ tool.roles   (user-level gate)
 *   agent    ∈ tool.agents   (agent-scope gate)
 *
 * This is applied uniformly to native tools, `load_skill`, and MCP tools *after*
 * discovery — discovery never bypasses permissions. The function is side-effect
 * free and fully unit-tested; callers (the specialist runner) emit the
 * `permission_check` / `permission_resolved` trace events from its result.
 */

import type { User } from "../identity";
import type { AgentId, ToolDescriptor } from "./registry";
import { TOOL_REGISTRY } from "./registry";

export type DenyReason = "user_role" | "agent_scope";

export interface DeniedTool {
  readonly name: string;
  readonly reason: DenyReason;
}

export interface AllowedToolsResult {
  readonly allowed: ToolDescriptor[];
  readonly denied: DeniedTool[];
}

/**
 * Partition the tool catalog for a (user, agent) pair.
 *
 * When a tool fails both gates we report `user_role`: lacking the role is the
 * more fundamental denial (the user could not use the tool through any agent),
 * and the choice is deterministic so the trace is stable.
 *
 * @param all defaults to the full {@link TOOL_REGISTRY}; pass a subset (e.g.
 *   native + discovered MCP tools actually present) to filter just those.
 */
export function allowedTools(
  user: User,
  agent: AgentId,
  all: readonly ToolDescriptor[] = TOOL_REGISTRY
): AllowedToolsResult {
  const allowed: ToolDescriptor[] = [];
  const denied: DeniedTool[] = [];

  for (const tool of all) {
    const roleOk = tool.roles.includes(user.role);
    const agentOk = tool.agents.includes(agent);

    if (roleOk && agentOk) {
      allowed.push(tool);
    } else if (!roleOk) {
      denied.push({ name: tool.name, reason: "user_role" });
    } else {
      denied.push({ name: tool.name, reason: "agent_scope" });
    }
  }

  return { allowed, denied };
}
