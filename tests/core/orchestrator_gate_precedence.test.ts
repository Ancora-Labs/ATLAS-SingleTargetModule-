/**
 * orchestrator_gate_precedence.test.ts
 *
 * Tests for GATE_PRECEDENCE and BLOCK_REASON exports and their integration
 * with evaluatePreDispatchGovernanceGate.
 *
 * Acceptance criteria:
 *   - GATE_PRECEDENCE values are unique ordered numbers with no duplicates.
 *   - BLOCK_REASON values are unique non-empty strings.
 *   - Every blocked result from evaluatePreDispatchGovernanceGate includes a gateIndex
 *     matching the corresponding GATE_PRECEDENCE entry.
 *   - reason strings produced by each gate start with the corresponding BLOCK_REASON prefix.
 *   - Non-blocked result does not include a gateIndex field (or it is undefined).
 *   - Guardrail gate emits GATE_PRECEDENCE.GUARDRAIL_PAUSE when active.
 *   - Governance freeze gate emits GATE_PRECEDENCE.GOVERNANCE_FREEZE when active.
 *   - Drift debt gate emits GATE_PRECEDENCE.MANDATORY_DRIFT_DEBT when active.
 *   - Plan evidence coupling gate emits GATE_PRECEDENCE.PLAN_EVIDENCE_COUPLING when active.
 *   - Negative path: non-blocked result has reason=null and no gateIndex.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  GATE_PRECEDENCE,
  BLOCK_REASON,
  evaluatePreDispatchGovernanceGate,
  resolveAthenaCorrectionDispatchBlockReason,
  type GovernanceBlockDecision,
} from "../../src/core/orchestrator.js";
import type { ArchitectureDriftReport } from "../../src/core/architecture_drift.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal config that passes ALL gates (nothing enabled, no debt, no plans). */
function passAllConfig(overrides: Record<string, unknown> = {}) {
  return {
    systemGuardian: { enabled: false },
    governance: { freeze: { active: false } },
    carryForward: { maxCriticalOverdue: 999 },
    budget: { enabled: false },
    workerPool: { minLanes: 1 },
    paths: { stateDir: "/tmp/box-gate-precedence-test" },
    runtime: {},
    ...overrides,
  };
}

function makeDriftReportHighPriority(): ArchitectureDriftReport {
  return {
    scannedDocs: ["docs/arch.md"],
    presentCount: 0,
    staleCount: 1,
    staleReferences: [
      { docPath: "docs/arch.md", referencedPath: "src/core/ghost.ts", line: 1 },
    ],
    deprecatedTokenCount: 0,
    deprecatedTokenRefs: [],
  };
}

// ── Structural invariant tests ────────────────────────────────────────────────

describe("GATE_PRECEDENCE structural invariants", () => {
  it("has only finite numeric values", () => {
    for (const [key, val] of Object.entries(GATE_PRECEDENCE)) {
      assert.equal(typeof val, "number", `GATE_PRECEDENCE.${key} must be a number, got ${typeof val}`);
      assert.ok(Number.isFinite(val), `GATE_PRECEDENCE.${key} must be finite, got ${val}`);
    }
  });

  it("values are unique (no two gates share a precedence number)", () => {
    const values = Object.values(GATE_PRECEDENCE);
    const unique = new Set(values);
    assert.equal(unique.size, values.length, "GATE_PRECEDENCE values must be unique");
  });

  it("values are strictly increasing after sort and start at 1", () => {
    const values = Object.values(GATE_PRECEDENCE).sort((a, b) => a - b);
    assert.equal(values[0], 1, "Expected the lowest GATE_PRECEDENCE value to be 1");
    for (let i = 1; i < values.length; i++) {
      assert.ok(
        values[i] > values[i - 1],
        `Expected strictly increasing sorted precedence values; index ${i - 1}=${values[i - 1]}, index ${i}=${values[i]}`
      );
    }
  });

  it("is frozen (immutable)", () => {
    assert.ok(Object.isFrozen(GATE_PRECEDENCE), "GATE_PRECEDENCE must be frozen");
  });
});

describe("BLOCK_REASON structural invariants", () => {
  it("has only non-empty string values", () => {
    for (const [key, val] of Object.entries(BLOCK_REASON)) {
      assert.equal(typeof val, "string", `BLOCK_REASON.${key} must be a string`);
      assert.ok(val.length > 0, `BLOCK_REASON.${key} must not be empty`);
    }
  });

  it("values are unique (no two block reasons share a prefix)", () => {
    const values = Object.values(BLOCK_REASON);
    const unique = new Set(values);
    assert.equal(unique.size, values.length, "BLOCK_REASON values must be unique");
  });

  it("is frozen (immutable)", () => {
    assert.ok(Object.isFrozen(BLOCK_REASON), "BLOCK_REASON must be frozen");
  });

  it("covers the same number of gates as GATE_PRECEDENCE", () => {
    assert.equal(
      Object.keys(BLOCK_REASON).length,
      Object.keys(GATE_PRECEDENCE).length,
      "BLOCK_REASON must have one entry per gate in GATE_PRECEDENCE"
    );
  });
});

// ── Integration tests: gateIndex on blocked results ──────────────────────────

describe("evaluatePreDispatchGovernanceGate — gateIndex on blocked results", () => {
  it("non-blocked result has reason=null and no gateIndex", async () => {
    const result = await evaluatePreDispatchGovernanceGate(passAllConfig(), [], "test-cycle", null);
    assert.equal(result.blocked, false);
    assert.equal(result.reason, null);
    assert.equal((result as any).gateIndex, undefined, "non-blocked result must not have gateIndex");
  });

  it("governance freeze gate: blocked reason starts with BLOCK_REASON.GOVERNANCE_FREEZE_ACTIVE", async () => {
    const config = passAllConfig({ governanceFreeze: { manualOverrideActive: true } });
    const result = await evaluatePreDispatchGovernanceGate(config, [], "test-cycle");
    assert.equal(result.blocked, true);
    assert.ok(
      result.reason?.startsWith(BLOCK_REASON.GOVERNANCE_FREEZE_ACTIVE),
      `reason must start with '${BLOCK_REASON.GOVERNANCE_FREEZE_ACTIVE}' — got: ${result.reason}`
    );
    assert.equal(
      (result as any).gateIndex,
      GATE_PRECEDENCE.GOVERNANCE_FREEZE,
      `gateIndex must equal GATE_PRECEDENCE.GOVERNANCE_FREEZE (${GATE_PRECEDENCE.GOVERNANCE_FREEZE})`
    );
  });

  it("governance freeze gate: reason includes the freeze sub-reason after ':'", async () => {
    const config = passAllConfig({ governanceFreeze: { manualOverrideActive: true } });
    const result = await evaluatePreDispatchGovernanceGate(config, [], "test-cycle");
    assert.ok(
      result.reason?.includes("MANUAL_OVERRIDE_ACTIVE"),
      `reason must include the freeze sub-reason — got: ${result.reason}`
    );
  });

  it("mandatory drift debt gate: blocked reason starts with BLOCK_REASON.MANDATORY_DRIFT_DEBT_UNRESOLVED", async () => {
    const result = await evaluatePreDispatchGovernanceGate(
      passAllConfig(), [], "test-cycle", makeDriftReportHighPriority()
    );
    assert.equal(result.blocked, true);
    assert.ok(
      result.reason?.startsWith(BLOCK_REASON.MANDATORY_DRIFT_DEBT_UNRESOLVED),
      `reason must start with '${BLOCK_REASON.MANDATORY_DRIFT_DEBT_UNRESOLVED}' — got: ${result.reason}`
    );
    assert.equal(
      (result as any).gateIndex,
      GATE_PRECEDENCE.MANDATORY_DRIFT_DEBT,
      `gateIndex must equal GATE_PRECEDENCE.MANDATORY_DRIFT_DEBT (${GATE_PRECEDENCE.MANDATORY_DRIFT_DEBT})`
    );
  });

  it("plan evidence coupling gate: blocked reason starts with BLOCK_REASON.PLAN_EVIDENCE_COUPLING_INVALID", async () => {
    // A plan with no verification_commands and no acceptance_criteria triggers the evidence coupling gate.
    const plans = [{ task_id: "T-001", task: "do something", role: "backend" }];
    const result = await evaluatePreDispatchGovernanceGate(passAllConfig(), plans, "test-cycle", null);
    assert.equal(result.blocked, true);
    assert.ok(
      result.reason?.startsWith(BLOCK_REASON.PLAN_EVIDENCE_COUPLING_INVALID),
      `reason must start with '${BLOCK_REASON.PLAN_EVIDENCE_COUPLING_INVALID}' — got: ${result.reason}`
    );
    assert.equal(
      (result as any).gateIndex,
      GATE_PRECEDENCE.PLAN_EVIDENCE_COUPLING,
      `gateIndex must equal GATE_PRECEDENCE.PLAN_EVIDENCE_COUPLING (${GATE_PRECEDENCE.PLAN_EVIDENCE_COUPLING})`
    );
  });

  it("lineage cycle gate: gateIndex is lower than drift debt gate (fires earlier)", () => {
    assert.ok(
      GATE_PRECEDENCE.LINEAGE_CYCLE < GATE_PRECEDENCE.MANDATORY_DRIFT_DEBT,
      "LINEAGE_CYCLE gate must fire before MANDATORY_DRIFT_DEBT gate"
    );
  });

  it("budget gate has lowest precedence number (fires first of all)", () => {
    const minPrecedence = Math.min(...Object.values(GATE_PRECEDENCE));
    assert.equal(
      GATE_PRECEDENCE.BUDGET_ELIGIBILITY,
      minPrecedence,
      "BUDGET_ELIGIBILITY must have the lowest precedence number (fires first)"
    );
  });

  it("oversized packet gate has highest precedence number (fires last)", () => {
    const maxPrecedence = Math.max(...Object.values(GATE_PRECEDENCE));
    assert.equal(
      GATE_PRECEDENCE.OVERSIZED_PACKET,
      maxPrecedence,
      "OVERSIZED_PACKET must have the highest precedence number (fires last)"
    );
    assert.ok(
      GATE_PRECEDENCE.SPECIALIZATION_ADMISSION < GATE_PRECEDENCE.OVERSIZED_PACKET,
      "SPECIALIZATION_ADMISSION must fire before OVERSIZED_PACKET"
    );
    assert.ok(
      GATE_PRECEDENCE.ROLLING_COMPLETION_YIELD < GATE_PRECEDENCE.SPECIALIZATION_ADMISSION,
      "ROLLING_COMPLETION_YIELD must fire before SPECIALIZATION_ADMISSION"
    );
  });

  it("negative path: drift gate disabled with disableDriftDebtGate=true does not block", async () => {
    const config = passAllConfig({ runtime: { disableDriftDebtGate: true } });
    const result = await evaluatePreDispatchGovernanceGate(
      config, [], "test-cycle", makeDriftReportHighPriority()
    );
    assert.equal(result.blocked, false, "gate must not block when disableDriftDebtGate=true");
    assert.equal((result as any).gateIndex, undefined);
  });

  it("BLOCK_REASON.GUARDRAIL_PAUSE_WORKERS_ACTIVE matches the legacy guardrail reason string", () => {
    // Ensure constant value matches what the guardrail gate previously emitted inline.
    assert.equal(BLOCK_REASON.GUARDRAIL_PAUSE_WORKERS_ACTIVE, "guardrail_pause_workers_active");
  });

  it("BLOCK_REASON.MANDATORY_DRIFT_DEBT_UNRESOLVED matches the legacy drift gate reason prefix", () => {
    assert.equal(BLOCK_REASON.MANDATORY_DRIFT_DEBT_UNRESOLVED, "mandatory_drift_debt_unresolved");
  });
});

// ── GovernanceBlockDecision envelope contract ─────────────────────────────────

describe("GovernanceBlockDecision envelope contract", () => {
  it("blocked result contains all required envelope fields with correct types", async () => {
    const config = passAllConfig({ governanceFreeze: { manualOverrideActive: true } });
    const result: GovernanceBlockDecision = await evaluatePreDispatchGovernanceGate(config, [], "envelope-blocked-test");
    assert.equal(typeof result.blocked, "boolean", "blocked must be boolean");
    assert.equal(result.blocked, true);
    assert.equal(typeof result.reason, "string", "reason must be a string on blocked result");
    assert.equal(result.cycleId, "envelope-blocked-test", "cycleId must be carried through");
    assert.ok("budgetEligibility" in result, "budgetEligibility must always be present");
    assert.equal(typeof result.budgetEligibility, "object", "budgetEligibility must be an object");
    assert.ok("graphResult" in result, "graphResult must always be present");
    assert.ok("action" in result, "action must always be present");
    assert.equal(typeof result.gateIndex, "number", "gateIndex must be a number on blocked result");
    assert.equal(typeof result.gateKey, "string", "gateKey must be a string on blocked result");
  });

  it("non-blocked result has gateIndex=undefined, reason=null, and action=undefined", async () => {
    const result: GovernanceBlockDecision = await evaluatePreDispatchGovernanceGate(passAllConfig(), [], "envelope-pass-test");
    assert.equal(result.blocked, false);
    assert.equal(result.reason, null, "reason must be null on non-blocked result");
    assert.equal(result.gateIndex, undefined, "gateIndex must be absent on non-blocked result");
    assert.equal(result.gateKey, undefined, "gateKey must be absent on non-blocked result");
    assert.equal(result.action, undefined, "action must be undefined on non-blocked result");
    assert.ok("budgetEligibility" in result, "budgetEligibility must always be present");
    assert.ok("graphResult" in result, "graphResult must always be present");
  });

  it("drift block carries mandatoryDriftPaths in the envelope", async () => {
    const result: GovernanceBlockDecision = await evaluatePreDispatchGovernanceGate(
      passAllConfig(), [], "envelope-drift-test", makeDriftReportHighPriority()
    );
    assert.equal(result.blocked, true);
    assert.ok(Array.isArray(result.mandatoryDriftPaths), "mandatoryDriftPaths must be an array on drift block");
    assert.ok(result.mandatoryDriftPaths!.length > 0, "mandatoryDriftPaths must be non-empty on drift block");
    assert.equal(result.gateKey, "MANDATORY_DRIFT_DEBT");
    assert.equal(result.gateIndex, GATE_PRECEDENCE.MANDATORY_DRIFT_DEBT);
  });

  it("negative path: envelope is consistent across all gate pass scenarios (no extra fields leak)", async () => {
    // With no gates active and no plans, result must only contain the standard envelope fields.
    const result: GovernanceBlockDecision = await evaluatePreDispatchGovernanceGate(passAllConfig(), [], "envelope-clean-test");
    assert.equal(result.blocked, false);
    assert.equal(result.mandatoryDriftPaths, undefined, "mandatoryDriftPaths must be absent on pass");
    assert.equal(result.rollbackResult, undefined, "rollbackResult must be absent on pass");
    assert.equal(result.gateIndex, undefined, "gateIndex must be absent on pass");
  });
});

// ── Governance BLOCK end-to-end flow assertions ───────────────────────────────
// Covers:
//   - Budget exhaustion gate (writes temp budget file, verifies blocked=true)
//   - Carry-forward debt gate (writes temp ledger with critical overdue debt)
//   - Gate precedence ordering (freeze fires before drift when both active)
//   - All blocked envelopes carry non-null reason + gateIndex
//   - Plan with one valid + one invalid evidence coupling: invalid blocks dispatch
//   - Negative path: valid plans with all gates disabled → clean pass

describe("evaluatePreDispatchGovernanceGate — end-to-end block flow assertions", () => {
  it("budget exhaustion gate fires when budget is at/below threshold (BUDGET_ELIGIBILITY gate)", async () => {
    const stateDir = path.join(os.tmpdir(), `box-budget-gate-${Date.now()}`);
    await fs.mkdir(stateDir, { recursive: true });
    try {
      // Write a budget file with 0 remaining USD (below the 0.2 threshold)
      const budgetFile = path.join(stateDir, "budget.json");
      await fs.writeFile(budgetFile, JSON.stringify({
        initialUsd: 10,
        remainingUsd: 0.0,
        claudeCalls: 100,
        workerRuns: 50,
        updatedAt: new Date().toISOString(),
      }));

      const config = {
        systemGuardian: { enabled: false },
        governance: { freeze: { active: false } },
        carryForward: { maxCriticalOverdue: 999 },
        budget: { enabled: true },
        env: { budgetUsd: 10 },
        workerPool: { minLanes: 1 },
        paths: { stateDir, budgetFile },
        runtime: {},
      };

      const result: GovernanceBlockDecision = await evaluatePreDispatchGovernanceGate(config, [], "budget-gate-test");

      assert.equal(result.blocked, true, "budget exhaustion must block dispatch");
      assert.ok(
        result.reason?.startsWith(BLOCK_REASON.BUDGET_EXHAUSTED),
        `reason must start with '${BLOCK_REASON.BUDGET_EXHAUSTED}' — got: ${result.reason}`
      );
      assert.equal(result.gateIndex, GATE_PRECEDENCE.BUDGET_ELIGIBILITY,
        "gateIndex must equal GATE_PRECEDENCE.BUDGET_ELIGIBILITY");
      assert.ok("budgetEligibility" in result, "budgetEligibility must be present on budget block");
      assert.equal(result.budgetEligibility.eligible, false, "budgetEligibility.eligible must be false");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("carry-forward debt gate fires when critical debt is overdue (CARRY_FORWARD_DEBT gate)", async () => {
    const stateDir = path.join(os.tmpdir(), `box-debt-gate-${Date.now()}`);
    await fs.mkdir(stateDir, { recursive: true });
    try {
      // Write a ledger with 3 critical overdue entries (openedCycle=1, dueCycle=1, currentCycle=10)
      const ledgerFile = path.join(stateDir, "carry_forward_ledger.json");
      const entries = Array.from({ length: 3 }, (_, i) => ({
        id: `debt-${i}`,
        lesson: `Critical overdue debt ${i}`,
        severity: "critical",
        openedCycle: 1,
        dueCycle: 1,
        cyclesOpen: 9,
        closedAt: null,
        closureEvidence: null,
      }));
      await fs.writeFile(ledgerFile, JSON.stringify({ entries, cycleCounter: 10 }));

      const config = {
        systemGuardian: { enabled: false },
        governance: { freeze: { active: false } },
        carryForward: { maxCriticalOverdue: 3 }, // block at >= 3
        budget: { enabled: false },
        workerPool: { minLanes: 1 },
        paths: { stateDir },
        runtime: {},
      };

      const result: GovernanceBlockDecision = await evaluatePreDispatchGovernanceGate(config, [], "debt-gate-test");

      assert.equal(result.blocked, true, "critical overdue debt must block dispatch");
      assert.ok(
        result.reason?.startsWith(BLOCK_REASON.CRITICAL_DEBT_OVERDUE),
        `reason must start with '${BLOCK_REASON.CRITICAL_DEBT_OVERDUE}' — got: ${result.reason}`
      );
      assert.equal(result.gateIndex, GATE_PRECEDENCE.CARRY_FORWARD_DEBT,
        "gateIndex must equal GATE_PRECEDENCE.CARRY_FORWARD_DEBT");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("freeze gate fires before drift gate when both would block (lower precedence wins)", async () => {
    // Both governance freeze AND high-priority drift debt are active.
    // Freeze (precedence 3) must fire before drift (precedence 7).
    const config = passAllConfig({ governanceFreeze: { manualOverrideActive: true } });
    const result = await evaluatePreDispatchGovernanceGate(
      config, [], "precedence-freeze-vs-drift", makeDriftReportHighPriority()
    );

    assert.equal(result.blocked, true, "must be blocked");
    assert.ok(
      result.reason?.startsWith(BLOCK_REASON.GOVERNANCE_FREEZE_ACTIVE),
      `freeze must win over drift; reason='${result.reason}'`
    );
    assert.equal(result.gateIndex, GATE_PRECEDENCE.GOVERNANCE_FREEZE,
      `gateIndex must equal GATE_PRECEDENCE.GOVERNANCE_FREEZE (${GATE_PRECEDENCE.GOVERNANCE_FREEZE}), not drift (${GATE_PRECEDENCE.MANDATORY_DRIFT_DEBT})`);
  });

  it("all tested gate types produce non-null, non-empty reason strings on block", async () => {
    const blockedCases: Array<{ label: string; config: unknown; plans?: unknown[]; drift?: ArchitectureDriftReport | null }> = [
      {
        label: "governance freeze",
        config: passAllConfig({ governanceFreeze: { manualOverrideActive: true } }),
      },
      {
        label: "drift debt",
        config: passAllConfig(),
        drift: makeDriftReportHighPriority(),
      },
      {
        label: "evidence coupling",
        config: passAllConfig(),
        plans: [{ task_id: "T-001", task: "do something", role: "backend" }],
      },
    ];

    for (const tc of blockedCases) {
      const result = await evaluatePreDispatchGovernanceGate(
        tc.config, tc.plans ?? [], `reason-test-${tc.label}`, tc.drift ?? null
      );
      assert.equal(result.blocked, true, `${tc.label}: must be blocked`);
      assert.ok(result.reason !== null && result.reason.length > 0,
        `${tc.label}: blocked result must have a non-empty reason string`);
      assert.ok(typeof result.gateIndex === "number",
        `${tc.label}: blocked result must have a numeric gateIndex`);
      assert.ok(result.gateIndex >= 1,
        `${tc.label}: gateIndex must be >= 1`);
    }
  });

  it("non-blocked result carries the exact cycleId passed to the function", async () => {
    const result = await evaluatePreDispatchGovernanceGate(passAllConfig(), [], "cycle-id-propagation-test");
    assert.equal(result.cycleId, "cycle-id-propagation-test",
      "cycleId must be propagated from the argument through to the result envelope");
    assert.ok("budgetEligibility" in result, "budgetEligibility must be present on pass");
    assert.equal(typeof result.budgetEligibility, "object");
    assert.equal(result.budgetEligibility.eligible, true, "budget must be eligible when unconfigured");
  });

  it("plan evidence coupling gate: reason encodes the failing plan task_id", async () => {
    const plans = [{ task_id: "T-FAIL-007", task: "do something without evidence", role: "evolution-worker" }];
    const result = await evaluatePreDispatchGovernanceGate(passAllConfig(), plans, "coupling-id-test");
    assert.equal(result.blocked, true);
    assert.ok(
      result.reason?.startsWith(BLOCK_REASON.PLAN_EVIDENCE_COUPLING_INVALID),
      `reason must start with coupling prefix — got: ${result.reason}`
    );
    assert.ok(
      result.reason?.includes("T-FAIL-007"),
      `reason must encode the failing plan ID; got: ${result.reason}`
    );
  });

  it("plan with full evidence passes coupling gate — negative path for coupling block", async () => {
    // A plan with valid verification_commands and acceptance_criteria must NOT trigger the coupling gate.
    const plans = [
      {
        task_id: "T-GOOD-001",
        task: "do something well-specified",
        role: "evolution-worker",
        verification_commands: ["npm test"],
        acceptance_criteria: ["All tests pass"],
      },
    ];
    const result = await evaluatePreDispatchGovernanceGate(passAllConfig(), plans, "valid-plan-coupling-test");
    assert.equal(result.blocked, false, "valid plans must not trigger the evidence coupling gate");
    assert.equal(result.reason, null);
  });

  it("negative path: empty plans + all gates disabled → always passes with clean envelope", async () => {
    const result: GovernanceBlockDecision = await evaluatePreDispatchGovernanceGate(
      passAllConfig(), [], "clean-pass-e2e", null
    );
    assert.equal(result.blocked, false);
    assert.equal(result.reason, null);
    assert.equal(result.action, undefined);
    assert.equal(result.gateIndex, undefined);
    assert.equal(result.mandatoryDriftPaths, undefined);
    assert.equal(result.rollbackResult, undefined);
    assert.equal(result.cycleId, "clean-pass-e2e");
    assert.ok("graphResult" in result);
    assert.ok("budgetEligibility" in result);
  });
});

describe("resolveAthenaCorrectionDispatchBlockReason precedence", () => {
  it("selects the highest-precedence canonical block reason when multiple governance tokens are present", () => {
    const reason = resolveAthenaCorrectionDispatchBlockReason([
      "Pre-dispatch governance state infeasible (critical_debt_overdue, force_checkpoint_validation_active) — resolve active gate before dispatch",
    ]);
    assert.equal(
      reason,
      `${BLOCK_REASON.GUARDRAIL_FORCE_CHECKPOINT_ACTIVE}:athena_correction_token=${BLOCK_REASON.GUARDRAIL_FORCE_CHECKPOINT_ACTIVE}`,
    );
  });

  it("negative path: ignores tokens that are neither canonical governance signals nor block reasons", () => {
    const reason = resolveAthenaCorrectionDispatchBlockReason([
      "verification command rewrite requested",
      "format docs and rerun targeted checks",
    ]);
    assert.equal(reason, null);
  });

  it("treats rolling_yield_throttle correction token as a blocking governance signal", () => {
    const reason = resolveAthenaCorrectionDispatchBlockReason([
      "athena correction: rolling_yield_throttle observed in dispatch telemetry",
      "verification command rewrite requested",
    ]);
    assert.equal(
      reason,
      `${BLOCK_REASON.ROLLING_YIELD_THROTTLE}:athena_correction_token=${BLOCK_REASON.ROLLING_YIELD_THROTTLE}`,
    );
  });

  it("treats autonomy_execution_gate_not_ready as a canonical blocking governance signal", () => {
    const reason = resolveAthenaCorrectionDispatchBlockReason([
      "athena correction: autonomy_execution_gate_not_ready detected in latest pre-dispatch audit",
      "rolling_yield_throttle observed in dispatch telemetry",
    ]);
    assert.equal(
      reason,
      `${BLOCK_REASON.AUTONOMY_EXECUTION_GATE_NOT_READY}:athena_correction_token=${BLOCK_REASON.AUTONOMY_EXECUTION_GATE_NOT_READY}`,
    );
  });
});

// ── Task 2: AUTO_APPROVE_DISPATCH_SIGNAL invariants ───────────────────────────

import { AUTO_APPROVE_DISPATCH_SIGNAL } from "../../src/core/orchestrator.js";

describe("AUTO_APPROVE_DISPATCH_SIGNAL structural invariants", () => {
  it("exports LOW_RISK_UNCHANGED and HIGH_QUALITY_LOW_RISK", () => {
    assert.equal(AUTO_APPROVE_DISPATCH_SIGNAL.LOW_RISK_UNCHANGED, "LOW_RISK_UNCHANGED");
    assert.equal(AUTO_APPROVE_DISPATCH_SIGNAL.HIGH_QUALITY_LOW_RISK, "HIGH_QUALITY_LOW_RISK");
  });

  it("is frozen (immutable)", () => {
    assert.ok(Object.isFrozen(AUTO_APPROVE_DISPATCH_SIGNAL), "AUTO_APPROVE_DISPATCH_SIGNAL must be frozen");
  });

  it("signal values are non-empty strings", () => {
    for (const [key, val] of Object.entries(AUTO_APPROVE_DISPATCH_SIGNAL)) {
      assert.equal(typeof val, "string", `${key} must be a string`);
      assert.ok(val.length > 0, `${key} must be non-empty`);
    }
  });

  it("adding auto-approve telemetry does not affect GATE_PRECEDENCE ordering", () => {
    // Regression guard: precedence values must remain sortable and strictly
    // increasing even as additional gates are introduced.
    const values = Object.values(GATE_PRECEDENCE).sort((a, b) => a - b);
    assert.equal(values[0], 1, "GATE_PRECEDENCE must start at 1");
    for (let i = 1; i < values.length; i++) {
      assert.ok(
        values[i] > values[i - 1],
        `GATE_PRECEDENCE must remain strictly increasing — invalid pair ${values[i - 1]} then ${values[i]}`
      );
    }
  });
});


// ── Rolling completion yield gate integration ─────────────────────────────────

describe("evaluatePreDispatchGovernanceGate — ROLLING_COMPLETION_YIELD gate", () => {
  it("BLOCK_REASON.ROLLING_YIELD_THROTTLE is a non-empty string", () => {
    assert.equal(typeof BLOCK_REASON.ROLLING_YIELD_THROTTLE, "string");
    assert.ok(BLOCK_REASON.ROLLING_YIELD_THROTTLE.length > 0);
  });

  it("GATE_PRECEDENCE.ROLLING_COMPLETION_YIELD is 11", () => {
    assert.equal(GATE_PRECEDENCE.ROLLING_COMPLETION_YIELD, 11);
  });

  it("rolling yield gate does not fire when no usage log exists (fail-open)", async () => {
    // passAllConfig uses a stateDir that has no premium_usage_log.json
    const result = await evaluatePreDispatchGovernanceGate(passAllConfig(), [], "yield-pass-test");
    assert.equal(result.blocked, false, "must fail-open when no usage log exists");
    assert.equal(result.gateIndex, undefined, "gateIndex must be absent on pass");
  });

  it("rolling yield gate fires when recent dispatch yield is at/below throttle threshold", async () => {
    const stateDir = path.join(os.tmpdir(), `box-yield-gate-${Date.now()}`);
    await fs.mkdir(stateDir, { recursive: true });
    try {
      // Write 5 all-failed dispatches → yield = 0.0 ≤ 0.2 → throttled
      const entries = Array.from({ length: 5 }, (_, i) => ({
        role: "worker",
        outcome: "failed",
        timestamp: new Date().toISOString(),
        taskId: `task-${i}`,
      }));
      await fs.writeFile(
        path.join(stateDir, "premium_usage_log.json"),
        JSON.stringify(entries),
        "utf8"
      );

      const config = {
        systemGuardian: { enabled: false },
        governance: { freeze: { active: false } },
        carryForward: { maxCriticalOverdue: 999 },
        budget: { enabled: false },
        workerPool: { minLanes: 1 },
        paths: { stateDir },
        runtime: {},
      };

      const result: GovernanceBlockDecision = await evaluatePreDispatchGovernanceGate(config, [], "yield-block-test");
      assert.equal(result.blocked, true, "low yield must block dispatch");
      assert.ok(
        result.reason?.startsWith(BLOCK_REASON.ROLLING_YIELD_THROTTLE),
        `reason must start with '${BLOCK_REASON.ROLLING_YIELD_THROTTLE}' — got: ${result.reason}`
      );
      assert.equal(result.gateIndex, GATE_PRECEDENCE.ROLLING_COMPLETION_YIELD,
        "gateIndex must equal GATE_PRECEDENCE.ROLLING_COMPLETION_YIELD");
      assert.ok("rollingYieldContract" in result, "rollingYieldContract must be present on rolling yield block");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("negative path: rolling yield gate does not fire when yield is healthy", async () => {
    const stateDir = path.join(os.tmpdir(), `box-yield-pass-${Date.now()}`);
    await fs.mkdir(stateDir, { recursive: true });
    try {
      // 5 dispatches, 4 done → yield = 0.8 > threshold → pass
      const entries = [
        ...Array.from({ length: 4 }, () => ({ role: "w", outcome: "done", timestamp: new Date().toISOString() })),
        { role: "w", outcome: "failed", timestamp: new Date().toISOString() },
      ];
      await fs.writeFile(
        path.join(stateDir, "premium_usage_log.json"),
        JSON.stringify(entries),
        "utf8"
      );
      const config = {
        systemGuardian: { enabled: false },
        governance: { freeze: { active: false } },
        carryForward: { maxCriticalOverdue: 999 },
        budget: { enabled: false },
        workerPool: { minLanes: 1 },
        paths: { stateDir },
        runtime: {},
      };
      const result: GovernanceBlockDecision = await evaluatePreDispatchGovernanceGate(config, [], "yield-healthy-test");
      assert.equal(result.blocked, false, "healthy yield must not block dispatch");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("evaluatePreDispatchGovernanceGate — lane diversity pre-dispatch gate", () => {
  it("does not block in pre-dispatch gate when active lane count is below minLanes", async () => {
    const config = passAllConfig({
      workerPool: { minLanes: 2 },
    });
    const plans = [
      {
        role: "Evolution Worker",
        task: "task-a",
        task_id: "a",
        acceptance_criteria: ["ac-a"],
        verification: "npm test -- tests/core/orchestrator_gate_precedence.test.ts",
        verification_commands: ["npm test -- tests/core/orchestrator_gate_precedence.test.ts"],
      },
      {
        role: "Evolution Worker",
        task: "task-b",
        task_id: "b",
        acceptance_criteria: ["ac-b"],
        verification: "npm test -- tests/core/orchestrator_gate_precedence.test.ts",
        verification_commands: ["npm test -- tests/core/orchestrator_gate_precedence.test.ts"],
      },
    ];
    const result = await evaluatePreDispatchGovernanceGate(config, plans, "lane-diversity-test");
    assert.equal(result.blocked, false);
  });
});
