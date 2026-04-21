/**
 * dependency_graph_resolver.js — Cross-task dependency graph resolver for BOX.
 *
 * Resolves cross-task dependencies to maximize safe parallelism and prevent
 * contradictory policy updates.
 *
 * ── Risk level: HIGH ─────────────────────────────────────────────────────────
 * This module feeds directly into prometheus.js and orchestrator.js scheduling.
 * Silent regression risk is significant. All execution paths are explicit.
 *
 * ── Conflict detection model (AC2 — deterministic, implementer-independent) ──
 * Two tasks are considered CONFLICTING when their `filesInScope` arrays share at
 * least one normalized file path. Conflicting tasks are placed in different
 * execution waves (serialized) to prevent contradictory policy updates.
 * Normalization: lowercase, forward slashes, no leading "./".
 *
 * ── GraphTask input schema ────────────────────────────────────────────────────
 * Each task descriptor must have:
 *   id           {string}   — unique identifier within the task set (required)
 *   dependsOn    {string[]} — IDs of tasks this task depends on (optional, default [])
 *   filesInScope {string[]} — repo-relative file paths for conflict detection (optional, default [])
 *
 * ── Parallel-track output schema (AC3) ───────────────────────────────────────
 * resolveDependencyGraph returns a GraphResolution object:
 * {
 *   schemaVersion:  1
 *   resolvedAt:     ISO timestamp
 *   status:         GRAPH_STATUS enum value
 *   reasonCode:     GRAPH_REASON enum value
 *   waves:          Wave[]
 *   conflictPairs:  ConflictPair[]
 *   cycles:         string[][]     — each entry is a cycle path of task IDs
 *   totalTasks:     integer
 *   parallelTasks:  integer        — tasks that share a wave with at least one other
 *   serializedTasks: integer       — tasks alone in their wave, or bumped by conflict
 *   errorMessage:   string|null
 * }
 *
 * Wave:
 * {
 *   wave:     integer   — 1-indexed wave number
 *   taskIds:  string[]  — IDs of tasks in this wave
 *   gates:    Gate[]    — prerequisites that must complete before this wave starts
 * }
 *
 * Gate:
 * {
 *   afterTaskId: string     — task that must complete before this gate opens
 *   reason:      GATE_REASON enum value
 *   sharedFiles: string[]   — populated when reason=file_conflict
 * }
 *
 * ConflictPair:
 * {
 *   taskA:       string
 *   taskB:       string
 *   reason:      CONFLICT_REASON enum value
 *   sharedFiles: string[]
 * }
 *
 * ── Diagnostics persistence (AC5) ────────────────────────────────────────────
 * persistGraphDiagnostics writes to: state/dependency_graph_diagnostics.json
 * The file is appended (line-delimited NDJSON) so history is preserved.
 * Callers must never fail if persistence fails — use the non-blocking wrapper.
 *
 * ── Error handling policy ─────────────────────────────────────────────────────
 * - Missing input (null/undefined tasks)   → status=invalid_input, reasonCode=MISSING_INPUT
 * - Wrong type (not an array)             → status=invalid_input, reasonCode=INVALID_INPUT
 * - Invalid task entry                     → status=invalid_input, reasonCode=INVALID_INPUT
 * - Empty array                            → status=ok,           reasonCode=EMPTY_INPUT (waves=[])
 * - Cycle detected in explicit deps        → status=cycle_detected, reasonCode=CYCLE_DETECTED
 * - All constraints satisfied              → status=ok,           reasonCode=VALID
 *
 * No silent fallback: every degraded/failure path sets an explicit status + reasonCode.
 */

import path from "node:path";
import fs from "node:fs/promises";

// ── Schema version ────────────────────────────────────────────────────────────

/** Schema version for dependency_graph_diagnostics.json entries. */
export const GRAPH_DIAGNOSTICS_SCHEMA_VERSION = 1;
/**
 * Shared diagnostics-envelope schema used across diagnostics producers/consumers.
 * Individual artifact streams are differentiated by recordType.
 */
export const DIAGNOSTICS_ARTIFACT_JSONL_SCHEMA = "box.diagnostics_artifact.v1";
export const GRAPH_DIAGNOSTICS_JSONL_SCHEMA = DIAGNOSTICS_ARTIFACT_JSONL_SCHEMA;
export const GRAPH_DIAGNOSTICS_FRESHNESS_MS = 6 * 60 * 60 * 1000;
export const GRAPH_DIAGNOSTICS_RECORD_TYPE = "dependency_graph_diagnostic";

/**
 * Strict contract validator for persisted dependency-graph diagnostics records.
 * Used by Prometheus to enforce trust boundaries before planning.
 */
export function isGraphDiagnosticsRecordContractValid(record: unknown): boolean {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const obj = record as Record<string, unknown>;
  if (obj.jsonlSchema !== GRAPH_DIAGNOSTICS_JSONL_SCHEMA) return false;
  if (obj.recordType !== GRAPH_DIAGNOSTICS_RECORD_TYPE) return false;
  if (Number(obj.schemaVersion) !== GRAPH_DIAGNOSTICS_SCHEMA_VERSION) return false;
  if (!(Object.values(GRAPH_STATUS) as string[]).includes(String(obj.status))) return false;
  if (!(Object.values(GRAPH_REASON) as string[]).includes(String(obj.reasonCode))) return false;
  if (!Array.isArray(obj.waves) || !Array.isArray(obj.conflictPairs) || !Array.isArray(obj.cycles)) return false;

  const freshness = obj.freshness;
  if (!freshness || typeof freshness !== "object" || Array.isArray(freshness)) return false;
  const freshObj = freshness as Record<string, unknown>;
  const staleAfterMs = Number(freshObj.staleAfterMs);
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) return false;
  const expiresAtMs = Date.parse(String(freshObj.expiresAt || ""));
  if (!Number.isFinite(expiresAtMs)) return false;

  const timestampRaw = String(obj.savedAt || obj.persistedAt || "").trim();
  const timestampMs = Date.parse(timestampRaw);
  if (!timestampRaw || !Number.isFinite(timestampMs)) return false;

  const payload = obj.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const payloadObj = payload as Record<string, unknown>;
  if (!(Object.values(GRAPH_STATUS) as string[]).includes(String(payloadObj.status))) return false;
  if (!(Object.values(GRAPH_REASON) as string[]).includes(String(payloadObj.reasonCode))) return false;
  if (!Array.isArray(payloadObj.waves) || !Array.isArray(payloadObj.conflictPairs) || !Array.isArray(payloadObj.cycles)) return false;

  return true;
}

// ── Status enum (AC10) ────────────────────────────────────────────────────────

/**
 * Top-level status codes for a GraphResolution result.
 * Written to the `status` field in every persisted diagnostics entry.
 *
 * Callers must inspect this field — no silent fallback allowed.
 */
export const GRAPH_STATUS = Object.freeze({
  /** DAG resolved; all constraints satisfied. Waves and gates are valid. */
  OK:             "ok",
  /** A cycle was found in explicit dependencies. Scheduling aborted. */
  CYCLE_DETECTED: "cycle_detected",
  /** Input validation failed — no graph was built. */
  INVALID_INPUT:  "invalid_input",
  /** Resolver entered an unexpected error state; partial results only. */
  DEGRADED:       "degraded",
});

// ── Reason code enum (AC9) ────────────────────────────────────────────────────

/**
 * Machine-readable reason codes for the top-level resolver result.
 * Callers must inspect this field; silent fallback is not allowed.
 */
export const GRAPH_REASON = Object.freeze({
  /** Graph resolved successfully; all tasks scheduled. */
  VALID:          "VALID",
  /** Input tasks array was provided but empty — no waves generated. */
  EMPTY_INPUT:    "EMPTY_INPUT",
  /** Required input (tasks) was null/undefined. */
  MISSING_INPUT:  "MISSING_INPUT",
  /** Input was provided but structurally invalid (wrong type or bad task). */
  INVALID_INPUT:  "INVALID_INPUT",
  /** At least one cycle was detected in explicit dependencies. */
  CYCLE_DETECTED: "CYCLE_DETECTED",
});

// ── Gate reason enum ──────────────────────────────────────────────────────────

/**
 * Reason codes for wave gate entries.
 */
export const GATE_REASON = Object.freeze({
  /** Gate caused by an explicit `dependsOn` relationship. */
  EXPLICIT_DEPENDENCY: "explicit_dependency",
  /** Gate caused by overlapping filesInScope between two tasks. */
  FILE_CONFLICT:       "file_conflict",
});

// ── Conflict reason enum ──────────────────────────────────────────────────────

/**
 * Reason codes for conflict pair entries.
 */
export const CONFLICT_REASON = Object.freeze({
  /** Two tasks share at least one file path in their filesInScope arrays. */
  OVERLAPPING_FILES_IN_SCOPE: "overlapping_files_in_scope",
});

// ── Task validation error codes ───────────────────────────────────────────────

/**
 * Reason codes for individual task validation failures.
 * Distinguishes missing/null input from structurally invalid input.
 */
export const TASK_ERROR_CODE = Object.freeze({
  /** Input is null/undefined. */
  MISSING_INPUT: "MISSING_INPUT",
  /** Input is not a plain object. */
  INVALID_TYPE:  "INVALID_TYPE",
  /** A required field is absent. */
  MISSING_FIELD: "MISSING_FIELD",
  /** A field is present but its value fails validation. */
  INVALID_FIELD: "INVALID_FIELD",
});

// ── Normalization ─────────────────────────────────────────────────────────────

/**
 * Normalize a file path for conflict comparison.
 * Lowercases, converts backslashes to forward slashes, strips leading "./".
 *
 * @param {string} filePath
 * @returns {string}
 */
export function normalizeFilePath(filePath) {
  return String(filePath || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim()
    .toLowerCase();
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validate a single GraphTask descriptor.
 *
 * Distinguishes missing input from invalid input:
 *   null/undefined input  → ok=false, code=MISSING_INPUT
 *   non-object input      → ok=false, code=INVALID_TYPE
 *   absent 'id' field     → ok=false, code=MISSING_FIELD
 *   invalid field value   → ok=false, code=INVALID_FIELD
 *   fully valid           → ok=true,  code=null
 *
 * @param {any} task
 * @returns {{ ok: boolean, code: string|null, field?: string, message: string }}
 */
export function validateGraphTask(task) {
  if (task === null || task === undefined) {
    return { ok: false, code: TASK_ERROR_CODE.MISSING_INPUT, message: "task is required (got null/undefined)" };
  }
  if (typeof task !== "object" || Array.isArray(task)) {
    return { ok: false, code: TASK_ERROR_CODE.INVALID_TYPE, message: "task must be a plain object" };
  }
  if (!("id" in task)) {
    return { ok: false, code: TASK_ERROR_CODE.MISSING_FIELD, field: "id", message: "required field 'id' is missing" };
  }
  if (typeof task.id !== "string" || task.id.trim() === "") {
    return { ok: false, code: TASK_ERROR_CODE.INVALID_FIELD, field: "id", message: "task.id must be a non-empty string" };
  }
  if (task.dependsOn !== undefined) {
    if (!Array.isArray(task.dependsOn)) {
      return { ok: false, code: TASK_ERROR_CODE.INVALID_FIELD, field: "dependsOn", message: "task.dependsOn must be an array when provided" };
    }
    for (let i = 0; i < task.dependsOn.length; i++) {
      if (typeof task.dependsOn[i] !== "string" || task.dependsOn[i].trim() === "") {
        return { ok: false, code: TASK_ERROR_CODE.INVALID_FIELD, field: `dependsOn[${i}]`, message: `dependsOn[${i}] must be a non-empty string` };
      }
    }
  }
  if (task.filesInScope !== undefined) {
    if (!Array.isArray(task.filesInScope)) {
      return { ok: false, code: TASK_ERROR_CODE.INVALID_FIELD, field: "filesInScope", message: "task.filesInScope must be an array when provided" };
    }
    for (let i = 0; i < task.filesInScope.length; i++) {
      if (typeof task.filesInScope[i] !== "string") {
        return { ok: false, code: TASK_ERROR_CODE.INVALID_FIELD, field: `filesInScope[${i}]`, message: `filesInScope[${i}] must be a string` };
      }
    }
  }
  return { ok: true, code: null, message: "valid" };
}

// ── Cycle detection ───────────────────────────────────────────────────────────

/**
 * Detect cycles in the explicit dependency graph using iterative DFS
 * (white/gray/black coloring).
 *
 * @param {Map<string, string[]>} dependsOnMap - taskId → [dependency IDs]
 * @param {string[]} taskIds
 * @returns {string[][]} - array of cycle paths; empty if no cycles
 */
function detectCycles(dependsOnMap, taskIds) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(taskIds.map((id) => [id, WHITE]));
  const cycles = [];

  for (const startId of taskIds) {
    if (color.get(startId) !== WHITE) continue;

    // Iterative DFS with explicit stack
    const stack = [{ id: startId, path: [startId], depIndex: 0 }];
    color.set(startId, GRAY);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const deps = dependsOnMap.get(frame.id) || [];

      if (frame.depIndex >= deps.length) {
        color.set(frame.id, BLACK);
        stack.pop();
        continue;
      }

      const depId = deps[frame.depIndex];
      frame.depIndex++;

      if (!color.has(depId)) {
        // Dependency references a task not in the input set — skip
        continue;
      }

      if (color.get(depId) === GRAY) {
        // Back edge → cycle found
        const cycleStart = frame.path.indexOf(depId);
        if (cycleStart >= 0) {
          cycles.push([...frame.path.slice(cycleStart), depId]);
        } else {
          cycles.push([...frame.path, depId]);
        }
        // Continue scanning for additional cycles
        continue;
      }

      if (color.get(depId) === WHITE) {
        color.set(depId, GRAY);
        stack.push({ id: depId, path: [...frame.path, depId], depIndex: 0 });
      }
    }
  }

  return cycles;
}

// ── Conflict detection ────────────────────────────────────────────────────────

/**
 * Detect all conflicting task pairs by comparing normalized filesInScope.
 * Two tasks conflict when they share at least one file path.
 *
 * @param {{ id: string, filesInScope: string[] }[]} tasks
 * @returns {{ taskA: string, taskB: string, reason: string, sharedFiles: string[] }[]}
 */
function detectConflicts(tasks) {
  const conflicts = [];

  for (let i = 0; i < tasks.length; i++) {
    const a = tasks[i];
    const aFiles = new Set((a.filesInScope || []).map(normalizeFilePath).filter(Boolean));
    if (aFiles.size === 0) continue;

    for (let j = i + 1; j < tasks.length; j++) {
      const b = tasks[j];
      const bFiles = (b.filesInScope || []).map(normalizeFilePath).filter(Boolean);
      const shared = bFiles.filter((f) => aFiles.has(f));

      if (shared.length > 0) {
        conflicts.push({
          taskA: a.id,
          taskB: b.id,
          reason: CONFLICT_REASON.OVERLAPPING_FILES_IN_SCOPE,
          sharedFiles: shared,
        });
      }
    }
  }

  return conflicts;
}

// ── Wave assignment ───────────────────────────────────────────────────────────

/**
 * Assign execution waves to tasks respecting:
 *   1. Explicit dependency ordering (task after all its dependsOn tasks)
 *   2. Conflict serialization (conflicting tasks must not share a wave)
 *
 * Algorithm: iterative relaxation (Bellman-Ford style).
 * Each iteration either propagates a dependency constraint or bumps a conflict.
 * Terminates when neither changes anything. Bounded by O(n^2) iterations.
 *
 * @param {string[]} taskIds
 * @param {Map<string, string[]>} dependsOnMap  - taskId → [dependency IDs]
 * @param {{ taskA: string, taskB: string, sharedFiles: string[] }[]} conflicts
 * @returns {Map<string, number>} - taskId → wave number (1-indexed)
 */
function assignWaves(taskIds, dependsOnMap, conflicts) {
  const waveOf = new Map(taskIds.map((id) => [id, 1]));

  let changed = true;
  while (changed) {
    changed = false;

    // Phase A: propagate explicit dependency constraints
    for (const id of taskIds) {
      const deps = dependsOnMap.get(id) || [];
      for (const depId of deps) {
        if (!waveOf.has(depId)) continue;
        const required = ((waveOf.get(depId) as number) ?? 0) + 1;
        if (required > ((waveOf.get(id) as number) ?? 1)) {
          waveOf.set(id, required);
          changed = true;
        }
      }
    }

    // Phase B: apply one conflict bump (restart after each bump for correctness)
    for (const conflict of conflicts) {
      const wA = waveOf.get(conflict.taskA);
      const wB = waveOf.get(conflict.taskB);
      if (wA === wB) {
        // Deterministic tie-break: bump the lexicographically larger ID
        const toBump = conflict.taskA < conflict.taskB ? conflict.taskB : conflict.taskA;
        waveOf.set(toBump, (wA as number) + 1);
        changed = true;
        break; // Restart so dependency propagation runs again
      }
    }
  }

  return waveOf;
}

// ── Gate computation ──────────────────────────────────────────────────────────

/**
 * Build gate entries for each task with wave > 1.
 * Gates are grouped per wave (the set of prerequisites for a wave to start).
 *
 * @param {string[]} taskIds
 * @param {Map<string, number>} waveOf
 * @param {Map<string, string[]>} dependsOnMap
 * @param {{ taskA: string, taskB: string, sharedFiles: string[] }[]} conflicts
 * @returns {Map<string, { afterTaskId: string, reason: string, sharedFiles: string[] }[]>}
 *   taskId → gates that must clear before this task runs
 */
function computeTaskGates(taskIds, waveOf, dependsOnMap, conflicts) {
  const taskGates = new Map(taskIds.map((id) => [id, []]));

  // Explicit dependency gates
  for (const id of taskIds) {
    const deps = dependsOnMap.get(id) || [];
    for (const depId of deps) {
      if (!waveOf.has(depId)) continue;
      (taskGates.get(id) as any)!.push({
        afterTaskId: depId,
        reason: GATE_REASON.EXPLICIT_DEPENDENCY,
        sharedFiles: [],
      });
    }
  }

  // Conflict-induced serialization gates
  for (const conflict of conflicts) {
    const wA = waveOf.get(conflict.taskA) ?? 1;
    const wB = waveOf.get(conflict.taskB) ?? 1;

    if (wA < wB) {
      (taskGates.get(conflict.taskB) as any)!.push({
        afterTaskId: conflict.taskA,
        reason: GATE_REASON.FILE_CONFLICT,
        sharedFiles: conflict.sharedFiles,
      });
    } else if (wB < wA) {
      (taskGates.get(conflict.taskA) as any)!.push({
        afterTaskId: conflict.taskB,
        reason: GATE_REASON.FILE_CONFLICT,
        sharedFiles: conflict.sharedFiles,
      });
    }
    // If same wave after resolution that's a bug, but we treat it as no gate needed
  }

  return taskGates;
}

// ── Main resolver ─────────────────────────────────────────────────────────────

/**
 * Resolve the dependency graph for a set of task descriptors.
 *
 * Validates DAG constraints, detects conflicts, assigns parallel waves, and
 * produces explicit gates. Returns a fully specified GraphResolution object.
 *
 * @param {any} tasks - Array of GraphTask descriptors
 * @returns {GraphResolution} - Always returns a valid object; never throws.
 */
export function resolveDependencyGraph(tasks) {
  const resolvedAt = new Date().toISOString();

  // ── Input validation: missing ──────────────────────────────────────────────
  if (tasks === null || tasks === undefined) {
    return {
      schemaVersion: GRAPH_DIAGNOSTICS_SCHEMA_VERSION,
      resolvedAt,
      status: GRAPH_STATUS.INVALID_INPUT,
      reasonCode: GRAPH_REASON.MISSING_INPUT,
      waves: [],
      conflictPairs: [],
      cycles: [],
      totalTasks: 0,
      parallelTasks: 0,
      serializedTasks: 0,
      errorMessage: "tasks is required (got null/undefined)",
    };
  }

  // ── Input validation: wrong type ───────────────────────────────────────────
  if (!Array.isArray(tasks)) {
    return {
      schemaVersion: GRAPH_DIAGNOSTICS_SCHEMA_VERSION,
      resolvedAt,
      status: GRAPH_STATUS.INVALID_INPUT,
      reasonCode: GRAPH_REASON.INVALID_INPUT,
      waves: [],
      conflictPairs: [],
      cycles: [],
      totalTasks: 0,
      parallelTasks: 0,
      serializedTasks: 0,
      errorMessage: `tasks must be an array; got ${typeof tasks}`,
    };
  }

  // ── Empty input ────────────────────────────────────────────────────────────
  if (tasks.length === 0) {
    return {
      schemaVersion: GRAPH_DIAGNOSTICS_SCHEMA_VERSION,
      resolvedAt,
      status: GRAPH_STATUS.OK,
      reasonCode: GRAPH_REASON.EMPTY_INPUT,
      waves: [],
      conflictPairs: [],
      cycles: [],
      totalTasks: 0,
      parallelTasks: 0,
      serializedTasks: 0,
      errorMessage: null,
    };
  }

  // ── Validate each task entry ───────────────────────────────────────────────
  for (let i = 0; i < tasks.length; i++) {
    const validation = validateGraphTask(tasks[i]);
    if (!validation.ok) {
      return {
        schemaVersion: GRAPH_DIAGNOSTICS_SCHEMA_VERSION,
        resolvedAt,
        status: GRAPH_STATUS.INVALID_INPUT,
        reasonCode: GRAPH_REASON.INVALID_INPUT,
        waves: [],
        conflictPairs: [],
        cycles: [],
        totalTasks: tasks.length,
        parallelTasks: 0,
        serializedTasks: 0,
        errorMessage: `tasks[${i}]: ${validation.message} (code=${validation.code})`,
      };
    }
  }

  // ── Check for duplicate IDs ────────────────────────────────────────────────
  const seenIds = new Set();
  for (const task of tasks) {
    if (seenIds.has(task.id)) {
      return {
        schemaVersion: GRAPH_DIAGNOSTICS_SCHEMA_VERSION,
        resolvedAt,
        status: GRAPH_STATUS.INVALID_INPUT,
        reasonCode: GRAPH_REASON.INVALID_INPUT,
        waves: [],
        conflictPairs: [],
        cycles: [],
        totalTasks: tasks.length,
        parallelTasks: 0,
        serializedTasks: 0,
        errorMessage: `duplicate task id: '${task.id}'`,
      };
    }
    seenIds.add(task.id);
  }

  const taskIds = tasks.map((t) => t.id);
  const dependsOnMap = new Map(tasks.map((t) => [t.id, (t.dependsOn || []).map(String)]));

  // ── DAG validation: cycle detection ───────────────────────────────────────
  const cycles = detectCycles(dependsOnMap, taskIds);
  if (cycles.length > 0) {
    return {
      schemaVersion: GRAPH_DIAGNOSTICS_SCHEMA_VERSION,
      resolvedAt,
      status: GRAPH_STATUS.CYCLE_DETECTED,
      reasonCode: GRAPH_REASON.CYCLE_DETECTED,
      waves: [],
      conflictPairs: [],
      cycles,
      totalTasks: tasks.length,
      parallelTasks: 0,
      serializedTasks: 0,
      errorMessage: `dependency graph contains ${cycles.length} cycle(s): ${cycles.map((c) => c.join(" → ")).join("; ")}`,
    };
  }

  // ── Conflict detection ─────────────────────────────────────────────────────
  const conflictPairs = detectConflicts(tasks);

  // ── Wave assignment ────────────────────────────────────────────────────────
  const waveOf = assignWaves(taskIds, dependsOnMap, conflictPairs);

  // ── Gate computation ───────────────────────────────────────────────────────
  const taskGates = computeTaskGates(taskIds, waveOf, dependsOnMap, conflictPairs);

  // ── Build wave groups ──────────────────────────────────────────────────────
  const maxWave = Math.max(...(waveOf.values() as any));
  const waveGroups = [];
  for (let w = 1; w <= maxWave; w++) {
    const taskIdsInWave = taskIds.filter((id) => waveOf.get(id) === w);
    if (taskIdsInWave.length === 0) continue;

    // Collect all gates for tasks in this wave (deduplicated by afterTaskId+reason)
    const gateSet = new Map();
    for (const id of taskIdsInWave) {
      for (const gate of ((taskGates.get(id) || []) as any[])) {
        const key = `${gate.afterTaskId}::${gate.reason}`;
        if (!gateSet.has(key)) {
          gateSet.set(key, gate);
        }
      }
    }

    waveGroups.push({
      wave: w,
      taskIds: taskIdsInWave,
      gates: Array.from(gateSet.values()),
    });
  }

  // ── Parallelism statistics ─────────────────────────────────────────────────
  const waveSizes = waveGroups.map((w) => w.taskIds.length);
  const parallelTasks = waveSizes.filter((s) => s > 1).reduce((sum, s) => sum + s, 0);
  const serializedTasks = tasks.length - parallelTasks;

  return {
    schemaVersion: GRAPH_DIAGNOSTICS_SCHEMA_VERSION,
    resolvedAt,
    status: GRAPH_STATUS.OK,
    reasonCode: GRAPH_REASON.VALID,
    waves: waveGroups,
    conflictPairs,
    cycles: [],
    totalTasks: tasks.length,
    parallelTasks,
    serializedTasks,
    errorMessage: null,
  };
}

// ── Readiness gate ────────────────────────────────────────────────────────────

/**
 * Confidence dimension field names expected on each graph task.
 * Plans produced by Prometheus may carry any or all of these fields.
 * Presence of a dimension with a numeric value opts that task into readiness checking.
 */
export const READINESS_CONFIDENCE_DIMENSION = Object.freeze({
  SHAPE:       "shapeConfidence",
  BUDGET:      "budgetConfidence",
  DEPENDENCY:  "dependencyConfidence",
} as const);

/**
 * Default minimum confidence value required for a task dimension to be considered
 * "ready" for dispatch.  Values below this threshold cause the readiness gate to block.
 * Configurable via options.minConfidence passed to computeReadinessGate.
 */
export const READINESS_CONFIDENCE_THRESHOLD_DEFAULT = 0.5;

/**
 * Status codes for ReadinessGateResult.
 */
export const READINESS_STATUS = Object.freeze({
  /** All tasks with confidence metadata meet the minimum threshold. */
  READY:         "ready",
  /** One or more tasks have confidence below threshold or carry invalid values. */
  INCOMPLETE:    "incomplete",
  /** The tasks input itself was invalid (not an array). */
  INVALID_INPUT: "invalid_input",
} as const);

/**
 * Reason codes for ReadinessGateResult.
 */
export const READINESS_REASON = Object.freeze({
  /** Gate passed — all tasks are ready for dispatch. */
  READY:              "READY",
  /** One or more tasks carry a confidence dimension with a non-numeric (invalid) value. */
  MISSING_CONFIDENCE: "MISSING_CONFIDENCE",
  /** One or more tasks have a confidence dimension below the minimum threshold. */
  BELOW_THRESHOLD:    "BELOW_THRESHOLD",
  /** Tasks input was not an array. */
  INVALID_INPUT:      "INVALID_INPUT",
} as const);

/** Typed result produced by computeReadinessGate. */
export interface ReadinessGateResult {
  /** True when all tasks with confidence metadata meet the minimum threshold. */
  ready: boolean;
  /** One of READINESS_STATUS values. */
  status: string;
  /** One of READINESS_REASON values. */
  reason: string;
  /** Dimension names that carried non-numeric (invalid) confidence values. */
  missingDimensions: string[];
  /** Tasks whose numeric confidence values are below the threshold. */
  belowThresholdTasks: Array<{ id: string; dimension: string; value: number; threshold: number }>;
  /** Number of tasks evaluated. */
  checkedTasks: number;
}

/**
 * Evaluate whether all tasks in a plan set have valid and sufficient confidence
 * metadata for dispatch.
 *
 * Confidence dimensions checked (all optional per-task):
 *   shapeConfidence      — confidence in the task's scope/shape definition
 *   budgetConfidence     — confidence in the effort/budget estimate
 *   dependencyConfidence — confidence in the dependency ordering
 *
 * Blocking rules:
 *   - A dimension is present with a NON-numeric value → reason=MISSING_CONFIDENCE
 *   - A dimension is present with a numeric value BELOW minConfidence → reason=BELOW_THRESHOLD
 *   - A dimension is ABSENT from a task → no constraint (opt-in metric; absence is allowed)
 *
 * The gate is fail-open for tasks that simply don't carry confidence fields.
 * It only blocks when confidence is explicitly declared but invalid or insufficient.
 *
 * @param tasks   — array of graph task descriptors (must have `id` string field)
 * @param options — optional { minConfidence: number } (default 0.5)
 * @returns ReadinessGateResult — never throws
 */
export function computeReadinessGate(
  tasks: any[],
  options?: { minConfidence?: number }
): ReadinessGateResult {
  if (!Array.isArray(tasks)) {
    return {
      ready: false,
      status: READINESS_STATUS.INVALID_INPUT,
      reason: READINESS_REASON.INVALID_INPUT,
      missingDimensions: [],
      belowThresholdTasks: [],
      checkedTasks: 0,
    };
  }

  if (tasks.length === 0) {
    return {
      ready: true,
      status: READINESS_STATUS.READY,
      reason: READINESS_REASON.READY,
      missingDimensions: [],
      belowThresholdTasks: [],
      checkedTasks: 0,
    };
  }

  const minConfidence =
    typeof options?.minConfidence === "number" && options.minConfidence >= 0
      ? options.minConfidence
      : READINESS_CONFIDENCE_THRESHOLD_DEFAULT;

  const dimensions = Object.values(READINESS_CONFIDENCE_DIMENSION);
  const missingDimensionSet = new Set<string>();
  const belowThresholdTasks: Array<{ id: string; dimension: string; value: number; threshold: number }> = [];

  for (const task of tasks) {
    const id = String(task?.id || "");
    for (const dim of dimensions) {
      const value = (task as any)?.[dim];
      // Absent dimension → opt-in, skip (no constraint)
      if (value === undefined || value === null) continue;

      const numValue = Number(value);
      if (!Number.isFinite(numValue)) {
        // Present but not a valid number → missing/corrupt confidence data
        missingDimensionSet.add(dim);
        continue;
      }

      if (numValue < minConfidence) {
        belowThresholdTasks.push({ id, dimension: dim, value: numValue, threshold: minConfidence });
      }
    }
  }

  if (missingDimensionSet.size > 0) {
    return {
      ready: false,
      status: READINESS_STATUS.INCOMPLETE,
      reason: READINESS_REASON.MISSING_CONFIDENCE,
      missingDimensions: Array.from(missingDimensionSet),
      belowThresholdTasks,
      checkedTasks: tasks.length,
    };
  }

  if (belowThresholdTasks.length > 0) {
    const dims = [...new Set(belowThresholdTasks.map(t => t.dimension))];
    return {
      ready: false,
      status: READINESS_STATUS.INCOMPLETE,
      reason: READINESS_REASON.BELOW_THRESHOLD,
      missingDimensions: dims,
      belowThresholdTasks,
      checkedTasks: tasks.length,
    };
  }

  return {
    ready: true,
    status: READINESS_STATUS.READY,
    reason: READINESS_REASON.READY,
    missingDimensions: [],
    belowThresholdTasks: [],
    checkedTasks: tasks.length,
  };
}

// ── Persistence (AC5) ─────────────────────────────────────────────────────────

/**
 * Persist a GraphResolution diagnostic entry to:
 *   <stateDir>/dependency_graph_diagnostics.json  (NDJSON append log)
 *
 * The file grows one line per invocation. Callers should wrap this in a
 * try/catch — persistence failures must never block orchestration.
 *
 * @param {string} stateDir - absolute or repo-relative path to state directory
 * @param {object} resolution - result from resolveDependencyGraph
 * @param {object} [meta] - optional metadata (correlationId, etc.)
 * @returns {Promise<void>}
 */
export async function persistGraphDiagnostics(stateDir, resolution, meta: any = {}) {
  const diagnosticsPath = path.join(stateDir, "dependency_graph_diagnostics.json");
  const persistedAt = new Date().toISOString();
  const savedAt = persistedAt;
  const expiresAt = new Date(Date.now() + GRAPH_DIAGNOSTICS_FRESHNESS_MS).toISOString();
  const reservedKeys = new Set([
    "jsonlSchema",
    "recordType",
    "schemaVersion",
    "persistedAt",
    "freshness",
    "status",
    "reasonCode",
    "resolvedAt",
    "totalTasks",
    "parallelTasks",
    "serializedTasks",
    "waveCount",
    "conflictCount",
    "cycleCount",
    "errorMessage",
    "waves",
    "conflictPairs",
    "cycles",
  ]);
  const safeMeta = meta && typeof meta === "object" && !Array.isArray(meta)
    ? Object.fromEntries(Object.entries(meta).filter(([key]) => !reservedKeys.has(key)))
    : {};
  const entry = JSON.stringify({
    jsonlSchema: GRAPH_DIAGNOSTICS_JSONL_SCHEMA,
    recordType: GRAPH_DIAGNOSTICS_RECORD_TYPE,
    schemaVersion: GRAPH_DIAGNOSTICS_SCHEMA_VERSION,
    savedAt,
    persistedAt,
    freshness: {
      status: "fresh",
      truthStatus: "point_in_time",
      evaluatedAt: persistedAt,
      staleAfterMs: GRAPH_DIAGNOSTICS_FRESHNESS_MS,
      expiresAt,
    },
    ...safeMeta,
    status: resolution.status,
    reasonCode: resolution.reasonCode,
    resolvedAt: resolution.resolvedAt,
    totalTasks: resolution.totalTasks,
    parallelTasks: resolution.parallelTasks,
    serializedTasks: resolution.serializedTasks,
    waveCount: Array.isArray(resolution.waves) ? resolution.waves.length : 0,
    conflictCount: Array.isArray(resolution.conflictPairs) ? resolution.conflictPairs.length : 0,
    cycleCount: Array.isArray(resolution.cycles) ? resolution.cycles.length : 0,
    errorMessage: resolution.errorMessage ?? null,
    waves: resolution.waves,
    conflictPairs: resolution.conflictPairs,
    cycles: resolution.cycles,
    payload: {
      status: resolution.status,
      reasonCode: resolution.reasonCode,
      resolvedAt: resolution.resolvedAt,
      totalTasks: resolution.totalTasks,
      parallelTasks: resolution.parallelTasks,
      serializedTasks: resolution.serializedTasks,
      waveCount: Array.isArray(resolution.waves) ? resolution.waves.length : 0,
      conflictCount: Array.isArray(resolution.conflictPairs) ? resolution.conflictPairs.length : 0,
      cycleCount: Array.isArray(resolution.cycles) ? resolution.cycles.length : 0,
      errorMessage: resolution.errorMessage ?? null,
      waves: resolution.waves,
      conflictPairs: resolution.conflictPairs,
      cycles: resolution.cycles,
    },
  });

  await fs.appendFile(diagnosticsPath, entry + "\n", "utf8");
}
