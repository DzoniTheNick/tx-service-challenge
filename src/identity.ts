/**
 * Identity and session ownership (CONTEXT.md §4 "Identity rules").
 *
 * Users are a fixed, server-side list. The role is resolved from the `X-User`
 * header (or the WebSocket query param) against this list and is NEVER read from
 * message text or chosen by the model. A session's role is bound at creation and
 * stored in SQLite; switching user starts a new session (a session never changes
 * role). The Durable Object instance name encodes the owner as `${userId}:${sessionId}`,
 * which is what the ownership check below enforces.
 */

/** The roles the capability matrix distinguishes (CONTEXT.md §4). */
export type Role = "employee" | "it_admin" | "hr_admin";

export interface User {
  readonly id: string;
  readonly role: Role;
  /** Human-facing label, handy for the UI user switcher. */
  readonly label: string;
}

/**
 * Fixed test users (CONTEXT.md §4 "Roles"). `alice` is a regular employee,
 * `bob` an IT administrator, `charlie` an HR administrator. This list is the
 * single source of truth for identity; there is no sign-up or external
 * directory in the MVP.
 */
export const USERS: Readonly<Record<string, User>> = {
  alice: { id: "alice", role: "employee", label: "Alice (employee)" },
  bob: { id: "bob", role: "it_admin", label: "Bob (IT admin)" },
  charlie: { id: "charlie", role: "hr_admin", label: "Charlie (HR admin)" }
} as const;

/** Every known user, in a stable order (for the UI dropdown). */
export const USER_LIST: readonly User[] = Object.values(USERS);

/**
 * Resolve a user from an untrusted identifier (header / query param).
 * Returns `null` for anything not in the fixed list — callers map that to 401.
 */
export function resolveUser(id: string | null | undefined): User | null {
  if (typeof id !== "string") return null;
  return USERS[id] ?? null;
}

/**
 * Derive the Durable Object instance name that owns a session. The name is
 * always server-derived from the resolved user id, never from the message body.
 */
export function sessionInstanceName(userId: string, sessionId: string): string {
  return `${userId}:${sessionId}`;
}

/**
 * Ownership check for `${userId}:${sessionId}` instance names. A request may
 * only touch a session whose instance name begins with the requesting user's id
 * segment. Splitting on the first `:` tolerates session ids that contain colons.
 */
export function userOwnsInstance(
  userId: string,
  instanceName: string
): boolean {
  const sep = instanceName.indexOf(":");
  if (sep <= 0) return false;
  return instanceName.slice(0, sep) === userId;
}
