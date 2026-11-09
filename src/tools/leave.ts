/**
 * Leave-request tools for the HR specialist (scenario 9). Built per turn, bound
 * to the acting user and the shared {@link LeaveStoreApi}. The acting user's id
 * and role come from server-resolved identity — never from the model — so a
 * request is always filed for the real user and `get_leave_requests` scopes
 * results by role. Exposure is still decided by `allowedTools()`:
 * `approve_leave_request` is registered to the `hr_admin` role only.
 */

import { z } from "zod";
import type { SpecialistTool } from "../llm";
import type { User } from "../identity";
import type { LeaveStoreApi } from "../leave/store";
import { leaveBalanceFor } from "../leave/balances";

export function buildLeaveTools(
  user: User,
  store: LeaveStoreApi
): Record<string, SpecialistTool> {
  const submit_leave_request: SpecialistTool = {
    description:
      "Submit a leave request for the current employee. Returns the new " +
      "request id and its status (always 'pending' until an HR admin decides).",
    inputSchema: z.object({
      startDate: z
        .string()
        .describe("First day of leave, ISO date e.g. 2026-12-20"),
      endDate: z
        .string()
        .describe("Last day of leave, ISO date e.g. 2026-12-27"),
      reason: z.string().describe("Short reason for the leave")
    }),
    execute: async (input) => {
      const { startDate, endDate, reason } = input as {
        startDate: string;
        endDate: string;
        reason: string;
      };
      const request = await store.create({
        userId: user.id,
        startDate,
        endDate,
        reason
      });
      return { ok: true, request };
    }
  };

  const get_leave_requests: SpecialistTool = {
    description:
      "List leave requests. A regular employee sees only their own; an HR " +
      "admin sees everyone's (optionally filtered by status). Use this to " +
      "check a request's status or to find pending requests to approve.",
    inputSchema: z.object({
      status: z
        .enum(["pending", "approved", "rejected"])
        .optional()
        .describe("Optional status filter (only applied for HR admins)")
    }),
    execute: async (input) => {
      const { status } = input as {
        status?: "pending" | "approved" | "rejected";
      };
      const requests =
        user.role === "hr_admin"
          ? await store.listAll(status)
          : await store.listForUser(user.id);
      return {
        ok: true,
        scope: user.role === "hr_admin" ? "all" : "own",
        requests
      };
    }
  };

  const approve_leave_request: SpecialistTool = {
    description:
      "Approve a pending leave request by id. Only available to HR admins.",
    inputSchema: z.object({
      id: z.string().describe("The leave request id to approve")
    }),
    execute: async (input) => {
      const { id } = input as { id: string };
      const result = await store.decide(id, user.id, "approved");
      return result.ok
        ? { ok: true, request: result.request }
        : { ok: false, error: result.error };
    }
  };

  const get_leave_balance: SpecialistTool = {
    description:
      "Look up an employee's PTO (paid leave) balance: entitlement, used, " +
      "remaining and carry-over days. A regular employee sees only their own " +
      "balance; an HR admin may pass a userId to look up any employee (use this " +
      "to check whether someone has enough days before approving a request).",
    inputSchema: z.object({
      userId: z
        .string()
        .optional()
        .describe("Employee id to look up (HR admin only); defaults to you")
    }),
    execute: (input) => {
      const { userId } = input as { userId?: string };
      // Employees are scoped to themselves; only an HR admin may target another.
      const target = user.role === "hr_admin" && userId ? userId : user.id;
      const balance = leaveBalanceFor(target);
      return balance
        ? { ok: true, userId: target, balance }
        : { ok: false, error: `no leave balance on record for '${target}'` };
    }
  };

  return {
    submit_leave_request,
    get_leave_requests,
    get_leave_balance,
    approve_leave_request
  };
}
