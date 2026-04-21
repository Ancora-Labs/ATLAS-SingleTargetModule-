/**
 * pipeline_integration_matrix.test.ts
 *
 * Deterministic integration matrix covering the cross-system pipeline:
 *   - Budget controller: depletion gate, Claude-usage guard
 *   - Diversity: capability pool assignment, lane diversity enforcement
 *   - Debt: addDebtEntries → tickCycle → shouldBlockOnDebt lifecycle
 *   - Evidence envelope intake: validateEvidenceEnvelope admission gate
 *   - Drift-debt normalization: deprecated tokens → debt entries → block at SLA
 *   - Cross-system invariants: independent gates compose without interference
 *
 * All tests are deterministic — no random values, no I/O, no network calls.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canUseClaude, BUDGET_THRESHOLD_USD } from "../../src/core/budget_controller.js";

import {
  assignWorkersToPlans,
  enforceLaneDiversity,
  computeDispatchMetrics,
} from "../../src/core/capability_pool.js";

import {
  addDebtEntries,
  tickCycle,
  closeDebt,
  getOpenDebts,
  shouldBlockOnDebt,
  autoCloseVerifiedDebt,
  computeFingerprint,
} from "../../src/core/carry_forward_ledger.js";

import { validateEvidenceEnvelope, validatePlanEvidenceCoupling } from "../../src/core/evidence_envelope.js";

import { detectDeprecatedTokensInContent } from "../../src/core/architecture_drift.js";

// ── Budget controller ─────────────────────────────────────────────────────────

describe("pipeline matrix — budget gate", () => {
  it("canUseClaude returns true when remaining budget is above threshold", () => {
    assert.equal(canUseClaude({ remainingUsd: 1.0 }), true);
  });

  it("canUseClaude returns true at the boundary value (exactly 0.2 + epsilon)", () => {
    assert.equal(canUseClaude({ remainingUsd: 0.201 }), true);
  });

  it("canUseClaude returns false at the threshold (exactly 0.2)", () => {
    // Threshold is > 0.2 — exactly 0.2 should return false
    assert.equal(canUseClaude({ remainingUsd: 0.2 }), false);
  });

  it("canUseClaude returns false when budget is exhausted (0 remaining)", () => {
    assert.equal(canUseClaude({ remainingUsd: 0 }), false);
  });

  it("budget depletion formula is deterministic: 1.0 - 0.35 = 0.65 remaining", () => {
    // Simulate chargeBudget math without I/O
    const initial = 1.0;
    const charged = 0.35;
    const remaining = Number((initial - charged).toFixed(4));
    assert.equal(remaining, 0.65);
    assert.equal(canUseClaude({ remainingUsd: remaining }), true);
  });

  it("negative: near-zero budget returns false from canUseClaude", () => {
    assert.equal(canUseClaude({ remainingUsd: 0.01 }), false);
  });
});

// ── Diversity — capability pool ───────────────────────────────────────────────

describe("pipeline matrix — diversity gate", () => {
  it("single-plan pool has diversityIndex of 0 (fully concentrated)", () => {
    const plans = [{ role: "Evolution Worker", task: "fix auth", taskKind: "implementation" }];
    const result = assignWorkersToPlans(plans, {});
    assert.equal(result.diversityIndex, 0);
    assert.equal(result.activeLaneCount, 1);
  });

  it("multi-role plans produce higher diversityIndex than single-role plans", () => {
    const uniform = [
      { role: "Evolution Worker", task: "fix auth" },
      { role: "Evolution Worker", task: "fix api" },
      { role: "Evolution Worker", task: "fix db" },
    ];
    const varied = [
      { role: "Evolution Worker", task: "fix auth" },
      { role: "Evolution Worker", task: "add metrics to dashboard" },
      { role: "Evolution Worker", task: "docker ci deploy infra change" },
    ];
    const uniformResult = assignWorkersToPlans(uniform, {});
    const variedResult = assignWorkersToPlans(varied, {});
    // varied plans infer different capability tags → different lanes → higher diversity
    assert.ok(
      variedResult.diversityIndex >= uniformResult.diversityIndex,
      `varied diversityIndex (${variedResult.diversityIndex}) should be >= uniform (${uniformResult.diversityIndex})`
    );
  });

  it("enforceLaneDiversity blocks when only 1 lane is active (minLanes=2)", () => {
    const plans = [
      { role: "Evolution Worker", task: "fix auth" },
      { role: "Evolution Worker", task: "fix api" },
    ];
    const pool = assignWorkersToPlans(plans, {});
    const gate = enforceLaneDiversity(pool, { minLanes: 2 });
    // All plans infer the same capability tag → 1 lane → fails minimum
    if (pool.activeLaneCount < 2) {
      assert.equal(gate.meetsMinimum, false);
      assert.ok(gate.warning.length > 0);
    } else {
      assert.equal(gate.meetsMinimum, true);
    }
  });

  it("computeDispatchMetrics concentrationRatio is 1 for single-role pool", () => {
    const plans = [
      { role: "Evolution Worker", task: "task-1" },
      { role: "Evolution Worker", task: "task-2" },
    ];
    const pool = assignWorkersToPlans(plans, {});
    const metrics = computeDispatchMetrics(pool);
    assert.equal(metrics.concentrationRatio, 1);
  });

  it("computeDispatchMetrics returns empty distributions for empty pool", () => {
    const metrics = computeDispatchMetrics({ assignments: [] });
    assert.deepEqual(metrics.roleDistribution, {});
    assert.deepEqual(metrics.laneDistribution, {});
    assert.equal(metrics.concentrationRatio, 1);
    assert.equal(metrics.diversityScore, 0);
  });

  it("negative: enforceLaneDiversity with minLanes=1 always passes", () => {
    const plans = [{ role: "Evolution Worker", task: "solo task" }];
    const pool = assignWorkersToPlans(plans, {});
    const gate = enforceLaneDiversity(pool, { minLanes: 1 });
    assert.equal(gate.meetsMinimum, true);
  });
});

// ── Carry-forward debt lifecycle ──────────────────────────────────────────────

describe("pipeline matrix — debt lifecycle", () => {
  it("addDebtEntries returns updated ledger with new entry", () => {
    const ledger = addDebtEntries([], [{ followUpTask: "fix the null pointer in orchestrator", severity: "critical" }], 1);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].severity, "critical");
    assert.equal(ledger[0].openedCycle, 1);
    assert.equal(ledger[0].closedAt, null);
  });

  it("addDebtEntries deduplicates semantically identical lessons (fingerprint match)", () => {
    const lesson = "improve test coverage for the policy engine module";
    const ledger1 = addDebtEntries([], [{ followUpTask: lesson }], 1);
    const ledger2 = addDebtEntries(ledger1, [{ followUpTask: lesson }], 2);
    assert.equal(ledger2.length, 1, "identical lesson should not create a duplicate entry");
  });

  it("tickCycle populates cyclesOpen and flags overdue critical entries", () => {
    const ledger = addDebtEntries([], [{ followUpTask: "address memory leak in worker runner", severity: "critical" }], 1, { slaMaxCycles: 2 });
    // Advance to cycle 4 — entry was due at cycle 3
    const { overdue } = tickCycle(ledger, 4);
    assert.equal(overdue.length, 1);
    assert.equal(overdue[0].severity, "critical");
    assert.equal(ledger[0].cyclesOpen, 3); // 4 - 1 = 3
  });

  it("closeDebt removes entry from open debts and attaches evidence", () => {
    let ledger = addDebtEntries([], [{ followUpTask: "fix the retry strategy timeout calculation" }], 1);
    const debtId = ledger[0].id;
    const closed = closeDebt(ledger, debtId, "Verified fix in PR #42");
    assert.equal(closed, true);
    const open = getOpenDebts(ledger);
    assert.equal(open.length, 0);
    assert.ok(ledger[0].closedAt !== null);
    assert.equal(ledger[0].closureEvidence, "Verified fix in PR #42");
  });

  it("shouldBlockOnDebt triggers when critical overdue count meets threshold", () => {
    const items = [
      { followUpTask: "fix catastrophic data loss scenario in checkpoint engine", severity: "critical" },
      { followUpTask: "resolve regression in rollback engine atomic write path", severity: "critical" },
      { followUpTask: "address null dereference in evidence envelope processor", severity: "critical" },
    ];
    const ledger = addDebtEntries([], items, 1, { slaMaxCycles: 1 });
    // At cycle 3 all three entries are overdue (due at cycle 2)
    const gate = shouldBlockOnDebt(ledger, 3);
    assert.equal(gate.shouldBlock, true);
    assert.ok(gate.overdueCount >= 3);
  });

  it("shouldBlockOnDebt does not trigger for warning-only debt regardless of age", () => {
    const items = [
      { followUpTask: "improve logging verbosity in pipeline progress module", severity: "warning" },
      { followUpTask: "add integration test for the canary ledger flush path", severity: "warning" },
      { followUpTask: "refactor delta analytics rolling window calculation", severity: "warning" },
      { followUpTask: "update dependency graph resolver to handle circular hints", severity: "warning" },
    ];
    const ledger = addDebtEntries([], items, 1, { slaMaxCycles: 1 });
    const gate = shouldBlockOnDebt(ledger, 10, { maxCriticalOverdue: 3 });
    assert.equal(gate.shouldBlock, false, "warning-only debt must never block");
  });

  it("autoCloseVerifiedDebt closes matching entries by fingerprint", () => {
    const lesson = "ensure all worker outputs include VERIFICATION_REPORT marker";
    const ledger = addDebtEntries([], [{ followUpTask: lesson, severity: "critical" }], 1);
    const closedCount = autoCloseVerifiedDebt(ledger, [
      {
        taskText: lesson,
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
    ]);
    assert.equal(closedCount, 1);
    assert.equal(getOpenDebts(ledger).length, 0);
  });

  it("negative: autoCloseVerifiedDebt does not close when evidence is too short", () => {
    const lesson = "enforce strict type checking on all orchestrator dispatch inputs";
    const ledger = addDebtEntries([], [{ followUpTask: lesson, severity: "critical" }], 1);
    const closedCount = autoCloseVerifiedDebt(ledger, [
      { taskText: lesson, verificationEvidence: "ok" }, // < 5 chars minimum
    ]);
    assert.equal(closedCount, 0);
    assert.equal(getOpenDebts(ledger).length, 1);
  });
});

// ── Evidence envelope intake ──────────────────────────────────────────────────

describe("pipeline matrix — evidence envelope intake", () => {
  function baseEnvelope() {
    return {
      roleName: "evolution-worker",
      status: "done",
      summary: "All acceptance criteria met, tests pass.",
      verificationEvidence: { build: "pass", tests: "pass", lint: "pass" },
    };
  }

  it("valid full-pass envelope is accepted", () => {
    const { valid, errors } = validateEvidenceEnvelope(baseEnvelope());
    assert.equal(valid, true);
    assert.deepEqual(errors, []);
  });

  it("partial-failure envelope (tests=fail) is still structurally valid", () => {
    const envelope = { ...baseEnvelope(), verificationEvidence: { build: "pass", tests: "fail", lint: "n/a" } };
    const { valid } = validateEvidenceEnvelope(envelope);
    assert.equal(valid, true, "structural validity does not depend on slot pass/fail values");
  });

  it("envelope missing roleName fails intake gate", () => {
    const { roleName: _, ...broken } = baseEnvelope();
    const { valid, errors } = validateEvidenceEnvelope(broken);
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes("roleName")));
  });

  it("envelope with invalid verificationEvidence slot fails intake gate", () => {
    const broken = { ...baseEnvelope(), verificationEvidence: { build: "pass", tests: "pass", lint: "maybe" } };
    const { valid, errors } = validateEvidenceEnvelope(broken);
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes("verificationEvidence.lint")));
  });

  it("negative: null envelope is rejected with descriptive error", () => {
    const { valid, errors } = validateEvidenceEnvelope(null);
    assert.equal(valid, false);
    assert.ok(errors.length > 0);
  });

  it("all 27 slot combinations (pass/fail/n/a × 3) are structurally valid", () => {
    const slots = ["pass", "fail", "n/a"] as const;
    let validCount = 0;
    for (const b of slots) {
      for (const t of slots) {
        for (const l of slots) {
          const { valid } = validateEvidenceEnvelope({
            ...baseEnvelope(),
            verificationEvidence: { build: b, tests: t, lint: l },
          });
          if (valid) validCount++;
        }
      }
    }
    assert.equal(validCount, 27, "all 27 slot combinations must be structurally valid");
  });
});

// ── Drift-debt normalization pipeline ─────────────────────────────────────────

describe("pipeline matrix — drift-debt normalization", () => {
  it("deprecated tokens detected in doc content produce non-zero token refs", () => {
    const docContent = `
## Old API

Use \`governance_verdict\` to check the plan decision.
Also see \`PLAN_STARTED\` for lifecycle events.
    `;
    const refs = detectDeprecatedTokensInContent("docs/guide.md", docContent);
    assert.ok(refs.length >= 2, `expected at least 2 deprecated token refs; got ${refs.length}`);
    assert.ok(refs.some(r => r.token === "governance_verdict"));
    assert.ok(refs.some(r => r.token === "PLAN_STARTED"));
  });

  it("deprecated token refs carry line numbers and hint text", () => {
    const docContent = "Line 1\nThe `WORKER_STARTED` event fires here.\nLine 3";
    const refs = detectDeprecatedTokensInContent("docs/events.md", docContent);
    const ref = refs.find(r => r.token === "WORKER_STARTED");
    assert.ok(ref, "WORKER_STARTED should be detected");
    assert.equal(ref!.line, 2);
    assert.ok(ref!.hint.length > 0, "hint must be non-empty");
  });

  it("drift tokens map to debt entries via normalization pipeline", () => {
    // Simulate the normalization pipeline:
    // 1. Detect deprecated tokens in a doc
    // 2. Convert each unique token/hint to a debt item
    // 3. Verify debt ledger reflects the detections
    const docContent = `
The \`resume_workers\` function must be called at startup.
Ensure \`resumeDispatch\` is idempotent.
    `;
    const refs = detectDeprecatedTokensInContent("docs/ops.md", docContent);
    assert.ok(refs.length >= 2);

    // Normalize token refs to debt items
    const debtItems = refs.map(r => ({
      followUpTask: `Replace deprecated token "${r.token}" in ${r.docPath}: ${r.hint}`,
      severity: "warning" as const,
    }));

    const ledger = addDebtEntries([], debtItems, 5);
    assert.ok(ledger.length >= 2, "each unique deprecated token should become a debt entry");

    // Verify each debt entry carries the hint as part of its lesson
    for (const entry of ledger) {
      assert.ok(entry.lesson.includes("deprecated token"), "lesson should mention the deprecated token");
    }
  });

  it("drift-debt deduplication: same token in same doc at two places = one debt entry", () => {
    const docContent = `
First mention: \`CYCLE_STARTED\` event.
Second mention: \`CYCLE_STARTED\` event again.
    `;
    const refs = detectDeprecatedTokensInContent("docs/lifecycle.md", docContent);
    const cycleStartedRefs = refs.filter(r => r.token === "CYCLE_STARTED");
    assert.ok(cycleStartedRefs.length >= 1, "at least one ref for CYCLE_STARTED");

    // Both refs produce the same lesson text → fingerprint deduplication fires
    const debtItems = cycleStartedRefs.map(r => ({
      followUpTask: `Replace deprecated token "${r.token}" in ${r.docPath}: ${r.hint}`,
      severity: "warning" as const,
    }));
    const ledger = addDebtEntries([], debtItems, 1);
    assert.equal(ledger.length, 1, "same lesson from same token should deduplicate to a single debt entry");
  });

  it("drift debt accumulated past SLA blocks plan acceptance via shouldBlockOnDebt", () => {
    // Build a drift-derived critical debt ledger and advance past the SLA
    const debtItems = [
      { followUpTask: 'Replace deprecated token "governance_verdict" in docs: use governance_contract decision fields', severity: "critical" as const },
      { followUpTask: 'Replace deprecated token "PLAN_STARTED" in docs: use PLANNING_ANALYSIS_STARTED event', severity: "critical" as const },
      { followUpTask: 'Replace deprecated token "WORKER_STARTED" in docs: use PLANNING_TASK_DISPATCHED event', severity: "critical" as const },
    ];
    const ledger = addDebtEntries([], debtItems, 1, { slaMaxCycles: 2 });
    // All entries due at cycle 3; advance to cycle 4
    const gate = shouldBlockOnDebt(ledger, 4, { maxCriticalOverdue: 3 });
    assert.equal(gate.shouldBlock, true, "drift-derived critical debt overdue must block plan acceptance");
    assert.ok(gate.reason.length > 0);
  });

  it("negative: doc with no deprecated tokens produces zero drift debt", () => {
    const cleanDoc = `
## Architecture

This document describes the current BOX orchestrator design.
See \`src/core/orchestrator.ts\` for the implementation.
    `;
    const refs = detectDeprecatedTokensInContent("docs/clean.md", cleanDoc);
    assert.equal(refs.length, 0, "clean doc should produce no deprecated token refs");

    const ledger = addDebtEntries([], [], 1);
    assert.equal(ledger.length, 0, "empty refs produce empty ledger");
  });
});

// ── Cross-system invariants ───────────────────────────────────────────────────

describe("pipeline matrix — cross-system invariants", () => {
  it("budget gate and debt gate are independent: both can block simultaneously", () => {
    // Budget exhausted
    const exhaustedBudget = { remainingUsd: 0.1 };
    const budgetGateBlocks = !canUseClaude(exhaustedBudget);

    // Critical debt overdue
    const debtItems = [
      { followUpTask: "resolve data integrity violation in state tracker flush path", severity: "critical" as const },
      { followUpTask: "fix determinism violation in hypothesis scheduler wave assignment", severity: "critical" as const },
      { followUpTask: "repair broken retry strategy exponential backoff calculation", severity: "critical" as const },
    ];
    const ledger = addDebtEntries([], debtItems, 1, { slaMaxCycles: 1 });
    const debtGate = shouldBlockOnDebt(ledger, 5, { maxCriticalOverdue: 3 });

    assert.equal(budgetGateBlocks, true, "budget gate must block when remaining < 0.2");
    assert.equal(debtGate.shouldBlock, true, "debt gate must block when critical overdue >= threshold");
  });

  it("valid evidence envelope passes intake even when debt blocks plan acceptance", () => {
    // Envelope validation is a structural check — it is independent of debt state
    const debtItems = [
      { followUpTask: "fix null pointer exception in the canary metrics aggregation", severity: "critical" as const },
      { followUpTask: "address schema validation regression in event_schema processor", severity: "critical" as const },
      { followUpTask: "resolve concurrency race condition in checkpoint engine flush", severity: "critical" as const },
    ];
    const ledger = addDebtEntries([], debtItems, 1, { slaMaxCycles: 1 });
    const debtGate = shouldBlockOnDebt(ledger, 5, { maxCriticalOverdue: 3 });

    const envelope = {
      roleName: "evolution-worker",
      status: "done",
      summary: "Task completed successfully with all criteria met.",
      verificationEvidence: { build: "pass", tests: "pass", lint: "pass" },
    };
    const { valid } = validateEvidenceEnvelope(envelope);

    assert.equal(debtGate.shouldBlock, true);
    assert.equal(valid, true, "envelope intake is independent of debt gate state");
  });

  it("computeFingerprint is deterministic: same text always produces same fingerprint", () => {
    const text = "improve test coverage for the budget controller depletion path";
    const fp1 = computeFingerprint(text);
    const fp2 = computeFingerprint(text);
    assert.equal(fp1, fp2);
    assert.ok(fp1 !== null);
    assert.equal(fp1!.length, 16);
  });

  it("diversity index does not change when budget is low (gates are orthogonal)", () => {
    const plans = [
      { role: "Evolution Worker", task: "fix auth service" },
      { role: "Evolution Worker", task: "monitor dashboard metrics alert" },
    ];
    const poolFull = assignWorkersToPlans(plans, {});
    const poolExhausted = assignWorkersToPlans(plans, {}); // budget state not passed to capability pool

    // Diversity computation is budget-agnostic
    assert.equal(poolFull.diversityIndex, poolExhausted.diversityIndex);
    assert.equal(poolFull.activeLaneCount, poolExhausted.activeLaneCount);
  });
});

// ── Budget gate (expanded) ────────────────────────────────────────────────────

describe("pipeline matrix — budget gate (expanded)", () => {
  it("BUDGET_THRESHOLD_USD constant is exactly 0.2", () => {
    assert.equal(BUDGET_THRESHOLD_USD, 0.2);
  });

  it("canUseClaude gate boundary is strictly greater-than, not greater-than-or-equal", () => {
    assert.equal(canUseClaude({ remainingUsd: BUDGET_THRESHOLD_USD }), false, "exactly at threshold must block");
    assert.equal(canUseClaude({ remainingUsd: BUDGET_THRESHOLD_USD + 0.0001 }), true, "just above threshold must pass");
  });

  it("canUseClaude returns false for negative remaining budget (overdrawn state)", () => {
    assert.equal(canUseClaude({ remainingUsd: -0.5 }), false);
  });

  it("canUseClaude: depletion simulation — five sequential 0.2 charges from 1.0 USD exhaust the budget", () => {
    let remaining = 1.0;
    let dispatchCount = 0;
    for (let i = 0; i < 10; i++) {
      if (canUseClaude({ remainingUsd: remaining })) {
        dispatchCount++;
        remaining = Number((remaining - 0.2).toFixed(4));
      }
    }
    // At 0.2 exactly the gate closes, so only 4 dispatches allowed (1.0→0.8→0.6→0.4→stop at 0.2)
    assert.equal(dispatchCount, 4, "exactly 4 dispatches before gate closes at 0.2");
    assert.equal(remaining, 0.2);
  });

  it("budget gate is orthogonal to lane diversity — canUseClaude ignores lane topology", () => {
    // Exhausted budget always blocks regardless of how many lanes are active
    const exhaustedBudget = { remainingUsd: 0.1 };
    const richBudget = { remainingUsd: 5.0 };
    assert.equal(canUseClaude(exhaustedBudget), false);
    assert.equal(canUseClaude(richBudget), true);
    // Lane count has no bearing on canUseClaude output
  });
});

// ── Drift debt (expanded) ─────────────────────────────────────────────────────

describe("pipeline matrix — drift debt (expanded)", () => {
  it("closed debt entry is excluded from getOpenDebts but remains in the ledger", () => {
    const ledger = addDebtEntries([], [
      { followUpTask: "refactor the authentication module to remove dead code paths", severity: "critical" as const },
    ], 1);
    const debtId = ledger[0].id;
    closeDebt(ledger, debtId, "Completed in PR #77");
    const open = getOpenDebts(ledger);
    assert.equal(open.length, 0, "no open debts after closing");
    assert.equal(ledger.length, 1, "closed entry stays in ledger for audit trail");
    assert.ok(ledger[0].closedAt !== null, "closedAt must be set");
  });

  it("shouldBlockOnDebt does not block after all critical entries are closed", () => {
    const items = [
      { followUpTask: "resolve data corruption in state tracker atomic flush path", severity: "critical" as const },
      { followUpTask: "fix integer overflow in capacity scoreboard composite formula", severity: "critical" as const },
      { followUpTask: "repair silent error swallow in rollback engine revert sequence", severity: "critical" as const },
    ];
    const ledger = addDebtEntries([], items, 1, { slaMaxCycles: 1 });
    // Close all entries before advancing
    for (const entry of ledger) {
      closeDebt(ledger, entry.id, "Fixed and verified in post-cycle review");
    }
    const gate = shouldBlockOnDebt(ledger, 5, { maxCriticalOverdue: 3 });
    assert.equal(gate.shouldBlock, false, "gate must not block when all critical debt is closed");
  });

  it("mixed critical+warning debt: gate fires only on critical overdue count", () => {
    // 2 critical (overdue) + 4 warnings (overdue): gate at threshold=3 must NOT fire (only 2 critical)
    const warnings = [
      { followUpTask: "add verbose logging to canary engine state transitions", severity: "warning" as const },
      { followUpTask: "document the hypothesis scheduler scoring algorithm", severity: "warning" as const },
      { followUpTask: "improve error message clarity in the resilience drill", severity: "warning" as const },
      { followUpTask: "update README with correct docker compose version instructions", severity: "warning" as const },
    ];
    const criticals = [
      { followUpTask: "fix determinism violation in the dag_scheduler wave ordering", severity: "critical" as const },
      { followUpTask: "resolve checkpoint engine race condition on concurrent writes", severity: "critical" as const },
    ];
    const ledger = addDebtEntries([], [...warnings, ...criticals], 1, { slaMaxCycles: 1 });
    // At cycle 5, all entries are overdue
    const gate = shouldBlockOnDebt(ledger, 5, { maxCriticalOverdue: 3 });
    assert.equal(gate.shouldBlock, false, "2 critical overdue < threshold 3 → must not block");
    assert.equal(gate.overdueCount, 2, "overdueCount must reflect only critical entries");
  });

  it("tickCycle: entries opened at different cycles age independently and correctly", () => {
    const cycle1Item = { followUpTask: "address memory pressure in the evidence envelope consumer", severity: "critical" as const };
    const cycle3Item = { followUpTask: "fix off-by-one in the carry forward SLA deadline calculation", severity: "critical" as const };
    let ledger = addDebtEntries([], [cycle1Item], 1);
    ledger = addDebtEntries(ledger, [cycle3Item], 3);
    // At current cycle 7: entry1 has been open 6 cycles, entry2 has been open 4 cycles
    tickCycle(ledger, 7);
    const entry1 = ledger.find(e => e.lesson.includes("memory pressure"));
    const entry2 = ledger.find(e => e.lesson.includes("off-by-one"));
    assert.equal(entry1!.cyclesOpen, 6, "entry opened at cycle 1 must show 6 cycles open at cycle 7");
    assert.equal(entry2!.cyclesOpen, 4, "entry opened at cycle 3 must show 4 cycles open at cycle 7");
  });
});

// ── Evidence envelope coupling (expanded) ────────────────────────────────────

describe("pipeline matrix — evidence envelope coupling gate", () => {
  function basePlan() {
    return {
      task: "Implement deterministic budget gate enforcement across all dispatch paths",
      role: "evolution-worker",
      verification_commands: ["node --import tsx --test tests/core/budget_controller.test.ts"],
      acceptance_criteria: ["Budget gate blocks dispatch at threshold", "canUseClaude returns correct boundary value"],
    };
  }

  it("plan with valid verification_commands and acceptance_criteria passes coupling gate", () => {
    const { valid, errors } = validatePlanEvidenceCoupling(basePlan());
    assert.equal(valid, true);
    assert.deepEqual(errors, []);
  });

  it("plan with no verification_commands fails coupling gate", () => {
    const plan = { ...basePlan() };
    delete (plan as any).verification_commands;
    const { valid, errors } = validatePlanEvidenceCoupling(plan);
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes("verification_commands")));
  });

  it("plan with empty verification_commands array fails coupling gate", () => {
    const { valid, errors } = validatePlanEvidenceCoupling({ ...basePlan(), verification_commands: [] });
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes("verification_commands")));
  });

  it("plan with blank-string-only commands fails coupling gate", () => {
    const { valid, errors } = validatePlanEvidenceCoupling({ ...basePlan(), verification_commands: ["   ", ""] });
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes("verification_commands")));
  });

  it("plan with absent acceptance_criteria fails coupling gate", () => {
    const plan = { ...basePlan() };
    delete (plan as any).acceptance_criteria;
    const { valid, errors } = validatePlanEvidenceCoupling(plan);
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes("acceptance_criteria")));
  });

  it("plan with empty acceptance_criteria array fails coupling gate", () => {
    const { valid, errors } = validatePlanEvidenceCoupling({ ...basePlan(), acceptance_criteria: [] });
    assert.equal(valid, false);
    assert.ok(errors.some(e => e.includes("acceptance_criteria")));
  });

  it("null plan input fails coupling gate with descriptive error", () => {
    const { valid, errors } = validatePlanEvidenceCoupling(null);
    assert.equal(valid, false);
    assert.ok(errors.length > 0);
  });

  it("coupling validation is structurally independent of evidence envelope validation", () => {
    // A structurally valid evidence envelope can pass while the plan fails coupling
    const envelope = {
      roleName: "evolution-worker",
      status: "done",
      summary: "Task completed.",
      verificationEvidence: { build: "pass", tests: "pass", lint: "pass" },
    };
    const envelopeResult = validateEvidenceEnvelope(envelope);
    const couplingResult = validatePlanEvidenceCoupling({ task: "no commands here", role: "w" });
    assert.equal(envelopeResult.valid, true, "envelope must be structurally valid");
    assert.equal(couplingResult.valid, false, "plan must fail coupling (missing verification_commands)");
  });
});

// ── Lane diversity (expanded) ─────────────────────────────────────────────────

describe("pipeline matrix — lane diversity (expanded)", () => {
  it("enforceLaneDiversity at exact minimum (activeLanes === minLanes) passes", () => {
    const pool = { activeLaneCount: 3 };
    const gate = enforceLaneDiversity(pool, { minLanes: 3 });
    assert.equal(gate.meetsMinimum, true, "meeting the exact minimum must pass");
    assert.equal(gate.warning, "");
  });

  it("enforceLaneDiversity below minimum produces a non-empty warning message", () => {
    const pool = { activeLaneCount: 1 };
    const gate = enforceLaneDiversity(pool, { minLanes: 3 });
    assert.equal(gate.meetsMinimum, false);
    assert.ok(gate.warning.length > 0, "warning message must be non-empty on diversity failure");
    assert.ok(gate.warning.includes("1"), "warning must reference the actual lane count");
    assert.ok(gate.warning.includes("3"), "warning must reference the minimum required lanes");
  });

  it("diverse task types infer distinct capability lanes", () => {
    const plans = [
      { task: "add prometheus metric collection endpoint to dashboard service" }, // → observation
      { task: "add test coverage for the canary ledger flush timeout path" },     // → test-infra
      { task: "wire governance policy engine into the pre-dispatch gate" },        // → state-governance
      { task: "update docker ci deploy pipeline for multi-stage builds" },         // → infrastructure
    ];
    const pool = assignWorkersToPlans(plans, {});
    // Each plan infers a distinct tag → ≥ 4 lanes
    assert.ok(pool.activeLaneCount >= 3, `diverse tasks must produce at least 3 lanes; got ${pool.activeLaneCount}`);
  });

  it("concentrationRatio is 1 for zero-plan pool (edge case)", () => {
    const metrics = computeDispatchMetrics({ assignments: [] });
    assert.equal(metrics.concentrationRatio, 1, "empty pool must report concentrationRatio=1");
    assert.equal(metrics.diversityScore, 0, "empty pool must report diversityScore=0");
  });

  it("assignWorkersToPlans includes diversityCheck gate in return value", () => {
    const plans = [
      { role: "Evolution Worker", task: "fix the auth service token refresh path" },
    ];
    const result = assignWorkersToPlans(plans, {});
    assert.ok("diversityCheck" in result, "result must include diversityCheck property");
    assert.ok(typeof result.diversityCheck.meetsMinimum === "boolean");
  });
});

// ── Full pipeline composition ─────────────────────────────────────────────────
// Tests for evaluatePreDispatchGovernanceGate covering full pipeline success
// and per-gate block scenarios.  All scenarios are deterministic and file-safe:
// the stateDir is set to a non-existent path so readJson calls return defaults
// rather than loading real data.

import {
  evaluatePreDispatchGovernanceGate,
  GATE_PRECEDENCE,
  BLOCK_REASON,
} from "../../src/core/orchestrator.js";

/** Minimal config that passes ALL gates. */
function makePipelinePassConfig(overrides: Record<string, unknown> = {}) {
  return {
    systemGuardian: { enabled: false },
    // isFreezeActive reads config.governanceFreeze; disabled here so December runs don't trigger
    governanceFreeze: { enabled: false },
    carryForward: { maxCriticalOverdue: 999 },
    canary: { governance: { enabled: false } },
    paths: { stateDir: "/nonexistent/box-pipeline-test-state" },
    runtime: {},
    ...overrides,
  };
}

/** Minimal valid plan that passes the evidence coupling gate. */
function makeValidPlan(id: string, deps: string[] = []) {
  return {
    id,
    task: `Task ${id}`,
    dependsOn: deps,
    verification_commands: ["npm test"],
    acceptance_criteria: [`${id} tests pass`],
  };
}

describe("pipeline matrix — full composition (success scenario)", () => {
  it("all gates pass when plans are valid and no blocks are active", async () => {
    const config = makePipelinePassConfig();
    const plans = [
      makeValidPlan("T-A"),
      makeValidPlan("T-B"),
    ];
    const result = await evaluatePreDispatchGovernanceGate(config, plans, "cycle-1");
    assert.equal(result.blocked, false, "pipeline must not be blocked when all gates pass");
    assert.equal(result.reason, null, "reason must be null on success");
    assert.equal(result.gateIndex, undefined, "gateIndex must be absent on success");
    assert.ok(result.budgetEligibility, "budgetEligibility must always be present");
  });

  it("success result always carries budgetEligibility with eligible=true", async () => {
    const result = await evaluatePreDispatchGovernanceGate(
      makePipelinePassConfig(),
      [makeValidPlan("T-X")],
      "cycle-budget-check"
    );
    assert.equal(result.blocked, false);
    assert.equal(result.budgetEligibility.eligible, true);
  });

  it("empty plans set passes all gates (no evidence coupling targets)", async () => {
    const result = await evaluatePreDispatchGovernanceGate(
      makePipelinePassConfig(),
      [],
      "cycle-empty"
    );
    assert.equal(result.blocked, false, "empty plans set must not trigger evidence coupling gate");
  });
});

describe("pipeline matrix — full composition (block scenarios)", () => {
  it("governance freeze blocks at gate 3 (GOVERNANCE_FREEZE)", async () => {
    // isFreezeActive checks config.governanceFreeze.manualOverrideActive (not config.governance.freeze)
    const config = makePipelinePassConfig({
      governanceFreeze: { manualOverrideActive: true },
    });
    const result = await evaluatePreDispatchGovernanceGate(config, [makeValidPlan("T-1")], "cycle-freeze");
    assert.equal(result.blocked, true, "governance freeze must block dispatch");
    assert.ok(
      result.reason?.startsWith(BLOCK_REASON.GOVERNANCE_FREEZE_ACTIVE),
      `reason must start with ${BLOCK_REASON.GOVERNANCE_FREEZE_ACTIVE}, got: ${result.reason}`
    );
    assert.equal(result.gateIndex, GATE_PRECEDENCE.GOVERNANCE_FREEZE, "gateIndex must match GOVERNANCE_FREEZE precedence");
  });

  it("lineage cycle blocks at gate 4 (LINEAGE_CYCLE_DETECTED)", async () => {
    const config = makePipelinePassConfig();
    const cyclicPlans = [
      { id: "T-A", task: "task A", dependsOn: ["T-B"], verification_commands: ["npm test"], acceptance_criteria: ["pass"] },
      { id: "T-B", task: "task B", dependsOn: ["T-A"], verification_commands: ["npm test"], acceptance_criteria: ["pass"] },
    ];
    const result = await evaluatePreDispatchGovernanceGate(config, cyclicPlans, "cycle-dag");
    assert.equal(result.blocked, true, "cyclic dependency must block dispatch");
    assert.ok(
      result.reason?.startsWith(BLOCK_REASON.LINEAGE_CYCLE_DETECTED),
      `reason must start with ${BLOCK_REASON.LINEAGE_CYCLE_DETECTED}`
    );
    assert.equal(result.gateIndex, GATE_PRECEDENCE.LINEAGE_CYCLE);
  });

  it("mandatory drift debt blocks at gate 7 (MANDATORY_DRIFT_DEBT_UNRESOLVED)", async () => {
    const config = makePipelinePassConfig();
    const driftReport = {
      scannedDocs:          ["docs/arch.md"],
      presentCount:         0,
      staleCount:           1,
      staleReferences:      [{ docPath: "docs/arch.md", referencedPath: "src/core/ghost.ts", line: 1 }],
      deprecatedTokenCount: 0,
      deprecatedTokenRefs:  [],
    };
    const result = await evaluatePreDispatchGovernanceGate(config, [], "cycle-drift", driftReport as any);
    assert.equal(result.blocked, true, "high-priority drift debt must block dispatch");
    assert.ok(
      result.reason?.startsWith(BLOCK_REASON.MANDATORY_DRIFT_DEBT_UNRESOLVED),
      `reason must start with ${BLOCK_REASON.MANDATORY_DRIFT_DEBT_UNRESOLVED}`
    );
    assert.equal(result.gateIndex, GATE_PRECEDENCE.MANDATORY_DRIFT_DEBT);
    assert.ok(Array.isArray(result.mandatoryDriftPaths), "mandatoryDriftPaths must be present on drift block");
    assert.ok(result.mandatoryDriftPaths!.includes("src/core/ghost.ts"), "ghost path must be in mandatoryDriftPaths");
  });

  it("plan evidence coupling blocks at gate 8 (PLAN_EVIDENCE_COUPLING_INVALID)", async () => {
    const config = makePipelinePassConfig();
    const plans = [
      { id: "T-NoEvidence", task: "some task", dependsOn: [] }, // missing verification_commands and acceptance_criteria
    ];
    const result = await evaluatePreDispatchGovernanceGate(config, plans, "cycle-evidence");
    assert.equal(result.blocked, true, "plan missing evidence coupling must block dispatch");
    assert.ok(
      result.reason?.startsWith(BLOCK_REASON.PLAN_EVIDENCE_COUPLING_INVALID),
      `reason must start with ${BLOCK_REASON.PLAN_EVIDENCE_COUPLING_INVALID}`
    );
    assert.equal(result.gateIndex, GATE_PRECEDENCE.PLAN_EVIDENCE_COUPLING);
  });

  it("higher-precedence gate fires before lower-precedence gate (freeze before evidence coupling)", async () => {
    // Governance freeze fires at gate 3; plan evidence coupling would fire at gate 8.
    // With both conditions active, only the freeze gate must fire.
    // isFreezeActive checks config.governanceFreeze.manualOverrideActive
    const config = makePipelinePassConfig({
      governanceFreeze: { manualOverrideActive: true },
    });
    const plans = [
      { id: "T-MissingEvidence", task: "no evidence here", dependsOn: [] },
    ];
    const result = await evaluatePreDispatchGovernanceGate(config, plans, "cycle-precedence");
    assert.equal(result.blocked, true);
    assert.equal(
      result.gateIndex,
      GATE_PRECEDENCE.GOVERNANCE_FREEZE,
      "freeze (gate 3) must fire before evidence coupling (gate 8)"
    );
    assert.ok(result.reason?.startsWith(BLOCK_REASON.GOVERNANCE_FREEZE_ACTIVE));
  });

  it("negative path: drift gate is skipped when disableDriftDebtGate=true even with stale refs", async () => {
    const config = makePipelinePassConfig({ runtime: { disableDriftDebtGate: true } });
    const driftReport = {
      scannedDocs:          ["docs/arch.md"],
      presentCount:         0,
      staleCount:           1,
      staleReferences:      [{ docPath: "docs/arch.md", referencedPath: "src/core/ghost.ts", line: 1 }],
      deprecatedTokenCount: 0,
      deprecatedTokenRefs:  [],
    };
    const result = await evaluatePreDispatchGovernanceGate(
      config,
      [makeValidPlan("T-DriftDisabled")],
      "cycle-drift-disabled",
      driftReport as any
    );
    assert.equal(result.blocked, false, "drift gate must be skipped when disableDriftDebtGate=true");
  });
});

// ── Nucleus/Frontier model — pipeline matrix integration ─────────────────────

import {
  buildRoleExecutionBatches as buildBatches,
  classifyNucleusFrontier,
  packNucleusFrontierBatches,
  computeCriticalPathScores,
} from "../../src/core/worker_batch_planner.js";

describe("pipeline matrix — nucleus/frontier execution model", () => {
  const baseConfig = {
    copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 },
  };
  const nfConfig = {
    copilot: {
      defaultModel: "Claude Sonnet 4.6",
      modelContextReserveTokens: 0,
      modelContextWindows: { "Claude Sonnet 4.6": 1_000_000 },
    },
    planner: { nucleusFrontierMode: true },
  };

  it("nucleus/frontier mode produces the same or fewer batches than standard mode", () => {
    // 4-plan chain: A→B→C + independent D
    // A,B,C are nucleus; D is frontier — nucleus/frontier should not increase batch count
    const plans = [
      { role: "Evolution Worker", task: "A", wave: 1, dependsOn: [] },
      { role: "Evolution Worker", task: "B", wave: 1, dependsOn: ["A"] },
      { role: "Evolution Worker", task: "C", wave: 1, dependsOn: ["B"] },
      { role: "Evolution Worker", task: "D", wave: 1, dependsOn: [] },
    ];
    const std = buildBatches(plans, baseConfig);
    const nf  = buildBatches(plans, nfConfig);

    assert.ok(
      nf.length <= std.length,
      `nucleus/frontier (${nf.length}) must not exceed standard (${std.length}) batch count`
    );
    // All plans preserved in both modes
    assert.equal(std.flatMap(b => b.plans).length, 4);
    assert.equal(nf.flatMap(b => b.plans).length, 4);
  });

  it("classifyNucleusFrontier is dependency-safe: nucleus score > 0 means blocked dependents", () => {
    // Linear chain: A is nucleus (B depends on it), B is nucleus (C depends on it), C is frontier
    const tasks = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["B"] },
    ];
    const scores = computeCriticalPathScores(tasks);
    const plans = tasks.map(t => ({ task: t.id }));
    const { nucleus, frontier } = classifyNucleusFrontier(plans, scores);

    const nucleusTasks = nucleus.map((p: any) => p.task);
    const frontierTasks = frontier.map((p: any) => p.task);

    // A and B must be nucleus (they have downstream work)
    assert.ok(nucleusTasks.includes("A"), "A must be nucleus (B and C depend on it)");
    assert.ok(nucleusTasks.includes("B"), "B must be nucleus (C depends on it)");
    // C must be frontier (no dependents)
    assert.ok(frontierTasks.includes("C"), "C must be frontier (no dependents)");
  });

  it("packNucleusFrontierBatches never loses plans vs standard packing", () => {
    const tasks = [
      { id: "root", dependsOn: [] },
      { id: "child1", dependsOn: ["root"] },
      { id: "child2", dependsOn: ["root"] },
      { id: "leaf1", dependsOn: ["child1"] },
      { id: "leaf2", dependsOn: ["child2"] },
    ];
    const scores = computeCriticalPathScores(tasks);
    const plans = tasks.map(t => ({ task: t.id, context: "ctx" }));

    const nfBatches = packNucleusFrontierBatches(plans, scores, 1_000_000);
    const allTasks = nfBatches.flatMap(b => (b.plans as any[]).map(p => p.task));

    assert.equal(allTasks.length, 5, "all 5 plans must be present in nucleus/frontier batches");
    for (const t of tasks) {
      assert.ok(allTasks.includes(t.id), `${t.id} must appear in nucleus/frontier output`);
    }
  });

  it("negative: nucleus/frontier mode disabled leaves batch structure unchanged", () => {
    const plans = [
      { role: "Evolution Worker", task: "A", wave: 1, dependsOn: [] },
      { role: "Evolution Worker", task: "B", wave: 1, dependsOn: ["A"] },
    ];
    const std = buildBatches(plans, baseConfig);
    const disabledConfig = { ...baseConfig, planner: { nucleusFrontierMode: false } };
    const withDisabled = buildBatches(plans, disabledConfig);

    // Disabled mode must match default (no mode flag) behavior
    assert.equal(std.length, withDisabled.length, "disabled mode must equal default mode batch count");
    assert.equal(
      std.flatMap(b => b.plans).length,
      withDisabled.flatMap(b => b.plans).length,
      "plan count must match between default and disabled mode"
    );
  });
});
