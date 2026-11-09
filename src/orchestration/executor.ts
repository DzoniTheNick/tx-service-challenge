/**
 * Executor (CONTEXT.md §3.1) — the no-LLM engine that runs a validated plan.
 *
 *   1. Run each wave with `Promise.all` (same-wave tasks execute in parallel).
 *   2. Inject each dependency's result into dependent tasks (`result_passed`).
 *   3. A failed dependency marks its dependents `failed: dependency_failed` without
 *      running them; one task's failure never aborts the turn.
 *   4. After all waves, if EVERY task failed, apply a deterministic guard so the
 *      orchestrator's final answer cannot claim success (`guard_applied`).
 *
 * The specialist runner is injected (`runTask`) so the executor is fully testable
 * against a fake — the plan's "never cut" executor tests exercise parallel timing,
 * dependency passing, and failure propagation here.
 */

import type { User } from "../identity";
import type { LlmClient, SpecialistToolMap } from "../llm";
import type { Tracer } from "../trace";
import { runSpecialist, type SpecialistTask } from "../agents/specialists";
import type { SpecialistResult } from "../agents/contract";
import type { Skill } from "../skills/loader";
import type { Plan, PlanTask } from "./plan";

export interface RunTaskArgs {
  readonly agent: PlanTask["agent"];
  readonly user: User;
  readonly task: SpecialistTask;
  readonly llm: LlmClient;
  readonly modelId: string;
  readonly tracer: Tracer;
  readonly mcpTools?: SpecialistToolMap;
  readonly skills?: readonly Skill[];
}

/** The unit of work the executor delegates; defaults to {@link runSpecialist}. */
export type RunTask = (args: RunTaskArgs) => Promise<SpecialistResult>;

export interface ExecutorParams {
  readonly plan: Plan;
  readonly waves: string[][];
  readonly user: User;
  readonly llm: LlmClient;
  readonly modelId: string;
  readonly tracer: Tracer;
  readonly runTask?: RunTask;
  /** MCP tools discovered for this turn, forwarded to every specialist. */
  readonly mcpTools?: SpecialistToolMap;
  /** Skills resolved for this turn, forwarded to every specialist. */
  readonly skills?: readonly Skill[];
}

export interface ExecutorResult {
  /** Results in plan order. */
  readonly results: SpecialistResult[];
  readonly byId: Record<string, SpecialistResult>;
  readonly allFailed: boolean;
  /** Fixed notice appended when every task failed (CONTEXT.md §3.1 step 6). */
  readonly guardNotice?: string;
}

const GUARD_NOTICE =
  "All delegated tasks failed. Do not claim the request was completed; " +
  "explain honestly what went wrong and what the user can do next.";

const defaultRunTask: RunTask = (a) =>
  runSpecialist({
    agent: a.agent,
    user: a.user,
    task: a.task,
    llm: a.llm,
    modelId: a.modelId,
    tracer: a.tracer,
    mcpTools: a.mcpTools,
    skills: a.skills
  });

export async function runExecutor(
  params: ExecutorParams
): Promise<ExecutorResult> {
  const runTask = params.runTask ?? defaultRunTask;
  const taskById = new Map(params.plan.tasks.map((t) => [t.id, t]));
  const results = new Map<string, SpecialistResult>();

  params.tracer.emit("orchestrator", "delegation_planned", {
    tasks: params.plan.tasks.map((t) => ({
      id: t.id,
      agent: t.agent,
      dependsOn: t.dependsOn ?? []
    })),
    waves: params.waves
  });

  for (const wave of params.waves) {
    await Promise.all(
      wave.map(async (id) => {
        const task = taskById.get(id);
        if (!task) return; // waves are derived from tasks; unreachable
        const deps = task.dependsOn ?? [];

        // Short-circuit: a failed dependency fails the dependent without running.
        const failedDep = deps.find((d) => results.get(d)?.status === "failed");
        if (failedDep) {
          const failed: SpecialistResult = {
            taskId: id,
            agent: task.agent,
            status: "failed",
            answer: "",
            limitations: [`dependency_failed: ${failedDep}`],
            toolErrors: []
          };
          results.set(id, failed);
          params.tracer.emit(task.agent, "specialist_end", {
            taskId: id,
            status: "failed",
            reason: "dependency_failed"
          });
          return;
        }

        // Inject upstream results for this task's dependencies.
        const inputs: Record<string, SpecialistResult> = {};
        for (const d of deps) {
          const dr = results.get(d);
          if (dr) {
            inputs[d] = dr;
            params.tracer.emit("orchestrator", "result_passed", {
              from: d,
              to: id
            });
          }
        }

        try {
          const result = await runTask({
            agent: task.agent,
            user: params.user,
            task: {
              taskId: id,
              instruction: task.instruction,
              inputs: deps.length ? inputs : undefined
            },
            llm: params.llm,
            modelId: params.modelId,
            tracer: params.tracer,
            mcpTools: params.mcpTools,
            skills: params.skills
          });
          results.set(id, result);
        } catch (err) {
          // runSpecialist is designed not to throw, but never let a stray throw
          // abort the whole turn (CONTEXT.md §3.1 step 4).
          const message = err instanceof Error ? err.message : String(err);
          results.set(id, {
            taskId: id,
            agent: task.agent,
            status: "failed",
            answer: "",
            limitations: [`executor error: ${message}`],
            toolErrors: []
          });
        }
      })
    );
  }

  const ordered = params.plan.tasks.map((t) => results.get(t.id)!);
  const allFailed =
    ordered.length > 0 && ordered.every((r) => r.status === "failed");

  let guardNotice: string | undefined;
  if (allFailed) {
    guardNotice = GUARD_NOTICE;
    params.tracer.emit("orchestrator", "guard_applied", {
      reason: "all_tasks_failed"
    });
  }

  return {
    results: ordered,
    byId: Object.fromEntries(results),
    allFailed,
    guardNotice
  };
}
