/**
 * Governance Canary — Staged rollout of policy rule changes to a subset of cycles.
 *
 * T-035: "Introduce governance canary for policy changes"
 * Risk level: medium-high (automatic rollback logic gates policy enforcement)
 *
 * ## Design: cohort-based policy gating
 *
 *   Each cycle is deterministically assigned to a cohort ("canary" or "control")
 *   via hash-mod of the cycle ID. Cycles in the canary cohort have new governance
 *   rules applied; control cycles use the existing policy baseline. This lets the
 *   system compare outcomes between the two groups before promoting globally.
 *
 * ## Cohort selection algorithm (AC1 / Athena missing item 1)
 *
 *   Algorithm  : "hash-mod"  (config key: canary.governance.cohortSelectionAlgorithm)
 *   Seeding    : sha1(cycleId) — cycle ID is the entropy source
 *   Mapping    : parseInt(sha1(cycleId).slice(0, 8), 16) % 100 < ratio * 100
 *                → CANARY; otherwise CONTROL
 *   ratio      : canary.governance.canaryRatio or canary.defaultRatio (default 0.2)
 *   Determinism: same cycleId always maps to the same cohort (no randomness)
 *
 * ## Tracking schema (AC2 / Athena missing item 2)
 *
 *   Storage    : state/governance_canary_ledger.json (GOVERNANCE_LEDGER_PATH)
 *   Format     : JSON, schemaVersion: 1
 *   Structure  :
 *   {
 *     "schemaVersion": 1,
 *     "experiments": [
 *       {
 *         "canaryId":      "govcanary-<sha1-12>",   // stable derived ID
 *         "experimentId":  "exp-...|null",           // links to experiment_registry
 *         "policyRulePatch": { ... },                // the staged policy rule change
 *         "canaryRatio":   0.2,                      // cohort selection ratio
 *         "status":        "running",                // GOVERNANCE_CANARY_STATUS enum
 *         "statusReason":  null,                     // machine-readable reason
 *         "cohortStats": {
 *           "canary":  { "cycleCount": 0, "falseBlockRate": 0, "safetyScore": 1 },
 *           "control": { "cycleCount": 0, "falseBlockRate": 0, "safetyScore": 1 }
 *         },
 *         "cycleLog": [                              // per-cycle cohort assignments + outcomes
 *           {
 *             "cycleId":   "cycle-...",
 *             "cohort":    "canary"|"control",
 *             "timestamp": "2026-...",
 *             "metrics":   { "falseBlockRate": 0.01, "safetyScore": 0.98, ... }
 *           }
 *         ],
 *         "createdAt":     "2026-...",
 *         "promotedAt":    null,
 *         "rolledBackAt":  null
 *       }
 *     ],
 *     "updatedAt": "2026-..."
 *   }
 *
 * ## Promotion thresholds (AC3 / Athena missing item 3)
 *
 *   falseBlockRateMax  : 0.02  — canary false-block rate must be < 2%
 *   safetyScoreMin     : 0.95  — canary safety score must be ≥ 95%
 *   Config keys: canary.governance.falseBlockRateMax, canary.governance.safetyScoreMin
 *
 * ## Breach (rollback) condition (AC4 / Athena missing item 4)
 *
 *   Trigger metric     : falseBlockRate > falseBlockRateTrigger (default 0.05)
 *                        OR safetyScore < safetyScoreTriggerLow (default 0.80)
 *   Measurement window : canary.governance.measurementWindowCycles (default 5) cycles
 *   Rollback behavior  : status=rolled_back, breachAction="halt_new_assignments"
 *                        (no new policy rule assignments until canary is cleared)
 *   Config key         : canary.governance.breachAction
 *
 * ## Audit log (AC5)
 *
 *   Storage    : state/governance_canary_audit.jsonl (GOVERNANCE_AUDIT_LOG_PATH)
 *   Each entry : { event, canaryId, experimentId, cycleId, cohort, timestamp,
 *                  metrics, reason }
 */

import path from "node:path";
import fs   from "node:fs/promises";
import { createHash } from "node:crypto";
import { readJson, writeJson } from "./fs_utils.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const GOVERNANCE_LEDGER_PATH    = "state/governance_canary_ledger.json";
export const GOVERNANCE_AUDIT_LOG_PATH = "state/governance_canary_audit.jsonl";

// ── Cohort enum (AC1) ─────────────────────────────────────────────────────────

/**
 * Cohort assignment values for governance canary.
 * CANARY cycles have new governance rules applied; CONTROL cycles use the baseline.
 */
export const COHORT = Object.freeze({
  CANARY:  "canary",
  CONTROL: "control"
});

// ── Status enum (AC8) ─────────────────────────────────────────────────────────

/**
 * Lifecycle status values for a governance canary experiment entry.
 */
export const GOVERNANCE_CANARY_STATUS = Object.freeze({
  RUNNING:     "running",
  PROMOTED:    "promoted",
  ROLLED_BACK: "rolled_back",
  FAILED:      "failed"
});

// ── Audit event enum (AC8) ────────────────────────────────────────────────────

export const GOVERNANCE_AUDIT_EVENT = Object.freeze({
  CANARY_STARTED:     "GOVERNANCE_CANARY_STARTED",
  CYCLE_ASSIGNED:     "GOVERNANCE_CYCLE_ASSIGNED",
  METRICS_RECORDED:   "GOVERNANCE_METRICS_RECORDED",
  CANARY_PROMOTED:    "GOVERNANCE_CANARY_PROMOTED",
  CANARY_ROLLED_BACK: "GOVERNANCE_CANARY_ROLLED_BACK",
  CANARY_FAILED:      "GOVERNANCE_CANARY_FAILED"
});

/** Required fields on every audit log entry. */
export const GOVERNANCE_AUDIT_REQUIRED_FIELDS = Object.freeze([
  "event", "canaryId", "timestamp"
]);

// ── Named metric set (AC2) ────────────────────────────────────────────────────

/**
 * Named governance metrics used for canary/control comparison.
 * falseBlockRate : fraction of valid policy evaluations incorrectly blocked
 * safetyScore    : weighted safety quality score (1.0 = perfect safety)
 */
export const GOVERNANCE_METRIC_NAMES = Object.freeze({
  FALSE_BLOCK_RATE: "falseBlockRate",
  SAFETY_SCORE:     "safetyScore"
});

// ── Threshold defaults (AC3 / AC4) ────────────────────────────────────────────

/**
 * Default promotion thresholds for governance canary (AC3 / Athena missing item 3).
 * Both must be satisfied across the canary cohort before global promotion is allowed.
 * Config keys: canary.governance.falseBlockRateMax, canary.governance.safetyScoreMin
 */
export const DEFAULT_GOVERNANCE_PROMOTION_THRESHOLDS = Object.freeze({
  falseBlockRateMax: 0.02,   // canary false-block rate must be < 2%
  safetyScoreMin:    0.95    // canary safety score must be >= 95%
});

/**
 * Default breach (rollback trigger) thresholds (AC4 / Athena missing item 4).
 * If the canary cohort exceeds these in any single measurement window, rollback triggers.
 * Config keys: canary.governance.falseBlockRateTrigger, canary.governance.safetyScoreTriggerLow
 */
export const DEFAULT_GOVERNANCE_BREACH_THRESHOLDS = Object.freeze({
  falseBlockRateTrigger: 0.05,  // error: false-block rate above 5% = immediate rollback
  safetyScoreTriggerLow: 0.80   // error: safety score below 80% = immediate rollback
});

/** Default cohort selection algorithm identifier (AC1). */
export const DEFAULT_COHORT_ALGORITHM = "hash-mod";

/** Default measurement window in cycles (AC4). */
export const DEFAULT_MEASUREMENT_WINDOW_CYCLES = 5;

/** Default breach action (AC4). */
export const DEFAULT_BREACH_ACTION = "halt_new_assignments";

// ── Breach action enum (AC4 / AC8) ────────────────────────────────────────────

/**
 * Machine-readable breach action values.
 * Written to the ledger entry status when a breach occurs.
 */
export const GOVERNANCE_BREACH_ACTION = Object.freeze({
  HALT_NEW_ASSIGNMENTS: "halt_new_assignments"
});

// ── Validation error codes (AC9) ─────────────────────────────────────────────

/**
 * Reason codes for governance canary input validation.
 * Distinguishes missing input from invalid input (AC9 / Athena missing item 7).
 *
 * @typedef {"MISSING_FIELD"|"INVALID_VALUE"} GovernanceValidationCode
 */
export const GOVERNANCE_VALIDATION_CODE = Object.freeze({
  MISSING_FIELD: "MISSING_FIELD",
  INVALID_VALUE: "INVALID_VALUE"
});

// ── Cohort selection algorithm (AC1 / Athena missing item 1) ──────────────────

/**
 * Deterministically assign a cycle to a cohort using hash-mod (AC1).
 *
 * Algorithm : "hash-mod"
 * Seeding   : sha1(cycleId)
 * Mapping   : parseInt(sha1(cycleId).slice(0, 8), 16) % 100 < ratio * 100 → CANARY
 *
 * Properties:
 *   - Deterministic: same cycleId always maps to the same cohort
 *   - No external state: purely functional
 *   - Uniform distribution across cycle IDs
 *
 * @param {string} cycleId - opaque cycle identifier (entropy source)
 * @param {number} ratio   - canary fraction in (0, 1] (e.g. 0.2 = 20% canary)
 * @returns {"canary"|"control"}
 */
export function assignCohort(cycleId, ratio) {
  if (!cycleId || typeof cycleId !== "string" || cycleId.trim() === "") {
    // Invalid input: default to control (safe fallback — no new rules applied)
    return COHORT.CONTROL;
  }
  const r = typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0 && ratio <= 1
    ? ratio
    : 0.2;

  const hex    = createHash("sha1").update(String(cycleId)).digest("hex");
  const bucket = parseInt(hex.slice(0, 8), 16) % 100;
  return bucket < Math.round(r * 100) ? COHORT.CANARY : COHORT.CONTROL;
}

// ── Config helpers ────────────────────────────────────────────────────────────

/**
 * Read governance canary config from box.config.json, applying defaults for missing keys.
 *
 * @param {object} config - full runtime config (loadConfig() result)
 * @returns {object}
 */
export function getGovernanceCanaryConfig(config) {
  const c  = config?.canary || {};
  const gc = c.governance || {};

  return {
    enabled:                  typeof c.enabled === "boolean" ? c.enabled : true,
    canaryRatio:              typeof gc.canaryRatio === "number" ? gc.canaryRatio
                              : (typeof c.defaultRatio === "number" ? c.defaultRatio : 0.2),
    cohortSelectionAlgorithm: gc.cohortSelectionAlgorithm || DEFAULT_COHORT_ALGORITHM,
    measurementWindowCycles:  typeof gc.measurementWindowCycles === "number"
                              ? gc.measurementWindowCycles : DEFAULT_MEASUREMENT_WINDOW_CYCLES,
    falseBlockRateMax:        typeof gc.falseBlockRateMax === "number"
                              ? gc.falseBlockRateMax : DEFAULT_GOVERNANCE_PROMOTION_THRESHOLDS.falseBlockRateMax,
    safetyScoreMin:           typeof gc.safetyScoreMin === "number"
                              ? gc.safetyScoreMin : DEFAULT_GOVERNANCE_PROMOTION_THRESHOLDS.safetyScoreMin,
    falseBlockRateTrigger:    typeof gc.falseBlockRateTrigger === "number"
                              ? gc.falseBlockRateTrigger : DEFAULT_GOVERNANCE_BREACH_THRESHOLDS.falseBlockRateTrigger,
    safetyScoreTriggerLow:    typeof gc.safetyScoreTriggerLow === "number"
                              ? gc.safetyScoreTriggerLow : DEFAULT_GOVERNANCE_BREACH_THRESHOLDS.safetyScoreTriggerLow,
    breachAction:             gc.breachAction || DEFAULT_BREACH_ACTION
  };
}

// ── Input validation (AC9 / Athena missing item 7) ────────────────────────────

/**
 * Validate a governance canary start request.
 * Distinguishes MISSING_FIELD from INVALID_VALUE (AC9).
 *
 * @param {object} input - { configPath|policyRulePatch, canaryRatio?, experimentId? }
 * @returns {{ ok: boolean, errors: Array<{ field: string, code: string, message: string }> }}
 */
export function validateGovernanceCanaryInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      errors: [{
        field:   "root",
        code:    GOVERNANCE_VALIDATION_CODE.MISSING_FIELD,
        message: "governance canary input must be a non-null object"
      }]
    };
  }

  const errors = [];
  const e = /** @type {Record<string, unknown>} */ (input);

  // policyRulePatch: required non-null object
  if (!("policyRulePatch" in e) || e.policyRulePatch == null) {
    errors.push({
      field:   "policyRulePatch",
      code:    GOVERNANCE_VALIDATION_CODE.MISSING_FIELD,
      message: "policyRulePatch is required"
    });
  } else if (typeof e.policyRulePatch !== "object" || Array.isArray(e.policyRulePatch)) {
    errors.push({
      field:   "policyRulePatch",
      code:    GOVERNANCE_VALIDATION_CODE.INVALID_VALUE,
      message: "policyRulePatch must be a non-array object"
    });
  }

  // canaryRatio: optional but if provided must be in (0, 1]
  if ("canaryRatio" in e && e.canaryRatio != null) {
    if (
      typeof e.canaryRatio !== "number" ||
      !Number.isFinite(e.canaryRatio) ||
      e.canaryRatio <= 0 ||
      e.canaryRatio > 1
    ) {
      errors.push({
        field:   "canaryRatio",
        code:    GOVERNANCE_VALIDATION_CODE.INVALID_VALUE,
        message: "canaryRatio must be a number in (0, 1]"
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

// ── Metric collection (AC2) ───────────────────────────────────────────────────

/**
 * Collect governance metrics from a policy evaluation outcome object.
 *
 * Expected outcome shape (callers may pass partial objects):
 *   {
 *     totalEvaluations : number   — total policy checks in this cycle
 *     falseBlocks      : number   — evaluations that were wrongly blocked
 *     safetyPassed     : number   — evaluations that passed safety checks
 *   }
 *
 * Returns zero-safe metrics — no NaN propagation. (AC10)
 *
 * @param {object} policyEvalOutcomes
 * @returns {{ falseBlockRate: number, safetyScore: number, sampleSize: number }}
 */
export function collectGovernanceMetrics(policyEvalOutcomes) {
  const total       = (policyEvalOutcomes?.totalEvaluations >= 0) ? policyEvalOutcomes.totalEvaluations : 0;
  const falseBlocks = (policyEvalOutcomes?.falseBlocks      >= 0) ? policyEvalOutcomes.falseBlocks      : 0;
  const safetyPassed = (policyEvalOutcomes?.safetyPassed    >= 0) ? policyEvalOutcomes.safetyPassed     : 0;

  const falseBlockRate = total > 0 ? falseBlocks  / total : 0;
  const safetyScore    = total > 0 ? safetyPassed / total : 1;   // default 1.0 = safe when no data

  return { falseBlockRate, safetyScore, sampleSize: total };
}

// ── Aggregation ───────────────────────────────────────────────────────────────

/**
 * Aggregate governance metric snapshots into averaged cohort stats.
 * Prevents NaN propagation for empty arrays.
 *
 * @param {Array<{ falseBlockRate: number, safetyScore: number }>} snapshots
 * @returns {{ falseBlockRate: number, safetyScore: number, totalObservations: number }}
 */
export function aggregateGovernanceMetrics(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    return { falseBlockRate: 0, safetyScore: 1, totalObservations: 0 };
  }
  let sumFbr = 0;
  let sumSs  = 0;
  for (const s of snapshots) {
    sumFbr += typeof s.falseBlockRate === "number" ? s.falseBlockRate : 0;
    sumSs  += typeof s.safetyScore    === "number" ? s.safetyScore    : 1;
  }
  const n = snapshots.length;
  return {
    falseBlockRate:    sumFbr / n,
    safetyScore:       sumSs  / n,
    totalObservations: n
  };
}

// ── Promotion evaluation (AC3) ────────────────────────────────────────────────

/**
 * Evaluate whether aggregated canary governance metrics satisfy promotion thresholds (AC3).
 *
 * @param {{ falseBlockRate: number, safetyScore: number }} canaryMetrics
 * @param {object} [thresholds]
 * @returns {{ promote: boolean, reason: string }}
 */
export function evaluateGovernancePromotion(canaryMetrics, thresholds: any = {}) {
  const maxFbr  = typeof thresholds.falseBlockRateMax === "number"
    ? thresholds.falseBlockRateMax : DEFAULT_GOVERNANCE_PROMOTION_THRESHOLDS.falseBlockRateMax;
  const minSs   = typeof thresholds.safetyScoreMin === "number"
    ? thresholds.safetyScoreMin : DEFAULT_GOVERNANCE_PROMOTION_THRESHOLDS.safetyScoreMin;

  if (canaryMetrics.falseBlockRate >= maxFbr) {
    return {
      promote: false,
      reason:  `FALSE_BLOCK_RATE_ABOVE_THRESHOLD:${canaryMetrics.falseBlockRate.toFixed(4)}>=${maxFbr}`
    };
  }
  if (canaryMetrics.safetyScore < minSs) {
    return {
      promote: false,
      reason:  `SAFETY_SCORE_BELOW_THRESHOLD:${canaryMetrics.safetyScore.toFixed(4)}<${minSs}`
    };
  }
  return { promote: true, reason: "ALL_GOVERNANCE_THRESHOLDS_MET" };
}

// ── Breach evaluation (AC4 / Athena missing item 4) ───────────────────────────

/**
 * Evaluate whether the latest canary governance metrics trigger a breach (AC4).
 *
 * Breach is evaluated per-cycle for fast failure detection within the measurement window.
 * On breach, breachAction="halt_new_assignments": no new policy rules are applied until cleared.
 *
 * @param {{ falseBlockRate: number, safetyScore: number }} canaryMetrics
 * @param {object} [thresholds]
 * @returns {{ breach: boolean, reason: string|null }}
 */
export function evaluateGovernanceBreach(canaryMetrics, thresholds: any = {}) {
  const triggerFbr = typeof thresholds.falseBlockRateTrigger === "number"
    ? thresholds.falseBlockRateTrigger : DEFAULT_GOVERNANCE_BREACH_THRESHOLDS.falseBlockRateTrigger;
  const triggerSs  = typeof thresholds.safetyScoreTriggerLow === "number"
    ? thresholds.safetyScoreTriggerLow : DEFAULT_GOVERNANCE_BREACH_THRESHOLDS.safetyScoreTriggerLow;

  if (canaryMetrics.falseBlockRate > triggerFbr) {
    return {
      breach: true,
      reason: `GOVERNANCE_BREACH_FALSE_BLOCK_RATE:${canaryMetrics.falseBlockRate.toFixed(4)}>${triggerFbr}`
    };
  }
  if (canaryMetrics.safetyScore < triggerSs) {
    return {
      breach: true,
      reason: `GOVERNANCE_BREACH_SAFETY_SCORE_TOO_LOW:${canaryMetrics.safetyScore.toFixed(4)}<${triggerSs}`
    };
  }
  return { breach: false, reason: null };
}

// ── ID generation ─────────────────────────────────────────────────────────────

/**
 * Build a stable governance canary ID from its defining axes.
 * Format: "govcanary-<sha1-12>" — deterministic for (policyKey, createdAt).
 *
 * @param {string} policyKey  - opaque key identifying the policy rule patch
 * @param {string} createdAt  - ISO timestamp
 * @returns {string}
 */
export function buildGovernanceCanaryId(policyKey, createdAt) {
  const key  = `${policyKey}|${createdAt}`;
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 12);
  return `govcanary-${hash}`;
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * Load the governance canary ledger from disk.
 * Returns a fresh default (schemaVersion=1, experiments=[]) on ENOENT.
 *
 * @param {string} stateDir
 * @returns {Promise<{ schemaVersion: number, experiments: Array<object>, updatedAt?: string }>}
 */
export async function loadGovernanceLedger(stateDir) {
  return readJson(path.join(stateDir, "governance_canary_ledger.json"), {
    schemaVersion: 1,
    experiments:   []
  });
}

/**
 * Save the governance canary ledger to disk (atomic write via writeJson).
 *
 * @param {string} stateDir
 * @param {object} ledger
 */
export async function saveGovernanceLedger(stateDir, ledger) {
  ledger.updatedAt = new Date().toISOString();
  await writeJson(path.join(stateDir, "governance_canary_ledger.json"), ledger);
}

// ── Audit log (AC5) ───────────────────────────────────────────────────────────

/**
 * Append a structured governance canary audit event (AC5).
 *
 * Required fields: event, canaryId, timestamp
 * Optional: experimentId, cycleId, cohort, metrics, reason
 *
 * Missing required fields produce an explicit `auditError` field (AC10 — no silent failure).
 *
 * @param {string} stateDir
 * @param {object} entry
 * @returns {Promise<void>}
 */
export async function appendGovernanceAuditLog(stateDir, entry) {
  const missingFields = GOVERNANCE_AUDIT_REQUIRED_FIELDS.filter(
    f => !(f in entry) || entry[f] == null
  );

  const record = {
    event:        entry.event        ?? null,
    canaryId:     entry.canaryId     ?? null,
    experimentId: entry.experimentId ?? null,
    cycleId:      entry.cycleId      ?? null,
    cohort:       entry.cohort       ?? null,
    timestamp:    entry.timestamp    ?? new Date().toISOString(),
    metrics:      entry.metrics      ?? null,
    reason:       entry.reason       ?? null,
    ...(missingFields.length > 0
      ? { auditError: `MISSING_REQUIRED_FIELDS:${missingFields.join(",")}` }
      : {})
  };

  const logPath = path.join(stateDir, "governance_canary_audit.jsonl");
  try {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.appendFile(logPath, JSON.stringify(record) + "\n", "utf8");
    return { ok: true, status: "written" };
  } catch {
    // Audit log write failure must not crash the main path.
    // The missing entry is observable via the absent log line.
    // Return explicit non-fatal failure signal so callers can observe the gap.
    return { ok: false, status: "audit-write-failed" };
  }
}

// ── State machine ─────────────────────────────────────────────────────────────

/**
 * Start a new governance canary experiment for a policy rule change.
 *
 * The policyRulePatch describes the new governance rules to test on canary cycles.
 * Control cycles continue to use the existing policy. After enough canary cycles
 * are observed, the experiment is promoted or rolled back.
 *
 * Returns { ok: false, status: "CANARY_DISABLED" } when canary is disabled.
 * Returns { ok: false, status: "ALREADY_RUNNING", canaryId } when an experiment
 *   with the same policyKey is already running.
 *
 * @param {object}      config         - full runtime config
 * @param {object}      policyRulePatch - the staged governance rule changes to test
 * @param {string|null} [experimentId]  - links to experiment_registry (may be null)
 * @returns {Promise<{ ok: boolean, canaryId?: string, status?: string, errors?: Array<object> }>}
 */
export async function startGovernanceCanary(config, policyRulePatch, experimentId = null) {
  const gc = getGovernanceCanaryConfig(config);

  if (!gc.enabled) {
    return { ok: false, status: "CANARY_DISABLED" };
  }

  const validation = validateGovernanceCanaryInput({ policyRulePatch });
  if (!validation.ok) {
    return { ok: false, status: "INVALID_INPUT", errors: validation.errors };
  }

  const stateDir = config.paths?.stateDir || "state";
  const ledger   = await loadGovernanceLedger(stateDir);
  const policyKey = JSON.stringify(policyRulePatch);

  // Prevent duplicate running experiments for the same policy patch
  const existing = (ledger.experiments || []).find(
    e => e.policyKey === policyKey && e.status === GOVERNANCE_CANARY_STATUS.RUNNING
  );
  if (existing) {
    return { ok: false, status: "ALREADY_RUNNING", canaryId: existing.canaryId };
  }

  const now      = new Date().toISOString();
  const canaryId = buildGovernanceCanaryId(policyKey, now);
  const ratio    = gc.canaryRatio;

  const entry = {
    canaryId,
    experimentId:    experimentId || null,
    policyKey,
    policyRulePatch,
    canaryRatio:     ratio,
    status:          GOVERNANCE_CANARY_STATUS.RUNNING,
    statusReason:    null,
    cohortStats: {
      canary:  { cycleCount: 0, falseBlockRate: 0, safetyScore: 1 },
      control: { cycleCount: 0, falseBlockRate: 0, safetyScore: 1 }
    },
    cycleLog:      [],
    createdAt:     now,
    promotedAt:    null,
    rolledBackAt:  null
  };

  ledger.experiments = ledger.experiments || [];
  ledger.experiments.push(entry);
  await saveGovernanceLedger(stateDir, ledger);

  await appendGovernanceAuditLog(stateDir, {
    event:        GOVERNANCE_AUDIT_EVENT.CANARY_STARTED,
    canaryId,
    experimentId: experimentId || null,
    cycleId:      null,
    cohort:       null,
    timestamp:    now,
    metrics:      null,
    reason:       `STARTED:ratio=${ratio} algorithm=${gc.cohortSelectionAlgorithm}`
  });

  return { ok: true, canaryId };
}

/**
 * Process a single governance cycle: assign cohort, record metrics, evaluate advancement.
 *
 * For each running governance canary experiment:
 *   1. Assign cycleId to canary or control cohort (hash-mod).
 *   2. Record governance metrics for that cohort.
 *   3. If canary cohort, check for breach (fast-fail) and aggregate for promotion.
 *
 * Returns an array of { canaryId, cohort, action, reason } for each running experiment.
 * Non-fatal per-experiment errors are captured and returned with action="error". (AC10)
 *
 * @param {object} config
 * @param {string} cycleId
 * @param {object} policyEvalOutcomes - output of policy evaluation for this cycle
 * @returns {Promise<Array<{ canaryId: string, cohort: string, action: string, reason: string }>>}
 */
export async function processGovernanceCycle(config, cycleId, policyEvalOutcomes: any = {}) {
  const gc = getGovernanceCanaryConfig(config);
  if (!gc.enabled) return [];

  const stateDir = config.paths?.stateDir || "state";
  const ledger   = await loadGovernanceLedger(stateDir);
  const running  = (ledger.experiments || []).filter(
    e => e.status === GOVERNANCE_CANARY_STATUS.RUNNING
  );

  if (running.length === 0) return [];

  const metrics  = collectGovernanceMetrics(policyEvalOutcomes);
  const results  = [];

  for (const entry of running) {
    try {
      const cohort = assignCohort(
        `${cycleId}:${entry.canaryId}`,
        entry.canaryRatio ?? gc.canaryRatio
      );

      const result = await _recordAndEvaluate(config, stateDir, entry.canaryId, cycleId, cohort, metrics, gc);
      results.push({ canaryId: entry.canaryId, cohort, action: result.action, reason: result.reason });
    } catch (err) {
      // Non-fatal: per-experiment error must not crash the cycle (AC10)
      results.push({
        canaryId: entry.canaryId,
        cohort:   "unknown",
        action:   "error",
        reason:   `PROCESSING_ERROR:${String(err?.message || err).slice(0, 200)}`
      });
    }
  }

  return results;
}

/**
 * Check if a governance canary breach is active (breach has been recorded and not cleared).
 * Used by policy_engine to determine whether new governance rules should be applied.
 *
 * @param {object} config
 * @returns {Promise<{ breachActive: boolean, reason: string|null }>}
 */
export async function isGovernanceCanaryBreachActive(config) {
  const gc = getGovernanceCanaryConfig(config);
  if (!gc.enabled) return { breachActive: false, reason: null };

  const stateDir = config.paths?.stateDir || "state";
  const ledger   = await loadGovernanceLedger(stateDir);
  const rolledBack = (ledger.experiments || []).find(
    e => e.status === GOVERNANCE_CANARY_STATUS.ROLLED_BACK &&
         e.breachAction === GOVERNANCE_BREACH_ACTION.HALT_NEW_ASSIGNMENTS
  );

  if (rolledBack) {
    return {
      breachActive: true,
      reason: rolledBack.statusReason || "GOVERNANCE_CANARY_BREACH"
    };
  }
  return { breachActive: false, reason: null };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Record metrics for a cycle/cohort pair and evaluate the canary's advancement.
 *
 * @param {object} config
 * @param {string} stateDir
 * @param {string} canaryId
 * @param {string} cycleId
 * @param {string} cohort   - COHORT.CANARY or COHORT.CONTROL
 * @param {object} metrics  - { falseBlockRate, safetyScore, sampleSize }
 * @param {object} gc       - governance canary config
 * @returns {Promise<{ action: string, reason: string }>}
 */
async function _recordAndEvaluate(config, stateDir, canaryId, cycleId, cohort, metrics, gc) {
  const ledger  = await loadGovernanceLedger(stateDir);
  const idx     = (ledger.experiments || []).findIndex(e => e.canaryId === canaryId);

  if (idx === -1) {
    return { action: "error", reason: "CANARY_NOT_FOUND" };
  }

  const entry = ledger.experiments[idx];
  if (entry.status !== GOVERNANCE_CANARY_STATUS.RUNNING) {
    return { action: "skip", reason: `NOT_RUNNING:status=${entry.status}` };
  }

  const now = new Date().toISOString();

  // Record cycle log entry (AC2 — both canary and control cohort tracked)
  entry.cycleLog = entry.cycleLog || [];
  entry.cycleLog.push({ cycleId, cohort, timestamp: now, metrics });

  // Update running cohort stats (rolling average)
  const stats = entry.cohortStats[cohort] || { cycleCount: 0, falseBlockRate: 0, safetyScore: 1 };
  const n     = stats.cycleCount + 1;
  entry.cohortStats[cohort] = {
    cycleCount:    n,
    falseBlockRate: ((stats.falseBlockRate * (n - 1)) + metrics.falseBlockRate) / n,
    safetyScore:    ((stats.safetyScore    * (n - 1)) + metrics.safetyScore)    / n
  };

  await saveGovernanceLedger(stateDir, ledger);

  await appendGovernanceAuditLog(stateDir, {
    event:        GOVERNANCE_AUDIT_EVENT.METRICS_RECORDED,
    canaryId,
    experimentId: entry.experimentId,
    cycleId,
    cohort,
    timestamp:    now,
    metrics,
    reason:       null
  });

  // Only evaluate advancement for canary cohort cycles (AC4)
  if (cohort !== COHORT.CANARY) {
    return { action: "continue", reason: `CONTROL_COHORT:tracking_only` };
  }

  // Fast-fail: check breach on current cycle metrics immediately (AC4)
  const breachCheck = evaluateGovernanceBreach(metrics, {
    falseBlockRateTrigger: gc.falseBlockRateTrigger,
    safetyScoreTriggerLow: gc.safetyScoreTriggerLow
  });

  if (breachCheck.breach) {
    return _rollbackGovernanceCanary(config, stateDir, canaryId, breachCheck.reason, gc);
  }

  // Check measurement window
  const canarySnaps = (entry.cycleLog || []).filter(l => l.cohort === COHORT.CANARY);
  if (canarySnaps.length < gc.measurementWindowCycles) {
    const remaining = gc.measurementWindowCycles - canarySnaps.length;
    return { action: "continue", reason: `AWAITING_CANARY_CYCLES:need=${remaining}more` };
  }

  // Aggregate canary snapshots for promotion evaluation (AC3)
  const aggregated     = aggregateGovernanceMetrics(canarySnaps.map(s => s.metrics));
  const promotionCheck = evaluateGovernancePromotion(aggregated, {
    falseBlockRateMax: gc.falseBlockRateMax,
    safetyScoreMin:    gc.safetyScoreMin
  });

  if (promotionCheck.promote) {
    return _promoteGovernanceCanary(config, stateDir, canaryId, promotionCheck.reason);
  }

  // Did not meet promotion thresholds after observation window → rollback
  return _rollbackGovernanceCanary(config, stateDir, canaryId, promotionCheck.reason, gc);
}

/**
 * Promote a running governance canary.
 * Marks the ledger entry as "promoted" and emits audit event.
 */
async function _promoteGovernanceCanary(config, stateDir, canaryId, reason) {
  const ledger = await loadGovernanceLedger(stateDir);
  const idx    = (ledger.experiments || []).findIndex(e => e.canaryId === canaryId);
  if (idx === -1) return { action: "error", reason: "NOT_FOUND_ON_PROMOTE" };

  const entry = ledger.experiments[idx];
  const now   = new Date().toISOString();

  ledger.experiments[idx] = {
    ...entry,
    status:       GOVERNANCE_CANARY_STATUS.PROMOTED,
    statusReason: reason,
    promotedAt:   now
  };
  await saveGovernanceLedger(stateDir, ledger);

  await appendGovernanceAuditLog(stateDir, {
    event:        GOVERNANCE_AUDIT_EVENT.CANARY_PROMOTED,
    canaryId,
    experimentId: entry.experimentId,
    cycleId:      null,
    cohort:       null,
    timestamp:    now,
    metrics:      null,
    reason
  });

  return { action: "promote", reason };
}

/**
 * Roll back a running governance canary due to breach or failed promotion.
 *
 * Rollback behavior (AC4 / Athena missing item 4):
 *   - status set to ROLLED_BACK
 *   - breachAction written to entry (default: "halt_new_assignments")
 *   - Audit event emitted with breach reason
 *
 * @param {object} config
 * @param {string} stateDir
 * @param {string} canaryId
 * @param {string} reason
 * @param {object} gc - governance canary config
 * @returns {Promise<{ action: string, reason: string }>}
 */
async function _rollbackGovernanceCanary(config, stateDir, canaryId, reason, gc) {
  const ledger = await loadGovernanceLedger(stateDir);
  const idx    = (ledger.experiments || []).findIndex(e => e.canaryId === canaryId);
  if (idx === -1) return { action: "error", reason: "NOT_FOUND_ON_ROLLBACK" };

  const entry  = ledger.experiments[idx];
  const now    = new Date().toISOString();
  const action = gc.breachAction || DEFAULT_BREACH_ACTION;

  ledger.experiments[idx] = {
    ...entry,
    status:       GOVERNANCE_CANARY_STATUS.ROLLED_BACK,
    statusReason: reason,
    breachAction: action,   // machine-readable breach action (AC4 / AC8)
    rolledBackAt: now
  };
  await saveGovernanceLedger(stateDir, ledger);

  await appendGovernanceAuditLog(stateDir, {
    event:        GOVERNANCE_AUDIT_EVENT.CANARY_ROLLED_BACK,
    canaryId,
    experimentId: entry.experimentId,
    cycleId:      null,
    cohort:       null,
    timestamp:    now,
    metrics:      null,
    reason:       `${reason}|breachAction=${action}`
  });

  return { action: "rollback", reason };
}
