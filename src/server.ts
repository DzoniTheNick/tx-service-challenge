/**
 * HTTP entrypoint (Hono) — identity, session ownership, agent routing, and the
 * trace API (CONTEXT.md §3, §4, §7).
 *
 * Every request is identified from the `X-User` header (or the `_user` query
 * param for the WebSocket, which browsers cannot set headers on). The user is
 * resolved against the fixed list; unknown → 401. A session's owner is encoded in
 * the DO instance name (`${userId}:${sessionId}`); a user may only reach their
 * own sessions → 403 otherwise. The orchestrator DO itself is defined in
 * agents/orchestrator.ts and re-exported here as the Worker's `ChatAgent` binding.
 */

import { Hono, type MiddlewareHandler } from "hono";
import { getAgentByName, routeAgentRequest } from "agents";
import { resolveUser, userOwnsInstance, type User } from "./identity";
import type { ChatAgent } from "./agents/orchestrator";

export { ChatAgent } from "./agents/orchestrator";
export { LeaveStore } from "./leave/store";

type AppEnv = { Bindings: Env; Variables: { user: User } };
const app = new Hono<AppEnv>();

/** Resolve identity from header or WS query param; 401 on an unknown user. */
const identity: MiddlewareHandler<AppEnv> = async (c, next) => {
  const headerUser = c.req.header("X-User");
  const queryUser = new URL(c.req.url).searchParams.get("_user");
  const user = resolveUser(headerUser ?? queryUser);
  if (!user) return c.json({ error: "unknown or missing user" }, 401);
  c.set("user", user);
  await next();
};

app.use("/agents/*", identity);
app.use("/api/*", identity);

/** Agent traffic (chat WebSocket / HTTP), gated by session ownership. */
app.all("/agents/*", async (c) => {
  const user = c.get("user");
  // Path shape: /agents/<agent>/<instanceName>/...
  const segments = new URL(c.req.url).pathname.split("/").filter(Boolean);
  const instanceName = segments[2]
    ? decodeURIComponent(segments[2])
    : undefined;
  if (instanceName && !userOwnsInstance(user.id, instanceName)) {
    return c.json({ error: "forbidden: session belongs to another user" }, 403);
  }
  const res = await routeAgentRequest(c.req.raw, c.env);
  return res ?? c.notFound();
});

/** Trace for one session, owner-checked (CONTEXT.md §7). */
app.get("/api/sessions/:id/trace", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!userOwnsInstance(user.id, id)) {
    return c.json({ error: "forbidden" }, 403);
  }
  const stub = await getAgentByName<Env, ChatAgent>(c.env.ChatAgent, id);
  const trace = await stub.getTrace();
  return c.json({ trace });
});

export default app;
