/**
 * LLM boundary (CONTEXT.md §9) — the single seam between our orchestration code
 * and a model provider. Two reasons it exists:
 *   1. Models are config (`MODEL_ORCHESTRATOR`/`MODEL_SPECIALIST`), resolved via
 *      config.ts; swapping to the `gpt-6-luna` fallback touches only the adapter.
 *   2. Every unit/integration test drives a FAKE client with scripted tool calls,
 *      so no test needs a key or the network (CONTEXT.md §12).
 *
 * Deliberately, OUR code owns the agentic loop semantics at this boundary: a
 * `complete()` call runs the model to a stop condition and returns the flattened
 * tool calls plus final text. The real adapter delegates the loop to the AI SDK's
 * `generateText`; the fake replays a script. Tools are described with a provider-
 * agnostic shape ({@link SpecialistTool}) so neither the fake nor the callers
 * import the AI SDK.
 */

import type { z } from "zod";

/** A tool as the specialist layer describes it — no AI-SDK types leak here. */
export interface SpecialistTool {
  readonly description: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly execute: (input: unknown) => Promise<unknown> | unknown;
}
export type SpecialistToolMap = Record<string, SpecialistTool>;

/** One tool call the model made, with its resolved output or error. */
export interface LlmToolCall {
  readonly toolName: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly error?: string;
}

export interface LlmResult {
  readonly text: string;
  readonly toolCalls: LlmToolCall[];
  readonly finishReason: string;
}

export interface LlmCompleteParams {
  readonly modelId: string;
  readonly system: string;
  readonly prompt: string;
  readonly tools: SpecialistToolMap;
  readonly maxSteps: number;
  /** Stop the loop as soon as this tool is called (e.g. `submit_result`). */
  readonly stopOnToolName?: string;
  readonly abortSignal?: AbortSignal;
}

export interface LlmClient {
  complete(params: LlmCompleteParams): Promise<LlmResult>;
}

/**
 * Real adapter over Workers AI via the AI SDK. Not exercised by the test suite
 * (tests use the fake); it only needs to typecheck and run live in `yarn dev`.
 */
export function createWorkersAiLlmClient(env: { AI: Ai }): LlmClient {
  return {
    async complete(params: LlmCompleteParams): Promise<LlmResult> {
      // Imported lazily so the fake path never pulls the AI SDK into tests.
      const { createWorkersAI } = await import("workers-ai-provider");
      const { generateText, tool, stepCountIs, hasToolCall } =
        await import("ai");

      const workersai = createWorkersAI({ binding: env.AI });
      const tools = Object.fromEntries(
        Object.entries(params.tools).map(([name, t]) => [
          name,
          tool({
            description: t.description,
            inputSchema: t.inputSchema,
            execute: async (input: unknown) => t.execute(input)
          })
        ])
      );

      const stopWhen = params.stopOnToolName
        ? [hasToolCall(params.stopOnToolName), stepCountIs(params.maxSteps)]
        : [stepCountIs(params.maxSteps)];

      const res = await generateText({
        model: workersai(params.modelId),
        system: params.system,
        prompt: params.prompt,
        // The AI SDK's precise ToolSet generic is not worth threading through the
        // provider-agnostic boundary; the shapes are structurally compatible.
        tools: tools as Parameters<typeof generateText>[0]["tools"],
        stopWhen,
        abortSignal: params.abortSignal
      });

      const toolCalls: LlmToolCall[] = res.steps.flatMap((s) =>
        (s.toolCalls ?? []).map((c) => ({
          toolName: c.toolName,
          input: c.input
        }))
      );
      return {
        text: res.text,
        toolCalls,
        finishReason: String(res.finishReason)
      };
    }
  };
}

/** Script for the fake client (CONTEXT.md §12 "scripted tool calls"). */
export interface FakeScriptStep {
  readonly tool: string;
  readonly input: unknown;
}
export interface FakeLlmConfig {
  /** Tool calls the "model" makes, in order. */
  readonly steps?: readonly FakeScriptStep[];
  /** Final assistant text (used when no `submit_result` is scripted). */
  readonly finalText?: string;
  /** If set, `complete()` rejects with this (simulates a model/provider error). */
  readonly error?: unknown;
  /** If true, hang until the abort signal fires, then reject (simulates timeout). */
  readonly hang?: boolean;
}

export interface FakeLlmClient extends LlmClient {
  /** Every `complete()` call's params, for assertions. */
  readonly calls: LlmCompleteParams[];
  /** Tool names exposed to the model on the last call (post-permission filter). */
  readonly lastToolNames: string[];
}

/**
 * Deterministic in-memory client. It replays {@link FakeLlmConfig.steps},
 * validating each input against the real tool's schema (as a well-behaved model
 * would) and invoking the tool's `execute` so side effects and trace happen
 * exactly as in production. A call to a tool that was not exposed is recorded as
 * an error tool call — this is how a "denied tool" path is exercised.
 */
export function createFakeLlmClient(config: FakeLlmConfig = {}): FakeLlmClient {
  const calls: LlmCompleteParams[] = [];
  let lastToolNames: string[] = [];

  return {
    calls,
    get lastToolNames() {
      return lastToolNames;
    },
    async complete(params: LlmCompleteParams): Promise<LlmResult> {
      calls.push(params);
      lastToolNames = Object.keys(params.tools);

      if (config.hang) {
        return new Promise<LlmResult>((_resolve, reject) => {
          const signal = params.abortSignal;
          if (!signal) return; // no signal → caller must bound it elsewhere
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true
          });
        });
      }
      if (config.error !== undefined) throw config.error;

      const toolCalls: LlmToolCall[] = [];
      for (const step of config.steps ?? []) {
        const tool = params.tools[step.tool];
        if (!tool) {
          toolCalls.push({
            toolName: step.tool,
            input: step.input,
            error: "tool_not_available"
          });
          continue;
        }
        const parsed = tool.inputSchema.safeParse(step.input);
        if (!parsed.success) {
          toolCalls.push({
            toolName: step.tool,
            input: step.input,
            error: "invalid_input"
          });
          continue;
        }
        try {
          const output = await tool.execute(parsed.data);
          toolCalls.push({ toolName: step.tool, input: parsed.data, output });
        } catch (err) {
          toolCalls.push({
            toolName: step.tool,
            input: parsed.data,
            error: err instanceof Error ? err.message : String(err)
          });
        }
        if (params.stopOnToolName && step.tool === params.stopOnToolName) break;
      }

      return {
        text: config.finalText ?? "",
        toolCalls,
        finishReason: "stop"
      };
    }
  };
}
