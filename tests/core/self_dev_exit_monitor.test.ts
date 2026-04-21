import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EXIT_STATE,
  DEFAULT_EXIT_THRESHOLDS,
  evaluateExitChecks,
  computeExitNextState,
  type ExitThresholds,
  type ExitSignalInputs,
} from "../../src/core/self_dev_exit_monitor.js";

const TIGHT_THRESHOLDS: ExitThresholds = {
  minBootstrapCycles:       5,
  measurementWindow:        10,
  capacityDeltaThreshold:   0.02,
  minExploitationCycles:    3,
  noveltyYieldMax:          0.20,
  roiDeltaThreshold:        0.10,
  minRoiSuccessRate:        0.60,
  maxPendingBenchmarkRatio: 0.40,
  maxOpenBacklogRatio:      0.25,
};

function makeInputs(overrides: Partial<ExitSignalInputs> = {}): ExitSignalInputs {
  return {
    capacityEarlyAvg: 0.72,
    capacityLateAvg: 0.73,
    capacityDelta: 0.01,
    consecutiveExploitationCycles: 4,
    noveltyYield: 0.10,
    roiEarlyAvg: 0.72,
    roiLateAvg: 0.75,
    roiDelta: 0.03,
    roiSuccessRate: 0.70,
    benchmarkPendingRatio: 0.25,
    backlogOpenRatio: 0.10,
    regressionClean: true,
    ...overrides,
  };
}

// ── evaluateExitChecks ───────────────────────────────────────────────────────

describe("evaluateExitChecks", () => {
  it("core stop and extra guards pass when metrics satisfy thresholds", () => {
    const { checks } = evaluateExitChecks(makeInputs(), TIGHT_THRESHOLDS);
    assert.strictEqual(checks.capacityPlateauMet, true);
    assert.strictEqual(checks.exploitationHeldMet, true);
    assert.strictEqual(checks.noveltyYieldMet, true);
    assert.strictEqual(checks.roiPlateauMet, true);
    assert.strictEqual(checks.regressionCleanMet, true);
    assert.strictEqual(checks.stabilityMet, true);
    assert.strictEqual(checks.coreStopMet, true);
    assert.strictEqual(checks.benchmarkGapClosedMet, true);
    assert.strictEqual(checks.backlogQualityMet, true);
    assert.strictEqual(checks.allMet, true);
  });

  it("fails core stop when capacity delta is above threshold", () => {
    const { checks } = evaluateExitChecks(
      makeInputs({ capacityDelta: 0.05 }),
      TIGHT_THRESHOLDS,
    );
    assert.strictEqual(checks.capacityPlateauMet, false);
    assert.strictEqual(checks.coreStopMet, false);
    assert.strictEqual(checks.allMet, false);
  });

  it("fails when exploitation streak is below threshold", () => {
    const { checks } = evaluateExitChecks(
      makeInputs({ consecutiveExploitationCycles: 2 }),
      TIGHT_THRESHOLDS,
    );
    assert.strictEqual(checks.exploitationHeldMet, false);
    assert.strictEqual(checks.allMet, false);
  });

  it("fails when novelty yield is still high", () => {
    const { checks } = evaluateExitChecks(
      makeInputs({ noveltyYield: 0.35 }),
      TIGHT_THRESHOLDS,
    );
    assert.strictEqual(checks.noveltyYieldMet, false);
    assert.strictEqual(checks.allMet, false);
  });

  it("fails when ROI is volatile or below floor", () => {
    const byDelta = evaluateExitChecks(
      makeInputs({ roiDelta: 0.25 }),
      TIGHT_THRESHOLDS,
    );
    assert.strictEqual(byDelta.checks.roiPlateauMet, false);

    const byFloor = evaluateExitChecks(
      makeInputs({ roiDelta: 0.02, roiSuccessRate: 0.45 }),
      TIGHT_THRESHOLDS,
    );
    assert.strictEqual(byFloor.checks.roiPlateauMet, false);
  });

  it("fails when regression cleanliness is broken", () => {
    const { checks } = evaluateExitChecks(
      makeInputs({ regressionClean: false }),
      TIGHT_THRESHOLDS,
    );
    assert.strictEqual(checks.regressionCleanMet, false);
    assert.strictEqual(checks.allMet, false);
  });

  it("fails when benchmark gap or backlog quality thresholds are not met", () => {
    const benchmarkFail = evaluateExitChecks(
      makeInputs({ benchmarkPendingRatio: 0.80 }),
      TIGHT_THRESHOLDS,
    );
    assert.strictEqual(benchmarkFail.checks.benchmarkGapClosedMet, false);

    const backlogFail = evaluateExitChecks(
      makeInputs({ backlogOpenRatio: 0.40 }),
      TIGHT_THRESHOLDS,
    );
    assert.strictEqual(backlogFail.checks.backlogQualityMet, false);
  });
});

// ── computeExitNextState ─────────────────────────────────────────────────────

describe("computeExitNextState", () => {
  const allMet = {
    capacityPlateauMet: true,
    exploitationHeldMet: true,
    noveltyYieldMet: true,
    roiPlateauMet: true,
    regressionCleanMet: true,
    stabilityMet: true,
    coreStopMet: true,
    benchmarkGapClosedMet: true,
    backlogQualityMet: true,
    allMet: true,
  };
  const noneMet = {
    capacityPlateauMet: false,
    exploitationHeldMet: false,
    noveltyYieldMet: false,
    roiPlateauMet: false,
    regressionCleanMet: false,
    stabilityMet: false,
    coreStopMet: false,
    benchmarkGapClosedMet: false,
    backlogQualityMet: false,
    allMet: false,
  };

  it("returns BOOTSTRAPPING when cyclesEvaluated < minBootstrapCycles", () => {
    const { nextState } = computeExitNextState(EXIT_STATE.BOOTSTRAPPING, allMet, 3, TIGHT_THRESHOLDS);
    assert.strictEqual(nextState, EXIT_STATE.BOOTSTRAPPING);
  });

  it("returns PLATEAU_DETECTED when all signals met after bootstrap", () => {
    const { nextState } = computeExitNextState(EXIT_STATE.MONITORING, allMet, 10, TIGHT_THRESHOLDS);
    assert.strictEqual(nextState, EXIT_STATE.PLATEAU_DETECTED);
  });

  it("returns MONITORING when not all signals met", () => {
    const { nextState } = computeExitNextState(EXIT_STATE.MONITORING, noneMet, 10, TIGHT_THRESHOLDS);
    assert.strictEqual(nextState, EXIT_STATE.MONITORING);
  });

  it("reverts PLATEAU_DETECTED → MONITORING when signals are no longer met", () => {
    const { nextState } = computeExitNextState(EXIT_STATE.PLATEAU_DETECTED, noneMet, 20, TIGHT_THRESHOLDS);
    assert.strictEqual(nextState, EXIT_STATE.MONITORING);
  });

  it("stays PLATEAU_DETECTED if signals continue to hold", () => {
    const { nextState } = computeExitNextState(EXIT_STATE.PLATEAU_DETECTED, allMet, 20, TIGHT_THRESHOLDS);
    assert.strictEqual(nextState, EXIT_STATE.PLATEAU_DETECTED);
  });

  it("reason includes failed signal names when not all met", () => {
    const { reason } = computeExitNextState(EXIT_STATE.MONITORING, noneMet, 10, TIGHT_THRESHOLDS);
    assert.ok(reason.includes("capacity_not_plateaued"), `reason=${reason}`);
    assert.ok(reason.includes("novelty_yield_still_high"), `reason=${reason}`);
    assert.ok(reason.includes("roi_not_plateaued_or_below_floor"), `reason=${reason}`);
    assert.ok(reason.includes("stability_not_satisfied"), `reason=${reason}`);
    assert.ok(reason.includes("benchmark_gap_not_closed"), `reason=${reason}`);
    assert.ok(reason.includes("backlog_quality_insufficient"), `reason=${reason}`);
  });
});

// ── DEFAULT_EXIT_THRESHOLDS guard ────────────────────────────────────────────

describe("DEFAULT_EXIT_THRESHOLDS", () => {
  it("has expected default values", () => {
    assert.strictEqual(DEFAULT_EXIT_THRESHOLDS.minBootstrapCycles,       20);
    assert.strictEqual(DEFAULT_EXIT_THRESHOLDS.measurementWindow,        20);
    assert.strictEqual(DEFAULT_EXIT_THRESHOLDS.capacityDeltaThreshold,    0.02);
    assert.strictEqual(DEFAULT_EXIT_THRESHOLDS.minExploitationCycles,     8);
    assert.strictEqual(DEFAULT_EXIT_THRESHOLDS.noveltyYieldMax,           0.25);
    assert.strictEqual(DEFAULT_EXIT_THRESHOLDS.roiDeltaThreshold,         0.10);
    assert.strictEqual(DEFAULT_EXIT_THRESHOLDS.minRoiSuccessRate,         0.55);
    assert.strictEqual(DEFAULT_EXIT_THRESHOLDS.maxPendingBenchmarkRatio,  0.40);
    assert.strictEqual(DEFAULT_EXIT_THRESHOLDS.maxOpenBacklogRatio,       0.25);
  });

  it("is frozen (immutable)", () => {
    assert.ok(Object.isFrozen(DEFAULT_EXIT_THRESHOLDS));
  });
});
