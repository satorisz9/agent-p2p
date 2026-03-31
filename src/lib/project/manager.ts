/**
 * Project Manager — Agent-Native Crowdfunding Layer
 *
 * Unifies fundraising, execution, and distribution:
 *
 *   1. Create project → define tasks + issue token + set funding goal
 *   2. Fund → agents/humans buy tokens (= invest / participate)
 *   3. Execute → tasks distributed to agents via marketplace
 *   4. Distribute → rewards flow to token holders based on outcomes
 *
 * Unlike traditional crowdfunding:
 *   - Executors are agents, not humans
 *   - Execution is distributed (P2P marketplace)
 *   - Rewards are auto-distributed via escrow + token economy
 */

import { randomBytes } from "crypto";
import { EventEmitter } from "events";

export interface ProjectTask {
  task_id: string;
  type: string;
  description: string;
  budget: number;        // tokens allocated to this task
  status: "pending" | "active" | "completed" | "failed";
  assigned_to?: string;  // agent ID
  proof_id?: string;     // execution proof
}

export interface Project {
  project_id: string;
  name: string;
  description: string;
  creator: string;       // agent ID
  token_id: string;      // associated token (local or on-chain)
  mint_address?: string; // on-chain mint address (if pump.fun or SPL)
  funding_goal: number;  // in SOL or token units
  funded_amount: number;
  status: "draft" | "funding" | "active" | "completed" | "failed";
  tasks: ProjectTask[];
  investors: Record<string, number>; // agent_id → amount invested
  treasury_balance: number; // SOL available for task execution
  created_at: string;
  funded_at?: string;
  completed_at?: string;
}

export class ProjectManager extends EventEmitter {
  private projects = new Map<string, Project>();

  /**
   * Create a new project.
   */
  createProject(
    creator: string,
    name: string,
    description: string,
    tokenId: string,
    fundingGoal: number,
    tasks: Array<{ type: string; description: string; budget: number }>,
    mintAddress?: string
  ): Project {
    const projectId = `proj_${randomBytes(8).toString("hex")}`;

    const projectTasks: ProjectTask[] = tasks.map((t, i) => ({
      task_id: `${projectId}_task_${i}`,
      type: t.type,
      description: t.description,
      budget: t.budget,
      status: "pending",
    }));

    const project: Project = {
      project_id: projectId,
      name,
      description,
      creator,
      token_id: tokenId,
      mint_address: mintAddress,
      funding_goal: fundingGoal,
      funded_amount: 0,
      status: "funding",
      tasks: projectTasks,
      investors: {},
      treasury_balance: 0,
      created_at: new Date().toISOString(),
    };

    this.projects.set(projectId, project);
    this.emit("project:created", project);
    return project;
  }

  /**
   * Record an investment in a project.
   */
  fund(
    projectId: string,
    investor: string,
    amount: number
  ): { success: boolean; project?: Project; error?: string } {
    const project = this.projects.get(projectId);
    if (!project) return { success: false, error: "Project not found" };
    if (project.status !== "funding") return { success: false, error: `Cannot fund: status is ${project.status}` };

    project.funded_amount += amount;
    project.treasury_balance += amount;
    project.investors[investor] = (project.investors[investor] || 0) + amount;

    // Check if funding goal reached
    if (project.funded_amount >= project.funding_goal) {
      project.status = "active";
      project.funded_at = new Date().toISOString();
      this.emit("project:funded", project);
    }

    this.emit("project:investment", { project_id: projectId, investor, amount });
    return { success: true, project };
  }

  /**
   * Mark a task as assigned to an agent (via marketplace auction).
   */
  assignTask(
    projectId: string,
    taskId: string,
    agentId: string
  ): { success: boolean; error?: string } {
    const project = this.projects.get(projectId);
    if (!project) return { success: false, error: "Project not found" };

    const task = project.tasks.find(t => t.task_id === taskId);
    if (!task) return { success: false, error: "Task not found" };
    if (task.status !== "pending") return { success: false, error: `Task status: ${task.status}` };

    task.status = "active";
    task.assigned_to = agentId;
    this.emit("project:task_assigned", { project_id: projectId, task_id: taskId, agent_id: agentId });
    return { success: true };
  }

  /**
   * Mark a task as completed with execution proof.
   */
  completeTask(
    projectId: string,
    taskId: string,
    proofId: string
  ): { success: boolean; error?: string } {
    const project = this.projects.get(projectId);
    if (!project) return { success: false, error: "Project not found" };

    const task = project.tasks.find(t => t.task_id === taskId);
    if (!task) return { success: false, error: "Task not found" };

    task.status = "completed";
    task.proof_id = proofId;
    project.treasury_balance -= task.budget;

    // Check if all tasks completed
    const allDone = project.tasks.every(t => t.status === "completed" || t.status === "failed");
    if (allDone) {
      project.status = "completed";
      project.completed_at = new Date().toISOString();
      this.emit("project:completed", project);
    }

    this.emit("project:task_completed", { project_id: projectId, task_id: taskId, proof_id: proofId });
    return { success: true };
  }

  /**
   * Mark a task as failed.
   */
  failTask(
    projectId: string,
    taskId: string
  ): { success: boolean; error?: string } {
    const project = this.projects.get(projectId);
    if (!project) return { success: false, error: "Project not found" };

    const task = project.tasks.find(t => t.task_id === taskId);
    if (!task) return { success: false, error: "Task not found" };

    task.status = "failed";

    const allDone = project.tasks.every(t => t.status === "completed" || t.status === "failed");
    if (allDone) {
      const hasSuccess = project.tasks.some(t => t.status === "completed");
      project.status = hasSuccess ? "completed" : "failed";
      project.completed_at = new Date().toISOString();
      this.emit(hasSuccess ? "project:completed" : "project:failed", project);
    }

    return { success: true };
  }

  /**
   * Calculate reward distribution for token holders.
   * Returns: { agent_id: reward_amount } based on investment proportion.
   */
  calculateDistribution(projectId: string): {
    success: boolean;
    distribution?: Record<string, number>;
    total_rewards?: number;
    error?: string;
  } {
    const project = this.projects.get(projectId);
    if (!project) return { success: false, error: "Project not found" };
    if (project.status !== "completed") return { success: false, error: "Project not completed" };

    // Remaining treasury after task payments = profit to distribute
    const totalRewards = project.treasury_balance;
    if (totalRewards <= 0) return { success: true, distribution: {}, total_rewards: 0 };

    const totalInvested = Object.values(project.investors).reduce((a, b) => a + b, 0);
    const distribution: Record<string, number> = {};

    for (const [investor, amount] of Object.entries(project.investors)) {
      distribution[investor] = (amount / totalInvested) * totalRewards;
    }

    return { success: true, distribution, total_rewards: totalRewards };
  }

  // --- Query ---

  getProject(projectId: string): Project | null {
    return this.projects.get(projectId) ?? null;
  }

  listProjects(status?: Project["status"]): Project[] {
    const all = Array.from(this.projects.values());
    return status ? all.filter(p => p.status === status) : all;
  }

  // --- Serialization ---

  serialize(): Record<string, Project> {
    return Object.fromEntries(this.projects);
  }

  load(data: Record<string, Project>): void {
    this.projects.clear();
    for (const [k, v] of Object.entries(data)) {
      this.projects.set(k, v);
    }
  }

  destroy(): void {
    this.projects.clear();
    this.removeAllListeners();
  }
}
