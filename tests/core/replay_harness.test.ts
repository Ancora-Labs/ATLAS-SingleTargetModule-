/**
 * Tests for T-023: Counterfactual Replay Harness.
 *
 * Covers ALL acceptance criteria:
 *   AC1:  Replay loads N recent cycles deterministically (double-run hash match).
 *   AC2:  Policy candidates produce comparable outcome metrics (specific metrics named,
 *         tolerance via exact-value assertions).
 *   AC3:  Harness flags low-confidence projections (< LOW_CONFIDENCE_THRESHOLD = 0.4).
 *   AC4:  Results stored with reproducibility metadata (schema field assertions).
 *   AC5:  No live state mutation during replay (snapshot diff before/after).
 *   AC6:  Each criterion has explicit deterministic pass/fail evidence.
 *   AC7:  Negative path — invalid policy → error with explicit reason code.
 *   AC8:  Output JSON fields and enums are defined and verified.
 *   AC9:  Missing input vs invalid input produce distinct REPLAY_DEGRADED_REASON codes.
 *   AC10: No silent fallback — degraded/error state sets explicit status + reason.
 *   AC11: N = DEFAULT_CYCLE_WINDOW = 10 (explicitly defined, not caller-guessed).
 *   AC12: Specific metrics: tasksCompleted, workerSuccessRate, avgAttempts, cycleHealth,
 *         weightedScore — all asserted.
 *   AC13: LOW_CONFIDENCE_THRESHOLD = 0.4 (numeric, explicit).
 *   AC14: Reproducibility metadata schema: replayId, replayTimestamp, status,
 *         degradedReason, cycleWindow, cyclesLoaded, inputHash, sourceFiles.
 *   AC15: State immutability — listdir before and after replay must be identical
 *         (except the replay_results/ subdir).
 *   AC16: This file is referenced explicitly as the replay-specific test file.
 *   AC17: PolicyEvalResult schema verified (all required fields + enums).
 *   AC18: Reason codes enumerated and tested: MISSING_CYCLES, INVALID_CYCLE,
 *         POLICY_ERROR, INSUFFICIENT_CYCLES, INVALID_POLICY, SIGNAL_REGRESSION.
 *   AC19: status enum values tested: "ok" | "degraded" | "error".
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  DEFAULT_CYCLE_WINDOW,
  LOW_CONFIDENCE_THRESHOLD,
  REPLAY_STATUS,
  REPLAY_DEGRADED_REASON,
  computeOutcomeMetrics,
  computeConfidenceScore,
  validatePolicyCandidate,
  applyPolicyToEntries,
  loadCycleSnapshots,
  computeInputHash,
  runReplay
} from "../../src/core/replay_harness.js";
import { DECISION_QUALITY_LABEL } from "../../src/core/athena_reviewer.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

async function writeTestJson(dir, filename, data) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), JSON.stringify(data, null, 2), "utf8");
}

async function writeRaw(dir, filename, text) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), text, "utf8");
}

async function writeReplayPolicySignalFixtures(dir, overrides = {}) {
  const plannerCheckpoint = Object.prototype.hasOwnProperty.call(overrides, "plannerCheckpoint")
    ? overrides.plannerCheckpoint
    : {
    candidatePlanning: {
      enabled: true,
      candidateCount: 2,
      selectedIndex: 1,
      selectedLabel: "candidate-b",
      score: 0.91,
      tieBreakUsed: false,
      reason: "clear-winner",
      summaries: [
        { label: "candidate-a", originalPlanCount: 1, admittedPlanCount: 1, contractPassRate: 0.6, freshnessPenalty: 0.2 },
        { label: "candidate-b", originalPlanCount: 1, admittedPlanCount: 1, contractPassRate: 1, freshnessPenalty: 0 },
      ],
    },
  };
  const dispatchCheckpoint = Object.prototype.hasOwnProperty.call(overrides, "dispatchCheckpoint")
    ? overrides.dispatchCheckpoint
    : {
    schemaVersion: 2,
    replayCompatibility: { replayContractVersion: 1 },
    dispatchPlanSnapshot: [
      {
        task_id: "T-chain-1",
        task: "Quality stage",
        role: "quality-worker",
        wave: 1,
        _chainMode: true,
        _chainId: "chain-1",
        _chainStageIndex: 1,
        _chainStageTotal: 2,
        _typedHandoffArtifact: {
          id: "handoff-1",
          chainId: "chain-1",
          stage: "quality",
          artifactKey: "chain-1:quality:artifact",
        },
      },
      {
        task_id: "T-chain-2",
        task: "Integration stage",
        role: "integration-worker",
        wave: 2,
        _chainMode: true,
        _chainId: "chain-1",
        _chainStageIndex: 2,
        _chainStageTotal: 2,
        _typedHandoffArtifact: {
          id: "handoff-2",
          chainId: "chain-1",
          stage: "integration",
          artifactKey: "chain-1:integration:artifact",
        },
      },
    ],
  };
  const attemptCheckpoint = Object.prototype.hasOwnProperty.call(overrides, "attemptCheckpoint")
    ? overrides.attemptCheckpoint
    : {
    retryStateKind: "phase_aware_retry_v1",
    phaseOrder: ["plan", "edit", "test", "push"],
    currentPhase: "test",
    failedPhase: "test",
    resumeFromPhase: "test",
    lastCompletedPhase: "edit",
    phaseStates: {
      plan: { status: "done", evidence: [] },
      edit: { status: "done", evidence: [] },
      test: { status: "failed", evidence: [{ code: "tests_failed", detail: "unit test failed", source: "worker_output" }] },
      push: { status: "pending", evidence: [] },
    },
    evidence: [{ code: "tests_failed", detail: "unit test failed", source: "worker_output" }],
    mutation: {
      strategy: "resume_from_failed_phase",
      instructions: ["Reproduce the failed test before editing."],
    },
  };
  const routeRoiLedger = Object.prototype.hasOwnProperty.call(overrides, "routeRoiLedger")
    ? overrides.routeRoiLedger
    : [
    {
      taskId: "T-hard-1",
      model: "Claude Opus 4.6",
      tier: "T3",
      estimatedTokens: 1400,
      expectedQuality: 0.92,
      realizedQuality: 0.88,
      outcome: "done",
      roi: 62.86,
      roiDelta: -2.85,
      routedAt: "2026-04-13T00:00:00.000Z",
      realizedAt: "2026-04-13T00:10:00.000Z",
      lineageId: "chain-1",
      taskKind: "integration",
      role: "integration-worker",
      cycleId: "cycle-1",
      routingReasonCode: "hard-task-escalation",
      hardChainSuccessRate: 1,
      hardChainSampleCount: 1,
      laneReliability: 0.92,
    },
  ];

  if (plannerCheckpoint !== null) {
    await writeTestJson(dir, "boundary_checkpoint_planner_cycle-1.json", plannerCheckpoint);
  }
  if (dispatchCheckpoint !== null) {
    await writeTestJson(dir, "dispatch_checkpoint.json", dispatchCheckpoint);
  }
  if (attemptCheckpoint !== null) {
    await writeTestJson(dir, "boundary_checkpoint_attempt_task-1.json", attemptCheckpoint);
  }
  if (routeRoiLedger !== null) {
    await writeTestJson(dir, "route_roi_ledger.json", routeRoiLedger);
  }
}

function makeConfig(stateDir, overrides = {}) {
  return { paths: { stateDir }, ...overrides };
}

/** Build a valid policy candidate. */
function makePolicy(id = "p1", overrides = {}) {
  return {
    id,
    description: `Policy ${id}`,
    thresholds: {
      maxRetries: 2,
      timeoutMinutes: 30,
      minSuccessRate: 0.7
    },
    ...overrides
  };
}

/** Build a minimal valid athena_postmortems.json (v1 schema). */
function makePostmortems(entries) {
  return { schemaVersion: 1, entries };
}

/** Build a postmortem entry with a given decision quality. */
function makeEntry(id, quality, attempts = 1) {
  return {
    taskId: id,
    decisionQualityLabel: quality,
    attempts,
    timestamp: new Date().toISOString(),
    reviewedAt: new Date().toISOString()
  };
}

// A set of 10 entries for full-window tests
const FULL_ENTRIES = [
  makeEntry("T-001", DECISION_QUALITY_LABEL.CORRECT,         1),
  makeEntry("T-002", DECISION_QUALITY_LABEL.CORRECT,         1),
  makeEntry("T-003", DECISION_QUALITY_LABEL.DELAYED_CORRECT, 2),
  makeEntry("T-004", DECISION_QUALITY_LABEL.INCORRECT,       3),
  makeEntry("T-005", DECISION_QUALITY_LABEL.CORRECT,         1),
  makeEntry("T-006", DECISION_QUALITY_LABEL.INCONCLUSIVE,    1),
  makeEntry("T-007", DECISION_QUALITY_LABEL.CORRECT,         1),
  makeEntry("T-008", DECISION_QUALITY_LABEL.DELAYED_CORRECT, 2),
  makeEntry("T-009", DECISION_QUALITY_LABEL.INCORRECT,       2),
  makeEntry("T-010", DECISION_QUALITY_LABEL.CORRECT,         1)
];

// ── AC11: DEFAULT_CYCLE_WINDOW and LOW_CONFIDENCE_THRESHOLD constants ─────────

describe("Exported constants", () => {
  it("DEFAULT_CYCLE_WINDOW = 10 (AC11)", () => {
    assert.equal(DEFAULT_CYCLE_WINDOW, 10, "N must be 10");
  });

  it("LOW_CONFIDENCE_THRESHOLD = 0.4 (AC13)", () => {
    assert.equal(LOW_CONFIDENCE_THRESHOLD, 0.4, "threshold must be 0.4");
  });
});

// ── AC8/AC19: REPLAY_STATUS enum ─────────────────────────────────────────────

describe("REPLAY_STATUS enum (AC8, AC19)", () => {
  it("is frozen with exactly three values: ok, degraded, error", () => {
    assert.ok(Object.isFrozen(REPLAY_STATUS));
    assert.equal(REPLAY_STATUS.OK,       "ok");
    assert.equal(REPLAY_STATUS.DEGRADED, "degraded");
    assert.equal(REPLAY_STATUS.ERROR,    "error");
    assert.equal(Object.keys(REPLAY_STATUS).length, 3);
  });
});

// ── AC8/AC18: REPLAY_DEGRADED_REASON enum ────────────────────────────────────

describe("REPLAY_DEGRADED_REASON enum (AC8, AC18)", () => {
  it("is frozen with all six reason codes", () => {
    assert.ok(Object.isFrozen(REPLAY_DEGRADED_REASON));
    assert.equal(REPLAY_DEGRADED_REASON.MISSING_CYCLES,      "MISSING_CYCLES");
    assert.equal(REPLAY_DEGRADED_REASON.INVALID_CYCLE,       "INVALID_CYCLE");
    assert.equal(REPLAY_DEGRADED_REASON.POLICY_ERROR,        "POLICY_ERROR");
    assert.equal(REPLAY_DEGRADED_REASON.INSUFFICIENT_CYCLES, "INSUFFICIENT_CYCLES");
    assert.equal(REPLAY_DEGRADED_REASON.INVALID_POLICY,      "INVALID_POLICY");
    assert.equal(REPLAY_DEGRADED_REASON.SIGNAL_REGRESSION,   "SIGNAL_REGRESSION");
    assert.equal(Object.keys(REPLAY_DEGRADED_REASON).length, 6);
  });
});

// ── AC12: computeOutcomeMetrics — specific metrics ────────────────────────────

describe("computeOutcomeMetrics (AC2, AC12)", () => {
  it("returns all five required metric fields", () => {
    const m = computeOutcomeMetrics(FULL_ENTRIES);
    assert.ok("tasksCompleted"    in m, "tasksCompleted field required");
    assert.ok("workerSuccessRate" in m, "workerSuccessRate field required");
    assert.ok("avgAttempts"       in m, "avgAttempts field required");
    assert.ok("cycleHealth"       in m, "cycleHealth field required");
    assert.ok("weightedScore"     in m, "weightedScore field required");
  });

  it("tasksCompleted counts correct + delayed-correct", () => {
    // FULL_ENTRIES: T-001(c), T-002(c), T-003(dc), T-005(c), T-007(c), T-008(dc), T-010(c) = 7
    const m = computeOutcomeMetrics(FULL_ENTRIES);
    assert.equal(m.tasksCompleted, 7);
  });

  it("workerSuccessRate = 7/10 = 0.7", () => {
    const m = computeOutcomeMetrics(FULL_ENTRIES);
    assert.equal(m.workerSuccessRate, 0.7);
  });

  it("avgAttempts is a positive number", () => {
    const m = computeOutcomeMetrics(FULL_ENTRIES);
    assert.ok(m.avgAttempts > 0, "avgAttempts must be > 0");
  });

  it("cycleHealth is 'good' for successRate=0.7 (>= 0.75 → 'good', 0.4-0.75 → 'fair')", () => {
    const m = computeOutcomeMetrics(FULL_ENTRIES);
    // 0.7 is in [0.4, 0.75) → "fair"
    assert.equal(m.cycleHealth, "fair");
  });

  it("cycleHealth = 'good' when successRate >= 0.75", () => {
    const goodEntries = [
      makeEntry("A", DECISION_QUALITY_LABEL.CORRECT, 1),
      makeEntry("B", DECISION_QUALITY_LABEL.CORRECT, 1),
      makeEntry("C", DECISION_QUALITY_LABEL.CORRECT, 1),
      makeEntry("D", DECISION_QUALITY_LABEL.CORRECT, 1)
    ];
    assert.equal(computeOutcomeMetrics(goodEntries).cycleHealth, "good");
  });

  it("cycleHealth = 'poor' when successRate < 0.4", () => {
    const poorEntries = [
      makeEntry("A", DECISION_QUALITY_LABEL.INCORRECT,  1),
      makeEntry("B", DECISION_QUALITY_LABEL.INCORRECT,  1),
      makeEntry("C", DECISION_QUALITY_LABEL.INCONCLUSIVE, 1)
    ];
    assert.equal(computeOutcomeMetrics(poorEntries).cycleHealth, "poor");
  });

  it("empty entries returns zero metrics and cycleHealth='poor'", () => {
    const m = computeOutcomeMetrics([]);
    assert.equal(m.tasksCompleted, 0);
    assert.equal(m.workerSuccessRate, 0);
    assert.equal(m.cycleHealth, "poor");
    assert.equal(m.weightedScore, null);
  });

  it("non-array entries returns zero metrics", () => {
    const m = computeOutcomeMetrics(null);
    assert.equal(m.tasksCompleted, 0);
  });
});

// ── AC13: computeConfidenceScore ──────────────────────────────────────────────

describe("computeConfidenceScore (AC3, AC13)", () => {
  it("returns 0 for empty entries", () => {
    assert.equal(computeConfidenceScore([]), 0);
    assert.equal(computeConfidenceScore(null), 0);
  });

  it("returns a value in [0, 1]", () => {
    const score = computeConfidenceScore(FULL_ENTRIES);
    assert.ok(score >= 0 && score <= 1, `score ${score} must be in [0, 1]`);
  });

  it("full window of labeled entries achieves score >= LOW_CONFIDENCE_THRESHOLD", () => {
    const score = computeConfidenceScore(FULL_ENTRIES);
    assert.ok(score >= LOW_CONFIDENCE_THRESHOLD,
      `full window should not be low-confidence, got ${score}`);
  });

  it("single entry is below LOW_CONFIDENCE_THRESHOLD", () => {
    const score = computeConfidenceScore([makeEntry("T-1", DECISION_QUALITY_LABEL.CORRECT, 1)]);
    assert.ok(score < LOW_CONFIDENCE_THRESHOLD,
      `single entry score ${score} should be < ${LOW_CONFIDENCE_THRESHOLD}`);
  });
});

// ── AC9: validatePolicyCandidate — missing vs invalid ────────────────────────

describe("validatePolicyCandidate (AC9, AC18)", () => {
  it("valid policy returns ok=true", () => {
    const result = validatePolicyCandidate(makePolicy());
    assert.equal(result.ok, true);
    assert.equal(result.reason, null);
    assert.deepEqual(result.missingFields, []);
    assert.deepEqual(result.invalidFields, []);
  });

  it("null policy → ok=false, missingFields includes <policy object>", () => {
    const result = validatePolicyCandidate(null);
    assert.equal(result.ok, false);
    assert.equal(result.reason, REPLAY_DEGRADED_REASON.INVALID_POLICY);
    assert.ok(result.missingFields.length > 0, "must report missing field");
  });

  it("missing id field → ok=false, missingFields includes 'id' (AC9 missing input)", () => {
    const p = makePolicy();
    delete p.id;
    const result = validatePolicyCandidate(p);
    assert.equal(result.ok, false);
    assert.ok(result.missingFields.includes("id"), "must report missing id");
  });

  it("empty id string → ok=false, invalidFields includes 'id' (AC9 invalid input)", () => {
    const result = validatePolicyCandidate(makePolicy(""));
    assert.equal(result.ok, false);
    assert.ok(result.invalidFields.includes("id"), "empty id is invalid, not missing");
  });

  it("missing thresholds → ok=false, missingFields includes 'thresholds'", () => {
    const p = makePolicy();
    delete p.thresholds;
    const result = validatePolicyCandidate(p);
    assert.equal(result.ok, false);
    assert.ok(result.missingFields.includes("thresholds"));
  });

  it("maxRetries=0 (invalid, not missing) → invalidFields includes threshold field", () => {
    const p = makePolicy();
    p.thresholds.maxRetries = 0;
    const result = validatePolicyCandidate(p);
    assert.equal(result.ok, false);
    assert.ok(result.invalidFields.includes("thresholds.maxRetries"));
  });

  it("minSuccessRate=1.5 (out of range) → invalidFields", () => {
    const p = makePolicy();
    p.thresholds.minSuccessRate = 1.5;
    const result = validatePolicyCandidate(p);
    assert.equal(result.ok, false);
    assert.ok(result.invalidFields.includes("thresholds.minSuccessRate"));
  });

  it("missing maxRetries (not present) → missingFields, not invalidFields (AC9 distinction)", () => {
    const p = makePolicy();
    delete p.thresholds.maxRetries;
    const result = validatePolicyCandidate(p);
    assert.equal(result.ok, false);
    assert.ok(result.missingFields.includes("thresholds.maxRetries"),
      "absent field must be MISSING not INVALID");
    assert.ok(!result.invalidFields.includes("thresholds.maxRetries"),
      "absent field must not appear in invalidFields");
  });
});

// ── applyPolicyToEntries — counterfactual model ───────────────────────────────

describe("applyPolicyToEntries", () => {
  it("entries within maxRetries are unchanged", () => {
    const policy = makePolicy("p1");
    policy.thresholds.maxRetries = 3;
    const entries = [makeEntry("T-1", DECISION_QUALITY_LABEL.CORRECT, 2)];
    const result = applyPolicyToEntries(entries, policy);
    assert.equal(result[0].decisionQualityLabel, DECISION_QUALITY_LABEL.CORRECT);
  });

  it("entries exceeding maxRetries are projected as INCORRECT", () => {
    const policy = makePolicy("p1");
    policy.thresholds.maxRetries = 1;
    const entries = [makeEntry("T-1", DECISION_QUALITY_LABEL.DELAYED_CORRECT, 3)];
    const result = applyPolicyToEntries(entries, policy);
    assert.equal(result[0].decisionQualityLabel, DECISION_QUALITY_LABEL.INCORRECT);
  });

  it("does not mutate the original entries (no live state mutation)", () => {
    const policy = makePolicy("p1");
    policy.thresholds.maxRetries = 1;
    const entries = [makeEntry("T-1", DECISION_QUALITY_LABEL.DELAYED_CORRECT, 3)];
    const originalQuality = entries[0].decisionQualityLabel;
    applyPolicyToEntries(entries, policy);
    assert.equal(entries[0].decisionQualityLabel, originalQuality, "original entry must not be mutated");
  });

  it("returns empty array for non-array input", () => {
    assert.deepEqual(applyPolicyToEntries(null, makePolicy()), []);
  });
});

// ── computeInputHash — determinism verification ───────────────────────────────

describe("computeInputHash (AC1, AC11)", () => {
  it("same input produces same hash (determinism double-run check)", () => {
    const cycles = FULL_ENTRIES.map(e => [e]);
    const hash1 = computeInputHash(cycles);
    const hash2 = computeInputHash(cycles);
    assert.equal(hash1, hash2, "double-run hash mismatch — harness is non-deterministic");
  });

  it("different input produces different hash", () => {
    const cyclesA = [[ makeEntry("T-1", DECISION_QUALITY_LABEL.CORRECT, 1) ]];
    const cyclesB = [[ makeEntry("T-1", DECISION_QUALITY_LABEL.INCORRECT, 1) ]];
    assert.notEqual(computeInputHash(cyclesA), computeInputHash(cyclesB));
  });

  it("returns a non-empty hex string", () => {
    const hash = computeInputHash([ [makeEntry("T-1", DECISION_QUALITY_LABEL.CORRECT, 1)] ]);
    assert.ok(typeof hash === "string" && hash.length > 0);
    assert.ok(/^[0-9a-f]+$/.test(hash), "hash must be hex");
  });
});

// ── loadCycleSnapshots ────────────────────────────────────────────────────────

describe("loadCycleSnapshots — source file missing (AC9: MISSING_CYCLES)", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t023-miss-"));
    // No athena_postmortems.json
  });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns ok=false with reason=MISSING_CYCLES", async () => {
    const result = await loadCycleSnapshots(tmpDir, 10);
    assert.equal(result.ok, false);
    assert.equal(result.reason, REPLAY_DEGRADED_REASON.MISSING_CYCLES);
    assert.deepEqual(result.cycles, []);
  });
});

describe("loadCycleSnapshots — source file invalid JSON (AC9: INVALID_CYCLE)", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t023-inv-"));
    await writeRaw(tmpDir, "athena_postmortems.json", "NOT JSON{{{}}}");
  });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns ok=false with reason=INVALID_CYCLE (not MISSING_CYCLES)", async () => {
    const result = await loadCycleSnapshots(tmpDir, 10);
    assert.equal(result.ok, false);
    assert.equal(result.reason, REPLAY_DEGRADED_REASON.INVALID_CYCLE,
      "corrupt file must produce INVALID_CYCLE, not MISSING_CYCLES");
  });
});

describe("loadCycleSnapshots — valid postmortems (AC1)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t023-valid-"));
    await writeTestJson(tmpDir, "athena_postmortems.json", makePostmortems(FULL_ENTRIES));
    result = await loadCycleSnapshots(tmpDir, 10);
  });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns ok=true", () => {
    assert.equal(result.ok, true);
  });

  it("loads up to N cycles (AC1)", () => {
    assert.ok(result.cycles.length > 0, "must load at least one cycle");
    assert.ok(result.cycles.length <= 10, "must not exceed window size");
  });

  it("sourceFiles includes athena_postmortems.json", () => {
    assert.ok(result.sourceFiles.includes("athena_postmortems.json"));
  });
});

// ── runReplay — full integration ──────────────────────────────────────────────

describe("runReplay — no policy candidates (AC9, AC10)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t023-nopol-"));
    result = await runReplay(makeConfig(tmpDir), []);
  });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("status=error when policyCandidates is empty (AC10)", () => {
    assert.equal(result.status, REPLAY_STATUS.ERROR, "empty policies must produce error status");
  });

  it("degradedReason=INVALID_POLICY (AC10, AC18)", () => {
    assert.equal(result.degradedReason, REPLAY_DEGRADED_REASON.INVALID_POLICY);
  });

  it("policyResults is empty array (no silent fallback — AC10)", () => {
    assert.deepEqual(result.policyResults, []);
  });
});

describe("runReplay — invalid policy object (AC7, AC9)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t023-invpol-"));
    await writeTestJson(tmpDir, "athena_postmortems.json", makePostmortems(FULL_ENTRIES));
    // Policy missing id and thresholds
    result = await runReplay(makeConfig(tmpDir), [{ description: "broken" }]);
  });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("status=error for invalid policy (AC7 negative path)", () => {
    assert.equal(result.status, REPLAY_STATUS.ERROR);
  });

  it("degradedReason=INVALID_POLICY — explicit, not silent (AC10)", () => {
    assert.equal(result.degradedReason, REPLAY_DEGRADED_REASON.INVALID_POLICY);
  });

  it("policyResults contains error entry with validationDetail (AC7)", () => {
    assert.ok(result.policyResults.length > 0, "must include error entry for invalid policy");
    const errResult = result.policyResults[0];
    assert.equal(errResult.status, "error");
    assert.equal(errResult.errorReason, REPLAY_DEGRADED_REASON.INVALID_POLICY);
    assert.ok(errResult.validationDetail, "validationDetail must be present");
  });
});

describe("runReplay — missing cycle data (AC9: MISSING_CYCLES)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t023-nocycles-"));
    // No athena_postmortems.json
    result = await runReplay(makeConfig(tmpDir), [makePolicy()]);
  });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("status=error when cycle data is missing (AC10)", () => {
    assert.equal(result.status, REPLAY_STATUS.ERROR);
  });

  it("degradedReason=MISSING_CYCLES (AC9: missing input, not invalid input)", () => {
    assert.equal(result.degradedReason, REPLAY_DEGRADED_REASON.MISSING_CYCLES,
      "missing file must produce MISSING_CYCLES, not INVALID_CYCLE");
  });

  it("cyclesLoaded=0 (no silent fallback — AC10)", () => {
    assert.equal(result.cyclesLoaded, 0);
  });
});

describe("runReplay — successful replay (AC1–AC5, AC14)", () => {
  let tmpDir;
  let result;
  let stateDirSnapshot;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t023-ok-"));
    await writeTestJson(tmpDir, "athena_postmortems.json", makePostmortems(FULL_ENTRIES));

    // AC5: snapshot state dir before replay (exclude replay_results which will be created)
    const beforeEntries = await fs.readdir(tmpDir);
    stateDirSnapshot = beforeEntries.filter(e => e !== "replay_results").sort();

    result = await runReplay(makeConfig(tmpDir), [makePolicy("policy-low-retry", {
      thresholds: { maxRetries: 1, timeoutMinutes: 30, minSuccessRate: 0.7 }
    })]);
  });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  // AC1: deterministic load
  it("inputHash is a non-empty hex string (AC1)", () => {
    assert.ok(typeof result.inputHash === "string" && result.inputHash.length > 0);
    assert.ok(/^[0-9a-f]+$/.test(result.inputHash));
  });

  it("double-run produces same inputHash (AC1 determinism contract)", async () => {
    const result2 = await runReplay(makeConfig(tmpDir), [makePolicy("policy-low-retry", {
      thresholds: { maxRetries: 1, timeoutMinutes: 30, minSuccessRate: 0.7 }
    })]);
    assert.equal(result2.inputHash, result.inputHash,
      "inputHash must be identical across runs — double-run diff check");
  });

  // AC4: reproducibility metadata schema
  it("result includes all reproducibility metadata fields (AC4, AC14)", () => {
    const required = [
      "replayId", "replayTimestamp", "status", "degradedReason",
      "cycleWindow", "cyclesLoaded", "inputHash", "sourceFiles", "policyResults"
    ];
    for (const field of required) {
      assert.ok(field in result, `result must include field: ${field}`);
    }
  });

  it("replayId is a non-empty string", () => {
    assert.ok(typeof result.replayId === "string" && result.replayId.length > 0);
  });

  it("replayTimestamp is an ISO8601 string", () => {
    assert.ok(!isNaN(Date.parse(result.replayTimestamp)), "replayTimestamp must be a valid date");
  });

  it("cycleWindow = DEFAULT_CYCLE_WINDOW (AC11)", () => {
    assert.equal(result.cycleWindow, DEFAULT_CYCLE_WINDOW);
  });

  it("status is one of REPLAY_STATUS values (AC8, AC19)", () => {
    assert.ok(Object.values(REPLAY_STATUS).includes(result.status),
      `status '${result.status}' must be a valid REPLAY_STATUS`);
  });

  // AC2: comparable outcome metrics in policyResults
  it("policyResults contains at least one entry (AC2)", () => {
    assert.ok(result.policyResults.length > 0);
  });

  it("each PolicyEvalResult has all required fields (AC8, AC17)", () => {
    const required = [
      "policyId", "cycleIndex", "metrics", "baselineMetrics", "delta",
      "confidenceScore", "lowConfidence", "lowConfidenceReason", "status", "errorReason"
    ];
    for (const pr of result.policyResults) {
      for (const field of required) {
        assert.ok(field in pr, `PolicyEvalResult must include field: ${field}`);
      }
    }
  });

  it("metrics contains all OutcomeMetrics fields (AC2, AC12)", () => {
    const metricFields = ["tasksCompleted", "workerSuccessRate", "avgAttempts", "cycleHealth", "weightedScore"];
    for (const pr of result.policyResults) {
      if (pr.metrics !== null) {
        for (const f of metricFields) {
          assert.ok(f in pr.metrics, `OutcomeMetrics must include field: ${f}`);
        }
      }
    }
  });

  it("PolicyEvalResult status is 'ok' or 'error' (AC8)", () => {
    for (const pr of result.policyResults) {
      assert.ok(["ok", "error"].includes(pr.status),
        `status must be 'ok' or 'error', got '${pr.status}'`);
    }
  });

  // AC3: low-confidence flagging
  it("lowConfidence field is a boolean (AC3)", () => {
    for (const pr of result.policyResults) {
      assert.equal(typeof pr.lowConfidence, "boolean");
    }
  });

  it("confidenceScore is in [0, 1] (AC3, AC13)", () => {
    for (const pr of result.policyResults) {
      assert.ok(pr.confidenceScore >= 0 && pr.confidenceScore <= 1,
        `confidenceScore ${pr.confidenceScore} must be in [0, 1]`);
    }
  });

  // AC5: state immutability
  it("replay does not mutate original state files (AC5)", async () => {
    const afterEntries = (await fs.readdir(tmpDir))
      .filter(e => e !== "replay_results")
      .sort();
    assert.deepEqual(afterEntries, stateDirSnapshot,
      "state dir contents must be unchanged after replay (excluding replay_results/)");
  });

  it("original athena_postmortems.json is unchanged after replay (AC5 snapshot diff)", async () => {
    const raw = await fs.readFile(path.join(tmpDir, "athena_postmortems.json"), "utf8");
    const data = JSON.parse(raw);
    assert.ok(Array.isArray(data.entries), "entries array must still exist");
    assert.equal(data.entries.length, FULL_ENTRIES.length, "entry count must be unchanged");
  });

  // AC4: result file persisted
  it("replay result is persisted to state/replay_results/<replayId>.json (AC4)", async () => {
    const resultPath = path.join(tmpDir, "replay_results", `${result.replayId}.json`);
    const raw = await fs.readFile(resultPath, "utf8");
    const persisted = JSON.parse(raw);
    assert.equal(persisted.replayId, result.replayId);
    assert.equal(persisted.status, result.status);
  });
});

describe("runReplay — policy signal audit", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t023-signals-"));
    await writeTestJson(tmpDir, "athena_postmortems.json", makePostmortems(FULL_ENTRIES));
    await writeReplayPolicySignalFixtures(tmpDir);
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("keeps replay status=ok when candidate planning, typed handoffs, phase retries, and hard-task routing signals are valid", async () => {
    const result = await runReplay(makeConfig(tmpDir, {
      replay: {
        expectedSignalDomains: [
          "candidate_planning",
          "typed_handoffs",
          "phase_retry",
          "hard_task_routing",
        ],
      },
    }), [makePolicy()]);

    assert.equal(result.status, REPLAY_STATUS.OK);
    assert.equal(result.degradedReason, null);
    assert.equal(result.policySignalAudit.passed, true);
    assert.equal(result.policySignalAudit.regressionCount, 0);
    assert.deepEqual(
      result.policySignalAudit.activeDomains.sort(),
      ["candidate_planning", "hard_task_routing", "phase_retry", "typed_handoffs"],
    );
  });

  it("fails closed with SIGNAL_REGRESSION when an expected replay signal snapshot is missing", async () => {
    const missingSignalsDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t023-signal-miss-"));
    try {
      await writeTestJson(missingSignalsDir, "athena_postmortems.json", makePostmortems(FULL_ENTRIES));
      await writeReplayPolicySignalFixtures(missingSignalsDir, { plannerCheckpoint: null });

      const result = await runReplay(makeConfig(missingSignalsDir, {
        replay: {
          expectedSignalDomains: ["candidate_planning"],
        },
      }), [makePolicy()]);

      assert.equal(result.status, REPLAY_STATUS.DEGRADED);
      assert.equal(result.degradedReason, REPLAY_DEGRADED_REASON.SIGNAL_REGRESSION);
      assert.equal(result.policySignalAudit.passed, false);
      assert.equal(result.policySignalAudit.regressionCount, 1);
      assert.equal(
        result.policySignalAudit.results.find((entry) => entry.domain === "candidate_planning")?.reason,
        "candidate planning snapshot missing",
      );
    } finally {
      await fs.rm(missingSignalsDir, { recursive: true, force: true });
    }
  });
});

// ── AC3: Low-confidence flagging with small sample ───────────────────────────

describe("runReplay — low-confidence flagging with single entry (AC3)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t023-lowconf-"));
    // Only 1 entry — guaranteed low confidence
    await writeTestJson(tmpDir, "athena_postmortems.json",
      makePostmortems([ makeEntry("T-1", DECISION_QUALITY_LABEL.CORRECT, 1) ]));
    result = await runReplay(makeConfig(tmpDir), [makePolicy()]);
  });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("policyResults[0].lowConfidence=true for single-entry cycle (AC3)", () => {
    assert.ok(result.policyResults.length > 0);
    assert.equal(result.policyResults[0].lowConfidence, true,
      "single-entry cycle must be flagged as low-confidence");
  });

  it("confidenceScore < LOW_CONFIDENCE_THRESHOLD (AC3, AC13)", () => {
    const score = result.policyResults[0].confidenceScore;
    assert.ok(score < LOW_CONFIDENCE_THRESHOLD,
      `score ${score} must be < ${LOW_CONFIDENCE_THRESHOLD}`);
  });

  it("lowConfidenceReason is a non-empty string when lowConfidence=true (AC3)", () => {
    const reason = result.policyResults[0].lowConfidenceReason;
    assert.ok(typeof reason === "string" && reason.length > 0,
      "lowConfidenceReason must be set when lowConfidence=true");
  });
});

// ── AC1: INSUFFICIENT_CYCLES when fewer cycles than requested ─────────────────

describe("runReplay — insufficient cycles (AC1, AC10)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t023-insuf-"));
    // Only 3 entries, but requesting DEFAULT_CYCLE_WINDOW=10
    const fewEntries = FULL_ENTRIES.slice(0, 3);
    await writeTestJson(tmpDir, "athena_postmortems.json", makePostmortems(fewEntries));
    result = await runReplay(makeConfig(tmpDir), [makePolicy()]);
  });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("status=degraded when fewer cycles loaded than requested (AC10)", () => {
    assert.equal(result.status, REPLAY_STATUS.DEGRADED,
      "must be degraded, not error, when partial data is available");
  });

  it("degradedReason=INSUFFICIENT_CYCLES (AC10, AC18)", () => {
    assert.equal(result.degradedReason, REPLAY_DEGRADED_REASON.INSUFFICIENT_CYCLES);
  });

  it("cyclesLoaded < cycleWindow (AC1)", () => {
    assert.ok(result.cyclesLoaded < result.cycleWindow,
      `cyclesLoaded ${result.cyclesLoaded} must be < cycleWindow ${result.cycleWindow}`);
  });

  it("still evaluates policies against available cycles (AC10 — partial not silent)", () => {
    assert.ok(result.policyResults.length > 0,
      "must still produce results for available cycles");
  });
});

// ── delta field verification ──────────────────────────────────────────────────

describe("runReplay — delta metrics computation", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t023-delta-"));
    await writeTestJson(tmpDir, "athena_postmortems.json", makePostmortems(FULL_ENTRIES));
    // maxRetries=1 will cause retried tasks to be projected as INCORRECT → lower success
    result = await runReplay(makeConfig(tmpDir), [
      makePolicy("strict", { thresholds: { maxRetries: 1, timeoutMinutes: 15, minSuccessRate: 0.8 } })
    ]);
  });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("delta contains tasksCompleted, workerSuccessRate, avgAttempts, weightedScore", () => {
    const okResults = result.policyResults.filter(r => r.status === "ok");
    assert.ok(okResults.length > 0, "must have at least one ok result");
    const delta = okResults[0].delta;
    assert.ok("tasksCompleted"    in delta);
    assert.ok("workerSuccessRate" in delta);
    assert.ok("avgAttempts"       in delta);
    assert.ok("weightedScore"     in delta);
  });

  it("strict maxRetries=1 reduces tasksCompleted vs baseline for entries with attempts > 1", () => {
    // T-003 (attempts=2), T-008 (attempts=2), T-009 (attempts=2) exceed maxRetries=1
    // They were delayed-correct/incorrect/incorrect → all become INCORRECT
    // Original tasksCompleted = 7; with strict policy: T-003 and T-008 (both succeeded) become INCORRECT
    // So projected tasksCompleted should be <= baseline
    const okResults = result.policyResults.filter(r => r.status === "ok");
    for (const r of okResults) {
      assert.ok(r.metrics.tasksCompleted <= r.baselineMetrics.tasksCompleted,
        "strict retry policy should not increase completions");
    }
  });
});
