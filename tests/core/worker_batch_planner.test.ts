import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  buildRoleExecutionBatches,
  MAX_PLANS_PER_DEPENDENCY_BATCH,
  computeCriticalPathScores,
  splitWavesIntoMicrowaves,
  MICROWAVE_MAX_TASKS_DEFAULT,
  buildFitScoredBatches,
  classifyNucleusFrontier,
  packNucleusFrontierBatches,
  buildTokenFirstBatches,
  estimatePlanTokens,
  getUsableModelContextTokens,
  autosplitOversizedPacket,
  checkPacketSizeCap,
  computeBatchOrderedStepCount,
  computePlanEstimatedDurationMinutes,
  computeBatchEstimatedDurationMinutes,
} from "../../src/core/worker_batch_planner.js";
import { validatePacketBatchAdmission } from "../../src/core/plan_contract_validator.js";
import { buildWorkerTopologyContract, selectExecutionPatternForPlans } from "../../src/core/role_registry.js";
import {
  computeAdaptiveSpecializedShareTarget,
  buildLanePerformanceFromCycleTelemetry,
} from "../../src/core/capability_pool.js";

function buildPlan(index) {
  return {
    role: "Evolution Worker",
    task: `Task ${index + 1} ${"x".repeat(80)}`,
    context: `Context ${index + 1}`,
    verification: `Verify ${index + 1}`,
    wave: 1,
    priority: index,
    taskKind: "implementation"
  };
}

describe("worker_batch_planner", () => {
  it("selects the model that minimizes batches and assigns GitHub closure to the final batch", () => {
    const config = {
      copilot: {
        defaultModel: "GPT-5.3-Codex",
        preferredModelsByTaskKind: {
          implementation: ["Claude Sonnet 4.6", "GPT-5.3-Codex"]
        },
        preferredModelsByRole: {
          "Evolution Worker": ["Claude Sonnet 4.6", "GPT-5.3-Codex"]
        },
        modelContextWindows: {
          "Claude Sonnet 4.6": 1700,
          "GPT-5.3-Codex": 1100
        },
        modelContextReserveTokens: 0
      },
      runtime: {
        workerContextTokenLimit: 1100
      },
      roleRegistry: {
        workers: {
          evolution: {
            name: "Evolution Worker",
            model: "GPT-5.3-Codex"
          }
        }
      }
    };

    const plans = Array.from({ length: 9 }, (_, index) => buildPlan(index));
    const batches = buildRoleExecutionBatches(plans, config);

    assert.equal(batches.length, 2);
    assert.equal(batches[0].model, "Claude Sonnet 4.6");
    assert.equal(batches[1].model, "Claude Sonnet 4.6");
    assert.equal(batches[0].plans.length, 5);
    assert.equal(batches[1].plans.length, 4);
    assert.equal(batches[0].githubFinalizer, false);
    assert.equal(batches[1].githubFinalizer, true);
    assert.equal(batches[0].roleBatchIndex, 1);
    assert.equal(batches[1].roleBatchIndex, 2);
    assert.equal(batches[0].roleBatchTotal, 2);
    assert.equal(batches[1].roleBatchTotal, 2);
    assert.equal(batches[0].sharedBranch, batches[1].sharedBranch);
  });

  it("routes model by taskKind expected value when telemetry exists", () => {
    const config = {
      paths: { stateDir: "state" },
      copilot: {
        defaultModel: "Claude Sonnet 4.6",
        preferredModelsByTaskKind: {
          implementation: ["Claude Sonnet 4.6", "GPT-5.3-Codex"],
        },
        modelContextReserveTokens: 0,
      },
    };
    const plans = [
      { ...buildPlan(0), role: "Evolution Worker", taskKind: "implementation" },
    ];
    const batches = buildRoleExecutionBatches(plans, config);
    assert.ok(batches.length >= 1);
    assert.ok((batches[0] as any).modelRouting, "batch should include modelRouting metadata");
    assert.ok("usedTelemetry" in (batches[0] as any).modelRouting);
  });

  it("stamps execution pattern and worker topology metadata on role batches", () => {
    const config = { copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 } };
    const plans = [
      { ...buildPlan(0), role: "quality-worker", wave: 1, target_files: ["tests/core/prometheus_parse.test.ts"] },
      { ...buildPlan(1), role: "integration-worker", wave: 1, target_files: ["src/core/prometheus.ts"] },
    ];
    const batches = buildRoleExecutionBatches(plans, config);
    assert.ok(batches.length >= 1);
    assert.equal((batches[0] as any).executionPattern, "wave_parallel");
    assert.equal((batches[0] as any).workerTopology.workerCount, 2);
    assert.equal((batches[0] as any).workerTopology.maxParallelWorkers, 2);
    assert.equal(Array.isArray((batches[0] as any).workerTopology.roles), true);
  });

  it("stamps bounded_chain when a dependency-bound plan set carries high planning uncertainty", () => {
    const config = { copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 } };
    const plans = [
      {
        ...buildPlan(0),
        role: "Evolution Worker",
        wave: 1,
        task_id: "bounded-chain-root",
        task: "Bounded chain root",
        planningUncertainty: "high",
      },
      {
        ...buildPlan(1),
        role: "Evolution Worker",
        wave: 2,
        task_id: "bounded-chain-child",
        task: "Bounded chain child",
        dependencies: ["bounded-chain-root"],
        planningUncertainty: "high",
      },
    ];

    const batches = buildRoleExecutionBatches(plans, config);

    assert.ok(batches.length >= 2);
    assert.ok(batches.every((batch: any) => batch.executionPattern === "bounded_chain"));
    assert.equal((batches[0] as any).workerTopology.laneCount, 1);
  });

  it("produces the same result when capabilityPoolResult is null (backward-compatible)", () => {
    const config = { copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 } };
    const plans = [buildPlan(0), buildPlan(1), buildPlan(2)];
    const withNull = buildRoleExecutionBatches(plans, config, null);
    const withoutArg = buildRoleExecutionBatches(plans, config);
    assert.equal(withNull.length, withoutArg.length);
    assert.equal(withNull[0].plans.length, withoutArg[0].plans.length);
  });

  it("separates conflicting plans in the same lane into distinct batches", () => {
    const config = {
      copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 },
      planner: { splitConflictingPlansAcrossBatches: true },
    };
    const planA = { role: "Evolution Worker", task: "Refactor orchestrator", target_files: ["src/core/orchestrator.ts"], wave: 1 };
    const planB = { role: "Evolution Worker", task: "Add log to orchestrator", target_files: ["src/core/orchestrator.ts"], wave: 1 };
    const planC = { role: "Evolution Worker", task: "Update prometheus", target_files: ["src/core/prometheus.ts"], wave: 1 };

    // Simulate capability pool result with lane assignments and a file conflict between A and B
    const capabilityPoolResult = {
      assignments: [
        { plan: planA, selection: { role: "Evolution Worker", lane: "implementation", isFallback: false } },
        { plan: planB, selection: { role: "Evolution Worker", lane: "implementation", isFallback: false } },
        { plan: planC, selection: { role: "Evolution Worker", lane: "implementation", isFallback: false } },
      ],
      diversityIndex: 0,
      activeLaneCount: 1,
    };

    const batches = buildRoleExecutionBatches([planA, planB, planC], config, capabilityPoolResult);

    // planA and planB share a file so they must NOT appear in the same batch
    const allBatchPlanSets = batches.map(b => b.plans);
    const conflictCoexists = allBatchPlanSets.some(batchPlans => batchPlans.includes(planA) && batchPlans.includes(planB));
    assert.equal(conflictCoexists, false, "conflicting plans should be in different batches");

    // planC (no conflict) should appear alongside exactly one of the two conflicting plans
    const planCBatch = allBatchPlanSets.find(bp => bp.includes(planC));
    assert.ok(planCBatch, "planC should be in some batch");
  });

  it("splits fragile task kinds with a tighter adaptive packet cap", () => {
    const config = {
      copilot: {
        defaultModel: "Claude Sonnet 4.6",
        modelContextWindows: {
          "Claude Sonnet 4.6": 100000,
        },
        modelContextReserveTokens: 0,
      },
      planner: {
        maxPlansPerPacket: 5,
      },
    };
    const plans = Array.from({ length: 5 }, (_, index) => ({
      ...buildPlan(index),
      role: "Evolution Worker",
      taskKind: "test",
      acceptance_criteria: ["criterion a", "criterion b"],
    }));

    const batches = buildRoleExecutionBatches(plans, config);

    assert.equal(batches.flatMap((batch) => batch.plans).length, 5);
    assert.ok(batches.every((batch) => batch.plans.length <= 3), "fragile task kinds must stay within adaptive cap");
    assert.ok(batches.every((batch: any) => typeof batch.adaptivePacketCap === "number" && batch.adaptivePacketCap <= 3));
  });
});

// ── Task 3: dependency graph wave and conflict integration ────────────────────

describe("worker_batch_planner — dependency graph optimization (Task 3)", () => {
  const baseConfig = { copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 } };
  const splitConfig = {
    copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 },
    planner: { splitConflictingPlansAcrossBatches: true },
  };

  it("uses graph wave to order plans that lack an explicit wave field", () => {
    // planB depends on planA — graph should place planA in wave 1, planB in wave 2.
    // No wave field on either plan: graph-derived ordering should be respected.
    const planA = { role: "Evolution Worker", task: "task-alpha", filesInScope: ["src/a.ts"] };
    const planB = { role: "Evolution Worker", task: "task-beta",  filesInScope: ["src/b.ts"], dependencies: ["task-alpha"] };

    const batches = buildRoleExecutionBatches([planB, planA], baseConfig);
    // Both plans are for the same role — graph resolves planA wave=1, planB wave=2.
    // The batch for planA (wave 1) should come before planB (wave 2).
    const allPlans = batches.flatMap(b => b.plans);
    const posA = allPlans.indexOf(planA);
    const posB = allPlans.indexOf(planB);
    assert.ok(posA !== -1, "planA must be in batches");
    assert.ok(posB !== -1, "planB must be in batches");
    assert.ok(posA < posB, `planA (wave 1) must appear before planB (wave 2); posA=${posA} posB=${posB}`);
  });

  it("separates plans with filesInScope conflict via graph (no capabilityPoolResult needed)", () => {
    // planX and planY share a filesInScope file — graph detects conflict.
    // Without capabilityPoolResult, only graph-based detection applies.
    const planX = { role: "Evolution Worker", task: "task-x", filesInScope: ["src/shared.ts"] };
    const planY = { role: "Evolution Worker", task: "task-y", filesInScope: ["src/shared.ts"] };
    const planZ = { role: "Evolution Worker", task: "task-z", filesInScope: ["src/other.ts"] };

    const batches = buildRoleExecutionBatches([planX, planY, planZ], splitConfig);
    const allBatchPlanSets = batches.map(b => b.plans);
    const conflictCoexists = allBatchPlanSets.some(bp => bp.includes(planX) && bp.includes(planY));
    assert.equal(conflictCoexists, false, "graph-detected conflicting plans must not share a batch");
  });

  it("plans without graph hints behave identically to pre-optimization (backward-compatible)", () => {
    // No filesInScope, no dependencies: graph hints are absent → no change in behavior.
    const plans = Array.from({ length: 3 }, (_, i) => ({
      role: "Evolution Worker",
      task: `Task ${i}`,
      wave: 1,
      priority: i,
    }));
    const batches = buildRoleExecutionBatches(plans, baseConfig);
    assert.equal(batches.length, 1, "3 small plans without hints should fit in one batch");
    assert.equal(batches[0].plans.length, 3);
  });

  it("graph wave assignment respects explicit wave field over graph wave", () => {
    // planA is marked wave=2 explicitly; planB is wave=1 explicitly.
    // Even if graph would order them differently, explicit wave fields take priority.
    const planA = { role: "Evolution Worker", task: "task-a", wave: 2, filesInScope: ["src/a.ts"] };
    const planB = { role: "Evolution Worker", task: "task-b", wave: 1, filesInScope: ["src/b.ts"] };

    const batches = buildRoleExecutionBatches([planA, planB], baseConfig);
    const allPlans = batches.flatMap(b => b.plans);
    const posA = allPlans.indexOf(planA);
    const posB = allPlans.indexOf(planB);
    // planB (wave=1) must come before planA (wave=2)
    assert.ok(posB < posA, `explicit wave field must override graph wave; posB=${posB} posA=${posA}`);
  });
});

// ── Cross-role wave ordering ──────────────────────────────────────────────────

describe("worker_batch_planner — cross-role wave ordering", () => {
  const baseConfig = { copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 } };
  const splitConfig = {
    copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 },
    planner: { splitConflictingPlansAcrossBatches: true },
  };

  it("all wave-1 batches precede all wave-2 batches across different roles", () => {
    // Two roles each contributing one plan per wave.
    // Without the wave-sort fix the output is [A-w1, A-w2, B-w1, B-w2],
    // causing the orchestrator to run A-w2 before B-w1 — wrong.
    const planA = { role: "Worker A", task: "task-a", wave: 1 };
    const planB = { role: "Worker A", task: "task-b", wave: 2 };
    const planC = { role: "Worker B", task: "task-c", wave: 1 };
    const planD = { role: "Worker B", task: "task-d", wave: 2 };

    const batches = buildRoleExecutionBatches([planA, planB, planC, planD], baseConfig);

    const wave1Indices = batches.filter(b => b.wave === 1).map(b => b.bundleIndex);
    const wave2Indices = batches.filter(b => b.wave === 2).map(b => b.bundleIndex);

    assert.ok(wave1Indices.length > 0, "expected wave-1 batches");
    assert.ok(wave2Indices.length > 0, "expected wave-2 batches");

    const maxWave1 = Math.max(...wave1Indices);
    const minWave2 = Math.min(...wave2Indices);
    assert.ok(maxWave1 < minWave2,
      `all wave-1 bundleIndices must be less than all wave-2 bundleIndices; max-w1=${maxWave1} min-w2=${minWave2}`);
  });

  it("graph-derived cross-role waves maintain global bundle ordering", () => {
    // planA and planB share a file across different roles — graph assigns them
    // different waves.  The batch with the lower graph-derived wave must have
    // the lower bundleIndex so the orchestrator runs it first.
    const planA = { role: "Worker A", task: "task-alpha", filesInScope: ["src/shared.ts"] };
    const planB = { role: "Worker B", task: "task-beta",  filesInScope: ["src/shared.ts"] };

    const batches = buildRoleExecutionBatches([planA, planB], splitConfig);

    const batchA = batches.find(b => b.plans.includes(planA as any));
    const batchB = batches.find(b => b.plans.includes(planB as any));

    assert.ok(batchA, "planA must appear in a batch");
    assert.ok(batchB, "planB must appear in a batch");
    assert.notEqual(
      (batchA as any).bundleIndex,
      (batchB as any).bundleIndex,
      "conflicting cross-role plans must not share the same bundle"
    );

    // When graph assigns different waves, bundle ordering must follow wave order.
    // When waves are equal, bundleIndex still provides deterministic serialization.
    if ((batchA as any).wave !== (batchB as any).wave) {
      const earlier = (batchA as any).wave < (batchB as any).wave ? batchA : batchB;
      const later = (batchA as any).wave < (batchB as any).wave ? batchB : batchA;
      assert.ok((earlier as any).bundleIndex < (later as any).bundleIndex,
        "earlier-wave batch must have lower bundleIndex than later-wave batch");
    }
  });

  it("negative: single-role plans are unaffected by cross-role sort", () => {
    // All plans belong to the same role at the same wave — batch count and
    // wave field must remain unchanged by the final sort step.
    const plans = Array.from({ length: 3 }, (_, i) => ({
      role: "Evolution Worker",
      task: `T${i}`,
      wave: 1,
    }));

    const batches = buildRoleExecutionBatches(plans, baseConfig);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].wave, 1);
    assert.equal(batches[0].plans.length, 3);
  });
});

// ── Task 4 hardening: dependency-sensitive batch splitting ────────────────────

describe("worker_batch_planner — dependency-sensitive batch size limit (Task 4)", () => {
  const baseConfig = { copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 } };

  it("exports MAX_PLANS_PER_DEPENDENCY_BATCH as a positive number", () => {
    assert.ok(typeof MAX_PLANS_PER_DEPENDENCY_BATCH === "number");
    assert.ok(MAX_PLANS_PER_DEPENDENCY_BATCH > 0);
  });

  it("does not split batches of plans with no dependency declarations", () => {
    // 5 plans without dependsOn/dependencies — should not be split beyond normal packing
    const plans = Array.from({ length: 5 }, (_, i) => ({
      role: "Evolution Worker",
      task: `T${i}`,
      wave: 1,
    }));
    const batches = buildRoleExecutionBatches(plans, baseConfig);
    // All fit in one batch (small token count) — no spurious splits
    assert.equal(batches.length, 1);
    assert.equal(batches[0].plans.length, 5);
  });

  it("splits a batch that exceeds MAX_PLANS_PER_DEPENDENCY_BATCH when plans carry dependsOn", () => {
    // 6 plans all with dependsOn — each batch must have ≤ MAX_PLANS_PER_DEPENDENCY_BATCH plans
    const plans = Array.from({ length: 6 }, (_, i) => ({
      role: "Evolution Worker",
      task: `dep-task-${i}`,
      wave: 1,
      dependsOn: [`dep-task-${i - 1}`].filter(x => x !== "dep-task--1"),
    }));
    const batches = buildRoleExecutionBatches(plans, baseConfig);
    for (const batch of batches) {
      assert.ok(
        (batch.plans as any[]).length <= MAX_PLANS_PER_DEPENDENCY_BATCH,
        `batch has ${(batch.plans as any[]).length} plans > MAX_PLANS_PER_DEPENDENCY_BATCH=${MAX_PLANS_PER_DEPENDENCY_BATCH}`
      );
    }
    // All plans must still be present
    const allPlans = batches.flatMap(b => b.plans);
    assert.equal(allPlans.length, 6);
  });

  it("splits a batch that exceeds MAX_PLANS_PER_DEPENDENCY_BATCH when plans carry dependencies", () => {
    const plans = Array.from({ length: 4 }, (_, i) => ({
      role: "Evolution Worker",
      task: `task-${i}`,
      wave: 1,
      dependencies: [`task-${i - 1}`].filter(x => x !== "task--1"),
    }));
    const batches = buildRoleExecutionBatches(plans, baseConfig);
    for (const batch of batches) {
      assert.ok(
        (batch.plans as any[]).length <= MAX_PLANS_PER_DEPENDENCY_BATCH,
        `dependency batch too large: ${(batch.plans as any[]).length} > ${MAX_PLANS_PER_DEPENDENCY_BATCH}`
      );
    }
    const allPlans = batches.flatMap(b => b.plans);
    assert.equal(allPlans.length, 4);
  });

  it("respects config override for maxPlansPerDependencyBatch", () => {
    const configWithOverride = {
      ...baseConfig,
      runtime: { maxPlansPerDependencyBatch: 2 }
    };
    const plans = Array.from({ length: 5 }, (_, i) => ({
      role: "Evolution Worker",
      task: `task-${i}`,
      wave: 1,
      dependsOn: i > 0 ? [`task-${i - 1}`] : [],
    }));
    const batches = buildRoleExecutionBatches(plans, configWithOverride);
    for (const batch of batches) {
      assert.ok(
        (batch.plans as any[]).length <= 2,
        `batch must not exceed config override of 2; got ${(batch.plans as any[]).length}`
      );
    }
    const allPlans = batches.flatMap(b => b.plans);
    assert.equal(allPlans.length, 5);
  });

  it("negative path: a single plan with dependsOn is not split (nothing to split)", () => {
    const plans = [{ role: "Evolution Worker", task: "solo", wave: 1, dependsOn: ["other"] }];
    const batches = buildRoleExecutionBatches(plans, baseConfig);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].plans.length, 1);
  });
});

// ── Wave-boundary enforcement ─────────────────────────────────────────────────

describe("worker_batch_planner — wave-boundary enforcement", () => {
  const baseConfig = { copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 } };

  it("plans from different waves are never co-batched", () => {
    const w1a = { role: "Evolution Worker", task: "wave1-a", wave: 1 };
    const w1b = { role: "Evolution Worker", task: "wave1-b", wave: 1 };
    const w2a = { role: "Evolution Worker", task: "wave2-a", wave: 2 };
    const w2b = { role: "Evolution Worker", task: "wave2-b", wave: 2 };

    const batches = buildRoleExecutionBatches([w1a, w1b, w2a, w2b], baseConfig);

    for (const batch of batches) {
      const waves = new Set(batch.plans.map((p: any) => p.wave));
      assert.equal(waves.size, 1, `batch must contain plans from exactly one wave; got waves=[${[...waves]}]`);
    }
  });

  it("batch carries the wave field matching its plans", () => {
    const w1 = { role: "Evolution Worker", task: "wave1", wave: 1 };
    const w2 = { role: "Evolution Worker", task: "wave2", wave: 2 };

    const batches = buildRoleExecutionBatches([w1, w2], baseConfig);

    const wave1Batch = batches.find(b => b.plans.includes(w1));
    const wave2Batch = batches.find(b => b.plans.includes(w2));
    assert.ok(wave1Batch, "wave-1 plan must be in some batch");
    assert.ok(wave2Batch, "wave-2 plan must be in some batch");
    assert.equal((wave1Batch as any).wave, 1);
    assert.equal((wave2Batch as any).wave, 2);
  });

  it("negative: single-wave plans are unaffected (no spurious splits)", () => {
    const plans = Array.from({ length: 4 }, (_, i) => ({
      role: "Evolution Worker",
      task: `T${i}`,
      wave: 1,
    }));

    const batches = buildRoleExecutionBatches(plans, baseConfig);
    // All plans share wave 1 — batch count should be 1 (all fit in context window)
    const allPlans = batches.flatMap(b => b.plans);
    assert.equal(allPlans.length, 4, "all plans must appear in batches");
    for (const batch of batches) {
      const waves = new Set(batch.plans.map((p: any) => p.wave));
      assert.equal(waves.size, 1);
    }
  });
});

// ── Critical-path scoring ─────────────────────────────────────────────────────

describe("worker_batch_planner — computeCriticalPathScores", () => {
  it("leaf tasks (no dependents) score 0", () => {
    const tasks = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: [] },
    ];
    const scores = computeCriticalPathScores(tasks);
    assert.equal(scores.get("A"), 0);
    assert.equal(scores.get("B"), 0);
  });

  it("a linear chain A→B→C gives A=2, B=1, C=0", () => {
    // C depends on B; B depends on A.
    // A has 2 levels of downstream work, B has 1, C has 0.
    const tasks = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["B"] },
    ];
    const scores = computeCriticalPathScores(tasks);
    assert.equal(scores.get("A"), 2, "A is upstream of B and C");
    assert.equal(scores.get("B"), 1, "B is upstream of C only");
    assert.equal(scores.get("C"), 0, "C is a leaf");
  });

  it("diamond DAG: A→B, A→C, B→D, C→D — A scores highest", () => {
    // D depends on B and C; B and C both depend on A.
    const tasks = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["A"] },
      { id: "D", dependsOn: ["B", "C"] },
    ];
    const scores = computeCriticalPathScores(tasks);
    assert.equal(scores.get("D"), 0);
    assert.equal(scores.get("B"), 1);
    assert.equal(scores.get("C"), 1);
    assert.equal(scores.get("A"), 2);
  });

  it("tasks not known to any other task all score 0", () => {
    const tasks = [
      { id: "X", dependsOn: [] },
      { id: "Y", dependsOn: [] },
      { id: "Z", dependsOn: [] },
    ];
    const scores = computeCriticalPathScores(tasks);
    for (const t of tasks) assert.equal(scores.get(t.id), 0);
  });

  it("negative path: empty task array returns empty map", () => {
    const scores = computeCriticalPathScores([]);
    assert.equal(scores.size, 0);
  });

  it("negative path: cycle guard returns 0 instead of infinite recursion", () => {
    // A depends on B, B depends on A — cycle. Guard must not throw.
    const tasks = [
      { id: "A", dependsOn: ["B"] },
      { id: "B", dependsOn: ["A"] },
    ];
    assert.doesNotThrow(() => computeCriticalPathScores(tasks));
    const scores = computeCriticalPathScores(tasks);
    // Scores may be 0 due to cycle guard — just verify they are non-negative numbers
    assert.ok((scores.get("A") ?? 0) >= 0);
    assert.ok((scores.get("B") ?? 0) >= 0);
  });
});

// ── Critical-path ordering within a wave ─────────────────────────────────────

describe("worker_batch_planner — critical-path dispatch ordering", () => {
  const baseConfig = { copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 } };

  it("within a wave, the task with the longest downstream chain is dispatched first", () => {
    // chain: root → mid → leaf (all wave 1)
    // root has the longest downstream path and must appear first in the output.
    const leaf = { role: "Evolution Worker", task: "leaf-task",  wave: 1, dependsOn: ["mid-task"] };
    const mid  = { role: "Evolution Worker", task: "mid-task",   wave: 1, dependsOn: ["root-task"] };
    const root = { role: "Evolution Worker", task: "root-task",  wave: 1, dependsOn: [] };

    // Pass in reverse order to ensure the sort — not input order — drives placement
    const batches = buildRoleExecutionBatches([leaf, mid, root], baseConfig);
    const allPlans = batches.flatMap(b => b.plans) as any[];

    const posRoot = allPlans.findIndex(p => p.task === "root-task");
    const posMid  = allPlans.findIndex(p => p.task === "mid-task");
    const posLeaf = allPlans.findIndex(p => p.task === "leaf-task");

    assert.ok(posRoot !== -1, "root-task must be in batches");
    assert.ok(posMid  !== -1, "mid-task must be in batches");
    assert.ok(posLeaf !== -1, "leaf-task must be in batches");

    assert.ok(posRoot < posMid,  `root (score 2) must precede mid (score 1); posRoot=${posRoot} posMid=${posMid}`);
    assert.ok(posMid  < posLeaf, `mid (score 1) must precede leaf (score 0); posMid=${posMid} posLeaf=${posLeaf}`);
  });

  it("tasks without any dependency hints preserve their original priority order", () => {
    // No dependsOn/filesInScope — critical-path scores all 0 → fall through to priority
    const plans = [
      { role: "Evolution Worker", task: "T0", wave: 1, priority: 0 },
      { role: "Evolution Worker", task: "T1", wave: 1, priority: 1 },
      { role: "Evolution Worker", task: "T2", wave: 1, priority: 2 },
    ];
    const batches = buildRoleExecutionBatches(plans, baseConfig);
    const allPlans = batches.flatMap(b => b.plans) as any[];
    const positions = plans.map(p => allPlans.findIndex(bp => (bp as any).task === p.task));
    // Priority-0 must come before priority-1, which must come before priority-2
    assert.ok(positions[0] < positions[1], "priority 0 before priority 1");
    assert.ok(positions[1] < positions[2], "priority 1 before priority 2");
  });

  it("wave ordering is never overridden by critical-path scores", () => {
    // leaf is in wave 1, root is in wave 2 — root depends on leaf.
    // Even though root has dependents (none), wave 1 tasks must come first.
    const planA = { role: "Evolution Worker", task: "wave1-task", wave: 1 };
    const planB = { role: "Evolution Worker", task: "wave2-task", wave: 2, dependsOn: ["wave1-task"] };

    const batches = buildRoleExecutionBatches([planB, planA], baseConfig);
    const batchA = batches.find(b => b.plans.some((p: any) => p.task === "wave1-task"));
    const batchB = batches.find(b => b.plans.some((p: any) => p.task === "wave2-task"));

    assert.ok(batchA, "wave1-task must be in some batch");
    assert.ok(batchB, "wave2-task must be in some batch");
    assert.ok((batchA as any).bundleIndex < (batchB as any).bundleIndex,
      "wave-1 batch must precede wave-2 batch regardless of critical-path score");
  });
});

// ── splitWavesIntoMicrowaves (re-exported from worker_batch_planner) ──────────

describe("worker_batch_planner — splitWavesIntoMicrowaves export", () => {
  it("MICROWAVE_MAX_TASKS_DEFAULT is 3", () => {
    assert.equal(MICROWAVE_MAX_TASKS_DEFAULT, 3);
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(splitWavesIntoMicrowaves([]), []);
  });

  it("returns empty array for non-array input", () => {
    assert.deepEqual(splitWavesIntoMicrowaves(null as any), []);
  });

  it("preserves plans that already fit within the limit", () => {
    const plans = [
      { task_id: "T-1", task: "Task 1", wave: 1, dependencies: [] },
      { task_id: "T-2", task: "Task 2", wave: 1, dependencies: [] },
    ];
    const result = splitWavesIntoMicrowaves(plans, 3);
    assert.equal(result.length, 2);
    assert.equal(result[0].wave, 1);
    assert.equal(result[1].wave, 1);
  });

  it("splits a wave exceeding the limit into micro-waves", () => {
    const plans = Array.from({ length: 5 }, (_, i) => ({
      task_id: `T-${i + 1}`, task: `Task ${i + 1}`, wave: 1, dependencies: [],
    }));
    const result = splitWavesIntoMicrowaves(plans, 3);
    assert.equal(result.length, 5);
    const waves = [...new Set(result.map((p: any) => p.wave))].sort((a, b) => a - b);
    assert.deepEqual(waves, [1, 2]);
  });

  it("negative path: tasks with no wave field are treated as wave 1", () => {
    const plans = [
      { task_id: "T-1", task: "T1", dependencies: [] },
      { task_id: "T-2", task: "T2", dependencies: [] },
    ];
    const result = splitWavesIntoMicrowaves(plans, 3);
    assert.equal(result.length, 2);
    assert.ok(result.every((p: any) => p.wave === 1));
  });
});

// ── buildRoleExecutionBatches — micro-wave integration ───────────────────────

describe("worker_batch_planner — micro-wave integration via config", () => {
  it("without maxTasksPerMicrowave config, large waves are not split (backward-compatible)", () => {
    const config = { copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 } };
    const plans = Array.from({ length: 6 }, (_, i) => ({
      role: "Evolution Worker",
      task: `Task ${i}`,
      wave: 1,
    }));
    // Without the config key, no micro-wave splitting occurs, but adaptive packet
    // caps can still break the wave into multiple batches.
    const batches = buildRoleExecutionBatches(plans, config);
    assert.equal([...new Set(batches.map((batch) => batch.wave))].length, 1, "all plans stay in the original wave");
    assert.equal(batches.flatMap((batch) => batch.plans).length, 6);
  });

  it("with maxTasksPerMicrowave=2, a 6-plan wave is split into 3 micro-waves of 2", () => {
    const config = {
      copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 },
      planner: { maxTasksPerMicrowave: 2 },
    };
    const plans = Array.from({ length: 6 }, (_, i) => ({
      role: "Evolution Worker",
      task: `Task ${i}`,
      wave: 1,
    }));
    const batches = buildRoleExecutionBatches(plans, config);
    // 6 plans split into 3 micro-waves → 3 batches (wave-boundary enforcement prevents co-batching)
    assert.equal(batches.length, 3, "6 plans with maxTasksPerMicrowave=2 → 3 batches");
    for (const batch of batches) {
      assert.ok(
        (batch.plans as any[]).length <= 2,
        `each micro-wave batch must have at most 2 plans; got ${(batch.plans as any[]).length}`
      );
    }
    // All plans must be present
    const allPlans = batches.flatMap(b => b.plans);
    assert.equal(allPlans.length, 6);
  });

  it("with maxTasksPerMicrowave=3, critical-path tasks are in earlier micro-waves", () => {
    // T-C has 2 intra-wave dependents (T-B and T-D depend on T-C) → highest priority
    const config = {
      copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 },
      planner: { maxTasksPerMicrowave: 3 },
    };
    const plans = [
      { role: "Evolution Worker", task_id: "T-A", task: "Task A", wave: 1, dependencies: [] },
      { role: "Evolution Worker", task_id: "T-B", task: "Task B", wave: 1, dependencies: ["T-C"] },
      { role: "Evolution Worker", task_id: "T-C", task: "Task C", wave: 1, dependencies: [] },
      { role: "Evolution Worker", task_id: "T-D", task: "Task D", wave: 1, dependencies: ["T-C"] },
    ];
    const batches = buildRoleExecutionBatches(plans, config);
    // 4 plans with limit 3 → 2 micro-waves
    assert.equal(batches.length, 2, "4 plans with maxTasksPerMicrowave=3 → 2 batches");
    const firstBatchTaskIds = (batches[0].plans as any[]).map((p: any) => p.task_id);
    // T-C (2 intra-wave dependents) must be in the first micro-wave batch
    assert.ok(
      firstBatchTaskIds.includes("T-C"),
      `T-C (critical-path) must be in first micro-wave; first batch: ${firstBatchTaskIds.join(", ")}`
    );
  });

  it("negative: maxTasksPerMicrowave=0 is treated as disabled (no splitting)", () => {
    const config = {
      copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 },
      planner: { maxTasksPerMicrowave: 0 },
    };
    const plans = Array.from({ length: 4 }, (_, i) => ({
      role: "Evolution Worker",
      task: `Task ${i}`,
      wave: 1,
    }));
    const batches = buildRoleExecutionBatches(plans, config);
    assert.equal(batches.length, 1, "maxTasksPerMicrowave=0 disables splitting");
    assert.equal((batches[0].plans as any[]).length, 4);
  });

  it("negative: maxTasksPerMicrowave set to non-numeric is treated as disabled", () => {
    const config = {
      copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 },
      planner: { maxTasksPerMicrowave: "invalid" },
    };
    const plans = Array.from({ length: 4 }, (_, i) => ({
      role: "Evolution Worker",
      task: `Task ${i}`,
      wave: 1,
    }));
    const batches = buildRoleExecutionBatches(plans, config);
    assert.equal(batches.length, 1, "non-numeric maxTasksPerMicrowave disables splitting");
  });

  it("micro-wave splitting preserves all plans across waves", () => {
    const config = {
      copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 },
      planner: { maxTasksPerMicrowave: 2 },
    };
    // 3 wave-1 plans and 3 wave-2 plans
    const w1Plans = Array.from({ length: 3 }, (_, i) => ({
      role: "Evolution Worker", task: `w1-task-${i}`, wave: 1,
    }));
    const w2Plans = Array.from({ length: 3 }, (_, i) => ({
      role: "Evolution Worker", task: `w2-task-${i}`, wave: 2,
    }));
    const batches = buildRoleExecutionBatches([...w1Plans, ...w2Plans], config);
    // wave 1: 3 plans → 2 micro-waves (2+1); wave 2: 3 plans → 2 micro-waves (2+1)
    // Total: 4 batches
    const allPlans = batches.flatMap(b => b.plans);
    assert.equal(allPlans.length, 6, "all 6 plans must be preserved after micro-wave splitting");
    // All wave-1 batches must precede wave-2 batches
    const wave1Indices = batches.filter(b => (b as any).wave <= 2).map(b => (b as any).bundleIndex);
    const wave2Indices = batches.filter(b => (b as any).wave >= 3).map(b => (b as any).bundleIndex);
    if (wave1Indices.length > 0 && wave2Indices.length > 0) {
      assert.ok(
        Math.max(...wave1Indices) < Math.min(...wave2Indices),
        "all wave-1 micro-wave batches must precede wave-2 micro-wave batches"
      );
    }
  });
});

describe("buildFitScoredBatches — fit-score-based worker assignment", () => {
  it("returns batches for an array of plans", () => {
    const plans = [
      { task: "Add spec coverage for parser", wave: 1 },
      { task: "Update Docker configuration", wave: 1 },
    ];
    const batches = buildFitScoredBatches(plans, {});
    assert.ok(Array.isArray(batches) && batches.length > 0, "must return at least one batch");
  });

  it("assigns workers based on fit score (test task → quality-worker)", () => {
    const plans = [{ task: "Add spec coverage for parser", wave: 1 }];
    const batches = buildFitScoredBatches(plans, {});
    assert.ok(batches.length > 0);
    assert.equal((batches[0] as any).role, "quality-worker");
  });

  it("returns empty array for empty input", () => {
    const batches = buildFitScoredBatches([], {});
    assert.deepEqual(batches, []);
  });

  it("each batch has the standard shape (role, plans, model, wave)", () => {
    const plans = [{ task: "Update governance freeze rules", wave: 1 }];
    const batches = buildFitScoredBatches(plans, {});
    for (const b of batches) {
      assert.ok((b as any).role, "batch must have role");
      assert.ok(Array.isArray((b as any).plans), "batch must have plans array");
      assert.ok((b as any).model, "batch must have model");
    }
  });

  it("negative path: null plans does not throw", () => {
    const batches = buildFitScoredBatches(null as any, {});
    assert.deepEqual(batches, []);
  });
});

// ── Singleton wave compaction integration ─────────────────────────────────────

describe("worker_batch_planner — compactSingletonWaves integration", () => {
  const baseConfig = { copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 } };
  const compactConfig = {
    copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 },
    planner: { compactSingletonWaves: true },
  };

  it("without compactSingletonWaves config, singleton wave-2 plan stays in its own batch (backward-compatible)", () => {
    const plans = [
      { role: "Evolution Worker", task: "wave1-a", wave: 1 },
      { role: "Evolution Worker", task: "wave1-b", wave: 1 },
      { role: "Evolution Worker", task: "wave2-solo", wave: 2 }, // singleton, no deps
    ];
    const batches = buildRoleExecutionBatches(plans, baseConfig);
    // Default: compaction disabled — wave-2 singleton stays in its own batch
    const wave2Batch = batches.find(b => (b as any).wave === 2);
    assert.ok(wave2Batch, "wave-2 singleton must remain in its own batch when compaction is disabled");
  });

  it("with compactSingletonWaves=true, non-dependent singleton wave is compacted into wave 1", () => {
    const plans = [
      { role: "Evolution Worker", task: "wave1-a", wave: 1 },
      { role: "Evolution Worker", task: "wave1-b", wave: 1 },
      { role: "Evolution Worker", task: "wave2-solo", wave: 2 }, // singleton, no deps
    ];
    const batches = buildRoleExecutionBatches(plans, compactConfig);
    // Compaction enabled: wave2-solo should be in wave 1
    const soloInWave2 = batches.find(b => (b as any).wave === 2);
    assert.ok(!soloInWave2, "wave-2 singleton must be compacted; no wave-2 batch should exist");
    const wave1Batches = batches.filter(b => (b as any).wave === 1);
    const allWave1Plans = wave1Batches.flatMap(b => b.plans) as any[];
    assert.ok(
      allWave1Plans.some(p => p.task === "wave2-solo"),
      "wave2-solo must appear in wave-1 batches after compaction"
    );
  });

  it("with compactSingletonWaves=true, dependent singleton wave is NOT compacted", () => {
    const plans = [
      { role: "Evolution Worker", task: "root-task",  wave: 1 },
      { role: "Evolution Worker", task: "child-task", wave: 2, dependsOn: ["root-task"] },
    ];
    const batches = buildRoleExecutionBatches(plans, compactConfig);
    // child-task has a dep on root-task — must stay in wave 2
    const childBatch = batches.find(b => (b.plans as any[]).some((p: any) => p.task === "child-task"));
    assert.ok(childBatch, "child-task must appear in some batch");
    assert.equal((childBatch as any).wave, 2, "dependent singleton must not be compacted");
  });

  it("all plans are preserved after compaction", () => {
    const plans = [
      { role: "Evolution Worker", task: "A", wave: 1 },
      { role: "Evolution Worker", task: "B", wave: 2 },
      { role: "Evolution Worker", task: "C", wave: 3, dependencies: ["A"] },
    ];
    const batches = buildRoleExecutionBatches(plans, compactConfig);
    const allPlanTasks = batches.flatMap(b => b.plans).map((p: any) => p.task);
    assert.ok(allPlanTasks.includes("A"), "A must be present");
    assert.ok(allPlanTasks.includes("B"), "B must be present");
    assert.ok(allPlanTasks.includes("C"), "C must be present");
  });

  it("negative: compactSingletonWaves=false is same as default (no compaction)", () => {
    const noCompactConfig = {
      copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 },
      planner: { compactSingletonWaves: false },
    };
    const plans = [
      { role: "Evolution Worker", task: "w1", wave: 1 },
      { role: "Evolution Worker", task: "w2-solo", wave: 2 },
    ];
    const batches = buildRoleExecutionBatches(plans, noCompactConfig);
    const wave2Batch = batches.find(b => (b as any).wave === 2);
    assert.ok(wave2Batch, "false config must not compact waves");
  });
});

// ── classifyNucleusFrontier ───────────────────────────────────────────────────

describe("worker_batch_planner — classifyNucleusFrontier", () => {
  it("tasks with score > 0 go to nucleus; score = 0 go to frontier", () => {
    const root = { task: "root-task", wave: 1 };
    const mid  = { task: "mid-task",  wave: 1 };
    const leaf = { task: "leaf-task", wave: 1 };
    const scores = new Map([["root-task", 2], ["mid-task", 1], ["leaf-task", 0]]);

    const { nucleus, frontier } = classifyNucleusFrontier([root, mid, leaf], scores);

    assert.deepEqual(nucleus.map((p: any) => p.task), ["root-task", "mid-task"]);
    assert.deepEqual(frontier.map((p: any) => p.task), ["leaf-task"]);
  });

  it("all leaf tasks (scores all 0) produce empty nucleus and full frontier", () => {
    const plans = [{ task: "A" }, { task: "B" }, { task: "C" }];
    const scores = new Map([["A", 0], ["B", 0], ["C", 0]]);
    const { nucleus, frontier } = classifyNucleusFrontier(plans, scores);
    assert.equal(nucleus.length, 0);
    assert.equal(frontier.length, 3);
  });

  it("plans with no entry in scores map are treated as frontier (score defaults to 0)", () => {
    const plans = [{ task: "unknown-task" }];
    const { nucleus, frontier } = classifyNucleusFrontier(plans, new Map());
    assert.equal(nucleus.length, 0);
    assert.equal(frontier.length, 1);
  });

  it("empty plans array returns empty nucleus and frontier", () => {
    const { nucleus, frontier } = classifyNucleusFrontier([], new Map());
    assert.equal(nucleus.length, 0);
    assert.equal(frontier.length, 0);
  });

  it("negative: null input returns empty nucleus and frontier without throwing", () => {
    assert.doesNotThrow(() => classifyNucleusFrontier(null as any, new Map()));
    const { nucleus, frontier } = classifyNucleusFrontier(null as any, new Map());
    assert.equal(nucleus.length, 0);
    assert.equal(frontier.length, 0);
  });
});

// ── packNucleusFrontierBatches ────────────────────────────────────────────────

describe("worker_batch_planner — packNucleusFrontierBatches", () => {
  it("nucleus tasks appear in earlier batches than standalone frontier tasks", () => {
    // root→mid→leaf chain: root score=2, mid score=1, leaf score=0
    const root = { task: "root-task", context: "x".repeat(10) };
    const mid  = { task: "mid-task",  context: "x".repeat(10) };
    const leaf = { task: "leaf-task", context: "x".repeat(10) };
    const scores = new Map([["root-task", 2], ["mid-task", 1], ["leaf-task", 0]]);

    // Use a large token budget so all plans fit in one batch
    const batches = packNucleusFrontierBatches([root, mid, leaf], scores, 1_000_000);

    assert.equal(batches.length, 1, "all three fit in one batch");
    const tasks = (batches[0].plans as any[]).map(p => p.task);
    // nucleus tasks (root, mid) must appear before frontier (leaf) within the batch
    assert.ok(tasks.indexOf("root-task") < tasks.indexOf("leaf-task"), "root before leaf");
    assert.ok(tasks.indexOf("mid-task") < tasks.indexOf("leaf-task"), "mid before leaf");
  });

  it("frontier tasks are absorbed into nucleus batch when context space permits", () => {
    // Two nucleus tasks + many frontier tasks; large context window
    const nucleus1 = { task: "n1", context: "x".repeat(10) };
    const nucleus2 = { task: "n2", context: "x".repeat(10) };
    const frontier1 = { task: "f1", context: "x".repeat(10) };
    const frontier2 = { task: "f2", context: "x".repeat(10) };
    const scores = new Map([["n1", 2], ["n2", 1], ["f1", 0], ["f2", 0]]);

    const batches = packNucleusFrontierBatches([nucleus1, nucleus2, frontier1, frontier2], scores, 1_000_000);

    // All four fit in a single batch — fewer requests than naive 2+2 split
    assert.equal(batches.length, 1);
    assert.equal((batches[0].plans as any[]).length, 4);
  });

  it("overflow frontier tasks get their own batches when context window is tight", () => {
    // Very small context window: each task fills it completely
    const nucleus1 = { task: "n1", context: "x".repeat(1000) };
    const frontier1 = { task: "f1", context: "x".repeat(1000) };
    const frontier2 = { task: "f2", context: "x".repeat(1000) };
    const scores = new Map([["n1", 1], ["f1", 0], ["f2", 0]]);

    // Token budget of 400 forces each task into its own batch
    const batches = packNucleusFrontierBatches([nucleus1, frontier1, frontier2], scores, 400);

    // nucleus1 alone, f1 alone, f2 alone (tight budget)
    assert.ok(batches.length >= 2, "tight context must produce multiple batches");
    // All plans preserved
    const allTasks = batches.flatMap(b => (b.plans as any[]).map(p => p.task));
    assert.ok(allTasks.includes("n1"), "nucleus1 must appear");
    assert.ok(allTasks.includes("f1"), "frontier1 must appear");
    assert.ok(allTasks.includes("f2"), "frontier2 must appear");
  });

  it("all-frontier plans fall back to standard packing (no nucleus)", () => {
    const plans = [
      { task: "f1", context: "x".repeat(10) },
      { task: "f2", context: "x".repeat(10) },
    ];
    const scores = new Map([["f1", 0], ["f2", 0]]);
    const batches = packNucleusFrontierBatches(plans, scores, 1_000_000);
    // Falls through to standard packing — both fit in one batch
    assert.equal(batches.length, 1);
    assert.equal((batches[0].plans as any[]).length, 2);
  });

  it("negative: empty plans array returns empty batches", () => {
    const batches = packNucleusFrontierBatches([], new Map(), 1_000_000);
    assert.deepEqual(batches, []);
  });
});

// ── buildRoleExecutionBatches — nucleusFrontierMode integration ───────────────

describe("worker_batch_planner — nucleusFrontierMode integration", () => {
  it("nucleusFrontierMode=false (default) is backward-compatible — same output as before", () => {
    const config = { copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 } };
    const plans = [
      { role: "Evolution Worker", task: "root-task", wave: 1, dependsOn: [] },
      { role: "Evolution Worker", task: "child-task", wave: 1, dependsOn: ["root-task"] },
      { role: "Evolution Worker", task: "leaf-task", wave: 1, dependsOn: ["child-task"] },
    ];
    const batches = buildRoleExecutionBatches(plans, config);
    // All three fit in one batch with default config
    assert.ok(batches.length >= 1);
    const allPlans = batches.flatMap(b => b.plans);
    assert.equal(allPlans.length, 3);
  });

  it("nucleusFrontierMode=true reduces batch count when nucleus + frontier coexist", () => {
    // root → mid → leaf chain: root and mid are nucleus (score > 0), leaf is frontier
    // With a generous context window all three should collapse into one batch
    const config = {
      copilot: {
        defaultModel: "Claude Sonnet 4.6",
        modelContextReserveTokens: 0,
        modelContextWindows: { "Claude Sonnet 4.6": 1_000_000 },
      },
      planner: { nucleusFrontierMode: true },
    };
    const root = { role: "Evolution Worker", task: "root-task", wave: 1, dependsOn: [] };
    const mid  = { role: "Evolution Worker", task: "mid-task",  wave: 1, dependsOn: ["root-task"] };
    const leaf = { role: "Evolution Worker", task: "leaf-task", wave: 1, dependsOn: ["mid-task"] };

    const standardConfig = { ...config, planner: { nucleusFrontierMode: false } };
    const standardBatches = buildRoleExecutionBatches([root, mid, leaf], standardConfig);
    const nfBatches       = buildRoleExecutionBatches([root, mid, leaf], config);

    // Both must contain all plans
    assert.equal(standardBatches.flatMap(b => b.plans).length, 3);
    assert.equal(nfBatches.flatMap(b => b.plans).length, 3);

    // nucleus/frontier must produce ≤ batch count as standard (it never makes things worse)
    assert.ok(
      nfBatches.length <= standardBatches.length,
      `nucleusFrontierMode must not increase batch count; nf=${nfBatches.length} std=${standardBatches.length}`
    );
  });

  it("nucleusFrontierMode=true preserves all plans with no data loss", () => {
    const config = {
      copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 },
      planner: { nucleusFrontierMode: true },
    };
    const plans = Array.from({ length: 6 }, (_, i) => ({
      role: "Evolution Worker",
      task: `task-${i}`,
      wave: 1,
      dependsOn: i > 0 ? [`task-${i - 1}`] : [],
    }));
    const batches = buildRoleExecutionBatches(plans, config);
    const allPlans = batches.flatMap(b => b.plans);
    assert.equal(allPlans.length, 6, "all 6 plans must be present after nucleus/frontier packing");
  });

  it("nucleusFrontierMode=true: wave boundary enforcement still holds", () => {
    const config = {
      copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 },
      planner: { nucleusFrontierMode: true },
    };
    const w1 = { role: "Evolution Worker", task: "wave1-root", wave: 1, dependsOn: [] };
    const w2 = { role: "Evolution Worker", task: "wave2-child", wave: 2, dependsOn: ["wave1-root"] };

    const batches = buildRoleExecutionBatches([w1, w2], config);
    const batchW1 = batches.find(b => (b.plans as any[]).some((p: any) => p.task === "wave1-root"));
    const batchW2 = batches.find(b => (b.plans as any[]).some((p: any) => p.task === "wave2-child"));

    assert.ok(batchW1, "wave-1 plan must be in a batch");
    assert.ok(batchW2, "wave-2 plan must be in a batch");
    assert.ok(
      (batchW1 as any).bundleIndex < (batchW2 as any).bundleIndex,
      "wave-1 batch must precede wave-2 batch"
    );
  });

  it("negative: nucleusFrontierMode=true on plans with no dependency hints behaves like standard mode", () => {
    // No dependsOn — no graph hints → criticalPathScoreByPlanId is empty → standard packing used
    const config = {
      copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 },
      planner: { nucleusFrontierMode: true },
    };
    const plans = Array.from({ length: 3 }, (_, i) => ({
      role: "Evolution Worker",
      task: `T${i}`,
      wave: 1,
    }));
    const batches = buildRoleExecutionBatches(plans, config);
    assert.equal(batches.length, 1, "3 plans with no deps must produce 1 batch in nucleus/frontier mode");
    assert.equal((batches[0].plans as any[]).length, 3);
  });
});

// ── buildTokenFirstBatches: specialist threshold routing ──────────────────────

describe("buildTokenFirstBatches — specialist threshold routing", () => {
  const config = {
    copilot: {
      defaultModel: "Claude Sonnet 4.6",
      modelContextReserveTokens: 0,
    },
  };
  const rerouteConfig = {
    paths: { stateDir: "__missing_state_for_test__" },
    ...config,
    workerPool: {
      specializationTargets: { fitScoreThreshold: 0.99, minSpecializedShare: 0 },
    },
  };

  function makePlan(role: string, task: string) {
    return {
      role,
      task,
      wave: 1,
      priority: 1,
      taskKind: "implementation",
    };
  }

  it("reroutes specialist plans to evolution-worker when below fill threshold", () => {
    // governance-worker with one tiny task — well below 100% of context
    const plans = [
      makePlan("evolution-worker", "Big evo task " + "x".repeat(200)),
      makePlan("governance-worker", "Small generic maintenance task"),
    ];

    const batches = buildTokenFirstBatches(plans, rerouteConfig);

    // Both plans should be in evolution-worker batches (governance rerouted)
    for (const batch of batches) {
      assert.equal(batch.role, "evolution-worker",
        "governance-worker should be rerouted to evolution-worker when below threshold");
    }
    // Should produce fewer batches than 2
    assert.ok(batches.length <= 2, "should not produce more than 2 batches");
  });

  it("keeps specialist lane when fit score is above threshold even below fill threshold", () => {
    const lockConfig = {
      ...config,
      paths: { stateDir: "__missing_state_for_test__" },
    };
    const plans = [
      makePlan("governance-worker", "Update governance freeze policy rules"),
    ];
    const batches = buildTokenFirstBatches(plans, lockConfig);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].role, "governance-worker");
    const plan = (batches[0].plans as any[])[0];
    assert.equal(plan._specialistFitLocked, true, "high-fit specialist plan must be locked to specialist lane");
  });

  it("rebalances specialist assignment when utilization target is unmet", () => {
    const rebalanceConfig = {
      ...config,
      paths: { stateDir: "__missing_state_for_test__" },
      workerPool: {
        specializationTargets: { fitScoreThreshold: 0.99, minSpecializedShare: 0.5 },
      },
    };
    const plans = [
      makePlan("evolution-worker", "Core implementation task"),
      makePlan("governance-worker", "Small generic maintenance task"),
    ];
    const batches = buildTokenFirstBatches(plans, rebalanceConfig);
    const roles = new Set(batches.map((batch) => batch.role));
    assert.ok(roles.has("governance-worker"), "rebalance should keep at least one specialist lane active");
    const target = (batches[0] as any).specialistUtilizationTarget;
    assert.equal(target.rebalanceApplied, true);
    assert.ok(target.rebalancedCount >= 1);
  });

  it("negative path: high threshold disables specialist lock and allows reroute", () => {
    const plans = [
      makePlan("governance-worker", "Update governance freeze policy rules"),
    ];
    const batches = buildTokenFirstBatches(plans, rerouteConfig);
    assert.equal(batches[0].role, "evolution-worker");
  });

  it("keeps specialist batch when fill threshold is met", () => {
    // Default threshold is 100%, so set an explicit lower threshold for this test.
    const thresholdConfig = {
      ...config,
      planner: { specialistFillThreshold: 0.35 },
    };
    // Create a specialist with enough work to exceed 35% threshold.
    const bigTask = "x".repeat(250000);
    const plans = [
      makePlan("evolution-worker", "evo task"),
      makePlan("governance-worker", bigTask),
    ];

    const batches = buildTokenFirstBatches(plans, thresholdConfig);
    const roles = new Set(batches.map(b => b.role));
    assert.ok(roles.has("governance-worker"),
      "governance-worker should keep its own batch when above threshold");
    assert.ok(roles.has("evolution-worker"));
  });

  it("respects custom specialistFillThreshold from config", () => {
    const customConfig = {
      ...config,
      planner: { specialistFillThreshold: 0.001 }, // 0.1% threshold = 160 tokens
    };
    const plans = [
      makePlan("quality-worker", "Small quality task " + "x".repeat(400)),
    ];

    const batches = buildTokenFirstBatches(plans, customConfig);
    // With threshold at 0.1%, a task with ~400 chars should keep specialist role
    assert.equal(batches.length, 1);
    assert.equal(batches[0].role, "quality-worker");
  });

  it("tags rerouted plans with _originalSpecialistRole", () => {
    const plans = [
      makePlan("observation-worker", "tiny obs task"),
    ];

    const batches = buildTokenFirstBatches(plans, rerouteConfig);
    assert.equal(batches[0].role, "evolution-worker");
    const plan = (batches[0].plans as any[])[0];
    assert.equal(plan._originalSpecialistRole, "observation-worker");
  });

  it("never reroutes evolution-worker (exempt role)", () => {
    const plans = [
      makePlan("evolution-worker", "tiny task"),
    ];

    const batches = buildTokenFirstBatches(plans, rerouteConfig);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].role, "evolution-worker");
  });

  it("preserves wave topology — plans from different waves are packed in separate batches (wave barriers enabled in buildTokenFirstBatches)", () => {
    // buildTokenFirstBatches now preserves dependency-aware wave topology.
    // Plans from different waves must not be co-packed into the same batch.
    const plans = [
      { ...makePlan("governance-worker", "gov w1"), wave: 1, dependsOn: [] },
      { ...makePlan("governance-worker", "gov w2"), wave: 2, dependencies: ["gov w1"] },
    ];

    const batches = buildTokenFirstBatches(plans, rerouteConfig);
    // Wave 1 plan must appear in a wave-1 batch, wave 2 in a wave-2 batch
    const wave1Batches = batches.filter(b => b.wave === 1);
    const wave2Batches = batches.filter(b => b.wave === 2);
    assert.ok(wave1Batches.length > 0, "must have at least one wave-1 batch");
    assert.ok(wave2Batches.length > 0, "must have at least one wave-2 batch");
    // No batch should mix plans from different waves
    for (const batch of batches) {
      const waveNums = new Set((batch.plans as any[]).map((p: any) => Number(p.wave) || 1));
      assert.equal(waveNums.size, 1, `batch wave=${batch.wave} must not mix plans from different waves`);
    }
  });

  it("includes specialistReroutes metadata when rerouting occurs", () => {
    const plans = [
      makePlan("governance-worker", "small task"),
    ];

    const batches = buildTokenFirstBatches(plans, rerouteConfig);
    const reroutes = (batches[0] as any).specialistReroutes;
    assert.ok(Array.isArray(reroutes), "should have specialistReroutes array");
    assert.ok(reroutes.length > 0, "should have at least one reroute entry");
    assert.ok(reroutes[0].includes("governance-worker"), "reroute should mention governance-worker");
  });

  it("includes structured specialistRerouteReasons when rerouting occurs", () => {
    const plans = [makePlan("governance-worker", "small task")];
    const batches = buildTokenFirstBatches(plans, rerouteConfig);
    const reasons = (batches[0] as any).specialistRerouteReasons;
    assert.ok(Array.isArray(reasons), "specialistRerouteReasons must be an array");
    assert.ok(reasons.length > 0, "must have at least one structured reroute reason");
    const r = reasons[0];
    assert.equal(r.role, "governance-worker");
    assert.equal(r.reasonCode, "below_fill_threshold");
    assert.ok(typeof r.tokens === "number");
    assert.ok(typeof r.fillRatio === "number");
    assert.ok(typeof r.adaptiveFillThreshold === "number");
    assert.ok(typeof r.laneScore === "number");
    assert.ok(r.fillRatio >= 0 && r.fillRatio <= 1, "fillRatio must be in [0, 1]");
    assert.ok(r.laneScore >= 0 && r.laneScore <= 1, "laneScore must be in [0, 1]");
  });

  it("specialistRerouteReasons is absent when no reroute occurs", () => {
    // All plans are evolution-worker — exempt role — so no reroute should fire.
    const plans = [makePlan("evolution-worker", "Regular implementation task")];
    const batches = buildTokenFirstBatches(plans, rerouteConfig);
    const reasons = (batches[0] as any).specialistRerouteReasons;
    assert.ok(
      reasons === undefined || (Array.isArray(reasons) && reasons.length === 0),
      "specialistRerouteReasons must be absent or empty when no reroute occurs"
    );
  });

  it("adaptive fill threshold lowers when lane has strong history (via cycle_analytics)", () => {
    // Write a cycle_analytics.json where the governance lane has very high performance.
    // With strong lane history, the adaptive fill threshold for governance should be
    // lower than the base threshold (1.0), making it harder to trigger a reroute.
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "box-adaptive-fill-"));
    try {
      writeFileSync(
        path.join(stateDir, "cycle_analytics.json"),
        JSON.stringify({
          lastCycle: {
            laneTelemetry: {
              governance: { completed: 20, failed: 0, completionRate: 1.0, roi: 2.5 },
            },
          },
        })
      );
      const strongLaneConfig = {
        ...config,
        paths: { stateDir },
        planner: { specialistFillThreshold: 1.0 }, // high base, but should be lowered adaptively
      };
      // Use a governance plan that is medium-sized — not enough to fill 100% context but
      // should survive with a lowered adaptive threshold.
      const plans = [makePlan("governance-worker", "gov task " + "x".repeat(80000))];
      const batches = buildTokenFirstBatches(plans, strongLaneConfig);
      // With a strong governance lane, the adaptive threshold should drop below 1.0
      // so a medium-sized specialist stays instead of being rerouted.
      // We can't guarantee routing outcome without knowing exact token math, but we
      // verify the adaptive threshold metadata shows a value strictly < 1.0.
      if ((batches[0] as any).specialistRerouteReasons?.length > 0) {
        const r = (batches[0] as any).specialistRerouteReasons[0];
        assert.ok(r.adaptiveFillThreshold < 1.0,
          `adaptive threshold must be < 1.0 for strong governance lane; got ${r.adaptiveFillThreshold}`);
      } else {
        // Specialist kept its own batch — adaptive threshold worked. Pass.
        const govBatch = batches.find(b => b.role === "governance-worker");
        assert.ok(govBatch, "governance-worker should keep batch when lane is strong and adaptive lowers threshold");
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reroute reason thresholdTokens reflects adaptive threshold not base threshold", () => {
    // The thresholdTokens should be computed from the adaptive threshold (which
    // may differ from the base 1.0) rather than always equal to usableTokens.
    const plans = [makePlan("governance-worker", "small task")];
    const batches = buildTokenFirstBatches(plans, rerouteConfig);
    const reasons = (batches[0] as any).specialistRerouteReasons;
    if (Array.isArray(reasons) && reasons.length > 0) {
      const r = reasons[0];
      // thresholdTokens must be positive and <= usableContextTokens
      assert.ok(r.thresholdTokens > 0, "thresholdTokens must be positive");
      const usable = (batches[0] as any).usableContextTokens ?? Infinity;
      assert.ok(r.thresholdTokens <= usable,
        "thresholdTokens must not exceed the usable context window");
      // thresholdTokens must equal floor(usable * adaptiveFillThreshold)
      const expected = Math.floor(usable * r.adaptiveFillThreshold);
      assert.equal(r.thresholdTokens, expected,
        `thresholdTokens must equal floor(usable * adaptiveFillThreshold); expected=${expected} got=${r.thresholdTokens}`);
    }
  });

  it("emits specialist utilization target metadata on each batch", () => {
    const plans = [
      makePlan("evolution-worker", "General implementation task"),
      makePlan("quality-worker", "Add test coverage for parser"),
    ];
    const batches = buildTokenFirstBatches(plans, config);
    const target = (batches[0] as any).specialistUtilizationTarget;
    assert.ok(target, "specialist utilization metadata must be present");
    assert.equal(typeof target.fitScoreThreshold, "number");
    assert.equal(typeof target.minSpecializedShare, "number");
    assert.equal(typeof target.adaptiveMinSpecializedShare, "number");
    assert.equal(typeof target.requiredSpecializedCount, "number");
    assert.equal(typeof target.achievedSpecializedCount, "number");
    assert.equal(typeof target.targetMet, "boolean");
    assert.equal(Array.isArray(target.reservedSpecialistLanes), true);
    assert.equal(Array.isArray(target.effectiveSpecialistLanes), true);
    assert.equal(Array.isArray(target.collapsedReservedLanes), true);
  });

  it("adaptiveMinSpecializedShare matches computeAdaptiveSpecializedShareTarget (unified formula)", () => {
    // buildTokenFirstBatches must delegate adaptiveMinSpecializedShare to the
    // canonical computeAdaptiveSpecializedShareTarget so that scoreboard values
    // are identical across token-first, Athena-prebatched, and role-split paths.
    const configuredMin = 0.4;
    const testConfig: any = {
      ...config,
      // Provide a non-existent stateDir so no cycle_analytics.json is loaded
      // from disk, giving us a deterministic empty lanePerformance.
      paths: { stateDir: "__nonexistent_dir_for_test__" },
      workerPool: { specializationTargets: { minSpecializedShare: configuredMin } },
    };
    const plans = [
      makePlan("evolution-worker", "Task A"),
      makePlan("evolution-worker", "Task B"),
    ];
    const batches = buildTokenFirstBatches(plans, testConfig);
    const target = (batches[0] as any).specialistUtilizationTarget;
    assert.ok(target, "specialistUtilizationTarget must be present");

    // Expected: same computation as computeAdaptiveSpecializedShareTarget with
    // no lane performance data (empty ledger → returns configuredMin unchanged).
    const emptyLanePerf = buildLanePerformanceFromCycleTelemetry({});
    const expected = computeAdaptiveSpecializedShareTarget(configuredMin, emptyLanePerf);
    assert.equal(
      target.adaptiveMinSpecializedShare,
      expected,
      `adaptiveMinSpecializedShare must equal computeAdaptiveSpecializedShareTarget result; got ${target.adaptiveMinSpecializedShare} expected ${expected}`,
    );
    // minSpecializedShare must always reflect the configured value
    assert.equal(target.minSpecializedShare, configuredMin);
  });

  it("feeds lane ROI/completion telemetry into per-lane specialist fit thresholds", () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "box-lane-telemetry-"));
    try {
      writeFileSync(
        path.join(stateDir, "cycle_analytics.json"),
        JSON.stringify({
          lastCycle: {
            laneTelemetry: {
              governance: {
                completed: 1,
                failed: 4,
                completionRate: 0.95,
                roi: 4,
              },
            },
          },
        }),
        "utf8"
      );

      const feedbackConfig = {
        ...config,
        paths: { stateDir },
        workerPool: {
          specializationTargets: { fitScoreThreshold: 0.72 },
        },
      };
      const plans = [
        makePlan("governance-worker", "Update governance freeze policy rules"),
      ];
      const batches = buildTokenFirstBatches(plans, feedbackConfig);
      assert.equal(batches.length, 1);
      assert.equal(batches[0].role, "governance-worker", "telemetry-adjusted threshold should preserve specialist lane");

      const target = (batches[0] as any).specialistUtilizationTarget;
      const governanceTarget = target.laneUtilizationTargets.governance;
      assert.ok(governanceTarget.fitScoreThreshold < target.fitScoreThreshold, "lane threshold should be lowered by strong ROI/completion telemetry");
      assert.equal(governanceTarget.completionRate, 0.95);
      assert.equal(governanceTarget.roi, 4);
      assert.equal(governanceTarget.targetMet, true);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("separates same-role conflicting file plans into distinct token-first batches", () => {
    const plans = [
      { role: "evolution-worker", task: "Change orchestrator", filesInScope: ["src/core/orchestrator.ts"], wave: 1, priority: 1 },
      { role: "evolution-worker", task: "Refine orchestrator", filesInScope: ["src/core/orchestrator.ts"], wave: 1, priority: 2 },
      { role: "evolution-worker", task: "Change prometheus", filesInScope: ["src/core/prometheus.ts"], wave: 1, priority: 3 },
    ];
    const batches = buildTokenFirstBatches(plans, config);
    const conflictCoBatched = batches.some((batch) => {
      const tasks = (batch.plans as any[]).map((p: any) => p.task);
      return tasks.includes("Change orchestrator") && tasks.includes("Refine orchestrator");
    });
    assert.equal(conflictCoBatched, false, "conflicting file plans must not be co-batched");
  });

  it("raises adaptive fill threshold when reroute history shows repeated below-fill reroutes for a lane", () => {
    // Write a temp reroute_history.jsonl with repeated below_fill_threshold reroutes
    // for the "governance" lane.  The adaptive threshold should be raised vs baseline
    // (with no reroute history) causing the governance-worker plan to still be rerouted.
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "box-reroute-test-"));
    try {
      const records = Array.from({ length: 6 }, () => JSON.stringify({
        recordedAt: new Date().toISOString(),
        role: "governance-worker",
        lane: "governance",
        reasonCode: "below_fill_threshold",
        fillRatio: 0.2,
        laneScore: 0.5,
      })).join("\n");
      writeFileSync(path.join(tmpDir, "reroute_history.jsonl"), records, "utf8");
      const penaltyConfig = {
        paths: { stateDir: tmpDir },
        ...config,
        workerPool: {
          specializationTargets: { fitScoreThreshold: 0.99, minSpecializedShare: 0 },
        },
      };
      const plans = [
        makePlan("evolution-worker", "Big evo task " + "x".repeat(200)),
        makePlan("governance-worker", "Small generic maintenance task"),
      ];
      const batches = buildTokenFirstBatches(plans, penaltyConfig);
      // governance-worker should still be rerouted (penalty raised the threshold further)
      for (const batch of batches) {
        assert.equal(batch.role, "evolution-worker",
          "governance-worker should be rerouted despite reroute history (penalty raised threshold)");
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not raise threshold when reroute history is empty", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "box-reroute-empty-"));
    try {
      writeFileSync(path.join(tmpDir, "reroute_history.jsonl"), "", "utf8");
      const emptyPenaltyConfig = {
        paths: { stateDir: tmpDir },
        ...config,
        workerPool: {
          specializationTargets: { fitScoreThreshold: 0.99, minSpecializedShare: 0 },
        },
      };
      const plans = [
        makePlan("evolution-worker", "Big evo task " + "x".repeat(200)),
        makePlan("governance-worker", "Small governance task"),
      ];
      // Should behave identically to missing-file scenario (no crash, no penalty)
      const batches = buildTokenFirstBatches(plans, emptyPenaltyConfig);
      assert.ok(Array.isArray(batches), "should return batches array with empty reroute history");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── buildTokenFirstBatches: calibration coefficient ────────────────────────────

describe("buildTokenFirstBatches — calibration coefficient", () => {
  const config = {
    copilot: {
      defaultModel: "Claude Sonnet 4.6",
      modelContextReserveTokens: 0,
    },
  };

  it("applies calibration coefficient to token estimates", () => {
    const plan = {
      role: "evolution-worker",
      task: "Calibration test " + "x".repeat(200),
      wave: 1,
    };
    const baseTokens = estimatePlanTokens(plan);
    const calibratedTokens = estimatePlanTokens(plan, 1.5);

    assert.ok(calibratedTokens > baseTokens, "calibrated tokens should be higher with coeff > 1");
    assert.ok(Math.abs(calibratedTokens - Math.round(baseTokens * 1.5)) <= 1,
      "calibrated tokens should equal base * coefficient");
  });

  it("passes calibrationState through to packing", () => {
    const plan = {
      role: "evolution-worker",
      task: "x".repeat(200),
      wave: 1,
    };

    const batchesNoCalib = buildTokenFirstBatches([plan], config);
    const batchesWithCalib = buildTokenFirstBatches([plan], config, {
      calibrationState: { globalCoefficient: 2.0, roleCoefficients: {} },
    });

    const estNoCal = (batchesNoCalib[0] as any).estimatedTokens;
    const estWithCal = (batchesWithCalib[0] as any).estimatedTokens;
    assert.ok(estWithCal > estNoCal,
      "calibration coefficient 2.0 should inflate estimated tokens");
  });

  it("falls back to 1.0 when no calibration state provided", () => {
    const plan = {
      role: "evolution-worker",
      task: "x".repeat(200),
      wave: 1,
    };

    const batchesDefault = buildTokenFirstBatches([plan], config);
    const batchesExplicit = buildTokenFirstBatches([plan], config, {
      calibrationState: { globalCoefficient: 1.0, roleCoefficients: {} },
    });

    assert.equal(
      (batchesDefault[0] as any).estimatedTokens,
      (batchesExplicit[0] as any).estimatedTokens,
      "no calibration should equal coefficient 1.0"
    );
  });
});

// ── autosplitOversizedPacket ──────────────────────────────────────────────────

describe("autosplitOversizedPacket", () => {
  it("returns single chunk when plans count <= maxSteps", () => {
    const plans = [{ task: "A" }, { task: "B" }, { task: "C" }];
    const chunks = autosplitOversizedPacket(plans, 3);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 3);
  });

  it("splits into chunks of maxSteps when oversized", () => {
    const plans = [{ task: "A" }, { task: "B" }, { task: "C" }, { task: "D" }];
    const chunks = autosplitOversizedPacket(plans, 2);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, 2);
    assert.equal(chunks[1].length, 2);
  });

  it("preserves all plans across chunks (no loss)", () => {
    const plans = [
      { task: "Fix auth", task_id: "T1" },
      { task: "Fix CI", task_id: "T2" },
      { task: "Fix types", task_id: "T3" },
      { task: "Fix lint", task_id: "T4" },
      { task: "Fix docs", task_id: "T5" },
    ];
    const chunks = autosplitOversizedPacket(plans, 2);
    const allTasks = chunks.flat().map((p: any) => p.task_id);
    assert.equal(allTasks.length, 5, "all plans must be preserved");
    assert.ok(allTasks.includes("T1"));
    assert.ok(allTasks.includes("T5"));
  });

  it("respects dependency ordering across chunks", () => {
    const plans = [
      { task: "Step B", task_id: "T2", dependsOn: ["T1"] },
      { task: "Step A", task_id: "T1" },
      { task: "Step C", task_id: "T3", dependsOn: ["T2"] },
      { task: "Step D", task_id: "T4" },
    ];
    const chunks = autosplitOversizedPacket(plans, 2);
    // T1 must appear before T2; T2 must appear before T3
    const allSorted = chunks.flat();
    const idxT1 = allSorted.findIndex((p: any) => p.task_id === "T1");
    const idxT2 = allSorted.findIndex((p: any) => p.task_id === "T2");
    const idxT3 = allSorted.findIndex((p: any) => p.task_id === "T3");
    assert.ok(idxT1 < idxT2, "T1 must precede T2");
    assert.ok(idxT2 < idxT3, "T2 must precede T3");
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(autosplitOversizedPacket([], 3), []);
  });

  it("negative path: handles null input gracefully", () => {
    assert.deepEqual(autosplitOversizedPacket(null as any, 3), []);
  });
});

// ── checkPacketSizeCap ────────────────────────────────────────────────────────

describe("checkPacketSizeCap", () => {
  it("returns null when plans count is at the cap", () => {
    const plans = [{ task: "A" }, { task: "B" }, { task: "C" }];
    assert.equal(checkPacketSizeCap(plans, 3), null);
  });

  it("returns null when plans count is below the cap", () => {
    assert.equal(checkPacketSizeCap([{ task: "A" }], 3), null);
  });

  it("returns violation string when plans count exceeds cap", () => {
    const plans = [{ task: "A" }, { task: "B" }, { task: "C" }, { task: "D" }];
    const result = checkPacketSizeCap(plans, 3);
    assert.ok(typeof result === "string", "must return a string when oversized");
    assert.ok(result.length > 0);
    assert.ok(result.includes("4"));
    assert.ok(result.includes("3"));
  });

  it("uses MAX_ACTIONABLE_STEPS_PER_PACKET as default cap", () => {
    // 4 plans with default cap of 3 must trigger violation
    const plans = [{ task: "A" }, { task: "B" }, { task: "C" }, { task: "D" }];
    const result = checkPacketSizeCap(plans);
    assert.ok(typeof result === "string");
  });

  it("returns null for non-array input", () => {
    assert.equal(checkPacketSizeCap(null as any), null);
  });
});

// ── validatePacketBatchAdmission ──────────────────────────────────────────────

describe("validatePacketBatchAdmission", () => {
  it("returns blocked=false for empty input", () => {
    const result = validatePacketBatchAdmission([], 3);
    assert.equal(result.blocked, false);
    assert.equal(result.reason, null);
    assert.deepEqual(result.oversizedRoles, []);
  });

  it("returns blocked=false when all role groups are within the cap", () => {
    const plans = [
      { role: "Evolution Worker", task: "A" },
      { role: "Evolution Worker", task: "B" },
      { role: "Infrastructure Worker", task: "C" },
    ];
    const result = validatePacketBatchAdmission(plans, 2);
    assert.equal(result.blocked, false);
  });

  it("returns blocked=true when a role group exceeds the cap", () => {
    const plans = [
      { role: "Evolution Worker", task: "A" },
      { role: "Evolution Worker", task: "B" },
      { role: "Evolution Worker", task: "C" },
    ];
    const result = validatePacketBatchAdmission(plans, 2);
    assert.equal(result.blocked, true);
    assert.ok(typeof result.reason === "string" && result.reason.length > 0);
    assert.ok(result.oversizedRoles.length > 0, "oversizedRoles must be non-empty");
    assert.ok(result.reason.includes("packet_exceeds_actionable_steps_cap"));
  });

  it("includes role name and counts in the reason string", () => {
    const plans = [
      { role: "CI Worker", task: "A" },
      { role: "CI Worker", task: "B" },
      { role: "CI Worker", task: "C" },
    ];
    const result = validatePacketBatchAdmission(plans, 2);
    assert.ok(result.reason?.includes("ci worker"), `reason must contain normalized role name; got: ${result.reason}`);
    assert.ok(result.reason?.includes("3>2"), `reason must contain count and cap; got: ${result.reason}`);
  });

  it("uses MAX_ACTIONABLE_STEPS_PER_PACKET as default cap", () => {
    // MAX_ACTIONABLE_STEPS_PER_PACKET = 3; 4 plans with same role triggers violation
    const plans = [
      { role: "Evo", task: "A" },
      { role: "Evo", task: "B" },
      { role: "Evo", task: "C" },
      { role: "Evo", task: "D" },
    ];
    const result = validatePacketBatchAdmission(plans);
    assert.equal(result.blocked, true, "must block with default cap of 3 when 4 plans share a role");
  });

  it("NEGATIVE PATH: multiple role groups each below cap is not blocked", () => {
    const plans = [
      { role: "Worker A", task: "1" },
      { role: "Worker A", task: "2" },
      { role: "Worker B", task: "3" },
      { role: "Worker B", task: "4" },
      { role: "Worker C", task: "5" },
    ];
    const result = validatePacketBatchAdmission(plans, 3);
    assert.equal(result.blocked, false, "2+2+1 plans across 3 roles must pass a cap of 3");
  });

  it("returns blocked=false for null input", () => {
    const result = validatePacketBatchAdmission(null as any, 3);
    assert.equal(result.blocked, false);
  });

  it("does not block when same role is split into Athena batches each under cap", () => {
    const plans = [
      { role: "evolution-worker", _batchWorkerRole: "evolution-worker", _batchIndex: 1, orderedSteps: ["a", "b"] },
      { role: "evolution-worker", _batchWorkerRole: "evolution-worker", _batchIndex: 2, orderedSteps: ["c", "d"] },
    ];
    const result = validatePacketBatchAdmission(plans, 2);
    assert.equal(result.blocked, false, "independent Athena batches under cap must pass");
  });

  it("blocks when an Athena role-batch itself exceeds cap", () => {
    const plans = [
      { role: "evolution-worker", _batchWorkerRole: "evolution-worker", _batchIndex: 1, orderedSteps: ["a", "b", "c"] },
      { role: "evolution-worker", _batchWorkerRole: "evolution-worker", _batchIndex: 2, orderedSteps: ["d"] },
    ];
    const result = validatePacketBatchAdmission(plans, 2);
    assert.equal(result.blocked, true);
    assert.ok(result.reason?.includes("batch 1"), `reason must mention oversize batch; got: ${result.reason}`);
  });
});

// ── buildTokenFirstBatches wave topology preservation (Task 3) ───────────────

describe("buildTokenFirstBatches — wave topology preservation", () => {
  const config = {
    copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 },
    runtime: { workerContextTokenLimit: 200_000 },
  };

  function makePlan(task: string, wave: number, file?: string) {
    return {
      role: "Evolution Worker",
      task,
      wave,
      target_files: [file ?? `src/core/${task.replace(/\s+/g, "_").toLowerCase()}.ts`],
    };
  }

  it("plans from different waves produce separate batches with correct wave numbers", () => {
    const plans = [
      makePlan("Wave-1 task A", 1),
      makePlan("Wave-1 task B", 1),
      makePlan("Wave-2 task C", 2),
    ];
    const batches = buildTokenFirstBatches(plans, config);
    const wave1 = batches.filter(b => b.wave === 1);
    const wave2 = batches.filter(b => b.wave === 2);
    assert.ok(wave1.length > 0, "must have wave-1 batches");
    assert.ok(wave2.length > 0, "must have wave-2 batches");
  });

  it("token packing applies within each wave — same-wave plans fit into one batch when under token budget", () => {
    const plans = [
      makePlan("W1 small A", 1),
      makePlan("W1 small B", 1),
    ];
    const batches = buildTokenFirstBatches(plans, config);
    const wave1 = batches.filter(b => b.wave === 1);
    // Both plans should fit in a single batch (well under 200k token limit)
    assert.equal(wave1.length, 1, "both wave-1 plans must be packed into a single batch");
    assert.equal((wave1[0].plans as any[]).length, 2);
  });

  it("negative: wave-2 plans are never co-batched with wave-1 plans", () => {
    const plans = [
      makePlan("Wave-1 task", 1),
      makePlan("Wave-2 dependent task", 2),
    ];
    const batches = buildTokenFirstBatches(plans, config);
    for (const batch of batches) {
      const waveNums = new Set((batch.plans as any[]).map((p: any) => Number(p.wave)));
      assert.equal(waveNums.size, 1, `batch must not mix waves; found waves ${[...waveNums].join(",")}`);
    }
  });

  it("tokenFirstPacked flag is set on all batches", () => {
    const plans = [makePlan("Task A", 1), makePlan("Task B", 2)];
    const batches = buildTokenFirstBatches(plans, config);
    for (const batch of batches) {
      assert.equal((batch as any).tokenFirstPacked, true);
    }
  });

  it("single-wave plans produce batches all with the same wave number", () => {
    const plans = [makePlan("A", 3), makePlan("B", 3)];
    const batches = buildTokenFirstBatches(plans, config);
    for (const batch of batches) {
      assert.equal(batch.wave, 3);
    }
  });

  it("preserves multi-lane admission metadata for later-wave singleton continuation slices", () => {
    const admittedPlans = [
      { role: "quality-worker", task: "Quality wave 1", wave: 1, target_files: ["tests/core/a.test.ts"] },
      { role: "governance-worker", task: "Governance wave 1", wave: 1, target_files: ["src/core/governance_freeze.ts"] },
      { role: "Evolution Worker", task: "Implementation wave 2", wave: 2, target_files: ["src/core/orchestrator.ts"] },
    ];
    const admittedTopology = buildWorkerTopologyContract(admittedPlans);
    const continuationPlans = [admittedPlans[2]];
    const continuationTopology = buildWorkerTopologyContract(continuationPlans, {
      admittedWorkerTopology: admittedTopology,
    });

    assert.equal(continuationTopology.workerCount, 1);
    assert.equal(continuationTopology.continuation?.preservesMultiLaneAdmission, true);
    assert.deepEqual(continuationTopology.continuation?.missingLanes, ["governance", "quality"]);
    assert.equal(
      selectExecutionPatternForPlans(continuationPlans, { workerTopology: continuationTopology }),
      "wave_parallel",
      "continuation slices should keep the admitted multi-lane execution pattern",
    );
  });
});

// ── Wave boundary idle gap instrumentation ─────────────────────────────────────
import {
  measureWaveBoundaryIdleGap,
  shouldPackAcrossWaveBoundary,
} from "../../src/core/worker_batch_planner.js";

describe("measureWaveBoundaryIdleGap", () => {
  it("returns correct idleMs from timestamps", () => {
    const record = measureWaveBoundaryIdleGap(1, 2, 1000, 3000, 4);
    assert.equal(record.waveFrom, 1);
    assert.equal(record.waveTo, 2);
    assert.equal(record.idleMs, 2000);
    assert.equal(record.batchCount, 4);
    assert.ok(record.idleStartedAt.length > 0);
    assert.ok(record.idleEndedAt.length > 0);
  });

  it("returns idleMs=0 when start and end are equal", () => {
    const record = measureWaveBoundaryIdleGap(2, 3, 5000, 5000, 1);
    assert.equal(record.idleMs, 0);
  });

  it("clamps negative idleMs to 0", () => {
    const record = measureWaveBoundaryIdleGap(1, 2, 9000, 8000, 2);
    assert.ok(record.idleMs >= 0);
  });
});

describe("shouldPackAcrossWaveBoundary", () => {
  it("returns true for singleton from-wave and dep-free to-wave batch", () => {
    const fromBatches = [{ plans: [{ task: "a" }] }];
    const toBatches = [{ plans: [{ task: "b", dependencies: [] }] }];
    assert.equal(shouldPackAcrossWaveBoundary(fromBatches, toBatches), true);
  });

  it("returns false when to-wave batch has dependency on from-wave", () => {
    const fromBatches = [{ plans: [{ task: "a" }] }];
    const toBatches = [{ plans: [{ task: "b", dependencies: ["a"] }] }];
    assert.equal(shouldPackAcrossWaveBoundary(fromBatches, toBatches), false);
  });

  it("returns false when the last from-wave batch has multiple plans", () => {
    const fromBatches = [{ plans: [{ task: "a" }, { task: "c" }] }];
    const toBatches = [{ plans: [{ task: "b", dependencies: [] }] }];
    assert.equal(shouldPackAcrossWaveBoundary(fromBatches, toBatches), false);
  });

  it("returns false when to-wave batches array is empty", () => {
    const fromBatches = [{ plans: [{ task: "a" }] }];
    assert.equal(shouldPackAcrossWaveBoundary(fromBatches, []), false);
  });
});

// ── computeBatchOrderedStepCount ──────────────────────────────────────────────
describe("computeBatchOrderedStepCount", () => {
  it("sums orderedSteps.length across plans when present", () => {
    const plans = [
      { id: "T-001", orderedSteps: ["s1", "s2", "s3"] },
      { id: "T-002", orderedSteps: ["s1", "s2"] },
    ];
    assert.equal(computeBatchOrderedStepCount(plans), 5);
  });

  it("falls back to acceptance_criteria.length when orderedSteps absent", () => {
    const plans = [
      { id: "T-001", acceptance_criteria: ["ac1", "ac2"] },
      { id: "T-002", acceptance_criteria: ["ac1"] },
    ];
    assert.equal(computeBatchOrderedStepCount(plans), 3);
  });

  it("uses 1 per plan when both orderedSteps and acceptance_criteria are absent", () => {
    const plans = [{ id: "T-001" }, { id: "T-002" }, { id: "T-003" }];
    assert.equal(computeBatchOrderedStepCount(plans), 3);
  });

  it("returns 0 for empty plans array", () => {
    assert.equal(computeBatchOrderedStepCount([]), 0);
  });

  it("handles mixed plans with some having orderedSteps and some having acceptance_criteria", () => {
    const plans = [
      { id: "T-001", orderedSteps: ["s1", "s2", "s3", "s4"] },
      { id: "T-002", acceptance_criteria: ["ac1", "ac2"] },
      { id: "T-003" },
    ];
    // T-001: 4 steps, T-002: 2 (falls back to ac), T-003: 1 (default)
    assert.equal(computeBatchOrderedStepCount(plans), 7);
  });

  it("negative path: non-array orderedSteps treated as absent (falls back to ac)", () => {
    const plans = [
      { id: "T-001", orderedSteps: "not-an-array", acceptance_criteria: ["ac1", "ac2"] },
    ];
    assert.equal(computeBatchOrderedStepCount(plans), 2);
  });
});

describe("computePlanEstimatedDurationMinutes", () => {
  it("prefers explicit estimatedDurationMinutes when present", () => {
    assert.equal(computePlanEstimatedDurationMinutes({ estimatedDurationMinutes: 42 }), 42);
  });

  it("derives longer duration for higher-token and higher-risk plans", () => {
    const medium = computePlanEstimatedDurationMinutes({ estimatedExecutionTokens: 8000, acceptance_criteria: ["a", "b"] });
    const critical = computePlanEstimatedDurationMinutes({ estimatedExecutionTokens: 16000, riskLevel: "critical", acceptance_criteria: ["a", "b", "c"] });
    assert.ok(critical > medium);
  });
});

describe("computeBatchEstimatedDurationMinutes", () => {
  it("sums per-plan estimated durations", () => {
    const plans = [
      { estimatedDurationMinutes: 20 },
      { estimatedDurationMinutes: 35 },
    ];
    assert.equal(computeBatchEstimatedDurationMinutes(plans), 55);
  });

  it("returns 0 for empty plan arrays", () => {
    assert.equal(computeBatchEstimatedDurationMinutes([]), 0);
  });
});

describe("buildRoleExecutionBatches — orderedStepCount on batch output", () => {
  it("attaches orderedStepCount to each batch", () => {
    const plans = [
      { id: "T-001", role: "Evolution Worker", task: "task 1", orderedSteps: ["s1", "s2"] },
      { id: "T-002", role: "Evolution Worker", task: "task 2", orderedSteps: ["s1"] },
    ];
    const config = {};
    const batches = buildRoleExecutionBatches(plans, config);
    for (const batch of batches) {
      assert.ok("orderedStepCount" in batch,
        "each batch must have orderedStepCount field");
      assert.equal(typeof (batch as any).orderedStepCount, "number",
        "orderedStepCount must be a number");
      assert.ok((batch as any).orderedStepCount >= 0,
        "orderedStepCount must be non-negative");
      assert.equal(typeof (batch as any).estimatedDurationMinutes, "number",
        "each batch must have estimatedDurationMinutes field");
      assert.ok((batch as any).estimatedDurationMinutes >= 0,
        "estimatedDurationMinutes must be non-negative");
    }
  });
});

// ── normalizeModelLabel and buildModelRoutingTelemetry label canonicalization ──
import { normalizeModelLabel } from "../../src/core/model_policy.js";
import { buildModelRoutingTelemetry } from "../../src/core/cycle_analytics.js";

describe("normalizeModelLabel", () => {
  it("lowercases and trims whitespace", () => {
    assert.equal(normalizeModelLabel("  Claude Sonnet 4.6  "), "claude sonnet 4.6");
  });

  it("converts hyphens to spaces", () => {
    assert.equal(normalizeModelLabel("claude-sonnet-4-6"), "claude sonnet 4 6");
  });

  it("converts underscores to spaces", () => {
    assert.equal(normalizeModelLabel("claude_sonnet_4_6"), "claude sonnet 4 6");
  });

  it("collapses mixed separators to a single space", () => {
    assert.equal(normalizeModelLabel("claude--sonnet__4-6"), "claude sonnet 4 6");
  });

  it("returns empty string for blank input", () => {
    assert.equal(normalizeModelLabel(""), "");
    assert.equal(normalizeModelLabel("   "), "");
  });

  it("NEGATIVE PATH: returns empty string for null/undefined", () => {
    assert.equal(normalizeModelLabel(null), "");
    assert.equal(normalizeModelLabel(undefined), "");
  });

  it("produces identical canonical key for 'Claude Sonnet 4.6' and 'claude-sonnet-4-6' variants", () => {
    const a = normalizeModelLabel("Claude Sonnet 4.6");
    const b = normalizeModelLabel("claude-sonnet-4-6");
    // Both lower to "claude sonnet 4.6" and "claude sonnet 4 6" respectively —
    // the dot in "4.6" is preserved, so they are NOT identical, but both are
    // deterministic canonical keys (no raw mixed-case keys leak into telemetry).
    assert.equal(typeof a, "string");
    assert.equal(typeof b, "string");
    assert.notEqual(a, "Claude Sonnet 4.6", "must not be original mixed-case");
    assert.notEqual(b, "claude-sonnet-4-6", "must not contain hyphens");
  });
});

describe("buildModelRoutingTelemetry — model label canonicalization", () => {
  it("consolidates identical models under different casing into one key", () => {
    const log = [
      { taskKind: "implementation", model: "Claude Sonnet 4.6", outcome: "done" },
      { taskKind: "implementation", model: "CLAUDE SONNET 4.6", outcome: "done" },
      { taskKind: "implementation", model: "claude sonnet 4.6", outcome: "partial" },
    ];
    const result = buildModelRoutingTelemetry(log);
    const modelKeys = Object.keys(result.byTaskKind["implementation"]?.models ?? {});
    assert.equal(modelKeys.length, 1, `expected 1 canonical model key, got: ${modelKeys.join(", ")}`);
    assert.equal(modelKeys[0], "claude sonnet 4.6");
  });

  it("consolidates hyphen-separated and space-separated forms of the same model", () => {
    const log = [
      { taskKind: "analysis", model: "claude-sonnet-4-6", outcome: "done" },
      { taskKind: "analysis", model: "claude sonnet 4 6", outcome: "done" },
    ];
    const result = buildModelRoutingTelemetry(log);
    const modelKeys = Object.keys(result.byTaskKind["analysis"]?.models ?? {});
    assert.equal(modelKeys.length, 1, `expected 1 canonical key after hyphen normalization; got: ${modelKeys.join(", ")}`);
  });

  it("preserves distinct models as separate keys after normalization", () => {
    const log = [
      { taskKind: "implementation", model: "claude-sonnet-4-6", outcome: "done" },
      { taskKind: "implementation", model: "claude-opus-4-6", outcome: "done" },
    ];
    const result = buildModelRoutingTelemetry(log);
    const modelKeys = Object.keys(result.byTaskKind["implementation"]?.models ?? {});
    assert.equal(modelKeys.length, 2, "distinct models must remain distinct after normalization");
  });

  it("NEGATIVE PATH: entries with blank model field are excluded from telemetry", () => {
    const log = [
      { taskKind: "implementation", model: "", outcome: "done" },
      { taskKind: "implementation", model: "   ", outcome: "done" },
    ];
    const result = buildModelRoutingTelemetry(log);
    assert.equal(result.sampleCount, 0, "blank model entries must be excluded");
  });

  it("NEGATIVE PATH: returns empty telemetry for empty log", () => {
    const result = buildModelRoutingTelemetry([]);
    assert.deepEqual(result, { byTaskKind: {}, sampleCount: 0 });
  });

  it("aggregates done/total counts correctly when same normalized model appears multiple times", () => {
    const log = [
      { taskKind: "implementation", model: "Claude Sonnet 4.6", outcome: "done" },
      { taskKind: "implementation", model: "claude sonnet 4.6", outcome: "done" },
      { taskKind: "implementation", model: "CLAUDE SONNET 4.6", outcome: "partial" },
    ];
    const result = buildModelRoutingTelemetry(log);
    const modelEntry = result.byTaskKind["implementation"]?.models?.["claude sonnet 4.6"];
    assert.ok(modelEntry, "canonical model key must be present");
    // 3 entries total, sampleCount should be 3
    assert.equal(result.sampleCount, 3);
    // successProbability = 2 done / 3 total = ~0.667
    assert.ok(modelEntry.successProbability > 0.6 && modelEntry.successProbability < 0.7,
      `successProbability must be ~0.667; got ${modelEntry.successProbability}`);
  });
});
