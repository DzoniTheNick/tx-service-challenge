import { Hono } from "hono";
import { routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { createWorkersAI } from "workers-ai-provider";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";

/**
 * Phase 0 baseline.
 *
 * The starter's demo tools (weather, timezone, calculator, scheduling), the
 * runtime addServer/removeServer MCP management, the MCP OAuth callback and the
 * image-upload path have all been removed. What remains is a minimal chat agent
 * on the keyless Workers AI default model plus a single `echo` tool, which
 * exists only so Phase 0 can verify one tool-call round trip. Phases 1–5 replace
 * this with the orchestrator, delegate tool, executor, native tools, MCP client
 * and skills described in CONTEXT.md.
 */
export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash", {
        sessionAffinity: this.sessionAffinity
      }),
      system:
        "You are an assistant for first-level IT and HR support. " +
        "Phase 0 baseline: when the user asks you to echo something, call the `echo` tool.",
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        // Minimal tool used only for the Phase-0 tool-call smoke test.
        echo: tool({
          description: "Echo a message back to the user verbatim.",
          inputSchema: z.object({
            message: z.string().describe("The text to echo back")
          }),
          execute: async ({ message }) => ({ echoed: message })
        })
      },
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}

/**
 * HTTP entrypoint (Hono). Phase 1/3 add identity + session-ownership middleware
 * and the /api/* routes; for now it only forwards agent traffic.
 */
const app = new Hono<{ Bindings: Env }>();

app.all("/agents/*", async (c) => {
  const res = await routeAgentRequest(c.req.raw, c.env);
  return res ?? c.notFound();
});

export default app;
