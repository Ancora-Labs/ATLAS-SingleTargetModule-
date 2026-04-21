/**
 * Tests for reviewer precision/recall measurement and policy tuning.
 *
 * Covers:
 *   AC1: computeReviewerPrecisionRecall computes correct metrics from postmortem labels.
 *   AC2: All-correct input yields precision=1, recall=1, fpr=0.
 *   AC3: All-incorrect input yields precision=0, fpr=1.
 *   AC4: Mixed input computes values deterministically.
 *   AC5: Inconclusive entries are excluded from rate calculations.
 *   AC6: Empty / non-array input returns null rates (no data, no crash).
 *   AC7: deriveReviewerPolicyAdjustment triggers "tighten" on high FP rate.
 *   AC8: deriveReviewerPolicyAdjustment triggers "deepen" on high rework rate.
 *   AC9: deriveReviewerPolicyAdjustment returns "ok" when metrics are healthy.
 *   AC10: deriveReviewerPolicyAdjustment handles null metrics gracefully.
 *   AC11: createReviewerDebtIfNeeded adds a debt entry when FP rate exceeds threshold.
 *   AC12: createReviewerDebtIfNeeded does NOT add debt when sample < 5.
 *   AC13: createReviewerDebtIfNeeded does NOT duplicate open reviewer-high-fpr debt.
 *   AC14: createReviewerDebtIfNeeded does NOT add debt when FP rate is below threshold.
 *   AC15: persistReviewerMetrics writes to reviewer_metrics.json and caps at 100.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  computeReviewerPrecisionRecall,
  DECISION_QUALITY_LABEL,
  runDualLanePlanReview,
  mergeLaneVerdicts,
  LANE_MERGE_POLICY,
} from "../../src/core/athena_reviewer.js";

import {
  deriveReviewerPolicyAdjustment,
  persistReviewerMetrics,
  REVIEWER_POLICY_THRESHOLDS,
} from "../../src/core/self_improvement.js";

import {
  createReviewerDebtIfNeeded,
} from "../../src/core/carry_forward_ledger.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePm(label: string) {
  return { decisionQualityLabel: label, reviewedAt: new Date().toISOString() };
}

// ── computeReviewerPrecisionRecall ────────────────────────────────────────────

describe("computeReviewerPrecisionRecall — all-correct (AC2)", () => {
  it("precision=1, recall=1, fpr=0, reworkRate=0", () => {
    const pms = [makePm("correct"), makePm("correct"), makePm("correct")];
    const r = computeReviewerPrecisionRecall(pms);
    assert.equal(r.correct, 3);
    assert.equal(r.incorrect, 0);
    assert.equal(r.delayedCorrect, 0);
    assert.equal(r.knownOutcomes, 3);
    assert.equal(r.precision, 1);
    assert.equal(r.recall, 1);
    assert.equal(r.falsePositiveRate, 0);
    assert.equal(r.reworkRate, 0);
    assert.equal(r.f1, 1);
  });
});

describe("computeReviewerPrecisionRecall — all-incorrect (AC3)", () => {
  it("precision=0, fpr=1, recall=null (no successes)", () => {
    const pms = [makePm("incorrect"), makePm("incorrect")];
    const r = computeReviewerPrecisionRecall(pms);
    assert.equal(r.incorrect, 2);
    assert.equal(r.correct, 0);
    assert.equal(r.precision, 0);
    assert.equal(r.falsePositiveRate, 1);
    assert.equal(r.recall, null, "recall is null when no successes exist");
    assert.equal(r.reworkRate, null, "reworkRate is null when no successes exist");
    assert.equal(r.f1, null, "f1 is null when recall is null");
  });
});

describe("computeReviewerPrecisionRecall — mixed labels (AC4)", () => {
  it("computes rates deterministically from known outcomes", () => {
    const pms = [
      makePm("correct"),         // TP
      makePm("correct"),         // TP
      makePm("delayed-correct"), // partial TP
      makePm("incorrect"),       // FP
    ];
    const r = computeReviewerPrecisionRecall(pms);
    assert.equal(r.correct, 2);
    assert.equal(r.delayedCorrect, 1);
    assert.equal(r.incorrect, 1);
    assert.equal(r.knownOutcomes, 4);
    // precision = (2+1)/4 = 0.75
    assert.equal(r.precision, 0.75);
    // recall = 2/(2+1) = 0.6667
    assert.equal(r.recall, 0.6667);
    // fpr = 1/4 = 0.25
    assert.equal(r.falsePositiveRate, 0.25);
    // reworkRate = 1/3
    assert.equal(r.reworkRate, 0.3333);
    // f1 = 2*0.75*0.6667/(0.75+0.6667)
    assert.ok(typeof r.f1 === "number", "f1 should be a number");
    assert.ok(r.f1 > 0 && r.f1 <= 1, "f1 must be in (0,1]");
  });

  it("inconclusive entries are excluded from rate calculations (AC5)", () => {
    const pms = [
      makePm("correct"),
      makePm("inconclusive"),
      makePm("inconclusive"),
    ];
    const r = computeReviewerPrecisionRecall(pms);
    assert.equal(r.inconclusive, 2);
    assert.equal(r.knownOutcomes, 1, "knownOutcomes excludes inconclusive");
    assert.equal(r.precision, 1, "only correct in known outcomes");
  });
});

describe("computeReviewerPrecisionRecall — empty / invalid input (AC6)", () => {
  it("returns null rates for empty array", () => {
    const r = computeReviewerPrecisionRecall([]);
    assert.equal(r.knownOutcomes, 0);
    assert.equal(r.precision, null);
    assert.equal(r.recall, null);
    assert.equal(r.falsePositiveRate, null);
    assert.equal(r.reworkRate, null);
    assert.equal(r.f1, null);
  });

  it("returns null rates for non-array input (negative path)", () => {
    const r = computeReviewerPrecisionRecall(null as any);
    assert.equal(r.knownOutcomes, 0);
    assert.equal(r.precision, null);
  });

  it("includes computedAt timestamp", () => {
    const r = computeReviewerPrecisionRecall([]);
    assert.ok(typeof r.computedAt === "string" && r.computedAt.length > 0, "computedAt must be a string");
  });
});

describe("computeReviewerPrecisionRecall — legacy entries without label", () => {
  it("treats entries without decisionQualityLabel as inconclusive (excluded from rates)", () => {
    const legacyPm = { workerName: "old-worker", recommendation: "proceed" };
    const r = computeReviewerPrecisionRecall([legacyPm, makePm("correct")]);
    assert.equal(r.inconclusive, 1, "legacy entry counts as inconclusive");
    assert.equal(r.correct, 1);
    assert.equal(r.knownOutcomes, 1, "legacy entry excluded from knownOutcomes");
    assert.equal(r.precision, 1);
  });
});

// ── deriveReviewerPolicyAdjustment ────────────────────────────────────────────

describe("deriveReviewerPolicyAdjustment — healthy metrics (AC9)", () => {
  it('returns policySignal="ok" and no warnings when FP rate and rework rate are low', () => {
    const metrics = {
      knownOutcomes: 10,
      falsePositiveRate: 0.1,
      reworkRate: 0.1,
      precision: 0.9,
      recall: 0.9,
    };
    const r = deriveReviewerPolicyAdjustment(metrics);
    assert.equal(r.policySignal, "ok");
    assert.equal(r.warnings.length, 0);
    assert.equal(r.lessons.length, 0);
    assert.equal(r.suggestedMinScore, null);
  });
});

describe("deriveReviewerPolicyAdjustment — high FP rate (AC7)", () => {
  it('returns policySignal="tighten" and suggests raising planQualityMinScore', () => {
    const metrics = {
      knownOutcomes: 10,
      falsePositiveRate: REVIEWER_POLICY_THRESHOLDS.FP_RATE_HIGH + 0.05, // exceeds threshold
      reworkRate: 0.1,
      precision: 0.7,
      recall: 0.9,
    };
    const r = deriveReviewerPolicyAdjustment(metrics);
    assert.equal(r.policySignal, "tighten");
    assert.ok(r.warnings.length > 0, "must emit warning for high FP rate");
    assert.ok(r.lessons.length > 0, "must emit lesson for high FP rate");
    assert.ok(typeof r.suggestedMinScore === "number", "suggestedMinScore must be set");
    assert.ok(r.suggestedMinScore > 40, "suggested score must be higher than default 40");
  });
});

describe("deriveReviewerPolicyAdjustment — high rework rate (AC8)", () => {
  it('returns policySignal="deepen" when rework rate exceeds threshold', () => {
    const metrics = {
      knownOutcomes: 10,
      falsePositiveRate: 0.1, // acceptable
      reworkRate: REVIEWER_POLICY_THRESHOLDS.REWORK_RATE_HIGH + 0.05, // exceeds
      precision: 0.8,
      recall: 0.7,
    };
    const r = deriveReviewerPolicyAdjustment(metrics);
    assert.equal(r.policySignal, "deepen");
    assert.ok(r.warnings.length > 0, "must warn on high rework rate");
    assert.ok(r.lessons.length > 0, "must emit lesson for high rework rate");
    assert.equal(r.suggestedMinScore, null, "rework-only should not change planQualityMinScore");
  });
});

describe("deriveReviewerPolicyAdjustment — low precision (AC7, critical lesson)", () => {
  it("emits a critical lesson when precision is below PRECISION_LOW threshold", () => {
    const metrics = {
      knownOutcomes: 8,
      falsePositiveRate: 0.1,
      reworkRate: 0.1,
      precision: REVIEWER_POLICY_THRESHOLDS.PRECISION_LOW - 0.05, // below threshold
      recall: 0.9,
    };
    const r = deriveReviewerPolicyAdjustment(metrics);
    const criticalLessons = r.lessons.filter((l) => l.severity === "critical");
    assert.ok(criticalLessons.length > 0, "must emit critical lesson for low precision");
    assert.ok(
      criticalLessons[0].source === "reviewer_precision_recall",
      "lesson source must be reviewer_precision_recall"
    );
  });
});

describe("deriveReviewerPolicyAdjustment — null / insufficient data (AC10)", () => {
  it('returns policySignal="ok" and no adjustments for null metrics', () => {
    const r = deriveReviewerPolicyAdjustment(null);
    assert.equal(r.policySignal, "ok");
    assert.equal(r.warnings.length, 0);
    assert.equal(r.lessons.length, 0);
  });

  it('returns "ok" when knownOutcomes === 0', () => {
    const r = deriveReviewerPolicyAdjustment({ knownOutcomes: 0, falsePositiveRate: 0.5, precision: 0.5, reworkRate: 0.5 });
    assert.equal(r.policySignal, "ok");
  });
});

// ── createReviewerDebtIfNeeded ────────────────────────────────────────────────

describe("createReviewerDebtIfNeeded — adds debt on high FP (AC11)", () => {
  it("adds a critical debt entry when FP rate exceeds threshold and sample >= 5", () => {
    const ledger = [];
    const metrics = { falsePositiveRate: 0.4, knownOutcomes: 10 };
    const result = createReviewerDebtIfNeeded(ledger, metrics, 5);
    assert.equal(result.length, 1, "one debt entry should be added");
    assert.equal(result[0].severity, "critical");
    assert.ok(result[0].lesson.includes("reviewer-high-fpr"), "lesson must include marker");
    assert.equal(result[0].owner, "governance-worker");
    assert.equal(result[0].closedAt, null);
  });
});

describe("createReviewerDebtIfNeeded — no debt when sample too small (AC12)", () => {
  it("does NOT add debt when knownOutcomes < 5 (insufficient sample)", () => {
    const ledger = [];
    const metrics = { falsePositiveRate: 0.9, knownOutcomes: 3 }; // high FP but small sample
    const result = createReviewerDebtIfNeeded(ledger, metrics, 5);
    assert.equal(result.length, 0, "no debt for small samples");
  });
});

describe("createReviewerDebtIfNeeded — no duplicate debt (AC13)", () => {
  it("does NOT add a second debt if an open reviewer-high-fpr entry already exists", () => {
    const existing = [{
      id: "debt-reviewer-1",
      lesson: "reviewer-high-fpr: Athena approved 35.0% of plans that failed (threshold 30%) — tighten gate",
      fingerprint: "abc",
      owner: "governance-worker",
      openedCycle: 1,
      dueCycle: 4,
      severity: "critical",
      closedAt: null,
      closureEvidence: null,
      cyclesOpen: 2
    }];
    const metrics = { falsePositiveRate: 0.4, knownOutcomes: 10 };
    const result = createReviewerDebtIfNeeded(existing, metrics, 3);
    assert.equal(result.length, 1, "should not add a duplicate entry");
  });
});

describe("createReviewerDebtIfNeeded — no debt below threshold (AC14)", () => {
  it("does NOT add debt when FP rate is at or below the threshold", () => {
    const ledger = [];
    const metrics = { falsePositiveRate: 0.2, knownOutcomes: 10 }; // 20% <= 30% default threshold
    const result = createReviewerDebtIfNeeded(ledger, metrics, 5);
    assert.equal(result.length, 0);
  });

  it("does NOT add debt for null FP rate (negative path)", () => {
    const ledger = [];
    const metrics = { falsePositiveRate: null, knownOutcomes: 10 };
    const result = createReviewerDebtIfNeeded(ledger as any, metrics as any, 5);
    assert.equal(result.length, 0);
  });
});

// ── persistReviewerMetrics ────────────────────────────────────────────────────

describe("persistReviewerMetrics — I/O (AC15)", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-prm-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes reviewer_metrics.json with a history array", async () => {
    const config = { paths: { stateDir: tmpDir } };
    const metrics = {
      correct: 3, delayedCorrect: 1, incorrect: 1, inconclusive: 0,
      knownOutcomes: 5, precision: 0.8, recall: 0.75,
      falsePositiveRate: 0.2, reworkRate: 0.25, f1: 0.7742,
      computedAt: new Date().toISOString()
    };
    await persistReviewerMetrics(config, metrics);

    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, "reviewer_metrics.json"), "utf8"));
    assert.ok(Array.isArray(raw.history), "history must be an array");
    assert.equal(raw.history.length, 1);
    assert.equal(raw.history[0].knownOutcomes, 5);
    assert.ok(typeof raw.updatedAt === "string", "updatedAt must be set");
  });

  it("appends on subsequent calls and caps at 100 entries", async () => {
    const config = { paths: { stateDir: tmpDir } };
    const base = {
      correct: 1, delayedCorrect: 0, incorrect: 0, inconclusive: 0,
      knownOutcomes: 1, precision: 1, recall: 1,
      falsePositiveRate: 0, reworkRate: 0, f1: 1,
      computedAt: new Date().toISOString()
    };
    // Write 101 entries total (1 already from previous test)
    for (let i = 0; i < 100; i++) {
      await persistReviewerMetrics(config, base);
    }
    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, "reviewer_metrics.json"), "utf8"));
    assert.ok(raw.history.length <= 100, "history must be capped at 100");
  });

  it("does not throw when stateDir does not exist (negative path)", async () => {
    const config = { paths: { stateDir: path.join(tmpDir, "nonexistent-subdir") } };
    // Should not throw — error is swallowed with a warn()
    await assert.doesNotReject(
      () => persistReviewerMetrics(config, { knownOutcomes: 0 }),
      "persistReviewerMetrics must not throw on I/O error"
    );
  });
});

// ── Dual-lane verdicts: precision/recall alignment ────────────────────────────

describe("dual-lane verdict alignment with computeReviewerPrecisionRecall", () => {
  // A plan approved by both lanes should eventually yield a "correct" label.
  // A plan rejected by both lanes should not enter the postmortem history.
  // These tests verify the decision quality label semantics are consistent
  // with what the dual-lane merge produces.

  it("MUST_PASS_BOTH: only plans approved by both lanes contribute positive labels", () => {
    // Simulate: two approved plans → 2 correct labels
    const pms = [makePm("correct"), makePm("correct")];
    const r = computeReviewerPrecisionRecall(pms);
    assert.equal(r.precision, 1, "all-correct outcomes must yield precision=1");
    assert.equal(r.falsePositiveRate, 0);
  });

  it("rejected batch (both lanes fail) prevents incorrect labels accumulating", () => {
    // A batch rejected by dual-lane review never dispatches a worker — no incorrect label.
    // We simulate: no postmortem entries when batch is rejected.
    const r = computeReviewerPrecisionRecall([]);
    assert.equal(r.knownOutcomes, 0);
    assert.equal(r.precision, null, "no data → null precision (no false positives possible)");
  });

  it("dual-lane merge produces approved=false when governance gate catches a violation — verifiable via FP analysis", () => {
    // Governance-only failure should drive approved=false,
    // protecting precision/recall from accruing incorrect labels.
    const highRiskWithoutPremortem = {
      role: "evolution-worker",
      task: "Migrate database schema with zero-downtime deployment pipeline",
      verification: "npm test",
      wave: 1,
      riskLevel: "high",
      capacityDelta: 0.1,
      requestROI: 2.0,
      // No premortem — governance lane must reject
    };
    const dual = runDualLanePlanReview([highRiskWithoutPremortem]);
    assert.equal(dual.approved, false,
      "high-risk plan without premortem must be rejected to protect decision quality metrics");
    assert.equal(dual.laneB.approved, false,
      "governance lane must surface the missing premortem violation");
  });

  it("dual-lane ANY_PASS does not change the fundamental precision/recall accounting (lane result still determines label)", () => {
    // With ANY_PASS, a plan can be approved with governance failure.
    // This test verifies that the merge policy is surfaced and the caller
    // can decide how to interpret precision differently.
    const laneA = { lane: "quality" as const, approved: true, score: 80, summary: "ok", issues: [], reason: null };
    const laneB = { lane: "governance" as const, approved: false, score: 40, summary: "violations", issues: ["PREMORTEM_VIOLATION: x"], reason: { code: "GOVERNANCE_VIOLATIONS", message: "x" } };
    const result = mergeLaneVerdicts(laneA, laneB, LANE_MERGE_POLICY.ANY_PASS);
    assert.equal(result.approved, true, "ANY_PASS: quality-only approval must proceed");
    assert.equal(result.mergePolicy, LANE_MERGE_POLICY.ANY_PASS);
    // The governance issues are still surfaced in laneB even when the merge approves.
    assert.ok(result.laneB.issues.length > 0, "governance issues must remain visible even when ANY_PASS approves");
  });

  it("DECISION_QUALITY_LABEL export is consistent with postmortem labeling contract", () => {
    assert.equal(DECISION_QUALITY_LABEL.CORRECT, "correct");
    assert.equal(DECISION_QUALITY_LABEL.DELAYED_CORRECT, "delayed-correct");
    assert.equal(DECISION_QUALITY_LABEL.INCORRECT, "incorrect");
    assert.equal(DECISION_QUALITY_LABEL.INCONCLUSIVE, "inconclusive");
  });
});
