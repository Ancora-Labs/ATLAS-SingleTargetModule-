/**
 * compounding_effects_analyzer.js — Second-order impact analyzer for BOX interventions.
 *
 * Computes first-order and second-order impact vectors for interventions across
 * four dimensions: throughput, quality, cost, and failure.
 *
 * Risk level: MEDIUM — integrates with self_improvement.js, state_tracker.js, and
 *   the dashboard; all I/O calls are wrapped and never block the parent pipeline.
 *
 * ── Dimension definitions ─────────────────────────────────────────────────────
 *   throughput — rate at which tasks are completed (tasks/cycle)
 *   quality    — correctness, test-pass rate, review-pass rate
 *   cost       — token / worker-spawn consumption
 *   failure    — error and rollback rates
 *
 * ── ImpactVector schema (all fields required) ─────────────────────────────────
 *   dimension      : IMPACT_DIMENSION enum
 *   order          : IMPACT_ORDER enum ("first" | "second")
 *   interventionId : string — ID of the originating intervention
 *   magnitude      : float ∈ [-1.0, 1.0] — signed effect size
 *   direction      : IMPACT_DIRECTION enum (derived from magnitude)
 *   confidence     : float ∈ [0.0, 1.0] — computed from sampleCount
 *   confidenceLevel: "high" | "medium" | "low" (derived from confidence)
 *   evidence       : string[] — supporting observation IDs or labels
 *
 * ── MitigationRecommendation schema (all fields required) ────────────────────
 *   interventionId     : string
 *   reason             : string — human-readable explanation
 *   reasonCode         : MITIGATION_REASON_CODE enum
 *   recommendation     : string — actionable advice
 *   priority           : "low" | "medium" | "high" | "critical"
 *   affectedDimensions : IMPACT_DIMENSION[]
 *
 * ── Thresholds (deterministic, machine-checkable) ────────────────────────────
 *   CONFIDENCE_THRESHOLD       = 5   — min samples for full confidence (1.0)
 *   MIN_SAMPLE_THRESHOLD       = 3   — below this → SPARSE_DATA, status≠ok
 *   NEGATIVE_MAGNITUDE_THRESHOLD = -0.1 — below this → mitigation triggered
 *   SECOND_ORDER_NOISE_FLOOR   = 0.05 — magnitude below this is ignored (noise)
 *   MONTHLY_REPORT_TOP_N       = 5   — number of contributors in monthly report
 *
 * ── Confidence computation ────────────────────────────────────────────────────
 *   confidence = min(1.0, sampleCount / CONFIDENCE_THRESHOLD)
 *   sampleCount = 0  → 0.00  (no data)
 *   sampleCount = 1  → 0.20
 *   sampleCount = 5+ → 1.00
 *   high   : confidence ≥ 0.8
 *   medium : confidence ≥ 0.5
 *   low    : confidence < 0.5
 *
 * ── Cross-dimension cascade matrix ───────────────────────────────────────────
 *   Multiplier applied to first-order magnitude to derive second-order magnitude.
 *   CROSS_IMPACT_MATRIX[source][target] = cascadeMultiplier
 *   Positive → same direction; Negative → opposite direction.
 *
 * ── Persistence ───────────────────────────────────────────────────────────────
 *   Per-run:     state/compounding_effects_latest.json
 *   Monthly:     state/compounding_effects_monthly_{YYYY-MM}.json
 *   Schema version: ANALYZER_SCHEMA_VERSION (integer, currently 1)
 */

import path from "node:path";
import { readJson, writeJson, ensureParent } from "./fs_utils.js";

// ── Schema version ────────────────────────────────────────────────────────────

export const ANALYZER_SCHEMA_VERSION = 1;

// ── Status enum ───────────────────────────────────────────────────────────────

/**
 * Top-level status codes for AnalyzerResult.
 * Written to the `status` field in every persisted record.
 * @enum {string}
 */
export const ANALYZER_STATUS = Object.freeze({
  /** Analysis succeeded with full confidence. */
  OK:               "ok",
  /** Analysis produced results with partial data (some inputs invalid/missing). */
  DEGRADED:         "degraded",
  /** Insufficient samples to produce reliable results. */
  INSUFFICIENT_DATA:"insufficient_data",
  /** Hard error — input was invalid or unparseable. */
  ERROR:            "error",
});

// ── Dimension enum ────────────────────────────────────────────────────────────

/**
 * Impact dimension values. All four dimensions must be covered in each analysis.
 * @enum {string}
 */
export const IMPACT_DIMENSION = Object.freeze({
  THROUGHPUT: "throughput",
  QUALITY:    "quality",
  COST:       "cost",
  FAILURE:    "failure",
});

// ── Order enum ────────────────────────────────────────────────────────────────

/**
 * Impact order: whether this is a direct or cascading effect.
 * @enum {string}
 */
export const IMPACT_ORDER = Object.freeze({
  FIRST:  "first",
  SECOND: "second",
});

// ── Direction enum ────────────────────────────────────────────────────────────

/**
 * Impact direction derived deterministically from magnitude.
 *   positive  : magnitude > 0
 *   negative  : magnitude < 0
 *   neutral   : magnitude === 0
 * @enum {string}
 */
export const IMPACT_DIRECTION = Object.freeze({
  POSITIVE: "positive",
  NEGATIVE: "negative",
  NEUTRAL:  "neutral",
});

// ── Mitigation reason code enum ───────────────────────────────────────────────

/**
 * Reason codes for mitigation recommendations.
 * Each code maps to one impacted dimension or compound event.
 * @enum {string}
 */
export const MITIGATION_REASON_CODE = Object.freeze({
  NEGATIVE_THROUGHPUT: "NEGATIVE_THROUGHPUT",
  NEGATIVE_QUALITY:    "NEGATIVE_QUALITY",
  NEGATIVE_COST:       "NEGATIVE_COST",
  NEGATIVE_FAILURE:    "NEGATIVE_FAILURE",
  COMPOUNDED_NEGATIVE: "COMPOUNDED_NEGATIVE",
});

// ── Analyzer reason code enum (validation errors) ─────────────────────────────

/**
 * Reason codes used in validation results and degraded-state records.
 * Distinguishes missing input from invalid input (Athena item 7 resolved).
 * @enum {string}
 */
export const ANALYZER_REASON_CODE = Object.freeze({
  /** Input is null, undefined, or absent. */
  MISSING_INPUT:  "MISSING_INPUT",
  /** Input is present but fails schema validation. */
  INVALID_INPUT:  "INVALID_INPUT",
  /** sampleCount < MIN_SAMPLE_THRESHOLD — results exist but are low-confidence. */
  SPARSE_DATA:    "SPARSE_DATA",
  /** File write operation failed. */
  WRITE_FAILED:   "WRITE_FAILED",
  /** Unexpected error during computation. */
  COMPUTE_ERROR:  "COMPUTE_ERROR",
});

// ── Priority enum ─────────────────────────────────────────────────────────────

/**
 * Mitigation priority levels, derived from magnitude severity.
 * @enum {string}
 */
export const MITIGATION_PRIORITY = Object.freeze({
  LOW:      "low",
  MEDIUM:   "medium",
  HIGH:     "high",
  CRITICAL: "critical",
});

// ── Deterministic thresholds ──────────────────────────────────────────────────

/** Minimum sample count for full confidence (1.0). Below this, confidence is penalized. */
export const CONFIDENCE_THRESHOLD = 5;

/** Minimum sample count to avoid SPARSE_DATA status. */
export const MIN_SAMPLE_THRESHOLD = 3;

/** Magnitude below this threshold (exclusive) triggers mitigation recommendations. */
export const NEGATIVE_MAGNITUDE_THRESHOLD = -0.1;

/** Magnitude below this absolute value is considered noise and ignored for second-order. */
export const SECOND_ORDER_NOISE_FLOOR = 0.05;

/** Number of top contributors included in the monthly report. */
export const MONTHLY_REPORT_TOP_N = 5;

// ── Schema contract ───────────────────────────────────────────────────────────

/**
 * Canonical schema descriptor for compounding_effects_latest.json and
 * compounding_effects_monthly_{YYYY-MM}.json.
 *
 * Required fields on every persisted AnalyzerResult:
 *   schemaVersion, status, generatedAt, interventionCount,
 *   impactVectors, mitigationRecommendations, negativeEffectCount
 *
 * Required fields on every ImpactVector:
 *   dimension, order, interventionId, magnitude, direction,
 *   confidence, confidenceLevel, evidence
 *
 * Required fields on every MitigationRecommendation:
 *   interventionId, reason, reasonCode, recommendation,
 *   priority, affectedDimensions
 */
export const ANALYZER_SCHEMA = Object.freeze({
  schemaVersion: ANALYZER_SCHEMA_VERSION,

  requiredResultFields: Object.freeze([
    "schemaVersion", "status", "generatedAt",
    "interventionCount", "impactVectors",
    "mitigationRecommendations", "negativeEffectCount",
  ]),

  requiredImpactVectorFields: Object.freeze([
    "dimension", "order", "interventionId", "magnitude",
    "direction", "confidence", "confidenceLevel", "evidence",
  ]),

  requiredMitigationFields: Object.freeze([
    "interventionId", "reason", "reasonCode",
    "recommendation", "priority", "affectedDimensions",
  ]),

  statusEnum:          Object.freeze(Object.values(ANALYZER_STATUS)),
  dimensionEnum:       Object.freeze(Object.values(IMPACT_DIMENSION)),
  orderEnum:           Object.freeze(Object.values(IMPACT_ORDER)),
  directionEnum:       Object.freeze(Object.values(IMPACT_DIRECTION)),
  mitigationCodeEnum:  Object.freeze(Object.values(MITIGATION_REASON_CODE)),
  priorityEnum:        Object.freeze(Object.values(MITIGATION_PRIORITY)),
  confidenceLevelEnum: Object.freeze(["high", "medium", "low"]),
});

// ── Cross-dimension cascade matrix ────────────────────────────────────────────

/**
 * Multiplier applied to a first-order magnitude to derive the second-order magnitude
 * on a different dimension. Zero entries are omitted (no cascade).
 *
 * Semantics: CROSS_IMPACT_MATRIX[sourceDimension][targetDimension] = multiplier
 *   Positive multiplier → target moves in the SAME direction as source.
 *   Negative multiplier → target moves in the OPPOSITE direction from source.
 *
 * Rationale:
 *   throughput → quality (-0.3): speed-quality tradeoff; faster delivery often lowers quality
 *   throughput → failure (+0.2): higher throughput may introduce more errors
 *   quality → throughput (+0.2): better quality reduces rework, improving throughput
 *   quality → failure (-0.4): higher quality directly reduces failure rate
 *   quality → cost (-0.2): higher quality typically reduces waste/rework costs
 *   cost → throughput (-0.2): higher cost may constrain worker spawns, reducing throughput
 *   cost → failure (+0.1): cutting costs may increase failure risk
 *   failure → throughput (-0.3): failures block pipeline, reducing throughput
 *   failure → quality (-0.3): systemic failures correlate with quality degradation
 *   failure → cost (+0.3): failures drive incident costs up
 */
export const CROSS_IMPACT_MATRIX = Object.freeze({
  [IMPACT_DIMENSION.THROUGHPUT]: Object.freeze({
    [IMPACT_DIMENSION.QUALITY]:  -0.3,
    [IMPACT_DIMENSION.FAILURE]:  +0.2,
  }),
  [IMPACT_DIMENSION.QUALITY]: Object.freeze({
    [IMPACT_DIMENSION.THROUGHPUT]: +0.2,
    [IMPACT_DIMENSION.FAILURE]:    -0.4,
    [IMPACT_DIMENSION.COST]:       -0.2,
  }),
  [IMPACT_DIMENSION.COST]: Object.freeze({
    [IMPACT_DIMENSION.THROUGHPUT]: -0.2,
    [IMPACT_DIMENSION.FAILURE]:    +0.1,
  }),
  [IMPACT_DIMENSION.FAILURE]: Object.freeze({
    [IMPACT_DIMENSION.THROUGHPUT]: -0.3,
    [IMPACT_DIMENSION.QUALITY]:    -0.3,
    [IMPACT_DIMENSION.COST]:       +0.3,
  }),
});

// ── Pure computation functions ────────────────────────────────────────────────

/**
 * Compute confidence ∈ [0.0, 1.0] from sampleCount.
 *
 * confidence = min(1.0, sampleCount / CONFIDENCE_THRESHOLD)
 *
 * @param {number} sampleCount — integer >= 0
 * @returns {number}
 */
export function computeConfidence(sampleCount) {
  const n = Math.max(0, Number(sampleCount) || 0);
  return Math.min(1.0, n / CONFIDENCE_THRESHOLD);
}

/**
 * Derive confidence level label from a confidence value.
 *
 * high:   confidence >= 0.8
 * medium: confidence >= 0.5
 * low:    confidence < 0.5
 *
 * @param {number} confidence — float ∈ [0.0, 1.0]
 * @returns {"high"|"medium"|"low"}
 */
export function computeConfidenceLevel(confidence) {
  const c = Number(confidence) || 0;
  if (c >= 0.8) return "high";
  if (c >= 0.5) return "medium";
  return "low";
}

/**
 * Derive impact direction from magnitude.
 *
 * @param {number} magnitude — float ∈ [-1.0, 1.0]
 * @returns {IMPACT_DIRECTION}
 */
export function computeImpactDirection(magnitude) {
  const m = Number(magnitude) || 0;
  if (m > 0) return IMPACT_DIRECTION.POSITIVE;
  if (m < 0) return IMPACT_DIRECTION.NEGATIVE;
  return IMPACT_DIRECTION.NEUTRAL;
}

/**
 * Clamp magnitude to [-1.0, 1.0].
 *
 * @param {number} value
 * @returns {number}
 */
function clampMagnitude(value) {
  const v = Number(value) || 0;
  return Math.max(-1.0, Math.min(1.0, v));
}

/**
 * Derive mitigation priority from magnitude.
 *
 * critical : magnitude <= -0.7
 * high     : magnitude <= -0.4
 * medium   : magnitude <= -0.1
 * low      : magnitude > -0.1 (below negative threshold, shouldn't happen but safe)
 *
 * @param {number} magnitude
 * @returns {MITIGATION_PRIORITY}
 */
export function deriveMitigationPriority(magnitude) {
  const m = Number(magnitude) || 0;
  if (m <= -0.7) return MITIGATION_PRIORITY.CRITICAL;
  if (m <= -0.4) return MITIGATION_PRIORITY.HIGH;
  if (m <= -0.1) return MITIGATION_PRIORITY.MEDIUM;
  return MITIGATION_PRIORITY.LOW;
}

// ── Input validation ──────────────────────────────────────────────────────────

/**
 * Validate a single intervention input.
 *
 * Required fields:
 *   id           {string}
 *   metrics      {object}
 *     throughputDelta {number} ∈ [-1, 1]
 *     qualityDelta    {number} ∈ [-1, 1]
 *     costDelta       {number} ∈ [-1, 1]
 *     failureDelta    {number} ∈ [-1, 1]
 *     sampleCount     {integer} >= 0
 *
 * Distinguishes missing input (null/undefined) from invalid input (wrong type/range).
 *
 * @param {any} intervention
 * @returns {{ ok: boolean, reasonCode?: string, reason?: string }}
 */
export function validateIntervention(intervention) {
  if (intervention === null || intervention === undefined) {
    return { ok: false, reasonCode: ANALYZER_REASON_CODE.MISSING_INPUT,
      reason: "MISSING_INPUT: intervention is null or undefined" };
  }
  if (typeof intervention !== "object" || Array.isArray(intervention)) {
    return { ok: false, reasonCode: ANALYZER_REASON_CODE.INVALID_INPUT,
      reason: "INVALID_INPUT: intervention must be a non-array object" };
  }
  if (!intervention.id || typeof intervention.id !== "string") {
    return { ok: false, reasonCode: ANALYZER_REASON_CODE.INVALID_INPUT,
      reason: "INVALID_INPUT: intervention.id must be a non-empty string" };
  }
  if (!intervention.metrics || typeof intervention.metrics !== "object") {
    return { ok: false, reasonCode: ANALYZER_REASON_CODE.INVALID_INPUT,
      reason: "INVALID_INPUT: intervention.metrics must be an object" };
  }
  const DELTA_FIELDS = ["throughputDelta", "qualityDelta", "costDelta", "failureDelta"];
  for (const field of DELTA_FIELDS) {
    const v = intervention.metrics[field];
    if (v === undefined || v === null) {
      return { ok: false, reasonCode: ANALYZER_REASON_CODE.INVALID_INPUT,
        reason: `INVALID_INPUT: intervention.metrics.${field} is required` };
    }
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { ok: false, reasonCode: ANALYZER_REASON_CODE.INVALID_INPUT,
        reason: `INVALID_INPUT: intervention.metrics.${field} must be a finite number` };
    }
    if (v < -1.0 || v > 1.0) {
      return { ok: false, reasonCode: ANALYZER_REASON_CODE.INVALID_INPUT,
        reason: `INVALID_INPUT: intervention.metrics.${field} must be ∈ [-1.0, 1.0], got ${v}` };
    }
  }
  const sc = intervention.metrics.sampleCount;
  if (sc === undefined || sc === null) {
    return { ok: false, reasonCode: ANALYZER_REASON_CODE.INVALID_INPUT,
      reason: "INVALID_INPUT: intervention.metrics.sampleCount is required" };
  }
  if (typeof sc !== "number" || !Number.isInteger(sc) || sc < 0) {
    return { ok: false, reasonCode: ANALYZER_REASON_CODE.INVALID_INPUT,
      reason: "INVALID_INPUT: intervention.metrics.sampleCount must be a non-negative integer" };
  }
  return { ok: true };
}

// ── First-order vector construction ──────────────────────────────────────────

/**
 * Build first-order ImpactVector objects for a single intervention.
 *
 * One vector is emitted per dimension with a non-zero delta.
 * sampleCount below MIN_SAMPLE_THRESHOLD results in a low confidence score
 * but vectors are still returned (status control is handled by the caller).
 *
 * @param {object} intervention — validated intervention object
 * @returns {object[]} — ImpactVector[]
 */
export function buildFirstOrderVectors(intervention) {
  const { id, metrics } = intervention;
  const sampleCount = Number(metrics.sampleCount) || 0;
  const confidence  = computeConfidence(sampleCount);
  const confLevel   = computeConfidenceLevel(confidence);
  const evidence    = Array.isArray(intervention.evidence) ? [...intervention.evidence] : [];

  const dimensionDeltas = [
    [IMPACT_DIMENSION.THROUGHPUT, metrics.throughputDelta],
    [IMPACT_DIMENSION.QUALITY,    metrics.qualityDelta],
    [IMPACT_DIMENSION.COST,       metrics.costDelta],
    [IMPACT_DIMENSION.FAILURE,    metrics.failureDelta],
  ];

  const vectors = [];
  for (const [dimension, rawDelta] of dimensionDeltas) {
    const magnitude = clampMagnitude(rawDelta);
    vectors.push({
      dimension,
      order:          IMPACT_ORDER.FIRST,
      interventionId: String(id),
      magnitude,
      direction:      computeImpactDirection(magnitude),
      confidence,
      confidenceLevel: confLevel,
      evidence,
    });
  }
  return vectors;
}

// ── Second-order vector construction ─────────────────────────────────────────

/**
 * Compute second-order ImpactVector objects from a set of first-order vectors.
 *
 * For each first-order vector with |magnitude| > SECOND_ORDER_NOISE_FLOOR,
 * apply the cross-dimension cascade matrix to derive second-order effects.
 * Only non-zero cascade entries are emitted. Magnitude is clamped to [-1, 1].
 *
 * @param {object[]} firstOrderVectors — ImpactVector[] with order="first"
 * @returns {object[]} — ImpactVector[] with order="second"
 */
export function buildSecondOrderVectors(firstOrderVectors) {
  const secondOrder = [];

  for (const vec of firstOrderVectors) {
    if (Math.abs(vec.magnitude) < SECOND_ORDER_NOISE_FLOOR) continue;

    const cascadeRow = CROSS_IMPACT_MATRIX[vec.dimension];
    if (!cascadeRow) continue;

    for (const [targetDimension, multiplier] of Object.entries(cascadeRow)) {
      const rawMagnitude = vec.magnitude * Number(multiplier);
      if (Math.abs(rawMagnitude) < SECOND_ORDER_NOISE_FLOOR) continue;

      const magnitude = clampMagnitude(rawMagnitude);
      secondOrder.push({
        dimension:      targetDimension,
        order:          IMPACT_ORDER.SECOND,
        interventionId: vec.interventionId,
        magnitude,
        direction:      computeImpactDirection(magnitude),
        confidence:     vec.confidence,
        confidenceLevel: vec.confidenceLevel,
        evidence:       [`cascade:${vec.dimension}->${targetDimension}`],
      });
    }
  }
  return secondOrder;
}

// ── Negative effect detection ─────────────────────────────────────────────────

/**
 * Return vectors whose magnitude is below NEGATIVE_MAGNITUDE_THRESHOLD.
 *
 * @param {object[]} vectors — ImpactVector[]
 * @returns {object[]}
 */
export function detectNegativeEffects(vectors) {
  return vectors.filter(v => Number(v.magnitude) < NEGATIVE_MAGNITUDE_THRESHOLD);
}

// ── Mitigation recommendation construction ────────────────────────────────────

/**
 * Build MitigationRecommendation objects for each negative-effect vector.
 *
 * Deduplication: one recommendation per (interventionId, reasonCode) pair.
 * When both first and second order are negative for the same intervention+dimension,
 * they are collapsed into a single COMPOUNDED_NEGATIVE recommendation.
 *
 * @param {object[]} negativeVectors — ImpactVector[] with magnitude < threshold
 * @returns {object[]} — MitigationRecommendation[]
 */
export function buildMitigationRecommendations(negativeVectors) {
  /** @type {Map<string, object>} key = `${interventionId}::${reasonCode}` */
  const seen = new Map();
  const recommendations = [];

  const DIMENSION_REASON = {
    [IMPACT_DIMENSION.THROUGHPUT]: MITIGATION_REASON_CODE.NEGATIVE_THROUGHPUT,
    [IMPACT_DIMENSION.QUALITY]:    MITIGATION_REASON_CODE.NEGATIVE_QUALITY,
    [IMPACT_DIMENSION.COST]:       MITIGATION_REASON_CODE.NEGATIVE_COST,
    [IMPACT_DIMENSION.FAILURE]:    MITIGATION_REASON_CODE.NEGATIVE_FAILURE,
  };

  const DIMENSION_ADVICE = {
    [IMPACT_DIMENSION.THROUGHPUT]: "Review throughput-impacting changes; consider batching or A/B testing before full rollout",
    [IMPACT_DIMENSION.QUALITY]:    "Add quality gates (tests, reviews) before enabling this intervention in production",
    [IMPACT_DIMENSION.COST]:       "Audit resource consumption and apply budget caps or efficiency optimizations",
    [IMPACT_DIMENSION.FAILURE]:    "Introduce canary deployment or feature flag to limit blast radius of this intervention",
  };

  // Group by interventionId to detect compounded negatives
  const byIntervention = new Map();
  for (const vec of negativeVectors) {
    const iid = String(vec.interventionId);
    if (!byIntervention.has(iid)) byIntervention.set(iid, []);
    byIntervention.get(iid).push(vec);
  }

  for (const [interventionId, vecs] of byIntervention) {
    const affectedDimensions = [...new Set(vecs.map(v => v.dimension))];
    const hasSecondOrder     = vecs.some(v => v.order === IMPACT_ORDER.SECOND);
    const minMagnitude       = Math.min(...vecs.map(v => Number(v.magnitude)));
    const priority           = deriveMitigationPriority(minMagnitude);

    if (hasSecondOrder && affectedDimensions.length > 1) {
      // Compounded negative spanning multiple dimensions
      const key = `${interventionId}::${MITIGATION_REASON_CODE.COMPOUNDED_NEGATIVE}`;
      if (!seen.has(key)) {
        seen.set(key, true);
        recommendations.push({
          interventionId,
          reason:             `Compounded negative effects detected across: ${affectedDimensions.join(", ")}`,
          reasonCode:         MITIGATION_REASON_CODE.COMPOUNDED_NEGATIVE,
          recommendation:     "Halt or gate this intervention immediately; cascading negative effects indicate systemic risk",
          priority:           priority === MITIGATION_PRIORITY.MEDIUM ? MITIGATION_PRIORITY.HIGH : priority,
          affectedDimensions,
        });
      }
    } else {
      // Individual per-dimension recommendations
      for (const vec of vecs) {
        const reasonCode = DIMENSION_REASON[vec.dimension] || MITIGATION_REASON_CODE.COMPOUNDED_NEGATIVE;
        const key        = `${interventionId}::${reasonCode}`;
        if (seen.has(key)) continue;
        seen.set(key, true);
        recommendations.push({
          interventionId,
          reason:             `Negative ${vec.dimension} effect (magnitude ${Number(vec.magnitude).toFixed(3)}, order=${vec.order})`,
          reasonCode,
          recommendation:     DIMENSION_ADVICE[vec.dimension] || "Investigate and mitigate this intervention",
          priority:           deriveMitigationPriority(Number(vec.magnitude)),
          affectedDimensions: [vec.dimension],
        });
      }
    }
  }
  return recommendations;
}

// ── Main analysis function ────────────────────────────────────────────────────

/**
 * Analyze compounding effects for a list of interventions.
 *
 * Returns a structured AnalyzerResult. Never throws.
 *
 * Input validation:
 *   - null/undefined interventions array → MISSING_INPUT, status=error
 *   - non-array value                   → INVALID_INPUT, status=error
 *   - empty array                       → status=insufficient_data
 *   - any intervention below MIN_SAMPLE_THRESHOLD → status=degraded with SPARSE_DATA reason
 *   - invalid individual interventions are skipped; skippedCount reflects this
 *
 * Status field enum (Athena item 8 resolved):
 *   ok | degraded | insufficient_data | error
 *
 * @param {any} interventions — array of intervention objects
 * @returns {object} — AnalyzerResult
 */
export function analyzeCompoundingEffects(interventions) {
  const generatedAt = new Date().toISOString();

  // ── Missing vs invalid input (Athena item 9 resolved) ──────────────────────
  if (interventions === null || interventions === undefined) {
    return {
      schemaVersion:           ANALYZER_SCHEMA_VERSION,
      status:                  ANALYZER_STATUS.ERROR,
      statusReason:            ANALYZER_REASON_CODE.MISSING_INPUT,
      generatedAt,
      interventionCount:       0,
      impactVectors:           [],
      mitigationRecommendations: [],
      negativeEffectCount:     0,
      skippedCount:            0,
      sparseDataCount:         0,
    };
  }
  if (!Array.isArray(interventions)) {
    return {
      schemaVersion:           ANALYZER_SCHEMA_VERSION,
      status:                  ANALYZER_STATUS.ERROR,
      statusReason:            ANALYZER_REASON_CODE.INVALID_INPUT,
      generatedAt,
      interventionCount:       0,
      impactVectors:           [],
      mitigationRecommendations: [],
      negativeEffectCount:     0,
      skippedCount:            0,
      sparseDataCount:         0,
    };
  }
  if (interventions.length === 0) {
    return {
      schemaVersion:           ANALYZER_SCHEMA_VERSION,
      status:                  ANALYZER_STATUS.INSUFFICIENT_DATA,
      statusReason:            ANALYZER_REASON_CODE.SPARSE_DATA,
      generatedAt,
      interventionCount:       0,
      impactVectors:           [],
      mitigationRecommendations: [],
      negativeEffectCount:     0,
      skippedCount:            0,
      sparseDataCount:         0,
    };
  }

  const allFirstOrder  = [];
  const allSecondOrder = [];
  let skippedCount     = 0;
  let sparseDataCount  = 0;

  for (const intervention of interventions) {
    const validation = validateIntervention(intervention);
    if (!validation.ok) {
      skippedCount += 1;
      continue;
    }
    // Sparse data check (Athena item 6 resolved)
    if (Number(intervention.metrics.sampleCount) < MIN_SAMPLE_THRESHOLD) {
      sparseDataCount += 1;
    }

    const firstOrder  = buildFirstOrderVectors(intervention);
    const secondOrder = buildSecondOrderVectors(firstOrder);
    allFirstOrder.push(...firstOrder);
    allSecondOrder.push(...secondOrder);
  }

  const validCount       = interventions.length - skippedCount;
  const allVectors       = [...allFirstOrder, ...allSecondOrder];
  const negativeVectors  = detectNegativeEffects(allVectors);
  const recommendations  = buildMitigationRecommendations(negativeVectors);

  // Determine status (Athena item 8 resolved — explicit enum)
  let status;
  let statusReason;
  if (validCount === 0) {
    status       = ANALYZER_STATUS.ERROR;
    statusReason = ANALYZER_REASON_CODE.INVALID_INPUT;
  } else if (sparseDataCount > 0 && validCount <= sparseDataCount) {
    status       = ANALYZER_STATUS.INSUFFICIENT_DATA;
    statusReason = ANALYZER_REASON_CODE.SPARSE_DATA;
  } else if (sparseDataCount > 0 || skippedCount > 0) {
    status       = ANALYZER_STATUS.DEGRADED;
    statusReason = skippedCount > 0 ? ANALYZER_REASON_CODE.INVALID_INPUT : ANALYZER_REASON_CODE.SPARSE_DATA;
  } else {
    status       = ANALYZER_STATUS.OK;
    statusReason = null;
  }

  return {
    schemaVersion:             ANALYZER_SCHEMA_VERSION,
    status,
    statusReason,
    generatedAt,
    interventionCount:         validCount,
    impactVectors:             allVectors,
    mitigationRecommendations: recommendations,
    negativeEffectCount:       negativeVectors.length,
    skippedCount,
    sparseDataCount,
  };
}

// ── Monthly report generation ─────────────────────────────────────────────────

/**
 * Generate a monthly compounding-effects report from persisted per-run data.
 *
 * Reads state/compounding_effects_latest.json (or provided results) and aggregates
 * the top-N compounding contributors for the given month.
 *
 * Top-N selection formula:
 *   score = |magnitude| × confidence × (order === "second" ? 1.5 : 1.0)
 *   Sorted descending; top MONTHLY_REPORT_TOP_N returned.
 *
 * Output file: state/compounding_effects_monthly_{YYYY-MM}.json
 * Top-N count: MONTHLY_REPORT_TOP_N (= 5)
 * Trigger: called explicitly; no automatic scheduling built in.
 *
 * @param {object[]} analyzerResults — array of AnalyzerResult objects for the month
 * @param {string}   monthKey        — "YYYY-MM"
 * @returns {object} — MonthlyCompoundingReport
 */
export function buildMonthlyCompoundingReport(analyzerResults, monthKey) {
  const generatedAt = new Date().toISOString();

  if (!Array.isArray(analyzerResults) || analyzerResults.length === 0) {
    return {
      schemaVersion:   ANALYZER_SCHEMA_VERSION,
      monthKey:        String(monthKey || ""),
      generatedAt,
      status:          ANALYZER_STATUS.INSUFFICIENT_DATA,
      statusReason:    ANALYZER_REASON_CODE.SPARSE_DATA,
      topContributors: [],
      totalVectors:    0,
      totalNegative:   0,
      runCount:        0,
    };
  }

  // Aggregate all vectors from all runs in the month
  const allVectors = [];
  for (const result of analyzerResults) {
    if (Array.isArray(result?.impactVectors)) {
      allVectors.push(...result.impactVectors);
    }
  }

  if (allVectors.length === 0) {
    return {
      schemaVersion:   ANALYZER_SCHEMA_VERSION,
      monthKey:        String(monthKey || ""),
      generatedAt,
      status:          ANALYZER_STATUS.INSUFFICIENT_DATA,
      statusReason:    ANALYZER_REASON_CODE.SPARSE_DATA,
      topContributors: [],
      totalVectors:    0,
      totalNegative:   0,
      runCount:        analyzerResults.length,
    };
  }

  // Score each vector
  const scored = allVectors.map(v => ({
    ...v,
    _score: Math.abs(Number(v.magnitude)) * Number(v.confidence) *
            (v.order === IMPACT_ORDER.SECOND ? 1.5 : 1.0),
  }));

  scored.sort((a, b) => b._score - a._score);
  const topN = scored.slice(0, MONTHLY_REPORT_TOP_N);

  // Strip internal score field
  const topContributors = topN.map(({ _score: _s, ...rest }) => rest);

  const negativeCount = allVectors.filter(
    v => Number(v.magnitude) < NEGATIVE_MAGNITUDE_THRESHOLD
  ).length;

  return {
    schemaVersion:   ANALYZER_SCHEMA_VERSION,
    monthKey:        String(monthKey || ""),
    generatedAt,
    status:          ANALYZER_STATUS.OK,
    statusReason:    null,
    topContributors,
    totalVectors:    allVectors.length,
    totalNegative:   negativeCount,
    runCount:        analyzerResults.length,
  };
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * Persist a compounding-effects analysis result to state/.
 *
 * Writes:
 *   state/compounding_effects_latest.json   — always overwritten
 *   state/compounding_effects_log.json      — append-only log (capped at 100 entries)
 *
 * Input validation:
 *   - null/undefined result → MISSING_INPUT
 *   - non-object or missing required fields → INVALID_INPUT
 *   - write failure → WRITE_FAILED (never silently dropped)
 *
 * @param {object} config — box config with config.paths.stateDir
 * @param {object} result — AnalyzerResult from analyzeCompoundingEffects()
 * @returns {Promise<{ ok: boolean, filePath?: string, reason?: string }>}
 */
export async function persistCompoundingEffectsResult(config, result) {
  if (result === null || result === undefined) {
    return { ok: false, reason: "MISSING_INPUT: result is null or undefined" };
  }
  if (typeof result !== "object" || Array.isArray(result)) {
    return { ok: false, reason: "INVALID_INPUT: result must be a non-array object" };
  }
  for (const field of ANALYZER_SCHEMA.requiredResultFields) {
    if (!(field in result)) {
      return { ok: false, reason: `INVALID_INPUT: missing required field "${field}"` };
    }
  }

  const stateDir   = config?.paths?.stateDir || "state";
  const latestPath = path.join(stateDir, "compounding_effects_latest.json");
  const logPath    = path.join(stateDir, "compounding_effects_log.json");

  try {
    await ensureParent(latestPath);
    await writeJson(latestPath, { ...result, savedAt: new Date().toISOString() });

    // Append to rolling log
    const log = await readJson(logPath, { schemaVersion: ANALYZER_SCHEMA_VERSION, entries: [] });
    const entries = Array.isArray(log.entries) ? log.entries : [];
    entries.push({ ...result, savedAt: new Date().toISOString() });
    log.entries   = entries.length > 100 ? entries.slice(-100) : entries;
    log.updatedAt = new Date().toISOString();
    await writeJson(logPath, log);

    return { ok: true, filePath: latestPath };
  } catch (err) {
    return { ok: false, reason: `WRITE_FAILED: ${String(err?.message || err)}` };
  }
}

/**
 * Persist a monthly compounding-effects report to state/.
 *
 * Output path: state/compounding_effects_monthly_{YYYY-MM}.json
 *
 * @param {object} config — box config with config.paths.stateDir
 * @param {object} report — MonthlyCompoundingReport from buildMonthlyCompoundingReport()
 * @returns {Promise<{ ok: boolean, filePath?: string, reason?: string }>}
 */
export async function persistMonthlyCompoundingReport(config, report) {
  if (report === null || report === undefined) {
    return { ok: false, reason: "MISSING_INPUT: report is null or undefined" };
  }
  if (typeof report !== "object" || Array.isArray(report)) {
    return { ok: false, reason: "INVALID_INPUT: report must be a non-array object" };
  }
  const monthKey = String(report?.monthKey || "");
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    return { ok: false, reason: `INVALID_INPUT: monthKey must be "YYYY-MM", got "${monthKey}"` };
  }

  const stateDir  = config?.paths?.stateDir || "state";
  const filePath  = path.join(stateDir, `compounding_effects_monthly_${monthKey}.json`);

  try {
    await ensureParent(filePath);
    await writeJson(filePath, report);
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, reason: `WRITE_FAILED: ${String(err?.message || err)}` };
  }
}

/**
 * Generate and persist a monthly compounding-effects report from the rolling log.
 *
 * Reads state/compounding_effects_log.json, filters to the given month,
 * builds the report, and writes state/compounding_effects_monthly_{YYYY-MM}.json.
 *
 * @param {object} config   — box config with config.paths.stateDir
 * @param {string} monthKey — "YYYY-MM"
 * @returns {Promise<{ ok: boolean, filePath?: string, report?: object, reason?: string }>}
 */
export async function generateAndPersistMonthlyReport(config, monthKey) {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) {
    return { ok: false, reason: `INVALID_INPUT: monthKey must be "YYYY-MM", got "${monthKey}"` };
  }

  const stateDir = config?.paths?.stateDir || "state";
  const logPath  = path.join(stateDir, "compounding_effects_log.json");

  let log;
  try {
    log = await readJson(logPath, { schemaVersion: ANALYZER_SCHEMA_VERSION, entries: [] });
  } catch (err) {
    return { ok: false, reason: `WRITE_FAILED: ${String(err?.message || err)}` };
  }

  const [year, month] = monthKey.split("-").map(Number);
  const monthStart    = new Date(Date.UTC(year, month - 1, 1)).getTime();
  const monthEnd      = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)).getTime();

  const entries = Array.isArray(log.entries) ? log.entries : [];
  const monthEntries = entries.filter(e => {
    const ts = new Date(e?.generatedAt || e?.savedAt || 0).getTime();
    return Number.isFinite(ts) && ts >= monthStart && ts <= monthEnd;
  });

  const report = buildMonthlyCompoundingReport(monthEntries, monthKey);
  const persist = await persistMonthlyCompoundingReport(config, report);
  if (!persist.ok) return persist;

  return { ok: true, filePath: persist.filePath, report };
}
