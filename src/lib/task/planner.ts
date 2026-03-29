/**
 * Task Planner — generates task queue from a plan automatically.
 *
 * A plan is a list of steps with dependencies. The planner watches
 * for completed tasks and enqueues the next available steps.
 *
 * Usage:
 *   const planner = new TaskPlanner(taskManager);
 *   planner.loadPlan({
 *     id: "deploy-v2",
 *     steps: [
 *       { id: "test", type: "run_tests", input: { suite: "all" } },
 *       { id: "build", type: "build", input: { target: "prod" }, depends_on: ["test"] },
 *       { id: "deploy", type: "deploy", input: { env: "prod" }, depends_on: ["build"] },
 *     ]
 *   });
 *   planner.start(); // Enqueues "test" immediately, "build" after "test" completes, etc.
 */

import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import type { TaskManager, TrackedTask } from "./manager";
import type { AgentId } from "../../types/protocol";

export interface PlanStep {
  id: string;
  type: string;
  description?: string;
  input: Record<string, unknown>;
  depends_on?: string[];          // Step IDs that must complete first
  assign_to?: AgentId;            // Specific peer, or auto-assign
  timeout_ms?: number;
  priority?: "low" | "normal" | "high";
}

export interface Plan {
  id: string;
  name?: string;
  steps: PlanStep[];
}

export interface PlanState {
  plan: Plan;
  status: "pending" | "running" | "completed" | "failed";
  step_status: Record<string, "pending" | "queued" | "running" | "completed" | "failed">;
  step_tasks: Record<string, string>;   // step_id → task_id
  step_results: Record<string, unknown>;
  started_at?: number;
  completed_at?: number;
}

export class TaskPlanner extends EventEmitter {
  private taskManager: TaskManager;
  private plans = new Map<string, PlanState>();
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(taskManager: TaskManager) {
    super();
    this.taskManager = taskManager;

    // Listen for task completions to advance plans
    taskManager.on("worker:task_completed", ({ task }: { task: TrackedTask }) => {
      this.onTaskCompleted(task.task_id, "completed", task.result?.output);
    });
    taskManager.on("worker:task_failed", ({ task }: { task: TrackedTask }) => {
      this.onTaskCompleted(task.task_id, "failed");
    });
  }

  /** Load a plan and prepare it for execution */
  loadPlan(plan: Plan): PlanState {
    const state: PlanState = {
      plan,
      status: "pending",
      step_status: {},
      step_tasks: {},
      step_results: {},
    };
    for (const step of plan.steps) {
      state.step_status[step.id] = "pending";
    }
    this.plans.set(plan.id, state);
    console.error(`[Planner] Loaded plan: ${plan.id} (${plan.steps.length} steps)`);
    return state;
  }

  /** Start executing a plan — enqueues all steps with no dependencies */
  start(planId: string): void {
    const state = this.plans.get(planId);
    if (!state) throw new Error(`Plan ${planId} not found`);

    state.status = "running";
    state.started_at = Date.now();
    this.enqueueReady(state);

    // Periodic check for stuck plans
    if (!this.checkTimer) {
      this.checkTimer = setInterval(() => {
        for (const [, ps] of this.plans) {
          if (ps.status === "running") this.enqueueReady(ps);
        }
      }, 10_000);
    }

    console.error(`[Planner] Started plan: ${planId}`);
  }

  /** Get plan state */
  getPlan(planId: string): PlanState | undefined {
    return this.plans.get(planId);
  }

  /** List all plans */
  listPlans(): PlanState[] {
    return Array.from(this.plans.values());
  }

  private enqueueReady(state: PlanState): void {
    for (const step of state.plan.steps) {
      if (state.step_status[step.id] !== "pending") continue;

      // Check dependencies
      const deps = step.depends_on || [];
      const allDepsComplete = deps.every(d => state.step_status[d] === "completed");
      const anyDepFailed = deps.some(d => state.step_status[d] === "failed");

      if (anyDepFailed) {
        state.step_status[step.id] = "failed";
        console.error(`[Planner] Step ${step.id} failed — dependency failed`);
        continue;
      }

      if (!allDepsComplete) continue;

      // Enqueue this step
      const task = this.taskManager.enqueue({
        type: step.type,
        description: step.description || `Plan ${state.plan.id} step ${step.id}`,
        input: {
          ...step.input,
          _plan_id: state.plan.id,
          _step_id: step.id,
          // Inject results from dependencies
          _dep_results: deps.reduce((acc, d) => {
            acc[d] = state.step_results[d];
            return acc;
          }, {} as Record<string, unknown>),
        },
        timeout_ms: step.timeout_ms,
        priority: step.priority,
      }, step.assign_to);

      state.step_status[step.id] = "queued";
      state.step_tasks[step.id] = task.task_id;
      console.error(`[Planner] Enqueued step ${step.id} → task ${task.task_id}`);

      this.emit("step:enqueued", { planId: state.plan.id, stepId: step.id, taskId: task.task_id });
    }
  }

  private onTaskCompleted(taskId: string, result: "completed" | "failed", output?: unknown): void {
    for (const [, state] of this.plans) {
      if (state.status !== "running") continue;

      for (const [stepId, tid] of Object.entries(state.step_tasks)) {
        if (tid !== taskId) continue;

        state.step_status[stepId] = result;
        if (output) state.step_results[stepId] = output;
        console.error(`[Planner] Step ${stepId} ${result}`);
        this.emit(`step:${result}`, { planId: state.plan.id, stepId, taskId, output });

        // Check if plan is complete
        const allDone = Object.values(state.step_status).every(s => s === "completed" || s === "failed");
        if (allDone) {
          const anyFailed = Object.values(state.step_status).some(s => s === "failed");
          state.status = anyFailed ? "failed" : "completed";
          state.completed_at = Date.now();
          console.error(`[Planner] Plan ${state.plan.id} ${state.status} (${Date.now() - (state.started_at || 0)}ms)`);
          this.emit("plan:completed", { planId: state.plan.id, status: state.status });
        } else {
          // Enqueue next steps
          this.enqueueReady(state);
        }
        return;
      }
    }
  }

  destroy(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    this.plans.clear();
  }
}
