/**
 * Trace emitter (CONTEXT.md §7 "State and trace").
 *
 * Every orchestration step emits a typed trace row. All rows for one inbound
 * user message share a server-minted `turnId` (minted in the DO, never from the
 * client or message text) — that is what makes concurrency verifiable: events
 * sharing a `turnId` are one turn, and overlapping specialist_start/_end
 * timestamps within it prove parallel execution.
 *
 * This module owns the *mechanism* (row shape, id, ISO-ms timestamp, console
 * mirror). The *sink* (SQLite insert in the DO, or an array in tests) is injected,
 * keeping the DO thin and this emitter unit-testable. Never put credentials, API
 * keys or model reasoning into `detail`.
 */

import type { AgentId } from "./permissions/registry";

/** Who emitted the event: the orchestrator or one of the specialists. */
export type TraceActor = "orchestrator" | AgentId;

/** The closed set of trace event names (CONTEXT.md §7). */
export type TraceEventName =
  | "permission_resolved"
  | "delegation_planned"
  | "clarification_requested"
  | "specialist_start"
  | "specialist_retry"
  | "permission_check"
  | "skill_loaded"
  | "tool_call"
  | "mcp_discovery"
  | "result_passed"
  | "specialist_end"
  | "guard_applied"
  | "turn_end";

export interface TraceEvent {
  readonly id: string;
  /** ISO 8601 timestamp with milliseconds. */
  readonly ts: string;
  readonly turnId: string;
  readonly agent: TraceActor;
  readonly event: TraceEventName;
  readonly detail: Record<string, unknown>;
}

/** Destination for finished rows (SQLite insert in prod, array in tests). */
export type TraceSink = (event: TraceEvent) => void;

export interface Tracer {
  /** Emit one row for this turn; returns the row (handy in tests). */
  emit(
    agent: TraceActor,
    event: TraceEventName,
    detail?: Record<string, unknown>
  ): TraceEvent;
  readonly turnId: string;
}

/** Overridable so tests can assert deterministic ids/timestamps if needed. */
export interface TracerClock {
  now(): string;
  id(): string;
}

const defaultClock: TracerClock = {
  now: () => new Date().toISOString(),
  id: () => crypto.randomUUID()
};

/**
 * Create a tracer bound to one `turnId`. Each `emit` builds a row, mirrors it to
 * the console as a single JSON line (CONTEXT.md §7), and hands it to the sink.
 * Console failures never break a turn.
 */
export function createTracer(
  turnId: string,
  sink: TraceSink,
  clock: TracerClock = defaultClock
): Tracer {
  return {
    turnId,
    emit(agent, event, detail = {}) {
      const row: TraceEvent = {
        id: clock.id(),
        ts: clock.now(),
        turnId,
        agent,
        event,
        detail
      };
      try {
        console.log(JSON.stringify(row));
      } catch {
        // Never let logging break the turn.
      }
      sink(row);
      return row;
    }
  };
}
