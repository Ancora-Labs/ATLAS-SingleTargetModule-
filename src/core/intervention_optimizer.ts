/**
 * intervention_optimizer.js — Budget-aware intervention optimizer for BOX.
 *
 * An "Intervention" is the domain concept for a planned unit of work dispatched
 * to a specific worker role in a specific execution wave.
 *
 * ── Domain definitions (deterministic, machine-checkable) ────────────────────
 *
 * INTERVENTION object shape (all fields required unless noted):
 *   id                  {string}  — unique identifier for this intervention
 *   type                {string}  — enum: "task" | "split" | "followup"
 *   wave                {integer} — execution wave number (>= 1)
 *   role                {string}  — worker role name (non-empty)
 *   title               {string}  — short description (non-empty)
 *   successProbability  {number}  — P(success) ∈ [0.0, 1.0]
 *   impact              {number}  — gain if success ∈ [0.0, 1.0]
 *   riskCost            {number}  — cost if failure ∈ [0.0, 1.0]
 *   sampleCount         {integer} — historical observations (>= 0)
 *   budgetCost          {integer} — worker spawns consumed (>= 1)
 *
 * BUDGET object shape:
 *   maxWorkerSpawns     {integer} — total spawn budget (>= 1; unit: workerSpawns)
 *   maxWorkersPerWave   {integer} — per-wave spawn cap (optional; defaults to maxWorkerSpawns)
 *   byRole              {object}  — per-role spawn caps: { [roleName]: integer } (optional)
 *
 * ── Expected-value formula (deterministic) ───────────────────────────────────
 *
 *   SPARSE_DATA_THRESHOLD = 3   — minimum sample count for full confidence
 *
 *   confidenceMultiplier(n) = min(1.0, n / SPARSE_DATA_THRESHOLD)
 *     n = 0  → 0.000  (no data — maximum confidence penalty)
 *     n = 1  → 0.333
 *     n = 2  → 0.667
 *     n >= 3 → 1.000  (full confidence)
 *
 *   adjustedSuccessProbability = successProbability × confidenceMultiplier(sampleCount)
 *
 *   EV = adjustedSuccessProbability × impact
 *      − (1 − adjustedSuccessProbability) × riskCost
 *
 * ── Budget reconciliation (all three constraints must be satisfied) ───────────
 *
 *   1. totalBudget  — Σ budgetCost of selected interventions ≤ maxWorkerSpawns
 *   2. byWaveBudget — per-wave Σ budgetCost ≤ maxWorkersPerWave
 *   3. byRoleBudget — per-role Σ budgetCost ≤ byRole[role] (when configured)
 *
 *   Selection algorithm: greedy by descending EV.
 *   An intervention is blocked if accepting it would violate any active constraint.
 *   Blocked interventions appear in `rejected[]` with an explicit `reasonCode`.
 *
 * ── Budget unit ───────────────────────────────────────────────────────────────
 *   Unit: "workerSpawns" — integer count of worker process spawns.
 *   Source: box.config.json → runtime.runtimeBudget.maxWorkerSpawnsPerCycle
 *
 * ── Persistence ───────────────────────────────────────────────────────────────
 *   Log file: state/intervention_optimizer_log.jsonl
 *   Schema version: OPTIMIZER_LOG_SCHEMA_VERSION (integer, currently 1)
 *   Required fields in each entry: schemaVersion, generatedAt, status, reasonCode,
 *     budgetUnit, totalBudgetLimit, totalBudgetUsed, byWaveBudgetLimit,
 *     byWaveUsed, byRoleBudgetLimits, byRoleUsed, selected, rejected
 *
 * Risk level: HIGH — modification of prometheus.js, state_tracker.js, and this
 *   new module requires careful isolation. All optimizer calls are non-blocking
 *   and never fail the parent orchestration flow.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { applyClassificationToSuccessProbability, normalizeRoleKey } from "./failure_classifier.js";
import { readJson, writeJson } from "./fs_utils.js";
import {
  IMPACT_ATTRIBUTION_OUTCOME,
  summarizeImpactAttributionWindow,
} from "./lesson_halflife.js";
import { normalizePlanRoleToWorkerName } from "./role_registry.js";

// ── Budget unit ───────────────────────────────────────────────────────────────

/**
 * Canonical budget unit identifier. Written into every persisted record so that
 * log consumers know what integer counts represent.
 */
export const BUDGET_UNIT = "workerSpawns";

// ── Intervention type enum ────────────────────────────────────────────────────

/**
 * Canonical Intervention type values.
 *   task      — a primary planned task assigned to one worker
 *   split     — a sub-task split from a larger task
 *   followup  — a follow-up task generated after a prior worker's output
 */
export const INTERVENTION_TYPE = Object.freeze({
  TASK:      "task",
  SPLIT:     "split",
  FOLLOWUP:  "followup",
});

export const INTERVENTION_ACCOUNTING_CATEGORY = Object.freeze({
  PLANNING: "planning_intervention",
  RETRY: "retry_intervention",
});

// ── Optimizer status enum ─────────────────────────────────────────────────────

/**
 * Top-level status codes returned by runInterventionOptimizer.
 * Written to the `status` field in every persisted log entry.
 */
export const OPTIMIZER_STATUS = Object.freeze({
  /** All interventions scheduled without budget violations. */
  OK:              "ok",
  /**
   * One or more interventions were rejected for budget reasons.
   * The schedule was created for the remaining interventions.
   */
  BUDGET_EXCEEDED: "budget_exceeded",
  /**
   * Input validation failed — no schedule was created.
   * Check `errorMessage` for the human-readable explanation and
   * `reasonCode` for the machine-readable reason.
   */
  INVALID_INPUT:   "invalid_input",
  /** Interventions array was valid but empty — no schedule created. */
  EMPTY_INPUT:     "empty_input",
});

// ── Optimizer reason code enum ────────────────────────────────────────────────

/**
 * Machine-readable reason codes for the top-level optimizer result.
 * Callers must inspect this field; silent fallback is not allowed.
 */
export const OPTIMIZER_REASON_CODE = Object.freeze({
  /** Schedule created, all interventions accepted. */
  VALID:                      "VALID",
  /** No interventions were provided. */
  EMPTY_INPUT:                "EMPTY_INPUT",
  /** Required input (interventions array or budget) was null/undefined. */
  MISSING_INPUT:              "MISSING_INPUT",
  /** An individual intervention failed schema validation. */
  INVALID_INTERVENTION:       "INVALID_INTERVENTION",
  /** Budget object failed validation. */
  INVALID_BUDGET:             "INVALID_BUDGET",
  /** At least one intervention was dropped — total spawn budget exceeded. */
  BUDGET_TOTAL_EXCEEDED:      "BUDGET_TOTAL_EXCEEDED",
  /** At least one intervention was dropped — wave spawn budget exceeded. */
  BUDGET_WAVE_EXCEEDED:       "BUDGET_WAVE_EXCEEDED",
  /** At least one intervention was dropped — role spawn budget exceeded. */
  BUDGET_ROLE_EXCEEDED:       "BUDGET_ROLE_EXCEEDED",
});

// ── Per-intervention rejection reason codes ───────────────────────────────────

/**
 * Machine-readable reason codes attached to each entry in the `rejected[]` array.
 */
export const INTERVENTION_REJECTION_CODE = Object.freeze({
  BUDGET_TOTAL: "BUDGET_TOTAL",
  BUDGET_WAVE:  "BUDGET_WAVE",
  BUDGET_ROLE:  "BUDGET_ROLE",
  DUPLICATE_FAMILY_CONTINUATION: "DUPLICATE_FAMILY_CONTINUATION",
});

// ── Intervention validation error codes ──────────────────────────────────────

/**
 * Reason codes returned by validateIntervention.
 * Distinguishes missing input from invalid field values.
 */
export const INTERVENTION_ERROR_CODE = Object.freeze({
  /** Input is null/undefined (missing entirely). */
  MISSING_INPUT:  "MISSING_INPUT",
  /** Input is not a plain object (wrong type). */
  INVALID_TYPE:   "INVALID_TYPE",
  /** A required field is absent from the object. */
  MISSING_FIELD:  "MISSING_FIELD",
  /** A field is present but its value is invalid. */
  INVALID_FIELD:  "INVALID_FIELD",
});

/**
 * EV penalty coefficient applied per rerouted specialist batch.
 * Each reroute occurrence reduces the EV for interventions in that role by this fraction.
 * Bounded by REROUTE_EV_MAX_PENALTY to prevent blocking all work.
 */
export const REROUTE_EV_PENALTY_COEFFICIENT = 0.15;

/**
 * Higher EV penalty coefficient applied when reroute reason is PERFORMANCE_DEGRADED.
 * Performance-degraded reroutes indicate a persistent failure pattern, warranting
 * a stronger signal to the adaptive threshold to avoid repeat specialist dispatches.
 */
export const REROUTE_PERFORMANCE_EV_PENALTY_COEFFICIENT = 0.25;

/**
 * Maximum total EV penalty fraction that can be applied from reroute history.
 * Caps the penalty even when many reroutes are observed.
 */
export const REROUTE_EV_MAX_PENALTY = 0.20;

/**
 * Number of PERFORMANCE_DEGRADED reroutes within a role that triggers escalation.
 * When this threshold is met the optimizer emits a structured WARN so the
 * orchestrator can act (e.g., skip specialist dispatch entirely for that lane).
 */
export const REROUTE_ESCALATION_THRESHOLD = 2;

/**
 * Canonical schema for records written to state/reroute_history.jsonl by the
 * orchestrator dispatch phase when specialist roles are rerouted.
 *
 * Each line in the file is a JSON-serialised object with exactly these fields.
 * This schema is the contract between the orchestrator (writer) and the optimizer
 * (reader) — the optimizer's applyRerouteCostPenalty() reads `role` and `reasonCode`.
 *
 * Field semantics:
 *   recordedAt          — ISO 8601 timestamp when the reroute was recorded
 *   role                — specialist role name that was rerouted (non-empty string)
 *   lane                — lane identifier for the rerouted role (non-empty string)
 *   reasonCode          — machine-readable reason (e.g. "fill_threshold", "performance_degraded")
 *   fillRatio           — actual fill ratio at time of reroute (number 0–1)
 *   laneScore           — composite lane score at time of reroute (number)
 */
export const REROUTE_HISTORY_RECORD_SCHEMA = Object.freeze({
  required: Object.freeze(["recordedAt", "role", "lane", "reasonCode", "fillRatio", "laneScore"]),
  reasonCodeExamples: Object.freeze(["fill_threshold", "performance_degraded", "below_fill_threshold"]),
});

// ── Anti-overbundle admission policy constants ────────────────────────────────

/**
 * Maximum total ordered steps across all plans in a single worker call before
 * the overbundle EV penalty activates.
 *
 * A batch whose step count exceeds this threshold is considered over-bundled:
 * the worker cannot reason coherently across all steps in a single session,
 * increasing verification latency and premium-request waste.
 */
export const OVERBUNDLE_STEPS_THRESHOLD = 9;

/**
 * EV penalty coefficient applied per over-bundled intervention.
 * Reduces the Expected Value by this fraction when totalOrderedSteps exceeds
 * OVERBUNDLE_STEPS_THRESHOLD, making the optimizer prefer splitting into
 * smaller coherent packets over dispatching an over-bundled batch.
 */
export const OVERBUNDLE_EV_PENALTY_COEFFICIENT = 0.20;

/**
 * Apply an overbundle EV penalty when the intervention's ordered-step count
 * exceeds OVERBUNDLE_STEPS_THRESHOLD.
 *
 * Only positive EVs are penalized (a negative-EV intervention is already
 * deprioritized and further penalizing it would have no scheduling impact).
 *
 * @param ev             - current expected value
 * @param stepCount      - total ordered steps in this intervention's batch
 * @returns adjusted EV (≤ original)
 */
export function applyOverbundleEVPenalty(ev: number, stepCount: number): number {
  if (ev <= 0) return ev;
  if (!Number.isFinite(stepCount) || stepCount <= OVERBUNDLE_STEPS_THRESHOLD) return ev;
  return Math.round((ev * (1 - OVERBUNDLE_EV_PENALTY_COEFFICIENT)) * 1000) / 1000;
}

/**
 * checkOverbundleHardAdmission — pre-dispatch hard admission gate for over-bundled packets.
 *
 * A plan packet is "over-bundled" when its ordered-step count (derived from
 * acceptance_criteria, orderedSteps, or plans.length) exceeds the threshold.
 * Over-bundled packets must be rejected or split before dispatch — this gate
 * makes the block deterministic and machine-readable.
 *
 * Distinct from applyOverbundleEVPenalty (which is a soft scoring adjustment):
 * this function returns a hard binary block decision so the orchestrator can
 * reject or split the packet before it reaches any worker.
 *
 * @param plans     — plan objects to evaluate
 * @param threshold — ordered-step cap (default: OVERBUNDLE_STEPS_THRESHOLD)
 * @returns { blocked, reason, rejectedIds }
 */
export function checkOverbundleHardAdmission(
  plans: any[],
  threshold: number = OVERBUNDLE_STEPS_THRESHOLD,
): { blocked: boolean; reason: string | null; rejectedIds: string[] } {
  if (!Array.isArray(plans) || plans.length === 0) {
    return { blocked: false, reason: null, rejectedIds: [] };
  }
  const cap = Math.max(1, Math.floor(Number.isFinite(threshold) ? threshold : OVERBUNDLE_STEPS_THRESHOLD));
  const rejectedIds: string[] = [];

  for (let idx = 0; idx < plans.length; idx += 1) {
    const plan = plans[idx];
    const id = String(plan?.id ?? plan?.task_id ?? "").trim();
    const steps = Array.isArray(plan?.orderedSteps)
      ? plan.orderedSteps.length
      : Array.isArray(plan?.ordered_steps)
        ? plan.ordered_steps.length
      : Array.isArray(plan?.acceptance_criteria)
        ? plan.acceptance_criteria.length
        : Array.isArray(plan?.plans)
          ? plan.plans.length
          : 1;
    if (steps > cap) {
      rejectedIds.push(id || `plan-idx-${idx}`);
    }
  }

  if (rejectedIds.length === 0) {
    return { blocked: false, reason: null, rejectedIds: [] };
  }

  const reason = `overbundle_hard_admission: ${rejectedIds.length} packet(s) [${rejectedIds.join(", ")}] exceed ordered-step cap of ${cap} — split or decompose before dispatch`;
  return { blocked: true, reason, rejectedIds };
}



/**
 * Apply a bounded EV penalty to an intervention whose role was recently rerouted.
 *
 * Penalty coefficient is differentiated by reason code:
 *   - PERFORMANCE_DEGRADED: uses REROUTE_PERFORMANCE_EV_PENALTY_COEFFICIENT (0.25)
 *   - all other codes:      uses REROUTE_EV_PENALTY_COEFFICIENT (0.15)
 * Bounded by REROUTE_EV_MAX_PENALTY. Only applied to positive EVs.
 *
 * Side effect: when PERFORMANCE_DEGRADED reroutes for a role reach
 * REROUTE_ESCALATION_THRESHOLD, a structured escalation object is returned
 * in the result alongside the adjusted EV.
 *
 * @param ev             - current expected value
 * @param role           - intervention role
 * @param rerouteReasons - reroute reasons from previous cycle(s)
 * @returns adjusted EV (≤ original)
 */
export function applyRerouteCostPenalty(
  ev: number,
  role: string,
  rerouteReasons: Array<{ role: string; reasonCode: string }>,
): number {
  if (!Array.isArray(rerouteReasons) || rerouteReasons.length === 0) return ev;
  const matchingReroutes = rerouteReasons.filter(r => r.role === role);
  if (matchingReroutes.length === 0) return ev;
  if (ev <= 0) return ev; // only penalize positive EVs

  // Accumulate weighted penalty: PERFORMANCE_DEGRADED counts at higher coefficient.
  let totalPenaltyFraction = 0;
  for (const reroute of matchingReroutes) {
    const coeff = reroute.reasonCode === "performance_degraded"
      ? REROUTE_PERFORMANCE_EV_PENALTY_COEFFICIENT
      : REROUTE_EV_PENALTY_COEFFICIENT;
    totalPenaltyFraction += coeff;
  }
  const boundedPenalty = Math.min(REROUTE_EV_MAX_PENALTY, totalPenaltyFraction);
  return Math.round((ev * (1 - boundedPenalty)) * 1000) / 1000;
}

/**
 * Check whether performance-degraded reroutes for a role have crossed the
 * escalation threshold. Returns a structured escalation descriptor or null.
 *
 * Intended to be called by the orchestrator after collecting reroute reasons
 * so it can emit a WARN and optionally suppress specialist dispatch for that lane.
 */
export function getRerouteEscalationSignal(
  role: string,
  rerouteReasons: Array<{ role: string; reasonCode: string }>,
): { role: string; degradedCount: number; escalate: true } | null {
  if (!Array.isArray(rerouteReasons)) return null;
  const degradedCount = rerouteReasons.filter(
    r => r.role === role && r.reasonCode === "performance_degraded"
  ).length;
  if (degradedCount >= REROUTE_ESCALATION_THRESHOLD) {
    return { role, degradedCount, escalate: true };
  }
  return null;
}

// ── Sparse data constant ──────────────────────────────────────────────────────

/**
 * Minimum number of historical observations (sampleCount) required before the
 * optimizer applies full confidence to an intervention's successProbability.
 *
 * Below this threshold the confidence penalty formula applies:
 *   confidenceMultiplier = min(1.0, sampleCount / SPARSE_DATA_THRESHOLD)
 *
 * Formula is deterministic and testable:
 *   sampleCount = 0 → multiplier = 0.000
 *   sampleCount = 1 → multiplier = 0.333
 *   sampleCount = 2 → multiplier = 0.667
 *   sampleCount >= 3 → multiplier = 1.000
 */
export const SPARSE_DATA_THRESHOLD = 3;

// ── Schema version ────────────────────────────────────────────────────────────

/**
 * Schema version for intervention_optimizer_log.jsonl entries.
 * Bump (integer) when the persisted schema changes incompatibly.
 */
export const OPTIMIZER_LOG_SCHEMA_VERSION = 1;
export const OPTIMIZER_LOG_JSONL_SCHEMA = "box.intervention_optimizer_log.v2";
export const OPTIMIZER_LOG_FRESHNESS_MS = 6 * 60 * 60 * 1000;
export const OPTIMIZER_LOG_RECORD_TYPE = "intervention_optimizer_diagnostic";

// ── Intervention schema ───────────────────────────────────────────────────────

/**
 * Canonical Intervention schema: required field names and type constraints.
 * Used by validateIntervention for deterministic, machine-checkable validation.
 */
export const INTERVENTION_SCHEMA = Object.freeze({
  required: Object.freeze([
    "id", "type", "wave", "role", "title",
    "successProbability", "impact", "riskCost",
    "sampleCount", "budgetCost",
  ]),
  typeEnum: Object.freeze(Object.values(INTERVENTION_TYPE)),
});

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validate a single Intervention object against INTERVENTION_SCHEMA.
 *
 * Distinguishes missing input from invalid input:
 *   null/undefined input  → ok=false, code=MISSING_INPUT
 *   non-object input      → ok=false, code=INVALID_TYPE
 *   absent required field → ok=false, code=MISSING_FIELD, field=<name>
 *   invalid field value   → ok=false, code=INVALID_FIELD, field=<name>
 *   fully valid           → ok=true,  code=null
 *
 * @param {any} intervention
 * @returns {{ ok: boolean, code: string|null, field?: string, message: string }}
 */
export function validateIntervention(intervention) {
  if (intervention === null || intervention === undefined) {
    return {
      ok: false,
      code: INTERVENTION_ERROR_CODE.MISSING_INPUT,
      message: "intervention is required (got null/undefined)",
    };
  }
  if (typeof intervention !== "object" || Array.isArray(intervention)) {
    return {
      ok: false,
      code: INTERVENTION_ERROR_CODE.INVALID_TYPE,
      message: "intervention must be a plain object",
    };
  }

  // Required field presence check
  for (const field of INTERVENTION_SCHEMA.required) {
    if (!(field in intervention)) {
      return {
        ok: false,
        code: INTERVENTION_ERROR_CODE.MISSING_FIELD,
        field,
        message: `required field '${field}' is missing`,
      };
    }
  }

  // type: must be one of INTERVENTION_TYPE values
  if (!INTERVENTION_SCHEMA.typeEnum.includes(intervention.type)) {
    return {
      ok: false,
      code: INTERVENTION_ERROR_CODE.INVALID_FIELD,
      field: "type",
      message: `type must be one of: ${INTERVENTION_SCHEMA.typeEnum.join(", ")}; got '${intervention.type}'`,
    };
  }

  // wave: must be a positive integer
  if (!Number.isInteger(intervention.wave) || intervention.wave < 1) {
    return {
      ok: false,
      code: INTERVENTION_ERROR_CODE.INVALID_FIELD,
      field: "wave",
      message: `wave must be a positive integer; got ${intervention.wave}`,
    };
  }

  // id, role, title: must be non-empty strings
  for (const field of ["id", "role", "title"]) {
    if (typeof intervention[field] !== "string" || intervention[field].trim() === "") {
      return {
        ok: false,
        code: INTERVENTION_ERROR_CODE.INVALID_FIELD,
        field,
        message: `${field} must be a non-empty string`,
      };
    }
  }

  // successProbability, impact, riskCost: numbers in [0.0, 1.0]
  for (const field of ["successProbability", "impact", "riskCost"]) {
    const v = intervention[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
      return {
        ok: false,
        code: INTERVENTION_ERROR_CODE.INVALID_FIELD,
        field,
        message: `${field} must be a finite number between 0.0 and 1.0; got ${v}`,
      };
    }
  }

  // sampleCount: non-negative integer
  if (!Number.isInteger(intervention.sampleCount) || intervention.sampleCount < 0) {
    return {
      ok: false,
      code: INTERVENTION_ERROR_CODE.INVALID_FIELD,
      field: "sampleCount",
      message: `sampleCount must be a non-negative integer; got ${intervention.sampleCount}`,
    };
  }

  // budgetCost: positive integer (>= 1)
  if (!Number.isInteger(intervention.budgetCost) || intervention.budgetCost < 1) {
    return {
      ok: false,
      code: INTERVENTION_ERROR_CODE.INVALID_FIELD,
      field: "budgetCost",
      message: `budgetCost must be a positive integer (>= 1); got ${intervention.budgetCost}`,
    };
  }

  return { ok: true, code: null, message: "valid" };
}

/**
 * Validate a Budget object.
 *
 * Distinguishes missing input from invalid input:
 *   null/undefined         → ok=false, code=MISSING_INPUT
 *   invalid maxWorkerSpawns → ok=false, code=INVALID_FIELD
 *   fully valid            → ok=true,  code=null
 *
 * @param {any} budget
 * @returns {{ ok: boolean, code: string|null, field?: string, message: string }}
 */
export function validateBudget(budget) {
  if (budget === null || budget === undefined) {
    return {
      ok: false,
      code: INTERVENTION_ERROR_CODE.MISSING_INPUT,
      message: "budget is required (got null/undefined)",
    };
  }
  if (typeof budget !== "object" || Array.isArray(budget)) {
    return {
      ok: false,
      code: INTERVENTION_ERROR_CODE.INVALID_TYPE,
      message: "budget must be a plain object",
    };
  }

  // maxWorkerSpawns: required positive integer
  if (!("maxWorkerSpawns" in budget)) {
    return {
      ok: false,
      code: INTERVENTION_ERROR_CODE.MISSING_FIELD,
      field: "maxWorkerSpawns",
      message: "required field 'maxWorkerSpawns' is missing",
    };
  }
  if (!Number.isInteger(budget.maxWorkerSpawns) || budget.maxWorkerSpawns < 1) {
    return {
      ok: false,
      code: INTERVENTION_ERROR_CODE.INVALID_FIELD,
      field: "maxWorkerSpawns",
      message: `budget.maxWorkerSpawns must be a positive integer; got ${budget.maxWorkerSpawns}`,
    };
  }

  // maxWorkersPerWave: optional positive integer
  if (budget.maxWorkersPerWave !== undefined) {
    if (!Number.isInteger(budget.maxWorkersPerWave) || budget.maxWorkersPerWave < 1) {
      return {
        ok: false,
        code: INTERVENTION_ERROR_CODE.INVALID_FIELD,
        field: "maxWorkersPerWave",
        message: `budget.maxWorkersPerWave must be a positive integer when provided; got ${budget.maxWorkersPerWave}`,
      };
    }
  }

  // byRole: optional object with positive integer values
  if (budget.byRole !== undefined) {
    if (typeof budget.byRole !== "object" || Array.isArray(budget.byRole)) {
      return {
        ok: false,
        code: INTERVENTION_ERROR_CODE.INVALID_FIELD,
        field: "byRole",
        message: "budget.byRole must be a plain object when provided",
      };
    }
    for (const [role, cap] of Object.entries(budget.byRole) as any[]) {
      if (!Number.isInteger(cap) || cap < 1) {
        return {
          ok: false,
          code: INTERVENTION_ERROR_CODE.INVALID_FIELD,
          field: `byRole.${role}`,
          message: `budget.byRole.${role} must be a positive integer; got ${cap}`,
        };
      }
    }
  }

  return { ok: true, code: null, message: "valid" };
}

// ── Expected-value computation ────────────────────────────────────────────────

/**
 * Compute the confidence multiplier for a given sample count.
 *
 * Formula: min(1.0, sampleCount / SPARSE_DATA_THRESHOLD)
 *   n < SPARSE_DATA_THRESHOLD → fractional multiplier (confidence penalty)
 *   n >= SPARSE_DATA_THRESHOLD → 1.0 (full confidence)
 *
 * @param {number} sampleCount — non-negative integer
 * @returns {number} — multiplier in [0.0, 1.0]
 */
export function computeConfidenceMultiplier(sampleCount) {
  return Math.min(1.0, sampleCount / SPARSE_DATA_THRESHOLD);
}

/**
 * Apply the confidence penalty to a raw successProbability.
 *
 * adjustedSuccessProbability = successProbability × confidenceMultiplier(sampleCount)
 *
 * @param {number} successProbability — raw P(success) in [0.0, 1.0]
 * @param {number} sampleCount — historical observation count (>= 0)
 * @returns {number} — adjusted P(success) in [0.0, 1.0]
 */
export function applyConfidencePenalty(successProbability, sampleCount) {
  return successProbability * computeConfidenceMultiplier(sampleCount);
}

/**
 * Compute the Expected Value (EV) for an Intervention.
 *
 * Formula:
 *   adjustedP = successProbability × confidenceMultiplier(sampleCount)
 *   EV = adjustedP × impact − (1 − adjustedP) × riskCost
 *
 * The EV is not clamped — it may be negative when riskCost is high
 * and/or confidence is low.
 *
 * @param {object} intervention — validated Intervention object
 * @returns {{ adjustedSuccessProbability: number, ev: number }}
 */
export function computeExpectedValue(intervention) {
  const adjustedP = applyConfidencePenalty(
    intervention.successProbability,
    intervention.sampleCount,
  );
  const ev = adjustedP * intervention.impact - (1 - adjustedP) * intervention.riskCost;
  return { adjustedSuccessProbability: adjustedP, ev };
}

const CONTINUATION_STATUS = Object.freeze({
  IMPLEMENTED_CORRECTLY: "implemented_correctly",
  IMPLEMENTED_PARTIALLY: "implemented_partially",
  NOT_IMPLEMENTED: "not_implemented",
  PENDING: "pending",
});

const FAMILY_KEY_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "when", "then", "than", "while",
  "under", "over", "into", "onto", "after", "before", "across", "only", "does", "not", "are",
  "is", "was", "were", "have", "has", "had", "will", "would", "should", "could", "must", "can",
  "your", "their", "them", "they", "each", "same", "keep", "keep", "more", "less", "very",
  "plan", "task", "worker", "route", "routing",
]);

function normalizeContinuationStatus(rawStatus: unknown): string {
  const status = String(rawStatus || CONTINUATION_STATUS.PENDING).toLowerCase().trim();
  if (status === CONTINUATION_STATUS.IMPLEMENTED_CORRECTLY) return status;
  if (status === CONTINUATION_STATUS.IMPLEMENTED_PARTIALLY) return status;
  if (status === CONTINUATION_STATUS.NOT_IMPLEMENTED) return status;
  return CONTINUATION_STATUS.PENDING;
}

function getContinuationStatusScore(rawStatus: unknown): number {
  const status = normalizeContinuationStatus(rawStatus);
  if (status === CONTINUATION_STATUS.IMPLEMENTED_CORRECTLY) return 3;
  if (status === CONTINUATION_STATUS.IMPLEMENTED_PARTIALLY) return 2;
  if (status === CONTINUATION_STATUS.NOT_IMPLEMENTED) return 1;
  return 0;
}

function normalizeFamilySegment(value: unknown): string[] {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4 && !FAMILY_KEY_STOP_WORDS.has(part));
}

function extractFamilyTargetTokens(targetFiles: unknown): string[] {
  if (!Array.isArray(targetFiles)) return [];
  const tokens: string[] = [];
  for (const file of targetFiles) {
    const base = path.basename(String(file || "")).replace(/\.[^.]+$/, "");
    tokens.push(...normalizeFamilySegment(base));
  }
  return Array.from(new Set(tokens)).sort().slice(0, 4);
}

function deriveContinuationFamilyKey(source: any): string {
  const explicitKey = String(
    source?.continuationFamilyKey
      || source?.familyKey
      || source?._familyKey
      || "",
  ).trim();
  if (explicitKey) {
    return explicitKey.toLowerCase();
  }

  const textTokens = Array.from(new Set([
    ...normalizeFamilySegment(source?.scope),
    ...normalizeFamilySegment(source?.title),
    ...normalizeFamilySegment(source?.task),
    ...normalizeFamilySegment(source?.task_id),
  ])).slice(0, 6);
  const fileTokens = extractFamilyTargetTokens(source?.targetFiles ?? source?.target_files);
  const parts = [...fileTokens, ...textTokens].slice(0, 8);
  return parts.join(":");
}

function suppressDuplicateContinuationFamilies(rankedInterventions: any[]) {
  if (!Array.isArray(rankedInterventions) || rankedInterventions.length === 0) {
    return { ranked: [], rejected: [], duplicateFamilySuppressionsApplied: 0 };
  }

  const familyGroups = new Map<string, any[]>();
  for (const intervention of rankedInterventions) {
    const familyKey = deriveContinuationFamilyKey(intervention);
    if (!familyKey) continue;
    const groupKey = `${String(intervention.role || "")}:${familyKey}`;
    const existing = familyGroups.get(groupKey);
    if (existing) existing.push(intervention);
    else familyGroups.set(groupKey, [intervention]);
  }

  const keptIds = new Set<string>();
  const rejectedById = new Map<string, any>();

  for (const [groupKey, group] of familyGroups.entries()) {
    if (group.length < 2) continue;
    const hasContinuationWork = group.some((item) => getContinuationStatusScore(item?.implementationStatus) > 0);
    if (!hasContinuationWork) continue;

    const preferred = [...group].sort((left, right) => {
      const statusDiff = getContinuationStatusScore(right?.implementationStatus) - getContinuationStatusScore(left?.implementationStatus);
      if (statusDiff !== 0) return statusDiff;
      const evDiff = Number(right?.ev ?? 0) - Number(left?.ev ?? 0);
      if (evDiff !== 0) return evDiff;
      const impactDiff = Number(right?.impact ?? 0) - Number(left?.impact ?? 0);
      if (impactDiff !== 0) return impactDiff;
      const waveDiff = Number(left?.wave ?? 0) - Number(right?.wave ?? 0);
      if (waveDiff !== 0) return waveDiff;
      return String(left?.id || "").localeCompare(String(right?.id || ""));
    })[0];

    keptIds.add(String(preferred?.id || groupKey));
    for (const intervention of group) {
      const interventionId = String(intervention?.id || "");
      if (interventionId === String(preferred?.id || "")) continue;
      rejectedById.set(interventionId, {
        ...intervention,
        rejectionReason: `duplicate continuation family suppressed in favor of '${String(preferred?.id || groupKey)}'`,
        reasonCode: INTERVENTION_REJECTION_CODE.DUPLICATE_FAMILY_CONTINUATION,
        duplicateFamilyKey: groupKey,
        preferredInterventionId: String(preferred?.id || groupKey),
      });
    }
  }

  const ranked = rankedInterventions.filter((intervention) => {
    const interventionId = String(intervention?.id || "");
    if (rejectedById.has(interventionId)) return false;
    if (keptIds.size === 0) return true;
    const familyKey = deriveContinuationFamilyKey(intervention);
    if (!familyKey) return true;
    const groupKey = `${String(intervention.role || "")}:${familyKey}`;
    const group = familyGroups.get(groupKey);
    if (!group || group.length < 2) return true;
    const hasContinuationWork = group.some((item) => getContinuationStatusScore(item?.implementationStatus) > 0);
    if (!hasContinuationWork) return true;
    return keptIds.has(interventionId);
  });

  return {
    ranked,
    rejected: Array.from(rejectedById.values()),
    duplicateFamilySuppressionsApplied: rejectedById.size,
  };
}

// ── Ranking ───────────────────────────────────────────────────────────────────

/**
 * Rank a list of interventions by descending Expected Value (EV).
 *
 * Applies confidence penalties and attaches `ev` and
 * `adjustedSuccessProbability` to each ranked entry.
 * Does not mutate the input array.
 *
 * @param {object[]} interventions — array of validated Intervention objects
 * @returns {object[]} — new array sorted by descending EV, each item decorated with ev
 */
export function rankInterventions(interventions) {
  return interventions
    .map((intervention) => {
      const { adjustedSuccessProbability, ev } = computeExpectedValue(intervention);
      return { ...intervention, adjustedSuccessProbability, ev };
    })
    .sort((a, b) => b.ev - a.ev);
}

// ── Budget reconciliation ─────────────────────────────────────────────────────

/**
 * Greedily select interventions by descending EV while respecting all three
 * budget constraints simultaneously.
 *
 * Reconciliation semantics (all three enforced concurrently):
 *   1. total    — running Σ budgetCost of accepted interventions ≤ maxWorkerSpawns
 *   2. by-wave  — per-wave Σ budgetCost ≤ maxWorkersPerWave (defaults to maxWorkerSpawns)
 *   3. by-role  — per-role Σ budgetCost ≤ byRole[role] (only when role is in byRole map)
 *
 * An intervention is accepted only if it satisfies ALL active constraints.
 * Rejected interventions are annotated with a machine-readable `reasonCode`.
 *
 * @param {object[]} ranked — EV-ranked interventions (output of rankInterventions)
 * @param {object} budget   — validated Budget object
 * @returns {object} — reconciliation result with selected/rejected arrays and usage tallies
 */
export function reconcileBudgets(ranked, budget) {
  const maxTotal    = budget.maxWorkerSpawns;
  const maxPerWave  = budget.maxWorkersPerWave ?? maxTotal;
  const byRoleLimits = budget.byRole ?? {};

  let totalUsed = 0;
  const byWaveUsed: Record<string, any> = {};
  const byRoleUsed: Record<string, any> = {};
  const selected    = [];
  const rejected    = [];

  for (const intervention of ranked) {
    const waveKey = String(intervention.wave);
    const role    = intervention.role;
    const cost    = intervention.budgetCost;

    // Constraint 1: total budget
    if (totalUsed + cost > maxTotal) {
      rejected.push({
        ...intervention,
        rejectionReason: `total budget exceeded (used=${totalUsed}, cost=${cost}, limit=${maxTotal})`,
        reasonCode: INTERVENTION_REJECTION_CODE.BUDGET_TOTAL,
      });
      continue;
    }

    // Constraint 2: per-wave budget
    const waveUsed = byWaveUsed[waveKey] ?? 0;
    if (waveUsed + cost > maxPerWave) {
      rejected.push({
        ...intervention,
        rejectionReason: `wave ${waveKey} budget exceeded (waveUsed=${waveUsed}, cost=${cost}, limit=${maxPerWave})`,
        reasonCode: INTERVENTION_REJECTION_CODE.BUDGET_WAVE,
      });
      continue;
    }

    // Constraint 3: per-role budget (only when configured)
    if (byRoleLimits[role] !== undefined) {
      const roleUsed = byRoleUsed[role] ?? 0;
      if (roleUsed + cost > byRoleLimits[role]) {
        rejected.push({
          ...intervention,
          rejectionReason: `role '${role}' budget exceeded (roleUsed=${roleUsed}, cost=${cost}, limit=${byRoleLimits[role]})`,
          reasonCode: INTERVENTION_REJECTION_CODE.BUDGET_ROLE,
        });
        continue;
      }
    }

    // Accept
    selected.push(intervention);
    totalUsed             += cost;
    byWaveUsed[waveKey]    = (byWaveUsed[waveKey] ?? 0) + cost;
    byRoleUsed[role]       = (byRoleUsed[role] ?? 0) + cost;
  }

  // Derive top-level status and reason code from the first rejection type found
  let status: any     = OPTIMIZER_STATUS.OK;
  let reasonCode: any = OPTIMIZER_REASON_CODE.VALID;

  if (rejected.length > 0) {
    status = OPTIMIZER_STATUS.BUDGET_EXCEEDED;
    const firstCode = rejected[0].reasonCode;
    if (firstCode === INTERVENTION_REJECTION_CODE.BUDGET_TOTAL) {
      reasonCode = OPTIMIZER_REASON_CODE.BUDGET_TOTAL_EXCEEDED;
    } else if (firstCode === INTERVENTION_REJECTION_CODE.BUDGET_WAVE) {
      reasonCode = OPTIMIZER_REASON_CODE.BUDGET_WAVE_EXCEEDED;
    } else {
      reasonCode = OPTIMIZER_REASON_CODE.BUDGET_ROLE_EXCEEDED;
    }
  }

  return {
    status,
    reasonCode,
    totalBudgetUsed:     totalUsed,
    totalBudgetLimit:    maxTotal,
    byWaveBudgetLimit:   maxPerWave,
    byWaveUsed,
    byRoleBudgetLimits:  { ...byRoleLimits },
    byRoleUsed,
    selected,
    rejected,
  };
}

// ── Main optimizer entry point ────────────────────────────────────────────────

/**
 * Run the budget-aware intervention optimizer.
 *
 * Steps:
 *   1. Validate budget (missing vs invalid — explicit reason codes)
 *   2. Validate interventions array (must be non-null array)
 *   3. Validate each individual intervention against INTERVENTION_SCHEMA
 *   4. Apply failure classifications to successProbability (AC #5 — intervention prioritisation)
 *   5. Rank interventions by descending Expected Value (with confidence penalties)
 *   6. Greedily reconcile budgets (total, by-wave, by-role simultaneously)
 *   7. Return structured result with full selection rationale
 *
 * AC #5 / Athena missing item #2 — failure classification integration:
 *   When options.failureClassifications is provided as an object keyed by role name,
 *   each intervention's successProbability is adjusted before ranking via
 *   applyClassificationToSuccessProbability().  This is the observable behavioral
 *   change that "feeds intervention prioritization": interventions for roles with
 *   prior failures receive lower EV scores and are ranked lower (or rejected first
 *   under budget pressure).
 *
 *   options.failureClassifications: { [role: string]: ClassificationResult }
 *
 * No silent fallbacks. All failure modes set an explicit `status` and `reasonCode`.
 *
 * @param {any[]} interventions — array of Intervention objects to evaluate
 * @param {object} budget       — Budget object (must include maxWorkerSpawns)
 * @param {object} [options]    — optional settings
 *   @param {object} [options.failureClassifications] — { [role]: ClassificationResult }
 * @returns {object}            — optimizer result conforming to OPTIMIZER_RESULT_SCHEMA
 */
export function runInterventionOptimizer(interventions, budget, options: any = {}) {
  const generatedAt = new Date().toISOString();

  // Validate budget first (fail fast on missing/invalid budget)
  const budgetValidation = validateBudget(budget);
  if (!budgetValidation.ok) {
    return {
      schemaVersion:       OPTIMIZER_LOG_SCHEMA_VERSION,
      generatedAt,
      status:              OPTIMIZER_STATUS.INVALID_INPUT,
      reasonCode:          OPTIMIZER_REASON_CODE.INVALID_BUDGET,
      errorMessage:        budgetValidation.message,
      invalidField:        budgetValidation.field ?? null,
      budgetUnit:          BUDGET_UNIT,
      totalBudgetLimit:    0,
      totalBudgetUsed:     0,
      byWaveBudgetLimit:   0,
      byWaveUsed:          {},
      byRoleBudgetLimits:  {},
      byRoleUsed:          {},
      selected:            [],
      rejected:            [],
    };
  }

  const maxTotal  = budget.maxWorkerSpawns;
  const maxWave   = budget.maxWorkersPerWave ?? maxTotal;
  const byRoleLimits = budget.byRole ?? {};

  // Validate interventions array (missing vs invalid distinction)
  if (interventions === null || interventions === undefined) {
    return {
      schemaVersion:       OPTIMIZER_LOG_SCHEMA_VERSION,
      generatedAt,
      status:              OPTIMIZER_STATUS.INVALID_INPUT,
      reasonCode:          OPTIMIZER_REASON_CODE.MISSING_INPUT,
      errorMessage:        "interventions is required (got null/undefined)",
      invalidField:        null,
      budgetUnit:          BUDGET_UNIT,
      totalBudgetLimit:    maxTotal,
      totalBudgetUsed:     0,
      byWaveBudgetLimit:   maxWave,
      byWaveUsed:          {},
      byRoleBudgetLimits:  { ...byRoleLimits },
      byRoleUsed:          {},
      selected:            [],
      rejected:            [],
    };
  }

  if (!Array.isArray(interventions)) {
    return {
      schemaVersion:       OPTIMIZER_LOG_SCHEMA_VERSION,
      generatedAt,
      status:              OPTIMIZER_STATUS.INVALID_INPUT,
      reasonCode:          OPTIMIZER_REASON_CODE.MISSING_INPUT,
      errorMessage:        "interventions must be an array",
      invalidField:        null,
      budgetUnit:          BUDGET_UNIT,
      totalBudgetLimit:    maxTotal,
      totalBudgetUsed:     0,
      byWaveBudgetLimit:   maxWave,
      byWaveUsed:          {},
      byRoleBudgetLimits:  { ...byRoleLimits },
      byRoleUsed:          {},
      selected:            [],
      rejected:            [],
    };
  }

  // Empty array is valid input (distinct from missing/invalid)
  if (interventions.length === 0) {
    return {
      schemaVersion:       OPTIMIZER_LOG_SCHEMA_VERSION,
      generatedAt,
      status:              OPTIMIZER_STATUS.EMPTY_INPUT,
      reasonCode:          OPTIMIZER_REASON_CODE.EMPTY_INPUT,
      errorMessage:        "no interventions provided",
      budgetUnit:          BUDGET_UNIT,
      totalBudgetLimit:    maxTotal,
      totalBudgetUsed:     0,
      byWaveBudgetLimit:   maxWave,
      byWaveUsed:          {},
      byRoleBudgetLimits:  { ...byRoleLimits },
      byRoleUsed:          {},
      selected:            [],
      rejected:            [],
    };
  }

  // Validate each intervention — fail fast on first invalid (gives index + field)
  for (let i = 0; i < interventions.length; i++) {
    const vr = validateIntervention(interventions[i]);
    if (!vr.ok) {
      return {
        schemaVersion:       OPTIMIZER_LOG_SCHEMA_VERSION,
        generatedAt,
        status:              OPTIMIZER_STATUS.INVALID_INPUT,
        reasonCode:          OPTIMIZER_REASON_CODE.INVALID_INTERVENTION,
        errorMessage:        `interventions[${i}]: ${vr.message}`,
        invalidField:        vr.field ?? null,
        budgetUnit:          BUDGET_UNIT,
        totalBudgetLimit:    maxTotal,
        totalBudgetUsed:     0,
        byWaveBudgetLimit:   maxWave,
        byWaveUsed:          {},
        byRoleBudgetLimits:  { ...byRoleLimits },
        byRoleUsed:          {},
        selected:            [],
        rejected:            [],
      };
    }
  }

  // Apply failure classifications to successProbability before ranking (AC #5)
  // failureClassifications: { [role: string]: ClassificationResult }
  // Observable change: adjusted interventions are ranked lower under budget pressure.
  const failureClassifications = options?.failureClassifications;
  const policyImpactByInterventionId = options?.policyImpactByInterventionId;
  const benchmarkTelemetry: any[] = Array.isArray(options?.benchmarkTelemetry) ? options.benchmarkTelemetry : [];
  let failureClassificationsApplied = 0;
  let policyImpactPenaltiesApplied = 0;
  let benchmarkBoostsApplied = 0;
  let adjustedInterventions = interventions;

  if (failureClassifications && typeof failureClassifications === "object" && !Array.isArray(failureClassifications)) {
    adjustedInterventions = interventions.map((intervention) => {
      const normalizedRole = normalizeRoleKey(String(intervention.role || ""));
      const classification = failureClassifications[normalizedRole];
      if (!classification) return intervention;
      const adjustedSP = applyClassificationToSuccessProbability(intervention.successProbability, classification);
      if (adjustedSP === intervention.successProbability) return intervention;
      failureClassificationsApplied += 1;
      return { ...intervention, successProbability: adjustedSP };
    });
  }

  if (policyImpactByInterventionId && typeof policyImpactByInterventionId === "object" && !Array.isArray(policyImpactByInterventionId)) {
    adjustedInterventions = adjustedInterventions.map((intervention) => {
      const entry = policyImpactByInterventionId[String(intervention.id || "")];
      if (!entry || typeof entry !== "object") return intervention;
      const decayedEffectiveness = Number(entry.decayedEffectiveness);
      if (!Number.isFinite(decayedEffectiveness)) return intervention;
      const bounded = Math.max(0, Math.min(1, decayedEffectiveness));
      const adjustedSP = Math.round((intervention.successProbability * bounded) * 1000) / 1000;
      if (adjustedSP === intervention.successProbability) return intervention;
      policyImpactPenaltiesApplied += 1;
      return { ...intervention, successProbability: adjustedSP };
    });
  }

  // ── Benchmark telemetry signal: adjust impact multiplier based on observed yield ─
  // benchmarkTelemetry entries: { interventionId, observedSuccessRate, sampleCount }
  // Observed success rates above 0.5 boost impact; below 0.5 reduce it.
  // This aligns ranking with measured ROI rather than static estimates.
  if (benchmarkTelemetry.length > 0) {
    const benchmarkByInterventionId = new Map<string, { observedSuccessRate: number; sampleCount: number }>();
    for (const entry of benchmarkTelemetry) {
      const id = String(entry?.interventionId || entry?.id || "");
      const rate = Number(entry?.observedSuccessRate ?? entry?.successRate);
      const count = Number(entry?.sampleCount ?? entry?.count ?? 0);
      if (id && Number.isFinite(rate) && rate >= 0 && rate <= 1) {
        benchmarkByInterventionId.set(id, { observedSuccessRate: rate, sampleCount: count });
      }
    }
    if (benchmarkByInterventionId.size > 0) {
      adjustedInterventions = adjustedInterventions.map((intervention) => {
        const signal = benchmarkByInterventionId.get(String(intervention.id || ""));
        if (!signal) return intervention;
        // Only use signal if backed by at least 1 observation
        if (signal.sampleCount < 1) return intervention;
        // Blend observed rate with estimated successProbability (60% weight on observed)
        const blended = Math.round(
          (signal.observedSuccessRate * 0.6 + intervention.successProbability * 0.4) * 1000
        ) / 1000;
        if (blended === intervention.successProbability) return intervention;
        benchmarkBoostsApplied += 1;
        return { ...intervention, successProbability: blended, _benchmarkAdjusted: true };
      });
    }
  }

  // ── Reroute history EV penalty (Task 2) ──────────────────────────────────
  // Apply bounded EV penalties to interventions whose role was repeatedly rerouted
  // in the previous cycle.  Repeated high-cost reroutes are a signal that the lane
  // is underperforming; reducing EV for that role shifts budget to healthier lanes.
  const rerouteReasons: Array<{ role: string; reasonCode: string }> = Array.isArray(options?.rerouteReasons)
    ? options.rerouteReasons
    : [];
  let rerouteCostPenaltiesApplied = 0;
  if (rerouteReasons.length > 0) {
    adjustedInterventions = adjustedInterventions.map((intervention) => {
      const adjustedEV = applyRerouteCostPenalty(
        computeExpectedValue(intervention).ev,
        String(intervention.role || ""),
        rerouteReasons,
      );
      const baseEV = computeExpectedValue(intervention).ev;
      if (adjustedEV === baseEV) return intervention;
      // Store adjusted successProbability that would produce the target EV
      // (approximation: scale successProbability by the EV ratio)
      const evRatio = baseEV !== 0 ? adjustedEV / baseEV : 1;
      const adjustedSP = Math.max(0, Math.min(1,
        Math.round((intervention.successProbability * evRatio) * 1000) / 1000,
      ));
      rerouteCostPenaltiesApplied += 1;
      return { ...intervention, successProbability: adjustedSP, _reroutePenaltyApplied: true };
    });
  }

  // ── Anti-overbundle EV penalty ───────────────────────────────────────────
  // options.overbundleStepCounts: { [interventionId: string]: number }
  // When an intervention's batch has too many ordered steps, reduce its EV to
  // favour splitting over dispatching an over-bundled packet.
  const overbundleStepCounts = options?.overbundleStepCounts;
  let overbundlePenaltiesApplied = 0;
  if (overbundleStepCounts && typeof overbundleStepCounts === "object" && !Array.isArray(overbundleStepCounts)) {
    adjustedInterventions = adjustedInterventions.map((intervention) => {
      const stepCount = Number(overbundleStepCounts[String(intervention.id || "")] ?? 0);
      if (!stepCount) return intervention;
      const currentEV = computeExpectedValue(intervention).ev;
      const adjustedEV = applyOverbundleEVPenalty(currentEV, stepCount);
      if (adjustedEV === currentEV) return intervention;
      // Back-calculate adjusted successProbability that approximates target EV
      const evRatio = currentEV !== 0 ? adjustedEV / currentEV : 1;
      const adjustedSP = Math.max(0, Math.min(1,
        Math.round((intervention.successProbability * evRatio) * 1000) / 1000,
      ));
      overbundlePenaltiesApplied += 1;
      return { ...intervention, successProbability: adjustedSP, _overbundlePenaltyApplied: true };
    });
  }

  // Rank by descending EV (with confidence penalties applied)
  const ranked = rankInterventions(adjustedInterventions);
  const continuationSuppression = suppressDuplicateContinuationFamilies(ranked);

  // Reconcile all three budget constraints simultaneously
  const reconciled = reconcileBudgets(continuationSuppression.ranked, budget);
  const mergedRejected = [
    ...continuationSuppression.rejected,
    ...reconciled.rejected,
  ];

  // Capture optional specializationContext passed by the orchestrator so the
  // persisted log records the active workerPool specialization policy for
  // alignment diagnostics between scoreboard, gate, and optimizer telemetry.
  const specializationContext = options?.specializationContext ?? null;

  return {
    schemaVersion:  OPTIMIZER_LOG_SCHEMA_VERSION,
    generatedAt,
    budgetUnit:     BUDGET_UNIT,
    failureClassificationsApplied,
    policyImpactPenaltiesApplied,
    benchmarkTelemetryCount: benchmarkTelemetry.length,
    benchmarkBoostsApplied,
    duplicateFamilySuppressionsApplied: continuationSuppression.duplicateFamilySuppressionsApplied,
    rerouteCostPenaltiesApplied,
    overbundlePenaltiesApplied,
    ...(specializationContext !== null ? { specializationContext } : {}),
    ...reconciled,
    rejected: mergedRejected,
  };
}

export function buildPolicyImpactByInterventionId(
  plans: any[],
  learnedPolicies: any[],
): Record<string, { policyId: string; decayedEffectiveness: number; inactiveCycles: number }> {
  if (!Array.isArray(plans) || plans.length === 0 || !Array.isArray(learnedPolicies) || learnedPolicies.length === 0) {
    return {};
  }
  const policyImpactMap: Record<string, { policyId: string; decayedEffectiveness: number; inactiveCycles: number }> = {};
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    const planId = String(plan?.intervention_id || plan?.id || plan?.task_id || `plan-${i + 1}`);
    const taskText = `${String(plan?.task || "")} ${String(plan?.title || "")} ${String(plan?.scope || "")}`.toLowerCase();
    let matched: any = null;
    for (const policy of learnedPolicies) {
      const policyId = String(policy?.id || "").toLowerCase();
      if (!policyId) continue;
      const policySignal = String(policy?.sourceLesson || policy?.assertion || "").toLowerCase();
      if (
        (policySignal && (taskText.includes(policySignal.slice(0, 30)) || policySignal.includes(taskText.slice(0, 30)))) ||
        (policyId && taskText.includes(policyId.replace(/-/g, " ")))
      ) {
        matched = policy;
        break;
      }
    }
    if (!matched) continue;
    const decayedEffectiveness = Number.isFinite(Number(matched?._decayedEffectiveness))
      ? Number(matched._decayedEffectiveness)
      : 1;
    const inactiveCycles = Number.isFinite(Number(matched?._inactiveCycles))
      ? Number(matched._inactiveCycles)
      : 0;
    policyImpactMap[planId] = {
      policyId: String(matched?.id || ""),
      decayedEffectiveness: Math.max(0, Math.min(1, decayedEffectiveness)),
      inactiveCycles,
    };
  }
  return policyImpactMap;
}

function normalizeOutcomeScoreSignal(rawOutcome: unknown): number {
  if (Number.isFinite(Number(rawOutcome))) {
    return Math.max(0, Math.min(1, Number(rawOutcome)));
  }
  if (!rawOutcome || typeof rawOutcome !== "object") return 0;
  const row = rawOutcome as Record<string, unknown>;
  const explicit = Number(row.outcomeScore);
  if (Number.isFinite(explicit)) {
    return Math.max(0, Math.min(1, explicit));
  }
  const metrics = [
    Number(row.precisionOnAttempted),
    Number(row.attemptRate),
    Number.isFinite(Number(row.abstainRate)) ? 1 - Number(row.abstainRate) : null,
    Number(row.laneReliability),
  ].filter((value) => Number.isFinite(value));
  const hardChainSampleCount = Number(row.hardChainSampleCount ?? 0);
  const hardChainSuccessRate = Number(row.hardChainSuccessRate);
  if (hardChainSampleCount > 0 && Number.isFinite(hardChainSuccessRate)) {
    metrics.push(hardChainSuccessRate);
  }
  if (metrics.length === 0) return 0;
  return Math.max(0, Math.min(1, Math.round((metrics.reduce((sum, value) => sum + value, 0) / metrics.length) * 1000) / 1000));
}

function normalizeOutcomeEnvelope(
  rawOutcome: unknown,
): {
  outcomeScore: number;
  noSignalOutcome: boolean;
  outcomeStatus: string;
  decisionMode: string | null;
  closureMode: string | null;
} {
  const outcomeScore = normalizeOutcomeScoreSignal(rawOutcome);
  const row = rawOutcome && typeof rawOutcome === "object" ? rawOutcome as Record<string, unknown> : {};
  const closureMode = row.closureMode ? String(row.closureMode).trim().toLowerCase() : null;
  const decisionMode = row.decisionMode ? String(row.decisionMode).trim() : null;
  const explicitStatus = String(row.outcomeStatus || "").trim().toLowerCase();
  const noSignalOutcome = row.noSignalOutcome === true || closureMode === "no_signal" || explicitStatus === IMPACT_ATTRIBUTION_OUTCOME.NO_SIGNAL;
  const outcomeStatus = explicitStatus
    || (noSignalOutcome
      ? IMPACT_ATTRIBUTION_OUTCOME.NO_SIGNAL
      : outcomeScore >= 0.55
        ? IMPACT_ATTRIBUTION_OUTCOME.IMPROVED
        : "");
  return {
    outcomeScore,
    noSignalOutcome,
    outcomeStatus,
    decisionMode,
    closureMode,
  };
}

export function scoreInterventionsAgainstRubric(
  interventions: any[],
  rubricByInterventionId: Record<string, Record<string, number>>,
  opts: {
    outcomeByInterventionId?: Record<string, number | Record<string, unknown>>;
    cycleId?: string;
    policyByInterventionId?: Record<string, string>;
  } = {},
): Array<{
  interventionId: string;
  cycleId: string;
    policyId: string;
    dimensionScores: Record<string, number>;
    rubricScore: number;
    outcomeScore: number;
    combinedScore: number;
    scoredAt: string;
    outcomeStatus: string;
    noSignalOutcome: boolean;
    decisionMode: string | null;
    closureMode: string | null;
  }> {
  if (!Array.isArray(interventions) || interventions.length === 0) return [];
  const cycleId = String(opts.cycleId || new Date().toISOString());
  const outcomeByInterventionId = opts.outcomeByInterventionId && typeof opts.outcomeByInterventionId === "object"
    ? opts.outcomeByInterventionId
    : {};
  const policyByInterventionId = opts.policyByInterventionId && typeof opts.policyByInterventionId === "object"
    ? opts.policyByInterventionId
    : {};
  const rows: Array<{
    interventionId: string;
    cycleId: string;
    policyId: string;
    dimensionScores: Record<string, number>;
    rubricScore: number;
    outcomeScore: number;
    combinedScore: number;
    scoredAt: string;
    outcomeStatus: string;
    noSignalOutcome: boolean;
    decisionMode: string | null;
    closureMode: string | null;
  }> = [];
  for (let i = 0; i < interventions.length; i++) {
    const intervention = interventions[i];
    const interventionId = String(intervention?.id || `intervention-${i + 1}`);
    const policyId = String(policyByInterventionId[interventionId] || "");
    if (!policyId) continue;
    const dimensions = rubricByInterventionId && typeof rubricByInterventionId === "object"
      ? (rubricByInterventionId[interventionId] || {})
      : {};
    const values = Object.values(dimensions).map((v) => Number(v)).filter((v) => Number.isFinite(v));
    const rubricScore = values.length > 0
      ? Math.round(((values.reduce((sum, value) => sum + Math.max(0, Math.min(1, value)), 0) / values.length)) * 1000) / 1000
      : 0;
    const outcomeEnvelope = normalizeOutcomeEnvelope(outcomeByInterventionId[interventionId]);
    const outcomeScore = outcomeEnvelope.outcomeScore;
    const combinedScore = Math.round(((rubricScore * 0.6) + (outcomeScore * 0.4)) * 1000) / 1000;
    rows.push({
      interventionId,
      cycleId,
      policyId,
      dimensionScores: dimensions,
      rubricScore,
      outcomeScore,
      combinedScore,
      scoredAt: new Date().toISOString(),
      outcomeStatus: outcomeEnvelope.outcomeStatus,
      noSignalOutcome: outcomeEnvelope.noSignalOutcome,
      decisionMode: outcomeEnvelope.decisionMode,
      closureMode: outcomeEnvelope.closureMode,
    });
  }
  return rows;
}

function classifyInterventionAccountingCategory(
  intervention: any,
  opts: {
    retryInterventionIds?: string[];
    decisionModeByInterventionId?: Record<string, string>;
  } = {},
): string {
  const interventionId = String(intervention?.id || "");
  const retryIds = new Set(
    Array.isArray(opts.retryInterventionIds)
      ? opts.retryInterventionIds.map((value) => String(value || ""))
      : [],
  );
  const decisionMode = String(opts.decisionModeByInterventionId?.[interventionId] || "").trim().toLowerCase();
  const title = `${String(intervention?.title || "")} ${String(intervention?.task || "")}`.toLowerCase();
  if (
    retryIds.has(interventionId)
    || String(intervention?.type || "") === INTERVENTION_TYPE.FOLLOWUP
    || decisionMode.includes("retry")
    || title.includes("retry")
  ) {
    return INTERVENTION_ACCOUNTING_CATEGORY.RETRY;
  }
  return INTERVENTION_ACCOUNTING_CATEGORY.PLANNING;
}

export function buildInterventionImpactAttributionRecords(
  interventions: any[],
  rubricByInterventionId: Record<string, Record<string, number>>,
  opts: {
    outcomeByInterventionId?: Record<string, number | Record<string, unknown>>;
    cycleId?: string;
    policyByInterventionId?: Record<string, string>;
    lineageByInterventionId?: Record<string, string>;
    history?: any[];
    evidenceWindowCycles?: number;
    minCombinedScore?: number;
    retireThreshold?: number;
    retryInterventionIds?: string[];
  } = {},
): Array<{
  interventionId: string;
  cycleId: string;
  policyId: string | null;
  lineageId: string | null;
  interventionCategory: string;
  rubricScore: number;
  outcomeScore: number;
  combinedScore: number;
  outcomeStatus: string;
  noSignalOutcome: boolean;
  evidenceCount: number;
  improvedCount: number;
  noSignalCount: number;
  ineffectiveCount: number;
  averageOutcomeScore: number;
  shouldRetire: boolean;
  reversible: boolean;
  retirementReason: string;
  reactivateWhen: string;
  decisionMode: string | null;
  closureMode: string | null;
}> {
  if (!Array.isArray(interventions) || interventions.length === 0) return [];
  const scoredRows = scoreInterventionsAgainstRubric(interventions, rubricByInterventionId, opts);
  const interventionById = new Map(interventions.map((intervention) => [String(intervention?.id || ""), intervention]));
  const history = Array.isArray(opts.history) ? opts.history : [];
  const evidenceWindowCycles = Math.max(1, Math.floor(Number(opts.evidenceWindowCycles) || 3));
  const minCombinedScore = Number.isFinite(Number(opts.minCombinedScore)) ? Number(opts.minCombinedScore) : 0.55;
  const retireThreshold = Number.isFinite(Number(opts.retireThreshold)) ? Number(opts.retireThreshold) : 0.25;

  return scoredRows.map((row) => {
    const intervention = interventionById.get(String(row.interventionId || ""));
    const lineageId = String(
      opts.lineageByInterventionId?.[row.interventionId]
      || intervention?.lineageId
      || intervention?.lineage?.lineageId
      || "",
    ).trim() || null;
    const relevantHistory = history.filter((entry) => {
      if (String(entry?.interventionId || "") === row.interventionId) return true;
      return Boolean(lineageId) && String(entry?.lineageId || "").trim() === lineageId;
    });
    const summary = summarizeImpactAttributionWindow(
      [
        ...relevantHistory.map((entry) => ({
          outcomeScore: entry?.outcomeScore,
          noSignalOutcome: entry?.noSignalOutcome,
          outcomeStatus: entry?.outcomeStatus || entry?.closureMode || entry?.decision,
        })),
        {
          outcomeScore: row.outcomeScore,
          noSignalOutcome: row.noSignalOutcome,
          outcomeStatus: row.outcomeStatus,
        },
      ],
      {
        minEvidenceWindow: evidenceWindowCycles,
        improvedThreshold: minCombinedScore,
        retireThreshold,
        reactivationEvidenceWindow: Math.min(2, evidenceWindowCycles),
      },
    );
    return {
      interventionId: row.interventionId,
      cycleId: row.cycleId,
      policyId: row.policyId || null,
      lineageId,
      interventionCategory: classifyInterventionAccountingCategory(intervention, {
        retryInterventionIds: opts.retryInterventionIds,
        decisionModeByInterventionId: row.decisionMode ? { [row.interventionId]: row.decisionMode } : {},
      }),
      rubricScore: row.rubricScore,
      outcomeScore: row.outcomeScore,
      combinedScore: row.combinedScore,
      outcomeStatus: summary.outcomeStatus,
      noSignalOutcome: row.noSignalOutcome,
      evidenceCount: summary.evidenceCount,
      improvedCount: summary.improvedCount,
      noSignalCount: summary.noSignalCount,
      ineffectiveCount: summary.ineffectiveCount,
      averageOutcomeScore: summary.averageOutcomeScore,
      shouldRetire: summary.shouldRetire,
      reversible: summary.reversible,
      retirementReason: summary.retirementReason,
      reactivateWhen: summary.reactivateWhen,
      decisionMode: row.decisionMode,
      closureMode: row.closureMode,
    };
  });
}

// ── Prometheus plan → Intervention adapter ────────────────────────────────────

/**
 * Convert a Prometheus plan array into Intervention objects.
 *
 * Prometheus plans carry strategic metadata but not historical performance data.
 * This adapter applies configurable defaults for the probability/impact/cost fields.
 * sampleCount defaults to SPARSE_DATA_THRESHOLD (full confidence baseline) so that
 * newly planned interventions are ranked by their relative impact/priority rather
 * than being penalized for zero historical data. Override via config if needed.
 *
 * Wave parsing: Prometheus uses string wave ids ("wave-1", "wave-2", etc.).
 * The numeric wave is extracted from the trailing integer; defaults to 1 if unparseable.
 *
 * @param {object[]} plans   — Prometheus plans array (from prometheus_analysis.json)
 * @param {object}   config  — box.config.json config object
 * @returns {object[]}       — array of Intervention objects ready for the optimizer
 */
export function buildInterventionsFromPlan(plans, config) {
  if (!Array.isArray(plans) || plans.length === 0) return [];

  const opts = config?.interventionOptimizer ?? {};
  const defaultSuccessP   = Number(opts.defaultSuccessProbability ?? 0.8);
  const _defaultImpact    = Number(opts.defaultImpact ?? 0.7); // impact is derived from plan priority instead
  const defaultRiskCost   = Number(opts.defaultRiskCost ?? 0.3);
  const defaultSampleCount = Number.isInteger(opts.defaultSampleCount)
    ? opts.defaultSampleCount
    : SPARSE_DATA_THRESHOLD;

  return plans.map((plan, index) => {
    // Parse wave number from "wave-1", "wave-2", etc.
    const waveStr  = String(plan?.wave ?? "wave-1");
    const waveMatch = waveStr.match(/(\d+)/);
    const wave     = waveMatch ? Math.max(1, parseInt(waveMatch[1], 10)) : 1;

    // Derive impact from priority (1–10 → 0.1–1.0)
    const rawPriority = Number(plan?.priority ?? 5);
    const impact = Math.min(1.0, Math.max(0.1, rawPriority / 10));
    const familyKey = deriveContinuationFamilyKey(plan);

    return {
      id:                  String(plan?.id ?? `plan-${index + 1}`),
      type:                INTERVENTION_TYPE.TASK,
      wave,
      role:                normalizePlanRoleToWorkerName(plan?.role),
      title:               String(plan?.task ?? plan?.title ?? `task-${index + 1}`).trim() || `task-${index + 1}`,
      successProbability:  defaultSuccessP,
      impact,
      riskCost:            defaultRiskCost,
      sampleCount:         defaultSampleCount,
      budgetCost:          1,
      task:                String(plan?.task ?? plan?.title ?? `task-${index + 1}`),
      task_id:             String(plan?.task_id ?? plan?.intervention_id ?? ""),
      scope:               String(plan?.scope ?? ""),
      implementationStatus: normalizeContinuationStatus(plan?.implementationStatus),
      targetFiles:         Array.isArray(plan?.targetFiles)
        ? plan.targetFiles
        : Array.isArray(plan?.target_files)
          ? plan.target_files
          : [],
      continuationFamilyKey: familyKey,
    };
  });
}

/**
 * Build a Budget object from a Prometheus requestBudget and box.config.json.
 *
 * Budget unit: workerSpawns (integer).
 * Sources (in priority order):
 *   1. requestBudget.hardCapTotal (from Prometheus AI output)
 *   2. config.runtime.runtimeBudget.maxWorkerSpawnsPerCycle
 *   3. config.runtime.runtimeBudget.maxTasksPerCycle (fallback)
 *   4. Hardcoded default: 12
 *
 * @param {object} requestBudget — Prometheus requestBudget object
 * @param {object} config        — box.config.json config object
 * @returns {object}             — Budget object for runInterventionOptimizer
 */
export function buildBudgetFromConfig(requestBudget, config) {
  const runtimeBudget = config?.runtime?.runtimeBudget ?? {};
  const plannerMaxWorkersPerWave = Math.max(
    1,
    Number(config?.planner?.defaultMaxWorkersPerWave ?? config?.maxParallelWorkers ?? 10),
  );

  // Derive total budget from requestBudget or runtime config
  const hardCap = Number(requestBudget?.hardCapTotal);
  const configSpawns = Number(runtimeBudget.maxWorkerSpawnsPerCycle);
  const configTasks  = Number(runtimeBudget.maxTasksPerCycle);
  const maxWorkerSpawns = (Number.isFinite(hardCap) && hardCap > 0)
    ? hardCap
    : (Number.isFinite(configSpawns) && configSpawns > 0)
      ? configSpawns
      : (Number.isFinite(configTasks) && configTasks > 0)
        ? configTasks
        : 12;

  // Per-wave budget from requestBudget.byWave or planner config
  let maxWorkersPerWave = plannerMaxWorkersPerWave;
  if (Array.isArray(requestBudget?.byWave) && requestBudget.byWave.length > 0) {
    const maxWaveEntry = requestBudget.byWave.reduce(
      (acc, w) => Math.max(acc, Number(w?.count ?? w?.budget ?? w?.estimatedRequests ?? 0)),
      0,
    );
    if (maxWaveEntry > 0) maxWorkersPerWave = maxWaveEntry;
  }

  // Per-role budget from requestBudget.byRole or optimizer config
  const byRole: Record<string, any> = {};
  if (Array.isArray(requestBudget?.byRole)) {
    for (const entry of requestBudget.byRole) {
      const roleName = String(entry?.role ?? "");
      const cap = Number(entry?.count ?? entry?.budget ?? entry?.estimatedRequests ?? 0);
      if (roleName && Number.isFinite(cap) && cap > 0) {
        byRole[roleName] = cap;
      }
    }
  }

  return {
    maxWorkerSpawns: Math.max(1, Math.floor(maxWorkerSpawns)),
    maxWorkersPerWave: Math.max(1, Math.floor(maxWorkersPerWave)),
    ...(Object.keys(byRole).length > 0 ? { byRole } : {}),
  };
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * Append an optimizer result entry to state/intervention_optimizer_log.jsonl.
 *
 * Called by prometheus.js integration after each optimizer run.
 * Never throws — all errors are returned in a result object so the caller can
 * log them without crashing the orchestration flow.
 *
 * Log file schema:
 *   JSONL (one object per line), each line:
 *   { jsonlSchema, recordType, schemaVersion, savedAt, freshness, payload }
 *   where payload is the optimizer result object.
 *
 * @param {string} stateDir — absolute path to state directory
 * @param {object} result   — optimizer result from runInterventionOptimizer
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function persistOptimizerLog(stateDir, result) {
  try {
    const logFile = path.join(stateDir, "intervention_optimizer_log.jsonl");
    const jsonMirrorFile = path.join(stateDir, "intervention_optimizer_log.json");
    const savedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + OPTIMIZER_LOG_FRESHNESS_MS).toISOString();
    const record = {
      jsonlSchema: OPTIMIZER_LOG_JSONL_SCHEMA,
      recordType: OPTIMIZER_LOG_RECORD_TYPE,
      schemaVersion: OPTIMIZER_LOG_SCHEMA_VERSION,
      savedAt,
      freshness: {
        status: "fresh",
        staleAfterMs: OPTIMIZER_LOG_FRESHNESS_MS,
        expiresAt,
      },
      payload: result,
    };
    const entry = JSON.stringify(record);

    await fs.appendFile(logFile, entry + "\n", "utf8");
    const mirror = await readJson(jsonMirrorFile, { schemaVersion: OPTIMIZER_LOG_SCHEMA_VERSION, updatedAt: savedAt, entries: [] });
    const entries = Array.isArray(mirror?.entries) ? mirror.entries : [];
    entries.push(record.payload);
    await writeJson(jsonMirrorFile, {
      schemaVersion: OPTIMIZER_LOG_SCHEMA_VERSION,
      updatedAt: savedAt,
      entries: entries.slice(-100),
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}
