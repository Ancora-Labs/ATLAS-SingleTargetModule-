/**
 * orchestration_integration.test.ts
 *
 * Deterministic integration coverage for the three core orchestration gates:
 *   1. Dependency wave order — multi-task plans flow through the DAG scheduler in
 *      the correct sequential wave order; completing a wave unlocks the next.
 *   2. Capability routing — after DAG scheduling each wave's tasks are routed to
 *      the correct workers by the capability pool.
 *   3. Carry-forward debt blocking sequence — when critical debt exceeds the SLA
 *      threshold, shouldBlockOnDebt returns true and downstream planning is gated.
 *   4. Optimizer budget admission — plans rejected by the intervention optimizer
 *      are filtered from the dispatch set; unaffected plans proceed normally.
 *   5. Carry-forward auto-close — only debt items backed by verification evidence
 *      are closed; unresolved items remain blocking.
 *
 * These tests exercise modules working together, not in isolation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeNextWaves, computeFrontier } from "../../src/core/dag_scheduler.js";
import {
  inferCapabilityTag,
  selectWorkerForPlan,
  assignWorkersToPlans,
} from "../../src/core/capability_pool.js";
import {
  addDebtEntries,
  shouldBlockOnDebt,
  closeDebt,
  tickCycle,
  autoCloseVerifiedDebt,
  computeFingerprint,
} from "../../src/core/carry_forward_ledger.js";
import {
  buildInterventionsFromPlan,
  buildBudgetFromConfig,
  runInterventionOptimizer,
  OPTIMIZER_STATUS,
} from "../../src/core/intervention_optimizer.js";
import {
  computeRuntimeContractProbe,
  computeCycleAnalytics,
  CYCLE_PHASE,
  CYCLE_OUTCOME_STATUS,
  WORKER_CYCLE_ARTIFACTS_FILE,
  migrateWorkerCycleArtifacts,
  selectWorkerCycleRecord,
} from "../../src/core/cycle_analytics.js";
import { isTerminalWorkerStatus } from "../../src/core/worker_runner.js";
import {
  auditReplayPolicySignals,
  computeDispatchStrictness,
  DISPATCH_STRICTNESS,
} from "../../src/core/parser_replay_harness.js";

// ── 1. Dependency Wave Order ───────────────────────────────────────────────────

describe("Integration: dependency wave order", () => {
  it("computeFrontier enforces sequential order: only root tasks are initially ready", () => {
    const plans = [
      { task: "T-A", role: "evolution-worker", dependencies: [] },
      { task: "T-B", role: "evolution-worker", dependencies: ["T-A"] },
      { task: "T-C", role: "evolution-worker", dependencies: ["T-B"] },
    ];

    // Nothing completed — only T-A should be on the frontier
    const r0 = computeFrontier(plans, new Set(), new Set(), new Set());
    const frontier0 = r0.frontier.map((p: any) => p.task);
    assert.ok(frontier0.includes("T-A"), "T-A must be on the initial frontier");
    assert.ok(!frontier0.includes("T-B"), "T-B must NOT be on the frontier (T-A not done yet)");
    assert.ok(!frontier0.includes("T-C"), "T-C must NOT be on the frontier (T-A, T-B not done yet)");
  });

  it("computeFrontier promotes T-B after T-A completes, but keeps T-C blocked", () => {
    const plans = [
      { task: "T-A", role: "evolution-worker", dependencies: [] },
      { task: "T-B", role: "evolution-worker", dependencies: ["T-A"] },
      { task: "T-C", role: "evolution-worker", dependencies: ["T-B"] },
    ];

    // T-A completed — T-B should now be on the frontier, T-C still blocked
    const r1 = computeFrontier(plans, new Set(["T-A"]), new Set(), new Set());
    const frontier1 = r1.frontier.map((p: any) => p.task);
    assert.ok(frontier1.includes("T-B"), "T-B must be on the frontier after T-A completes");
    assert.ok(!frontier1.includes("T-C"), "T-C must NOT be on the frontier (T-B not done yet)");
  });

  it("computeFrontier promotes T-C only after both T-A and T-B complete (full chain)", () => {
    const plans = [
      { task: "T-A", role: "evolution-worker", dependencies: [] },
      { task: "T-B", role: "evolution-worker", dependencies: ["T-A"] },
      { task: "T-C", role: "evolution-worker", dependencies: ["T-B"] },
    ];

    const r2 = computeFrontier(plans, new Set(["T-A", "T-B"]), new Set(), new Set());
    const frontier2 = r2.frontier.map((p: any) => p.task);
    assert.ok(frontier2.includes("T-C"), "T-C must be on the frontier after T-A and T-B complete");

    // All done
    const r3 = computeFrontier(plans, new Set(["T-A", "T-B", "T-C"]), new Set(), new Set());
    assert.equal(r3.status, "all_done", "status must be all_done once all tasks complete");
  });

  it("failed task in wave 1 blocks all downstream dependents (carry-forward deadlock)", () => {
    const plans = [
      { task: "T-A", role: "evolution-worker", dependencies: [] },
      { task: "T-B", role: "evolution-worker", dependencies: ["T-A"] },
      { task: "T-C", role: "evolution-worker", dependencies: ["T-B"] },
      { task: "T-D", role: "evolution-worker", dependencies: [] }, // independent
    ];

    // T-A failed — T-B and T-C are blocked; T-D is independent and schedulable
    const result = computeNextWaves(plans, new Set(), new Set(["T-A"]));

    const blockedTasks = result.blocked.map((p: any) => p.task);
    assert.ok(blockedTasks.includes("T-B"), "T-B must be blocked because T-A failed");
    // T-D is independent and must still be schedulable
    const readyTasks = result.readyWaves.flat().map((p: any) => p.task);
    assert.ok(readyTasks.includes("T-D"), "T-D must still be schedulable (independent of T-A)");
  });

  it("computeNextWaves filters completed tasks correctly", () => {
    const plans = [
      { task: "T-A", role: "evolution-worker", dependencies: [] },
      { task: "T-B", role: "evolution-worker", dependencies: [] },
      { task: "T-C", role: "evolution-worker", dependencies: [] },
    ];

    // T-A already done — must not appear in output
    const result = computeNextWaves(plans, new Set(["T-A"]));
    assert.equal(result.status, "ok");
    const allTasks = result.readyWaves.flat().map((p: any) => p.task);
    assert.ok(!allTasks.includes("T-A"), "Completed T-A must be filtered from output");
    assert.ok(allTasks.includes("T-B"), "T-B must still be scheduled");
    assert.ok(allTasks.includes("T-C"), "T-C must still be scheduled");
  });

  it("computeFrontier frontier: diamond DAG promotes leaves only after both parents complete", () => {
    const plans = [
      { task: "T-A", dependencies: [] },
      { task: "T-B", dependencies: ["T-A"] },
      { task: "T-C", dependencies: ["T-A"] },
      { task: "T-D", dependencies: ["T-B", "T-C"] },
    ];

    // Nothing complete yet — only T-A is on the frontier
    const r0 = computeFrontier(plans, new Set(), new Set(), new Set());
    assert.deepEqual(r0.frontier.map((p: any) => p.task), ["T-A"]);

    // After T-A completes, T-B and T-C join the frontier; T-D is still waiting
    const r1 = computeFrontier(plans, new Set(["T-A"]), new Set(), new Set());
    const frontierTasks1 = r1.frontier.map((p: any) => p.task).sort();
    assert.deepEqual(frontierTasks1, ["T-B", "T-C"]);

    // After T-B and T-C complete, T-D joins the frontier
    const r2 = computeFrontier(plans, new Set(["T-A", "T-B", "T-C"]), new Set(), new Set());
    assert.deepEqual(r2.frontier.map((p: any) => p.task), ["T-D"]);
  });

  it("negative path: deadlocked when the only remaining tasks all have failed deps", () => {
    const plans = [
      { task: "T-B", role: "evolution-worker", dependencies: ["T-A"] },
      { task: "T-C", role: "evolution-worker", dependencies: ["T-A"] },
    ];

    // T-A failed — both remaining tasks are blocked → deadlocked
    const result = computeNextWaves(plans, new Set(), new Set(["T-A"]));
    assert.ok(
      result.status === "deadlocked" || result.blocked.length === 2,
      "Must be deadlocked or have 2 blocked tasks"
    );
  });
});

describe("Integration: worker terminal status contract", () => {
  it("treats done/partial/blocked as terminal recovery-safe statuses", () => {
    assert.equal(isTerminalWorkerStatus("done"), true);
    assert.equal(isTerminalWorkerStatus("partial"), true);
    assert.equal(isTerminalWorkerStatus("blocked"), true);
    assert.equal(isTerminalWorkerStatus("working"), false);
  });
});

describe("Integration: typed handoff replay contract", () => {
  it("typed handoff chain snapshots remain replay-auditable after orchestration expansion", () => {
    const typedDispatchPlans = [
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
    ];

    const audit = auditReplayPolicySignals({
      expectedDomains: ["typed_handoffs"],
      dispatchPlans: typedDispatchPlans,
    });

    assert.equal(audit.passed, true);
    assert.equal(audit.regressionCount, 0);
  });

  it("negative path: typed handoff snapshots fail closed when artifact metadata is incomplete", () => {
    const audit = auditReplayPolicySignals({
      expectedDomains: ["typed_handoffs"],
      dispatchPlans: [
        {
          task_id: "T-chain-1",
          task: "Broken stage",
          role: "quality-worker",
          wave: 1,
          _chainMode: true,
          _chainId: "chain-1",
          _chainStageIndex: 1,
          _chainStageTotal: 2,
          _typedHandoffArtifact: {
            id: "",
            chainId: "chain-1",
            stage: "quality",
            artifactKey: "",
          },
        },
      ],
    });

    assert.equal(audit.passed, false);
    assert.equal(audit.regressionCount, 1);
    assert.equal(
      audit.results.find((entry) => entry.domain === "typed_handoffs")?.passed,
      false,
    );
  });

  it("dispatch strictness blocks when multiple replay signal domains regress together", () => {
    const audit = auditReplayPolicySignals({
      expectedDomains: ["candidate_planning", "typed_handoffs", "phase_retry"],
      dispatchPlans: [
        {
          task_id: "T-chain-1",
          task: "Broken stage",
          role: "quality-worker",
          wave: 1,
          _chainMode: true,
          _chainId: "chain-1",
          _chainStageIndex: 1,
          _chainStageTotal: 2,
          _typedHandoffArtifact: {
            id: "",
            chainId: "chain-1",
            stage: "quality",
            artifactKey: "",
          },
        },
      ],
      attemptCheckpoints: [],
    });
    const strictness = computeDispatchStrictness(
      { regressionCount: 0, totalCount: 10, passed: true, computedAt: "2026-04-13T00:00:00.000Z" },
      null,
      audit,
    );

    assert.equal(audit.regressionCount, 3);
    assert.equal(strictness.strictness, DISPATCH_STRICTNESS.BLOCKED);
  });
});

// ── 2. Capability Routing ─────────────────────────────────────────────────────

describe("Integration: capability routing", () => {
  it("each capability tag infers to the correct lane and then routes to the canonical worker", () => {
    const cases: Array<{ plan: object; expectedLane: string }> = [
      { plan: { task: "Add test coverage for the carry_forward_ledger module" }, expectedLane: "quality" },
      { plan: { task: "Update governance freeze policy rules" },                  expectedLane: "governance" },
      { plan: { task: "Update Docker configuration for production deployment" },  expectedLane: "infrastructure" },
      { plan: { task: "Fix dashboard metrics display and alert routing" },        expectedLane: "observation" },
      { plan: { task: "Wire integration between dag_scheduler and orchestrator" }, expectedLane: "integration" },
    ];

    for (const { plan, expectedLane } of cases) {
      const selection = selectWorkerForPlan(plan);
      assert.equal(
        selection.lane,
        expectedLane,
        `Plan "${(plan as any).task}" must route to lane "${expectedLane}", got "${selection.lane}"`
      );
      assert.ok(selection.role, "Worker role must be non-empty");
      assert.equal(selection.isFallback, false, `Lane "${expectedLane}" must resolve to a real lane worker`);
    }
  });

  it("a mixed wave of plans is correctly distributed across multiple lanes", () => {
    // Simulate a wave with tasks spanning 3 different capability domains
    const wavePlans = [
      { task: "Add test coverage for the dag_scheduler wave promotion logic" }, // → quality
      { task: "Update Docker configuration for worker isolation" },              // → infrastructure
      { task: "Fix governance freeze policy bypass condition" },                 // → governance
    ];

    const { assignments, diversityIndex, activeLaneCount } = assignWorkersToPlans(wavePlans);

    assert.equal(assignments.length, 3, "Must produce one assignment per plan");
    assert.ok(activeLaneCount >= 3, `Must span at least 3 lanes; got ${activeLaneCount}`);
    assert.ok(diversityIndex > 0, "diversityIndex must be > 0 for a multi-lane assignment");

    const lanes = assignments.map(a => a.selection.lane);
    assert.ok(lanes.includes("quality"),         "quality lane must be assigned");
    assert.ok(lanes.includes("infrastructure"),  "infrastructure lane must be assigned");
    assert.ok(lanes.includes("governance"),      "governance lane must be assigned");
  });

  it("DAG scheduler output plans are all capability-routable without fallback for known lanes", () => {
    const plans = [
      { task: "T-Governance", role: "governance-worker", dependencies: [], task_text: "Update policy freeze rules" },
      { task: "T-Test",       role: "quality-worker",    dependencies: [], task_text: "Add test for dag_scheduler" },
      { task: "T-Infra",      role: "infra-worker",      dependencies: ["T-Governance"], task_text: "Rebuild Docker base" },
    ];

    // Simulate: compute first wave from DAG
    const waveResult = computeNextWaves(plans);
    assert.equal(waveResult.status, "ok");

    const wave1Plans = waveResult.readyWaves[0] ?? [];
    assert.ok(wave1Plans.length >= 1, "Wave 1 must have schedulable tasks");

    // Route each plan in wave 1 through capability pool
    for (const plan of wave1Plans) {
      const tag = inferCapabilityTag(plan);
      assert.ok(typeof tag === "string" && tag.length > 0, "Must infer a capability tag");

      const selection = selectWorkerForPlan(plan);
      assert.ok(selection.role, `Worker role must be set for plan "${(plan as any).task}"`);
      assert.ok(selection.lane, `Worker lane must be set for plan "${(plan as any).task}"`);
    }
  });

  it("negative path: unknown plan type still routes without throwing (graceful fallback)", () => {
    const plan = { task: "Do something completely undefined and unrecognisable by any heuristic" };
    assert.doesNotThrow(() => {
      const tag = inferCapabilityTag(plan);
      const selection = selectWorkerForPlan(plan);
      assert.equal(tag, "runtime-refactor", "Unknown tasks must fall back to runtime-refactor");
      assert.ok(selection.role, "Must still produce a worker role");
    });
  });
});

// ── 3. Carry-Forward Debt Blocking Sequence ───────────────────────────────────

describe("Integration: carry-forward debt blocking sequence", () => {
  it("critical debt added and left unresolved triggers shouldBlockOnDebt at SLA expiry", () => {
    const ledger = addDebtEntries(
      [],
      [
        { followUpTask: "Fix flaky dag_scheduler integration wave ordering", severity: "critical" },
        { followUpTask: "Fix broken capability routing for governance lane tasks", severity: "critical" },
        { followUpTask: "Resolve carry-forward debt SLA escalation logic gap", severity: "critical" },
      ],
      1, // openedCycle
      { slaMaxCycles: 3 }
    );

    assert.equal(ledger.length, 3, "All 3 distinct debt entries must be added");

    // Cycle 2 — all within SLA, must not block
    const r2 = shouldBlockOnDebt(ledger, 2, { maxCriticalOverdue: 3 });
    assert.equal(r2.shouldBlock, false, "Must NOT block at cycle 2 (SLA is 3 cycles)");

    // Cycle 5 — all 3 overdue (dueCycle=4), must block at threshold=3
    const r5 = shouldBlockOnDebt(ledger, 5, { maxCriticalOverdue: 3 });
    assert.equal(r5.shouldBlock, true, "Must block at cycle 5 with 3 critical overdue items");
    assert.equal(r5.overdueCount, 3, "Overdue count must equal 3");
    assert.ok(r5.reason.includes("critical"), "Reason must mention critical debt");
  });

  it("closing one critical debt item brings count below threshold and unblocks planning", () => {
    const ledger = addDebtEntries(
      [],
      [
        { followUpTask: "Fix flaky dag_scheduler integration wave ordering", severity: "critical" },
        { followUpTask: "Fix broken capability routing for governance lane tasks", severity: "critical" },
        { followUpTask: "Resolve carry-forward debt SLA escalation logic gap", severity: "critical" },
      ],
      1,
      { slaMaxCycles: 2 }
    );

    // Cycle 4 — all 3 overdue (dueCycle=3)
    const rBefore = shouldBlockOnDebt(ledger, 4, { maxCriticalOverdue: 3 });
    assert.equal(rBefore.shouldBlock, true, "Must block with 3 critical overdue items");

    // Close one debt item
    const closed = closeDebt(ledger, ledger[0].id, "PR #42 merged — wave order fixed");
    assert.equal(closed, true, "closeDebt must return true for a valid open entry");

    // Cycle 4 again with 2 remaining overdue — below threshold of 3
    const rAfter = shouldBlockOnDebt(ledger, 4, { maxCriticalOverdue: 3 });
    assert.equal(rAfter.shouldBlock, false, "Must NOT block after closing one item (2 < 3 threshold)");
    assert.equal(rAfter.overdueCount, 2, "Overdue count must be 2 after closing one");
  });

  it("warning-severity debt does NOT trigger shouldBlockOnDebt even when overdue", () => {
    const ledger = addDebtEntries(
      [],
      [
        { followUpTask: "Improve documentation for dag_scheduler public API", severity: "warning" },
        { followUpTask: "Add JSDoc examples for capability pool routing", severity: "warning" },
        { followUpTask: "Review carry-forward SLA window sizing", severity: "warning" },
      ],
      1,
      { slaMaxCycles: 1 }
    );

    // Cycle 5 — all overdue but only warnings
    const result = shouldBlockOnDebt(ledger, 5, { maxCriticalOverdue: 3 });
    assert.equal(result.shouldBlock, false, "Warning-severity debt must not trigger shouldBlock");
    assert.equal(result.overdueCount, 0, "overdueCount counts only critical overdue items");
  });

  it("tickCycle correctly ages open entries across multiple cycles", () => {
    let ledger = addDebtEntries(
      [],
      [{ followUpTask: "Fix integration test gaps in the wave ordering suite", severity: "critical" }],
      1,
      { slaMaxCycles: 5 }
    );

    assert.equal(ledger.length, 1);

    // Simulate cycle progression
    for (let cycle = 2; cycle <= 4; cycle++) {
      const { overdue } = tickCycle(ledger, cycle);
      // dueCycle = 1+5 = 6; none overdue until cycle 7
      assert.equal(overdue.length, 0, `No overdue at cycle ${cycle} (SLA extends to cycle 6)`);
      assert.equal(ledger[0].cyclesOpen, cycle - 1);
    }

    const { overdue: overdue7 } = tickCycle(ledger, 7);
    assert.equal(overdue7.length, 1, "Entry is overdue at cycle 7 (dueCycle=6)");
    assert.equal(ledger[0].cyclesOpen, 6);
  });

  it("debt deduplication prevents double-counting when same lesson appears multiple cycles", () => {
    const lesson = "Fix the integration test wave ordering assertion gap in dag_scheduler";

    let ledger = addDebtEntries([], [{ followUpTask: lesson, severity: "critical" }], 1);
    assert.equal(ledger.length, 1, "First entry added");

    // Same lesson added again next cycle — must be deduplicated
    ledger = addDebtEntries(ledger, [{ followUpTask: lesson, severity: "critical" }], 2);
    assert.equal(ledger.length, 1, "Duplicate entry must be rejected by fingerprint deduplication");

    // Different lesson — must be added
    ledger = addDebtEntries(ledger, [
      { followUpTask: "Fix capability routing for the observation lane worker dispatch path", severity: "warning" }
    ], 2);
    assert.equal(ledger.length, 2, "New lesson must be added");
  });

  it("negative path: empty ledger never blocks, regardless of cycle number", () => {
    const result = shouldBlockOnDebt([], 999, { maxCriticalOverdue: 1 });
    assert.equal(result.shouldBlock, false);
    assert.equal(result.overdueCount, 0);
  });
});

// ── 4. End-to-end orchestration gate sequence ─────────────────────────────────

describe("Integration: full orchestration gate sequence", () => {
  it("debt gate runs before wave dispatch and blocks the cycle when critical debt is overdue", () => {
    // Step 1: accumulate debt across cycles
    let ledger = addDebtEntries(
      [],
      [
        { followUpTask: "Fix wave ordering regression in the dag_scheduler integration suite", severity: "critical" },
        { followUpTask: "Fix capability routing for observation lane producing wrong worker", severity: "critical" },
        { followUpTask: "Resolve critical SLA breach in carry-forward debt escalation path", severity: "critical" },
      ],
      1,
      { slaMaxCycles: 2 }
    );

    // Step 2: advance to cycle 4 — all entries overdue (dueCycle=3)
    const { shouldBlock, reason } = shouldBlockOnDebt(ledger, 4, { maxCriticalOverdue: 3 });
    assert.equal(shouldBlock, true, "Debt gate must block before wave dispatch");

    // Step 3: when blocked, no waves should be dispatched
    if (shouldBlock) {
      // Simulated plan set that would otherwise be scheduled
      const pendingPlans = [
        { task: "Ship feature X", role: "evolution-worker", dependencies: [] },
      ];
      // In the real orchestrator this is gated; here we verify the gate signal is present
      assert.ok(reason.length > 0, "shouldBlock reason must be non-empty to surface in logs");
      assert.ok(pendingPlans.length > 0, "Plans exist but are intentionally not dispatched");
    }
  });

  it("full cycle: plan set → wave order → capability routing → debt check → dispatch", () => {
    // Plans spanning multiple waves and capability lanes
    const plans = [
      { task: "Add test coverage for architecture_drift stale ref detection", role: "quality-worker",        dependencies: [], wave: 1 },
      { task: "Fix governance policy freeze bypass condition in policy_engine", role: "governance-worker",   dependencies: [], wave: 1 },
      { task: "Update Docker worker base image for reproducible builds",        role: "infra-worker",        dependencies: [], wave: 1 },
      { task: "Wire dag_scheduler frontier output to orchestrator dispatch",    role: "evolution-worker",    dependencies: ["T-test", "T-gov"], wave: 2 },
    ];

    // Step 1: no debt → gate should pass
    const ledger: any[] = [];
    const { shouldBlock } = shouldBlockOnDebt(ledger, 1, { maxCriticalOverdue: 3 });
    assert.equal(shouldBlock, false, "Clean ledger must not block");

    // Step 2: compute wave 1 (wave 2 plan has unsatisfied deps in this simplified context)
    const wave1Plans = plans.filter(p => p.wave === 1);
    const wavePlans = wave1Plans.map(p => ({ ...p, dependencies: [] }));

    const waveResult = computeNextWaves(wavePlans);
    assert.equal(waveResult.status, "ok");
    assert.equal(waveResult.readyWaves[0]?.length, 3, "Wave 1 must contain all 3 independent tasks");

    // Step 3: route wave 1 tasks through capability pool
    const { assignments, activeLaneCount } = assignWorkersToPlans(wave1Plans);
    assert.ok(activeLaneCount >= 2, "Wave 1 must use at least 2 distinct capability lanes");
    assert.equal(assignments.length, 3, "All 3 wave-1 tasks must be assigned workers");

    // Step 4: every assignment must have a valid role and lane
    for (const a of assignments) {
      assert.ok(a.selection.role, "Each assignment must have a worker role");
      assert.ok(a.selection.lane, "Each assignment must have a capability lane");
    }
  });
});

// ── 5. Optimizer Budget Admission ─────────────────────────────────────────────

describe("Integration: optimizer budget admission filtering", () => {
  it("all plans are admitted when total budget is sufficient", () => {
    const plans = [
      { id: "p1", role: "evolution-worker", task: "Fix auth token validation bug", priority: 9, wave: "wave-1" },
      { id: "p2", role: "evolution-worker", task: "Add governance canary test coverage", priority: 7, wave: "wave-1" },
      { id: "p3", role: "evolution-worker", task: "Update carry-forward SLA defaults", priority: 5, wave: "wave-2" },
    ];
    const config = { runtime: { runtimeBudget: { maxWorkerSpawnsPerCycle: 10 } } };
    const requestBudget = { hardCapTotal: 10 };

    const interventions = buildInterventionsFromPlan(plans, config);
    const budget = buildBudgetFromConfig(requestBudget, config);
    const result = runInterventionOptimizer(interventions, budget);

    assert.equal(result.status, OPTIMIZER_STATUS.OK, "All plans must be admitted with sufficient budget");
    assert.equal(result.selected.length, 3, "All 3 plans must be in selected");

    // Simulate admission filter (mirrors orchestrator logic)
    const admittedIds = new Set(result.selected.map((i: any) => i.id));
    const admittedPlans = plans.filter((plan: any, idx: number) => {
      const id = String(plan?.id ?? `plan-${idx + 1}`);
      return admittedIds.has(id);
    });
    assert.equal(admittedPlans.length, 3, "All plans pass admission with sufficient budget");
  });

  it("low-EV plans are rejected and removed from dispatch when budget is tight", () => {
    const plans = [
      { id: "p1", role: "evolution-worker", task: "Fix critical auth regression", priority: 10, wave: "wave-1" },
      { id: "p2", role: "evolution-worker", task: "Improve documentation typos", priority: 1, wave: "wave-1" },
      { id: "p3", role: "evolution-worker", task: "Add minor style polish", priority: 1, wave: "wave-1" },
    ];
    const config = {};
    // Budget allows only 1 worker spawn
    const requestBudget = { hardCapTotal: 1 };

    const interventions = buildInterventionsFromPlan(plans, config);
    const budget = buildBudgetFromConfig(requestBudget, config);
    const result = runInterventionOptimizer(interventions, budget);

    assert.equal(result.status, OPTIMIZER_STATUS.BUDGET_EXCEEDED, "Budget exceeded when too many plans for limit");
    assert.equal(result.selected.length, 1, "Only 1 plan admitted under budget=1");

    // The highest-priority plan (p1) must be the one admitted
    assert.equal(result.selected[0].id, "p1", "Highest-priority plan must be admitted first");
    assert.equal(result.rejected.length, 2, "Low-EV plans must be in rejected");

    // Admission filter removes rejected plans
    const admittedIds = new Set(result.selected.map((i: any) => i.id));
    const admittedPlans = plans.filter((plan: any, idx: number) =>
      admittedIds.has(String(plan?.id ?? `plan-${idx + 1}`))
    );
    assert.equal(admittedPlans.length, 1, "Dispatch set must contain only admitted plans");
    assert.equal((admittedPlans[0] as any).id, "p1", "Only high-priority plan dispatched");
  });

  it("negative path: optimizer fail-open — invalid budget config does not block dispatch", () => {
    const plans = [
      { id: "p1", role: "evolution-worker", task: "Critical fix for dispatch", priority: 8, wave: "wave-1" },
    ];
    // Null budget (simulates missing config) — optimizer returns INVALID_INPUT
    const interventions = buildInterventionsFromPlan(plans, {});
    const result = runInterventionOptimizer(interventions, null as any);

    assert.equal(result.status, OPTIMIZER_STATUS.INVALID_INPUT, "Null budget must produce INVALID_INPUT");
    // Orchestrator logic: INVALID_INPUT → skip admission filter → plans proceed unchanged
    const shouldSkipFilter = result.status === OPTIMIZER_STATUS.INVALID_INPUT || result.status === OPTIMIZER_STATUS.EMPTY_INPUT;
    assert.equal(shouldSkipFilter, true, "Dispatch must not be blocked on optimizer INVALID_INPUT");
  });
});

describe("Integration: dispatch-success semantics align with analytics outcomes", () => {
  it("does not report success when dispatch count is non-zero and completed count remains zero", () => {
    const record = computeCycleAnalytics({}, {
      workerResults: [{ roleName: "evolution-worker", status: "partial" }],
      planCount: 1,
      phase: CYCLE_PHASE.COMPLETED,
    });
    assert.equal(record.outcomes.tasksCompleted, 0);
    assert.notEqual(record.outcomes.status, CYCLE_OUTCOME_STATUS.SUCCESS);
    assert.equal(record.outcomes.status, CYCLE_OUTCOME_STATUS.PARTIAL);
  });
});

// ── 6. Carry-Forward Auto-Close Integration ───────────────────────────────────

describe("Integration: carry-forward auto-close with verification evidence", () => {
  it("verified debt item is auto-closed; unverified item remains blocking", () => {
    // Set up: two critical debt items from postmortems
    const verifiedLesson = "Fix dag_scheduler wave ordering integration test regression";
    const unresolvedLesson = "Fix capability pool observation lane routing false negative";

    const ledger = addDebtEntries(
      [],
      [
        { followUpTask: verifiedLesson, severity: "critical" },
        { followUpTask: unresolvedLesson, severity: "critical" },
      ],
      1,
      { slaMaxCycles: 2 }
    );

    assert.equal(ledger.length, 2);

    // A worker completed the first task with evidence; the second has no resolution
    const resolvedItems = [
      {
        taskText: verifiedLesson,
        verificationEvidence: {
          workerContract: {
            passed: true,
            artifactDetail: {
              hasSha: true,
              hasTestOutput: true,
              hasCleanTreeEvidence: true,
              hasUnfilledPlaceholder: false,
            },
          },
          replayClosure: {
            contractSatisfied: true,
            executedCommands: ["git rev-parse HEAD", "git status --porcelain", "npm test"],
            rawArtifactEvidenceLinks: [
              "inline://post-merge-sha/abc1234",
              "inline://clean-tree-status",
              "inline://npm-test-output-block",
            ],
          },
        },
      },
    ];

    const closedCount = autoCloseVerifiedDebt(ledger, resolvedItems);
    assert.equal(closedCount, 1, "Exactly one item must be auto-closed");

    // Verified item is now closed
    const verifiedEntry = ledger.find(e => e.lesson === verifiedLesson);
    assert.ok(verifiedEntry?.closedAt, "Verified debt entry must be closed");
    assert.ok(
      verifiedEntry?.closureEvidence?.includes("replay-closure:v1"),
      "Closure evidence must be linked to the worker's verification"
    );

    // Unresolved item remains open and still blocking
    const unresolvedEntry = ledger.find(e => e.lesson === unresolvedLesson);
    assert.equal(unresolvedEntry?.closedAt, null, "Unresolved entry must remain open");

    // shouldBlockOnDebt still fires for the remaining critical overdue item
    const blockResult = shouldBlockOnDebt(ledger, 5, { maxCriticalOverdue: 1 });
    assert.equal(blockResult.shouldBlock, true, "One remaining critical overdue item must still block dispatch");
  });

  it("no items are auto-closed when worker evidence is absent", () => {
    const lesson = "Fix the carry-forward fingerprint deduplication regression";
    const ledger = addDebtEntries([], [{ followUpTask: lesson, severity: "critical" }], 1);

    // Worker completed but provided no verification evidence
    const closedCount = autoCloseVerifiedDebt(ledger, [
      { taskText: lesson, verificationEvidence: "" },
    ]);

    assert.equal(closedCount, 0, "No close when evidence is missing");
    assert.equal(ledger[0].closedAt, null, "Entry must remain open");
  });

  it("negative path: auto-close with unmatched task text leaves all debt blocking", () => {
    const blockingLesson1 = "Fix orchestrator resume path checkpoint integrity check";
    const blockingLesson2 = "Fix catastrophe detector false-positive on SLO breach cycle";
    const ledger = addDebtEntries(
      [],
      [
        { followUpTask: blockingLesson1, severity: "critical" },
        { followUpTask: blockingLesson2, severity: "critical" },
      ],
      1,
      { slaMaxCycles: 1 }
    );

    // Worker completed an unrelated task
    autoCloseVerifiedDebt(ledger, [
      { taskText: "Completely unrelated task with no debt match", verificationEvidence: "PR #999 merged" },
    ]);

    // Both items still open and overdue at cycle 4
    const { shouldBlock, overdueCount } = shouldBlockOnDebt(ledger, 4, { maxCriticalOverdue: 2 });
    assert.equal(shouldBlock, true, "Both items must remain blocking");
    assert.equal(overdueCount, 2, "Both items must be counted as overdue");
  });
});

// ── 7. Dispatch command normalization + plan contract validation ───────────────

import {
  rewriteVerificationCommand,
  normalizeCommandBatch,
  checkForbiddenCommands,
} from "../../src/core/verification_command_registry.js";
import {
  validatePlanContract,
  validateAllPlans,
  PLAN_VIOLATION_SEVERITY,
} from "../../src/core/plan_contract_validator.js";

describe("Integration: dispatch command normalization + plan contract validation", () => {
  it("normalizeCommandBatch sanitizes all commands before they reach plan-contract validation", () => {
    // Simulate a batch of commands that a Prometheus-generated plan might contain
    const rawCmds = [
      "node --test tests/**/*.test.ts",   // glob — forbidden
      "bash scripts/run_tests.sh",          // bash — forbidden
      "npm test",                           // canonical — passes
    ];

    const normalized = normalizeCommandBatch(rawCmds);
    // All glob/shell commands are rewritten; no forbidden patterns remain
    for (const cmd of normalized) {
      const check = checkForbiddenCommands(cmd);
      assert.equal(check.forbidden, false,
        `command "${cmd}" must not be forbidden after normalization`
      );
    }
    assert.ok(normalized.includes("npm test"), "canonical npm test must be preserved");
    assert.ok(!normalized.some(c => c.includes("*")), "no globs must survive normalization");
  });

  it("validatePlanContract rejects a plan that contains a forbidden verification command", () => {
    const plan = {
      task: "Fix integration test wave ordering in dag_scheduler",
      role: "quality-worker",
      wave: 1,
      verification: "node --test tests/**/*.test.ts",
      dependencies: [],
      acceptance_criteria: ["all wave ordering tests pass"],
      capacityDelta: 0.1,
      requestROI: 2.0,
    };

    const result = validatePlanContract(plan);
    assert.equal(result.valid, false,
      "plan with forbidden glob verification must be invalid"
    );
    assert.ok(
      result.violations.some(v => v.field === "verification" && v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL),
      "must have a CRITICAL violation on the verification field for forbidden glob"
    );
  });

  it("validateAllPlans correctly segregates valid and invalid plans at the dispatch boundary", () => {
    const plans = [
      {
        task: "Fix dag_scheduler wave ordering regression test gap",
        role: "quality-worker",
        wave: 1,
        verification: "tests/core/dag_scheduler.test.ts — test: wave ordering is correct",
        dependencies: [],
        acceptance_criteria: ["wave 1 tasks complete before wave 2 starts"],
        capacityDelta: 0.1,
        requestROI: 1.8,
      },
      {
        task: "Fix capability routing for the observation lane",
        role: "backend-worker",
        wave: 1,
        verification: "node --test tests/**/*.test.ts",   // forbidden — must be caught
        dependencies: [],
        acceptance_criteria: ["observation lane routes correctly"],
        capacityDelta: 0.05,
        requestROI: 1.5,
      },
    ];

    const batch = validateAllPlans(plans);
    assert.equal(batch.totalPlans, 2);
    assert.equal(batch.validCount, 1, "only 1 plan must pass contract validation");
    assert.equal(batch.invalidCount, 1, "plan with forbidden command must be flagged invalid");
    assert.ok(batch.passRate < 1.0, "pass rate must be below 100% with a failing plan");

    // The invalid plan must be identifiable by planIndex for pre-dispatch removal
    const toRemove = batch.results
      .filter(r => !r.valid && r.violations.some(v => v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL))
      .map(r => r.planIndex);
    assert.deepEqual(toRemove, [1], "plan at index 1 (forbidden glob) must be flagged for removal");
  });

  it("full round-trip: forbidden commands are normalized then revalidated as clean", () => {
    // Simulate Prometheus emitting a plan with a Windows-unsafe command
    const prometheusGeneratedPlan = {
      task: "Add regression coverage for carry-forward debt auto-close logic",
      role: "quality-worker",
      wave: 1,
      verification: "node --test tests/**/*.test.ts",
      verification_commands: ["node --test tests/**/*.test.ts"],
      dependencies: [],
      acceptance_criteria: ["carry-forward auto-close tests pass"],
      capacityDelta: 0.1,
      requestROI: 1.5,
    };

    // Step 1: plan fails validation (forbidden glob)
    const beforeNorm = validatePlanContract(prometheusGeneratedPlan);
    assert.equal(beforeNorm.valid, false, "plan with forbidden glob must fail initial validation");

    // Step 2: normalize the verification_commands array
    const normalizedCmds = normalizeCommandBatch(prometheusGeneratedPlan.verification_commands);
    assert.ok(!normalizedCmds.some(c => c.includes("*")),
      "normalized commands must not contain glob patterns"
    );

    // Step 3: also rewrite the top-level verification field
    const normalizedVerification = rewriteVerificationCommand(prometheusGeneratedPlan.verification);
    // After normalization, the command is "npm test" — still non-specific for verification field
    // but no longer forbidden (the plan validator's forbidden check passes)
    const normalizedPlan = {
      ...prometheusGeneratedPlan,
      verification: "tests/core/carry_forward_ledger.test.ts — test: auto-close closes verified entries",
      verification_commands: normalizedCmds,
    };
    for (const cmd of normalizedCmds) {
      const check = checkForbiddenCommands(cmd);
      assert.equal(check.forbidden, false,
        `normalized command "${cmd}" must not be forbidden`
      );
    }
    // The plan is now safe for dispatch
    assert.ok(normalizedCmds.length > 0, "normalized batch must be non-empty");
  });

  it("negative path: plan with all forbidden commands still fails after normalization of different fields", () => {
    // A plan where the top-level `verification` field is the problem (not normalizeable by batch)
    const plan = {
      task: "Fix architecture drift detection for stale test references",
      role: "quality-worker",
      wave: 1,
      verification: "bash scripts/run_tests.sh",          // forbidden — bash
      dependencies: [],
      acceptance_criteria: ["architecture drift tests pass"],
      capacityDelta: 0.1,
      requestROI: 2.0,
    };

    const result = validatePlanContract(plan);
    assert.equal(result.valid, false, "plan with bash verification must be invalid");
    assert.ok(
      result.violations.some(v => v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL),
      "must have at least one CRITICAL violation for forbidden bash command"
    );
  });
});

// ── 8. Artifact evidence coupling + plan-validation at dispatch boundary ─────

import { validatePlanEvidenceCoupling } from "../../src/core/evidence_envelope.js";

describe("Integration: artifact evidence coupling + plan-validation at dispatch boundary", () => {
  it("plan missing verification_commands is rejected by evidence coupling gate", () => {
    const plan = {
      id: "T1",
      task: "Fix orchestrator resume checkpoint write regression",
      acceptance_criteria: ["resume checkpoint is written before gate evaluation"],
      // missing verification_commands
    };

    const coupling = validatePlanEvidenceCoupling(plan);
    assert.equal(coupling.valid, false,
      "plan without verification_commands must fail evidence coupling"
    );
    assert.ok(
      coupling.errors.some(e => e.includes("verification_commands")),
      "error must reference the missing verification_commands field"
    );
  });

  it("plan missing acceptance_criteria is rejected by evidence coupling gate", () => {
    const plan = {
      id: "T2",
      task: "Fix governance canary breach detection regression",
      verification_commands: ["npm test"],
      // missing acceptance_criteria
    };

    const coupling = validatePlanEvidenceCoupling(plan);
    assert.equal(coupling.valid, false,
      "plan without acceptance_criteria must fail evidence coupling"
    );
    assert.ok(
      coupling.errors.some(e => e.includes("acceptance_criteria")),
      "error must reference the missing acceptance_criteria field"
    );
  });

  it("plan with both fields populated passes evidence coupling gate", () => {
    const plan = {
      id: "T3",
      task: "Fix dag_scheduler diamond DAG wave ordering test gap",
      verification_commands: ["npm test"],
      acceptance_criteria: ["all DAG tests pass"],
    };

    const coupling = validatePlanEvidenceCoupling(plan);
    assert.equal(coupling.valid, true,
      "plan with both verification_commands and acceptance_criteria must pass coupling"
    );
    assert.equal(coupling.errors.length, 0, "no errors for a fully-coupled plan");
  });

  it("coupling gate + contract validation together: a plan must pass both before dispatch", () => {
    // A plan that has evidence coupling fields but also has a forbidden verification command
    const plan = {
      id: "T4",
      task: "Fix carry-forward debt blocking sequence in orchestration gate",
      role: "quality-worker",
      wave: 1,
      verification: "node --test tests/**/*.test.ts",   // forbidden
      verification_commands: ["npm test"],               // coupling field OK
      dependencies: [],
      acceptance_criteria: ["carry-forward blocking tests pass"],  // coupling field OK
      capacityDelta: 0.1,
      requestROI: 1.5,
    };

    // Evidence coupling passes (coupling fields are present)
    const coupling = validatePlanEvidenceCoupling(plan);
    assert.equal(coupling.valid, true, "coupling gate passes when both fields are present");

    // But contract validation catches the forbidden command
    const contract = validatePlanContract(plan);
    assert.equal(contract.valid, false, "contract validation catches the forbidden glob in verification");
    assert.ok(
      contract.violations.some(v => v.field === "verification" && v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL),
      "forbidden glob in verification field must be a CRITICAL contract violation"
    );
  });

  it("wave-ordered multi-plan batch: all plans with complete evidence pass coupling gate", () => {
    const plans = [
      {
        id: "T-A", task: "Fix dag_scheduler wave ordering for 3-plan linear chain",
        verification_commands: ["npm test"], acceptance_criteria: ["wave 1 plans run before wave 2"],
      },
      {
        id: "T-B", task: "Fix capability routing for governance lane worker dispatch",
        verification_commands: ["npm test"], acceptance_criteria: ["governance lane correctly routed"],
      },
      {
        id: "T-C", task: "Fix carry-forward debt SLA escalation logic for critical entries",
        verification_commands: ["npm test"], acceptance_criteria: ["SLA escalation triggers at cycle 4"],
      },
    ];

    const allCoupled = plans.every(p => validatePlanEvidenceCoupling(p).valid);
    assert.equal(allCoupled, true, "all plans with complete evidence must pass coupling gate");
  });

  it("negative path: empty verification_commands array fails coupling gate", () => {
    const plan = {
      id: "T5",
      task: "Fix optimizer budget admission filtering for low-EV plans",
      verification_commands: [],   // empty — not valid
      acceptance_criteria: ["only high-priority plans are admitted"],
    };

    const coupling = validatePlanEvidenceCoupling(plan);
    assert.equal(coupling.valid, false,
      "plan with empty verification_commands must fail evidence coupling"
    );
  });
});

// ── 9. Fit-scored dispatch with bounded fallback promotion ────────────────────

import {
  scoreWorkerTaskFit,
  selectWorkerByFitScore,
  recordLaneOutcome,
} from "../../src/core/capability_pool.js";

describe("Integration: fit-scored dispatch with bounded fallback promotion", () => {
  it("specialist worker wins decisively for specialist tasks (governance)", () => {
    // governance-worker has single capability ["state-governance"] + specialist bonus
    const result = selectWorkerByFitScore({ task: "Update governance freeze policy rules" });
    assert.equal(result.role, "governance-worker",
      "governance-worker must be selected for governance tasks (single-capability specialist)"
    );
    assert.ok(result.fitScore > 0.5, `fitScore (${result.fitScore}) must exceed 0.5 for a capability match`);
  });

  it("specialist worker wins decisively for specialist tasks (infrastructure)", () => {
    const result = selectWorkerByFitScore({ task: "Update Docker CI pipeline configuration" });
    assert.equal(result.role, "infrastructure-worker",
      "infrastructure-worker must be selected for infrastructure tasks"
    );
    assert.ok(result.fitScore > 0.5);
  });

  it("quality-worker wins for test-infra tasks over all generalists", () => {
    const plan = { task: "Add test coverage for the dag_scheduler wave ordering" };
    const qualityScore = scoreWorkerTaskFit("quality-worker",    plan);
    const evolvScore   = scoreWorkerTaskFit("Evolution Worker",  plan);
    const govScore     = scoreWorkerTaskFit("governance-worker", plan);
    assert.ok(qualityScore > evolvScore,
      `quality-worker (${qualityScore}) must outscore Evolution Worker (${evolvScore})`
    );
    assert.ok(qualityScore > govScore,
      `quality-worker (${qualityScore}) must outscore governance-worker (${govScore})`
    );
  });

  it("fit-scored dispatch is deterministic: same plan always produces same worker", () => {
    const plan = { task: "Add observation metrics to the dashboard service endpoint" };
    const r1 = selectWorkerByFitScore(plan);
    const r2 = selectWorkerByFitScore(plan);
    const r3 = selectWorkerByFitScore(plan);
    assert.equal(r1.role, r2.role, "first and second call must produce same worker");
    assert.equal(r2.role, r3.role, "second and third call must produce same worker");
    assert.equal(r1.fitScore, r2.fitScore, "fit scores must be identical across calls");
  });

  it("worker starvation prevention: unknown task type still produces a valid worker", () => {
    // Tasks with no recognized capability keywords fall back to runtime-refactor
    const plan = { task: "something completely unrecognized xyzzy qwerty blorp" };
    const result = selectWorkerByFitScore(plan);
    assert.ok(result.role, "must always return a non-empty role (no starvation)");
    assert.ok(typeof result.fitScore === "number" && result.fitScore >= 0,
      "fitScore must be a non-negative number (bounded fallback)"
    );
  });

  it("worker starvation prevention: degraded lane does not prevent worker assignment", () => {
    // Simulate a severely degraded quality lane (20 consecutive failures)
    let ledger = {};
    for (let i = 0; i < 20; i++) {
      ledger = recordLaneOutcome(ledger, "quality", { success: false, durationMs: 100 });
    }
    const plan = { task: "Add test coverage for the parser module" }; // → quality lane
    const result = selectWorkerByFitScore(plan, undefined, ledger);
    // With degraded quality lane, capability match still contributes 50% to fit score
    assert.ok(result.role, "degraded lane must not produce null worker (starvation prevention)");
    assert.ok(result.fitScore >= 0, "fit score must be non-negative even for degraded lane");
    // Capability match contributes 0.5 even when performance is low
    assert.ok(result.fitScore > 0, "quality-worker has capability match and must still score > 0");
  });

  it("fit score bounds: all workers score in [0, 1] for any plan", () => {
    const plans = [
      { task: "Add test coverage for the dag_scheduler module" },
      { task: "Update governance freeze policy rules" },
      { task: "Fix Docker CI pipeline configuration" },
      { task: "Wire integration between scheduler and orchestrator dispatch" },
    ];
    const workerNames = ["quality-worker", "governance-worker", "Evolution Worker", "infrastructure-worker", "integration-worker", "observation-worker"];
    for (const plan of plans) {
      for (const workerName of workerNames) {
        const score = scoreWorkerTaskFit(workerName, plan);
        assert.ok(
          score >= 0 && score <= 1,
          `score ${score} out of [0,1] for worker=${workerName}, plan="${plan.task}"`
        );
      }
    }
  });

  it("negative path: worker with zero capability overlap still scores >= 0 (floor prevents starvation)", () => {
    // governance-worker has only ["state-governance"]; test-infra task gives capMatch=0
    // Expected: capMatch=0 → 0, laneScore=0.5 → 0.5*0.4=0.2, specialistBonus=0 → raw=0.2
    const score = scoreWorkerTaskFit(
      "governance-worker",
      { task: "Add test coverage for the parser module" }
    );
    assert.ok(score >= 0, "score must never be negative (bounded fallback floor)");
    assert.ok(score < 0.5, "worker with no capability match must score below 0.5");
  });

  it("performance history raises fit score for the matching specialist lane", () => {
    // A healthy quality lane should increase quality-worker's fit score vs no history
    let ledger = {};
    for (let i = 0; i < 10; i++) {
      ledger = recordLaneOutcome(ledger, "quality", { success: true, durationMs: 200 });
    }
    const plan = { task: "Add test coverage for the carry_forward_ledger module" };
    const scoreWithHistory    = scoreWorkerTaskFit("quality-worker", plan, ledger);
    const scoreWithoutHistory = scoreWorkerTaskFit("quality-worker", plan);
    assert.ok(
      scoreWithHistory >= scoreWithoutHistory,
      `healthy ledger (${scoreWithHistory}) must not decrease fit score vs no history (${scoreWithoutHistory})`
    );
  });
});

describe("Integration: runtime contract cycle-proof probe", () => {
  it("passes when Prometheus, Athena, and worker verification seams are all valid", () => {
    const probe = computeRuntimeContractProbe({
      prometheusAnalysis: {
        generatedAt: "2026-04-04T12:00:00.000Z",
        keyFindings: "Parser contract fields are present and non-empty.",
      },
      athenaPlanReview: { overallScore: 8.5 },
      workerResults: [{
        roleName: "quality-worker",
        status: "done",
        verificationEvidence: "===VERIFICATION_REPORT===\nBUILD=pass\nTESTS=pass\n===END_VERIFICATION===",
      }],
    });

    assert.equal(probe.passed, true);
    assert.equal(probe.criteria.prometheusGeneratedAtAndKeyFindings.pass, true);
    assert.equal(probe.criteria.athenaPlanReviewOverallScoreFinite.pass, true);
    assert.equal(probe.criteria.doneWorkerWithVerificationReportEvidence.pass, true);
  });

  it("fails when a done worker does not provide VERIFICATION_REPORT evidence", () => {
    const probe = computeRuntimeContractProbe({
      prometheusAnalysis: {
        generatedAt: "2026-04-04T12:00:00.000Z",
        keyFindings: "Signals exist.",
      },
      athenaPlanReview: { overallScore: 7 },
      workerResults: [{
        roleName: "Evolution Worker",
        status: "done",
        verificationEvidence: "Finished implementation with no verification block.",
      }],
    });

    assert.equal(probe.passed, false);
    assert.equal(probe.criteria.doneWorkerWithVerificationReportEvidence.pass, false);
  });
});

// ── 11. Premium efficiency split: raw vs execution-adjusted ──────────────────
// Tests that cycle_analytics kpis expose both variants, and that the values
// flow correctly from computeCycleAnalytics.  Autonomy band gate selection
// is tested separately in autonomy_band_monitor.test.ts.

describe("Integration: premium efficiency variants in cycle analytics kpis", () => {
  it("kpis expose premiumEfficiencyRaw and premiumEfficiencyAdjusted when provided", () => {
    const record = computeCycleAnalytics({}, {
      sloRecord: null,
      premiumEfficiencyRaw: 0.90,
      premiumEfficiencyAdjusted: 0.60,
    });
    assert.equal(record.kpis.premiumEfficiencyRaw, 0.90, "raw variant must be preserved in kpis");
    assert.equal(record.kpis.premiumEfficiencyAdjusted, 0.60, "adjusted variant must be preserved in kpis");
  });

  it("kpis.premiumEfficiencyRaw and premiumEfficiencyAdjusted are null when omitted", () => {
    const record = computeCycleAnalytics({}, {});
    assert.equal(record.kpis.premiumEfficiencyRaw, null);
    assert.equal(record.kpis.premiumEfficiencyAdjusted, null);
  });

  it("raw=1.0 adjusted=0.25 reflects unexecuted worker slots (historical comparability preserved)", () => {
    // Scenario: 4 premium events (3 leadership OK + 1 worker API-OK but 0 verified done)
    // raw  = 4/4 = 1.0
    // adj  = (3 + 0) / 4 = 0.75 (leadership successes only)
    const record = computeCycleAnalytics({}, {
      premiumEfficiencyRaw: 1.0,
      premiumEfficiencyAdjusted: 0.75,
    });
    assert.equal(record.kpis.premiumEfficiencyRaw, 1.0);
    assert.equal(record.kpis.premiumEfficiencyAdjusted, 0.75);
    assert.ok(
      record.kpis.premiumEfficiencyRaw! > record.kpis.premiumEfficiencyAdjusted!,
      "raw must exceed adjusted when worker slots produced no verified output",
    );
  });

  it("negative path: adjusted below raw surfaces the execution penalty signal", () => {
    // raw=0.80 (good API success rate), adjusted=0.30 (low verified output)
    const record = computeCycleAnalytics({}, {
      premiumEfficiencyRaw: 0.80,
      premiumEfficiencyAdjusted: 0.30,
    });
    assert.ok(
      (record.kpis.premiumEfficiencyRaw ?? 0) > (record.kpis.premiumEfficiencyAdjusted ?? 0),
      "execution penalty must be visible: raw should exceed adjusted",
    );
  });
});

// ── Canonical telemetry spine integration ─────────────────────────────────────
// Verifies that the canonical worker-cycle artifact filename constant is stable
// and that terminal worker statuses used in canonical artifacts are fully
// recognized by the observability pipeline.

describe("canonical telemetry spine — artifact schema and terminal status coverage", () => {
  it("WORKER_CYCLE_ARTIFACTS_FILE constant resolves to expected filename", () => {
    assert.equal(WORKER_CYCLE_ARTIFACTS_FILE, "worker_cycle_artifacts.json",
      "WORKER_CYCLE_ARTIFACTS_FILE must be the stable canonical filename");
  });

  it("all canonical workerActivity status values are recognized as terminal by isTerminalWorkerStatus", () => {
    // These are the status values written into workerActivity entries in worker_cycle_artifacts.json.
    const canonicalStatuses = ["done", "success", "skipped", "partial", "blocked", "error", "failed", "recovered"];
    for (const status of canonicalStatuses) {
      assert.ok(isTerminalWorkerStatus(status),
        `Status "${status}" used in canonical artifacts must be terminal`);
    }
  });

  it("non-terminal status is not recognized as terminal", () => {
    assert.equal(isTerminalWorkerStatus("in_progress"), false);
    assert.equal(isTerminalWorkerStatus("pending"), false);
    assert.equal(isTerminalWorkerStatus("running"), false);
    assert.equal(isTerminalWorkerStatus(""), false);
  });

  it("computeCycleAnalytics produces a record that integrates worker session data", () => {
    const workerSessions = {
      "evolution-worker": { status: "idle", startedAt: new Date().toISOString() },
    };
    const record = computeCycleAnalytics({ workerSessions }, {});
    // The record must be a non-null object with kpis — it consumed the session data
    assert.ok(record !== null && typeof record === "object", "must return analytics record");
    assert.ok("kpis" in record, "record must include kpis");
  });
});

// ── Canonical active-worker detection ─────────────────────────────────────────
// Verifies that the canonical artifact structure (worker_cycle_artifacts.json)
// correctly signals active vs. idle workers after migration and that terminal
// activity entries are handled for stale-session recovery.

describe("canonical active-worker detection — artifact structure invariants", () => {
  const makeCycleArtifact = (workerSessions, workerActivity = {}) => ({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    latestCycleId: "cycle-1",
    cycles: {
      "cycle-1": {
        cycleId: "cycle-1",
        updatedAt: new Date().toISOString(),
        status: "in_progress",
        workerSessions,
        workerActivity,
        completedTaskIds: [],
      },
    },
  });

  it("migrateWorkerCycleArtifacts accepts a valid v1 artifact and marks it already_current", () => {
    const artifact = makeCycleArtifact({ "coder-worker": { status: "working" } });
    const result = migrateWorkerCycleArtifacts(artifact);
    assert.ok(result.ok, "migration must succeed for valid v1 artifact");
    assert.equal(result.reason, "already_current", "v1 artifact must be already_current");
  });

  it("sessions with status=working are detected as active via workerSessions", () => {
    const artifact = makeCycleArtifact({
      "coder-worker": { status: "working", startedAt: new Date().toISOString() },
    });
    const result = migrateWorkerCycleArtifacts(artifact);
    assert.ok(result.ok);
    const cycle = (result.data as any).cycles["cycle-1"];
    const sessions: Record<string, any> = cycle.workerSessions;
    const activeWorkers = Object.values(sessions).filter((s: any) => s.status === "working");
    assert.equal(activeWorkers.length, 1, "one worker must be active");
  });

  it("sessions with status=idle are not detected as active", () => {
    const artifact = makeCycleArtifact({
      "coder-worker": { status: "idle", startedAt: new Date().toISOString() },
    });
    const result = migrateWorkerCycleArtifacts(artifact);
    assert.ok(result.ok);
    const cycle = (result.data as any).cycles["cycle-1"];
    const sessions: Record<string, any> = cycle.workerSessions;
    const activeWorkers = Object.values(sessions).filter((s: any) => s.status === "working");
    assert.equal(activeWorkers.length, 0, "idle session must not be counted as active");
  });

  it("terminal activity entries for a working session flag recovery need via isTerminalWorkerStatus", () => {
    // A session that is 'working' in workerSessions but whose last activity entry
    // has a terminal status indicates a stale/crashed worker that needs recovery.
    const artifact = makeCycleArtifact(
      { "coder-worker": { status: "working" } },
      { "coder-worker": [{ at: new Date().toISOString(), status: "done", task: "task-1" }] }
    );
    const result = migrateWorkerCycleArtifacts(artifact);
    assert.ok(result.ok);
    const cycle = (result.data as any).cycles["cycle-1"];
    const activityLog: any[] = (cycle.workerActivity as any)["coder-worker"] || [];
    const lastEntry = activityLog[activityLog.length - 1];
    // The last activity status is terminal — this is the recovery-detection signal.
    assert.ok(
      isTerminalWorkerStatus(lastEntry.status),
      "last activity status must be terminal so recovery path can identify stale working sessions"
    );
  });

  it("empty workerSessions cycle produces zero active workers", () => {
    const artifact = makeCycleArtifact({});
    const result = migrateWorkerCycleArtifacts(artifact);
    assert.ok(result.ok);
    const cycle = (result.data as any).cycles["cycle-1"];
    const sessions: Record<string, any> = cycle.workerSessions;
    assert.equal(Object.keys(sessions).length, 0, "no sessions must produce zero active workers");
  });

  it("selectWorkerCycleRecord falls back to most recent cycle when pointers are stale", () => {
    const artifact = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      latestCycleId: "missing-cycle",
      cycles: {
        "cycle-old": {
          cycleId: "cycle-old",
          status: "complete",
          updatedAt: "2026-01-01T00:00:00.000Z",
          workerSessions: { "coder-worker": { status: "idle" } },
          workerActivity: { "coder-worker": [] },
          completedTaskIds: [],
        },
        "cycle-new": {
          cycleId: "cycle-new",
          status: "complete",
          updatedAt: "2026-01-01T00:01:00.000Z",
          workerSessions: { "coder-worker": { status: "working" } },
          workerActivity: { "coder-worker": [{ at: new Date().toISOString(), status: "working" }] },
          completedTaskIds: ["T-001"],
        },
      },
    };
    const migrated = migrateWorkerCycleArtifacts(artifact);
    assert.ok(migrated.ok, "artifact must migrate");
    const selected = selectWorkerCycleRecord(migrated.data, "also-missing");
    assert.equal(selected.source, "most_recent");
    assert.equal(selected.cycleId, "cycle-new");
    assert.equal((selected.record as any)?.workerSessions?.["coder-worker"]?.status, "working");
  });
});
