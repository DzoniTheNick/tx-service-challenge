/**
 * Cross-agent data contract (CONTEXT.md §3.2).
 *
 * Specialists return a structured {@link SpecialistResult}, produced by calling a
 * `submit_result` tool. Code (not the model) owns the identity fields `taskId`
 * and `agent`, so the `submit_result` *input* schema omits them — the runner
 * stamps them on. When one task's output feeds a dependent task, the carried
 * payload is the typed `data` object (e.g. an {@link EquipmentProfile}), never
 * prose, so the weak receiving model gets structured input.
 */

import { z } from "zod";
import { AGENT_IDS, type AgentId } from "../permissions/registry";

/** Outcome of a specialist task. `partial` = ran but did not fully succeed. */
export const specialistStatusSchema = z.enum(["ok", "partial", "failed"]);
export type SpecialistStatus = z.infer<typeof specialistStatusSchema>;

/**
 * The fields the model supplies via `submit_result`. Identity (`taskId`,
 * `agent`) is added by the runner, not the model.
 */
export const submitResultSchema = z.object({
  status: specialistStatusSchema,
  answer: z.string(),
  /** Structured output (e.g. an equipment profile) for dependent tasks. */
  data: z.record(z.string(), z.unknown()).optional(),
  /** Honest statements of what could not be done (e.g. a missing capability). */
  limitations: z.array(z.string()).default([]),
  /** Tool-level errors encountered while producing the answer. */
  toolErrors: z.array(z.string()).default([])
});
export type SubmitResultInput = z.infer<typeof submitResultSchema>;

/** The full, identity-stamped result the executor passes around. */
export interface SpecialistResult extends SubmitResultInput {
  readonly taskId: string;
  readonly agent: AgentId;
}

/**
 * Pinned equipment-profile shape (CONTEXT.md §3.2), the canonical `data` payload
 * for the HR→IT→HR chain (scenarios 4 and 8). Provenance is carried in `source`
 * so a downstream agent can answer honestly about where a figure came from.
 */
export const equipmentProfileSchema = z.object({
  role: z.string(),
  laptop: z.object({ model: z.string(), specs: z.string() }),
  accessories: z.array(z.string()),
  software: z.array(z.string()),
  source: z.object({
    policyId: z.string().optional(),
    version: z.string().optional()
  })
});
export type EquipmentProfile = z.infer<typeof equipmentProfileSchema>;

/** Guard used by the runner and executor when they must assert a known agent. */
export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}
