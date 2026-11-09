/**
 * Specialist runner (CONTEXT.md §3.1–§3.2). `runSpecialist` executes one
 * delegated task for one agent (IT or HR) on behalf of one user:
 *
 *   1. `allowedTools(user, agent)` decides what the specialist may use — code
 *      enforces, discovery never bypasses it (a `permission_check` trace row).
 *   2. The permitted native tools + a `submit_result` tool are handed to the LLM.
 *   3. The model loops (≤ 5 steps, 25 s AbortSignal) and calls `submit_result`
 *      to return a structured {@link SpecialistResult}. Code owns the identity
 *      fields `taskId`/`agent`; the model never supplies them.
 *   4. If the loop ends without a valid `submit_result` (step limit, timeout,
 *      plain text), the runner wraps the outcome as `partial`/`failed` so a turn
 *      can never silently claim success.
 *
 * Errors become typed results here; nothing is thrown across the agent boundary
 * (CONTEXT.md §14).
 */

import { z } from "zod";
import { LIMITS } from "../config";
import type { User } from "../identity";
import { allowedTools } from "../permissions/allowed";
import type { AgentId } from "../permissions/registry";
import type { LlmClient, SpecialistTool, SpecialistToolMap } from "../llm";
import type { Tracer } from "../trace";
import { NATIVE_TOOLS } from "../tools/native";
import {
  loadSkillFor,
  skillIndex,
  skillsForAgent,
  type Skill
} from "../skills/loader";
import {
  submitResultSchema,
  type SpecialistResult,
  type SubmitResultInput
} from "./contract";

/** A unit of delegated work (produced by the executor from the plan). */
export interface SpecialistTask {
  readonly taskId: string;
  readonly instruction: string;
  /** Upstream results injected for `dependsOn` tasks (CONTEXT.md §3.1). */
  readonly inputs?: Record<string, SpecialistResult>;
}

export interface RunSpecialistParams {
  readonly agent: AgentId;
  readonly user: User;
  readonly task: SpecialistTask;
  readonly llm: LlmClient;
  readonly modelId: string;
  readonly tracer: Tracer;
  /** Override the 25 s default (tests use a few ms). */
  readonly timeoutMs?: number;
  /** Override native tool implementations (tests inject fakes). */
  readonly nativeTools?: Readonly<Record<string, SpecialistTool>>;
  /** MCP tools discovered this turn (CONTEXT.md §5); permission-filtered here. */
  readonly mcpTools?: SpecialistToolMap;
  /** All skills for the turn (CONTEXT.md §6); scoped to this agent here. */
  readonly skills?: readonly Skill[];
}

const SYSTEM_PROMPTS: Record<AgentId, string> = {
  it:
    "You are the IT support specialist for Acme d.o.o. Diagnose and resolve " +
    "first-level IT issues using ONLY the tools you have been given. Never claim " +
    "to have done something a tool did not confirm. When you are finished, call " +
    "submit_result with an honest status, your answer, and any limitations.",
  hr:
    "You are the HR specialist for Acme d.o.o. Answer policy, leave and equipment " +
    "questions using ONLY the tools you have been given, grounded in company " +
    "policy. Never invent policy. When you are finished, call submit_result with " +
    "an honest status, your answer, and any limitations."
};

/** System prompt for the agent, with the (scoped) skill index appended. */
function buildSystemPrompt(agent: AgentId, skills: readonly Skill[]): string {
  const index = skillIndex(agent, skills);
  if (index.length === 0) return SYSTEM_PROMPTS[agent];
  const lines = index.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return (
    `${SYSTEM_PROMPTS[agent]}\n\n` +
    "Skills available to you (load the relevant one with load_skill BEFORE " +
    `answering, then follow it):\n${lines}`
  );
}

/** Build the user-facing prompt, folding in any upstream structured inputs. */
function buildPrompt(task: SpecialistTask): string {
  const inputs = task.inputs ?? {};
  const entries = Object.entries(inputs);
  if (entries.length === 0) return task.instruction;
  const payload = entries.map(([id, r]) => ({
    from: id,
    agent: r.agent,
    status: r.status,
    answer: r.answer,
    data: r.data
  }));
  return `${task.instruction}\n\nStructured inputs from prior steps (use these, do not re-derive):\n${JSON.stringify(payload)}`;
}

export async function runSpecialist(
  params: RunSpecialistParams
): Promise<SpecialistResult> {
  const { agent, user, task, llm, modelId, tracer } = params;
  const timeoutMs = params.timeoutMs ?? LIMITS.SPECIALIST_TIMEOUT_MS;
  const skills = params.skills ?? [];
  const agentSkills = skillsForAgent(agent, skills);

  // Permitted tools are resolved from native implementations, MCP tools
  // discovered this turn, and load_skill (only when the agent has skills);
  // permission filtering below is the only gate.
  const impls: SpecialistToolMap = {
    ...(params.nativeTools ?? NATIVE_TOOLS),
    ...(params.mcpTools ?? {}),
    ...(agentSkills.length > 0
      ? {
          load_skill: buildLoadSkillTool(
            agent,
            task.taskId,
            agentSkills,
            tracer
          )
        }
      : {})
  };

  tracer.emit(agent, "specialist_start", {
    taskId: task.taskId,
    instruction: task.instruction
  });

  // 1. Permission decision (code enforces).
  const { allowed, denied } = allowedTools(user, agent);
  tracer.emit(agent, "permission_check", {
    taskId: task.taskId,
    allowed: allowed.map((t) => t.name),
    denied
  });

  // 2. Expose only permitted tools that have an implementation available
  //    (native + discovered MCP tools; load_skill arrives in Phase 5).
  const toolErrors: string[] = [];
  const exposed: SpecialistToolMap = {};
  for (const descriptor of allowed) {
    const impl = impls[descriptor.name];
    if (!impl) continue;
    exposed[descriptor.name] = wrapWithTrace(
      descriptor.name,
      impl,
      tracer,
      agent,
      task.taskId,
      toolErrors
    );
  }

  // 3. submit_result: the model's structured hand-off. Identity is stamped by us.
  let submitted: SubmitResultInput | undefined;
  exposed.submit_result = {
    description:
      "Return your final structured result. Call this exactly once when done.",
    inputSchema: submitResultSchema,
    execute: (input) => {
      const parsed = submitResultSchema.safeParse(input);
      if (!parsed.success) {
        return { ok: false, error: "invalid submit_result; fix and resubmit" };
      }
      submitted = parsed.data;
      return { ok: true };
    }
  };

  // 4. Run the model loop, bounded by a timeout AbortSignal.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("specialist_timeout")),
    timeoutMs
  );
  let timedOut = false;
  let runError: unknown;
  try {
    await llm.complete({
      modelId,
      system: buildSystemPrompt(agent, skills),
      prompt: buildPrompt(task),
      tools: exposed,
      maxSteps: LIMITS.SPECIALIST_MAX_STEPS,
      stopOnToolName: "submit_result",
      abortSignal: controller.signal
    });
  } catch (err) {
    if (controller.signal.aborted) timedOut = true;
    else runError = err;
  } finally {
    clearTimeout(timer);
  }

  const result = assembleResult({
    taskId: task.taskId,
    agent,
    submitted,
    toolErrors,
    timedOut,
    runError
  });

  tracer.emit(agent, "specialist_end", {
    taskId: task.taskId,
    status: result.status,
    toolErrors: result.toolErrors
  });
  return result;
}

/** Wrap a tool so each call emits a `tool_call` trace row and records errors. */
function wrapWithTrace(
  name: string,
  tool: SpecialistTool,
  tracer: Tracer,
  agent: AgentId,
  taskId: string,
  toolErrors: string[]
): SpecialistTool {
  return {
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: async (input) => {
      const start = Date.now();
      try {
        const output = await tool.execute(input);
        tracer.emit(agent, "tool_call", {
          taskId,
          name,
          ok: true,
          duration_ms: Date.now() - start
        });
        return output;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toolErrors.push(`${name}: ${message}`);
        tracer.emit(agent, "tool_call", {
          taskId,
          name,
          ok: false,
          error: message,
          duration_ms: Date.now() - start
        });
        return { ok: false, error: message };
      }
    }
  };
}

/**
 * The `load_skill` tool for one agent. Enforces skill scope (CONTEXT.md §6): it
 * can only load a skill whose `agents` frontmatter includes this agent. A
 * successful load emits a `skill_loaded` trace row and returns the body.
 */
function buildLoadSkillTool(
  agent: AgentId,
  taskId: string,
  agentSkills: readonly Skill[],
  tracer: Tracer
): SpecialistTool {
  const names = agentSkills.map((s) => s.name).join(", ");
  return {
    description: `Load the full body of a skill by name (available: ${names}). Load one before answering, then follow it.`,
    inputSchema: z.object({
      name: z.string().describe("The skill name to load")
    }),
    execute: (input) => {
      const { name } = input as { name: string };
      const result = loadSkillFor(agent, name, agentSkills);
      if (result.ok) {
        tracer.emit(agent, "skill_loaded", { taskId, name: result.name });
      }
      return result;
    }
  };
}

function assembleResult(args: {
  taskId: string;
  agent: AgentId;
  submitted: SubmitResultInput | undefined;
  toolErrors: string[];
  timedOut: boolean;
  runError: unknown;
}): SpecialistResult {
  const { taskId, agent, submitted, toolErrors, timedOut, runError } = args;

  if (submitted) {
    return {
      taskId,
      agent,
      status: submitted.status,
      answer: submitted.answer,
      data: submitted.data,
      limitations: submitted.limitations,
      toolErrors: dedupe([...submitted.toolErrors, ...toolErrors])
    };
  }

  if (timedOut) {
    return {
      taskId,
      agent,
      status: "failed",
      answer: "",
      limitations: ["specialist timed out before returning a result"],
      toolErrors: dedupe(toolErrors)
    };
  }

  if (runError !== undefined) {
    const message =
      runError instanceof Error ? runError.message : String(runError);
    return {
      taskId,
      agent,
      status: "failed",
      answer: "",
      limitations: [`specialist error: ${message}`],
      toolErrors: dedupe(toolErrors)
    };
  }

  // Ran to completion but never produced a structured result.
  return {
    taskId,
    agent,
    status: "partial",
    answer: "",
    limitations: ["specialist did not return a structured result"],
    toolErrors: dedupe(toolErrors)
  };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
