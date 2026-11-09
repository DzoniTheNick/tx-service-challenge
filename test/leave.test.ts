import { describe, expect, it } from "vitest";
import { USERS } from "../src/identity";
import { buildLeaveTools } from "../src/tools/leave";
import type {
  CreateLeaveInput,
  DecideResult,
  LeaveRequest,
  LeaveStatus,
  LeaveStoreApi
} from "../src/leave/store";

/** In-memory stand-in for the LeaveStore DO (same surface the tools depend on). */
class FakeLeaveStore implements LeaveStoreApi {
  private items: LeaveRequest[] = [];
  private seq = 0;

  async create(input: CreateLeaveInput): Promise<LeaveRequest> {
    const req: LeaveRequest = {
      id: `req-${++this.seq}`,
      userId: input.userId,
      startDate: input.startDate,
      endDate: input.endDate,
      reason: input.reason,
      status: "pending",
      createdAt: `t${this.seq}`,
      decidedBy: null,
      decidedAt: null
    };
    this.items.unshift(req);
    return req;
  }

  async get(id: string): Promise<LeaveRequest | null> {
    return this.items.find((r) => r.id === id) ?? null;
  }

  async listForUser(userId: string): Promise<LeaveRequest[]> {
    return this.items.filter((r) => r.userId === userId);
  }

  async listAll(status?: LeaveStatus): Promise<LeaveRequest[]> {
    return status
      ? this.items.filter((r) => r.status === status)
      : [...this.items];
  }

  async decide(
    id: string,
    deciderId: string,
    decision: "approved" | "rejected"
  ): Promise<DecideResult> {
    const r = this.items.find((x) => x.id === id);
    if (!r) return { ok: false, error: `no leave request with id '${id}'` };
    if (r.status !== "pending") {
      return { ok: false, error: `request '${id}' is already ${r.status}` };
    }
    const updated: LeaveRequest = {
      ...r,
      status: decision,
      decidedBy: deciderId,
      decidedAt: "decided"
    };
    this.items = this.items.map((x) => (x.id === id ? updated : x));
    return { ok: true, request: updated };
  }
}

type ToolResult = {
  ok: boolean;
  request?: LeaveRequest;
  requests?: LeaveRequest[];
};
const run = (tool: { execute: (i: unknown) => unknown }, input: unknown) =>
  Promise.resolve(tool.execute(input)) as Promise<ToolResult>;

describe("leave tools — the scenario-9 workflow", () => {
  it("employee submits, HR admin approves, employee sees the approved status", async () => {
    const store = new FakeLeaveStore();
    const aliceTools = buildLeaveTools(USERS.alice, store);
    const charlieTools = buildLeaveTools(USERS.charlie, store);

    // 1. Alice (employee) submits a leave request → pending, filed under alice.
    const submit = await run(aliceTools.submit_leave_request, {
      startDate: "2026-12-20",
      endDate: "2026-12-27",
      reason: "holidays"
    });
    expect(submit.ok).toBe(true);
    expect(submit.request?.status).toBe("pending");
    expect(submit.request?.userId).toBe("alice");
    const id = submit.request!.id;

    // 2. Charlie (HR admin) sees ALL pending requests, then approves by id.
    const pending = await run(charlieTools.get_leave_requests, {
      status: "pending"
    });
    expect(pending.requests?.map((r) => r.id)).toContain(id);
    const approve = await run(charlieTools.approve_leave_request, { id });
    expect(approve.ok).toBe(true);
    expect(approve.request?.status).toBe("approved");
    expect(approve.request?.decidedBy).toBe("charlie");

    // 3. Alice checks status → her own request, now approved.
    const mine = await run(aliceTools.get_leave_requests, {});
    expect(mine.requests).toHaveLength(1);
    expect(mine.requests?.[0].status).toBe("approved");
  });

  it("an employee's get_leave_requests is scoped to their own requests", async () => {
    const store = new FakeLeaveStore();
    await run(buildLeaveTools(USERS.alice, store).submit_leave_request, {
      startDate: "a",
      endDate: "b",
      reason: "x"
    });
    // A different employee submits too.
    await run(buildLeaveTools(USERS.bob, store).submit_leave_request, {
      startDate: "a",
      endDate: "b",
      reason: "y"
    });

    const aliceView = await run(
      buildLeaveTools(USERS.alice, store).get_leave_requests,
      {}
    );
    expect(aliceView.requests).toHaveLength(1);
    expect(aliceView.requests?.[0].userId).toBe("alice");

    const adminView = await run(
      buildLeaveTools(USERS.charlie, store).get_leave_requests,
      {}
    );
    expect(adminView.requests).toHaveLength(2); // HR admin sees everyone's
  });

  it("get_leave_balance: an employee sees only their own PTO balance", async () => {
    const store = new FakeLeaveStore();
    const aliceTools = buildLeaveTools(USERS.alice, store);
    // Own balance (default — userId ignored for a non-admin).
    const own = (await run(aliceTools.get_leave_balance, {})) as {
      ok: boolean;
      userId?: string;
      balance?: { remainingDays: number };
    };
    expect(own.ok).toBe(true);
    expect(own.userId).toBe("alice");
    expect(typeof own.balance?.remainingDays).toBe("number");

    // An employee cannot target someone else — the userId arg is ignored.
    const spoof = (await run(aliceTools.get_leave_balance, {
      userId: "bob"
    })) as { userId?: string };
    expect(spoof.userId).toBe("alice");
  });

  it("get_leave_balance: an HR admin can look up any employee", async () => {
    const charlieTools = buildLeaveTools(USERS.charlie, new FakeLeaveStore());
    const alices = (await run(charlieTools.get_leave_balance, {
      userId: "alice"
    })) as { ok: boolean; userId?: string };
    expect(alices.ok).toBe(true);
    expect(alices.userId).toBe("alice");

    const unknown = (await run(charlieTools.get_leave_balance, {
      userId: "nobody"
    })) as { ok: boolean; error?: string };
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/no leave balance/);
  });

  it("approving an already-decided request fails honestly", async () => {
    const store = new FakeLeaveStore();
    const charlie = buildLeaveTools(USERS.charlie, store);
    const { request } = await run(
      buildLeaveTools(USERS.alice, store).submit_leave_request,
      { startDate: "a", endDate: "b", reason: "x" }
    );
    await run(charlie.approve_leave_request, { id: request!.id });
    const second = (await run(charlie.approve_leave_request, {
      id: request!.id
    })) as { ok: boolean; error?: string };
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already approved/);
  });
});
