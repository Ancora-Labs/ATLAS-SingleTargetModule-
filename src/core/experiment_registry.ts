/**
 * Experiment Registry — Self-Improvement Experiment Management
 *
 * Tracks autonomous config/policy interventions as structured experiments so that
 * every change can be traced, disproved, and rolled back deterministically.
 *
 * ## Conflict dimension (AC3)
 *   Two experiments conflict when they share ≥1 config path in interventionScope
 *   AND both have status "running". Config-path overlap is chosen because:
 *   - It is directly observable (two writers on the same key produce indeterminate state)
 *   - It requires no external coordination (pure set intersection)
 *   - Domain/role conflicts are less dangerous because they do not produce silent overrides
 *
 * ## AC1 enforcement mode
 *   - soft (default): config changes are tagged with an experiment ID when one is active;
 *     a warning is logged if none is found, but the change is not blocked.
 *     Use this for migration while existing suggestions are still in-flight.
 *   - hard: config changes are blocked unless a running experiment covers the config path.
 *     Enable via selfImprovement.experimentEnforcement = "hard" in box.config.json.
 *     WARNING: enabling hard mode stops all auto-tuning until experiments are registered.
 *
 * State file: state/experiment_registry.json
 */

import path from "node:path";
import { createHash } from "node:crypto";
import { readJson, writeJson } from "./fs_utils.js";

// ── Schema ────────────────────────────────────────────────────────────────────

/**
 * @typedef {"planned"|"running"|"completed"|"rolled_back"} ExperimentStatus
 */

/**
 * @typedef {"max_duration_hours"|"error_rate_threshold"|"min_health_score"|"manual"} StopConditionType
 */

/**
 * @typedef {object} StopCondition
 * @property {StopConditionType} type
 * @property {number|string}     value
 */

/**
 * @typedef {object} BaselineWindow
 * @property {string}  startAt       ISO timestamp
 * @property {string|null} endAt     ISO timestamp or null if open-ended
 * @property {number}  durationHours Planned duration
 */

/**
 * @typedef {object} Experiment
 * @property {string}           experimentId       Stable derived ID
 * @property {string}           hypothesisId       What we expect to be true
 * @property {string}           interventionId     What we are changing
 * @property {string}           treatmentGroup     A/B group label
 * @property {BaselineWindow}   baselineWindow     Measurement window before the change
 * @property {StopCondition[]}  stopConditions     When to halt the experiment
 * @property {string}           disproveCriteria   Explicit falsification statement
 * @property {string}           rollbackPlan       How to undo the intervention
 * @property {string[]}         interventionScope  Config paths this experiment touches
 * @property {ExperimentStatus} status
 * @property {string|null}      [statusReason]     Machine-readable reason for last transition
 * @property {string}           createdAt
 * @property {string}           [startedAt]
 * @property {string}           [completedAt]
 * @property {string}           [rolledBackAt]
 */

/**
 * @typedef {object} RegistryStore
 * @property {number}       schemaVersion
 * @property {Experiment[]} experiments
 * @property {string}       [updatedAt]
 */

/** @type {ReadonlySet<ExperimentStatus>} */
export const VALID_STATUSES = Object.freeze(
  new Set(["planned", "running", "completed", "rolled_back"])
);

/** @type {ReadonlySet<StopConditionType>} */
export const VALID_STOP_CONDITION_TYPES = Object.freeze(
  new Set(["max_duration_hours", "error_rate_threshold", "min_health_score", "manual"])
);

export const EXTERNAL_BENCHMARK_CONTRACTS = Object.freeze([
  Object.freeze({
    name: "swe-bench",
    requiredFields: Object.freeze(["benchmarkName", "instanceId", "repo", "status"]),
  }),
  Object.freeze({
    name: "osworld",
    requiredFields: Object.freeze(["benchmarkName", "instanceId", "environmentId", "status"]),
  }),
]);

/** Valid status transitions. Unlisted source statuses have no valid transitions. */
const VALID_TRANSITIONS = Object.freeze({
  planned:     Object.freeze(["running"]),
  running:     Object.freeze(["completed", "rolled_back"]),
  completed:   Object.freeze(["rolled_back"]),
  rolled_back: Object.freeze([])
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function isIsoDate(value) {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  return Number.isFinite(Date.parse(value));
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * @typedef {object} ValidationError
 * @property {string}                         field
 * @property {"MISSING_FIELD"|"INVALID_VALUE"} code
 * @property {string}                         message
 */

/**
 * Validate an experiment definition.
 *
 * Distinguishes missing fields (code: "MISSING_FIELD") from invalid values
 * (code: "INVALID_VALUE") so callers can surface precise error messages.
 *
 * @param {unknown} input
 * @returns {{ ok: boolean, errors: ValidationError[] }}
 */
export function validateExperiment(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      errors: [{ field: "root", code: "MISSING_FIELD", message: "experiment must be a non-null object" }]
    };
  }

  const exp = /** @type {Record<string, unknown>} */ (input);
  const errors = /** @type {ValidationError[]} */ ([]);

  // ── Required non-empty strings
  for (const field of ["experimentId", "hypothesisId", "interventionId", "treatmentGroup", "disproveCriteria", "rollbackPlan"]) {
    if (!(field in exp) || exp[field] == null) {
      errors.push({ field, code: "MISSING_FIELD", message: `${field} is required` });
    } else if (typeof exp[field] !== "string" || String(exp[field]).trim() === "") {
      errors.push({ field, code: "INVALID_VALUE", message: `${field} must be a non-empty string` });
    }
  }

  // ── baselineWindow
  if (!(("baselineWindow") in exp) || exp.baselineWindow == null) {
    errors.push({ field: "baselineWindow", code: "MISSING_FIELD", message: "baselineWindow is required" });
  } else if (typeof exp.baselineWindow !== "object" || Array.isArray(exp.baselineWindow)) {
    errors.push({ field: "baselineWindow", code: "INVALID_VALUE", message: "baselineWindow must be an object" });
  } else {
    const bw = /** @type {Record<string, unknown>} */ (exp.baselineWindow);

    if (!("startAt" in bw) || bw.startAt == null) {
      errors.push({ field: "baselineWindow.startAt", code: "MISSING_FIELD", message: "baselineWindow.startAt is required" });
    } else if (!isIsoDate(bw.startAt)) {
      errors.push({ field: "baselineWindow.startAt", code: "INVALID_VALUE", message: "baselineWindow.startAt must be a valid ISO timestamp" });
    }

    if (bw.endAt !== null && bw.endAt !== undefined && !isIsoDate(bw.endAt)) {
      errors.push({ field: "baselineWindow.endAt", code: "INVALID_VALUE", message: "baselineWindow.endAt must be a valid ISO timestamp or null" });
    }

    if (!("durationHours" in bw) || bw.durationHours == null) {
      errors.push({ field: "baselineWindow.durationHours", code: "MISSING_FIELD", message: "baselineWindow.durationHours is required" });
    } else if (typeof bw.durationHours !== "number" || !Number.isFinite(bw.durationHours) || bw.durationHours <= 0) {
      errors.push({ field: "baselineWindow.durationHours", code: "INVALID_VALUE", message: "baselineWindow.durationHours must be a positive finite number" });
    }
  }

  // ── stopConditions
  if (!("stopConditions" in exp) || exp.stopConditions == null) {
    errors.push({ field: "stopConditions", code: "MISSING_FIELD", message: "stopConditions is required" });
  } else if (!Array.isArray(exp.stopConditions) || exp.stopConditions.length === 0) {
    errors.push({ field: "stopConditions", code: "INVALID_VALUE", message: "stopConditions must be a non-empty array" });
  } else {
    for (let i = 0; i < exp.stopConditions.length; i++) {
      const sc = exp.stopConditions[i];
      if (!sc || typeof sc !== "object") {
        errors.push({ field: `stopConditions[${i}]`, code: "INVALID_VALUE", message: `stopConditions[${i}] must be an object` });
        continue;
      }
      if (!("type" in sc) || sc.type == null) {
        errors.push({ field: `stopConditions[${i}].type`, code: "MISSING_FIELD", message: `stopConditions[${i}].type is required` });
      } else if (!VALID_STOP_CONDITION_TYPES.has(/** @type {any} */ (sc.type))) {
        errors.push({
          field: `stopConditions[${i}].type`,
          code: "INVALID_VALUE",
          message: `stopConditions[${i}].type must be one of: ${[...VALID_STOP_CONDITION_TYPES].join(", ")}`
        });
      }
      if (!("value" in sc) || sc.value == null) {
        errors.push({ field: `stopConditions[${i}].value`, code: "MISSING_FIELD", message: `stopConditions[${i}].value is required` });
      }
    }
  }

  // ── interventionScope
  if (!("interventionScope" in exp) || exp.interventionScope == null) {
    errors.push({ field: "interventionScope", code: "MISSING_FIELD", message: "interventionScope is required" });
  } else if (!Array.isArray(exp.interventionScope) || exp.interventionScope.length === 0) {
    errors.push({ field: "interventionScope", code: "INVALID_VALUE", message: "interventionScope must be a non-empty array of config path strings" });
  } else {
    const nonStrings = exp.interventionScope.filter(p => typeof p !== "string" || p.trim() === "");
    if (nonStrings.length > 0) {
      errors.push({ field: "interventionScope", code: "INVALID_VALUE", message: "interventionScope entries must be non-empty strings" });
    }
  }

  // ── status
  if (!("status" in exp) || exp.status == null) {
    errors.push({ field: "status", code: "MISSING_FIELD", message: "status is required" });
  } else if (!VALID_STATUSES.has(/** @type {any} */ (exp.status))) {
    errors.push({
      field: "status",
      code: "INVALID_VALUE",
      message: `status must be one of: ${[...VALID_STATUSES].join(", ")}`
    });
  }

  return { ok: errors.length === 0, errors };
}

// ── ID generation ─────────────────────────────────────────────────────────────

/**
 * Build a stable experiment ID from its defining axes.
 * The ID is deterministic so duplicate registrations are detectable.
 *
 * @param {string} hypothesisId
 * @param {string} interventionId
 * @param {string} treatmentGroup
 * @returns {string}
 */
export function buildExperimentId(hypothesisId, interventionId, treatmentGroup) {
  const key = `${hypothesisId}|${interventionId}|${treatmentGroup}`;
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 12);
  return `exp-${hash}`;
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * Load experiment registry from disk.
 * Always returns a fresh default object so concurrent callers cannot share a
 * mutable array reference through the fallback.
 * @param {string} stateDir
 * @returns {Promise<RegistryStore>}
 */
export async function loadRegistry(stateDir) {
  return readJson(path.join(stateDir, "experiment_registry.json"), { schemaVersion: 1, experiments: [] });
}

/**
 * Save experiment registry to disk.
 * @param {string} stateDir
 * @param {RegistryStore} registry
 */
export async function saveRegistry(stateDir, registry) {
  registry.updatedAt = new Date().toISOString();
  await writeJson(path.join(stateDir, "experiment_registry.json"), registry);
}

// ── Conflict detection ────────────────────────────────────────────────────────

/**
 * Detect conflicts between a candidate experiment and all currently running experiments.
 *
 * Conflict dimension: config-path overlap in interventionScope.
 * Two experiments are in conflict when they share ≥1 config path in interventionScope
 * and both would be in "running" state simultaneously.
 *
 * @param {RegistryStore} registry
 * @param {Pick<Experiment, "experimentId"|"interventionScope">} candidate
 * @returns {{ hasConflict: boolean, conflictsWith: string[], sharedPaths: string[] }}
 */
export function detectConflicts(registry, candidate) {
  const candidatePaths = new Set(
    Array.isArray(candidate.interventionScope) ? candidate.interventionScope : []
  );

  const running = (registry.experiments || []).filter(
    e => e.status === "running" && e.experimentId !== candidate.experimentId
  );

  const conflictsWith = [];
  const sharedPaths = [];

  for (const exp of running) {
    const expPaths = Array.isArray(exp.interventionScope) ? exp.interventionScope : [];
    const overlap = expPaths.filter(p => candidatePaths.has(p));
    if (overlap.length > 0) {
      conflictsWith.push(exp.experimentId);
      for (const p of overlap) {
        if (!sharedPaths.includes(p)) sharedPaths.push(p);
      }
    }
  }

  return { hasConflict: conflictsWith.length > 0, conflictsWith, sharedPaths };
}

// ── Registry operations ───────────────────────────────────────────────────────

/**
 * Register a new experiment.
 *
 * Validates, checks for duplicate IDs, checks conflicts if status is "running", then saves.
 *
 * @param {string}  stateDir
 * @param {unknown} experiment
 * @returns {Promise<{ ok: boolean, experimentId?: string, errors?: ValidationError[], conflict?: object }>}
 */
export async function registerExperiment(stateDir, experiment) {
  const validation = validateExperiment(experiment);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }

  const exp = /** @type {Experiment} */ (experiment);
  const registry = await loadRegistry(stateDir);

  // Duplicate ID check
  const exists = (registry.experiments || []).some(e => e.experimentId === exp.experimentId);
  if (exists) {
    return {
      ok: false,
      errors: [{ field: "experimentId", code: "INVALID_VALUE", message: `experiment ${exp.experimentId} already exists` }]
    };
  }

  // Conflict check (only relevant when starting in running state)
  if (exp.status === "running") {
    const conflict = detectConflicts(registry, exp);
    if (conflict.hasConflict) {
      return {
        ok: false,
        errors: [{
          field: "interventionScope",
          code: "INVALID_VALUE",
          message: `conflicts with running experiments ${conflict.conflictsWith.join(", ")} on paths: ${conflict.sharedPaths.join(", ")}`
        }],
        conflict
      };
    }
  }

  const now = new Date().toISOString();
  const entry = /** @type {Experiment} */ ({
    ...exp,
    createdAt: exp.createdAt || now,
    ...(exp.status === "running" && !exp.startedAt ? { startedAt: now } : {})
  });

  registry.experiments = registry.experiments || [];
  registry.experiments.push(entry);
  await saveRegistry(stateDir, registry);

  return { ok: true, experimentId: exp.experimentId };
}

/**
 * Transition an experiment to a new status.
 *
 * Valid transitions:
 *   planned     → running
 *   running     → completed | rolled_back
 *   completed   → rolled_back
 *   rolled_back → (terminal — no transitions allowed)
 *
 * @param {string}  stateDir
 * @param {string}  experimentId
 * @param {ExperimentStatus} newStatus
 * @param {string}  [reason]  Machine-readable reason string
 * @returns {Promise<{ ok: boolean, status?: ExperimentStatus, errors?: ValidationError[], conflict?: object }>}
 */
export async function transitionExperiment(stateDir, experimentId, newStatus, reason) {
  if (!experimentId || typeof experimentId !== "string") {
    return { ok: false, errors: [{ field: "experimentId", code: "MISSING_FIELD", message: "experimentId is required" }] };
  }
  if (!newStatus || !VALID_STATUSES.has(newStatus)) {
    return {
      ok: false,
      errors: [{ field: "status", code: "INVALID_VALUE", message: `status must be one of: ${[...VALID_STATUSES].join(", ")}` }]
    };
  }

  const registry = await loadRegistry(stateDir);
  const idx = (registry.experiments || []).findIndex(e => e.experimentId === experimentId);

  if (idx === -1) {
    return {
      ok: false,
      errors: [{ field: "experimentId", code: "INVALID_VALUE", message: `experiment ${experimentId} not found` }]
    };
  }

  const exp = registry.experiments[idx];
  const current = exp.status;
  const allowed = VALID_TRANSITIONS[current] || [];

  if (!allowed.includes(newStatus)) {
    return {
      ok: false,
      errors: [{
        field: "status",
        code: "INVALID_VALUE",
        message: `cannot transition from ${current} to ${newStatus}; allowed: ${allowed.join(", ") || "none (terminal)"}`
      }]
    };
  }

  // Conflict check before starting
  if (newStatus === "running") {
    const conflict = detectConflicts(registry, exp);
    if (conflict.hasConflict) {
      return {
        ok: false,
        errors: [{
          field: "interventionScope",
          code: "INVALID_VALUE",
          message: `cannot start: conflicts with running experiments ${conflict.conflictsWith.join(", ")} on paths: ${conflict.sharedPaths.join(", ")}`
        }],
        conflict
      };
    }
  }

  const now = new Date().toISOString();
  registry.experiments[idx] = {
    ...exp,
    status: newStatus,
    statusReason: reason || null,
    ...(newStatus === "running"     ? { startedAt:    now } : {}),
    ...(newStatus === "completed"   ? { completedAt:  now } : {}),
    ...(newStatus === "rolled_back" ? { rolledBackAt: now } : {})
  };

  await saveRegistry(stateDir, registry);
  return { ok: true, status: newStatus };
}

// ── Query helpers ─────────────────────────────────────────────────────────────

/**
 * Return IDs of running experiments that include the given config path in their
 * interventionScope. Used by self_improvement.js to tag applied config changes.
 *
 * @param {RegistryStore} registry
 * @param {string}        configPath
 * @returns {string[]}
 */
export function getRunningExperimentsForPath(registry, configPath) {
  return (registry.experiments || [])
    .filter(e => e.status === "running" && Array.isArray(e.interventionScope) && e.interventionScope.includes(configPath))
    .map(e => e.experimentId);
}

/**
 * Return all experiments with a given status.
 *
 * @param {RegistryStore}  registry
 * @param {ExperimentStatus} status
 * @returns {Experiment[]}
 */
export function getExperimentsByStatus(registry, status) {
  return (registry.experiments || []).filter(e => e.status === status);
}
