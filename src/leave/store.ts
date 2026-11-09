/**
 * Shared leave-request store (scenario 9). A single Durable Object instance
 * (fixed name "global") holds every leave request, so a request created in one
 * user's session is visible to another user's session — the cross-user state
 * the approval workflow needs. State is server-authoritative: the LLM asks to
 * submit/approve, but code (here) assigns ids, timestamps and status
 * transitions and records who decided. The owning worker exposes the three HR
 * tools in src/tools/leave.ts; who may call `approve` is gated by the
 * permission registry, never by this store.
 */

import { DurableObject } from "cloudflare:workers";

export type LeaveStatus = "pending" | "approved" | "rejected";

export interface LeaveRequest {
  readonly id: string;
  readonly userId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly reason: string;
  readonly status: LeaveStatus;
  readonly createdAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
}

export interface CreateLeaveInput {
  readonly userId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly reason: string;
}

export type DecideResult =
  | { readonly ok: true; readonly request: LeaveRequest }
  | { readonly ok: false; readonly error: string };

/**
 * The store surface the leave tools depend on. Both the real Durable Object and
 * the in-memory test fake implement it, so the tools never import the DO.
 */
export interface LeaveStoreApi {
  create(input: CreateLeaveInput): Promise<LeaveRequest>;
  get(id: string): Promise<LeaveRequest | null>;
  listForUser(userId: string): Promise<LeaveRequest[]>;
  listAll(status?: LeaveStatus): Promise<LeaveRequest[]>;
  decide(
    id: string,
    deciderId: string,
    decision: "approved" | "rejected"
  ): Promise<DecideResult>;
}

interface Row {
  id: string;
  user_id: string;
  start_date: string;
  end_date: string;
  reason: string;
  status: string;
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
  // The SQL cursor generic requires an index signature of SQL-storable values.
  [key: string]: SqlStorageValue;
}

function toRequest(r: Row): LeaveRequest {
  return {
    id: r.id,
    userId: r.user_id,
    startDate: r.start_date,
    endDate: r.end_date,
    reason: r.reason,
    status: r.status as LeaveStatus,
    createdAt: r.created_at,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at
  };
}

export class LeaveStore extends DurableObject<Env> implements LeaveStoreApi {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS leave_request (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_by TEXT,
        decided_at TEXT
      )`
    );
  }

  async create(input: CreateLeaveInput): Promise<LeaveRequest> {
    const req: LeaveRequest = {
      id: crypto.randomUUID().slice(0, 8),
      userId: input.userId,
      startDate: input.startDate,
      endDate: input.endDate,
      reason: input.reason,
      status: "pending",
      createdAt: new Date().toISOString(),
      decidedBy: null,
      decidedAt: null
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO leave_request
        (id, user_id, start_date, end_date, reason, status, created_at, decided_by, decided_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      req.id,
      req.userId,
      req.startDate,
      req.endDate,
      req.reason,
      req.status,
      req.createdAt
    );
    return req;
  }

  async get(id: string): Promise<LeaveRequest | null> {
    const rows = this.ctx.storage.sql
      .exec<Row>(`SELECT * FROM leave_request WHERE id = ?`, id)
      .toArray();
    return rows.length > 0 ? toRequest(rows[0]) : null;
  }

  async listForUser(userId: string): Promise<LeaveRequest[]> {
    return this.ctx.storage.sql
      .exec<Row>(
        `SELECT * FROM leave_request WHERE user_id = ? ORDER BY created_at DESC`,
        userId
      )
      .toArray()
      .map(toRequest);
  }

  async listAll(status?: LeaveStatus): Promise<LeaveRequest[]> {
    const rows = status
      ? this.ctx.storage.sql
          .exec<Row>(
            `SELECT * FROM leave_request WHERE status = ? ORDER BY created_at DESC`,
            status
          )
          .toArray()
      : this.ctx.storage.sql
          .exec<Row>(`SELECT * FROM leave_request ORDER BY created_at DESC`)
          .toArray();
    return rows.map(toRequest);
  }

  async decide(
    id: string,
    deciderId: string,
    decision: "approved" | "rejected"
  ): Promise<DecideResult> {
    const existing = await this.get(id);
    if (!existing)
      return { ok: false, error: `no leave request with id '${id}'` };
    if (existing.status !== "pending") {
      return {
        ok: false,
        error: `request '${id}' is already ${existing.status}`
      };
    }
    const decidedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE leave_request SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?`,
      decision,
      deciderId,
      decidedAt,
      id
    );
    return {
      ok: true,
      request: {
        ...existing,
        status: decision,
        decidedBy: deciderId,
        decidedAt
      }
    };
  }
}

/** Resolve the single shared store instance (fixed name) from the environment. */
export function leaveStore(env: Env): LeaveStoreApi {
  return env.LEAVE_STORE.get(
    env.LEAVE_STORE.idFromName("global")
  ) as unknown as LeaveStoreApi;
}
