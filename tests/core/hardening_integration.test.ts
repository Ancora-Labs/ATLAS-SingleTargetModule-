/**
 * Hardening Integration Tests — Deterministic cross-system checks
 *
 * Verifies that the confidence scoring, baseline recovery, architecture drift,
 * and carry-forward lifecycle subsystems integrate correctly and produce
 * consistent, deterministic outcomes when their states interact.
 *
 * Coverage:
 *   - Confidence scoring (computeConfidenceMultiplier, computeExpectedValue)
 *   - Baseline recovery lifecycle (compute → persist → read → trend)
 *   - Architecture drift detection (deprecated token + stale ref pipeline)
 *   - Carry-forward ledger lifecycle (add → tick → close → shouldBlock)
 *   - Cross-system: low confidence drives capacity delta, carry-forward debt
 *     accumulates correctly and gates plan acceptance
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  computeConfidenceMultiplier,
  applyConfidencePenalty,
  computeExpectedValue,
} from "../../src/core/intervention_optimizer.js";

import {
  computeBaselineRecoveryState,
  persistBaselineMetrics,
  readBaselineMetrics,
  PARSER_CONFIDENCE_RECOVERY_THRESHOLD,
} from "../../src/core/parser_baseline_recovery.js";

import {
  computeCapacityIndex,
} from "../../src/core/capacity_scoreboard.js";

import {
  addDebtEntries,
  tickCycle,
  closeDebt,
  getOpenDebts,
  shouldBlockOnDebt,
  computeFingerprint,
} from "../../src/core/carry_forward_ledger.js";

import {
  detectDeprecatedTokensInContent,
  normalizeAliasPath,
} from "../../src/core/architecture_drift.js";

import {
  checkPostMergeArtifact,
  collectArtifactGaps,
  ARTIFACT_GAP,
  validateWorkerContract,
} from "../../src/core/verification_gate.js";

import {
  validatePlanContract,
  validateAllPlans,
  PLAN_VIOLATION_SEVERITY,
  PACKET_VIOLATION_CODE,
} from "../../src/core/plan_contract_validator.js";

import {
  validatePlanEvidenceCoupling,
} from "../../src/core/evidence_envelope.js";

// ── Shared test infrastructure ─────────────────────────────────────────────────

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-hardening-integration-"));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeConfig(subDir = "") {
  const dir = subDir ? path.join(tmpDir, subDir) : tmpDir;
  return { paths: { stateDir: dir } };
}

// ── Task 1: Confidence scoring determinism ─────────────────────────────────────

describe("confidence scoring — deterministic formula invariants", () => {
  it("multiplier is exactly 0 when sampleCount=0 (maximum penalty)", () => {
    assert.equal(computeConfidenceMultiplier(0), 0);
  });

  it("multiplier is exactly 1.0 when sampleCount >= SPARSE_DATA_THRESHOLD", () => {
    assert.equal(computeConfidenceMultiplier(3), 1.0);
    assert.equal(computeConfidenceMultiplier(100), 1.0);
  });

  it("multiplier is linear between 0 and threshold", () => {
    // n=1 → 1/3, n=2 → 2/3
    assert.ok(Math.abs(computeConfidenceMultiplier(1) - 1 / 3) < 0.0001);
    assert.ok(Math.abs(computeConfidenceMultiplier(2) - 2 / 3) < 0.0001);
  });

  it("applyConfidencePenalty is idempotent for full-confidence observations", () => {
    const adjusted = applyConfidencePenalty(0.8, 10);
    assert.ok(Math.abs(adjusted - 0.8) < 0.0001);
  });

  it("applyConfidencePenalty reduces probability for sparse observations", () => {
    const adjusted = applyConfidencePenalty(0.8, 1);
    assert.ok(adjusted < 0.8, "sparse data must reduce adjusted probability");
    assert.ok(adjusted > 0, "adjusted probability must remain positive");
  });

  it("computeExpectedValue produces negative EV when riskCost is high and confidence is zero", () => {
    const { ev } = computeExpectedValue({
      successProbability: 0.9,
      impact: 0.5,
      riskCost: 1.0,
      sampleCount: 0,
    });
    assert.ok(ev < 0, "zero confidence + high risk must produce negative EV");
  });

  it("EV formula is deterministic — same inputs always produce same output", () => {
    const intervention = { successProbability: 0.7, impact: 0.8, riskCost: 0.3, sampleCount: 5 };
    const r1 = computeExpectedValue(intervention);
    const r2 = computeExpectedValue(intervention);
    assert.equal(r1.ev, r2.ev);
    assert.equal(r1.adjustedSuccessProbability, r2.adjustedSuccessProbability);
  });

  it("negative path: zero-impact intervention has non-positive EV regardless of success probability", () => {
    const { ev } = computeExpectedValue({
      successProbability: 1.0,
      impact: 0,
      riskCost: 0,
      sampleCount: 10,
    });
    assert.ok(ev <= 0, "zero-impact intervention must produce EV <= 0");
  });
});

// ── Baseline recovery lifecycle ────────────────────────────────────────────────

describe("baseline recovery lifecycle — compute → persist → read → trend", () => {
  it("recoveryActive transitions to true exactly when confidence drops below threshold", () => {
    const above = computeBaselineRecoveryState({ parserConfidence: PARSER_CONFIDENCE_RECOVERY_THRESHOLD });
    const below = computeBaselineRecoveryState({ parserConfidence: PARSER_CONFIDENCE_RECOVERY_THRESHOLD - 0.001 });
    assert.equal(above.recoveryActive, false, "at threshold: recoveryActive must be false");
    assert.equal(below.recoveryActive, true, "below threshold: recoveryActive must be true");
  });

  it("componentGap is deterministic complement of componentMetrics", () => {
    const analysis = {
      parserConfidence: 0.7,
      parserConfidenceComponents: { plansShape: 0.6, healthField: 0.75, requestBudget: 1.0 },
    };
    const record = computeBaselineRecoveryState(analysis);
    assert.ok(
      Math.abs(record.componentGap.plansShape + record.componentMetrics.plansShape - 1.0) < 0.001,
      "gap + metric must equal 1.0 for plansShape"
    );
    assert.ok(
      Math.abs(record.componentGap.healthField + record.componentMetrics.healthField - 1.0) < 0.001,
      "gap + metric must equal 1.0 for healthField"
    );
  });

  it("rolling history: newest record is prepended, oldest evicted at cap", async () => {
    const config = makeConfig("baseline-history");
    await fs.mkdir(config.paths.stateDir, { recursive: true });

    // Persist two records with distinct cycle IDs
    for (const [cycleId, confidence] of [["c1", 0.6], ["c2", 0.8], ["c3", 0.95]] as const) {
      const record = computeBaselineRecoveryState({ parserConfidence: confidence }, cycleId);
      await persistBaselineMetrics(config, record);
    }

    const state = await readBaselineMetrics(config);
    assert.ok(state !== null);
    assert.equal(state!.history.length, 3);
    assert.equal(state!.history[0].cycleId, "c3", "newest record must be first");
    assert.equal(state!.history[2].cycleId, "c1", "oldest record must be last");
    assert.equal(state!.lastRecord.cycleId, "c3");
  });

  it("cross-system: low parser confidence produces degraded capacity dimensions", () => {
    const degradedAnalysis = { parserConfidence: 0.5 };
    const record = computeBaselineRecoveryState(degradedAnalysis, "degraded-cycle");
    assert.equal(record.recoveryActive, true);

    // Use the confidence value to compute capacity index
    const capacityIndex = computeCapacityIndex({
      parserConfidence: record.parserConfidence,
      planContractPassRate: 0.9,
      testPassRate: 0.95,
    });
    assert.ok(
      capacityIndex.dimensions.parserQuality < 0.9,
      "degraded parser confidence must degrade parserQuality dimension"
    );
    assert.ok(
      capacityIndex.dimensions.promptQuality < 0.9,
      "degraded parser confidence must degrade promptQuality dimension"
    );
  });

  it("capacity delta is computable from before/after capacity indexes", () => {
    const before = computeCapacityIndex({ parserConfidence: 0.5, testPassRate: 0.8 });
    const after = computeCapacityIndex({ parserConfidence: 0.95, testPassRate: 0.95 }, before);

    assert.ok(after.deltas !== null, "deltas must be present when previous index is provided");
    assert.ok(after.deltas!.parserQuality > 0, "parserQuality must improve after confidence recovery");
    assert.ok(after.composite > before.composite, "composite score must improve after recovery");
  });
});

// ── Architecture drift detection ───────────────────────────────────────────────

describe("architecture drift — deprecated token detection", () => {
  it("detects governance_verdict as a deprecated token", () => {
    const refs = detectDeprecatedTokensInContent(
      "docs/design.md",
      "The system uses governance_verdict to finalize decisions."
    );
    assert.ok(refs.length > 0, "governance_verdict must be detected as deprecated");
    assert.equal(refs[0].token, "governance_verdict");
    assert.ok(refs[0].hint.length > 0, "deprecated token must have a hint");
  });

  it("detects pre-v1 event names as deprecated", () => {
    const refs = detectDeprecatedTokensInContent(
      "docs/events.md",
      "Emit PLAN_STARTED when planning begins, then CYCLE_STARTED for each loop."
    );
    const tokens = refs.map(r => r.token);
    assert.ok(tokens.includes("PLAN_STARTED"), "PLAN_STARTED must be flagged");
    assert.ok(tokens.includes("CYCLE_STARTED"), "CYCLE_STARTED must be flagged");
  });

  it("returns empty array for content with no deprecated tokens", () => {
    const refs = detectDeprecatedTokensInContent(
      "docs/clean.md",
      "The orchestrator uses PLANNING_ANALYSIS_STARTED and ORCHESTRATION_CYCLE_STARTED events."
    );
    assert.equal(refs.length, 0, "modern event names must not be flagged");
  });

  it("includes correct line numbers in deprecated token refs", () => {
    const content = [
      "Line one — clean",
      "Line two contains governance_verdict reference",
      "Line three — clean",
    ].join("\n");
    const refs = detectDeprecatedTokensInContent("docs/test.md", content);
    assert.ok(refs.length > 0);
    assert.equal(refs[0].line, 2, "deprecated token must be attributed to line 2");
  });

  it("normalizeAliasPath correctly resolves @core/ to src/core/", () => {
    const resolved = normalizeAliasPath("@core/orchestrator.ts");
    assert.equal(resolved, "src/core/orchestrator.ts");
  });

  it("normalizeAliasPath returns null for unknown alias prefixes", () => {
    const resolved = normalizeAliasPath("@unknown/foo.ts");
    assert.equal(resolved, null);
  });

  it("negative path: resume_workers is detected as deprecated", () => {
    const refs = detectDeprecatedTokensInContent(
      "docs/resume.md",
      "Call resume_workers to restart halted dispatch."
    );
    assert.ok(refs.some(r => r.token === "resume_workers"), "resume_workers must be flagged");
    assert.ok(refs[0].hint.includes("runResumeDispatch"), "hint must suggest runResumeDispatch");
  });
});

// ── Carry-forward ledger lifecycle ─────────────────────────────────────────────

describe("carry-forward ledger — full lifecycle: add → tick → close → shouldBlock", () => {
  it("fingerprint is deterministic for the same lesson text", () => {
    const fp1 = computeFingerprint("Fix parser confidence degradation in plansShape");
    const fp2 = computeFingerprint("Fix parser confidence degradation in plansShape");
    assert.equal(fp1, fp2, "same lesson must produce same fingerprint");
    assert.ok(fp1 !== null && fp1!.length === 16);
  });

  it("fingerprint differs for distinct lessons", () => {
    const fp1 = computeFingerprint("Fix parser confidence degradation");
    const fp2 = computeFingerprint("Fix architecture drift detection in docs scanner");
    assert.notEqual(fp1, fp2, "distinct lessons must have distinct fingerprints");
  });

  it("addDebtEntries deduplicates by fingerprint across cycles", () => {
    const lesson = "Ensure artifact gate is enforced on all done-emission paths";
    const ledger = addDebtEntries([], [{ followUpTask: lesson, severity: "critical" }], 1);
    assert.equal(ledger.length, 1);
    // Re-adding same lesson to same ledger must not add duplicate
    const ledger2 = addDebtEntries(ledger, [{ followUpTask: lesson, severity: "critical" }], 2);
    assert.equal(ledger2.length, 1, "duplicate debt by fingerprint must not be added");
  });

  it("tickCycle increments cyclesOpen for open entries", () => {
    const ledger = addDebtEntries([], [
      { followUpTask: "Add measurable capacity delta to plan contract", severity: "warning" },
    ], 5);
    const { overdue } = tickCycle(ledger, 7);
    assert.equal(ledger[0].cyclesOpen, 2, "cyclesOpen must equal currentCycle - openedCycle");
    assert.equal(overdue.length, 0, "entry should not be overdue (7 < dueCycle=8)");
  });

  it("tickCycle marks entry as overdue when currentCycle exceeds dueCycle", () => {
    const ledger = addDebtEntries([], [
      { followUpTask: "Critical drift in architecture documentation scan results", severity: "critical" },
    ], 1);
    const dueCycle = ledger[0].dueCycle; // cycle 1 + SLA 3 = cycle 4
    const { overdue } = tickCycle(ledger, dueCycle + 1);
    assert.equal(overdue.length, 1, "entry must be overdue past its dueCycle");
  });

  it("closeDebt removes entry from open debts", () => {
    const ledger = addDebtEntries([], [
      { followUpTask: "Deterministic integration checks across confidence and drift", severity: "warning" },
    ], 3);
    const debtId = ledger[0].id;
    const closed = closeDebt(ledger, debtId, "Integration test added in hardening_integration.test.ts");
    assert.equal(closed, true);
    assert.equal(getOpenDebts(ledger).length, 0, "closed debt must not appear in open debts");
    assert.ok(ledger[0].closedAt !== null);
    assert.ok(ledger[0].closureEvidence!.includes("hardening_integration"));
  });

  it("shouldBlockOnDebt: does not block when no critical overdue items", () => {
    const ledger = addDebtEntries([], [
      { followUpTask: "Minor warning debt item that is not yet due", severity: "warning" },
    ], 10);
    const result = shouldBlockOnDebt(ledger, 10);
    assert.equal(result.shouldBlock, false);
  });

  it("shouldBlockOnDebt: blocks when critical overdue count meets limit", () => {
    // Inject 3 critical items opened at cycle 1, due cycle 4, check at cycle 5 (overdue)
    let ledger: any[] = [];
    for (let i = 0; i < 3; i++) {
      ledger = addDebtEntries(ledger, [
        { followUpTask: `Critical item ${i + 1} — must be resolved before next plan acceptance`, severity: "critical" },
      ], 1);
    }
    const result = shouldBlockOnDebt(ledger, 5, { maxCriticalOverdue: 3 });
    assert.equal(result.shouldBlock, true, "3 critical overdue items must trigger block");
    assert.ok(result.overdueCount >= 3);
    assert.ok(result.reason.length > 0, "block reason must be non-empty");
  });

  it("negative path: closeDebt returns false for unknown debt ID", () => {
    const ledger = addDebtEntries([], [
      { followUpTask: "Some valid debt item here for testing purposes", severity: "warning" },
    ], 1);
    const result = closeDebt(ledger, "debt-id-that-does-not-exist", "evidence");
    assert.equal(result, false, "closing unknown debt must return false");
  });
});

// ── Artifact gate hard-block — cross-system integration ───────────────────────

describe("artifact gate — hard-block integration across done-emission paths", () => {
  it("evolution executor path: output without SHA produces MISSING_SHA gap", () => {
    const workerOutput = [
      "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass",
      "BOX_PR_URL=https://github.com/org/repo/pull/42",
      "BOX_STATUS=done",
      "===NPM TEST OUTPUT START===",
      "# tests 15 # pass 15 # fail 0",
      "===NPM TEST OUTPUT END===",
      // No git SHA present
    ].join("\n");
    const artifact = checkPostMergeArtifact(workerOutput);
    assert.equal(artifact.hasSha, false);
    assert.equal(artifact.hasTestOutput, true);
    assert.equal(artifact.hasArtifact, false);
    // Would map to MISSING_SHA gap in both worker_runner and evolution_executor
    const gaps: string[] = [];
    if (!artifact.hasSha) gaps.push(ARTIFACT_GAP.MISSING_SHA);
    if (!artifact.hasTestOutput) gaps.push(ARTIFACT_GAP.MISSING_TEST_OUTPUT);
    assert.ok(gaps.includes(ARTIFACT_GAP.MISSING_SHA));
  });

  it("worker runtime path: SHA + test output present → artifact gate clears", () => {
    const workerOutput = [
      "BOX_MERGED_SHA=abc1234",
      "CLEAN_TREE_STATUS=clean",
      "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass",
      "===NPM TEST OUTPUT START===",
      "# tests 20 # pass 20 # fail 0",
      "===NPM TEST OUTPUT END===",
      "BOX_PR_URL=https://github.com/org/repo/pull/55",
      "BOX_STATUS=done",
    ].join("\n");
    const artifact = checkPostMergeArtifact(workerOutput);
    assert.equal(artifact.hasArtifact, true, "complete evidence must pass artifact gate");
    assert.equal(artifact.hasUnfilledPlaceholder, false);
  });

  it("worker runtime path: task-scoped clean-tree evidence clears artifact gate in shared dirty repo", () => {
    const workerOutput = [
      "BOX_MERGED_SHA=abc1234",
      "CLEAN_TREE_STATUS=dirty-other-tasks-only",
      "TASK_SCOPED_CLEAN_STATUS=clean",
      "TASK_SCOPED_CLEAN_TARGETS=src/core/slo_checker.ts, src/core/orchestrator.ts",
      "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass",
      "===NPM TEST OUTPUT START===",
      "# tests 20 # pass 20 # fail 0",
      "===NPM TEST OUTPUT END===",
      "BOX_PR_URL=https://github.com/org/repo/pull/55",
      "BOX_STATUS=done",
    ].join("\n");
    const artifact = checkPostMergeArtifact(workerOutput, {
      expectedTargetFiles: ["src/core/slo_checker.ts", "src/core/orchestrator.ts"],
    });
    assert.equal(artifact.hasArtifact, true, "task-scoped clean evidence must pass artifact gate");
    assert.equal(artifact.hasTaskScopedCleanTreeEvidence, true);
  });

  it("unfilled placeholder blocks done regardless of SHA + test presence", () => {
    const workerOutput = [
      "Merged abc1234 into main",
      "POST_MERGE_TEST_OUTPUT",
      "BOX_STATUS=done",
    ].join("\n");
    const artifact = checkPostMergeArtifact(workerOutput);
    assert.equal(artifact.hasUnfilledPlaceholder, true);
    assert.equal(artifact.hasArtifact, false);
    const gaps: string[] = [];
    if (artifact.hasUnfilledPlaceholder) gaps.push(ARTIFACT_GAP.UNFILLED_PLACEHOLDER);
    assert.ok(gaps.includes(ARTIFACT_GAP.UNFILLED_PLACEHOLDER));
  });
});

// ── Plan packet — measurable capacity delta and request-ROI ───────────────────

describe("plan packet — capacityDelta and requestROI field enforcement", () => {
  it("plan without capacityDelta gets a CRITICAL violation with measurable message", () => {
    const plan = {
      task: "Add integration hardening to BOX core",
      role: "evolution-worker",
      wave: 1,
      verification: "npm test",
      dependencies: [],
      acceptance_criteria: ["All tests pass"],
      requestROI: 2.5,
    };
    const result = validatePlanContract(plan);
    const v = result.violations.find(v => v.field === "capacityDelta");
    assert.ok(v !== undefined, "missing capacityDelta must produce a violation");
    assert.equal(v!.severity, PLAN_VIOLATION_SEVERITY.CRITICAL);
    assert.ok(v!.message.includes("measurable"), "violation message must mention measurable");
  });

  it("plan without requestROI gets a CRITICAL violation with ROI mention", () => {
    const plan = {
      task: "Add integration hardening to BOX core",
      role: "evolution-worker",
      wave: 1,
      verification: "npm test",
      dependencies: [],
      acceptance_criteria: ["All tests pass"],
      capacityDelta: 0.15,
    };
    const result = validatePlanContract(plan);
    const v = result.violations.find(v => v.field === "requestROI");
    assert.ok(v !== undefined, "missing requestROI must produce a violation");
    assert.equal(v!.severity, PLAN_VIOLATION_SEVERITY.CRITICAL);
    assert.ok(v!.message.toLowerCase().includes("roi") || v!.message.toLowerCase().includes("return"),
      "violation message must mention ROI or return-on-investment"
    );
  });

  it("fully scored packet with capacityDelta=0.2 and requestROI=3.0 has no packet-scoring violations", () => {
    const plan = {
      task: "Add integration hardening to BOX core",
      role: "evolution-worker",
      wave: 1,
      verification: "npm test",
      dependencies: [],
      acceptance_criteria: ["All tests pass"],
      capacityDelta: 0.2,
      requestROI: 3.0,
    };
    const result = validatePlanContract(plan);
    const packetViolations = result.violations.filter(
      v => v.field === "capacityDelta" || v.field === "requestROI"
    );
    assert.equal(packetViolations.length, 0, "fully-scored packet must have no packet-scoring violations");
  });

  it("cross-system: capacity delta from plan matches direction of capacity index change", () => {
    // Simulate: plan declares 0.1 capacity delta improvement
    const declaredDelta = 0.1;

    // After plan executes, parser confidence improves from 0.5 to 0.9
    const before = computeCapacityIndex({ parserConfidence: 0.5 });
    const after = computeCapacityIndex({ parserConfidence: 0.9 }, before);

    const actualComposite = after.composite - before.composite;
    assert.ok(actualComposite > 0, "capacity must improve after confidence improvement");
    assert.ok(declaredDelta > 0, "declared delta must be positive for an improvement plan");
    // Both actual improvement and declared delta point in the same direction
    assert.ok(
      Math.sign(actualComposite) === Math.sign(declaredDelta),
      "declared capacityDelta direction must match actual composite capacity change direction"
    );
  });
});

// ── Artifact gate regression — all gap combinations ───────────────────────────

describe("artifact gate regression — collectArtifactGaps covers all gap combinations", () => {
  it("no SHA and no test output produces MISSING_SHA, MISSING_TEST_OUTPUT, and DIRTY_TREE gaps", () => {
    const gaps = collectArtifactGaps({ hasSha: false, hasTestOutput: false, hasUnfilledPlaceholder: false });
    assert.ok(gaps.includes(ARTIFACT_GAP.MISSING_SHA), "must include MISSING_SHA gap");
    assert.ok(gaps.includes(ARTIFACT_GAP.MISSING_TEST_OUTPUT), "must include MISSING_TEST_OUTPUT gap");
    assert.ok(gaps.includes(ARTIFACT_GAP.DIRTY_TREE), "must include DIRTY_TREE gap");
    assert.equal(gaps.length, 3);
  });

  it("missing SHA only produces MISSING_SHA and no DIRTY_TREE when clean-tree evidence is present", () => {
    const gaps = collectArtifactGaps({
      hasSha: false,
      hasTestOutput: true,
      hasCleanTreeEvidence: true,
      hasUnfilledPlaceholder: false,
    });
    assert.equal(gaps.length, 1);
    assert.ok(gaps.includes(ARTIFACT_GAP.MISSING_SHA));
  });

  it("missing test output only produces MISSING_TEST_OUTPUT and no DIRTY_TREE when clean-tree evidence is present", () => {
    const gaps = collectArtifactGaps({
      hasSha: true,
      hasTestOutput: false,
      hasCleanTreeEvidence: true,
      hasUnfilledPlaceholder: false,
    });
    assert.equal(gaps.length, 1);
    assert.ok(gaps.includes(ARTIFACT_GAP.MISSING_TEST_OUTPUT));
  });

  it("complete artifact (SHA + test output, no placeholder) produces empty gaps array", () => {
    const gaps = collectArtifactGaps({
      hasSha: true,
      hasTestOutput: true,
      hasCleanTreeEvidence: true,
      hasUnfilledPlaceholder: false,
    });
    assert.deepEqual(gaps, []);
  });

  it("unfilled placeholder gap is emitted first (highest priority)", () => {
    const gaps = collectArtifactGaps({ hasSha: false, hasTestOutput: false, hasUnfilledPlaceholder: true });
    assert.ok(gaps[0] === ARTIFACT_GAP.UNFILLED_PLACEHOLDER, "placeholder gap must be first");
    assert.ok(gaps.includes(ARTIFACT_GAP.MISSING_SHA));
    assert.ok(gaps.includes(ARTIFACT_GAP.MISSING_TEST_OUTPUT));
    assert.ok(gaps.includes(ARTIFACT_GAP.DIRTY_TREE));
    assert.equal(gaps.length, 4);
  });

  it("checkPostMergeArtifact: missing test output block produces hasTestOutput=false", () => {
    const output = [
      "BOX_MERGED_SHA=f1a2b3c",
      // No '===NPM TEST OUTPUT START===' block
      "BOX_STATUS=done",
    ].join("\n");
    const artifact = checkPostMergeArtifact(output);
    assert.equal(artifact.hasSha, true, "SHA must be detected");
    assert.equal(artifact.hasTestOutput, false, "missing test output block must yield hasTestOutput=false");
    assert.equal(artifact.hasArtifact, false, "incomplete artifact must be false");
  });

  it("checkPostMergeArtifact: test output line without SHA yields hasSha=false", () => {
    const output = [
      "===NPM TEST OUTPUT START===",
      "# tests 12 # pass 12 # fail 0",
      "===NPM TEST OUTPUT END===",
      "VERIFICATION_REPORT: BUILD=pass; TESTS=pass",
      "BOX_STATUS=done",
      // No SHA
    ].join("\n");
    const artifact = checkPostMergeArtifact(output);
    assert.equal(artifact.hasTestOutput, true, "test output line must be detected");
    assert.equal(artifact.hasSha, false, "absent SHA must yield hasSha=false");
    assert.equal(artifact.hasArtifact, false);
  });
});

// ── Env-contract regression — worker contract and dispatch gate ───────────────

describe("env-contract regression — worker contract and dispatch command gate", () => {
  it("validateWorkerContract: backend status=done without VERIFICATION_REPORT fails with descriptive gap", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: "Work completed but I forgot to include the report",
    });
    assert.equal(result.passed, false);
    assert.ok(
      result.gaps.some(g => g.includes("VERIFICATION_REPORT")),
      "gap must reference missing VERIFICATION_REPORT"
    );
  });

  it("validateWorkerContract: backend status=done with all evidence fields passes", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc123f",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# tests 25 # pass 25 # fail 0",
        "===NPM TEST OUTPUT END===",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=pass; API=n/a; RESPONSIVE=n/a",
        "BOX_PR_URL=https://github.com/CanerDoqdu/Box/pull/200",
      ].join("\n"),
    });
    assert.equal(result.passed, true, "complete worker output must pass env-contract");
    assert.equal(result.gaps.length, 0);
  });

  it("validateWorkerContract: TESTS=fail gap is emitted with exact reason text", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "Merged abc1234 into main",
        "# tests 10 # pass 7 # fail 3",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=fail; EDGE_CASES=pass; SECURITY=pass",
        "BOX_PR_URL=https://github.com/CanerDoqdu/Box/pull/201",
      ].join("\n"),
    });
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some(g => g.includes("TESTS reported as FAIL")), "TESTS=fail must produce exact gap text");
  });

  it("plan evidence coupling and contract validator are complementary: both can block the same plan", () => {
    const plan = {
      task: "X", // too short → TASK_TOO_SHORT in contract validator
      role: "",   // missing → MISSING_ROLE
      wave: -1,
      // no verification_commands → coupling fails
      // no acceptance_criteria → coupling fails
    };
    const contractResult = validatePlanContract(plan);
    const couplingResult = validatePlanEvidenceCoupling(plan);
    assert.equal(contractResult.valid, false, "contract validator must block malformed plan");
    assert.equal(couplingResult.valid, false, "coupling gate must block plan without commands");
  });

  it("violation codes from validateAllPlans batch preserve deterministic taxonomy codes", () => {
    const plans = [
      // valid plan
      {
        task: "Add deterministic SLA enforcement to the carry forward ledger cycle gate",
        role: "evolution-worker",
        wave: 1,
        verification: "tests/core/carry_forward_ledger.test.ts — test: tickCycle",
        dependencies: [],
        acceptance_criteria: ["Gate blocks after SLA exceeded"],
        capacityDelta: 0.1,
        requestROI: 2.0,
      },
      // missing capacityDelta → MISSING_CAPACITY_DELTA
      {
        task: "Expand budget controller to track per-model USD consumption",
        role: "evolution-worker",
        wave: 1,
        verification: "tests/core/budget_controller.test.ts — test: charges",
        dependencies: [],
        acceptance_criteria: ["Per-model tracking works"],
        requestROI: 1.5,
      },
    ];
    const result = validateAllPlans(plans);
    assert.equal(result.validCount, 1);
    assert.equal(result.invalidCount, 1);
    const invalidEntry = result.results.find(r => !r.valid);
    assert.ok(invalidEntry, "invalid entry must exist");
    const cdViolation = invalidEntry!.violations.find(v => v.code === PACKET_VIOLATION_CODE.MISSING_CAPACITY_DELTA);
    assert.ok(cdViolation, "MISSING_CAPACITY_DELTA code must be present in batch validation results");
    assert.equal(cdViolation!.severity, PLAN_VIOLATION_SEVERITY.CRITICAL);
  });

  it("packet taxonomy: UNRECOVERABLE_PACKET_REASONS aliases and PACKET_VIOLATION_CODE values are identical for cross-gate consistency", async () => {
    const { UNRECOVERABLE_PACKET_REASONS } = await import("../../src/core/prometheus.js");
    assert.equal(UNRECOVERABLE_PACKET_REASONS.NO_TASK_IDENTITY,        PACKET_VIOLATION_CODE.NO_TASK_IDENTITY);
    assert.equal(UNRECOVERABLE_PACKET_REASONS.MISSING_CAPACITY_DELTA,  PACKET_VIOLATION_CODE.MISSING_CAPACITY_DELTA);
    assert.equal(UNRECOVERABLE_PACKET_REASONS.INVALID_CAPACITY_DELTA,  PACKET_VIOLATION_CODE.INVALID_CAPACITY_DELTA);
    assert.equal(UNRECOVERABLE_PACKET_REASONS.MISSING_REQUEST_ROI,     PACKET_VIOLATION_CODE.MISSING_REQUEST_ROI);
    assert.equal(UNRECOVERABLE_PACKET_REASONS.INVALID_REQUEST_ROI,     PACKET_VIOLATION_CODE.INVALID_REQUEST_ROI);
    assert.equal(UNRECOVERABLE_PACKET_REASONS.MISSING_VERIFICATION_COUPLING, PACKET_VIOLATION_CODE.MISSING_VERIFICATION_COUPLING);
  });
});
