/**
 * orchestrator_health_divergence.test.ts
 *
 * Tests for the deterministic healthDivergence output and status mapping.
 * Verifies that operational health (orchestrator) and planner health (Prometheus)
 * disagreements resolve to explicit, predictable warning states.
 *
 * Acceptance criteria:
 *  - Every combination of (operationalStatus, plannerHealth) maps to a
 *    deterministic divergenceState and pipelineStatus.
 *  - isWarning is true whenever divergenceState !== "none".
 *  - Unknown/missing inputs produce divergenceState="unknown" without throwing.
 *  - Negative path: degraded operational + critical planner → both_degraded + critical.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeHealthDivergence,
  HEALTH_DIVERGENCE_STATE,
  PIPELINE_HEALTH_STATUS,
  ORCHESTRATOR_STATUS,
} from "../../src/core/orchestrator.js";

describe("computeHealthDivergence", () => {
  it("operational + good → none divergence, healthy pipeline status, no warning", () => {
    const result = computeHealthDivergence(ORCHESTRATOR_STATUS.OPERATIONAL, "good");
    assert.equal(result.divergenceState, HEALTH_DIVERGENCE_STATE.NONE);
    assert.equal(result.pipelineStatus, PIPELINE_HEALTH_STATUS.HEALTHY);
    assert.equal(result.isWarning, false);
  });

  it("operational + needs-work → planner_warning, warning pipeline status", () => {
    const result = computeHealthDivergence(ORCHESTRATOR_STATUS.OPERATIONAL, "needs-work");
    assert.equal(result.divergenceState, HEALTH_DIVERGENCE_STATE.PLANNER_WARNING);
    assert.equal(result.pipelineStatus, PIPELINE_HEALTH_STATUS.WARNING);
    assert.equal(result.isWarning, true);
  });

  it("operational + critical → planner_critical, critical pipeline status", () => {
    const result = computeHealthDivergence(ORCHESTRATOR_STATUS.OPERATIONAL, "critical");
    assert.equal(result.divergenceState, HEALTH_DIVERGENCE_STATE.PLANNER_CRITICAL);
    assert.equal(result.pipelineStatus, PIPELINE_HEALTH_STATUS.CRITICAL);
    assert.equal(result.isWarning, true);
  });

  it("degraded + good → operational_degraded_planner_ok, warning pipeline status", () => {
    const result = computeHealthDivergence(ORCHESTRATOR_STATUS.DEGRADED, "good");
    assert.equal(result.divergenceState, HEALTH_DIVERGENCE_STATE.OPERATIONAL_DEGRADED_PLANNER_OK);
    assert.equal(result.pipelineStatus, PIPELINE_HEALTH_STATUS.WARNING);
    assert.equal(result.isWarning, true);
  });

  it("degraded + needs-work → both_degraded, critical pipeline status", () => {
    const result = computeHealthDivergence(ORCHESTRATOR_STATUS.DEGRADED, "needs-work");
    assert.equal(result.divergenceState, HEALTH_DIVERGENCE_STATE.BOTH_DEGRADED);
    assert.equal(result.pipelineStatus, PIPELINE_HEALTH_STATUS.CRITICAL);
    assert.equal(result.isWarning, true);
  });

  it("degraded + critical → both_degraded, critical pipeline status (negative path)", () => {
    const result = computeHealthDivergence(ORCHESTRATOR_STATUS.DEGRADED, "critical");
    assert.equal(result.divergenceState, HEALTH_DIVERGENCE_STATE.BOTH_DEGRADED);
    assert.equal(result.pipelineStatus, PIPELINE_HEALTH_STATUS.CRITICAL);
    assert.equal(result.isWarning, true);
  });

  it("unknown operationalStatus → unknown divergenceState, no warning", () => {
    const result = computeHealthDivergence("unknown-state", "good");
    assert.equal(result.divergenceState, HEALTH_DIVERGENCE_STATE.UNKNOWN);
    assert.equal(result.pipelineStatus, PIPELINE_HEALTH_STATUS.UNKNOWN);
    assert.equal(result.isWarning, false);
  });

  it("unknown plannerHealth → unknown divergenceState", () => {
    const result = computeHealthDivergence(ORCHESTRATOR_STATUS.OPERATIONAL, "unknown-health");
    assert.equal(result.divergenceState, HEALTH_DIVERGENCE_STATE.UNKNOWN);
    assert.equal(result.pipelineStatus, PIPELINE_HEALTH_STATUS.UNKNOWN);
    assert.equal(result.isWarning, false);
  });

  it("null inputs produce unknown without throwing", () => {
    const result = computeHealthDivergence(null, null);
    assert.equal(result.divergenceState, HEALTH_DIVERGENCE_STATE.UNKNOWN);
    assert.equal(result.pipelineStatus, PIPELINE_HEALTH_STATUS.UNKNOWN);
  });

  it("undefined inputs produce unknown without throwing", () => {
    const result = computeHealthDivergence(undefined, undefined);
    assert.equal(result.divergenceState, HEALTH_DIVERGENCE_STATE.UNKNOWN);
    assert.equal(result.pipelineStatus, PIPELINE_HEALTH_STATUS.UNKNOWN);
  });

  it("result always contains operationalStatus and plannerHealth as strings", () => {
    const result = computeHealthDivergence(ORCHESTRATOR_STATUS.OPERATIONAL, "good");
    assert.ok(typeof result.operationalStatus === "string");
    assert.ok(typeof result.plannerHealth === "string");
  });

  it("all HEALTH_DIVERGENCE_STATE values are non-empty strings", () => {
    for (const [key, val] of Object.entries(HEALTH_DIVERGENCE_STATE)) {
      assert.ok(typeof val === "string" && val.length > 0, `${key} must be a non-empty string`);
    }
  });

  it("all PIPELINE_HEALTH_STATUS values are non-empty strings", () => {
    for (const [key, val] of Object.entries(PIPELINE_HEALTH_STATUS)) {
      assert.ok(typeof val === "string" && val.length > 0, `${key} must be a non-empty string`);
    }
  });

  it("isWarning is false only for none and unknown divergence states", () => {
    const safeStates = [
      computeHealthDivergence(ORCHESTRATOR_STATUS.OPERATIONAL, "good"),
      computeHealthDivergence(null, null),
      computeHealthDivergence(undefined, "good"),
    ];
    for (const s of safeStates) {
      assert.equal(s.isWarning, false, `expected isWarning=false for divergenceState=${s.divergenceState}`);
    }
  });

  it("isWarning is true for all warning/critical divergence states", () => {
    const warnStates = [
      computeHealthDivergence(ORCHESTRATOR_STATUS.OPERATIONAL, "needs-work"),
      computeHealthDivergence(ORCHESTRATOR_STATUS.OPERATIONAL, "critical"),
      computeHealthDivergence(ORCHESTRATOR_STATUS.DEGRADED, "good"),
      computeHealthDivergence(ORCHESTRATOR_STATUS.DEGRADED, "needs-work"),
      computeHealthDivergence(ORCHESTRATOR_STATUS.DEGRADED, "critical"),
    ];
    for (const s of warnStates) {
      assert.equal(s.isWarning, true, `expected isWarning=true for divergenceState=${s.divergenceState}`);
    }
  });
});

// ── Planner health alias normalization (Task 1) ───────────────────────────────

describe("computeHealthDivergence — planner health alias normalization", () => {
  it("alias 'healthy' resolves to 'good' — produces none divergence, no warning", () => {
    const result = computeHealthDivergence(ORCHESTRATOR_STATUS.OPERATIONAL, "healthy");
    assert.equal(result.divergenceState, HEALTH_DIVERGENCE_STATE.NONE,
      "alias 'healthy' must resolve to 'good' and produce none divergence");
    assert.equal(result.pipelineStatus, PIPELINE_HEALTH_STATUS.HEALTHY);
    assert.equal(result.isWarning, false);
  });

  it("alias 'warning' resolves to 'needs-work' — produces planner_warning", () => {
    const result = computeHealthDivergence(ORCHESTRATOR_STATUS.OPERATIONAL, "warning");
    assert.equal(result.divergenceState, HEALTH_DIVERGENCE_STATE.PLANNER_WARNING,
      "alias 'warning' must resolve to 'needs-work' and produce planner_warning divergence");
    assert.equal(result.pipelineStatus, PIPELINE_HEALTH_STATUS.WARNING);
    assert.equal(result.isWarning, true);
  });

  it("alias 'HEALTHY' (uppercase) resolves to 'good'", () => {
    const result = computeHealthDivergence(ORCHESTRATOR_STATUS.OPERATIONAL, "HEALTHY");
    assert.equal(result.divergenceState, HEALTH_DIVERGENCE_STATE.NONE);
    assert.equal(result.pipelineStatus, PIPELINE_HEALTH_STATUS.HEALTHY);
  });

  it("alias 'WARNING' (uppercase) resolves to 'needs-work'", () => {
    const result = computeHealthDivergence(ORCHESTRATOR_STATUS.OPERATIONAL, "WARNING");
    assert.equal(result.divergenceState, HEALTH_DIVERGENCE_STATE.PLANNER_WARNING);
    assert.equal(result.pipelineStatus, PIPELINE_HEALTH_STATUS.WARNING);
  });

  it("alias 'healthy' + degraded operational → operational_degraded_planner_ok", () => {
    // Alias resolves to 'good' — degraded + good = operational_degraded_planner_ok
    const result = computeHealthDivergence(ORCHESTRATOR_STATUS.DEGRADED, "healthy");
    assert.equal(result.divergenceState, HEALTH_DIVERGENCE_STATE.OPERATIONAL_DEGRADED_PLANNER_OK);
    assert.equal(result.pipelineStatus, PIPELINE_HEALTH_STATUS.WARNING);
    assert.equal(result.isWarning, true);
  });

  it("alias 'warning' + degraded operational → both_degraded (negative path)", () => {
    // Alias resolves to 'needs-work' — degraded + needs-work = both_degraded
    const result = computeHealthDivergence(ORCHESTRATOR_STATUS.DEGRADED, "warning");
    assert.equal(result.divergenceState, HEALTH_DIVERGENCE_STATE.BOTH_DEGRADED);
    assert.equal(result.pipelineStatus, PIPELINE_HEALTH_STATUS.CRITICAL);
    assert.equal(result.isWarning, true);
  });

  it("unrecognized alias still produces unknown divergence (negative path)", () => {
    const result = computeHealthDivergence(ORCHESTRATOR_STATUS.OPERATIONAL, "ok");
    assert.equal(result.divergenceState, HEALTH_DIVERGENCE_STATE.UNKNOWN);
    assert.equal(result.pipelineStatus, PIPELINE_HEALTH_STATUS.UNKNOWN);
    assert.equal(result.isWarning, false);
  });

  it("historical planner truth forces unknown divergence to prevent stale diagnostics from appearing live", () => {
    const result = computeHealthDivergence(ORCHESTRATOR_STATUS.OPERATIONAL, "critical", "historical");
    assert.equal(result.divergenceState, HEALTH_DIVERGENCE_STATE.UNKNOWN);
    assert.equal(result.pipelineStatus, PIPELINE_HEALTH_STATUS.UNKNOWN);
    assert.equal(result.isWarning, false);
    assert.equal(result.plannerTruthStatus, "historical");
  });

  it("unknown planner truth status also resolves to unknown divergence (negative path)", () => {
    const result = computeHealthDivergence(ORCHESTRATOR_STATUS.OPERATIONAL, "critical", "stale-ish");
    assert.equal(result.divergenceState, HEALTH_DIVERGENCE_STATE.UNKNOWN);
    assert.equal(result.pipelineStatus, PIPELINE_HEALTH_STATUS.UNKNOWN);
    assert.equal(result.plannerTruthStatus, "unknown");
  });
});
