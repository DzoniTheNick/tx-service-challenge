import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EQUIPMENT_PROFILES, IT_KB, POLICIES } from "./fixtures";

/**
 * Acme d.o.o. MCP server (CONTEXT.md §5).
 *
 * Exposes four read-only tools over the company's (fictional) policy, equipment
 * and IT-knowledge-base fixtures. All inputs are validated with Zod and every
 * result is JSON with an `ok` flag.
 *
 * `MCP_MODE` (wrangler var) is a deliberate failure switch used to prove the
 * app's graceful degradation (scenario 7):
 *   - "ok"      — normal (default)
 *   - "error"   — every tool returns `{ ok:false, error }`
 *   - "timeout" — every tool sleeps past the client's 5 s timeout
 * Restart the server after changing it.
 */

type McpMode = "ok" | "error" | "timeout";

const TIMEOUT_SLEEP_MS = 10_000; // longer than the client's 5s bound

function mode(env: Env): McpMode {
  // The generated type narrows MCP_MODE to its default literal; read it widely so
  // the runtime value ("error" / "timeout") is honored.
  const m = env.MCP_MODE as string;
  return m === "error" || m === "timeout" ? m : "ok";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** JSON text result in the MCP content shape. */
function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function matches(query: string, haystack: readonly string[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const terms = q.split(/\s+/);
  return terms.some((term) =>
    haystack.some((h) => h.toLowerCase().includes(term))
  );
}

export class AcmeMcp extends McpAgent<Env> {
  server = new McpServer({ name: "acme-mcp", version: "1.0.0" });

  async init() {
    // One wrapper applies the MCP_MODE switch uniformly to every tool.
    const guarded =
      <A>(handler: (args: A) => unknown) =>
      async (args: A) => {
        const m = mode(this.env);
        if (m === "timeout") await sleep(TIMEOUT_SLEEP_MS);
        if (m === "error") {
          return json({
            ok: false,
            error: "MCP server is in forced-error mode"
          });
        }
        return json(handler(args));
      };

    this.server.tool(
      "search_policies",
      "Search company HR/policy documents by keyword and tag. Returns id, title and a snippet.",
      { query: z.string().describe("Keywords, e.g. 'remote work' or 'leave'") },
      guarded(({ query }: { query: string }) => {
        const results = POLICIES.filter(
          (p) => matches(query, p.tags) || matches(query, [p.title, p.body])
        ).map((p) => ({
          id: p.id,
          title: p.title,
          snippet: p.body.slice(0, 160)
        }));
        return { ok: true, results };
      })
    );

    this.server.tool(
      "read_policy",
      "Read the full text and metadata of a policy document by id.",
      { id: z.string().describe("Policy id, e.g. 'annual-leave'") },
      guarded(({ id }: { id: string }) => {
        const policy = POLICIES.find((p) => p.id === id);
        if (!policy) return { ok: false, error: `no policy with id '${id}'` };
        return { ok: true, policy };
      })
    );

    this.server.tool(
      "get_equipment_profile",
      "Get the standard equipment profile (laptop, accessories, software) for a role.",
      {
        role: z.string().describe("Role, e.g. 'engineer', 'designer', 'sales'")
      },
      guarded(({ role }: { role: string }) => {
        const profile = EQUIPMENT_PROFILES[role.trim().toLowerCase()];
        if (!profile) {
          return {
            ok: false,
            error: `no equipment profile for role '${role}'`,
            knownRoles: Object.keys(EQUIPMENT_PROFILES)
          };
        }
        return { ok: true, profile };
      })
    );

    this.server.tool(
      "search_it_kb",
      "Search the IT knowledge base for troubleshooting articles. Returns id, title and a snippet.",
      {
        query: z.string().describe("Keywords, e.g. 'vpn' or 'printer offline'")
      },
      guarded(({ query }: { query: string }) => {
        const results = IT_KB.filter(
          (a) => matches(query, a.tags) || matches(query, [a.title, a.body])
        ).map((a) => ({
          id: a.id,
          title: a.title,
          snippet: a.body.slice(0, 160)
        }));
        return { ok: true, results };
      })
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return AcmeMcp.serve("/mcp").fetch(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  }
};
