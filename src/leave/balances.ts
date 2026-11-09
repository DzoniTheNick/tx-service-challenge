/**
 * Fictional per-employee PTO (paid leave) balances. Lets the HR specialist
 * answer "does this employee have enough days?" during the leave workflow
 * (CONTEXT.md §4 capability matrix, scenario 9). Static mock data — the point
 * is the capability + permission wiring, not a real HRIS.
 */

export interface LeaveBalance {
  readonly entitlementDays: number;
  readonly usedDays: number;
  readonly remainingDays: number;
  readonly carryOverDays: number;
}

const BALANCES: Readonly<Record<string, LeaveBalance>> = {
  alice: {
    entitlementDays: 25,
    usedDays: 6,
    remainingDays: 19,
    carryOverDays: 2
  },
  bob: {
    entitlementDays: 25,
    usedDays: 10,
    remainingDays: 15,
    carryOverDays: 0
  },
  charlie: {
    entitlementDays: 25,
    usedDays: 3,
    remainingDays: 22,
    carryOverDays: 5
  }
};

/** The PTO balance for an employee id, or null if there is no record. */
export function leaveBalanceFor(userId: string): LeaveBalance | null {
  return BALANCES[userId] ?? null;
}
