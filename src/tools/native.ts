/**
 * Native specialist tools (CONTEXT.md §4 capability matrix). These are mocks —
 * the point of the challenge is the orchestration and permission enforcement, not
 * a real IT backend. Each tool validates its input with Zod and returns a small
 * JSON result with an `ok` flag. Exposure is decided by `allowedTools()`; this
 * module only provides implementations keyed by the registry tool name.
 */

import { z } from "zod";
import type { SpecialistTool } from "../llm";

/** A deterministic mock status table so scenarios read predictably. */
const SERVICE_STATUS: Record<string, "operational" | "degraded" | "down"> = {
  vpn: "operational",
  email: "operational",
  wifi: "degraded",
  printer: "down"
};

const getServiceStatus: SpecialistTool = {
  description: "Get the operational status of an internal IT service by name.",
  inputSchema: z.object({
    service: z.string().describe("Service name, e.g. 'vpn', 'email', 'wifi'")
  }),
  execute: (input) => {
    const { service } = input as { service: string };
    const key = service.trim().toLowerCase();
    const status = SERVICE_STATUS[key] ?? "operational";
    return { ok: true, service: key, status };
  }
};

const resetPassword: SpecialistTool = {
  description:
    "Reset a user's password (mock; issues a temporary password, no approval in the MVP).",
  inputSchema: z.object({
    user: z.string().describe("The user id whose password to reset").optional()
  }),
  execute: (input) => {
    const { user } = input as { user?: string };
    return {
      ok: true,
      user: user ?? "unknown",
      message:
        "A temporary password has been issued (mock). The user must change it at next sign-in."
    };
  }
};

/**
 * Native tool implementations by registry name. The specialist runner looks up
 * only the names that `allowedTools()` has approved for the (user, agent) pair.
 */
export const NATIVE_TOOLS: Readonly<Record<string, SpecialistTool>> = {
  get_service_status: getServiceStatus,
  reset_password: resetPassword
} as const;
