import { describe, expect, it } from "vitest";
import { USERS } from "../src/identity";
import { allowedTools } from "../src/permissions/allowed";
import type { DenyReason } from "../src/permissions/allowed";
import {
  TOOL_REGISTRY,
  findTool,
  type AgentId
} from "../src/permissions/registry";

const alice = USERS.alice; // employee
const bob = USERS.bob; // it_admin

/** Convenience: names the (user, agent) pair is allowed to use. */
function allowedNames(user: typeof alice, agent: AgentId): string[] {
  return allowedTools(user, agent)
    .allowed.map((t) => t.name)
    .sort();
}

/** Convenience: deny reason for one tool, or undefined if it was allowed. */
function denyReason(
  user: typeof alice,
  agent: AgentId,
  name: string
): DenyReason | undefined {
  return allowedTools(user, agent).denied.find((d) => d.name === name)?.reason;
}

describe("allowedTools — user-level difference (reset_password)", () => {
  it("denies reset_password to an employee on the IT agent (user_role)", () => {
    expect(denyReason(alice, "it", "reset_password")).toBe("user_role");
    expect(allowedNames(alice, "it")).not.toContain("reset_password");
  });

  it("allows reset_password to an it_admin on the IT agent", () => {
    expect(denyReason(bob, "it", "reset_password")).toBeUndefined();
    expect(allowedNames(bob, "it")).toContain("reset_password");
  });

  it("is the ONLY tool that differs between employee and it_admin on IT", () => {
    const empl = new Set(allowedNames(alice, "it"));
    const admin = new Set(allowedNames(bob, "it"));
    const extra = [...admin].filter((n) => !empl.has(n));
    expect(extra).toEqual(["reset_password"]);
  });
});

describe("allowedTools — agent-level differences (scope)", () => {
  it("exposes get_service_status on IT but not HR (agent_scope)", () => {
    expect(allowedNames(bob, "it")).toContain("get_service_status");
    expect(denyReason(bob, "hr", "get_service_status")).toBe("agent_scope");
  });

  it("exposes search_it_kb on IT but not HR (agent_scope)", () => {
    expect(allowedNames(alice, "it")).toContain("search_it_kb");
    expect(denyReason(alice, "hr", "search_it_kb")).toBe("agent_scope");
  });

  it("exposes policy/equipment tools on HR but not IT (agent_scope)", () => {
    for (const name of [
      "search_policies",
      "read_policy",
      "get_equipment_profile"
    ]) {
      expect(allowedNames(alice, "hr")).toContain(name);
      expect(denyReason(alice, "it", name)).toBe("agent_scope");
    }
  });

  it("load_skill is available to both agents and both roles", () => {
    for (const agent of ["it", "hr"] as const) {
      expect(allowedNames(alice, agent)).toContain("load_skill");
      expect(allowedNames(bob, agent)).toContain("load_skill");
    }
  });
});

describe("allowedTools — full partition matches the CONTEXT §4 matrix", () => {
  it("employee on IT", () => {
    expect(allowedNames(alice, "it")).toEqual([
      "get_service_status",
      "load_skill",
      "search_it_kb"
    ]);
  });

  it("it_admin on IT", () => {
    expect(allowedNames(bob, "it")).toEqual([
      "get_service_status",
      "load_skill",
      "reset_password",
      "search_it_kb"
    ]);
  });

  it("employee on HR", () => {
    expect(allowedNames(alice, "hr")).toEqual([
      "get_equipment_profile",
      "load_skill",
      "read_policy",
      "search_policies"
    ]);
  });

  it("it_admin on HR (role grants nothing HR-specific beyond employee)", () => {
    expect(allowedNames(bob, "hr")).toEqual(allowedNames(alice, "hr"));
  });

  it("allowed + denied always partitions the whole catalog with no overlap", () => {
    for (const user of [alice, bob]) {
      for (const agent of ["it", "hr"] as const) {
        const { allowed, denied } = allowedTools(user, agent);
        expect(allowed.length + denied.length).toBe(TOOL_REGISTRY.length);
        const names = new Set([
          ...allowed.map((t) => t.name),
          ...denied.map((d) => d.name)
        ]);
        expect(names.size).toBe(TOOL_REGISTRY.length);
      }
    }
  });
});

describe("allowedTools — filtering a subset (post-MCP-discovery)", () => {
  it("only partitions the tools it is handed", () => {
    const subset = [findTool("get_service_status")!, findTool("read_policy")!];
    const { allowed, denied } = allowedTools(bob, "it", subset);
    expect(allowed.map((t) => t.name)).toEqual(["get_service_status"]);
    expect(denied).toEqual([{ name: "read_policy", reason: "agent_scope" }]);
  });
});
