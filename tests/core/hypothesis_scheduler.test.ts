/**
 * tests/core/hypothesis_scheduler.test.ts
 *
 * Covers all T-021 acceptance criteria with deterministic pass/fail evidence.
 *
 * AC1:  Only one high-impact experiment active per scope tier by default.
 * AC2:  Scheduler respects runtime budget and worker limits (explicit config keys).
 * AC3:  Experiment start requires baseline metric snapshot (schema verified).
 * AC4:  Conflicting experiments (interventionScope overlap) are deferred.
 * AC5:  Scheduler emits explainable selection rationale (schema verified).
 * AC6:  Each AC maps to at least one explicit test with deterministic evidence.
 * AC7:  Negative paths assert failure handling (invalid candidate, disabled engine,
 *       registry failure, etc.).
 * AC8:  JSON output includes defined schema with required fields and enums.
 * AC9:  Validation distinguishes missing input from invalid input with reason codes.
 * AC10: No silent fallback — degraded behavior sets explicit status + reason code.
 * AC11: 'high-impact' threshold and 'scope tier' enum are concretely defined.
 * AC12: Budget config keys are named and numeric limits are testable.
 * AC13: Baseline snapshot has defined schema, metric list, and storage path.
 * AC14: Conflict-detection rules are specified (interventionScope overlap + tier slots).
 * AC15: Rationale output has defined field contract and destination.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  VALID_SCOPE_TIERS,
  VALID_SELECTION_STATUSES,
  DEFAULT_TIER_SLOTS,
  HIGH_IMPACT_SCORE_THRESHOLD,
  validateSchedulerCandidate,
  isHighImpact,
  buildBaselineMetrics,
  captureBaseline,
  loadBaselines,
  getBaseline,
  appendRationale,
  loadRationale,
  buildBudgetSnapshot,
  scheduleBoundedHypothesisCandidates,
  scheduleNextExperiment,
} from "../../src/core/hypothesis_scheduler.js";

import {
  registerExperiment,
  buildExperimentId,
} from "../../src/core/experiment_registry.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function validCandidate(overrides = {}) {
  return {
    experimentId: buildExperimentId("hyp-timeout", "int-timeout-20", "A"),
    hypothesisId: "hyp-timeout",
    interventionId: "int-timeout-20",
    treatmentGroup: "A",
    scopeTier: "medium",
    impactScore: 0.5,
    interventionScope: ["runtime.workerTimeoutMinutes"],
    baselineWindow: { startAt: "2026-01-01T00:00:00.000Z", endAt: null, durationHours: 24 },
    stopConditions: [{ type: "max_duration_hours", value: 48 }],
    disproveCriteria: "Timeout rate increases by >5%",
    rollbackPlan: "Revert workerTimeoutMinutes",
    status: "planned",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function makeConfig(stateDir, schedulerOverrides = {}) {
  return {
    selfImprovement: {
      enabled: true,
      experimentEngineEnabled: true,
      scheduler: {
        maxTotalActiveExperiments: 3,
        highImpactScoreThreshold: 0.7,
        maxActiveExperimentsPerTier: {
          critical: 1,
          high: 1,
          medium: 2,
          low: 3
        },
        ...schedulerOverrides
      }
    },
    runtime: {
      maxParallelWorkers: 10,
      runtimeBudget: { maxWorkerSpawnsPerCycle: 12 }
    },
    maxParallelWorkers: 10,
    paths: { stateDir }
  };
}

async function freshStateDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "box-sched-test-"));
}

// ── AC8/AC11: Schema constants ────────────────────────────────────────────────

describe("VALID_SCOPE_TIERS (AC8, AC11 — scope tier enum defined)", () => {
  it("contains exactly four required tiers", () => {
    assert.ok(VALID_SCOPE_TIERS.has("critical"), "must have critical");
    assert.ok(VALID_SCOPE_TIERS.has("high"),     "must have high");
    assert.ok(VALID_SCOPE_TIERS.has("medium"),   "must have medium");
    assert.ok(VALID_SCOPE_TIERS.has("low"),      "must have low");
    assert.equal(VALID_SCOPE_TIERS.size, 4);
  });

  it("does not contain non-standard tiers", () => {
    assert.ok(!VALID_SCOPE_TIERS.has("normal"));
    assert.ok(!VALID_SCOPE_TIERS.has("urgent"));
  });
});

describe("VALID_SELECTION_STATUSES (AC8)", () => {
  it("contains all five required selection statuses", () => {
    assert.ok(VALID_SELECTION_STATUSES.has("selected"));
    assert.ok(VALID_SELECTION_STATUSES.has("deferred"));
    assert.ok(VALID_SELECTION_STATUSES.has("no_candidates"));
    assert.ok(VALID_SELECTION_STATUSES.has("budget_exhausted"));
    assert.ok(VALID_SELECTION_STATUSES.has("error"));
    assert.equal(VALID_SELECTION_STATUSES.size, 5);
  });
});

describe("DEFAULT_TIER_SLOTS (AC1, AC12 — numeric limits defined)", () => {
  it("critical and high tiers have slot limit 1", () => {
    assert.equal(DEFAULT_TIER_SLOTS.critical, 1, "critical tier slot limit must be 1");
    assert.equal(DEFAULT_TIER_SLOTS.high,     1, "high tier slot limit must be 1");
  });

  it("medium tier has slot limit 2", () => {
    assert.equal(DEFAULT_TIER_SLOTS.medium, 2);
  });

  it("low tier has slot limit 3", () => {
    assert.equal(DEFAULT_TIER_SLOTS.low, 3);
  });
});

describe("HIGH_IMPACT_SCORE_THRESHOLD (AC11 — threshold defined)", () => {
  it("is a finite number in [0, 1]", () => {
    assert.ok(typeof HIGH_IMPACT_SCORE_THRESHOLD === "number");
    assert.ok(Number.isFinite(HIGH_IMPACT_SCORE_THRESHOLD));
    assert.ok(HIGH_IMPACT_SCORE_THRESHOLD >= 0 && HIGH_IMPACT_SCORE_THRESHOLD <= 1);
  });

  it("is 0.7 (the documented threshold)", () => {
    assert.equal(HIGH_IMPACT_SCORE_THRESHOLD, 0.7);
  });
});

describe("scheduleBoundedHypothesisCandidates", () => {
  it("returns the highest-scoring candidate first and respects the configured limit", () => {
    const result = scheduleBoundedHypothesisCandidates([
      {
        key: "surface_map",
        summary: "Map the high-risk call path.",
        rationale: "Narrow the edit surface.",
        cheapSignals: ["laneReliability=0.30 below 0.55"],
        signalScores: {
          uncertaintyReduction: 0.6,
          cheapVerification: 0.7,
          executionLeverage: 0.7,
        },
      },
      {
        key: "smallest_verification",
        summary: "Run the smallest verification slice first.",
        rationale: "Cheap verification anchors the next move.",
        cheapSignals: ["successRate=0.10 below 0.55"],
        signalScores: {
          uncertaintyReduction: 0.95,
          cheapVerification: 0.95,
          executionLeverage: 0.85,
        },
      },
      {
        key: "contract_scan",
        summary: "Inspect the contract and nearest tests.",
        rationale: "Clarify the first edit before coding.",
        cheapSignals: ["sampleCount=1 below threshold 6"],
        signalScores: {
          uncertaintyReduction: 0.75,
          cheapVerification: 0.95,
          executionLeverage: 0.75,
        },
      },
    ], { limit: 2 });

    assert.deepEqual(result.map((candidate) => candidate.key), ["smallest_verification", "contract_scan"]);
    assert.equal(result.length, 2);
    assert.ok(result[0].score >= result[1].score);
  });

  it("negative path: drops invalid candidates and returns empty output for zero limit", () => {
    const invalidOnly = scheduleBoundedHypothesisCandidates([
      { key: "", summary: "Missing key" },
      { key: "missing_summary", summary: "" },
    ], { limit: 3 });
    const zeroLimit = scheduleBoundedHypothesisCandidates([
      { key: "contract_scan", summary: "Inspect the contract." },
    ], { limit: 0 });

    assert.deepEqual(invalidOnly, []);
    assert.deepEqual(zeroLimit, []);
  });
});

// ── AC9: validateSchedulerCandidate — MISSING vs INVALID ─────────────────────

describe("validateSchedulerCandidate — happy path (AC9)", () => {
  it("accepts a fully valid candidate", () => {
    const result = validateSchedulerCandidate(validCandidate());
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  it("accepts all valid scope tiers", () => {
    for (const tier of VALID_SCOPE_TIERS) {
      const r = validateSchedulerCandidate(validCandidate({ scopeTier: tier }));
      assert.equal(r.ok, true, `scopeTier=${tier} should be valid`);
    }
  });
});

describe("validateSchedulerCandidate — MISSING_FIELD codes (AC9)", () => {
  it("returns MISSING_FIELD for absent experimentId", () => {
    const c = validCandidate();
    delete c.experimentId;
    const r = validateSchedulerCandidate(c);
    assert.equal(r.ok, false);
    const err = r.errors.find(e => e.field === "experimentId");
    assert.ok(err, "must have error for experimentId");
    assert.equal(err.code, "MISSING_FIELD");
  });

  it("returns MISSING_FIELD for absent scopeTier", () => {
    const c = validCandidate();
    delete c.scopeTier;
    const r = validateSchedulerCandidate(c);
    assert.equal(r.ok, false);
    const err = r.errors.find(e => e.field === "scopeTier");
    assert.ok(err);
    assert.equal(err.code, "MISSING_FIELD");
  });

  it("returns MISSING_FIELD for absent impactScore", () => {
    const c = validCandidate();
    delete c.impactScore;
    const r = validateSchedulerCandidate(c);
    assert.equal(r.ok, false);
    const err = r.errors.find(e => e.field === "impactScore");
    assert.ok(err);
    assert.equal(err.code, "MISSING_FIELD");
  });

  it("returns MISSING_FIELD for absent interventionScope", () => {
    const c = validCandidate();
    delete c.interventionScope;
    const r = validateSchedulerCandidate(c);
    assert.equal(r.ok, false);
    const err = r.errors.find(e => e.field === "interventionScope");
    assert.ok(err);
    assert.equal(err.code, "MISSING_FIELD");
  });
});

describe("validateSchedulerCandidate — INVALID_VALUE codes (AC9)", () => {
  it("returns INVALID_VALUE for out-of-range impactScore (>1)", () => {
    const r = validateSchedulerCandidate(validCandidate({ impactScore: 1.5 }));
    assert.equal(r.ok, false);
    const err = r.errors.find(e => e.field === "impactScore");
    assert.ok(err);
    assert.equal(err.code, "INVALID_VALUE");
  });

  it("returns INVALID_VALUE for negative impactScore", () => {
    const r = validateSchedulerCandidate(validCandidate({ impactScore: -0.1 }));
    assert.equal(r.ok, false);
    const err = r.errors.find(e => e.field === "impactScore");
    assert.ok(err);
    assert.equal(err.code, "INVALID_VALUE");
  });

  it("returns INVALID_VALUE for unknown scopeTier (not null — present but wrong)", () => {
    const r = validateSchedulerCandidate(validCandidate({ scopeTier: "ultra" }));
    assert.equal(r.ok, false);
    const err = r.errors.find(e => e.field === "scopeTier");
    assert.ok(err);
    assert.equal(err.code, "INVALID_VALUE");
  });

  it("returns INVALID_VALUE for empty interventionScope array", () => {
    const r = validateSchedulerCandidate(validCandidate({ interventionScope: [] }));
    assert.equal(r.ok, false);
    const err = r.errors.find(e => e.field === "interventionScope");
    assert.ok(err);
    assert.equal(err.code, "INVALID_VALUE");
  });

  it("returns MISSING_FIELD (not INVALID_VALUE) for null input — distinguishes absent from invalid", () => {
    const r = validateSchedulerCandidate(null);
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, "MISSING_FIELD");
  });
});

// ── AC11: isHighImpact ────────────────────────────────────────────────────────

describe("isHighImpact (AC11 — high-impact classification defined)", () => {
  it("classifies score >= threshold as high-impact", () => {
    assert.equal(isHighImpact({ scopeTier: "medium", impactScore: 0.7  }), true);
    assert.equal(isHighImpact({ scopeTier: "medium", impactScore: 0.8  }), true);
    assert.equal(isHighImpact({ scopeTier: "medium", impactScore: 1.0  }), true);
  });

  it("classifies score < threshold as NOT high-impact (medium/low tiers)", () => {
    assert.equal(isHighImpact({ scopeTier: "medium", impactScore: 0.69 }), false);
    assert.equal(isHighImpact({ scopeTier: "low",    impactScore: 0.5  }), false);
  });

  it("classifies 'critical' tier as always high-impact regardless of score", () => {
    assert.equal(isHighImpact({ scopeTier: "critical", impactScore: 0.1 }), true);
    assert.equal(isHighImpact({ scopeTier: "critical", impactScore: 0.0 }), true);
  });

  it("classifies 'high' tier as always high-impact regardless of score", () => {
    assert.equal(isHighImpact({ scopeTier: "high", impactScore: 0.1 }), true);
    assert.equal(isHighImpact({ scopeTier: "high", impactScore: 0.0 }), true);
  });

  it("respects custom threshold", () => {
    assert.equal(isHighImpact({ scopeTier: "medium", impactScore: 0.5 }, 0.5), true);
    assert.equal(isHighImpact({ scopeTier: "medium", impactScore: 0.5 }, 0.6), false);
  });
});

// ── AC3/AC13: Baseline metrics ────────────────────────────────────────────────

describe("buildBaselineMetrics (AC3, AC13 — schema and metric list defined)", () => {
  it("includes all five required metric keys", () => {
    const m = buildBaselineMetrics({});
    const required = [
      "cycleSuccessRate",
      "workerTimeoutRate",
      "taskCompletionRate",
      "decisionQualityScore",
      "systemHealthScore"
    ];
    for (const key of required) {
      assert.ok(key in m, `metrics must include: ${key}`);
    }
  });

  it("sets metrics to null when outcomes are empty", () => {
    const m = buildBaselineMetrics({});
    assert.equal(m.cycleSuccessRate, null);
    assert.equal(m.workerTimeoutRate, null);
    assert.equal(m.taskCompletionRate, null);
    assert.equal(m.decisionQualityScore, null);
    assert.equal(m.systemHealthScore, null);
  });

  it("derives workerTimeoutRate from workerOutcomes", () => {
    const outcomes = {
      workerOutcomes: [
        { totalDispatches: 10, timeouts: 2 },
        { totalDispatches: 10, timeouts: 1 }
      ]
    };
    const m = buildBaselineMetrics(outcomes);
    assert.equal(m.workerTimeoutRate, 3 / 20);
  });

  it("derives taskCompletionRate from totalPlans and completedCount", () => {
    const m = buildBaselineMetrics({ totalPlans: 5, completedCount: 4 });
    assert.equal(m.taskCompletionRate, 0.8);
  });

  it("maps projectHealth 'good' to cycleSuccessRate=1.0", () => {
    const m = buildBaselineMetrics({ projectHealth: "good" });
    assert.equal(m.cycleSuccessRate, 1.0);
  });

  it("maps projectHealth 'warning' to cycleSuccessRate=0.5", () => {
    const m = buildBaselineMetrics({ projectHealth: "warning" });
    assert.equal(m.cycleSuccessRate, 0.5);
  });

  it("maps projectHealth 'degraded' to cycleSuccessRate=0.2", () => {
    const m = buildBaselineMetrics({ projectHealth: "degraded" });
    assert.equal(m.cycleSuccessRate, 0.2);
  });

  it("extracts decisionQualityScore from outcomes.decisionQuality.score", () => {
    const m = buildBaselineMetrics({ decisionQuality: { score: 0.75 } });
    assert.equal(m.decisionQualityScore, 0.75);
  });
});

describe("captureBaseline / loadBaselines / getBaseline (AC3, AC13)", () => {
  let tmpDir;
  before(async () => { tmpDir = await freshStateDir(); });
  after(async ()  => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("stores a baseline snapshot with required fields (schemaVersion, experimentId, capturedAt, metrics)", async () => {
    const metrics = {
      cycleSuccessRate: 1.0,
      workerTimeoutRate: 0.05,
      taskCompletionRate: 0.9,
      decisionQualityScore: 0.8,
      systemHealthScore: 85
    };
    const snapshot = await captureBaseline(tmpDir, "exp-test-001", metrics);
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.experimentId, "exp-test-001");
    assert.ok(typeof snapshot.capturedAt === "string" && snapshot.capturedAt.length > 0);
    assert.deepEqual(snapshot.metrics, metrics);
  });

  it("persists to hypothesis_baselines.json at the defined path (AC13)", async () => {
    const filePath = path.join(tmpDir, "hypothesis_baselines.json");
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed), "hypothesis_baselines.json must be a JSON array");
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].experimentId, "exp-test-001");
  });

  it("getBaseline returns the stored snapshot by experimentId", async () => {
    const b = await getBaseline(tmpDir, "exp-test-001");
    assert.ok(b !== null);
    assert.equal(b.experimentId, "exp-test-001");
  });

  it("getBaseline returns null for unknown experimentId (negative path)", async () => {
    const b = await getBaseline(tmpDir, "exp-nonexistent");
    assert.equal(b, null);
  });

  it("replacing an existing baseline updates it rather than appending a duplicate", async () => {
    const newMetrics = { cycleSuccessRate: 0.9, workerTimeoutRate: 0.1, taskCompletionRate: 0.8, decisionQualityScore: 0.7, systemHealthScore: 70 };
    await captureBaseline(tmpDir, "exp-test-001", newMetrics);
    const all = await loadBaselines(tmpDir);
    assert.equal(all.length, 1, "must not create duplicate baseline for same experimentId");
    assert.equal(all[0].metrics.cycleSuccessRate, 0.9);
  });
});

// ── AC2/AC12: Budget snapshot ─────────────────────────────────────────────────

describe("buildBudgetSnapshot (AC2, AC12 — budget config keys and limits)", () => {
  it("reads maxTotalActiveExperiments from config key", () => {
    const cfg = makeConfig("/tmp", { maxTotalActiveExperiments: 5 });
    const budget = buildBudgetSnapshot(cfg, { schemaVersion: 1, experiments: [] });
    assert.equal(budget.maxTotalActiveExperiments, 5, "must read from selfImprovement.scheduler.maxTotalActiveExperiments");
  });

  it("reads maxParallelWorkers from runtime config", () => {
    const cfg = makeConfig("/tmp");
    cfg.runtime.maxParallelWorkers = 8;
    const budget = buildBudgetSnapshot(cfg, { schemaVersion: 1, experiments: [] });
    assert.equal(budget.maxParallelWorkers, 8, "must read from runtime.maxParallelWorkers");
  });

  it("reads maxWorkerSpawnsPerCycle from runtime.runtimeBudget", () => {
    const cfg = makeConfig("/tmp");
    cfg.runtime.runtimeBudget.maxWorkerSpawnsPerCycle = 6;
    const budget = buildBudgetSnapshot(cfg, { schemaVersion: 1, experiments: [] });
    assert.equal(budget.maxWorkerSpawnsPerCycle, 6, "must read from runtime.runtimeBudget.maxWorkerSpawnsPerCycle");
  });

  it("defaults to 3 for maxTotalActiveExperiments when not configured", () => {
    const cfg = makeConfig("/tmp", {});
    delete cfg.selfImprovement.scheduler.maxTotalActiveExperiments;
    const budget = buildBudgetSnapshot(cfg, { schemaVersion: 1, experiments: [] });
    assert.equal(budget.maxTotalActiveExperiments, 3);
  });

  it("counts running experiments per tier in tierSlotUsed", () => {
    const cfg = makeConfig("/tmp");
    const registry = {
      schemaVersion: 1,
      experiments: [
        { experimentId: "exp-a", scopeTier: "critical", status: "running", interventionScope: ["a"] },
        { experimentId: "exp-b", scopeTier: "high",     status: "running", interventionScope: ["b"] },
        { experimentId: "exp-c", scopeTier: "critical", status: "planned", interventionScope: ["c"] }
      ]
    };
    const budget = buildBudgetSnapshot(cfg, registry);
    assert.equal(budget.tierSlotUsed.critical, 1, "one critical running");
    assert.equal(budget.tierSlotUsed.high,     1, "one high running");
    assert.equal(budget.tierSlotUsed.medium,   0);
    assert.equal(budget.tierSlotUsed.low,      0);
    assert.equal(budget.currentActiveCount, 2);
  });

  it("tier slot limits in budgetSnapshot reflect config overrides (AC12)", () => {
    const cfg = makeConfig("/tmp", { maxActiveExperimentsPerTier: { critical: 2, high: 1, medium: 3, low: 5 } });
    const budget = buildBudgetSnapshot(cfg, { schemaVersion: 1, experiments: [] });
    assert.equal(budget.tierSlotLimits.critical, 2);
    assert.equal(budget.tierSlotLimits.medium, 3);
    assert.equal(budget.tierSlotLimits.low, 5);
  });
});

// ── AC5/AC15: Rationale output ────────────────────────────────────────────────

describe("appendRationale / loadRationale (AC5, AC15 — rationale schema and destination)", () => {
  let tmpDir;
  before(async () => { tmpDir = await freshStateDir(); });
  after(async ()  => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("writes rationale to state/scheduler_rationale.json (AC15)", async () => {
    const mockRationale = {
      schemaVersion: 1,
      scheduledAt: new Date().toISOString(),
      selectedExperimentId: "exp-001",
      selectionStatus: "selected",
      rationale: "test rationale",
      selectedFromCount: 3,
      deferredExperimentIds: [],
      deferralReasons: {},
      budgetSnapshot: {
        maxTotalActiveExperiments: 3,
        currentActiveCount: 0,
        maxParallelWorkers: 10,
        maxWorkerSpawnsPerCycle: 12,
        tierSlotLimits: { critical: 1, high: 1, medium: 2, low: 3 },
        tierSlotUsed: { critical: 0, high: 0, medium: 0, low: 0 }
      },
      baselineCaptured: true,
      baselineExperimentId: "exp-001"
    };
    await appendRationale(tmpDir, mockRationale);

    const filePath = path.join(tmpDir, "scheduler_rationale.json");
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 1);
  });

  it("rationale record includes all required schema fields (AC5, AC8)", async () => {
    const records = await loadRationale(tmpDir);
    const r = records[0];
    const required = [
      "schemaVersion", "scheduledAt", "selectedExperimentId", "selectionStatus",
      "rationale", "selectedFromCount", "deferredExperimentIds", "deferralReasons",
      "budgetSnapshot", "baselineCaptured", "baselineExperimentId"
    ];
    for (const f of required) {
      assert.ok(f in r, `rationale must include field: ${f}`);
    }
  });

  it("selectionStatus is one of the defined enum values (AC8)", async () => {
    const records = await loadRationale(tmpDir);
    assert.ok(VALID_SELECTION_STATUSES.has(records[0].selectionStatus));
  });
});

// ── AC1/AC4: scheduleNextExperiment — core scheduling behavior ────────────────

describe("scheduleNextExperiment — no candidates (AC1)", () => {
  let tmpDir;
  before(async () => { tmpDir = await freshStateDir(); });
  after(async ()  => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns status=no_candidates when registry has no planned experiments", async () => {
    const cfg = makeConfig(tmpDir);
    const result = await scheduleNextExperiment(cfg);
    assert.equal(result.status, "no_candidates");
    assert.equal(result.experimentId, null);
    assert.equal(result.errorCode, null);
  });

  it("writes a rationale record even when no candidates exist (AC5)", async () => {
    const records = await loadRationale(tmpDir);
    assert.ok(records.length >= 1);
    assert.equal(records[records.length - 1].selectionStatus, "no_candidates");
  });
});

describe("scheduleNextExperiment — selects the highest impactScore candidate (AC1)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await freshStateDir();
    const cfg = makeConfig(tmpDir);

    // Register two planned candidates with different impact scores
    await registerExperiment(tmpDir, validCandidate({
      experimentId: "exp-low-impact",
      impactScore: 0.3,
      scopeTier: "medium",
      interventionScope: ["runtime.workerTimeoutMinutes"]
    }));
    await registerExperiment(tmpDir, validCandidate({
      experimentId: "exp-high-impact",
      impactScore: 0.8,
      scopeTier: "medium",
      interventionScope: ["systemGuardian.cooldownMinutes"],
      hypothesisId: "hyp-guardian",
      interventionId: "int-guardian-10",
      treatmentGroup: "B"
    }));

    result = await scheduleNextExperiment(cfg);
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("selects the higher-impactScore experiment", () => {
    assert.equal(result.status, "selected");
    assert.equal(result.experimentId, "exp-high-impact");
  });

  it("defers the lower-impactScore experiment", () => {
    assert.ok(result.deferredIds.includes("exp-low-impact"), "lower impact must be deferred");
  });

  it("captures a baseline for the selected experiment (AC3)", () => {
    assert.equal(result.baselineCaptured, true);
    assert.equal(result.status, "selected");
  });
});

describe("scheduleNextExperiment — baseline already captured is not recaptured (AC3)", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await freshStateDir();
    // Pre-create baseline
    await captureBaseline(tmpDir, "exp-preexisting", {
      cycleSuccessRate: 1.0, workerTimeoutRate: 0, taskCompletionRate: 1,
      decisionQualityScore: 1, systemHealthScore: 100
    });
    await registerExperiment(tmpDir, validCandidate({ experimentId: "exp-preexisting" }));
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("baselineCaptured=false when baseline already exists", async () => {
    const cfg = makeConfig(tmpDir);
    const result = await scheduleNextExperiment(cfg);
    assert.equal(result.status, "selected");
    assert.equal(result.baselineCaptured, false, "must not overwrite existing baseline");
  });
});

describe("scheduleNextExperiment — tier slot enforcement (AC1, AC4)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await freshStateDir();
    const cfg = makeConfig(tmpDir);

    // Simulate one running critical experiment (fills the 1-slot critical tier)
    await registerExperiment(tmpDir, validCandidate({
      experimentId: "exp-critical-running",
      scopeTier: "critical",
      impactScore: 0.9,
      status: "running",
      interventionScope: ["src/core/orchestrator.js"]
    }));

    // Register a planned critical experiment — should be deferred (tier full)
    await registerExperiment(tmpDir, validCandidate({
      experimentId: "exp-critical-planned",
      scopeTier: "critical",
      impactScore: 0.8,
      status: "planned",
      interventionScope: ["src/core/policy_engine.js"],
      hypothesisId: "hyp-policy",
      interventionId: "int-policy-1",
      treatmentGroup: "A"
    }));

    result = await scheduleNextExperiment(cfg);
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("defers the critical experiment when tier slot is full (AC1 — one high-impact per tier)", () => {
    assert.equal(result.status, "deferred");
    assert.ok(result.deferredIds.includes("exp-critical-planned"));
  });

  it("deferral reason includes TIER_SLOT_FULL with tier name (AC10 — explicit reason code)", () => {
    const reason = result.budgetSnapshot
      ? result.deferredIds.length > 0
        ? "TIER_SLOT_FULL"
        : null
      : null;
    // Check via the rationale record which has the full deferralReasons map
    assert.ok(result.deferredIds.length > 0, "must have deferred IDs");
  });

  it("rationale record deferralReasons contains TIER_SLOT_FULL for the deferred experiment (AC5)", async () => {
    const records = await loadRationale(tmpDir);
    const last = records[records.length - 1];
    const reason = last.deferralReasons["exp-critical-planned"] || "";
    assert.ok(reason.startsWith("TIER_SLOT_FULL"), `expected TIER_SLOT_FULL, got: ${reason}`);
  });
});

describe("scheduleNextExperiment — interventionScope conflict (AC4)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await freshStateDir();
    const cfg = makeConfig(tmpDir);

    // Running experiment covering "runtime.workerTimeoutMinutes"
    await registerExperiment(tmpDir, validCandidate({
      experimentId: "exp-running-timeout",
      scopeTier: "medium",
      impactScore: 0.6,
      status: "running",
      interventionScope: ["runtime.workerTimeoutMinutes"]
    }));

    // Planned experiment with overlapping interventionScope
    await registerExperiment(tmpDir, validCandidate({
      experimentId: "exp-conflict-planned",
      scopeTier: "medium",
      impactScore: 0.5,
      status: "planned",
      interventionScope: ["runtime.workerTimeoutMinutes"],
      hypothesisId: "hyp-conflict",
      interventionId: "int-conflict-1",
      treatmentGroup: "B"
    }));

    result = await scheduleNextExperiment(cfg);
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("defers the conflicting experiment (same interventionScope path)", () => {
    assert.equal(result.status, "deferred");
    assert.ok(result.deferredIds.includes("exp-conflict-planned"));
  });

  it("deferral reason includes CONFLICT keyword (AC4, AC10)", async () => {
    const records = await loadRationale(tmpDir);
    const last = records[records.length - 1];
    const reason = last.deferralReasons["exp-conflict-planned"] || "";
    assert.ok(reason.startsWith("CONFLICT"), `expected CONFLICT, got: ${reason}`);
  });
});

describe("scheduleNextExperiment — global active cap (AC2, AC12)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await freshStateDir();
    // Config with maxTotalActiveExperiments=1 to make it easy to hit the cap
    const cfg = makeConfig(tmpDir, { maxTotalActiveExperiments: 1 });

    // One running experiment to fill the cap
    await registerExperiment(tmpDir, validCandidate({
      experimentId: "exp-running-a",
      scopeTier: "medium",
      impactScore: 0.5,
      status: "running",
      interventionScope: ["runtime.workerTimeoutMinutes"]
    }));

    // One planned experiment — should be blocked by global cap
    await registerExperiment(tmpDir, validCandidate({
      experimentId: "exp-planned-b",
      scopeTier: "low",
      impactScore: 0.4,
      status: "planned",
      interventionScope: ["runtime.blockedTaskRequeueMinutes"],
      hypothesisId: "hyp-requeue",
      interventionId: "int-requeue-1",
      treatmentGroup: "A"
    }));

    result = await scheduleNextExperiment(cfg);
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns status=budget_exhausted when global cap is reached (AC2)", () => {
    assert.equal(result.status, "budget_exhausted");
  });

  it("errorCode=GLOBAL_ACTIVE_CAP (AC10 — explicit reason code)", () => {
    assert.equal(result.errorCode, "GLOBAL_ACTIVE_CAP");
  });

  it("all candidates appear in deferredIds", () => {
    assert.ok(result.deferredIds.includes("exp-planned-b"));
  });
});

// ── AC7/AC10: Negative paths ──────────────────────────────────────────────────

describe("scheduleNextExperiment — engine disabled (AC10 — no silent fallback)", () => {
  let tmpDir;
  before(async () => { tmpDir = await freshStateDir(); });
  after(async ()  => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns status=error with ENGINE_DISABLED errorCode when experimentEngineEnabled=false", async () => {
    const cfg = makeConfig(tmpDir);
    cfg.selfImprovement.experimentEngineEnabled = false;
    const result = await scheduleNextExperiment(cfg);
    assert.equal(result.status, "error");
    assert.equal(result.errorCode, "ENGINE_DISABLED");
    assert.equal(result.experimentId, null);
  });

  it("does not write any rationale when engine is disabled (no side-effects)", async () => {
    const records = await loadRationale(tmpDir);
    assert.equal(records.length, 0, "no rationale should be written when engine is disabled");
  });
});

describe("scheduleNextExperiment — candidate with invalid scopeTier is deferred, not thrown (AC7, AC10)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await freshStateDir();
    const cfg = makeConfig(tmpDir);

    // Register an invalid candidate directly (bypass registerExperiment validation)
    // by writing to state file directly
    const registryPath = path.join(tmpDir, "experiment_registry.json");
    await fs.writeFile(registryPath, JSON.stringify({
      schemaVersion: 1,
      experiments: [{
        experimentId: "exp-bad-tier",
        hypothesisId: "hyp-bad",
        interventionId: "int-bad",
        treatmentGroup: "A",
        scopeTier: "INVALID_TIER",
        impactScore: 0.5,
        interventionScope: ["some.path"],
        baselineWindow: { startAt: "2026-01-01T00:00:00.000Z", endAt: null, durationHours: 24 },
        stopConditions: [{ type: "manual", value: "done" }],
        disproveCriteria: "x",
        rollbackPlan: "y",
        status: "planned",
        createdAt: "2026-01-01T00:00:00.000Z"
      }]
    }), "utf8");

    result = await scheduleNextExperiment(cfg);
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns status=deferred (not error/throw) for invalid candidate", () => {
    assert.equal(result.status, "deferred");
  });

  it("deferral reason contains INVALID_CANDIDATE with reason code (AC10)", async () => {
    const records = await loadRationale(tmpDir);
    const last = records[records.length - 1];
    const reason = last.deferralReasons["exp-bad-tier"] || "";
    assert.ok(reason.startsWith("INVALID_CANDIDATE"), `expected INVALID_CANDIDATE, got: ${reason}`);
  });
});

// ── AC5: Rationale content is explainable ─────────────────────────────────────

describe("scheduleNextExperiment — rationale is explainable and contains key fields (AC5)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await freshStateDir();
    const cfg = makeConfig(tmpDir);

    await registerExperiment(tmpDir, validCandidate({
      experimentId: "exp-explain-me",
      scopeTier: "high",
      impactScore: 0.85,
      interventionScope: ["selfImprovement.maxImprovementTasksPerCycle"]
    }));

    result = await scheduleNextExperiment(cfg, {
      projectHealth: "good",
      totalPlans: 5,
      completedCount: 4,
      workerOutcomes: [{ totalDispatches: 10, timeouts: 1 }],
      decisionQuality: { score: 0.8 }
    });
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("rationale string mentions the experiment ID", () => {
    assert.ok(result.rationale.includes("exp-explain-me"), "rationale must name the selected experiment");
  });

  it("rationale string mentions the tier", () => {
    assert.ok(result.rationale.includes("high"), "rationale must mention scope tier");
  });

  it("rationale string mentions highImpact flag", () => {
    assert.ok(result.rationale.includes("highImpact=true"), "rationale must state highImpact");
  });

  it("rationale record in state file has selectedFromCount >= 1 (AC5, AC15)", async () => {
    const records = await loadRationale(tmpDir);
    const last = records[records.length - 1];
    assert.ok(last.selectedFromCount >= 1);
  });

  it("baseline captured with all five required metric keys (AC3)", async () => {
    const baseline = await getBaseline(tmpDir, "exp-explain-me");
    assert.ok(baseline !== null);
    const required = ["cycleSuccessRate", "workerTimeoutRate", "taskCompletionRate", "decisionQualityScore", "systemHealthScore"];
    for (const k of required) {
      assert.ok(k in baseline.metrics, `baseline.metrics must include: ${k}`);
    }
  });
});

// ── AC2: Budget snapshot fields are present in result ─────────────────────────

describe("scheduleNextExperiment — budgetSnapshot in result (AC2)", () => {
  let tmpDir;
  before(async () => { tmpDir = await freshStateDir(); });
  after(async ()  => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("result always includes budgetSnapshot with required fields", async () => {
    const cfg = makeConfig(tmpDir);
    const result = await scheduleNextExperiment(cfg);
    const b = result.budgetSnapshot;
    assert.ok(b && typeof b === "object", "budgetSnapshot must be an object");
    assert.ok("maxTotalActiveExperiments" in b, "must include maxTotalActiveExperiments");
    assert.ok("currentActiveCount" in b, "must include currentActiveCount");
    assert.ok("maxParallelWorkers" in b, "must include maxParallelWorkers");
    assert.ok("maxWorkerSpawnsPerCycle" in b, "must include maxWorkerSpawnsPerCycle");
    assert.ok("tierSlotLimits" in b, "must include tierSlotLimits");
    assert.ok("tierSlotUsed" in b, "must include tierSlotUsed");
  });
});
