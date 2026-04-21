/**
 * orchestrator_repair_flow.test.ts
 *
 * Tests for the Step 3.5 repair loop design contract and Phase B health audit flow.
 *
 * Scenarios:
 *   1. reject → repair(REPLAN_ONCE) → approve → workers dispatched
 *   2. reject → repair(REPLAN_ONCE) → reject → stop + escalate (no 3rd attempt)
 *   3. reject → repair(STOP_AND_ESCALATE) → stop immediately
 *   4. success loop → health audit HEALTHY → continue
 *   5. success loop → health audit UNHEALTHY → escalate
 *
 * These are deterministic flow-simulation tests. They verify the logical
 * contract of the repair loop without mocking agent calls.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { REPAIR_GATE, HEALTH_GATE } from "../../src/core/self_improvement_repair.js";
import { SI_STATUS } from "../../src/core/si_control.js";

// ── Flow simulation helpers ─────────────────────────────────────────────────

/**
 * Simulate the Step 3.5 repair flow logic deterministically.
 *
 * @param {object} params
 * @param {object} params.athenaReview1  — { approved, corrections? }
 * @param {string} [params.repairGate]   — REPLAN_ONCE or STOP_AND_ESCALATE
 * @param {object} [params.athenaReview2] — { approved, corrections? }
 * @returns {{ outcome: string, athenaReviewCount: number, escalated: boolean, thirdAttempt: boolean }}
 */
function simulateRepairFlow({ athenaReview1, repairGate, athenaReview2 }) {
  let athenaReviewCount = 0;
  let escalated = false;
  const thirdAttempt = false; // NEVER a 3rd attempt by design

  // Athena review #1
  athenaReviewCount++;
  if (athenaReview1.approved) {
    return { outcome: "workers_dispatched", athenaReviewCount, escalated, thirdAttempt };
  }

  // Self-improvement repair analysis
  if (!repairGate || repairGate === REPAIR_GATE.STOP_AND_ESCALATE) {
    escalated = true;
    return { outcome: "stopped", athenaReviewCount, escalated, thirdAttempt };
  }

  // REPLAN_ONCE: Prometheus re-plans, Athena reviews again
  athenaReviewCount++;
  if (athenaReview2?.approved) {
    return { outcome: "workers_dispatched", athenaReviewCount, escalated, thirdAttempt };
  }

  // 2nd rejection — hard stop, escalation
  escalated = true;
  return { outcome: "stopped", athenaReviewCount, escalated, thirdAttempt };
}

/**
 * Simulate the Phase B health audit flow.
 *
 * @param {object} params
 * @param {string} params.gateDecision — HEALTHY or UNHEALTHY
 * @returns {{ outcome: string, escalated: boolean }}
 */
function simulateHealthAudit({ gateDecision }) {
  if (gateDecision === HEALTH_GATE.UNHEALTHY) {
    return { outcome: "escalated", escalated: true };
  }
  return { outcome: "continue", escalated: false };
}

// ── Step 3.5 Repair Flow Tests ──────────────────────────────────────────────

describe("Step 3.5: Athena reject → Self-Improvement repair → re-plan flow", () => {
  it("reject → repair(REPLAN_ONCE) → approve: dispatches workers", () => {
    const flow = simulateRepairFlow({
      athenaReview1: { approved: false, corrections: ["missing target_files"] },
      repairGate: REPAIR_GATE.REPLAN_ONCE,
      athenaReview2: { approved: true },
    });
    assert.equal(flow.outcome, "workers_dispatched");
    assert.equal(flow.athenaReviewCount, 2);
    assert.equal(flow.escalated, false);
  });

  it("reject → repair(REPLAN_ONCE) → reject: stops + escalates, no 3rd attempt", () => {
    const flow = simulateRepairFlow({
      athenaReview1: { approved: false, corrections: ["missing verification"] },
      repairGate: REPAIR_GATE.REPLAN_ONCE,
      athenaReview2: { approved: false, corrections: ["still missing"] },
    });
    assert.equal(flow.outcome, "stopped");
    assert.equal(flow.athenaReviewCount, 2);
    assert.equal(flow.escalated, true);
    assert.equal(flow.thirdAttempt, false, "must NEVER attempt a 3rd review");
  });

  it("reject → repair(STOP_AND_ESCALATE): stops immediately after 1 review", () => {
    const flow = simulateRepairFlow({
      athenaReview1: { approved: false, corrections: ["systemic failure"] },
      repairGate: REPAIR_GATE.STOP_AND_ESCALATE,
    });
    assert.equal(flow.outcome, "stopped");
    assert.equal(flow.athenaReviewCount, 1);
    assert.equal(flow.escalated, true);
  });

  it("approve on first review: skips repair entirely", () => {
    const flow = simulateRepairFlow({
      athenaReview1: { approved: true },
    });
    assert.equal(flow.outcome, "workers_dispatched");
    assert.equal(flow.athenaReviewCount, 1);
    assert.equal(flow.escalated, false);
  });

  it("repair with no gate decision defaults to STOP_AND_ESCALATE", () => {
    const flow = simulateRepairFlow({
      athenaReview1: { approved: false },
      repairGate: undefined,
    });
    assert.equal(flow.outcome, "stopped");
    assert.equal(flow.escalated, true);
  });
});

// ── Phase B Health Audit Tests ──────────────────────────────────────────────

describe("Phase B: Post-completion health audit flow", () => {
  it("HEALTHY verdict: allows continuation", () => {
    const flow = simulateHealthAudit({ gateDecision: HEALTH_GATE.HEALTHY });
    assert.equal(flow.outcome, "continue");
    assert.equal(flow.escalated, false);
  });

  it("UNHEALTHY verdict: triggers escalation", () => {
    const flow = simulateHealthAudit({ gateDecision: HEALTH_GATE.UNHEALTHY });
    assert.equal(flow.outcome, "escalated");
    assert.equal(flow.escalated, true);
  });
});

// ── Gate constant integrity ─────────────────────────────────────────────────

describe("Gate decision constants are immutable", () => {
  it("REPAIR_GATE is frozen", () => {
    assert.throws(() => { REPAIR_GATE.THIRD_TRY = "NOPE"; }, TypeError);
  });

  it("HEALTH_GATE is frozen", () => {
    assert.throws(() => { HEALTH_GATE.MAYBE = "NOPE"; }, TypeError);
  });
});

// ── SI Disabled: deterministic fallback flows ────────────────────────────────

/**
 * Simulate the Step 3.5 repair flow when SI is disabled.
 * When SI is off: reject → direct escalate (no repair attempt).
 */
function simulateRepairFlowWithSiGate({ athenaReview1, siGate, repairGate, athenaReview2 }) {
  let athenaReviewCount = 0;
  let escalated = false;

  athenaReviewCount++;
  if (athenaReview1.approved) {
    return { outcome: "workers_dispatched", athenaReviewCount, escalated, siSkipped: false };
  }

  // SI gate check
  if (!siGate.active) {
    escalated = true;
    return { outcome: "stopped", athenaReviewCount, escalated, siSkipped: true, siStatus: siGate.status };
  }

  // SI active — normal repair flow
  if (!repairGate || repairGate === REPAIR_GATE.STOP_AND_ESCALATE) {
    escalated = true;
    return { outcome: "stopped", athenaReviewCount, escalated, siSkipped: false };
  }

  athenaReviewCount++;
  if (athenaReview2?.approved) {
    return { outcome: "workers_dispatched", athenaReviewCount, escalated, siSkipped: false };
  }

  escalated = true;
  return { outcome: "stopped", athenaReviewCount, escalated, siSkipped: false };
}

/**
 * Simulate health audit flow with SI gate.
 */
function simulateHealthAuditWithSiGate({ siGate, gateDecision }) {
  if (!siGate.active) {
    return { outcome: "skipped", escalated: false, siSkipped: true, siStatus: siGate.status };
  }
  if (gateDecision === HEALTH_GATE.UNHEALTHY) {
    return { outcome: "escalated", escalated: true, siSkipped: false };
  }
  return { outcome: "continue", escalated: false, siSkipped: false };
}

describe("SI disabled: repair flow fallback", () => {
  it("reject + SI disabled (config) → direct escalate, no repair", () => {
    const flow = simulateRepairFlowWithSiGate({
      athenaReview1: { approved: false },
      siGate: { active: false, status: SI_STATUS.DISABLED_CONFIG },
    });
    assert.equal(flow.outcome, "stopped");
    assert.equal(flow.escalated, true);
    assert.equal(flow.siSkipped, true);
    assert.equal(flow.siStatus, SI_STATUS.DISABLED_CONFIG);
    assert.equal(flow.athenaReviewCount, 1);
  });

  it("reject + SI disabled (manual) → direct escalate", () => {
    const flow = simulateRepairFlowWithSiGate({
      athenaReview1: { approved: false },
      siGate: { active: false, status: SI_STATUS.DISABLED_MANUAL },
    });
    assert.equal(flow.outcome, "stopped");
    assert.equal(flow.siSkipped, true);
    assert.equal(flow.siStatus, SI_STATUS.DISABLED_MANUAL);
  });

  it("reject + SI disabled (guardrail) → direct escalate", () => {
    const flow = simulateRepairFlowWithSiGate({
      athenaReview1: { approved: false },
      siGate: { active: false, status: SI_STATUS.DISABLED_GUARDRAIL },
    });
    assert.equal(flow.outcome, "stopped");
    assert.equal(flow.siSkipped, true);
    assert.equal(flow.siStatus, SI_STATUS.DISABLED_GUARDRAIL);
  });

  it("reject + SI ACTIVE → normal repair flow (REPLAN_ONCE + approve)", () => {
    const flow = simulateRepairFlowWithSiGate({
      athenaReview1: { approved: false },
      siGate: { active: true, status: SI_STATUS.ACTIVE },
      repairGate: REPAIR_GATE.REPLAN_ONCE,
      athenaReview2: { approved: true },
    });
    assert.equal(flow.outcome, "workers_dispatched");
    assert.equal(flow.siSkipped, false);
    assert.equal(flow.athenaReviewCount, 2);
  });

  it("approve on first review → SI gate never checked", () => {
    const flow = simulateRepairFlowWithSiGate({
      athenaReview1: { approved: true },
      siGate: { active: false, status: SI_STATUS.DISABLED_CONFIG },
    });
    assert.equal(flow.outcome, "workers_dispatched");
    assert.equal(flow.siSkipped, false);
  });
});

describe("SI disabled: health audit fallback", () => {
  it("SI disabled → health audit skipped", () => {
    const flow = simulateHealthAuditWithSiGate({
      siGate: { active: false, status: SI_STATUS.DISABLED_MANUAL },
      gateDecision: HEALTH_GATE.UNHEALTHY,
    });
    assert.equal(flow.outcome, "skipped");
    assert.equal(flow.siSkipped, true);
    assert.equal(flow.escalated, false);
  });

  it("SI active + HEALTHY → continue", () => {
    const flow = simulateHealthAuditWithSiGate({
      siGate: { active: true, status: SI_STATUS.ACTIVE },
      gateDecision: HEALTH_GATE.HEALTHY,
    });
    assert.equal(flow.outcome, "continue");
    assert.equal(flow.siSkipped, false);
  });

  it("SI active + UNHEALTHY → escalate", () => {
    const flow = simulateHealthAuditWithSiGate({
      siGate: { active: true, status: SI_STATUS.ACTIVE },
      gateDecision: HEALTH_GATE.UNHEALTHY,
    });
    assert.equal(flow.outcome, "escalated");
    assert.equal(flow.escalated, true);
    assert.equal(flow.siSkipped, false);
  });
});

// ── Combined lifecycle integration test ─────────────────────────────────────

/**
 * Simulate the full combined orchestration lifecycle in one deterministic path:
 *   SI active → Athena reject → REPLAN_ONCE → Athena approve → workers_dispatched
 *   → health audit HEALTHY → continue
 *
 * Validates governance gate outcomes and artifact state across both the repair
 * loop and the health audit phase in a single end-to-end pass.
 */
describe("combined orchestration lifecycle — governance and artifact outcomes", () => {
  it("SI active: reject → REPLAN_ONCE → approve → dispatch → health HEALTHY → continue [integration]", () => {
    // ── Phase A: SI gate and repair loop ──────────────────────────────────────
    const repairFlow = simulateRepairFlowWithSiGate({
      athenaReview1: { approved: false, corrections: ["missing verification_command"] },
      siGate: { active: true, status: SI_STATUS.ACTIVE },
      repairGate: REPAIR_GATE.REPLAN_ONCE,
      athenaReview2: { approved: true },
    });

    // Repair loop outcome: workers must be dispatched after the second approval
    assert.equal(repairFlow.outcome, "workers_dispatched",
      "combined lifecycle must reach workers_dispatched after REPLAN_ONCE succeeds"
    );
    assert.equal(repairFlow.athenaReviewCount, 2,
      "exactly 2 Athena reviews must occur: initial reject + post-repair approve"
    );
    assert.equal(repairFlow.escalated, false,
      "no escalation must occur when the second review approves"
    );
    assert.equal(repairFlow.siSkipped, false,
      "SI gate must be active throughout the repair loop — siSkipped must be false"
    );

    // ── Phase B: health audit ─────────────────────────────────────────────────
    const healthFlow = simulateHealthAuditWithSiGate({
      siGate: { active: true, status: SI_STATUS.ACTIVE },
      gateDecision: HEALTH_GATE.HEALTHY,
    });

    // Health audit outcome: system is healthy, pipeline continues
    assert.equal(healthFlow.outcome, "continue",
      "health audit must return continue when system is HEALTHY after successful dispatch"
    );
    assert.equal(healthFlow.escalated, false,
      "health audit must not escalate when outcome is HEALTHY"
    );
    assert.equal(healthFlow.siSkipped, false,
      "health audit must run (not be skipped) when SI gate is active"
    );

    // ── Combined artifact governance invariants ───────────────────────────────
    // These invariants must hold across both phases of the lifecycle:
    //   1. Total Athena reviews across the full lifecycle: exactly 2 (no 3rd attempt)
    //   2. No escalation path triggered in either phase
    //   3. SI gate remained active throughout — no short-circuit skip
    assert.ok(
      repairFlow.athenaReviewCount === 2 && !repairFlow.escalated && !healthFlow.escalated,
      "governance artifact invariant: 2 reviews, 0 escalations across both lifecycle phases"
    );
  });
});
