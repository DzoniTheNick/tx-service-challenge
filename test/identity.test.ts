import { describe, expect, it } from "vitest";
import {
  USER_LIST,
  USERS,
  resolveUser,
  sessionInstanceName,
  userOwnsInstance
} from "../src/identity";

describe("identity — resolveUser", () => {
  it("resolves known users to their bound role", () => {
    expect(resolveUser("alice")?.role).toBe("employee");
    expect(resolveUser("bob")?.role).toBe("it_admin");
  });

  it("returns null for unknown / missing ids (caller maps to 401)", () => {
    expect(resolveUser("mallory")).toBeNull();
    expect(resolveUser("")).toBeNull();
    expect(resolveUser(null)).toBeNull();
    expect(resolveUser(undefined)).toBeNull();
  });

  it("exposes a stable user list for the UI switcher", () => {
    expect(USER_LIST.map((u) => u.id)).toEqual(["alice", "bob", "charlie"]);
    expect(USER_LIST).toHaveLength(Object.keys(USERS).length);
  });
});

describe("identity — session ownership", () => {
  it("derives the instance name from user + session", () => {
    expect(sessionInstanceName("alice", "s1")).toBe("alice:s1");
  });

  it("grants ownership only to the encoded user", () => {
    const name = sessionInstanceName("alice", "s1");
    expect(userOwnsInstance("alice", name)).toBe(true);
    expect(userOwnsInstance("bob", name)).toBe(false);
  });

  it("tolerates session ids that themselves contain colons", () => {
    const name = sessionInstanceName("bob", "2026:11:09:xyz");
    expect(userOwnsInstance("bob", name)).toBe(true);
    expect(userOwnsInstance("alice", name)).toBe(false);
  });

  it("rejects malformed / prefix-spoofing instance names", () => {
    expect(userOwnsInstance("alice", "alice")).toBe(false); // no separator
    expect(userOwnsInstance("alice", ":s1")).toBe(false); // empty owner
    expect(userOwnsInstance("alice", "alicia:s1")).toBe(false); // not a prefix match
  });
});
