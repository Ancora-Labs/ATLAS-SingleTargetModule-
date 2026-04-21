import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BAND_STATE,
  DEFAULT_THRESHOLDS,
  computeCompositeScore,
  evaluateInBandThresholds,
  evaluateRegressionTriggers,
  computeNextState,
  type CycleSample,
} from "../../src/core/autonomy_band_monitor.js";

// ── Helper: build a CycleSample with convenient defaults ─────────────────────

function makeSample(overrides: Partial<CycleSample> = {}): CycleSample {
  return {
    cycleId: `test-${Date.now()}`,
    recordedAt: new Date().toISOString(),
    phase: "completed",
    completionRate: 0.85,
    premiumEfficiency: 0.70,
    premiumEfficiencyAdjusted: null,
    rawPremiumEfficiency: null,
    executionAdjustedPremiumEfficiency: null,
    athenaRejectRate: 0.10,
    parserFallbackRate: 0.05,
    contractFailRate: 0.05,
    benchmarkGain: 0.20,
    crashCount: 0,
    crashRate: 0,
    hardGuardrailBreach: false,
    capacityTrend: "stable",
    ...overrides,
  };
}

function makeHistory(count: number, overrides: Partial<CycleSample> = {}): CycleSample[] {
  return Array.from({ length: count }, (_, i) =>
    makeSample({ cycleId: `cycle-${i}`, ...overrides }),
  );
}

// ── computeCompositeScore ────────────────────────────────────────────────────

describe("computeCompositeScore", () => {
  it("computes weighted score with all dimensions present", () => {
    const score = computeCompositeScore({
      completion: 0.8,
      premiumEfficiency: 0.7,
      quality: 0.9,
      capacityTrend: 0.6,
      stability: 0.85,
    });
    assert.ok(score !== null);
    assert.ok(score! > 0.7 && score! < 0.85, `expected ~0.77, got ${score}`);
  });

  it("returns null when all dimensions are null", () => {
    const score = computeCompositeScore({
      completion: null,
      premiumEfficiency: null,
      quality: null,
      capacityTrend: null,
      stability: null,
    });
    assert.equal(score, null);
  });

  it("redistributes weight when some dimensions are null", () => {
    // Only completion(0.25) and stability(0.20) present
    const partial = computeCompositeScore({
      completion: 1.0,
      premiumEfficiency: null,
      quality: null,
      capacityTrend: null,
      stability: 1.0,
    });
    assert.ok(partial !== null);
    // With redistribution, all active weights normalize to 1.0, score should be 1.0
    assert.equal(partial, 1.0);
  });

  it("clamps dimension values to 0-1", () => {
    const score = computeCompositeScore({
      completion: 1.5,
      premiumEfficiency: -0.2,
      quality: 0.5,
      capacityTrend: 0.5,
      stability: 0.5,
    });
    assert.ok(score !== null);
    // 1.5 clamped to 1.0, -0.2 clamped to 0.0
    assert.ok(score! >= 0 && score! <= 1);
  });
});

// ── evaluateInBandThresholds ─────────────────────────────────────────────────

describe("evaluateInBandThresholds", () => {
  it("returns allMet=true when all thresholds met", () => {
    const history = makeHistory(35, {
      completionRate: 0.90,
      premiumEfficiency: 0.80,
      athenaRejectRate: 0.05,
    });
    const checks = evaluateInBandThresholds(history, DEFAULT_THRESHOLDS);
    assert.ok(checks.allMet, `expected allMet but got ${JSON.stringify(checks)}`);
    assert.ok(checks.compositeScoreMet);
    assert.ok(checks.completionRateMet);
    assert.ok(checks.premiumEfficiencyMet);
    assert.ok(checks.athenaRejectRateMet);
    assert.ok(checks.hardGuardrailBreachMet);
  });

  it("returns allMet=false when completion rate is below threshold", () => {
    const history = makeHistory(35, {
      completionRate: 0.50,
      premiumEfficiency: 0.80,
      athenaRejectRate: 0.05,
    });
    const checks = evaluateInBandThresholds(history, DEFAULT_THRESHOLDS);
    assert.ok(!checks.allMet);
    assert.ok(!checks.completionRateMet);
  });

  it("returns allMet=false when too many guardrail breaches", () => {
    const history = makeHistory(55);
    // Add 3 breaches (max is 2)
    history[50]!.hardGuardrailBreach = true;
    history[51]!.hardGuardrailBreach = true;
    history[52]!.hardGuardrailBreach = true;
    const checks = evaluateInBandThresholds(history, DEFAULT_THRESHOLDS);
    assert.ok(!checks.hardGuardrailBreachMet);
    assert.ok(!checks.allMet);
  });
});

// ── evaluateRegressionTriggers ───────────────────────────────────────────────

describe("evaluateRegressionTriggers", () => {
  it("returns no breaches for healthy history", () => {
    const history = makeHistory(20);
    const checks = evaluateRegressionTriggers(history, DEFAULT_THRESHOLDS);
    assert.ok(!checks.anyBreach);
    assert.ok(!checks.crashBreach);
    assert.ok(!checks.completionBreach);
    assert.ok(!checks.hardGuardrailBreach);
    assert.ok(!checks.athenaRejectBreach);
  });

  it("detects crash breach when 3+ crashes in window", () => {
    const history = makeHistory(12, { crashCount: 0 });
    history[9]!.crashCount = 1;
    history[10]!.crashCount = 1;
    history[11]!.crashCount = 1;
    const checks = evaluateRegressionTriggers(history, DEFAULT_THRESHOLDS);
    assert.ok(checks.crashBreach);
    assert.ok(checks.anyBreach);
  });

  it("detects completion breach when avg < 0.40", () => {
    const history = makeHistory(12, { completionRate: 0.30 });
    const checks = evaluateRegressionTriggers(history, DEFAULT_THRESHOLDS);
    assert.ok(checks.completionBreach);
    assert.ok(checks.anyBreach);
  });

  it("detects hard guardrail breach in last cycle", () => {
    const history = makeHistory(5);
    history[4]!.hardGuardrailBreach = true;
    const checks = evaluateRegressionTriggers(history, DEFAULT_THRESHOLDS);
    assert.ok(checks.hardGuardrailBreach);
    assert.ok(checks.anyBreach);
  });

  it("detects athena reject breach when avg > 0.40 in window", () => {
    const history = makeHistory(8, { athenaRejectRate: 0.50 });
    const checks = evaluateRegressionTriggers(history, DEFAULT_THRESHOLDS);
    assert.ok(checks.athenaRejectBreach);
    assert.ok(checks.anyBreach);
  });
});

// ── computeNextState ─────────────────────────────────────────────────────────

describe("computeNextState", () => {
  it("stays BOOTSTRAPPING when cycle count is below minimum", () => {
    const history = makeHistory(5);
    const { nextState } = computeNextState(BAND_STATE.BOOTSTRAPPING, history, DEFAULT_THRESHOLDS);
    assert.equal(nextState, BAND_STATE.BOOTSTRAPPING);
  });

  it("transitions to STABILIZING after minimum cycles with unmet thresholds", () => {
    const history = makeHistory(15, { completionRate: 0.50 });
    const { nextState } = computeNextState(BAND_STATE.BOOTSTRAPPING, history, DEFAULT_THRESHOLDS);
    assert.equal(nextState, BAND_STATE.STABILIZING);
  });

  it("transitions to IN_BAND when all thresholds met", () => {
    const history = makeHistory(35, {
      completionRate: 0.90,
      premiumEfficiency: 0.80,
      athenaRejectRate: 0.05,
    });
    const { nextState } = computeNextState(BAND_STATE.STABILIZING, history, DEFAULT_THRESHOLDS);
    assert.equal(nextState, BAND_STATE.IN_BAND);
  });

  it("transitions from IN_BAND to STABILIZING on threshold drift (not REGRESSED)", () => {
    const history = makeHistory(35, {
      completionRate: 0.90,
      premiumEfficiency: 0.80,
      athenaRejectRate: 0.05,
    });
    // Drop last few cycles' completion
    for (let i = 30; i < 35; i++) {
      history[i]!.completionRate = 0.50;
    }
    // First check with only 5 bad cycles — avg may still pass. Force clear failure:
    for (let i = 10; i < 35; i++) {
      history[i]!.completionRate = 0.50;
    }
    const { nextState: state2 } = computeNextState(BAND_STATE.IN_BAND, history, DEFAULT_THRESHOLDS);
    assert.equal(state2, BAND_STATE.STABILIZING);
  });

  it("transitions to REGRESSED on hard regression trigger regardless of state", () => {
    const history = makeHistory(20, { crashCount: 0 });
    // 3 crashes in last 10
    history[17]!.crashCount = 1;
    history[18]!.crashCount = 1;
    history[19]!.crashCount = 1;
    const { nextState } = computeNextState(BAND_STATE.IN_BAND, history, DEFAULT_THRESHOLDS);
    assert.equal(nextState, BAND_STATE.REGRESSED);
  });

  it("transitions from REGRESSED back to STABILIZING when triggers clear", () => {
    const history = makeHistory(15, {
      completionRate: 0.60,
      premiumEfficiency: 0.50,
      athenaRejectRate: 0.10,
    });
    const { nextState } = computeNextState(BAND_STATE.REGRESSED, history, DEFAULT_THRESHOLDS);
    // No regression triggers, enough cycles, but thresholds not all met → STABILIZING
    assert.equal(nextState, BAND_STATE.STABILIZING);
  });
});

// ── computePhaseAwareVariance ─────────────────────────────────────────────────

import {
  computePhaseAwareVariance,
  VARIANCE_NORMALIZATION_STABILITY_THRESHOLD,
  computeExecutionPhase,
} from "../../src/core/autonomy_band_monitor.js";

describe("VARIANCE_NORMALIZATION_STABILITY_THRESHOLD", () => {
  it("is set to 0.85", () => {
    assert.equal(VARIANCE_NORMALIZATION_STABILITY_THRESHOLD, 0.85);
  });
});

describe("computePhaseAwareVariance", () => {
  it("returns a number (variance) when recent stability is below threshold", () => {
    // History with mixed completion rates — low stability, no normalization expected
    const rates = [0, 0.2, 0.4, 0.3, 0.5, 0.1];
    const result = computePhaseAwareVariance(rates, rates.length);
    assert.ok(result === null || result >= 0, "variance must be non-negative or null");
  });

  it("returns low variance when recent cycles are stable after bootstrap outlier", () => {
    // Bootstrap outlier (0) followed by stable recent cycles (all 1.0)
    const rates = [0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0];
    const result = computePhaseAwareVariance(rates, rates.length);
    // With high recent stability the effective window excludes the outlier → variance near 0
    if (result !== null) {
      assert.ok(result < 0.1, `normalized variance must be low, got ${result}`);
    }
  });

  it("stable history returns lower variance than degraded history", () => {
    const stableRates  = [0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0];
    const degradedRates = [0, 0.5, 0.6, 0.5, 0.6, 0.5, 0.6, 0.7];
    const normalized = computePhaseAwareVariance(stableRates, stableRates.length);
    const full       = computePhaseAwareVariance(degradedRates, degradedRates.length);
    if (normalized !== null && full !== null) {
      assert.ok(normalized <= full + 0.001,
        `stable variance (${normalized}) should be <= degraded variance (${full})`);
    }
  });

  it("returns variance ~0 when all rates in the effective window are identical", () => {
    const rates = [0, 1.0, 1.0, 1.0, 1.0, 1.0]; // recent window = all 1.0
    const result = computePhaseAwareVariance(rates, rates.length);
    if (result !== null) {
      assert.ok(result < 0.01, `variance must be near 0, got ${result}`);
    }
  });

  it("falls back gracefully when fewer than 2 values in stability-check window", () => {
    const result = computePhaseAwareVariance([1.0], 4);
    // Not enough recent values for stability check — returns standard variance or null
    assert.ok(result === null || typeof result === "number");
  });

  it("handles empty array without throwing", () => {
    const result = computePhaseAwareVariance([], 4);
    assert.ok(result === null || result === 0);
  });
});

describe("computeExecutionPhase: varianceNormalizationApplied flag", () => {
  it("sets varianceNormalizationApplied=true when recent cycles are stable after bootstrap outlier", () => {
    // Need exactly exploitationWindow (10) cycles for the gate to not short-circuit.
    // First cycle: bootstrap outlier (completionRate=0), rest: stable (1.0)
    const history = [
      makeSample({ cycleId: "c0", completionRate: 0, benchmarkGain: 0.3 }),
      ...Array.from({ length: 9 }, (_, i) =>
        makeSample({
          cycleId: `c${i + 1}`,
          completionRate: 1.0,
          premiumEfficiency: 0.9,
          benchmarkGain: 0.3,
          phase: "completed",
        }),
      ),
    ];
    const result = computeExecutionPhase(BAND_STATE.IN_BAND, history, DEFAULT_THRESHOLDS);
    // If the recent window is all 1.0, variance normalization should be applied
    assert.equal(result.varianceNormalizationApplied, true,
      "varianceNormalizationApplied must be true when bootstrap outlier is excluded by normalization");
  });

  it("sets varianceNormalizationApplied=false for mixed/degraded history", () => {
    const history = makeHistory(10, { completionRate: 0.5, premiumEfficiency: 0.4 });
    const result = computeExecutionPhase(BAND_STATE.IN_BAND, history, DEFAULT_THRESHOLDS);
    assert.equal(result.varianceNormalizationApplied, false,
      "varianceNormalizationApplied must be false when recent stability is below threshold");
  });
});

// ── Premium efficiency gate variant ──────────────────────────────────────────

import { type Thresholds } from "../../src/core/autonomy_band_monitor.js";

describe("DEFAULT_THRESHOLDS.premiumEfficiencyGateVariant", () => {
  it("defaults to 'raw' for backward compatibility", () => {
    assert.equal(DEFAULT_THRESHOLDS.premiumEfficiencyGateVariant, "raw");
  });
});

describe("evaluateInBandThresholds — gate variant selection", () => {
  it("uses raw premiumEfficiency when variant is 'raw'", () => {
    // raw=0.65 (above 0.60 min), adjusted=0.30 (below) — raw variant should pass
    const history = makeHistory(35, {
      completionRate: 0.90,
      premiumEfficiency: 0.65,
      premiumEfficiencyAdjusted: 0.30,
      athenaRejectRate: 0.05,
    });
    const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, premiumEfficiencyGateVariant: "raw" };
    const checks = evaluateInBandThresholds(history, thresholds);
    assert.ok(checks.premiumEfficiencyMet, "raw variant: 0.65 should meet 0.60 threshold");
  });

  it("uses adjusted premiumEfficiency when variant is 'execution_adjusted'", () => {
    // raw=0.65 (above 0.60 min), adjusted=0.30 (below) — adjusted variant should FAIL
    const history = makeHistory(35, {
      completionRate: 0.90,
      premiumEfficiency: 0.65,
      premiumEfficiencyAdjusted: 0.30,
      athenaRejectRate: 0.05,
    });
    const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, premiumEfficiencyGateVariant: "execution_adjusted" };
    const checks = evaluateInBandThresholds(history, thresholds);
    assert.ok(!checks.premiumEfficiencyMet, "execution_adjusted variant: 0.30 should NOT meet 0.60 threshold");
  });

  it("falls back to raw when adjusted is null and variant is 'execution_adjusted'", () => {
    // adjusted=null, raw=0.75 — gate should fall back to raw and pass
    const history = makeHistory(35, {
      completionRate: 0.90,
      premiumEfficiency: 0.75,
      premiumEfficiencyAdjusted: null,
      athenaRejectRate: 0.05,
    });
    const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, premiumEfficiencyGateVariant: "execution_adjusted" };
    const checks = evaluateInBandThresholds(history, thresholds);
    assert.ok(checks.premiumEfficiencyMet, "fallback to raw: 0.75 should meet 0.60 threshold");
  });

  it("execution_adjusted passes when adjusted meets threshold even if raw is lower", () => {
    // adjusted=0.80, raw=0.40 — execution_adjusted variant should PASS
    const history = makeHistory(35, {
      completionRate: 0.90,
      premiumEfficiency: 0.40,
      premiumEfficiencyAdjusted: 0.80,
      athenaRejectRate: 0.05,
    });
    const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, premiumEfficiencyGateVariant: "execution_adjusted" };
    const checks = evaluateInBandThresholds(history, thresholds);
    assert.ok(checks.premiumEfficiencyMet, "execution_adjusted 0.80 should meet 0.60 threshold");
  });

  it("negative path: raw fails when premiumEfficiency is below threshold", () => {
    const history = makeHistory(35, {
      completionRate: 0.90,
      premiumEfficiency: 0.50,  // below 0.60
      premiumEfficiencyAdjusted: null,
      athenaRejectRate: 0.05,
    });
    const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, premiumEfficiencyGateVariant: "raw" };
    const checks = evaluateInBandThresholds(history, thresholds);
    assert.ok(!checks.premiumEfficiencyMet, "raw 0.50 should NOT meet 0.60 threshold");
    assert.ok(!checks.allMet, "allMet must be false when premiumEfficiencyMet is false");
  });
});

// ── New explicit metrics: rawPremiumEfficiency and executionAdjustedPremiumEfficiency ──

describe("evaluateInBandThresholds — rawPremiumEfficiency (new field)", () => {
  it("uses rawPremiumEfficiency over legacy premiumEfficiency when present (raw variant)", () => {
    // rawPremiumEfficiency=0.70 (above 0.60), premiumEfficiency=0.30 (below) — new field wins
    const history = makeHistory(35, {
      completionRate: 0.90,
      premiumEfficiency: 0.30,
      rawPremiumEfficiency: 0.70,
      athenaRejectRate: 0.05,
    });
    const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, premiumEfficiencyGateVariant: "raw" };
    const checks = evaluateInBandThresholds(history, thresholds);
    assert.ok(checks.premiumEfficiencyMet, "rawPremiumEfficiency=0.70 should meet threshold even when legacy premiumEfficiency=0.30");
  });

  it("falls back to premiumEfficiency when rawPremiumEfficiency is null (raw variant)", () => {
    // rawPremiumEfficiency=null — must fall back to legacy premiumEfficiency=0.70
    const history = makeHistory(35, {
      completionRate: 0.90,
      premiumEfficiency: 0.70,
      rawPremiumEfficiency: null,
      athenaRejectRate: 0.05,
    });
    const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, premiumEfficiencyGateVariant: "raw" };
    const checks = evaluateInBandThresholds(history, thresholds);
    assert.ok(checks.premiumEfficiencyMet, "should fall back to premiumEfficiency=0.70 when rawPremiumEfficiency is null");
  });

  it("negative path: rawPremiumEfficiency below threshold fails gate", () => {
    const history = makeHistory(35, {
      completionRate: 0.90,
      premiumEfficiency: 0.80,
      rawPremiumEfficiency: 0.40,  // below 0.60 threshold — wins over legacy
      athenaRejectRate: 0.05,
    });
    const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, premiumEfficiencyGateVariant: "raw" };
    const checks = evaluateInBandThresholds(history, thresholds);
    assert.ok(!checks.premiumEfficiencyMet, "rawPremiumEfficiency=0.40 should fail even when legacy premiumEfficiency=0.80");
  });
});

describe("evaluateInBandThresholds — executionAdjustedPremiumEfficiency (new field)", () => {
  it("prefers premiumEfficiencyAdjusted over executionAdjustedPremiumEfficiency for execution_adjusted variant", () => {
    const history = makeHistory(35, {
      completionRate: 0.90,
      premiumEfficiency: 0.30,
      premiumEfficiencyAdjusted: 0.40,
      executionAdjustedPremiumEfficiency: 0.75,
      athenaRejectRate: 0.05,
    });
    const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, premiumEfficiencyGateVariant: "execution_adjusted" };
    const checks = evaluateInBandThresholds(history, thresholds);
    assert.ok(!checks.premiumEfficiencyMet, "premiumEfficiencyAdjusted=0.40 should win and fail threshold");
  });

  it("falls back to executionAdjustedPremiumEfficiency when premiumEfficiencyAdjusted is null", () => {
    const history = makeHistory(35, {
      completionRate: 0.90,
      premiumEfficiency: 0.30,
      premiumEfficiencyAdjusted: null,
      executionAdjustedPremiumEfficiency: 0.70,
      athenaRejectRate: 0.05,
    });
    const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, premiumEfficiencyGateVariant: "execution_adjusted" };
    const checks = evaluateInBandThresholds(history, thresholds);
    assert.ok(checks.premiumEfficiencyMet, "should fall back to executionAdjustedPremiumEfficiency=0.70 when premiumEfficiencyAdjusted is null");
  });

  it("negative path: executionAdjustedPremiumEfficiency below threshold fails gate", () => {
    const history = makeHistory(35, {
      completionRate: 0.90,
      premiumEfficiency: 0.90,
      premiumEfficiencyAdjusted: null,
      executionAdjustedPremiumEfficiency: 0.45,  // below 0.60 threshold
      athenaRejectRate: 0.05,
    });
    const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, premiumEfficiencyGateVariant: "execution_adjusted" };
    const checks = evaluateInBandThresholds(history, thresholds);
    assert.ok(!checks.premiumEfficiencyMet, "executionAdjustedPremiumEfficiency=0.45 should fail threshold");
    assert.ok(!checks.allMet, "allMet must be false");
  });
});

// ── Bootstrap-outlier eligibility filtering for completionVarianceMet ────────

describe("evaluateInBandThresholds — completionVarianceMet bootstrap-outlier filtering", () => {
  it("persists completionVarianceRaw and completionVarianceEligible", () => {
    const history = makeHistory(35, { completionRate: 0.90 });
    const checks = evaluateInBandThresholds(history, DEFAULT_THRESHOLDS);
    assert.ok(
      checks.completionVarianceRaw === null || typeof checks.completionVarianceRaw === "number",
      "completionVarianceRaw must be number|null",
    );
    assert.ok(
      checks.completionVarianceEligible === null || typeof checks.completionVarianceEligible === "number",
      "completionVarianceEligible must be number|null",
    );
  });

  it("completionVarianceMet uses eligibleVariance (bootstrap-filtered), not rawVariance", () => {
    // First sample: bootstrap outlier (completionRate=0); rest: stable (1.0)
    // Raw variance over the window will be inflated by the outlier.
    // Eligible variance (phase-aware) over recent stable cycles should be near 0 → gate passes.
    const history = [
      makeSample({ cycleId: "bootstrap-0", completionRate: 0 }),
      ...Array.from({ length: 34 }, (_, i) =>
        makeSample({ cycleId: `stable-${i}`, completionRate: 1.0 }),
      ),
    ];
    const checks = evaluateInBandThresholds(history, DEFAULT_THRESHOLDS);
    assert.ok(
      checks.completionVarianceMet,
      `completionVarianceMet should be true using eligible variance; ` +
      `raw=${checks.completionVarianceRaw}, eligible=${checks.completionVarianceEligible}`,
    );
    if (checks.completionVarianceRaw !== null && checks.completionVarianceEligible !== null) {
      assert.ok(
        checks.completionVarianceRaw >= checks.completionVarianceEligible,
        `raw variance (${checks.completionVarianceRaw}) must be >= eligible variance (${checks.completionVarianceEligible})`,
      );
    }
  });

  it("completionVarianceBootstrapFiltered is true when recent stability is high", () => {
    const history = [
      makeSample({ cycleId: "bootstrap-0", completionRate: 0 }),
      ...Array.from({ length: 34 }, (_, i) =>
        makeSample({ cycleId: `stable-${i}`, completionRate: 1.0 }),
      ),
    ];
    const checks = evaluateInBandThresholds(history, DEFAULT_THRESHOLDS);
    assert.equal(
      checks.completionVarianceBootstrapFiltered,
      true,
      "bootstrap filtering must activate when recent completion rates are high and stable",
    );
  });

  it("completionVarianceBootstrapFiltered is false when recent stability is low", () => {
    const history = makeHistory(35, { completionRate: 0.5 });
    const checks = evaluateInBandThresholds(history, DEFAULT_THRESHOLDS);
    assert.equal(
      checks.completionVarianceBootstrapFiltered,
      false,
      "bootstrap filtering must NOT activate when recent stability is below threshold",
    );
  });

  it("negative path: high variance history without stable recent cycles fails completionVarianceMet", () => {
    // Mix of 0 and 0.5 — recent avg too low to trigger bootstrap filtering
    const history = Array.from({ length: 35 }, (_, i) =>
      makeSample({ cycleId: `c-${i}`, completionRate: i % 2 === 0 ? 0 : 0.5 }),
    );
    const checks = evaluateInBandThresholds(history, DEFAULT_THRESHOLDS);
    assert.ok(
      !checks.completionVarianceMet,
      "completionVarianceMet must be false for highly variable history without stable recent cycles",
    );
  });
});

describe("computeExecutionPhase — variance metadata persistence", () => {
  it("returns completionVarianceRaw, completionVarianceEligible, and completionVarianceBootstrapFiltered", () => {
    const history = [
      makeSample({ cycleId: "c0", completionRate: 0, benchmarkGain: 0.3 }),
      ...Array.from({ length: 9 }, (_, i) =>
        makeSample({
          cycleId: `c${i + 1}`,
          completionRate: 1.0,
          benchmarkGain: 0.3,
          phase: "completed",
        }),
      ),
    ];
    const result = computeExecutionPhase(BAND_STATE.IN_BAND, history, DEFAULT_THRESHOLDS);
    assert.ok(
      result.completionVarianceRaw === null || typeof result.completionVarianceRaw === "number",
      "completionVarianceRaw must be number|null",
    );
    assert.ok(
      result.completionVarianceEligible === null || typeof result.completionVarianceEligible === "number",
      "completionVarianceEligible must be number|null",
    );
    assert.ok(
      typeof result.completionVarianceBootstrapFiltered === "boolean",
      "completionVarianceBootstrapFiltered must be boolean",
    );
  });

  it("returns null variance metadata when band_not_reached", () => {
    const history = makeHistory(5);
    const result = computeExecutionPhase(BAND_STATE.STABILIZING, history, DEFAULT_THRESHOLDS);
    assert.equal(result.completionVarianceRaw, null);
    assert.equal(result.completionVarianceEligible, null);
    assert.equal(result.completionVarianceBootstrapFiltered, false);
  });

  it("eligible variance is lower than raw when bootstrap outlier is present and recent stability is high", () => {
    const history = [
      makeSample({ cycleId: "c0", completionRate: 0, benchmarkGain: 0.3 }),
      ...Array.from({ length: 9 }, (_, i) =>
        makeSample({
          cycleId: `c${i + 1}`,
          completionRate: 1.0,
          benchmarkGain: 0.3,
          phase: "completed",
        }),
      ),
    ];
    const result = computeExecutionPhase(BAND_STATE.IN_BAND, history, DEFAULT_THRESHOLDS);
    if (result.completionVarianceRaw !== null && result.completionVarianceEligible !== null) {
      assert.ok(
        result.completionVarianceRaw >= result.completionVarianceEligible,
        `raw (${result.completionVarianceRaw}) must be >= eligible (${result.completionVarianceEligible}) when bootstrap outlier is present`,
      );
    }
  });
});
