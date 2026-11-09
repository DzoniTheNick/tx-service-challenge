import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, LIMITS, modelFor } from "../src/config";

describe("config (Phase 0 smoke)", () => {
  it("exposes the documented limits", () => {
    expect(LIMITS.SPECIALIST_MAX_STEPS).toBe(5);
    expect(LIMITS.SPECIALIST_MAX_ATTEMPTS).toBe(2);
    expect(LIMITS.SPECIALIST_TIMEOUT_MS).toBe(60_000);
    expect(LIMITS.ORCHESTRATOR_MAX_STEPS).toBe(6);
    expect(LIMITS.MCP_TIMEOUT_MS).toBe(5_000);
    expect(LIMITS.MAX_TASKS).toBe(4);
  });

  it("defaults both roles to the keyless Workers AI model", () => {
    expect(modelFor("orchestrator", {})).toBe(DEFAULT_MODEL);
    expect(modelFor("specialist", {})).toBe(DEFAULT_MODEL);
  });

  it("honors per-role env overrides", () => {
    const env = { MODEL_ORCHESTRATOR: "gpt-6-luna", MODEL_SPECIALIST: "x" };
    expect(modelFor("orchestrator", env)).toBe("gpt-6-luna");
    expect(modelFor("specialist", env)).toBe("x");
  });
});
