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
import { resolveUser, type Role, type User } from "../identity";
import { TOOL_REGISTRY } from "../permissions/registry";
import { createWorkersAiLlmClient, type SpecialistToolMap } from "../llm";
import { createTracer, type TraceEvent, type Tracer } from "../trace";
import { parsePlan, planSchema } from "../orchestration/plan";
import { runExecutor } from "../orchestration/executor";
import {
  discoverMcpTools,
  parseMcpContent,
  type McpToolRef
} from "../mcp/client";
import { loadSkills, type Skill } from "../skills/loader";
import { BUNDLED_SKILLS } from "../skills/bundled";
import { NATIVE_TOOLS } from "../tools/native";
import { buildLeaveTools } from "../tools/leave";
import { leaveStore } from "../leave/store";

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
    // Discover MCP tools once per turn; failure degrades gracefully to none.
    const mcpTools = await this.discoverMcp(tracer);
    // Resolve skills once per turn (KV source of truth, bundled fallback).
    const skills = await this.loadTurnSkills();
    // Native tools for this turn: the static mocks plus the leave-request tools
    // bound to the acting user and the shared store (scenario 9). Exposure is
    // still gated per (user, agent) by allowedTools inside the specialist.
    const nativeTools = {
      ...NATIVE_TOOLS,
      ...buildLeaveTools(user, leaveStore(this.env))
    };
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
              tracer,
              mcpTools,
              skills,
              nativeTools
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

  /**
   * Connect to the Acme MCP server (if configured) and discover its tools for
   * this turn. Connection and discovery are bounded and caught — a dead or
   * misbehaving MCP server never blocks or crashes the turn (CONTEXT.md §5).
   */
  private async discoverMcp(tracer: Tracer): Promise<SpecialistToolMap> {
    const url = this.env.MCP_URL;
    if (!url) {
      tracer.emit("orchestrator", "mcp_discovery", {
        ok: false,
        error: "MCP_URL not configured"
      });
      return {};
    }
    const { tools } = await discoverMcpTools({
      tracer,
      timeoutMs: LIMITS.MCP_TIMEOUT_MS,
      listTools: async () => {
        const serverId = await this.ensureMcpConnection(url);
        return this.mcp
          .listTools({ serverId })
          .map((t) => ({ name: t.name, serverId: t.serverId }));
      },
      call: async (ref: McpToolRef, args) => {
        const result = await this.mcp.callTool(
          { serverId: ref.serverId, name: ref.name, arguments: args },
          undefined,
          { timeout: LIMITS.MCP_TIMEOUT_MS }
        );
        return parseMcpContent(result);
      }
    });
    return tools;
  }

  /**
   * Ensure a single connection to the MCP server, reusing an existing one across
   * hibernation. Bounded by the MCP timeout so a hanging connect cannot wedge the
   * DO. Returns the server id to address tool calls.
   */
  private async ensureMcpConnection(url: string): Promise<string> {
    const existing = Object.entries(this.mcp.mcpConnections).find(
      ([, conn]) => String((conn as { url?: URL }).url ?? "") === url
    );
    if (existing) return existing[0];
    const connected = await new Promise<{ id: string }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("mcp_connect_timeout")),
        LIMITS.MCP_TIMEOUT_MS
      );
      this.addMcpServer("acme", url).then(
        (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        }
      );
    });
    return connected.id;
  }

  /** Resolve this turn's skills: KV `SKILLS` if seeded, else the bundled set. */
  private async loadTurnSkills(): Promise<Skill[]> {
    return loadSkills(this.env, BUNDLED_SKILLS);
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

/** Friendly, user-facing names for the internal role ids. */
const ROLE_LABELS: Record<Role, string> = {
  employee: "Employee",
  it_admin: "IT Administrator",
  hr_admin: "HR Administrator"
};

/**
 * Plain-language, user-facing description of each capability. Keyed by registry
 * tool name; `load_skill` is internal and intentionally omitted. `get_leave_requests`
 * reads differently for an admin (sees everyone) vs an employee (sees their own).
 */
function capabilityPhrase(toolName: string, role: Role): string | null {
  switch (toolName) {
    case "get_service_status":
      return "check the status of internal IT services";
    case "search_it_kb":
      return "search the IT knowledge base for troubleshooting help";
    case "search_policies":
    case "read_policy":
      return "look up company policies";
    case "get_equipment_profile":
      return "look up the standard equipment profile for a role";
    case "submit_leave_request":
      return "submit a leave request";
    case "get_leave_requests":
      return role === "hr_admin"
        ? "view all employees' leave requests and their status"
        : "check the status of your own leave requests";
    case "get_leave_balance":
      return role === "hr_admin"
        ? "look up any employee's PTO (leave) balance"
        : "check your own PTO (leave) balance";
    case "reset_password":
      return "reset another user's password";
    case "approve_leave_request":
      return "approve pending leave requests";
    default:
      return null; // internal (e.g. load_skill) — not user-facing
  }
}

/** System prompt listing the user's capabilities (authoritative) and delegation rules. */
function orchestratorSystemPrompt(user: User): string {
  const roleLabel = ROLE_LABELS[user.role];
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const weekday = now.toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "UTC"
  });

  // The COMPLETE, authoritative list of what this role can do, in plain language
  // (deduped — several tools collapse to one user-facing capability).
  const can = new Set<string>();
  // The subset unique to this role (not available to a regular employee).
  const extra = new Set<string>();
  for (const t of TOOL_REGISTRY) {
    if (!t.roles.includes(user.role)) continue;
    const p = capabilityPhrase(t.name, user.role);
    if (!p) continue;
    can.add(p);
    if (!t.roles.includes("employee")) extra.add(p);
  }
  const canList = [...can].map((p) => `- ${p}`).join("\n");
  const extraLine =
    extra.size > 0
      ? `Of these, the ONLY abilities a regular Employee does not also have are: ${[...extra].join("; ")}. Do not claim any other difference from an employee.`
      : "This role has the standard shared capabilities and no extra privileged abilities.";

  return [
    "You are the orchestrator for the TX Service internal IT + HR help desk.",
    "You coordinate two specialists via the `delegate` tool: an IT specialist " +
      "(service status, password resets, IT knowledge base) and an HR specialist " +
      "(company policies, equipment profiles, and leave requests — submitting, " +
      "listing, and approving them). You never do their work " +
      "yourself and you never invent facts.",
    "Decide what each specialist should do, then call `delegate` with " +
      "self-contained task instructions. Keep each instruction SHORT and specific " +
      "(one or two sentences naming exactly what the specialist should look up or " +
      "do) — do not enumerate every possible topic or restate policy; the " +
      "specialist has its own tools and will decide how to answer. Chain tasks " +
      "with dependsOn only when one genuinely needs another's output. If the " +
      "request is ambiguous, ask ONE concise clarifying question instead of " +
      "delegating. Do NOT narrate what you are about to do (no 'I'll ask the HR " +
      "specialist…', no preamble) — call delegate directly and write " +
      "user-facing text only as your single final answer once results return.",
    `The user is signed in as ${roleLabel}. Always refer to their role by this ` +
      "friendly name, never the internal id (not 'it_admin'/'hr_admin').",
    `This is the COMPLETE and EXACT list of what you can help this ${roleLabel} ` +
      `with — treat it as the whole truth and never claim, imply, or invent any ` +
      `ability beyond it (there is NO 'reset your own password', no self-service ` +
      `portal, no benefits/payroll actions, etc.):\n${canList}`,
    extraLine,
    "When the user asks what you can help with or what their role can do, answer " +
      "DIRECTLY (do not delegate) using ONLY the list above, in plain language. " +
      "Do NOT volunteer a list of things they cannot do, and do NOT mention " +
      "abilities that belong to other roles. If the user asks for an action that " +
      "is not on the list, tell them plainly it is not available to their role " +
      "and never invent a reason for it.",
    "In every user-facing answer, speak as a single assistant in the first " +
      "person ('I can help you …'). Never mention the internal IT/HR specialists, " +
      "the delegate mechanism, or raw tool names — describe capabilities in plain " +
      "language.",
    `Today is ${weekday}, ${today} (UTC). Resolve relative dates yourself — ` +
      "'this Friday', 'next Monday', 'in 10 days' — into concrete YYYY-MM-DD " +
      "dates; NEVER ask the user to compute a calendar date for you. A leave " +
      "request needs a start date, an end date, and a reason; if the user gives " +
      "a start plus a duration (e.g. '10 days from Friday'), compute the end " +
      "date yourself (an N-day leave ending on start+N-1).",
    "To actually DO something — submit or approve a leave request, reset a " +
      "password — you MUST delegate it so the specialist calls the real tool; a " +
      "text reply performs NOTHING. Once you have the needed details, delegate " +
      "the action immediately. NEVER say you 'will' submit/approve something " +
      "'now' or 'shortly', and never state that an action was done unless a " +
      "specialist tool actually returned a result confirming it (e.g. a leave " +
      "request id). If details are missing, ask only for exactly what is missing.",
    "When specialists return results, compose a single honest answer. If a task " +
      "failed or returned limitations, say so plainly — never claim success that " +
      "the results do not support. When a leave request is submitted, report the " +
      "returned request id and its status so the user can track it."
  ].join("\n\n");
}
