/**
 * Hypothesis Scorecard — T-029
 *
 * Exposes active/completed hypotheses with deterministic, machine-checkable output.
 *
 * ## Schema (prerequisite — AC8/AC11 resolution)
 *
 * ### HYPOTHESIS_STATUS enum (AC1/AC12)
 *   planned     — experiment defined, not yet running
 *   running     — actively collecting treatment data
 *   completed   — data collected; hypothesis was supported
 *   rolled_back — intervention reverted; hypothesis was disproved or abandoned
 *
 * ### HYPOTHESIS_PHASE enum (AC4/AC15)
 *   Derived deterministically from status:
 *   baseline   — status === "planned"   (pre-treatment window)
 *   treatment  — status === "running"   (intervention active)
 *   evaluation — status === "completed" (outcome assessed, intervention kept)
 *   closed     — status === "rolled_back" (terminal, intervention reverted)
 *
 * ### HYPOTHESIS_RISK enum (AC4/AC15)
 *   Mapped from experiment.scopeTier (written by hypothesis_scheduler.js):
 *   critical — core runtime modules (orchestrator, policy_engine, task_queue)
 *   high     — self-improvement, worker management, scheduling infrastructure
 *   medium   — config tuning, prompts, non-core modules
 *   low      — docs, tests, scripts, helpers
 *   unknown  — scopeTier absent or not a valid enum value
 *
 * ### Success Probability (AC1)
 *   Computed deterministically from status:
 *   planned     → null  (no evidence yet)
 *   running     → impactScore ?? null  (in-progress estimate)
 *   completed   → 1.0   (hypothesis supported — experiment ran to completion)
 *   rolled_back → 0.0   (hypothesis disproved or abandoned)
 *
 * ### RollbackEvent contract (AC3/AC14) — required fields:
 *   hypothesis_id  string      — hypothesisId from experiment
 *   experiment_id  string      — experimentId
 *   action         "rolled_back" — always "rolled_back" for rollback events
 *   timestamp      string (ISO)  — rolledBackAt; null if not set
 *   reason         string|null   — statusReason from experiment
 *
 * ### DisproveEvent contract (AC2/AC13) — linked to metrics via metric_id:
 *   hypothesis_id  string          — hypothesisId from experiment
 *   experiment_id  string          — experimentId
 *   metric_id      string          — deterministic slug derived from disproveCriteria
 *   event_type     "disproved"
 *   timestamp      string (ISO)    — rolledBackAt ?? completedAt ?? null
 *   evidence       string|null     — disproveCriteria text (falsification statement)
 *
 * ### Safe-to-expose field allowlist (AC5/AC18)
 *   Exposed: experimentId, hypothesisId, interventionId, treatmentGroup,
 *            status, statusReason, phase, risk, impactScore, successProbability,
 *            disproveCriteria, rollbackPlan, interventionScope,
 *            createdAt, startedAt, completedAt, rolledBackAt,
 *            baselineWindow, stopConditions
 *   Excluded: any field not in the allowlist (e.g. internal AI prompts,
 *             raw config values, system-internal metadata)
 *
 * ### ScorecardFilter schema (AC4/AC15)
 *   phase  string|null — one of HYPOTHESIS_PHASE values, or null (no filter)
 *   risk   string|null — one of HYPOTHESIS_RISK values, or null (no filter)
 *
 * ### Validation reason codes (AC9)
 *   MISSING_FIELD — required field is absent or null/undefined
 *   INVALID_VALUE — field is present but fails enum/type constraint
 *
 * ### Degraded state (AC10)
 *   When the registry cannot be loaded, the result object includes:
 *     degraded:       true
 *     degradedReason: SCORECARD_DEGRADED_REASON code (never null when degraded)
 *     hypotheses:     []
 *     rollbackEvents: []
 *     disproveEvents: []
 *
 * Risk note (Athena AC18): exposing experiment_registry.json externally is medium risk.
 * A strict field allowlist (SCORECARD_SAFE_FIELDS) is enforced on every output row.
 * Internal fields not in this list are never included in scorecard output.
 */

import path from "node:path";
import { readJson } from "./fs_utils.js";

// ── Enums ────────────────────────────────────────────────────────────────────

/**
 * @typedef {"planned"|"running"|"completed"|"rolled_back"} HypothesisStatus
 * Valid status values — directly mirrors ExperimentStatus from experiment_registry.js.
 * @type {ReadonlySet<HypothesisStatus>}
 */
export const HYPOTHESIS_STATUS = Object.freeze(
  new Set(["planned", "running", "completed", "rolled_back"])
);

/**
 * @typedef {"baseline"|"treatment"|"evaluation"|"closed"} HypothesisPhase
 * @type {ReadonlySet<HypothesisPhase>}
 */
export const HYPOTHESIS_PHASE = Object.freeze(
  new Set(["baseline", "treatment", "evaluation", "closed"])
);

/**
 * @typedef {"critical"|"high"|"medium"|"low"|"unknown"} HypothesisRisk
 * @type {ReadonlySet<HypothesisRisk>}
 */
export const HYPOTHESIS_RISK = Object.freeze(
  new Set(["critical", "high", "medium", "low", "unknown"])
);

/**
 * Machine-readable reason codes for scorecard degraded state.
 * Distinguishes missing input (ABSENT) from invalid/corrupt input (INVALID).
 *
 *   REGISTRY_ABSENT  — state/experiment_registry.json not found (ENOENT)
 *   REGISTRY_INVALID — file found but fails structure validation (not an object/array)
 */
export const SCORECARD_DEGRADED_REASON = Object.freeze({
  REGISTRY_ABSENT:  "REGISTRY_ABSENT",
  REGISTRY_INVALID: "REGISTRY_INVALID"
});

// ── Safe-to-expose field allowlist (medium-risk mitigation) ──────────────────

/**
 * Explicit allowlist of experiment fields safe for external exposure.
 * Any field not in this set is stripped from scorecard output.
 * This is the primary defense against inadvertently surfacing internal state.
 */
export const SCORECARD_SAFE_FIELDS = Object.freeze(new Set([
  "experimentId",
  "hypothesisId",
  "interventionId",
  "treatmentGroup",
  "status",
  "statusReason",
  "disproveCriteria",
  "rollbackPlan",
  "interventionScope",
  "createdAt",
  "startedAt",
  "completedAt",
  "rolledBackAt",
  "baselineWindow",
  "stopConditions",
  // Scored/derived fields added by scorecard (not from registry directly):
  "phase",
  "risk",
  "impactScore",
  "successProbability"
]));

// ── Metric ID derivation ──────────────────────────────────────────────────────

/**
 * Derive a deterministic metric_id from a disproveCriteria string.
 * Used to link DisproveEvents to a metric identifier (AC2 join key).
 *
 * Strategy: lowercase slug of the first 40 chars, alphanumeric + hyphen only.
 * Prefixed with "metric-" so consumers can reliably identify it.
 *
 * @param {string|null|undefined} disproveCriteria
 * @returns {string}
 */
export function deriveMetricId(disproveCriteria) {
  if (typeof disproveCriteria !== "string" || disproveCriteria.trim().length === 0) {
    return "metric-undefined";
  }
  const slug = disproveCriteria
    .trim()
    .toLowerCase()
    .slice(0, 40)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `metric-${slug || "unnamed"}`;
}

// ── Phase derivation ──────────────────────────────────────────────────────────

/**
 * Derive hypothesis phase from status (deterministic, no ambiguity).
 *
 * @param {string} status
 * @returns {HypothesisPhase}
 */
export function derivePhase(status) {
  switch (status) {
    case "planned":     return "baseline";
    case "running":     return "treatment";
    case "completed":   return "evaluation";
    case "rolled_back": return "closed";
    default:            return "baseline";
  }
}

// ── Risk derivation ───────────────────────────────────────────────────────────

/**
 * Derive hypothesis risk from experiment.scopeTier.
 * Returns "unknown" when scopeTier is absent or not a valid HYPOTHESIS_RISK value.
 *
 * @param {object} experiment
 * @returns {HypothesisRisk}
 */
export function deriveRisk(experiment) {
  const tier = experiment?.scopeTier;
  if (typeof tier === "string" && HYPOTHESIS_RISK.has(/** @type {any} */ (tier)) && tier !== "unknown") {
    return /** @type {HypothesisRisk} */ (tier);
  }
  return "unknown";
}

// ── Success probability ───────────────────────────────────────────────────────

/**
 * Compute a deterministic success probability for a hypothesis.
 *
 * - completed   → 1.0  (hypothesis supported; experiment ran to completion)
 * - rolled_back → 0.0  (hypothesis disproved or intervention abandoned)
 * - running     → experiment.impactScore if present [0,1], else null
 * - planned     → experiment.impactScore if present [0,1], else null
 *
 * @param {object} experiment
 * @returns {number|null}
 */
export function deriveSuccessProbability(experiment) {
  const status = String(experiment?.status || "");
  if (status === "completed") return 1.0;
  if (status === "rolled_back") return 0.0;
  const score = experiment?.impactScore;
  if (typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 1) {
    return score;
  }
  return null;
}

// ── Field sanitization ────────────────────────────────────────────────────────

/**
 * Sanitize a raw experiment entry for safe external exposure.
 * Only fields in SCORECARD_SAFE_FIELDS are included in the output.
 * Derived fields (phase, risk, successProbability) are appended.
 *
 * @param {object} experiment
 * @returns {object}
 */
export function sanitizeHypothesis(experiment) {
  if (!experiment || typeof experiment !== "object" || Array.isArray(experiment)) {
    return {};
  }
  const out: Record<string, any> = {};
  for (const key of SCORECARD_SAFE_FIELDS) {
    if (key in experiment) {
      out[key] = experiment[key];
    }
  }
  // Always set derived fields (overwrite if somehow present in raw data)
  out.phase = derivePhase(String(experiment.status || ""));
  out.risk = deriveRisk(experiment);
  out.successProbability = deriveSuccessProbability(experiment);
  return out;
}

// ── Rollback event extraction ─────────────────────────────────────────────────

/**
 * Build rollback events from a list of experiments.
 * Only experiments with status "rolled_back" produce a rollback event.
 *
 * RollbackEvent required fields (AC3/AC14):
 *   hypothesis_id  string
 *   experiment_id  string
 *   action         "rolled_back"
 *   timestamp      string (ISO) | null
 *   reason         string | null
 *
 * @param {object[]} experiments
 * @returns {object[]}
 */
export function buildRollbackEvents(experiments) {
  if (!Array.isArray(experiments)) return [];
  return experiments
    .filter(e => e && typeof e === "object" && e.status === "rolled_back")
    .map(e => ({
      hypothesis_id: String(e.hypothesisId || ""),
      experiment_id: String(e.experimentId || ""),
      action:        "rolled_back",
      timestamp:     e.rolledBackAt || null,
      reason:        e.statusReason || null
    }));
}

// ── Disprove event extraction ─────────────────────────────────────────────────

/**
 * Build disprove events from a list of experiments.
 * A disprove event is emitted for every experiment that has been rolled_back
 * (the most common signal that a hypothesis was disproved).
 *
 * DisproveEvent fields (AC2/AC13):
 *   hypothesis_id  string          — hypothesisId from experiment
 *   experiment_id  string          — experimentId
 *   metric_id      string          — deterministic slug from disproveCriteria (join key)
 *   event_type     "disproved"
 *   timestamp      string (ISO)    — rolledBackAt ?? completedAt ?? null
 *   evidence       string | null   — disproveCriteria text
 *
 * @param {object[]} experiments
 * @returns {object[]}
 */
export function buildDisproveEvents(experiments) {
  if (!Array.isArray(experiments)) return [];
  return experiments
    .filter(e => e && typeof e === "object" && e.status === "rolled_back")
    .map(e => ({
      hypothesis_id: String(e.hypothesisId || ""),
      experiment_id: String(e.experimentId || ""),
      metric_id:     deriveMetricId(e.disproveCriteria),
      event_type:    "disproved",
      timestamp:     e.rolledBackAt || e.completedAt || null,
      evidence:      e.disproveCriteria || null
    }));
}

// ── Filter validation ─────────────────────────────────────────────────────────

/**
 * @typedef {object} FilterValidationError
 * @property {string}                         field
 * @property {"MISSING_FIELD"|"INVALID_VALUE"} code
 * @property {string}                         message
 */

/**
 * Validate a scorecard filter object.
 *
 * Valid shape: { phase?: string|null, risk?: string|null }
 * - null values are valid (means "no filter for this dimension")
 * - non-null values must be valid enum members
 *
 * Distinguishes MISSING_FIELD (null/undefined when required) from INVALID_VALUE
 * (present but wrong type or invalid enum member).
 *
 * @param {unknown} filters
 * @returns {{ ok: boolean, errors: FilterValidationError[] }}
 */
export function validateScorecardFilter(filters) {
  if (filters === null || filters === undefined) {
    return {
      ok: false,
      errors: [{ field: "root", code: "MISSING_FIELD", message: "filters must be a non-null object" }]
    };
  }
  if (typeof filters !== "object" || Array.isArray(filters)) {
    return {
      ok: false,
      errors: [{ field: "root", code: "INVALID_VALUE", message: "filters must be a plain object" }]
    };
  }

  const f = /** @type {Record<string, unknown>} */ (filters);
  const errors = /** @type {FilterValidationError[]} */ ([]);

  // phase: null | valid HYPOTHESIS_PHASE member
  if ("phase" in f && f.phase !== null && f.phase !== undefined) {
    if (typeof f.phase !== "string") {
      errors.push({ field: "phase", code: "INVALID_VALUE", message: "phase must be a string or null" });
    } else if (!HYPOTHESIS_PHASE.has(/** @type {any} */ (f.phase))) {
      errors.push({
        field: "phase",
        code: "INVALID_VALUE",
        message: `phase must be one of: ${[...HYPOTHESIS_PHASE].join(", ")}`
      });
    }
  }

  // risk: null | valid HYPOTHESIS_RISK member
  if ("risk" in f && f.risk !== null && f.risk !== undefined) {
    if (typeof f.risk !== "string") {
      errors.push({ field: "risk", code: "INVALID_VALUE", message: "risk must be a string or null" });
    } else if (!HYPOTHESIS_RISK.has(/** @type {any} */ (f.risk))) {
      errors.push({
        field: "risk",
        code: "INVALID_VALUE",
        message: `risk must be one of: ${[...HYPOTHESIS_RISK].join(", ")}`
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

// ── Main scorecard builder ────────────────────────────────────────────────────

/**
 * @typedef {object} ScorecardResult
 * @property {boolean}     ok
 * @property {boolean}     degraded               — true when registry could not be loaded
 * @property {string|null} degradedReason          — SCORECARD_DEGRADED_REASON code; null when not degraded
 * @property {object[]}    hypotheses              — sanitized hypothesis rows
 * @property {object[]}    rollbackEvents          — rollback event log
 * @property {object[]}    disproveEvents          — disprove event log (linked to metrics)
 * @property {{ total: number, byStatus: Record<string,number>, byPhase: Record<string,number>, byRisk: Record<string,number> }} summary
 * @property {string}      generatedAt             — ISO timestamp
 * @property {FilterValidationError[]} [filterErrors] — present when filter validation failed
 */

/**
 * Build a hypothesis scorecard from a loaded registry and optional filters.
 *
 * All output fields are deterministic and machine-checkable.
 * Filter validation errors are returned in-band (never throws).
 *
 * @param {object|null} registry  — experiment registry object ({ experiments: [...] })
 * @param {{ phase?: string|null, risk?: string|null }} [filters]
 * @returns {ScorecardResult}
 */
export function buildHypothesisScorecard(registry, filters) {
  const generatedAt = new Date().toISOString();

  // ── Filter validation ───────────────────────────────────────────────────
  const effectiveFilters = filters || {};
  const filterValidation = validateScorecardFilter(effectiveFilters);
  if (!filterValidation.ok) {
    return {
      ok: false,
      degraded: true,
      degradedReason: null,
      hypotheses: [],
      rollbackEvents: [],
      disproveEvents: [],
      summary: { total: 0, byStatus: {}, byPhase: {}, byRisk: {} },
      generatedAt,
      filterErrors: filterValidation.errors
    };
  }

  // ── Registry validation ─────────────────────────────────────────────────
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    return {
      ok: false,
      degraded: true,
      degradedReason: SCORECARD_DEGRADED_REASON.REGISTRY_INVALID,
      hypotheses: [],
      rollbackEvents: [],
      disproveEvents: [],
      summary: { total: 0, byStatus: {}, byPhase: {}, byRisk: {} },
      generatedAt
    };
  }

  const rawExperiments = Array.isArray(registry.experiments) ? registry.experiments : [];

  // ── Sanitize all hypotheses ─────────────────────────────────────────────
  let all = rawExperiments
    .filter(e => e && typeof e === "object" && !Array.isArray(e))
    .map(e => sanitizeHypothesis(e));

  // ── Apply filters ───────────────────────────────────────────────────────
  const phaseFilter = effectiveFilters.phase || null;
  const riskFilter  = effectiveFilters.risk  || null;

  if (phaseFilter !== null) {
    all = all.filter(h => h.phase === phaseFilter);
  }
  if (riskFilter !== null) {
    all = all.filter(h => h.risk === riskFilter);
  }

  // ── Build event logs (from unfiltered experiments for completeness) ──────
  const rollbackEvents = buildRollbackEvents(rawExperiments);
  const disproveEvents = buildDisproveEvents(rawExperiments);

  // ── Summary statistics ──────────────────────────────────────────────────
  const allUnfiltered = rawExperiments
    .filter(e => e && typeof e === "object")
    .map(e => sanitizeHypothesis(e));

  const byStatus = /** @type {Record<string,number>} */ ({});
  const byPhase  = /** @type {Record<string,number>} */ ({});
  const byRisk   = /** @type {Record<string,number>} */ ({});

  for (const h of allUnfiltered) {
    const s = String(h.status || "unknown");
    byStatus[s] = (byStatus[s] || 0) + 1;
    const p = String(h.phase  || "unknown");
    byPhase[p]  = (byPhase[p]  || 0) + 1;
    const r = String(h.risk   || "unknown");
    byRisk[r]   = (byRisk[r]   || 0) + 1;
  }

  return {
    ok: true,
    degraded: false,
    degradedReason: null,
    hypotheses: all,
    rollbackEvents,
    disproveEvents,
    summary: {
      total:    allUnfiltered.length,
      byStatus,
      byPhase,
      byRisk
    },
    generatedAt
  };
}

// ── Async collector (reads from disk) ─────────────────────────────────────────

/**
 * Collect the hypothesis scorecard from the experiment registry on disk.
 *
 * Reads state/experiment_registry.json and applies buildHypothesisScorecard.
 * Never throws — returns a degraded scorecard on any I/O or parse failure.
 *
 * Degraded state sets:
 *   degraded:       true
 *   degradedReason: SCORECARD_DEGRADED_REASON code (REGISTRY_ABSENT or REGISTRY_INVALID)
 *
 * @param {string} stateDir
 * @param {{ phase?: string|null, risk?: string|null }} [filters]
 * @returns {Promise<ScorecardResult>}
 */
export async function collectHypothesisScorecard(stateDir, filters) {
  const generatedAt = new Date().toISOString();

  let registry;
  try {
    registry = await readJson(path.join(stateDir, "experiment_registry.json"), null);
  } catch {
    return {
      ok: false,
      degraded: true,
      degradedReason: SCORECARD_DEGRADED_REASON.REGISTRY_ABSENT,
      hypotheses: [],
      rollbackEvents: [],
      disproveEvents: [],
      summary: { total: 0, byStatus: {}, byPhase: {}, byRisk: {} },
      generatedAt
    };
  }

  if (registry === null) {
    // readJson returned fallback null — file absent
    return {
      ok: false,
      degraded: true,
      degradedReason: SCORECARD_DEGRADED_REASON.REGISTRY_ABSENT,
      hypotheses: [],
      rollbackEvents: [],
      disproveEvents: [],
      summary: { total: 0, byStatus: {}, byPhase: {}, byRisk: {} },
      generatedAt
    };
  }

  return buildHypothesisScorecard(registry, filters);
}
