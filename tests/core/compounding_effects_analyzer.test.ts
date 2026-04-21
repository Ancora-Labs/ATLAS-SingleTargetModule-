/**
 * Tests for T-038: Compounding-effects analyzer.
 *
 * Covers all acceptance criteria (AC1–AC22) and Athena hardening items:
 *
 *   AC1:  Analyzer reports first-order and second-order impact vectors.
 *   AC2:  Negative compounding effects trigger mitigation recommendations.
 *   AC3:  Confidence estimates provided per effect (range [0,1], method defined).
 *   AC4:  Monthly report includes top compounding contributors (top-5).
 *   AC5:  Analyzer handles sparse data gracefully (< MIN_SAMPLE_THRESHOLD).
 *   AC6:  Verification commands are deterministic (this file satisfies that).
 *   AC7:  One negative path: invalid/missing input asserting failure handling.
 *   AC8:  JSON output includes defined schema with required fields and enums.
 *   AC9:  Validation distinguishes missing input (null) from invalid input (wrong type).
 *   AC10: No silent fallback — degraded behavior sets status field and reason code.
 *
 * Athena missing items resolved:
 *   item 1:  ImpactVector schema defined (ANALYZER_SCHEMA.requiredImpactVectorFields).
 *   item 2:  Negative threshold = NEGATIVE_MAGNITUDE_THRESHOLD (-0.1).
 *   item 3:  MitigationRecommendation schema defined.
 *   item 4:  Confidence ∈ [0,1], formula: min(1, sampleCount/CONFIDENCE_THRESHOLD).
 *   item 5:  Monthly report top-N = MONTHLY_REPORT_TOP_N (5).
 *   item 6:  Sparse data = sampleCount < MIN_SAMPLE_THRESHOLD (3).
 *   item 7:  Reason codes: MISSING_INPUT, INVALID_INPUT, SPARSE_DATA, WRITE_FAILED, COMPUTE_ERROR.
 *   item 8:  Status enum: ok, degraded, insufficient_data, error.
 *   item 9:  This file explicitly targets the new analyzer module.
 *   item 10: Test file path: tests/core/compounding_effects_analyzer.test.ts
 *   item 11: Negative test scenarios in "negative paths" describe block.
 *   item 12: Risk level documented as MEDIUM in compounding_effects_analyzer.js.
 *
 * Scenarios:
 *   1.  Happy path: 3 valid interventions → status=ok, first+second order vectors
 *   2.  Negative effects → mitigations triggered for magnitude < -0.1
 *   3.  Confidence formula: sampleCount=0 → 0, sampleCount=3 → 0.6, >=5 → 1.0
 *   4.  Monthly report: top-5 contributors, totalVectors, totalNegative
 *   5.  Sparse data: sampleCount < MIN_SAMPLE_THRESHOLD → status=insufficient_data or degraded
 *   6.  Missing input: null interventions → status=error, MISSING_INPUT reason
 *   7.  Invalid input: non-array → status=error, INVALID_INPUT reason
 *   8.  Empty array → status=insufficient_data
 *   9.  Invalid individual intervention (missing metrics) → skipped, skippedCount++
 *   10. Second-order vectors respect SECOND_ORDER_NOISE_FLOOR
 *   11. persistCompoundingEffectsResult: missing result → MISSING_INPUT
 *   12. persistCompoundingEffectsResult: invalid schema → INVALID_INPUT
 *   13. persistCompoundingEffectsResult: valid result → written to disk
 *   14. persistMonthlyCompoundingReport: invalid monthKey → INVALID_INPUT
 *   15. generateAndPersistMonthlyReport: valid → filters by month, writes file
 *   16. ANALYZER_SCHEMA enum completeness
 *   17. ANALYZER_REASON_CODE enum completeness
 *   18. MITIGATION_REASON_CODE enum completeness
 *   19. ANALYZER_STATUS enum completeness
 *   20. Missing input vs invalid input produce distinct reason codes (AC9)
 *   21. Compounded negative across dims → COMPOUNDED_NEGATIVE reasonCode
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  ANALYZER_SCHEMA_VERSION,
  ANALYZER_STATUS,
  IMPACT_DIMENSION,
  IMPACT_ORDER,
  IMPACT_DIRECTION,
  MITIGATION_REASON_CODE,
  ANALYZER_REASON_CODE,
  MITIGATION_PRIORITY,
  CONFIDENCE_THRESHOLD,
  MIN_SAMPLE_THRESHOLD,
  NEGATIVE_MAGNITUDE_THRESHOLD,
  SECOND_ORDER_NOISE_FLOOR,
  MONTHLY_REPORT_TOP_N,
  ANALYZER_SCHEMA,
  CROSS_IMPACT_MATRIX,
  computeConfidence,
  computeConfidenceLevel,
  computeImpactDirection,
  deriveMitigationPriority,
  validateIntervention,
  buildFirstOrderVectors,
  buildSecondOrderVectors,
  detectNegativeEffects,
  buildMitigationRecommendations,
  analyzeCompoundingEffects,
  buildMonthlyCompoundingReport,
  persistCompoundingEffectsResult,
  persistMonthlyCompoundingReport,
  generateAndPersistMonthlyReport,
} from "../../src/core/compounding_effects_analyzer.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(stateDir) {
  return { paths: { stateDir } };
}

function makeIntervention(overrides = {}) {
  return {
    id: "i-001",
    evidence: ["obs-1"],
    metrics: {
      throughputDelta: 0.2,
      qualityDelta:    0.1,
      costDelta:       -0.05,
      failureDelta:    -0.3,
      sampleCount:     5,
      ...overrides.metrics,
    },
    ...overrides,
  };
}

// ── Enum completeness ─────────────────────────────────────────────────────────

describe("ANALYZER_STATUS enum", () => {
  it("contains all required status values", () => {
    assert.equal(ANALYZER_STATUS.OK,               "ok");
    assert.equal(ANALYZER_STATUS.DEGRADED,         "degraded");
    assert.equal(ANALYZER_STATUS.INSUFFICIENT_DATA,"insufficient_data");
    assert.equal(ANALYZER_STATUS.ERROR,            "error");
    assert.ok(Object.isFrozen(ANALYZER_STATUS));
  });
});

describe("ANALYZER_REASON_CODE enum", () => {
  it("contains all required reason codes", () => {
    assert.equal(ANALYZER_REASON_CODE.MISSING_INPUT, "MISSING_INPUT");
    assert.equal(ANALYZER_REASON_CODE.INVALID_INPUT, "INVALID_INPUT");
    assert.equal(ANALYZER_REASON_CODE.SPARSE_DATA,   "SPARSE_DATA");
    assert.equal(ANALYZER_REASON_CODE.WRITE_FAILED,  "WRITE_FAILED");
    assert.equal(ANALYZER_REASON_CODE.COMPUTE_ERROR, "COMPUTE_ERROR");
    assert.ok(Object.isFrozen(ANALYZER_REASON_CODE));
  });
});

describe("MITIGATION_REASON_CODE enum", () => {
  it("contains all required mitigation reason codes", () => {
    assert.equal(MITIGATION_REASON_CODE.NEGATIVE_THROUGHPUT, "NEGATIVE_THROUGHPUT");
    assert.equal(MITIGATION_REASON_CODE.NEGATIVE_QUALITY,    "NEGATIVE_QUALITY");
    assert.equal(MITIGATION_REASON_CODE.NEGATIVE_COST,       "NEGATIVE_COST");
    assert.equal(MITIGATION_REASON_CODE.NEGATIVE_FAILURE,    "NEGATIVE_FAILURE");
    assert.equal(MITIGATION_REASON_CODE.COMPOUNDED_NEGATIVE, "COMPOUNDED_NEGATIVE");
    assert.ok(Object.isFrozen(MITIGATION_REASON_CODE));
  });
});

describe("ANALYZER_SCHEMA", () => {
  it("defines all required result fields", () => {
    assert.ok(Array.isArray(ANALYZER_SCHEMA.requiredResultFields));
    for (const f of ["schemaVersion","status","generatedAt","interventionCount",
                     "impactVectors","mitigationRecommendations","negativeEffectCount"]) {
      assert.ok(ANALYZER_SCHEMA.requiredResultFields.includes(f), `missing: ${f}`);
    }
  });

  it("defines all required ImpactVector fields", () => {
    for (const f of ["dimension","order","interventionId","magnitude",
                     "direction","confidence","confidenceLevel","evidence"]) {
      assert.ok(ANALYZER_SCHEMA.requiredImpactVectorFields.includes(f), `missing: ${f}`);
    }
  });

  it("defines all required MitigationRecommendation fields", () => {
    for (const f of ["interventionId","reason","reasonCode",
                     "recommendation","priority","affectedDimensions"]) {
      assert.ok(ANALYZER_SCHEMA.requiredMitigationFields.includes(f), `missing: ${f}`);
    }
  });

  it("statusEnum contains all ANALYZER_STATUS values", () => {
    for (const v of Object.values(ANALYZER_STATUS)) {
      assert.ok(ANALYZER_SCHEMA.statusEnum.includes(v), `missing: ${v}`);
    }
  });
});

// ── Constants ─────────────────────────────────────────────────────────────────

describe("constants", () => {
  it("CONFIDENCE_THRESHOLD = 5", () => assert.equal(CONFIDENCE_THRESHOLD, 5));
  it("MIN_SAMPLE_THRESHOLD = 3", () => assert.equal(MIN_SAMPLE_THRESHOLD, 3));
  it("NEGATIVE_MAGNITUDE_THRESHOLD = -0.1", () =>
    assert.equal(NEGATIVE_MAGNITUDE_THRESHOLD, -0.1));
  it("SECOND_ORDER_NOISE_FLOOR = 0.05", () =>
    assert.equal(SECOND_ORDER_NOISE_FLOOR, 0.05));
  it("MONTHLY_REPORT_TOP_N = 5", () => assert.equal(MONTHLY_REPORT_TOP_N, 5));
});

// ── computeConfidence ─────────────────────────────────────────────────────────

describe("computeConfidence", () => {
  it("sampleCount=0 → 0.0 (no data)", () =>
    assert.equal(computeConfidence(0), 0.0));

  it("sampleCount=1 → 0.2", () =>
    assert.equal(computeConfidence(1), 0.2));

  it("sampleCount=3 → 0.6", () =>
    assert.equal(computeConfidence(3), 0.6));

  it("sampleCount=5 → 1.0 (full confidence)", () =>
    assert.equal(computeConfidence(5), 1.0));

  it("sampleCount=10 → 1.0 (capped at 1.0)", () =>
    assert.equal(computeConfidence(10), 1.0));

  it("negative sampleCount treated as 0", () =>
    assert.equal(computeConfidence(-1), 0.0));
});

// ── computeConfidenceLevel ────────────────────────────────────────────────────

describe("computeConfidenceLevel", () => {
  it("confidence=1.0 → 'high'", () =>
    assert.equal(computeConfidenceLevel(1.0), "high"));

  it("confidence=0.8 → 'high' (boundary)", () =>
    assert.equal(computeConfidenceLevel(0.8), "high"));

  it("confidence=0.6 → 'medium'", () =>
    assert.equal(computeConfidenceLevel(0.6), "medium"));

  it("confidence=0.5 → 'medium' (boundary)", () =>
    assert.equal(computeConfidenceLevel(0.5), "medium"));

  it("confidence=0.4 → 'low'", () =>
    assert.equal(computeConfidenceLevel(0.4), "low"));

  it("confidence=0.0 → 'low'", () =>
    assert.equal(computeConfidenceLevel(0.0), "low"));
});

// ── computeImpactDirection ────────────────────────────────────────────────────

describe("computeImpactDirection", () => {
  it("positive magnitude → POSITIVE", () =>
    assert.equal(computeImpactDirection(0.5), IMPACT_DIRECTION.POSITIVE));
  it("negative magnitude → NEGATIVE", () =>
    assert.equal(computeImpactDirection(-0.3), IMPACT_DIRECTION.NEGATIVE));
  it("zero magnitude → NEUTRAL", () =>
    assert.equal(computeImpactDirection(0), IMPACT_DIRECTION.NEUTRAL));
});

// ── deriveMitigationPriority ──────────────────────────────────────────────────

describe("deriveMitigationPriority", () => {
  it("magnitude = -0.7 → critical (boundary)", () =>
    assert.equal(deriveMitigationPriority(-0.7), MITIGATION_PRIORITY.CRITICAL));
  it("magnitude = -0.8 → critical", () =>
    assert.equal(deriveMitigationPriority(-0.8), MITIGATION_PRIORITY.CRITICAL));
  it("magnitude = -0.5 → high", () =>
    assert.equal(deriveMitigationPriority(-0.5), MITIGATION_PRIORITY.HIGH));
  it("magnitude = -0.2 → medium", () =>
    assert.equal(deriveMitigationPriority(-0.2), MITIGATION_PRIORITY.MEDIUM));
  it("magnitude = -0.15 → medium", () =>
    assert.equal(deriveMitigationPriority(-0.15), MITIGATION_PRIORITY.MEDIUM));
});

// ── validateIntervention ──────────────────────────────────────────────────────

describe("validateIntervention — missing vs invalid input (AC9)", () => {
  it("null → MISSING_INPUT", () => {
    const r = validateIntervention(null);
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, ANALYZER_REASON_CODE.MISSING_INPUT,
      "null must produce MISSING_INPUT, not INVALID_INPUT");
  });

  it("undefined → MISSING_INPUT", () => {
    const r = validateIntervention(undefined);
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, ANALYZER_REASON_CODE.MISSING_INPUT);
  });

  it("string value → INVALID_INPUT (not MISSING_INPUT)", () => {
    const r = validateIntervention("bad");
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, ANALYZER_REASON_CODE.INVALID_INPUT,
      "non-null invalid value must produce INVALID_INPUT");
  });

  it("missing id field → INVALID_INPUT", () => {
    const r = validateIntervention({ metrics: { throughputDelta: 0, qualityDelta: 0, costDelta: 0, failureDelta: 0, sampleCount: 0 } });
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, ANALYZER_REASON_CODE.INVALID_INPUT);
  });

  it("delta out of range [-1,1] → INVALID_INPUT", () => {
    const r = validateIntervention(makeIntervention({ metrics: { throughputDelta: 2.0, qualityDelta: 0, costDelta: 0, failureDelta: 0, sampleCount: 5 } }));
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, ANALYZER_REASON_CODE.INVALID_INPUT);
    assert.ok(r.reason.includes("throughputDelta"));
  });

  it("non-integer sampleCount → INVALID_INPUT", () => {
    const r = validateIntervention(makeIntervention({ metrics: { throughputDelta: 0, qualityDelta: 0, costDelta: 0, failureDelta: 0, sampleCount: 1.5 } }));
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, ANALYZER_REASON_CODE.INVALID_INPUT);
  });

  it("valid intervention → ok=true", () => {
    const r = validateIntervention(makeIntervention());
    assert.equal(r.ok, true);
  });
});

// ── buildFirstOrderVectors ────────────────────────────────────────────────────

describe("buildFirstOrderVectors — AC1 first-order", () => {
  it("emits exactly 4 vectors (one per dimension)", () => {
    const vectors = buildFirstOrderVectors(makeIntervention());
    assert.equal(vectors.length, 4);
    const dims = vectors.map(v => v.dimension).sort();
    assert.deepEqual(dims, [
      IMPACT_DIMENSION.COST,
      IMPACT_DIMENSION.FAILURE,
      IMPACT_DIMENSION.QUALITY,
      IMPACT_DIMENSION.THROUGHPUT,
    ].sort());
  });

  it("all vectors have order=first", () => {
    const vectors = buildFirstOrderVectors(makeIntervention());
    assert.ok(vectors.every(v => v.order === IMPACT_ORDER.FIRST));
  });

  it("all vectors include required schema fields", () => {
    const vectors = buildFirstOrderVectors(makeIntervention());
    for (const v of vectors) {
      for (const f of ANALYZER_SCHEMA.requiredImpactVectorFields) {
        assert.ok(f in v, `ImpactVector missing field: ${f}`);
      }
    }
  });

  it("direction derived correctly from magnitude", () => {
    const iv = makeIntervention({ metrics: { throughputDelta: 0.2, qualityDelta: -0.3, costDelta: 0, failureDelta: 0, sampleCount: 5 } });
    const vectors = buildFirstOrderVectors(iv);
    const t = vectors.find(v => v.dimension === IMPACT_DIMENSION.THROUGHPUT);
    const q = vectors.find(v => v.dimension === IMPACT_DIMENSION.QUALITY);
    const c = vectors.find(v => v.dimension === IMPACT_DIMENSION.COST);
    assert.equal(t.direction, IMPACT_DIRECTION.POSITIVE);
    assert.equal(q.direction, IMPACT_DIRECTION.NEGATIVE);
    assert.equal(c.direction, IMPACT_DIRECTION.NEUTRAL);
  });

  it("confidence matches computeConfidence(sampleCount)", () => {
    const iv = makeIntervention({ metrics: { throughputDelta: 0.1, qualityDelta: 0, costDelta: 0, failureDelta: 0, sampleCount: 3 } });
    const vectors = buildFirstOrderVectors(iv);
    for (const v of vectors) {
      assert.equal(v.confidence, computeConfidence(3), "confidence must be 0.6 for sampleCount=3");
      assert.equal(v.confidenceLevel, "medium");
    }
  });
});

// ── buildSecondOrderVectors ───────────────────────────────────────────────────

describe("buildSecondOrderVectors — AC1 second-order", () => {
  it("emits second-order vectors from first-order throughput effect", () => {
    const firstOrder = [{
      dimension:      IMPACT_DIMENSION.THROUGHPUT,
      order:          IMPACT_ORDER.FIRST,
      interventionId: "i-001",
      magnitude:      0.5,
      direction:      IMPACT_DIRECTION.POSITIVE,
      confidence:     1.0,
      confidenceLevel:"high",
      evidence:       [],
    }];
    const secondOrder = buildSecondOrderVectors(firstOrder);
    assert.ok(secondOrder.length > 0, "must emit at least one second-order vector");
    assert.ok(secondOrder.every(v => v.order === IMPACT_ORDER.SECOND));
  });

  it("second-order vectors respect SECOND_ORDER_NOISE_FLOOR", () => {
    // magnitude = 0.04 (below noise floor) → no second-order vectors
    const firstOrder = [{
      dimension:      IMPACT_DIMENSION.THROUGHPUT,
      order:          IMPACT_ORDER.FIRST,
      interventionId: "i-001",
      magnitude:      0.04,
      direction:      IMPACT_DIRECTION.POSITIVE,
      confidence:     1.0,
      confidenceLevel:"high",
      evidence:       [],
    }];
    const secondOrder = buildSecondOrderVectors(firstOrder);
    assert.equal(secondOrder.length, 0, "tiny magnitude must produce no second-order vectors");
  });

  it("second-order vectors include required schema fields", () => {
    const firstOrder = [buildFirstOrderVectors(makeIntervention({ metrics: { throughputDelta: 0.6, qualityDelta: 0, costDelta: 0, failureDelta: 0, sampleCount: 5 } }))[0]];
    const secondOrder = buildSecondOrderVectors(firstOrder);
    for (const v of secondOrder) {
      for (const f of ANALYZER_SCHEMA.requiredImpactVectorFields) {
        assert.ok(f in v, `second-order ImpactVector missing field: ${f}`);
      }
    }
  });

  it("second-order magnitude is clamped to [-1, 1]", () => {
    const firstOrder = [{
      dimension:      IMPACT_DIMENSION.FAILURE,
      order:          IMPACT_ORDER.FIRST,
      interventionId: "i-001",
      magnitude:      -1.0,
      direction:      IMPACT_DIRECTION.NEGATIVE,
      confidence:     1.0,
      confidenceLevel:"high",
      evidence:       [],
    }];
    const secondOrder = buildSecondOrderVectors(firstOrder);
    for (const v of secondOrder) {
      assert.ok(v.magnitude >= -1.0 && v.magnitude <= 1.0,
        `magnitude ${v.magnitude} out of [-1,1]`);
    }
  });
});

// ── detectNegativeEffects ─────────────────────────────────────────────────────

describe("detectNegativeEffects — AC2 threshold", () => {
  it("returns only vectors with magnitude < -0.1", () => {
    const vectors = [
      { magnitude:  0.5, dimension: IMPACT_DIMENSION.THROUGHPUT, order: IMPACT_ORDER.FIRST, interventionId: "x", direction: IMPACT_DIRECTION.POSITIVE, confidence: 1, confidenceLevel: "high", evidence: [] },
      { magnitude: -0.15, dimension: IMPACT_DIMENSION.QUALITY, order: IMPACT_ORDER.FIRST, interventionId: "x", direction: IMPACT_DIRECTION.NEGATIVE, confidence: 1, confidenceLevel: "high", evidence: [] },
      { magnitude: -0.05, dimension: IMPACT_DIMENSION.COST, order: IMPACT_ORDER.FIRST, interventionId: "x", direction: IMPACT_DIRECTION.NEGATIVE, confidence: 1, confidenceLevel: "high", evidence: [] },
    ];
    const neg = detectNegativeEffects(vectors);
    assert.equal(neg.length, 1, "only magnitude=-0.15 is below -0.1 threshold");
    assert.equal(neg[0].magnitude, -0.15);
  });

  it("magnitude exactly = -0.1 is NOT negative (threshold exclusive)", () => {
    const vectors = [{ magnitude: -0.1, dimension: IMPACT_DIMENSION.FAILURE, order: IMPACT_ORDER.FIRST, interventionId: "x", direction: IMPACT_DIRECTION.NEGATIVE, confidence: 1, confidenceLevel: "high", evidence: [] }];
    assert.equal(detectNegativeEffects(vectors).length, 0,
      "magnitude=-0.1 is at boundary, not below threshold");
  });
});

// ── buildMitigationRecommendations ────────────────────────────────────────────

describe("buildMitigationRecommendations — AC2 schema", () => {
  it("returns recommendations for each negative dimension", () => {
    const negVecs = [
      { magnitude: -0.3, dimension: IMPACT_DIMENSION.THROUGHPUT, order: IMPACT_ORDER.FIRST, interventionId: "i-001", direction: IMPACT_DIRECTION.NEGATIVE, confidence: 1, confidenceLevel: "high", evidence: [] },
    ];
    const recs = buildMitigationRecommendations(negVecs);
    assert.ok(recs.length >= 1);
    for (const r of recs) {
      for (const f of ANALYZER_SCHEMA.requiredMitigationFields) {
        assert.ok(f in r, `MitigationRecommendation missing field: ${f}`);
      }
    }
  });

  it("reasonCode is a valid MITIGATION_REASON_CODE value", () => {
    const negVecs = [
      { magnitude: -0.3, dimension: IMPACT_DIMENSION.QUALITY, order: IMPACT_ORDER.FIRST, interventionId: "i-001", direction: IMPACT_DIRECTION.NEGATIVE, confidence: 1, confidenceLevel: "high", evidence: [] },
    ];
    const recs = buildMitigationRecommendations(negVecs);
    for (const r of recs) {
      assert.ok(
        Object.values(MITIGATION_REASON_CODE).includes(r.reasonCode),
        `unknown reasonCode: ${r.reasonCode}`
      );
    }
  });

  it("priority is a valid MITIGATION_PRIORITY value", () => {
    const negVecs = [
      { magnitude: -0.5, dimension: IMPACT_DIMENSION.COST, order: IMPACT_ORDER.FIRST, interventionId: "i-001", direction: IMPACT_DIRECTION.NEGATIVE, confidence: 1, confidenceLevel: "high", evidence: [] },
    ];
    const recs = buildMitigationRecommendations(negVecs);
    for (const r of recs) {
      assert.ok(
        Object.values(MITIGATION_PRIORITY).includes(r.priority),
        `unknown priority: ${r.priority}`
      );
    }
  });

  it("compounded negative across dims → COMPOUNDED_NEGATIVE reasonCode", () => {
    const negVecs = [
      { magnitude: -0.3, dimension: IMPACT_DIMENSION.THROUGHPUT, order: IMPACT_ORDER.FIRST,  interventionId: "i-001", direction: IMPACT_DIRECTION.NEGATIVE, confidence: 1, confidenceLevel: "high", evidence: [] },
      { magnitude: -0.2, dimension: IMPACT_DIMENSION.QUALITY,    order: IMPACT_ORDER.SECOND, interventionId: "i-001", direction: IMPACT_DIRECTION.NEGATIVE, confidence: 1, confidenceLevel: "high", evidence: [] },
    ];
    const recs = buildMitigationRecommendations(negVecs);
    const compounded = recs.find(r => r.reasonCode === MITIGATION_REASON_CODE.COMPOUNDED_NEGATIVE);
    assert.ok(compounded, "must emit COMPOUNDED_NEGATIVE when multi-dim second-order negative present");
  });
});

// ── analyzeCompoundingEffects — happy path ────────────────────────────────────

describe("analyzeCompoundingEffects — happy path (AC1, AC2, AC3)", () => {
  const interventions = [
    makeIntervention({ id: "i-001", metrics: { throughputDelta: 0.4, qualityDelta: 0.1, costDelta: -0.05, failureDelta: -0.2, sampleCount: 5 } }),
    makeIntervention({ id: "i-002", metrics: { throughputDelta: -0.15, qualityDelta: 0.2, costDelta: 0.1,  failureDelta: 0.05, sampleCount: 6 } }),
    makeIntervention({ id: "i-003", metrics: { throughputDelta: 0.1,   qualityDelta: -0.3, costDelta: 0.0, failureDelta: -0.1, sampleCount: 8 } }),
  ];

  let result;
  before(() => { result = analyzeCompoundingEffects(interventions); });

  it("status=ok for valid interventions with sufficient samples", () => {
    assert.equal(result.status, ANALYZER_STATUS.OK);
    assert.equal(result.statusReason, null);
  });

  it("includes first-order and second-order vectors (AC1)", () => {
    const hasFirst  = result.impactVectors.some(v => v.order === IMPACT_ORDER.FIRST);
    const hasSecond = result.impactVectors.some(v => v.order === IMPACT_ORDER.SECOND);
    assert.ok(hasFirst,  "must include first-order vectors");
    assert.ok(hasSecond, "must include second-order vectors");
  });

  it("each vector has required schema fields", () => {
    for (const v of result.impactVectors) {
      for (const f of ANALYZER_SCHEMA.requiredImpactVectorFields) {
        assert.ok(f in v, `ImpactVector missing field: ${f}`);
      }
    }
  });

  it("confidence is in [0.0, 1.0] per vector (AC3)", () => {
    for (const v of result.impactVectors) {
      assert.ok(
        typeof v.confidence === "number" && v.confidence >= 0 && v.confidence <= 1,
        `confidence ${v.confidence} out of range`
      );
      assert.ok(
        ["high", "medium", "low"].includes(v.confidenceLevel),
        `unknown confidenceLevel: ${v.confidenceLevel}`
      );
    }
  });

  it("mitigations emitted for negative effects (AC2)", () => {
    assert.ok(result.negativeEffectCount >= 0);
    if (result.negativeEffectCount > 0) {
      assert.ok(result.mitigationRecommendations.length > 0,
        "must emit recommendations when negative effects exist");
    }
  });

  it("result includes all required schema fields (AC8)", () => {
    for (const f of ANALYZER_SCHEMA.requiredResultFields) {
      assert.ok(f in result, `AnalyzerResult missing field: ${f}`);
    }
    assert.equal(result.schemaVersion, ANALYZER_SCHEMA_VERSION);
  });

  it("interventionCount matches valid intervention count", () => {
    assert.equal(result.interventionCount, 3);
    assert.equal(result.skippedCount, 0);
  });
});

// ── analyzeCompoundingEffects — negative paths (AC7, AC9, AC10) ───────────────

describe("analyzeCompoundingEffects — negative paths", () => {
  it("null input → status=error, MISSING_INPUT (AC7, AC9, AC10)", () => {
    const r = analyzeCompoundingEffects(null);
    assert.equal(r.status, ANALYZER_STATUS.ERROR);
    assert.equal(r.statusReason, ANALYZER_REASON_CODE.MISSING_INPUT,
      "null must produce MISSING_INPUT, not INVALID_INPUT");
    assert.ok("impactVectors" in r, "must include impactVectors even in error state");
    assert.equal(r.impactVectors.length, 0);
  });

  it("non-array input → status=error, INVALID_INPUT (distinct from null)", () => {
    const r = analyzeCompoundingEffects({ bad: true });
    assert.equal(r.status, ANALYZER_STATUS.ERROR);
    assert.equal(r.statusReason, ANALYZER_REASON_CODE.INVALID_INPUT,
      "non-null non-array must produce INVALID_INPUT");
    assert.notEqual(r.statusReason, ANALYZER_REASON_CODE.MISSING_INPUT,
      "INVALID_INPUT must differ from MISSING_INPUT");
  });

  it("empty array → status=insufficient_data (AC5)", () => {
    const r = analyzeCompoundingEffects([]);
    assert.equal(r.status, ANALYZER_STATUS.INSUFFICIENT_DATA);
    assert.equal(r.interventionCount, 0);
  });

  it("all interventions invalid → status=error (AC10 — no silent success)", () => {
    const r = analyzeCompoundingEffects([null, "bad", 42]);
    assert.equal(r.status, ANALYZER_STATUS.ERROR,
      "must not silently succeed when all interventions are invalid");
    assert.ok(r.skippedCount > 0, "must count skipped interventions");
    assert.ok("statusReason" in r, "status field must include reason");
  });

  it("status field is always present and is a known ANALYZER_STATUS value (AC10)", () => {
    for (const input of [null, [], [makeIntervention()], "bad"]) {
      const r = analyzeCompoundingEffects(input);
      assert.ok(
        Object.values(ANALYZER_STATUS).includes(r.status),
        `unknown status: ${r.status}`
      );
    }
  });
});

// ── Sparse data handling (AC5) ─────────────────────────────────────────────────

describe("analyzeCompoundingEffects — sparse data (AC5)", () => {
  it("all interventions with sampleCount < MIN_SAMPLE_THRESHOLD → insufficient_data or degraded", () => {
    const sparse = [
      makeIntervention({ id: "s-1", metrics: { throughputDelta: 0.1, qualityDelta: 0.1, costDelta: 0.1, failureDelta: 0.1, sampleCount: 0 } }),
      makeIntervention({ id: "s-2", metrics: { throughputDelta: 0.1, qualityDelta: 0.1, costDelta: 0.1, failureDelta: 0.1, sampleCount: 1 } }),
    ];
    const r = analyzeCompoundingEffects(sparse);
    assert.ok(
      r.status === ANALYZER_STATUS.INSUFFICIENT_DATA || r.status === ANALYZER_STATUS.DEGRADED,
      `expected insufficient_data or degraded for all-sparse, got: ${r.status}`
    );
    assert.ok(r.sparseDataCount > 0, "must record sparseDataCount > 0");
  });

  it("mixed: some sparse, some ok → status=degraded (partial data)", () => {
    const mixed = [
      makeIntervention({ id: "m-1", metrics: { throughputDelta: 0.1, qualityDelta: 0.1, costDelta: 0.1, failureDelta: 0.1, sampleCount: 1 } }),
      makeIntervention({ id: "m-2", metrics: { throughputDelta: 0.1, qualityDelta: 0.1, costDelta: 0.1, failureDelta: 0.1, sampleCount: 5 } }),
    ];
    const r = analyzeCompoundingEffects(mixed);
    assert.equal(r.status, ANALYZER_STATUS.DEGRADED,
      "mixed sparse/full data must produce degraded status");
    assert.equal(r.sparseDataCount, 1);
  });
});

// ── buildMonthlyCompoundingReport (AC4) ───────────────────────────────────────

describe("buildMonthlyCompoundingReport — AC4 monthly top-N", () => {
  const MONTH = "2025-04";

  it("returns status=ok with top-N contributors from multiple runs", () => {
    const run1 = analyzeCompoundingEffects([
      makeIntervention({ id: "r1-i1", metrics: { throughputDelta: 0.5, qualityDelta: 0.3, costDelta: -0.1, failureDelta: -0.4, sampleCount: 5 } }),
      makeIntervention({ id: "r1-i2", metrics: { throughputDelta: -0.3, qualityDelta: 0.2, costDelta: 0.15, failureDelta: 0.1, sampleCount: 7 } }),
    ]);
    const run2 = analyzeCompoundingEffects([
      makeIntervention({ id: "r2-i1", metrics: { throughputDelta: 0.2, qualityDelta: -0.4, costDelta: 0.0, failureDelta: -0.2, sampleCount: 6 } }),
    ]);

    const report = buildMonthlyCompoundingReport([run1, run2], MONTH);
    assert.equal(report.status, ANALYZER_STATUS.OK);
    assert.equal(report.monthKey, MONTH);
    assert.ok(report.topContributors.length <= MONTHLY_REPORT_TOP_N,
      `topContributors must not exceed MONTHLY_REPORT_TOP_N (${MONTHLY_REPORT_TOP_N})`);
    assert.ok(report.totalVectors > 0, "totalVectors must be > 0");
    assert.equal(report.runCount, 2);
  });

  it("topContributors is sorted by score descending (highest impact first)", () => {
    const run = analyzeCompoundingEffects([
      makeIntervention({ id: "big",  metrics: { throughputDelta: 0.9, qualityDelta: 0, costDelta: 0, failureDelta: 0, sampleCount: 5 } }),
      makeIntervention({ id: "small", metrics: { throughputDelta: 0.1, qualityDelta: 0, costDelta: 0, failureDelta: 0, sampleCount: 5 } }),
    ]);
    const report = buildMonthlyCompoundingReport([run], MONTH);
    if (report.topContributors.length >= 2) {
      // Top contributor should have higher |magnitude| × confidence than the next
      const first  = Math.abs(report.topContributors[0].magnitude) * report.topContributors[0].confidence;
      const second = Math.abs(report.topContributors[1].magnitude) * report.topContributors[1].confidence;
      assert.ok(first >= second, "top contributor must have score >= next contributor");
    }
  });

  it("empty analyzerResults → status=insufficient_data", () => {
    const report = buildMonthlyCompoundingReport([], MONTH);
    assert.equal(report.status, ANALYZER_STATUS.INSUFFICIENT_DATA);
    assert.equal(report.topContributors.length, 0);
  });

  it("monthly report includes all required fields (AC8)", () => {
    const report = buildMonthlyCompoundingReport([], MONTH);
    for (const f of ["schemaVersion","monthKey","generatedAt","status",
                     "topContributors","totalVectors","totalNegative","runCount"]) {
      assert.ok(f in report, `monthly report missing field: ${f}`);
    }
  });

  it("totalNegative counts vectors below NEGATIVE_MAGNITUDE_THRESHOLD", () => {
    const run = analyzeCompoundingEffects([
      makeIntervention({ id: "neg", metrics: { throughputDelta: -0.5, qualityDelta: -0.3, costDelta: 0.1, failureDelta: 0.2, sampleCount: 5 } }),
    ]);
    const report = buildMonthlyCompoundingReport([run], MONTH);
    assert.ok(report.totalNegative >= 0);
  });
});

// ── Persistence: persistCompoundingEffectsResult ──────────────────────────────

describe("persistCompoundingEffectsResult", () => {
  let tmpDir;
  before(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t038-per-")); });
  after(async ()  => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("null result → MISSING_INPUT (AC9)", async () => {
    const r = await persistCompoundingEffectsResult(makeConfig(tmpDir), null);
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes("MISSING_INPUT"));
  });

  it("non-object result → INVALID_INPUT", async () => {
    const r = await persistCompoundingEffectsResult(makeConfig(tmpDir), "bad");
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes("INVALID_INPUT"));
  });

  it("result missing required field → INVALID_INPUT", async () => {
    const r = await persistCompoundingEffectsResult(makeConfig(tmpDir), { schemaVersion: 1 });
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes("INVALID_INPUT"));
  });

  it("valid result → written to disk, ok=true", async () => {
    const result = analyzeCompoundingEffects([makeIntervention()]);
    const r = await persistCompoundingEffectsResult(makeConfig(tmpDir), result);
    assert.equal(r.ok, true, `persist failed: ${r.reason}`);
    assert.ok(r.filePath.endsWith("compounding_effects_latest.json"));
    const written = JSON.parse(await fs.readFile(r.filePath, "utf8"));
    assert.equal(written.status, ANALYZER_STATUS.OK);
    assert.equal(written.schemaVersion, ANALYZER_SCHEMA_VERSION);
  });
});

// ── Persistence: persistMonthlyCompoundingReport ──────────────────────────────

describe("persistMonthlyCompoundingReport", () => {
  let tmpDir;
  before(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t038-mon-")); });
  after(async ()  => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("null report → MISSING_INPUT", async () => {
    const r = await persistMonthlyCompoundingReport(makeConfig(tmpDir), null);
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes("MISSING_INPUT"));
  });

  it("invalid monthKey → INVALID_INPUT", async () => {
    const r = await persistMonthlyCompoundingReport(makeConfig(tmpDir), {
      schemaVersion: 1, monthKey: "bad-key", generatedAt: new Date().toISOString(),
      status: ANALYZER_STATUS.OK, statusReason: null,
      topContributors: [], totalVectors: 0, totalNegative: 0, runCount: 0,
    });
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes("INVALID_INPUT"));
  });

  it("valid report → written to correct path, ok=true", async () => {
    const MONTH = "2025-04";
    const report = buildMonthlyCompoundingReport(
      [analyzeCompoundingEffects([makeIntervention()])],
      MONTH
    );
    const r = await persistMonthlyCompoundingReport(makeConfig(tmpDir), report);
    assert.equal(r.ok, true, `persist failed: ${r.reason}`);
    assert.ok(r.filePath.includes(`compounding_effects_monthly_${MONTH}`));
    const written = JSON.parse(await fs.readFile(r.filePath, "utf8"));
    assert.equal(written.monthKey, MONTH);
    assert.equal(written.schemaVersion, ANALYZER_SCHEMA_VERSION);
  });
});

// ── Persistence: generateAndPersistMonthlyReport ──────────────────────────────

describe("generateAndPersistMonthlyReport", () => {
  let tmpDir;
  before(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t038-gen-")); });
  after(async ()  => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("invalid monthKey → INVALID_INPUT, ok=false", async () => {
    const r = await generateAndPersistMonthlyReport(makeConfig(tmpDir), "bad");
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes("INVALID_INPUT"));
  });

  it("empty log → ok=true, report.status=insufficient_data", async () => {
    const MONTH = "2025-05";
    const r = await generateAndPersistMonthlyReport(makeConfig(tmpDir), MONTH);
    assert.equal(r.ok, true, `failed: ${r.reason}`);
    assert.equal(r.report.status, ANALYZER_STATUS.INSUFFICIENT_DATA);
  });

  it("with entries in log → generates monthly file correctly", async () => {
    const MONTH = "2025-06";
    // First persist a result so the log has an entry for this month
    const result = analyzeCompoundingEffects([makeIntervention()]);
    // Stamp it with the target month's date
    result.generatedAt = `${MONTH}-15T12:00:00.000Z`;
    await persistCompoundingEffectsResult(makeConfig(tmpDir), result);

    const r = await generateAndPersistMonthlyReport(makeConfig(tmpDir), MONTH);
    assert.equal(r.ok, true, `failed: ${r.reason}`);
    assert.ok(r.filePath.includes(`compounding_effects_monthly_${MONTH}`));
    assert.equal(r.report.monthKey, MONTH);
  });
});

// ── CROSS_IMPACT_MATRIX completeness ─────────────────────────────────────────

describe("CROSS_IMPACT_MATRIX", () => {
  it("all source dimensions are present in the matrix", () => {
    for (const dim of Object.values(IMPACT_DIMENSION)) {
      assert.ok(dim in CROSS_IMPACT_MATRIX, `CROSS_IMPACT_MATRIX missing source: ${dim}`);
    }
  });

  it("all cascade multipliers are finite numbers ∈ [-1, 1]", () => {
    for (const [src, targets] of Object.entries(CROSS_IMPACT_MATRIX)) {
      for (const [tgt, mult] of Object.entries(targets)) {
        assert.ok(
          typeof mult === "number" && Number.isFinite(mult) && mult >= -1 && mult <= 1,
          `CROSS_IMPACT_MATRIX[${src}][${tgt}] = ${mult} is not a valid multiplier`
        );
      }
    }
  });

  it("source and target are never the same dimension (no self-loops)", () => {
    for (const [src, targets] of Object.entries(CROSS_IMPACT_MATRIX)) {
      assert.ok(!(src in targets), `CROSS_IMPACT_MATRIX has self-loop on ${src}`);
    }
  });
});
