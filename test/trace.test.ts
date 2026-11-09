import { describe, expect, it, vi } from "vitest";
import { createTracer, type TraceEvent, type TracerClock } from "../src/trace";

/** Deterministic clock so ids/timestamps are assertable. */
function fixedClock(): TracerClock {
  let n = 0;
  return {
    now: () => "2026-11-09T12:00:00.000Z",
    id: () => `id-${++n}`
  };
}

describe("trace — createTracer", () => {
  it("stamps every row with the shared turnId and ISO-ms timestamp", () => {
    const rows: TraceEvent[] = [];
    const tracer = createTracer("turn-1", (e) => rows.push(e), fixedClock());

    tracer.emit("orchestrator", "delegation_planned", { tasks: 2 });
    tracer.emit("it", "specialist_start");

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.turnId === "turn-1")).toBe(true);
    expect(rows[0]).toMatchObject({
      id: "id-1",
      ts: "2026-11-09T12:00:00.000Z",
      agent: "orchestrator",
      event: "delegation_planned",
      detail: { tasks: 2 }
    });
    // ISO-8601 with milliseconds.
    expect(rows[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("defaults detail to an empty object and returns the emitted row", () => {
    const tracer = createTracer("turn-2", () => {}, fixedClock());
    const row = tracer.emit("hr", "turn_end");
    expect(row.detail).toEqual({});
    expect(row.event).toBe("turn_end");
  });

  it("mirrors each row to the console as a single JSON line", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const tracer = createTracer("turn-3", () => {}, fixedClock());
      const row = tracer.emit("orchestrator", "permission_resolved", {
        user: "bob"
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(JSON.stringify(row));
    } finally {
      spy.mockRestore();
    }
  });

  it("does not let a console failure break the turn (row still reaches sink)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("console down");
    });
    const rows: TraceEvent[] = [];
    try {
      const tracer = createTracer("turn-4", (e) => rows.push(e), fixedClock());
      expect(() => tracer.emit("it", "tool_call", { name: "x" })).not.toThrow();
      expect(rows).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
