/**
 * Delegation plan: schema, validation, and wave computation (CONTEXT.md §3.1).
 *
 * The orchestrator LLM emits a plan via the `delegate` tool. Code — never the
 * model — validates it (known agents, unique ids, existing deps, no cycles, ≤ 4
 * tasks) and computes the execution waves. All of this is pure and unit-tested;
 * invalid plans become typed errors, never thrown exceptions (CONTEXT.md §14).
 */

import { z } from "zod";
import { LIMITS } from "../config";
import { AGENT_IDS } from "../permissions/registry";

export const planTaskSchema = z.object({
  id: z.string().min(1),
  agent: z.enum(AGENT_IDS),
  /** Self-contained; specialists never see the user chat (CONTEXT.md §3.1). */
  instruction: z.string().min(1),
  dependsOn: z.array(z.string()).optional()
});
export type PlanTask = z.infer<typeof planTaskSchema>;

export const planSchema = z.object({
  tasks: z.array(planTaskSchema).min(1).max(LIMITS.MAX_TASKS)
});
export type Plan = z.infer<typeof planSchema>;

export type PlanErrorCode =
  | "schema"
  | "duplicate_id"
  | "unknown_dependency"
  | "self_dependency"
  | "cycle";

export interface PlanError {
  readonly code: PlanErrorCode;
  readonly message: string;
}

export type ParsePlanResult =
  | { readonly ok: true; readonly plan: Plan; readonly waves: string[][] }
  | { readonly ok: false; readonly error: PlanError };

/**
 * Topological levels via Kahn's algorithm: each wave is the set of still-unresolved
 * tasks whose dependencies are all resolved, in plan order. Returns `null` if a
 * cycle (or self-loop) leaves tasks that can never resolve.
 */
export function computeWaves(tasks: readonly PlanTask[]): string[][] | null {
  const ids = tasks.map((t) => t.id);
  const deps = new Map(
    ids.map((id, i) => [id, new Set(tasks[i].dependsOn ?? [])])
  );
  const resolved = new Set<string>();
  const waves: string[][] = [];

  while (resolved.size < ids.length) {
    const wave = ids.filter(
      (id) =>
        !resolved.has(id) &&
        [...(deps.get(id) ?? [])].every((d) => resolved.has(d))
    );
    if (wave.length === 0) return null; // cycle / self-loop
    for (const id of wave) resolved.add(id);
    waves.push(wave);
  }
  return waves;
}

/**
 * Parse and fully validate an untrusted plan (the `delegate` tool input).
 * On success returns the typed plan plus its execution waves.
 */
export function parsePlan(input: unknown): ParsePlanResult {
  const parsed = planSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "schema",
        message: parsed.error.issues[0]?.message ?? "invalid plan"
      }
    };
  }
  const plan = parsed.data;
  const ids = new Set<string>();
  for (const t of plan.tasks) {
    if (ids.has(t.id)) {
      return {
        ok: false,
        error: { code: "duplicate_id", message: `duplicate task id: ${t.id}` }
      };
    }
    ids.add(t.id);
  }
  for (const t of plan.tasks) {
    for (const d of t.dependsOn ?? []) {
      if (d === t.id) {
        return {
          ok: false,
          error: {
            code: "self_dependency",
            message: `task ${t.id} depends on itself`
          }
        };
      }
      if (!ids.has(d)) {
        return {
          ok: false,
          error: {
            code: "unknown_dependency",
            message: `task ${t.id} depends on unknown task ${d}`
          }
        };
      }
    }
  }
  const waves = computeWaves(plan.tasks);
  if (waves === null) {
    return {
      ok: false,
      error: { code: "cycle", message: "plan has a dependency cycle" }
    };
  }
  return { ok: true, plan, waves };
}
