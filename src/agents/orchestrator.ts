/**
 * Orchestrator Durable Object (CONTEXT.md §3, §7).
 *
 * An `AIChatAgent` that owns a single user session. It streams the chat, exposes
 * one `delegate` tool to the model, and runs the validated plan through the
 * executor. Identity is derived from the DO instance name (`${userId}:${sessionId}`,
 * server-minted) — never from message text. All state lives in the DO's SQLite:
 * a `session` row (role bound at creation) and the per-turn `trace`.
 *
 * The DO class is intentionally still named `ChatAgent` so the Worker binding,
 * SQLite migration, and client routing from Phase 0 keep working unchanged; the
 * UI is renamed/redesigned in Phase 6.
 */

import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { createWorkersAI } from "workers-ai-provider";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool,
  type StreamTextOnFinishCallback,
  type ToolSet
} from "ai";
import { LIMITS, modelFor } from "../config";
import { resolveUser, type User } from "../identity";
import { TOOL_REGISTRY } from "../permissions/registry";
import { createWorkersAiLlmClient } from "../llm";
import { createTracer, type TraceEvent } from "../trace";
import { parsePlan, planSchema } from "../orchestration/plan";
import { runExecutor } from "../orchestration/executor";

interface TraceRow {
  id: string;
  ts: string;
  turnId: string;
  agent: string;
  event: string;
  detailJson: string;
}

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;

  async onStart(): Promise<void> {
    this.sql`CREATE TABLE IF NOT EXISTS session (
      user_id TEXT, role TEXT, created_at TEXT, model_config TEXT
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS trace (
      id TEXT PRIMARY KEY, ts TEXT, turn_id TEXT, agent TEXT, event TEXT, detail_json TEXT
    )`;

    const user = this.sessionUser();
    const existing = this.sql<{ c: number }>`SELECT COUNT(*) AS c FROM session`;
    if ((existing[0]?.c ?? 0) === 0) {
      const modelConfig = JSON.stringify({
        orchestrator: modelFor("orchestrator", this.env),
        specialist: modelFor("specialist", this.env)
      });
      this.sql`INSERT INTO session (user_id, role, created_at, model_config)
        VALUES (${user.id}, ${user.role}, ${new Date().toISOString()}, ${modelConfig})`;
    }
  }

  async onChatMessage(
    _onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ): Promise<Response | undefined> {
    const user = this.sessionUser();
    const turnId = crypto.randomUUID();
    const tracer = createTracer(turnId, (e) => this.persistTrace(e));
    tracer.emit("orchestrator", "permission_resolved", {
      user: user.id,
      role: user.role
    });

    const orchestratorModel = modelFor("orchestrator", this.env);
    const specialistModel = modelFor("specialist", this.env);
    const specialistLlm = createWorkersAiLlmClient(this.env);
    const workersai = createWorkersAI({ binding: this.env.AI });
    let delegated = false;

    const result = streamText({
      model: workersai(orchestratorModel, {
        sessionAffinity: this.sessionAffinity
      }),
      system: orchestratorSystemPrompt(user),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        delegate: tool({
          description:
            "Delegate one or more self-contained tasks to the IT and/or HR " +
            "specialists. Each task is independent prose the specialist can act " +
            "on without seeing the chat. Use dependsOn to chain tasks whose input " +
            "comes from another task's result. Max 4 tasks.",
          inputSchema: planSchema,
          execute: async ({ tasks }) => {
            delegated = true;
            const parsed = parsePlan({ tasks });
            if (!parsed.ok) {
              tracer.emit("orchestrator", "delegation_planned", {
                rejected: parsed.error
              });
              return {
                ok: false,
                error: `Invalid plan (${parsed.error.code}): ${parsed.error.message}`
              };
            }
            const exec = await runExecutor({
              plan: parsed.plan,
              waves: parsed.waves,
              user,
              llm: specialistLlm,
              modelId: specialistModel,
              tracer
            });
            return {
              ok: true,
              results: exec.results,
              guardNotice: exec.guardNotice
            };
          }
        })
      },
      stopWhen: stepCountIs(LIMITS.ORCHESTRATOR_MAX_STEPS),
      abortSignal: options?.abortSignal,
      onFinish: () => {
        // A turn that never delegated is a clarification / direct answer — a
        // successful outcome, not a failure (CONTEXT.md §3.1).
        if (!delegated) {
          tracer.emit("orchestrator", "clarification_requested", {});
        }
        tracer.emit("orchestrator", "turn_end", { delegated });
      }
    });

    return result.toUIMessageStreamResponse();
  }

  /** Read the full trace for this session (RPC target for the /api route). */
  async getTrace(): Promise<TraceRow[]> {
    return this.sql<TraceRow>`SELECT id, ts, turn_id AS turnId, agent, event,
      detail_json AS detailJson FROM trace ORDER BY ts, id`;
  }

  private persistTrace(event: TraceEvent): void {
    this.sql`INSERT INTO trace (id, ts, turn_id, agent, event, detail_json)
      VALUES (${event.id}, ${event.ts}, ${event.turnId}, ${event.agent},
        ${event.event}, ${JSON.stringify(event.detail)})`;
  }

  /** Resolve the owning user from the server-minted instance name. */
  private sessionUser(): User {
    const sep = this.name.indexOf(":");
    const userId = sep > 0 ? this.name.slice(0, sep) : this.name;
    const user = resolveUser(userId);
    if (!user)
      throw new Error(`unknown session user for instance ${this.name}`);
    return user;
  }
}

/** System prompt listing the user's capability boundaries and delegation rules. */
function orchestratorSystemPrompt(user: User): string {
  const roleDenied = TOOL_REGISTRY.filter(
    (t) => !t.roles.includes(user.role)
  ).map((t) => t.name);
  const deniedLine =
    roleDenied.length > 0
      ? `This user's role (${user.role}) is NOT permitted to use: ${roleDenied.join(", ")}. ` +
        "If the request needs one of these, explain honestly that it is not available to this user rather than attempting it."
      : `This user's role (${user.role}) has no role-level capability restrictions.`;

  return [
    "You are the orchestrator for Acme d.o.o.'s internal IT + HR assistant.",
    "You coordinate two specialists via the `delegate` tool: an IT specialist " +
      "(service status, password resets, IT knowledge base) and an HR specialist " +
      "(company policies, leave, equipment profiles). You never do their work " +
      "yourself and you never invent facts.",
    "Decide what each specialist should do, then call `delegate` with " +
      "self-contained task instructions. Chain tasks with dependsOn only when one " +
      "genuinely needs another's output. If the request is ambiguous, ask ONE " +
      "concise clarifying question instead of delegating.",
    deniedLine,
    "When specialists return results, compose a single honest answer. If a task " +
      "failed or returned limitations, say so plainly — never claim success that " +
      "the results do not support."
  ].join("\n\n");
}
