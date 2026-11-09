import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Acme d.o.o. MCP server (Phase 0 skeleton).
 *
 * Phase 4 fleshes this out with the real tools (search_policies, read_policy,
 * get_equipment_profile, search_it_kb), fixtures, and the MCP_MODE failure
 * switch. For now it exposes a single `ping` tool so the app Worker can prove
 * MCP discovery + invocation end to end.
 */
export class AcmeMcp extends McpAgent<Env> {
  server = new McpServer({ name: "acme-mcp", version: "0.1.0" });

  async init() {
    this.server.tool("ping", "Health check. Returns pong.", {}, async () => ({
      content: [{ type: "text", text: "pong" }]
    }));
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
