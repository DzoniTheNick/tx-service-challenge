/**
 * Central limits and model configuration (CONTEXT.md §3.3, §9).
 * Keep every tunable here so the DO classes and executor stay thin.
 */

export const LIMITS = {
  /** Specialist agent: max reasoning/tool steps per task. */
  SPECIALIST_MAX_STEPS: 5,
  /** Specialist agent: wall-clock timeout per task (AbortSignal), ms. */
  SPECIALIST_TIMEOUT_MS: 25_000,
  /** Orchestrator: max reasoning/tool steps per turn. */
  ORCHESTRATOR_MAX_STEPS: 6,
  /** MCP client: per-call timeout, ms. */
  MCP_TIMEOUT_MS: 5_000,
  /** Delegation plan: max tasks per turn. */
  MAX_TASKS: 4
} as const;

/**
 * Keyless default model (Workers AI). Per-role overrides come from env vars
 * MODEL_ORCHESTRATOR / MODEL_SPECIALIST; documented fallback is `gpt-6-luna`.
 */
export const DEFAULT_MODEL = "@cf/zai-org/glm-4.7-flash";

export type ModelRole = "orchestrator" | "specialist";

/** Resolve the model id for a role, honoring env overrides when present. */
export function modelFor(
  role: ModelRole,
  env: { MODEL_ORCHESTRATOR?: string; MODEL_SPECIALIST?: string }
): string {
  if (role === "orchestrator") return env.MODEL_ORCHESTRATOR ?? DEFAULT_MODEL;
  return env.MODEL_SPECIALIST ?? DEFAULT_MODEL;
}
