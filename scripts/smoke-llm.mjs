// Phase-0 LLM tool-call smoke test (headless, Workers AI REST path).
//
// Verifies the default model (glm-4.7-flash) will emit a tool call — the one
// capability the whole orchestration depends on. Uses the Workers AI REST API
// so it runs without `wrangler dev`.
//
// Usage:
//   1. Get a Cloudflare API token with "Workers AI: Read" (and your account id).
//      Create at https://dash.cloudflare.com/profile/api-tokens
//   2. CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node scripts/smoke-llm.mjs
//      (optionally MODEL=gpt-... to smoke-test a fallback instead)
//
// Exit 0 = the model emitted a valid tool call. Non-zero = it did not.

import { createWorkersAI } from "workers-ai-provider";
import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiKey = process.env.CLOUDFLARE_API_TOKEN;
const model = process.env.MODEL ?? "@cf/zai-org/glm-4.7-flash";

if (!accountId || !apiKey) {
  console.error(
    "Missing CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN. See the header of this file."
  );
  process.exit(2);
}

const workersai = createWorkersAI({ accountId, apiKey });

let called = false;
const result = await generateText({
  model: workersai(model),
  stopWhen: stepCountIs(3),
  tools: {
    get_service_status: tool({
      description: "Get the operational status of an internal IT service.",
      inputSchema: z.object({
        service: z.string().describe("The service name, e.g. 'vpn' or 'email'")
      }),
      execute: async ({ service }) => {
        called = true;
        return { service, status: "operational" };
      }
    })
  },
  prompt:
    "A user reports the VPN might be down. Check the status of the 'vpn' service using your tool, then tell them."
});

const toolCalls = result.steps.flatMap((s) => s.toolCalls ?? []);
console.log(`model: ${model}`);
console.log(`tool calls: ${toolCalls.length}`, toolCalls.map((c) => c.toolName));
console.log(`tool executed: ${called}`);
console.log(`final text: ${result.text.slice(0, 200)}`);

if (toolCalls.length > 0 && called) {
  console.log("\n✅ SMOKE PASS: model emits and uses tool calls.");
  process.exit(0);
}
console.error(
  "\n❌ SMOKE FAIL: model did not call the tool. Consider the gpt-6-luna fallback (CONTEXT.md §9)."
);
process.exit(1);
