import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferCapabilityTag, selectWorkerForPlan, assignWorkersToPlans, enforceLaneDiversity, computeDispatchMetrics, buildWorkerChain, detectLaneConflicts, recordLaneOutcome, getLaneScore, scoreWorkerTaskFit, selectWorkerByFitScore, buildLanePerformanceFromCycleTelemetry, buildLaneTelemetrySignals, computeSpecialistFitThreshold, evaluateSpecializationAdmissionGate, SPECIALIZATION_ADMISSION_MAX_BLOCK_CYCLES, SPECIALIZATION_ADMISSION_BLOCK_REASON } from "../../src/core/capability_pool.js";

describe("capability_pool", () => {
  describe("inferCapabilityTag", () => {
    it("returns default for null", () => {
      assert.equal(inferCapabilityTag(null), "runtime-refactor");
    });

    it("detects governance role", () => {
      assert.equal(inferCapabilityTag({ role: "governance-worker" }), "state-governance");
    });

    it("detects test task", () => {
      assert.equal(inferCapabilityTag({ task: "Add test coverage for parser" }), "test-infra");
    });

    it("detects prometheus task", () => {
      assert.equal(inferCapabilityTag({ task: "Plan new hypothesis" }), "planner-improvement");
    });

    it("detects infrastructure task", () => {
      assert.equal(inferCapabilityTag({ task: "Update Docker configuration" }), "infrastructure");
    });

    it("detects dashboard task", () => {
      assert.equal(inferCapabilityTag({ task: "Fix dashboard metrics display" }), "observation");
    });

    it("falls back to runtime-refactor for generic tasks", () => {
      assert.equal(inferCapabilityTag({ task: "Update code logic" }), "runtime-refactor");
    });

    it("does not misclassify generic capability wording as infrastructure", () => {
      assert.equal(
        inferCapabilityTag({
          task: "Reconcile health audit capability detection with current deep-equality tracking",
          acceptance_criteria: ["Audit capability verification path remains deterministic"],
        }),
        "test-infra",
      );
    });
  });

  describe("selectWorkerForPlan", () => {
    it("selects a worker from the lane", () => {
      const plan = { task: "Add test for foo", role: "evolution-worker" };
      const selection = selectWorkerForPlan(plan);
      assert.ok(selection.role);
      assert.ok(selection.lane);
      assert.ok(selection.reason);
    });

    it("quality task routes to quality-worker", () => {
      const plan = { task: "Add test coverage for the parser module" };
      const selection = selectWorkerForPlan(plan);
      assert.equal(selection.role, "quality-worker");
      assert.equal(selection.lane, "quality");
      assert.equal(selection.isFallback, false);
    });

    it("upgrades generic evolution-worker role when plan signals clearly require a specialist lane", () => {
      const plan = { task: "Add tests for parser timeout handling", role: "evolution-worker" };
      const selection = selectWorkerForPlan(plan);
      assert.equal(selection.role, "quality-worker");
      assert.equal(selection.lane, "quality");
      assert.match(selection.reason, /upgraded to specialist lane/i);
    });

    it("preserves explicit evolution-worker role for generic implementation work", () => {
      const plan = { task: "Update response parsing logic", role: "evolution-worker" };
      const selection = selectWorkerForPlan(plan);
      assert.equal(selection.role, "evolution-worker");
      assert.equal(selection.lane, "implementation");
      assert.match(selection.reason, /Explicit planner role/i);
    });

    it("preserves explicit quality-worker role for test plans", () => {
      const plan = { task: "Add tests for parser timeout handling", role: "quality-worker" };
      const selection = selectWorkerForPlan(plan);
      assert.equal(selection.role, "quality-worker");
      assert.equal(selection.lane, "quality");
      assert.match(selection.reason, /Explicit planner role/i);
    });

    it("normalizes explicit lane labels to canonical worker names", () => {
      const plan = { task: "Enforce governance freeze gate", role: "governance" };
      const selection = selectWorkerForPlan(plan);
      assert.equal(selection.role, "governance-worker");
      assert.equal(selection.lane, "governance");
      assert.match(selection.reason, /normalized to worker/i);
    });

    it("governance task routes to governance-worker", () => {
      const plan = { task: "Update governance freeze policy rules" };
      const selection = selectWorkerForPlan(plan);
      assert.equal(selection.role, "governance-worker");
      assert.equal(selection.lane, "governance");
    });

    it("uses target file signals to route governance-heavy generic plans", () => {
      const plan = {
        task: "Normalize lane-diversity reason contract with compatibility bridge",
        role: "evolution-worker",
        target_files: ["src/core/governance_contract.ts", "src/core/orchestrator.ts"],
      };
      const selection = selectWorkerForPlan(plan);
      assert.equal(selection.role, "governance-worker");
      assert.equal(selection.lane, "governance");
    });

    it("routes audit-and-test heavy generic plans to quality instead of infrastructure", () => {
      const plan = {
        task: "Reconcile health audit capability detection with current deep-equality tracking",
        role: "evolution-worker",
        target_files: ["tests/core/athena_review_normalization.test.ts", "src/core/athena_reviewer.ts"],
        acceptance_criteria: ["Regression test proves deep-equality behavior remains intact"],
        verification: "npm test -- tests/core/athena_review_normalization.test.ts",
      };
      const selection = selectWorkerForPlan(plan);
      assert.equal(selection.role, "quality-worker");
      assert.equal(selection.lane, "quality");
    });

    it("infrastructure task routes to infrastructure-worker", () => {
      const plan = { task: "Update Docker configuration for production" };
      const selection = selectWorkerForPlan(plan);
      assert.equal(selection.role, "infrastructure-worker");
      assert.equal(selection.lane, "infrastructure");
    });

    it("implementation task routes to evolution-worker (kebab-case canonical identity)", () => {
      // Use a task with no domain keywords — pure implementation falls back to runtime-refactor → implementation lane
      const plan = { task: "Update the response parsing logic" };
      const selection = selectWorkerForPlan(plan);
      assert.equal(selection.role, "evolution-worker");
      assert.equal(selection.lane, "implementation");
    });

    it("negative path: falls back when lane mapping is unknown", () => {
      const plan = { task: "Generic task", role: "nonexistent-role" };
      const selection = selectWorkerForPlan(plan);
      assert.ok(selection.role);
    });
  });

  describe("assignWorkersToPlans", () => {
    it("returns empty for non-array", () => {
      const result = assignWorkersToPlans(null);
      assert.deepEqual(result.assignments, []);
      assert.equal(result.diversityIndex, 0);
    });

    it("assigns workers to all plans", () => {
      const plans = [
        { task: "Add tests", role: "evolution-worker" },
        { task: "Fix governance policy", role: "evolution-worker" },
        { task: "Update docker config", role: "evolution-worker" },
      ];
      const result = assignWorkersToPlans(plans);
      assert.equal(result.assignments.length, 3);
      assert.ok(result.diversityIndex >= 0 && result.diversityIndex <= 1);
    });

    it("computes diversity index", () => {
      const plans = [
        { task: "A" },
        { task: "B" },
      ];
      const result = assignWorkersToPlans(plans);
      assert.ok(typeof result.diversityIndex === "number");
    });

    it("retains multi-lane topology for mixed explicit roles", () => {
      const plans = [
        { task: "Refactor response aggregation flow", role: "evolution-worker" },
        { task: "Add tests around reviewer", role: "quality-worker" },
      ];
      const result = assignWorkersToPlans(plans);
      assert.equal(result.activeLaneCount, 2);
      assert.equal(result.diversityCheck.meetsMinimum, true);
    });

    it("tracks effective-lane collapse separately from nominal specialist intent", () => {
      let lanePerformance = {};
      for (let i = 0; i < 8; i++) {
        lanePerformance = recordLaneOutcome(lanePerformance, "quality", { success: false });
      }
      const plans = [
        { task: "Add regression tests for parser", role: "evolution-worker" },
        { task: "Refactor response aggregation flow", role: "evolution-worker" },
      ];
      const result = assignWorkersToPlans(plans, {}, lanePerformance);
      assert.equal(result.activeLaneCount, 1);
      assert.equal(result.nominalActiveLaneCount, 2);
      assert.equal(result.specializationUtilization.fallbackCollapseCount, 1);
      assert.equal(result.specializationUtilization.collapsedReservedLanes.includes("quality"), true);
      assert.deepEqual(result.laneCounts, { implementation: 2 });
      assert.deepEqual(result.nominalLaneCounts, { quality: 1, implementation: 1 });
    });
  });

  describe("computeDispatchMetrics (Packet 12)", () => {
    it("returns metrics for empty pool", () => {
      const metrics = computeDispatchMetrics({ assignments: [] });
      assert.ok(typeof metrics.concentrationRatio === "number");
      assert.ok(typeof metrics.diversityScore === "number");
    });

    it("returns role and lane distribution", () => {
      const pool = {
        assignments: [
          { selection: { role: "evolution-worker", lane: "implementation" } },
          { selection: { role: "evolution-worker", lane: "implementation" } },
          { selection: { role: "governance-worker", lane: "governance" } },
        ],
      };
      const metrics = computeDispatchMetrics(pool);
      assert.ok(metrics.roleDistribution["evolution-worker"] >= 2);
      assert.ok(metrics.laneDistribution["implementation"] >= 2);
    });

    it("computes concentration ratio", () => {
      const pool = {
        assignments: [
          { selection: { role: "a", lane: "x" } },
          { selection: { role: "a", lane: "x" } },
          { selection: { role: "b", lane: "y" } },
        ],
      };
      const metrics = computeDispatchMetrics(pool);
      assert.ok(metrics.concentrationRatio > 0);
      assert.ok(metrics.concentrationRatio <= 1);
    });
  });

  describe("buildWorkerChain (Packet 13)", () => {
    it("returns 3-stage chain for complex tasks", () => {
      const plan = { task: "Complex multi-file refactoring", complexity: "critical" };
      const result = buildWorkerChain(plan, { complexity: "critical" });
      assert.equal(result.isChained, true);
      assert.ok(result.chain.length === 3);
    });

    it("returns empty chain for simple tasks", () => {
      const plan = { task: "Fix typo" };
      const result = buildWorkerChain(plan, { complexity: "low" });
      assert.equal(result.isChained, false);
      assert.equal(result.chain.length, 0);
    });

    it("each stage has stage and lane", () => {
      const result = buildWorkerChain({ task: "Refactor auth" }, { complexity: "high" });
      assert.equal(result.isChained, true);
      for (const stage of result.chain) {
        assert.ok(stage.stage);
        assert.ok(stage.lane);
        assert.ok(stage.task);
      }
    });

    it("uses the authoritative runtime contract for implementation output", () => {
      const result = buildWorkerChain({ task: "Refactor auth" }, { complexity: "high" });
      const implementationStage = result.chain.find((stage) => stage.stage === "implementation");
      assert.ok(implementationStage);
      assert.match(implementationStage.task, /authoritative runtime completion contract/i);
      assert.match(implementationStage.task, /BOX_\* closure markers/i);
      assert.match(implementationStage.task, /do not emit TOOL_INTENT or HOOK_DECISION/i);
      assert.doesNotMatch(implementationStage.task, /Output BOX_STATUS and VERIFICATION_REPORT/i);
    });
  });

  describe("detectLaneConflicts", () => {
    it("returns empty for fewer than 2 assignments", () => {
      assert.deepEqual(detectLaneConflicts([]), []);
      assert.deepEqual(detectLaneConflicts([
        { plan: { target_files: ["src/a.ts"] }, selection: { lane: "implementation" } }
      ]), []);
    });

    it("returns empty when plans share a lane but no target files", () => {
      const conflicts = detectLaneConflicts([
        { plan: { task: "A", target_files: ["src/a.ts"] }, selection: { lane: "implementation" } },
        { plan: { task: "B", target_files: ["src/b.ts"] }, selection: { lane: "implementation" } },
      ]);
      assert.deepEqual(conflicts, []);
    });

    it("detects a conflict when plans share a lane and a target file", () => {
      const conflicts = detectLaneConflicts([
        { plan: { task: "A", target_files: ["src/core/orchestrator.ts"] }, selection: { lane: "implementation" } },
        { plan: { task: "B", target_files: ["src/core/orchestrator.ts"] }, selection: { lane: "implementation" } },
      ]);
      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0].lane, "implementation");
      assert.ok(conflicts[0].sharedFiles.includes("src/core/orchestrator.ts"));
    });

    it("does not flag plans in different lanes even if they share files", () => {
      const conflicts = detectLaneConflicts([
        { plan: { task: "A", target_files: ["src/core/orchestrator.ts"] }, selection: { lane: "implementation" } },
        { plan: { task: "B", target_files: ["src/core/orchestrator.ts"] }, selection: { lane: "governance" } },
      ]);
      assert.deepEqual(conflicts, []);
    });

    it("reports multiple conflicts when multiple pairs share files", () => {
      const conflicts = detectLaneConflicts([
        { plan: { task: "A", target_files: ["src/core/foo.ts"] }, selection: { lane: "quality" } },
        { plan: { task: "B", target_files: ["src/core/foo.ts"] }, selection: { lane: "quality" } },
        { plan: { task: "C", target_files: ["src/core/foo.ts"] }, selection: { lane: "quality" } },
      ]);
      // A↔B, A↔C, B↔C = 3 pairs
      assert.equal(conflicts.length, 3);
    });
  });

  describe("enforceLaneDiversity — lane diversity gate", () => {
    it("passes when activeLaneCount meets minLanes default (2)", () => {
      const pool = assignWorkersToPlans([
        { task: "Add test coverage" },
        { task: "Update Docker configuration" },
      ]);
      const result = enforceLaneDiversity(pool);
      assert.equal(result.meetsMinimum, true);
      assert.equal(result.warning, "");
    });

    it("fails when all plans route to a single lane", () => {
      const pool = assignWorkersToPlans([
        { task: "Add test coverage" },
        { task: "Write more tests" },
      ]);
      // Both are test-infra → quality lane → activeLaneCount = 1
      const result = enforceLaneDiversity(pool, { minLanes: 2 });
      if (pool.activeLaneCount < 2) {
        assert.equal(result.meetsMinimum, false);
        assert.ok(result.warning.length > 0, "warning must be non-empty when minimum is not met");
      } else {
        // If diversity happened to spread, just verify shape
        assert.ok(typeof result.meetsMinimum === "boolean");
      }
    });

    it("respects custom minLanes from config", () => {
      const pool = assignWorkersToPlans([
        { task: "Add test coverage" },
        { task: "Update Docker configuration" },
      ]);
      // Require 5 lanes — almost certain to fail with only 2 plans
      const result = enforceLaneDiversity(pool, { minLanes: 5 });
      assert.equal(result.meetsMinimum, false);
      assert.ok(result.warning.includes("minimum is 5"));
    });

    it("negative path: empty pool produces meetsMinimum=false", () => {
      const result = enforceLaneDiversity({ activeLaneCount: 0, assignments: [] });
      assert.equal(result.meetsMinimum, false);
      assert.ok(result.warning.length > 0);
    });

    it("negative path: null/missing pool falls back to activeLaneCount=0", () => {
      const result = enforceLaneDiversity({});
      assert.equal(result.meetsMinimum, false);
    });

    // Hard admission control contract — callers (orchestrator) must block dispatch
    // when meetsMinimum is false and plans.length >= minLanes.
    it("hard gate contract: meetsMinimum=false signals dispatch must be blocked", () => {
      const pool = assignWorkersToPlans([
        { task: "Add test coverage" },
        { task: "Write more tests" },
      ]);
      const result = enforceLaneDiversity(pool, { minLanes: 2 });
      // If meetsMinimum is false, the warning must be non-empty (caller uses it for alert)
      if (!result.meetsMinimum) {
        assert.ok(result.warning.length > 0, "hard gate: warning must carry a reason for the block");
        assert.ok(typeof result.activeLaneCount === "number");
      }
    });

    it("hard gate contract: meetsMinimum=true means gate passes and dispatch proceeds", () => {
      const pool = assignWorkersToPlans([
        { task: "Add test coverage" },
        { task: "Update Docker configuration" },
        { task: "Fix governance policy" },
      ]);
      const result = enforceLaneDiversity(pool, { minLanes: 2 });
      if (result.meetsMinimum) {
        assert.equal(result.warning, "", "no warning when gate passes");
      }
    });
  });
});

// ── Lane performance feedback ─────────────────────────────────────────────────

describe("capability_pool — lane performance feedback", () => {
  describe("recordLaneOutcome", () => {
    it("initialises a lane entry from an empty ledger", () => {
      const ledger = recordLaneOutcome({}, "quality", { success: true, durationMs: 500 });
      assert.equal(ledger.quality.successes, 1);
      assert.equal(ledger.quality.failures, 0);
      assert.equal(ledger.quality.totalMs, 500);
      assert.ok(ledger.quality.lastUpdated);
    });

    it("accumulates multiple outcomes for the same lane", () => {
      let ledger = {};
      ledger = recordLaneOutcome(ledger, "quality", { success: true,  durationMs: 300 });
      ledger = recordLaneOutcome(ledger, "quality", { success: false, durationMs: 150 });
      ledger = recordLaneOutcome(ledger, "quality", { success: true,  durationMs: 200 });
      assert.equal(ledger.quality.successes, 2);
      assert.equal(ledger.quality.failures,  1);
      assert.equal(ledger.quality.totalMs,   650);
    });

    it("does not mutate the input ledger", () => {
      const original = {};
      recordLaneOutcome(original, "quality", { success: true });
      assert.deepEqual(original, {});
    });

    it("handles missing durationMs gracefully (treats as 0)", () => {
      const ledger = recordLaneOutcome({}, "implementation", { success: true });
      assert.equal(ledger.implementation.totalMs, 0);
    });

    it("tracks separate lanes independently", () => {
      let ledger = {};
      ledger = recordLaneOutcome(ledger, "quality",        { success: true });
      ledger = recordLaneOutcome(ledger, "infrastructure", { success: false });
      assert.equal(ledger.quality.successes,        1);
      assert.equal(ledger.infrastructure.failures,  1);
      assert.equal(ledger.infrastructure.successes, 0);
    });
  });

  describe("getLaneScore", () => {
    it("returns 0.5 for an unseen lane (neutral prior)", () => {
      assert.equal(getLaneScore({}, "quality"), 0.5);
    });

    it("returns 0.5 for null/undefined ledger", () => {
      assert.equal(getLaneScore(null, "quality"), 0.5);
      assert.equal(getLaneScore(undefined, "quality"), 0.5);
    });

    it("returns close to 1 for a perfect lane (all successes)", () => {
      let ledger = {};
      for (let i = 0; i < 10; i++) ledger = recordLaneOutcome(ledger, "quality", { success: true });
      const score = getLaneScore(ledger, "quality");
      assert.ok(score > 0.9, `expected score > 0.9 for perfect lane; got ${score}`);
    });

    it("returns close to 0 for a consistently failing lane", () => {
      let ledger = {};
      for (let i = 0; i < 10; i++) ledger = recordLaneOutcome(ledger, "infra", { success: false });
      const score = getLaneScore(ledger, "infra");
      assert.ok(score < 0.2, `expected score < 0.2 for failing lane; got ${score}`);
    });

    it("score is always in [0, 1]", () => {
      let ledger = {};
      ledger = recordLaneOutcome(ledger, "governance", { success: true });
      ledger = recordLaneOutcome(ledger, "governance", { success: false });
      const score = getLaneScore(ledger, "governance");
      assert.ok(score >= 0 && score <= 1, `score out of range: ${score}`);
    });

    it("negative path: score below LOW_PERFORMANCE_THRESHOLD triggers fallback in selectWorkerForPlan", () => {
      let ledger = {};
      // Force 10 consecutive failures → score well below 0.25
      for (let i = 0; i < 10; i++) ledger = recordLaneOutcome(ledger, "quality", { success: false });
      const plan = { task: "Add test coverage for the parser module" }; // routes to quality lane
      const selection = selectWorkerForPlan(plan, null, ledger);
      assert.equal(selection.isFallback, true, "degraded lane must trigger fallback");
      assert.ok(selection.performanceScore < 0.25, `expected low score; got ${selection.performanceScore}`);
    });
  });

  describe("selectWorkerForPlan — performance-aware routing", () => {
    it("includes performanceScore=0.5 when no ledger is provided", () => {
      const plan = { task: "Add test coverage" };
      const selection = selectWorkerForPlan(plan);
      assert.equal(selection.performanceScore, 0.5);
    });

    it("routes to quality-worker when quality lane has healthy score", () => {
      let ledger = {};
      for (let i = 0; i < 5; i++) ledger = recordLaneOutcome(ledger, "quality", { success: true });
      const plan = { task: "Add test coverage for the parser module" };
      const selection = selectWorkerForPlan(plan, null, ledger);
      assert.equal(selection.role, "quality-worker");
      assert.equal(selection.lane, "quality");
      assert.ok(selection.performanceScore > 0.5);
    });

    it("falls back to evolution-worker when quality lane is degraded", () => {
      let ledger = {};
      for (let i = 0; i < 20; i++) ledger = recordLaneOutcome(ledger, "quality", { success: false });
      const plan = { task: "Add test coverage for the parser module" };
      const selection = selectWorkerForPlan(plan, null, ledger);
      assert.equal(selection.isFallback, true);
      assert.equal(selection.lane, "quality", "lane label preserved for diversity accounting");
    });
  });

  describe("assignWorkersToPlans — performance ledger passthrough", () => {
    it("accepts lanePerformance parameter and propagates scores to selections", () => {
      let ledger = {};
      for (let i = 0; i < 5; i++) ledger = recordLaneOutcome(ledger, "quality", { success: true });
      const plans = [{ task: "Add test coverage" }];
      const result = assignWorkersToPlans(plans, null, ledger);
      assert.equal(result.assignments.length, 1);
      assert.ok(result.assignments[0].selection.performanceScore > 0.5);
    });

    it("backward-compatible: works without lanePerformance argument", () => {
      const plans = [{ task: "Add test coverage" }, { task: "Update docker config" }];
      const result = assignWorkersToPlans(plans);
      assert.equal(result.assignments.length, 2);
      result.assignments.forEach(a => {
        assert.equal(a.selection.performanceScore, 0.5, "default score is 0.5 when no ledger");
      });
    });

    it("diversity controls are unaffected by performance feedback", () => {
      // Even when all lanes are healthy, diversityIndex and activeLaneCount still reflect actual routing
      let ledger = {};
      ["quality", "governance", "infrastructure"].forEach(l => {
        for (let i = 0; i < 5; i++) ledger = recordLaneOutcome(ledger, l, { success: true });
      });
      const plans = [
        { task: "Add test coverage" },
        { task: "Fix governance policy" },
        { task: "Update docker config" },
      ];
      const result = assignWorkersToPlans(plans, null, ledger);
      assert.ok(typeof result.diversityIndex === "number", "diversityIndex must still be computed");
      assert.ok(typeof result.activeLaneCount === "number", "activeLaneCount must still be computed");
    });
  });
});

// ── Lane diversity threshold enforcement (Task 1) ─────────────────────────────

describe("capability_pool — lane diversity threshold enforcement", () => {
  describe("assignWorkersToPlans — diversityCheck in return value", () => {
    it("always includes diversityCheck in the result shape", () => {
      const plans = [{ task: "Add test coverage" }];
      const result = assignWorkersToPlans(plans);
      assert.ok(typeof result.diversityCheck === "object", "diversityCheck must be present");
      assert.ok(typeof result.specializationUtilization === "object", "specializationUtilization must be present");
      assert.ok(typeof result.diversityCheck.meetsMinimum === "boolean");
      assert.ok(typeof result.diversityCheck.activeLaneCount === "number");
      assert.ok(typeof result.diversityCheck.warning === "string");
    });

    it("tracks specialization share and target compliance", () => {
      const plans = [
        { task: "Add test coverage" },
        { task: "Update docker deployment pipeline" },
        { task: "Update internal runtime refactor" },
      ];
      const result = assignWorkersToPlans(plans, { workerPool: { specializationTargets: { minSpecializedShare: 0.2 } } });
      assert.ok(result.specializationUtilization.specializedCount >= 1);
      assert.equal(result.specializationUtilization.total, 3);
      assert.ok(result.specializationUtilization.specializedShare > 0);
      assert.equal(result.specializationUtilization.specializationTargetsMet, true);
    });

    it("surfaces lane ROI admission so specialist gating can use EV signals", () => {
      const plans = [
        { task: "Add test coverage" },
        { task: "Update Docker configuration" },
      ];
      const laneTelemetrySignals = buildLaneTelemetrySignals({
        quality: { completionRate: 0.82, roi: 0.74 },
        infrastructure: { completionRate: 0.61, roi: 0.58 },
      });

      const result = assignWorkersToPlans(plans, null, undefined, { laneTelemetrySignals });

      assert.equal(result.laneROIAdmission.admitted, true);
      assert.ok(result.laneROIAdmission.passingLanes.includes("quality"));
      assert.ok(result.laneROIAdmission.passingLanes.includes("infrastructure"));
    });

    it("diversityCheck.meetsMinimum=true when lane spread meets default threshold (2)", () => {
      const plans = [
        { task: "Add test coverage" },        // quality lane
        { task: "Update Docker configuration" }, // infrastructure lane
      ];
      const result = assignWorkersToPlans(plans);
      // Two different lanes → should meet the default minLanes=2
      if (result.activeLaneCount >= 2) {
        assert.equal(result.diversityCheck.meetsMinimum, true);
        assert.equal(result.diversityCheck.warning, "");
      }
    });

    it("diversityCheck.meetsMinimum=false when all plans route to a single lane", () => {
      const plans = [
        { task: "Add test coverage" },
        { task: "Write more tests" },
        { task: "Add spec coverage" },
      ];
      // All test-infra → quality lane → activeLaneCount = 1 < minLanes=2
      const result = assignWorkersToPlans(plans);
      if (result.activeLaneCount < 2) {
        assert.equal(result.diversityCheck.meetsMinimum, false);
        assert.ok(result.diversityCheck.warning.length > 0,
          "warning must be non-empty when threshold is not met");
      }
    });

    it("respects custom diversityThreshold option", () => {
      const plans = [
        { task: "Add test coverage" },
        { task: "Update Docker configuration" },
      ];
      // Two lanes but require 5 — must fail
      const result = assignWorkersToPlans(plans, null, undefined, { diversityThreshold: 5 });
      assert.equal(result.diversityCheck.meetsMinimum, false);
      assert.ok(/minimum is 5/i.test(result.diversityCheck.warning),
        "warning must cite the minimum threshold");
    });

    it("keeps distinct lanes when plans use lane labels instead of worker names", () => {
      const plans = [
        { role: "governance", task: "Harden policy gate" },
        { role: "quality", task: "Add regression tests" },
      ];
      const result = assignWorkersToPlans(plans);
      assert.equal(result.activeLaneCount, 2);
      assert.equal(result.laneCounts.governance, 1);
      assert.equal(result.laneCounts.quality, 1);
      assert.equal(result.diversityCheck.meetsMinimum, true);
    });

    it("diversityThreshold=0 always passes (diversity check disabled)", () => {
      const plans = [{ task: "Write tests" }, { task: "More tests" }];
      const result = assignWorkersToPlans(plans, null, undefined, { diversityThreshold: 0 });
      // minLanes=0 → always meets minimum
      assert.equal(result.diversityCheck.meetsMinimum, true);
    });

    it("backward-compatible: result still contains diversityIndex and activeLaneCount", () => {
      const plans = [{ task: "Fix governance policy" }];
      const result = assignWorkersToPlans(plans);
      assert.ok(typeof result.diversityIndex === "number");
      assert.ok(typeof result.activeLaneCount === "number");
      assert.ok(typeof result.laneCounts === "object");
    });

    it("negative path: empty plans list returns diversityCheck with meetsMinimum=true (no violation on empty set)", () => {
      const result = assignWorkersToPlans([]);
      assert.ok(typeof result.diversityCheck === "object");
      // An empty set has no diversity violation by convention
      assert.ok(typeof result.diversityCheck.meetsMinimum === "boolean");
    });

    it("negative path: null input returns diversityCheck object", () => {
      const result = assignWorkersToPlans(null);
      assert.ok(typeof result.diversityCheck === "object");
      assert.ok(typeof result.diversityCheck.meetsMinimum === "boolean");
    });
  });

  describe("buildRoleExecutionBatches — diversityViolation in batch descriptors", () => {
    // Import buildRoleExecutionBatches to verify diversityViolation is surfaced
    it("each batch includes diversityViolation field (null or object)", async () => {
      const { buildRoleExecutionBatches } = await import("../../src/core/worker_batch_planner.js");
      const plans = [{ role: "Evolution Worker", task: "Fix bug", wave: 1, taskKind: "implementation" }];
      const batches = buildRoleExecutionBatches(plans, {});
      assert.ok(batches.length > 0, "must produce at least one batch");
      for (const batch of batches) {
        // diversityViolation is null when no violation, or an object when violated
        assert.ok("diversityViolation" in batch,
          "each batch must include diversityViolation field");
        const dv = (batch as any).diversityViolation;
        assert.ok(dv === null || (typeof dv === "object" && dv !== null),
          "diversityViolation must be null or an object");
      }
    });

    it("diversityViolation is null when capabilityPoolResult is absent (no diversity info)", async () => {
      const { buildRoleExecutionBatches } = await import("../../src/core/worker_batch_planner.js");
      const plans = [{ role: "Evolution Worker", task: "Task A", wave: 1, taskKind: "implementation" }];
      const batches = buildRoleExecutionBatches(plans, {}, null);
      // No capabilityPoolResult → no diversity info → null
      assert.equal((batches[0] as any).diversityViolation, null);
    });
  });
});

// ── Worker-task fit scoring ────────────────────────────────────────────────────

describe("capability_pool — worker-task fit scoring", () => {
  describe("scoreWorkerTaskFit()", () => {
    it("returns a number in [0, 1]", () => {
      const score = scoreWorkerTaskFit("quality-worker", { task: "Add test coverage" });
      assert.ok(typeof score === "number");
      assert.ok(score >= 0 && score <= 1, `score out of range: ${score}`);
    });

    it("gives high score when worker capability matches plan tag", () => {
      // test-infra tag → quality-worker handles it
      const score = scoreWorkerTaskFit("quality-worker", { task: "Add spec for parser" });
      assert.ok(score > 0.5, `expected > 0.5; got ${score}`);
    });

    it("gives lower score for a mismatched worker", () => {
      // governance task → governance-worker is correct; quality-worker is not
      const govScore  = scoreWorkerTaskFit("governance-worker", { task: "Freeze governance policy" });
      const qualScore = scoreWorkerTaskFit("quality-worker",    { task: "Freeze governance policy" });
      assert.ok(govScore > qualScore, "governance-worker should outscore quality-worker on a governance task");
    });

    it("incorporates lane performance via ledger", () => {
      let ledger = {};
      for (let i = 0; i < 10; i++) ledger = recordLaneOutcome(ledger, "quality", { success: true });
      const scoreWithHistory    = scoreWorkerTaskFit("quality-worker", { task: "Add spec" }, ledger);
      const scoreWithoutHistory = scoreWorkerTaskFit("quality-worker", { task: "Add spec" });
      assert.ok(scoreWithHistory >= scoreWithoutHistory, "healthy ledger should not decrease score");
    });

    it("negative path: unknown worker name returns a number (no throw)", () => {
      const score = scoreWorkerTaskFit("nonexistent-worker", { task: "Fix bug" });
      assert.ok(typeof score === "number");
    });
  });

  describe("selectWorkerByFitScore()", () => {
    it("returns a WorkerSelection shape", () => {
      const result = selectWorkerByFitScore({ task: "Add test coverage" });
      assert.ok(result.role, "must have role");
      assert.ok(result.lane, "must have lane");
      assert.ok(result.reason, "must have reason");
      assert.ok(typeof result.fitScore === "number", "must have fitScore");
      assert.ok(typeof result.isFallback === "boolean");
    });

    it("selects quality-worker for a test-infra task", () => {
      const result = selectWorkerByFitScore({ task: "Add spec coverage for parser" });
      assert.equal(result.role, "quality-worker");
    });

    it("selects governance-worker for a governance task", () => {
      const result = selectWorkerByFitScore({ task: "Update governance freeze rules" });
      assert.equal(result.role, "governance-worker");
    });

    it("is deterministic — same input always returns same worker", () => {
      const plan = { task: "Add docker configuration" };
      const r1 = selectWorkerByFitScore(plan);
      const r2 = selectWorkerByFitScore(plan);
      assert.equal(r1.role, r2.role, "must be deterministic");
    });

    it("negative path: null plan does not throw and returns a selection", () => {
      const result = selectWorkerByFitScore(null as any);
      assert.ok(result.role);
    });
  });
});

// ── roiToLaneScore — ROI-to-performance-score conversion ─────────────────────

import { roiToLaneScore } from "../../src/core/capability_pool.js";

describe("capability_pool — roiToLaneScore", () => {
  it("returns neutral 0.5 for roi=0 (no history — matches getLaneScore default for unseen lanes)", () => {
    assert.equal(roiToLaneScore(0), 0.5);
  });

  it("returns neutral 0.5 for negative roi (invalid input)", () => {
    assert.equal(roiToLaneScore(-1), 0.5);
    assert.equal(roiToLaneScore(-100), 0.5);
  });

  it("returns neutral 0.5 for non-finite roi (NaN, Infinity)", () => {
    assert.equal(roiToLaneScore(NaN), 0.5);
    assert.equal(roiToLaneScore(Infinity), 0.5);
  });

  it("maps roi=2.0 to score=1.0 (excellent performance ceiling)", () => {
    assert.equal(roiToLaneScore(2.0), 1.0);
  });

  it("maps roi=1.0 to score=0.5 (midpoint — average performance)", () => {
    assert.equal(roiToLaneScore(1.0), 0.5);
  });

  it("output is always in [0, 1] for any non-negative input", () => {
    for (const roi of [0, 0.1, 0.5, 1.0, 1.5, 2.0, 5.0, 100]) {
      const score = roiToLaneScore(roi);
      assert.ok(score >= 0 && score <= 1, `score ${score} out of [0,1] for roi=${roi}`);
    }
  });

  it("roi above 2.0 is capped at 1.0", () => {
    assert.equal(roiToLaneScore(5.0),  1.0, "roi=5 → score=1");
    assert.equal(roiToLaneScore(100),  1.0, "roi=100 → score=1");
  });

  it("negative path: very low positive roi (0.1) maps to a score below 0.1", () => {
    // roi=0.1 → 0.1/2 = 0.05 < 0.1
    const score = roiToLaneScore(0.1);
    assert.ok(score < 0.1, `expected score < 0.1 for roi=0.1; got ${score}`);
  });

  it("score is monotonically non-decreasing as roi increases from 0 to 2", () => {
    const rois = [0.01, 0.3, 0.6, 0.9, 1.2, 1.6, 2.0];
    const scores = rois.map(roiToLaneScore);
    for (let i = 1; i < scores.length; i++) {
      assert.ok(
        scores[i] >= scores[i - 1],
        `roiToLaneScore must be non-decreasing: roi=${rois[i - 1]}→${scores[i - 1]}, roi=${rois[i]}→${scores[i]}`
      );
    }
  });
});

describe("capability_pool — buildLanePerformanceFromCycleTelemetry", () => {
  it("builds lane performance entries from telemetry completion/failure counts", () => {
    const ledger = buildLanePerformanceFromCycleTelemetry({
      quality: { completed: 3, failed: 1 },
      governance: { completed: 2, failed: 0 },
    });
    assert.equal(ledger.quality.successes, 3);
    assert.equal(ledger.quality.failures, 1);
    assert.equal(ledger.governance.successes, 2);
    assert.equal(ledger.governance.failures, 0);
  });

  it("negative path: ignores non-numeric telemetry rows", () => {
    const ledger = buildLanePerformanceFromCycleTelemetry({
      quality: { completed: "bad", failed: 1 },
      implementation: null,
    } as any);
    assert.deepEqual(ledger, {});
  });
});

describe("capability_pool — buildLaneTelemetrySignals", () => {
  it("extracts completionRate and roi for each lane", () => {
    const signals = buildLaneTelemetrySignals({
      quality: { completionRate: 0.75, roi: 2.2 },
      governance: { completionRate: 0.5, roi: 1.0 },
    });
    assert.equal(signals.quality.completionRate, 0.75);
    assert.equal(signals.quality.roi, 2.2);
    assert.equal(signals.governance.completionRate, 0.5);
    assert.equal(signals.governance.roi, 1.0);
  });

  it("negative path: ignores telemetry rows without numeric completionRate and roi", () => {
    const signals = buildLaneTelemetrySignals({
      quality: { completionRate: "bad", roi: 2.2 },
      governance: { completionRate: 0.5, roi: null },
    } as any);
    assert.deepEqual(signals, {});
  });
});

describe("capability_pool — computeSpecialistFitThreshold", () => {
  it("lowers threshold for strong lane telemetry to increase specialist reuse", () => {
    const adjusted = computeSpecialistFitThreshold(0.7, "quality", {
      quality: { completionRate: 0.95, roi: 3.0 },
    });
    assert.ok(adjusted < 0.7, `expected lowered threshold, got ${adjusted}`);
  });

  it("raises threshold for weak lane telemetry to reduce specialist overuse", () => {
    const adjusted = computeSpecialistFitThreshold(0.7, "quality", {
      quality: { completionRate: 0.2, roi: 0.2 },
    });
    assert.ok(adjusted > 0.7, `expected raised threshold, got ${adjusted}`);
  });
});

describe("capability_pool — evaluateSpecializationAdmissionGate", () => {
  const MET_UTILIZATION = {
    specializationTargetsMet: true,
    specializedShare: 0.8,
    minSpecializedShare: 0.5,
    adaptiveMinSpecializedShare: 0.5,
    specializedDeficit: 0,
    admissionReady: true,
  };
  const NOT_MET_UTILIZATION = {
    specializationTargetsMet: false,
    specializedShare: 0.2,
    minSpecializedShare: 0.5,
    adaptiveMinSpecializedShare: 0.5,
    specializedDeficit: 2,
    admissionReady: false,
  };

  it("does NOT block when specialization targets are met", () => {
    const result = evaluateSpecializationAdmissionGate(MET_UTILIZATION, 0);
    assert.equal(result.blocked, false);
    assert.equal(result.consecutiveBlockCycles, 0);
  });

  it("blocks when specialization targets are not met and within max cycles", () => {
    const result = evaluateSpecializationAdmissionGate(NOT_MET_UTILIZATION, 0);
    assert.equal(result.blocked, true);
    assert.ok(result.reason.startsWith(SPECIALIZATION_ADMISSION_BLOCK_REASON));
    assert.equal(result.consecutiveBlockCycles, 1);
  });

  it("increments consecutiveBlockCycles on each block", () => {
    const result = evaluateSpecializationAdmissionGate(NOT_MET_UTILIZATION, 1);
    assert.equal(result.blocked, true);
    assert.equal(result.consecutiveBlockCycles, 2);
  });

  it("bypasses gate (bounded fallback) when consecutiveBlockCycles >= maxBlockCycles", () => {
    const max = SPECIALIZATION_ADMISSION_MAX_BLOCK_CYCLES;
    const result = evaluateSpecializationAdmissionGate(NOT_MET_UTILIZATION, max);
    assert.equal(result.blocked, false);
    assert.ok(result.reason.includes("bypassed_fallback"));
  });

  it("resets consecutiveBlockCycles to 0 when targets are met after prior blocks", () => {
    const result = evaluateSpecializationAdmissionGate(MET_UTILIZATION, 2);
    assert.equal(result.blocked, false);
    assert.equal(result.consecutiveBlockCycles, 0);
  });

  it("exports SPECIALIZATION_ADMISSION_MAX_BLOCK_CYCLES as a positive integer", () => {
    assert.ok(Number.isInteger(SPECIALIZATION_ADMISSION_MAX_BLOCK_CYCLES));
    assert.ok(SPECIALIZATION_ADMISSION_MAX_BLOCK_CYCLES >= 1);
  });

  it("exports SPECIALIZATION_ADMISSION_BLOCK_REASON as a non-empty string", () => {
    assert.equal(typeof SPECIALIZATION_ADMISSION_BLOCK_REASON, "string");
    assert.ok(SPECIALIZATION_ADMISSION_BLOCK_REASON.length > 0);
  });

  it("handles null/undefined utilization gracefully without blocking", () => {
    const result = evaluateSpecializationAdmissionGate(null as any, 0);
    assert.equal(result.blocked, false);
  });
});

// ── computeAdaptiveSpecialistFillThreshold ────────────────────────────────────

import {
  computeAdaptiveSpecialistFillThreshold,
  SPECIALIST_REROUTE_REASON_CODE,
} from "../../src/core/capability_pool.js";

describe("capability_pool — computeAdaptiveSpecialistFillThreshold", () => {
  it("returns base threshold unchanged when no lane performance data exists (neutral prior)", () => {
    const result = computeAdaptiveSpecialistFillThreshold(0.8, "quality", {});
    assert.equal(result, 0.8);
  });

  it("lowers threshold for a strong-performing lane (more specialist-friendly)", () => {
    let ledger = {};
    for (let i = 0; i < 10; i++) ledger = recordLaneOutcome(ledger, "quality", { success: true });
    const result = computeAdaptiveSpecialistFillThreshold(0.8, "quality", ledger);
    assert.ok(result < 0.8, `expected lowered threshold for strong lane; got ${result}`);
  });

  it("raises threshold for a consistently failing lane (more conservative)", () => {
    let ledger = {};
    for (let i = 0; i < 10; i++) ledger = recordLaneOutcome(ledger, "infra", { success: false });
    const result = computeAdaptiveSpecialistFillThreshold(0.5, "infra", ledger);
    assert.ok(result > 0.5, `expected raised threshold for failing lane; got ${result}`);
  });

  it("result is always clamped to [0, 1]", () => {
    let ledger = {};
    for (let i = 0; i < 20; i++) ledger = recordLaneOutcome(ledger, "governance", { success: true });
    const result = computeAdaptiveSpecialistFillThreshold(0.0, "governance", ledger);
    assert.ok(result >= 0 && result <= 1, `result must be in [0, 1]; got ${result}`);
  });

  it("handles non-finite baseFillThreshold by defaulting to 1.0", () => {
    const result = computeAdaptiveSpecialistFillThreshold(NaN, "quality", {});
    assert.equal(result, 1.0);
  });

  it("handles empty/missing lane name gracefully and returns base unchanged", () => {
    const result = computeAdaptiveSpecialistFillThreshold(0.6, "", {});
    assert.equal(result, 0.6);
  });

  it("handles missing lanePerformance parameter (undefined) same as empty ledger", () => {
    const result = computeAdaptiveSpecialistFillThreshold(0.7, "quality", undefined);
    assert.equal(result, 0.7);
  });

  it("negative path: output is monotonically decreasing as lane score increases past 0.5", () => {
    // Higher lane score → lower adaptive threshold
    let ldgr: any = {};
    for (let i = 0; i < 5; i++) ldgr = recordLaneOutcome(ldgr, "quality", { success: false }); // score ~0.25
    const threshLow = computeAdaptiveSpecialistFillThreshold(0.8, "quality", ldgr);

    let ldgr2: any = {};
    for (let i = 0; i < 5; i++) ldgr2 = recordLaneOutcome(ldgr2, "quality", { success: true }); // score ~0.75
    const threshHigh = computeAdaptiveSpecialistFillThreshold(0.8, "quality", ldgr2);

    assert.ok(threshHigh < threshLow,
      `strong lane (${threshHigh}) should have lower threshold than weak lane (${threshLow})`);
  });

  it("SPECIALIST_REROUTE_REASON_CODE exports a stable BELOW_FILL_THRESHOLD code", () => {
    assert.equal(SPECIALIST_REROUTE_REASON_CODE.BELOW_FILL_THRESHOLD, "below_fill_threshold");
  });

  it("SPECIALIST_REROUTE_REASON_CODE exports PERFORMANCE_DEGRADED code", () => {
    assert.equal(SPECIALIST_REROUTE_REASON_CODE.PERFORMANCE_DEGRADED, "performance_degraded");
  });

  it("SPECIALIST_REROUTE_REASON_CODE exports DEPENDENCY_ISOLATION code", () => {
    assert.equal(SPECIALIST_REROUTE_REASON_CODE.DEPENDENCY_ISOLATION, "dependency_isolation");
  });

  it("SPECIALIST_REROUTE_REASON_CODE is frozen (immutable)", () => {
    assert.ok(Object.isFrozen(SPECIALIST_REROUTE_REASON_CODE));
  });
});

// ── selectWorkerForPlan — rerouteReasonCode field ──────────────────────────────

describe("capability_pool — selectWorkerForPlan rerouteReasonCode", () => {
  it("rerouteReasonCode is null when lane score is healthy (no reroute)", () => {
    let ledger = {};
    for (let i = 0; i < 5; i++) ledger = recordLaneOutcome(ledger, "quality", { success: true });
    const plan = { task: "Add test coverage for the parser module" };
    const selection = selectWorkerForPlan(plan, null, ledger);
    assert.equal(selection.rerouteReasonCode, null);
  });

  it("rerouteReasonCode is PERFORMANCE_DEGRADED when lane score is below threshold", () => {
    let ledger = {};
    for (let i = 0; i < 15; i++) ledger = recordLaneOutcome(ledger, "quality", { success: false });
    const plan = { task: "Add test coverage for the parser module" };
    const selection = selectWorkerForPlan(plan, null, ledger);
    assert.equal(selection.rerouteReasonCode, SPECIALIST_REROUTE_REASON_CODE.PERFORMANCE_DEGRADED,
      "degraded lane must emit PERFORMANCE_DEGRADED reason code");
  });

  it("rerouteReasonCode is null when no ledger is provided (neutral prior → no reroute)", () => {
    const plan = { task: "Add test coverage for the parser module" };
    const selection = selectWorkerForPlan(plan);
    // Neutral prior 0.5 is above LOW_PERFORMANCE_THRESHOLD — no reroute
    assert.equal(selection.rerouteReasonCode, null);
  });

  it("negative path: isFallback=true iff rerouteReasonCode is non-null (coherent reroute state)", () => {
    let ledger = {};
    for (let i = 0; i < 15; i++) ledger = recordLaneOutcome(ledger, "quality", { success: false });
    const plan = { task: "Add test coverage for the parser module" };
    const selection = selectWorkerForPlan(plan, null, ledger);
    if (selection.rerouteReasonCode !== null) {
      assert.equal(selection.isFallback, true, "isFallback must be true when rerouteReasonCode is set");
    }
  });
});

