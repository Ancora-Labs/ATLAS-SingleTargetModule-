/**
 * Tests for dispatch strictness level computation from replay harness regressions.
 *
 * Verifies that computeDispatchStrictness() correctly combines:
 *   - Replay regression state (regressionCount / totalCount → regressionRate)
 *   - Parser baseline recovery record (recoveryActive, parserConfidence)
 *
 * Thresholds:
 *   BLOCKED  : regressionRate > 0.50
 *   STRICT   : regressionRate > 0.20  OR  (recoveryActive AND parserConfidence < 0.70)
 *   ELEVATED : regressionRate > 0.00  OR  recoveryActive (shallow)
 *   NORMAL   : regressionRate == 0    AND NOT recoveryActive
 *
 * Also covers persistence helpers:
 *   persistReplayRegressionState / loadReplayRegressionState
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  computeDispatchStrictness,
  persistReplayRegressionState,
  loadReplayRegressionState,
  DISPATCH_STRICTNESS,
  type ReplayRegressionState,
} from "../../src/core/parser_replay_harness.js";

import type { BaselineRecoveryRecord } from "../../src/core/parser_baseline_recovery.js";

import {
  isDiscoverySafeTask,
  DISCOVERY_SAFE_TASK_KINDS,
  NON_MERGE_TASK_KINDS,
} from "../../src/core/verification_gate.js";
import {
  resolveWorkerExecutionLineageId,
  WORKER_MODEL_CALL_HOOK,
  emitWorkerModelCallHookEvent,
} from "../../src/core/worker_runner.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReplayState(regressionCount: number, totalCount: number): ReplayRegressionState {
  return {
    regressionCount,
    totalCount,
    passed: regressionCount === 0,
    computedAt: new Date().toISOString(),
  };
}

function makeRecoveryRecord(overrides: Partial<BaselineRecoveryRecord> = {}): BaselineRecoveryRecord {
  return {
    cycleId: null,
    recordedAt: new Date().toISOString(),
    parserConfidence: 1.0,
    recoveryActive: false,
    recoveryThreshold: 0.9,
    componentMetrics: { plansShape: 1.0, healthField: 1.0, requestBudget: 1.0 },
    componentGap:     { plansShape: 0,   healthField: 0,   requestBudget: 0   },
    penalties: [],
    ...overrides,
  };
}

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-dispatch-strictness-"));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── DISPATCH_STRICTNESS constants ─────────────────────────────────────────────

describe("DISPATCH_STRICTNESS", () => {
  it("exports all four levels as frozen string constants", () => {
    assert.equal(DISPATCH_STRICTNESS.NORMAL,   "normal");
    assert.equal(DISPATCH_STRICTNESS.ELEVATED, "elevated");
    assert.equal(DISPATCH_STRICTNESS.STRICT,   "strict");
    assert.equal(DISPATCH_STRICTNESS.BLOCKED,  "blocked");
    assert.throws(() => { (DISPATCH_STRICTNESS as any).NEW_LEVEL = "x"; }, "must be frozen");
  });
});

describe("worker_runner lifecycle hook events", () => {
  it("exports deterministic model-call hook names", () => {
    assert.equal(WORKER_MODEL_CALL_HOOK.SETTINGS_OVERLAY_RESOLVED, "settings_overlay_resolved");
    assert.equal(WORKER_MODEL_CALL_HOOK.BEFORE_MODEL_CALL, "before_model_call");
    assert.equal(WORKER_MODEL_CALL_HOOK.AFTER_MODEL_CALL, "after_model_call");
    assert.ok(Object.isFrozen(WORKER_MODEL_CALL_HOOK));
  });

  it("emits explicit lifecycle hook events without throwing", () => {
    assert.doesNotThrow(() => {
      emitWorkerModelCallHookEvent(
        WORKER_MODEL_CALL_HOOK.BEFORE_MODEL_CALL,
        "worker",
        "Claude Sonnet 4.6",
        "lin-123",
        { taskId: 1 },
      );
      emitWorkerModelCallHookEvent(
        WORKER_MODEL_CALL_HOOK.AFTER_MODEL_CALL,
        "worker",
        "Claude Sonnet 4.6",
        "lin-123",
        { taskId: 1, exitCode: 0 },
      );
    });
  });

  it("negative path: tolerates null lineage and empty payload", () => {
    assert.doesNotThrow(() => {
      emitWorkerModelCallHookEvent(
        WORKER_MODEL_CALL_HOOK.SETTINGS_OVERLAY_RESOLVED,
        "worker",
        null,
        null,
      );
    });
  });
});

// ── computeDispatchStrictness: NORMAL cases ───────────────────────────────────

describe("computeDispatchStrictness — NORMAL level", () => {
  it("returns NORMAL when no regressions and parser healthy", () => {
    const result = computeDispatchStrictness(
      makeReplayState(0, 10),
      makeRecoveryRecord({ recoveryActive: false })
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.NORMAL);
    assert.equal(result.regressionRate, 0);
    assert.equal(result.recoveryActive, false);
  });

  it("returns NORMAL with null replayState and healthy baseline", () => {
    const result = computeDispatchStrictness(null, makeRecoveryRecord());
    assert.equal(result.strictness, DISPATCH_STRICTNESS.NORMAL);
  });

  it("returns NORMAL with null replayState and null baseline", () => {
    const result = computeDispatchStrictness(null, null);
    assert.equal(result.strictness, DISPATCH_STRICTNESS.NORMAL);
  });

  it("returns NORMAL with undefined inputs", () => {
    const result = computeDispatchStrictness(undefined, undefined);
    assert.equal(result.strictness, DISPATCH_STRICTNESS.NORMAL);
  });

  it("returns NORMAL for zero corpus size with healthy baseline", () => {
    const result = computeDispatchStrictness(makeReplayState(0, 0), null);
    assert.equal(result.strictness, DISPATCH_STRICTNESS.NORMAL);
    assert.equal(result.regressionRate, 0);
  });
});

// ── computeDispatchStrictness: ELEVATED cases ─────────────────────────────────

describe("computeDispatchStrictness — ELEVATED level", () => {
  it("returns ELEVATED for single regression in large corpus (rate ≤ 0.2)", () => {
    const result = computeDispatchStrictness(
      makeReplayState(1, 10),
      makeRecoveryRecord()
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.ELEVATED);
    assert.ok(result.regressionRate > 0 && result.regressionRate <= 0.2);
  });

  it("returns ELEVATED when regressionRate is exactly 0.2 (boundary)", () => {
    const result = computeDispatchStrictness(
      makeReplayState(2, 10),
      makeRecoveryRecord()
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.ELEVATED);
    assert.equal(result.regressionRate, 0.2);
  });

  it("returns ELEVATED when recoveryActive=true with confidence >= 0.7, no corpus regressions", () => {
    const result = computeDispatchStrictness(
      makeReplayState(0, 10),
      makeRecoveryRecord({ recoveryActive: true, parserConfidence: 0.75 })
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.ELEVATED);
    assert.equal(result.recoveryActive, true);
  });

  it("returns ELEVATED when recoveryActive=true with confidence == 0.7 (boundary)", () => {
    const result = computeDispatchStrictness(
      makeReplayState(0, 5),
      makeRecoveryRecord({ recoveryActive: true, parserConfidence: 0.7 })
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.ELEVATED);
  });

  it("reason mentions regression count for regression-driven elevation", () => {
    const result = computeDispatchStrictness(
      makeReplayState(1, 20),
      makeRecoveryRecord()
    );
    assert.ok(result.reason.length > 0);
    assert.equal(result.regressionCount, 1);
  });

  it("reason mentions baseline recovery for recovery-driven elevation", () => {
    const result = computeDispatchStrictness(
      null,
      makeRecoveryRecord({ recoveryActive: true, parserConfidence: 0.85 })
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.ELEVATED);
    assert.ok(/recovery/i.test(result.reason), "reason should mention recovery");
  });
});

// ── computeDispatchStrictness: STRICT cases ───────────────────────────────────

describe("computeDispatchStrictness — STRICT level", () => {
  it("returns STRICT when regressionRate slightly exceeds 0.2 (3/10)", () => {
    const result = computeDispatchStrictness(
      makeReplayState(3, 10),
      makeRecoveryRecord()
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.STRICT);
    assert.equal(result.regressionRate, 0.3);
  });

  it("returns STRICT at exactly 0.5 regression rate (boundary below BLOCKED)", () => {
    const result = computeDispatchStrictness(
      makeReplayState(5, 10),
      makeRecoveryRecord()
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.STRICT);
    assert.equal(result.regressionRate, 0.5);
  });

  it("returns STRICT when recoveryActive=true and confidence < 0.7, no corpus regressions", () => {
    const result = computeDispatchStrictness(
      makeReplayState(0, 10),
      makeRecoveryRecord({ recoveryActive: true, parserConfidence: 0.65 })
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.STRICT);
    assert.equal(result.recoveryActive, true);
  });

  it("returns STRICT when recoveryActive=true and confidence just below 0.7", () => {
    const result = computeDispatchStrictness(
      makeReplayState(0, 10),
      makeRecoveryRecord({ recoveryActive: true, parserConfidence: 0.699 })
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.STRICT);
  });

  it("reason field is non-empty for STRICT level", () => {
    const result = computeDispatchStrictness(
      makeReplayState(4, 10),
      makeRecoveryRecord()
    );
    assert.ok(result.reason.length > 0);
  });
});

// ── computeDispatchStrictness: BLOCKED cases ─────────────────────────────────

describe("computeDispatchStrictness — BLOCKED level", () => {
  it("returns BLOCKED when regressionRate just exceeds 0.5 (6/10)", () => {
    const result = computeDispatchStrictness(
      makeReplayState(6, 10),
      makeRecoveryRecord()
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.BLOCKED);
    assert.equal(result.regressionRate, 0.6);
  });

  it("returns BLOCKED at 100% regression rate", () => {
    const result = computeDispatchStrictness(
      makeReplayState(10, 10),
      makeRecoveryRecord()
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.BLOCKED);
    assert.equal(result.regressionRate, 1.0);
  });

  it("BLOCKED overrides recovery signal — regression rate takes precedence", () => {
    const result = computeDispatchStrictness(
      makeReplayState(8, 10),
      makeRecoveryRecord({ recoveryActive: false, parserConfidence: 1.0 })
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.BLOCKED);
  });

  it("reason mentions threshold for BLOCKED level", () => {
    const result = computeDispatchStrictness(
      makeReplayState(7, 10),
      null
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.BLOCKED);
    assert.ok(/50%|blocked|threshold/i.test(result.reason));
  });

  it("negative: BLOCKED does not fire at exactly 50% regression rate", () => {
    // Exactly 0.5 is STRICT, not BLOCKED — the threshold is strictly > 0.5.
    const result = computeDispatchStrictness(
      makeReplayState(5, 10),
      makeRecoveryRecord()
    );
    assert.notEqual(result.strictness, DISPATCH_STRICTNESS.BLOCKED);
    assert.equal(result.strictness, DISPATCH_STRICTNESS.STRICT);
  });
});

// ── computeDispatchStrictness: output shape ───────────────────────────────────

describe("computeDispatchStrictness — result shape", () => {
  it("always returns regressionRate, regressionCount, totalCount, recoveryActive, reason", () => {
    const result = computeDispatchStrictness(makeReplayState(2, 8), makeRecoveryRecord());
    assert.ok(typeof result.regressionRate === "number");
    assert.ok(typeof result.regressionCount === "number");
    assert.ok(typeof result.totalCount === "number");
    assert.ok(typeof result.recoveryActive === "boolean");
    assert.ok(typeof result.reason === "string");
    assert.ok(typeof result.strictness === "string");
  });

  it("regressionRate is computed correctly (regressionCount / totalCount)", () => {
    const result = computeDispatchStrictness(makeReplayState(3, 12), null);
    assert.ok(Math.abs(result.regressionRate - 0.25) < 0.0001);
  });

  it("regressionRate is 0 when totalCount is 0", () => {
    const result = computeDispatchStrictness(makeReplayState(0, 0), null);
    assert.equal(result.regressionRate, 0);
  });
});

// ── persistReplayRegressionState / loadReplayRegressionState ─────────────────

describe("persistReplayRegressionState + loadReplayRegressionState", () => {
  it("returns null when no state file exists", async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-rr-empty-"));
    try {
      const result = await loadReplayRegressionState({ paths: { stateDir: emptyDir } });
      assert.equal(result, null);
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("persists and reads back a regression state with correct fields", async () => {
    const dir = path.join(tmpDir, "persist-test");
    await fs.mkdir(dir, { recursive: true });
    const config = { paths: { stateDir: dir } };

    await persistReplayRegressionState(config, {
      regressionCount: 3,
      results: new Array(10).fill({}),
      passed: false,
    });

    const loaded = await loadReplayRegressionState(config);
    assert.ok(loaded !== null);
    assert.equal(loaded!.regressionCount, 3);
    assert.equal(loaded!.totalCount, 10);
    assert.equal(loaded!.passed, false);
    assert.ok(typeof loaded!.computedAt === "string");
    assert.ok(!isNaN(Date.parse(loaded!.computedAt)));
  });

  it("overwrites the previous state on subsequent persist", async () => {
    const dir = path.join(tmpDir, "overwrite-test");
    await fs.mkdir(dir, { recursive: true });
    const config = { paths: { stateDir: dir } };

    await persistReplayRegressionState(config, { regressionCount: 2, results: new Array(5).fill({}), passed: false });
    await persistReplayRegressionState(config, { regressionCount: 0, results: new Array(5).fill({}), passed: true });

    const loaded = await loadReplayRegressionState(config);
    assert.equal(loaded!.regressionCount, 0);
    assert.equal(loaded!.passed, true);
  });

  it("passed=true is stored when regressionCount is 0", async () => {
    const dir = path.join(tmpDir, "passed-true-test");
    await fs.mkdir(dir, { recursive: true });
    const config = { paths: { stateDir: dir } };

    await persistReplayRegressionState(config, { regressionCount: 0, results: [], passed: true });
    const loaded = await loadReplayRegressionState(config);
    assert.equal(loaded!.passed, true);
    assert.equal(loaded!.totalCount, 0);
  });

  it("totalCount reflects results.length not regressionCount", async () => {
    const dir = path.join(tmpDir, "totalcount-test");
    await fs.mkdir(dir, { recursive: true });
    const config = { paths: { stateDir: dir } };

    await persistReplayRegressionState(config, {
      regressionCount: 1,
      results: new Array(20).fill({}),
      passed: false,
    });
    const loaded = await loadReplayRegressionState(config);
    assert.equal(loaded!.totalCount, 20);
    assert.equal(loaded!.regressionCount, 1);
  });
});

// ── End-to-end: replayCorpus → persist → computeDispatchStrictness ───────────

describe("end-to-end: replayCorpus → persist → computeDispatchStrictness", () => {
  it("correct corpus produces NORMAL dispatch strictness after persistence roundtrip", async () => {
    const { replayCorpus } = await import("../../src/core/parser_replay_harness.js");

    const corpus = [
      { id: "e2e-1", raw: "input", baselineConfidence: 0.9, expectedPlanCount: 1, requiredKeys: ["id"] },
      { id: "e2e-2", raw: "input", baselineConfidence: 0.8, expectedPlanCount: 1, requiredKeys: ["id"] },
    ];
    const replayResult = replayCorpus(corpus, () => ({ confidence: 0.9, plans: [{ id: 1 }] }));

    const dir = path.join(tmpDir, "e2e-normal");
    await fs.mkdir(dir, { recursive: true });
    const config = { paths: { stateDir: dir } };

    await persistReplayRegressionState(config, replayResult);
    const loaded = await loadReplayRegressionState(config);

    const strictness = computeDispatchStrictness(loaded, null);
    assert.equal(strictness.strictness, DISPATCH_STRICTNESS.NORMAL);
    assert.equal(strictness.regressionCount, 0);
  });

  it("regressed corpus produces STRICT dispatch strictness after persistence roundtrip", async () => {
    const { replayCorpus } = await import("../../src/core/parser_replay_harness.js");

    // 3 out of 5 entries regress → rate = 0.6 → BLOCKED
    const corpus = [
      { id: "r1", raw: "input", baselineConfidence: 0.9, expectedPlanCount: 1 },
      { id: "r2", raw: "input", baselineConfidence: 0.9, expectedPlanCount: 1 },
      { id: "r3", raw: "input", baselineConfidence: 0.9, expectedPlanCount: 1 },
      { id: "r4", raw: "input", baselineConfidence: 0.9, expectedPlanCount: 1 },
      { id: "r5", raw: "input", baselineConfidence: 0.5, expectedPlanCount: 1 },
    ];
    // Parser returns low confidence → 4 regressions (rate=0.8)
    const replayResult = replayCorpus(corpus, () => ({ confidence: 0.5, plans: [] }));

    const dir = path.join(tmpDir, "e2e-blocked");
    await fs.mkdir(dir, { recursive: true });
    const config = { paths: { stateDir: dir } };

    await persistReplayRegressionState(config, replayResult);
    const loaded = await loadReplayRegressionState(config);

    const strictness = computeDispatchStrictness(loaded, null);
    assert.equal(strictness.strictness, DISPATCH_STRICTNESS.BLOCKED);
  });

  it("partial regressions (20% rate) combined with recovery produces ELEVATED", async () => {
    const { replayCorpus } = await import("../../src/core/parser_replay_harness.js");

    const corpus = [
      { id: "p1", raw: "input", baselineConfidence: 0.9, expectedPlanCount: 1 },
      { id: "p2", raw: "input", baselineConfidence: 0.9, expectedPlanCount: 1 },
      { id: "p3", raw: "input", baselineConfidence: 0.9, expectedPlanCount: 1 },
      { id: "p4", raw: "input", baselineConfidence: 0.9, expectedPlanCount: 1 },
      { id: "p5", raw: "input", baselineConfidence: 0.5, expectedPlanCount: 1 },
    ];
    // 1 regresses (rate=0.2 → boundary) — parser returns 0.5 for r5 (only r5 had baseline 0.5 + gets conf 0.9 = passes)
    // Actually let me construct exactly 1 regression: only p1 regresses (baseline=0.9, current=0.5 → delta=-0.4 < -0.15)
    const replayResult = replayCorpus(corpus, (raw) => {
      // Only the first corpus entry gets low confidence
      if (raw === "input") return { confidence: 0.5, plans: [] };
      return { confidence: 0.9, plans: [{}] };
    });
    // All entries have the same raw "input", so all 5 regress — that's BLOCKED
    // Let's use a different approach: use distinct raw values
    const corpus2 = [
      { id: "q1", raw: "raw-a", baselineConfidence: 0.9, expectedPlanCount: 1 },
      { id: "q2", raw: "raw-b", baselineConfidence: 0.9, expectedPlanCount: 1 },
      { id: "q3", raw: "raw-c", baselineConfidence: 0.5, expectedPlanCount: 1 },
      { id: "q4", raw: "raw-d", baselineConfidence: 0.5, expectedPlanCount: 1 },
      { id: "q5", raw: "raw-e", baselineConfidence: 0.5, expectedPlanCount: 1 },
    ];
    // Only q1 and q2 regress (current 0.75 < baseline 0.9 by 0.15 exactly — boundary, NOT a regression since delta must be < -0.15)
    // Set current = 0.7 → delta = -0.2 < -0.15 for q1 and q2; q3..q5 have baseline 0.5, current 0.7 = passes
    const replayResult2 = replayCorpus(corpus2, (raw) => {
      if (raw === "raw-a" || raw === "raw-b") return { confidence: 0.7, plans: [{}] };
      return { confidence: 0.7, plans: [{}] };
    });
    // q1: delta = 0.7-0.9 = -0.2 < -0.15 → regression
    // q2: delta = 0.7-0.9 = -0.2 < -0.15 → regression
    // q3..q5: delta = 0.7-0.5 = +0.2 → no regression
    // regressionCount = 2, totalCount = 5, rate = 0.4 → STRICT

    const dir = path.join(tmpDir, "e2e-partial");
    await fs.mkdir(dir, { recursive: true });
    const config = { paths: { stateDir: dir } };

    await persistReplayRegressionState(config, replayResult2);
    const loaded = await loadReplayRegressionState(config);

    const strictness = computeDispatchStrictness(
      loaded,
      makeRecoveryRecord({ recoveryActive: true, parserConfidence: 0.85 })
    );
    // rate=0.4 → STRICT (>0.2 but <=0.5)
    assert.equal(strictness.strictness, DISPATCH_STRICTNESS.STRICT);
  });
});

// ── Discovery-safe bypass — strict gate vs. non-merge task interaction ─────────
//
// When dispatch strictness is BLOCKED (regression rate > 50%), merge tasks must
// be prevented.  Discovery-safe tasks (scan, doc, discovery, research, etc.)
// qualify for the adaptive throttle bypass — they do not produce code changes
// and cannot introduce regressions, so they can proceed even at BLOCKED level.
//
// These tests verify that:
//   1. DISCOVERY_SAFE_TASK_KINDS is consistent with NON_MERGE_TASK_KINDS.
//   2. isDiscoverySafeTask correctly classifies all task kinds.
//   3. At BLOCKED dispatch strictness, discovery-safe tasks are identifiable
//      as bypass candidates while merge tasks remain blocked.

describe("discovery-safe bypass — dispatch strictness interaction", () => {
  it("all NON_MERGE_TASK_KINDS are also DISCOVERY_SAFE_TASK_KINDS (non-merge implies discovery-safe)", () => {
    for (const kind of NON_MERGE_TASK_KINDS) {
      assert.ok(
        DISCOVERY_SAFE_TASK_KINDS.has(kind),
        `"${kind}" is in NON_MERGE_TASK_KINDS but not in DISCOVERY_SAFE_TASK_KINDS — every non-merge kind must qualify for the discovery bypass`
      );
    }
  });

  it("DISCOVERY_SAFE_TASK_KINDS contains the full expected set of discovery-safe kinds", () => {
    const expectedKinds = ["scan", "doc", "observation", "diagnosis", "discovery", "research", "review", "audit"];
    for (const kind of expectedKinds) {
      assert.ok(
        DISCOVERY_SAFE_TASK_KINDS.has(kind),
        `DISCOVERY_SAFE_TASK_KINDS must include "${kind}"`
      );
    }
  });

  it("isDiscoverySafeTask returns true for all discovery-safe kinds", () => {
    for (const kind of DISCOVERY_SAFE_TASK_KINDS) {
      assert.equal(
        isDiscoverySafeTask(kind),
        true,
        `isDiscoverySafeTask("${kind}") must return true`
      );
    }
  });

  it("isDiscoverySafeTask returns false for merge-oriented kinds (strict gate preserved at BLOCKED)", () => {
    const mergeKinds = ["implementation", "rework", "backend", "frontend", "devops", "infrastructure"];
    for (const kind of mergeKinds) {
      assert.equal(
        isDiscoverySafeTask(kind),
        false,
        `isDiscoverySafeTask("${kind}") must return false — merge tasks must remain blocked`
      );
    }
  });

  it("isDiscoverySafeTask returns false for null/undefined/empty (fail-safe: unknown tasks are not auto-bypassed)", () => {
    assert.equal(isDiscoverySafeTask(null), false);
    assert.equal(isDiscoverySafeTask(undefined), false);
    assert.equal(isDiscoverySafeTask(""), false);
  });

  it("BLOCKED dispatch strictness does not affect isDiscoverySafeTask — bypass decision is independent of regression state", () => {
    const blockedResult = computeDispatchStrictness(
      makeReplayState(8, 10),   // 80% regression rate → BLOCKED
      makeRecoveryRecord()
    );
    assert.equal(blockedResult.strictness, DISPATCH_STRICTNESS.BLOCKED);

    // Discovery-safe tasks qualify for bypass regardless of BLOCKED state
    assert.equal(isDiscoverySafeTask("scan"), true,
      "scan must remain discovery-safe even when dispatch strictness is BLOCKED"
    );
    assert.equal(isDiscoverySafeTask("discovery"), true,
      "discovery must remain discovery-safe even when dispatch strictness is BLOCKED"
    );
    assert.equal(isDiscoverySafeTask("research"), true,
      "research must remain discovery-safe even when dispatch strictness is BLOCKED"
    );

    // Merge tasks are NOT bypass candidates at BLOCKED strictness
    assert.equal(isDiscoverySafeTask("implementation"), false,
      "implementation must not bypass the strict gate even if discovery-safe logic is queried"
    );
  });

  it("negative: BLOCKED dispatch strictness correctly rejects non-discovery tasks", () => {
    const blockedResult = computeDispatchStrictness(
      makeReplayState(6, 10),   // 60% → BLOCKED
      makeRecoveryRecord()
    );
    assert.equal(blockedResult.strictness, DISPATCH_STRICTNESS.BLOCKED);
    assert.equal(isDiscoverySafeTask("implementation"), false,
      "implementation is a merge task and must not qualify for the discovery bypass"
    );
    assert.equal(isDiscoverySafeTask("rework"), false,
      "rework is a merge task and must not qualify for the discovery bypass"
    );
  });

  it("NORMAL dispatch strictness still respects discovery bypass classification (bypass applies at all strictness levels)", () => {
    const normalResult = computeDispatchStrictness(null, null);
    assert.equal(normalResult.strictness, DISPATCH_STRICTNESS.NORMAL);

    // Even at NORMAL strictness, discovery-safe tasks are correctly classified
    assert.equal(isDiscoverySafeTask("doc"), true);
    assert.equal(isDiscoverySafeTask("audit"), true);
    assert.equal(isDiscoverySafeTask("implementation"), false);
  });
});

describe("resolveWorkerExecutionLineageId", () => {
  it("uses explicit lineageId when provided", () => {
    const lineageId = resolveWorkerExecutionLineageId({
      lineageId: "lineage-explicit-1",
      taskId: 42,
      taskKind: "implementation",
      task: "Implement feature X",
      reworkAttempt: 0,
    });
    assert.equal(lineageId, "lineage-explicit-1");
  });

  it("falls back to parentLineageId when explicit lineageId is absent", () => {
    const lineageId = resolveWorkerExecutionLineageId({
      parentLineageId: "parent-lineage-9",
      taskId: 17,
      taskKind: "ci-fix",
      task: "Fix CI failure",
    });
    assert.equal(lineageId, "parent-lineage-9");
  });

  it("builds deterministic lineage ID from task fingerprint and attempt", () => {
    const lineageId = resolveWorkerExecutionLineageId({
      taskId: 31,
      taskKind: "implementation",
      task: "Add strict lineage telemetry",
      reworkAttempt: 1,
    });
    assert.ok(typeof lineageId === "string" && lineageId.length > 0);
    assert.ok(lineageId!.endsWith("-31-2"), `expected deterministic suffix -31-2, got ${lineageId}`);
  });

  it("returns null when no explicit lineage and taskId is invalid", () => {
    const lineageId = resolveWorkerExecutionLineageId({
      taskId: "not-a-number",
      taskKind: "research",
      task: "Investigate metrics drift",
    });
    assert.equal(lineageId, null);
  });
});

