/**
 * dag_scheduler.js — Dynamic DAG-aware scheduler for wave dispatch.
 *
 * Wraps the existing dependency_graph_resolver with runtime awareness:
 * - Completed tasks are removed from the graph before scheduling
 * - Failed tasks propagate blocks to dependents
 * - Re-scheduling can happen mid-cycle when a wave finishes
 *
 * Integration: called by orchestrator between waves to re-evaluate the schedule.
 */

import { resolveDependencyGraph } from "./dependency_graph_resolver.js";

/**
 * @typedef {object} ScheduleResult
 * @property {object[][]} readyWaves — array of waves, each wave is an array of plan objects
 * @property {object[]} blocked — plans blocked by unresolved dependencies
 * @property {string} status — "ok" | "all_done" | "deadlocked"
 */

/**
 * Compute the next dispatchable wave(s) given current completion state.
 *
 * @param {object[]} allPlans — full list of plans from Prometheus
 * @param {Set<string>} completedTaskIds — IDs of tasks already completed
 * @param {Set<string>} failedTaskIds — IDs of tasks that failed
 * @returns {ScheduleResult}
 */
export function computeNextWaves(allPlans, completedTaskIds = new Set(), failedTaskIds = new Set()) {
  if (!Array.isArray(allPlans) || allPlans.length === 0) {
    return { readyWaves: [], blocked: [], status: "all_done" };
  }

  // Filter out completed plans
  const remaining = allPlans.filter(p => {
    const id = p.task || p.role || "";
    return !completedTaskIds.has(id);
  });

  if (remaining.length === 0) {
    return { readyWaves: [], blocked: [], status: "all_done" };
  }

  // Mark plans whose dependencies include failed tasks as blocked
  const blocked = [];
  const schedulable = [];

  for (const plan of remaining) {
    const deps = Array.isArray(plan.dependencies) ? plan.dependencies : [];
    const hasFailedDep = deps.some(d => failedTaskIds.has(d));
    if (hasFailedDep) {
      blocked.push(plan);
    } else {
      schedulable.push(plan);
    }
  }

  if (schedulable.length === 0) {
    return { readyWaves: [], blocked, status: "deadlocked" };
  }

  // Build graph tasks for resolution
  // Standardize field names: accept both dependsOn/dependencies and filesInScope/files (Packet 4)
  const graphTasks = schedulable.map(p => {
    const deps = Array.isArray(p.dependsOn) ? p.dependsOn
      : Array.isArray(p.dependencies) ? p.dependencies : [];
    const files = Array.isArray(p.filesInScope) ? p.filesInScope
      : Array.isArray(p.files) ? p.files : [];
    return {
      id: p.task || p.role || "",
      role: p.role || "",
      dependencies: deps.filter(d => !completedTaskIds.has(d)),
      files,
    };
  });

  const graph = resolveDependencyGraph(graphTasks);

  // Convert graph waves back to plan references
  const planById = new Map();
  for (const p of schedulable) {
    planById.set(p.task || p.role || "", p);
  }

  const readyWaves = (graph.waves || []).map(wave =>
    (wave.taskIds || []).map(id => planById.get(id)).filter(Boolean)
  ).filter(w => w.length > 0);

  return {
    readyWaves,
    blocked,
    status: readyWaves.length > 0 ? "ok" : "deadlocked"
  };
}

/**
 * Compute the immediate frontier — all tasks whose dependencies are satisfied.
 * Unlike wave-based scheduling, this returns tasks individually as they become ready.
 *
 * @param {object[]} allPlans
 * @param {Set<string>} completedTaskIds
 * @param {Set<string>} failedTaskIds
 * @param {Set<string>} [inProgressTaskIds] — tasks currently being executed
 * @returns {{ frontier: object[], blocked: object[], status: string }}
 */
export function computeFrontier(allPlans, completedTaskIds = new Set(), failedTaskIds = new Set(), inProgressTaskIds = new Set()) {
  if (!Array.isArray(allPlans) || allPlans.length === 0) {
    return { frontier: [], blocked: [], status: "all_done" };
  }

  const remaining = allPlans.filter(p => {
    const id = p.task_id || p.task || p.role || "";
    return !completedTaskIds.has(id) && !inProgressTaskIds.has(id);
  });

  if (remaining.length === 0 && inProgressTaskIds.size > 0) {
    return { frontier: [], blocked: [], status: "waiting" };
  }
  if (remaining.length === 0) {
    return { frontier: [], blocked: [], status: "all_done" };
  }

  const frontier = [];
  const blocked = [];

  for (const plan of remaining) {
    const deps = Array.isArray(plan.dependencies) ? plan.dependencies : [];
    const hasFailedDep = deps.some(d => failedTaskIds.has(d));
    if (hasFailedDep) {
      blocked.push(plan);
      continue;
    }
    // All dependencies must be completed (not just in progress)
    const allDepsCompleted = deps.every(d => completedTaskIds.has(d));
    if (allDepsCompleted) {
      frontier.push(plan);
    }
    // Otherwise: still waiting on deps — not blocked, not ready
  }

  return {
    frontier,
    blocked,
    status: frontier.length > 0 ? "ok" : (blocked.length > 0 ? "deadlocked" : "waiting")
  };
}

/**
 * Compute the critical path length from a resolved dependency graph.
 *
 * The critical path length equals the maximum wave number, since each wave
 * represents one mandatory serial stage of execution. Tasks within the same
 * wave can run concurrently; tasks in later waves must wait.
 *
 * @param graph — result from resolveDependencyGraph (or any object with a waves array)
 * @returns the critical path length (max wave number, minimum 1)
 */
export function computeCriticalPathLength(graph: { waves?: Array<{ wave: number; taskIds: string[] }> }): number {
  if (!graph || !Array.isArray(graph.waves) || graph.waves.length === 0) return 1;
  return Math.max(...graph.waves.map(w => w.wave));
}

/**
 * Compute a safe maxConcurrent bound based on the DAG critical path.
 *
 * Formula: ceil(totalTasks / criticalPathLength), clamped to [min, max].
 *
 * Rationale: the critical path serializes execution into `criticalPathLength`
 * serial stages. Distributing `totalTasks` evenly across those stages gives the
 * average wave width — the natural parallelism the DAG supports. Running more
 * concurrent tasks than this bound wastes capacity on tasks whose dependencies
 * have not been satisfied in practice.
 *
 * @param totalTasks         — number of tasks in the current wave/frontier
 * @param criticalPathLength — result of computeCriticalPathLength
 * @param opts               — optional { min?: number, max?: number }
 * @returns safe maxConcurrent value
 */
export function computeWaveParallelismBound(
  totalTasks: number,
  criticalPathLength: number,
  opts: { min?: number; max?: number } = {}
): number {
  const min = opts.min ?? 1;
  const max = opts.max ?? 8;
  if (totalTasks <= 0 || criticalPathLength <= 0) return min;
  const bound = Math.ceil(totalTasks / criticalPathLength);
  return Math.max(min, Math.min(max, bound));
}

/**
 * Create conflict-safe micro-batches from the frontier.
 * Ensures no more than `maxConcurrent` tasks are dispatched simultaneously.
 *
 * Concurrency resolution order (first match wins):
 *   1. `opts.maxConcurrent`       — explicit cap, always used as-is
 *   2. `opts.criticalPathLength`  — derive safe cap from DAG structure via
 *                                   computeWaveParallelismBound()
 *   3. static default (3)         — conservative fallback when no graph info
 *                                   is available, preserving original behaviour
 *
 * @param {object[]} frontier — tasks ready for dispatch
 * @param {{ maxConcurrent?: number, criticalPathLength?: number }} opts
 * @returns {object[][]} — array of micro-batches
 */
export function microBatch(frontier, opts: any = {}) {
  if (!Array.isArray(frontier) || frontier.length === 0) return [];

  let maxConcurrent: number;
  if (opts.maxConcurrent !== undefined) {
    maxConcurrent = Number(opts.maxConcurrent);
  } else if (opts.criticalPathLength !== undefined) {
    maxConcurrent = computeWaveParallelismBound(frontier.length, Number(opts.criticalPathLength));
  } else {
    // Conservative static default — matches original behaviour when no graph info is provided
    maxConcurrent = 3;
  }

  const batches = [];
  for (let i = 0; i < frontier.length; i += maxConcurrent) {
    batches.push(frontier.slice(i, i + maxConcurrent));
  }
  return batches;
}

/**
 * Create conflict-safe micro-batches from the frontier while preserving wave invariants.
 *
 * Extends `microBatch` with conflict awareness: tasks that share a dependency-graph
 * conflict (same file scope or explicit conflict pair) are placed into different batches.
 * Uses greedy graph-coloring — the same approach as `buildRoleExecutionBatches` in
 * `worker_batch_planner.ts` — ensuring correctness without look-ahead.
 *
 * Wave invariants are preserved because:
 *  - The frontier is computed by `computeFrontier`, which only returns tasks whose
 *    dependencies are fully satisfied. All frontier tasks are wave-ready.
 *  - Conflict separation does not re-order tasks across wave boundaries; it only
 *    distributes tasks within the current wave into separate dispatch slots.
 *
 * Concurrency bound follows the same three-tier resolution as `microBatch`:
 *   1. `opts.maxConcurrent`      — explicit cap
 *   2. `opts.criticalPathLength` — DAG-derived cap via computeWaveParallelismBound
 *   3. static default (3)        — conservative fallback
 *
 * @param frontier       — tasks ready for dispatch (output of computeFrontier)
 * @param conflictPairs  — [taskIdA, taskIdB] pairs that must not share a batch
 * @param opts           — { maxConcurrent?, criticalPathLength?, taskIdField? }
 * @returns object[][]   — conflict-safe micro-batches, each batch ≤ maxConcurrent
 */
export function conflictAwareMicroBatch(
  frontier: object[],
  conflictPairs: Array<[string, string]> = [],
  opts: any = {}
): object[][] {
  if (!Array.isArray(frontier) || frontier.length === 0) return [];

  // Determine concurrency bound (same three-tier logic as microBatch)
  let maxConcurrent: number;
  if (opts.maxConcurrent !== undefined) {
    maxConcurrent = Number(opts.maxConcurrent);
  } else if (opts.criticalPathLength !== undefined) {
    maxConcurrent = computeWaveParallelismBound(frontier.length, Number(opts.criticalPathLength));
  } else {
    maxConcurrent = 3;
  }

  // If no conflict pairs are provided, fall back to plain microBatch behaviour.
  // This preserves the existing dispatch path for callers that don't have
  // dependency-graph conflict information.
  if (!Array.isArray(conflictPairs) || conflictPairs.length === 0) {
    const batches: object[][] = [];
    for (let i = 0; i < frontier.length; i += maxConcurrent) {
      batches.push(frontier.slice(i, i + maxConcurrent));
    }
    return batches;
  }

  // Build a conflict adjacency set: "idA:idB" → true
  const idField: string = opts.taskIdField || "task_id";
  const getTaskId = (task: any): string =>
    String(task[idField] || task.task || task.role || "");

  const conflictSet = new Set<string>();
  for (const [a, b] of conflictPairs) {
    if (a && b) {
      conflictSet.add(`${a}:${b}`);
      conflictSet.add(`${b}:${a}`);
    }
  }

  const areTwoConflicting = (taskA: any, taskB: any): boolean => {
    const idA = getTaskId(taskA);
    const idB = getTaskId(taskB);
    return Boolean(idA && idB && conflictSet.has(`${idA}:${idB}`));
  };

  // Greedy graph-coloring: assign each frontier task to the first batch where:
  //   (a) no existing task in the batch conflicts with it, AND
  //   (b) the batch has not yet reached maxConcurrent
  // If no such batch exists, open a new one.
  const batches: object[][] = [];

  for (const task of frontier) {
    let placed = false;
    for (const batch of batches) {
      if (batch.length >= maxConcurrent) continue;
      const hasConflict = batch.some(existing => areTwoConflicting(task, existing));
      if (!hasConflict) {
        batch.push(task);
        placed = true;
        break;
      }
    }
    if (!placed) {
      batches.push([task]);
    }
  }

  return batches;
}

/**
 * Compact non-dependent singleton waves into earlier eligible waves, reducing
 * unnecessary serial execution stages while preserving dependency-required isolation.
 *
 * A wave is eligible for compaction when:
 *   - It contains exactly one task (singleton), AND
 *   - That task has no declared dependencies (empty or absent dependsOn/dependencies)
 *
 * Compaction merges eligible singleton waves into the earliest (lowest-numbered)
 * wave, allowing them to run concurrently rather than sequentially.
 *
 * Waves with multiple tasks, or singleton waves whose task has dependencies,
 * are preserved as-is — dependency-required isolation is never violated.
 *
 * @param allPlans - plans with wave, dependsOn, and/or dependencies fields
 * @returns new plans array with compacted wave assignments; originals are not mutated
 */
export function compactSingletonWaves(allPlans: any[]): any[] {
  if (!Array.isArray(allPlans) || allPlans.length === 0) return [];

  // Group plans by their declared wave number (default to 1 when absent/invalid)
  const waveMap = new Map<number, any[]>();
  for (const plan of allPlans) {
    const w = Number.isFinite(Number(plan?.wave)) && Number(plan.wave) > 0
      ? Number(plan.wave) : 1;
    if (!waveMap.has(w)) waveMap.set(w, []);
    waveMap.get(w)!.push(plan);
  }

  if (waveMap.size <= 1) {
    // Single wave or empty — nothing to compact
    return allPlans.map(p => ({ ...p }));
  }

  const sortedWaves = [...waveMap.keys()].sort((a, b) => a - b);
  const baseWave = sortedWaves[0];
  const result: any[] = [];

  for (const waveNum of sortedWaves) {
    const wavePlans = waveMap.get(waveNum)!;

    if (waveNum !== baseWave && wavePlans.length === 1) {
      const plan = wavePlans[0];
      const deps = Array.isArray(plan?.dependsOn) ? plan.dependsOn
        : Array.isArray(plan?.dependencies) ? plan.dependencies
        : [];
      if (deps.length === 0) {
        // Non-dependent singleton — compact into the base wave
        result.push({ ...plan, wave: baseWave });
        continue;
      }
    }

    // Multi-task wave or singleton with dependencies — preserve wave assignment
    for (const plan of wavePlans) {
      result.push({ ...plan });
    }
  }

  return result;
}
