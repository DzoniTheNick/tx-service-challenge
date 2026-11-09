/**
 * Ambient declaration-merge for optional environment variables that the
 * generated `env.d.ts` (from wrangler.jsonc) does not know about because they are
 * supplied at runtime via `.dev.vars` / `wrangler secret`, not declared as
 * `vars` in the config. Keeping them optional means a fresh clone runs keyless on
 * the defaults (CONTEXT.md §9) while allowing per-role model overrides.
 */

interface Env {
  /** Override the orchestrator model id (default: the keyless Workers AI model). */
  readonly MODEL_ORCHESTRATOR?: string;
  /** Override the specialist model id (default: the keyless Workers AI model). */
  readonly MODEL_SPECIALIST?: string;
}
