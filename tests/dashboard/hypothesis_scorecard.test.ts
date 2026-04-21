/**
 * Tests for src/core/hypothesis_scorecard.js — T-029
 *
 * Covers:
 *   - Schema exports: HYPOTHESIS_STATUS, HYPOTHESIS_PHASE, HYPOTHESIS_RISK,
 *     SCORECARD_DEGRADED_REASON, SCORECARD_SAFE_FIELDS
 *   - derivePhase: all status → phase mappings (AC1/AC12)
 *   - deriveRisk: valid/invalid scopeTier mappings (AC4/AC15)
 *   - deriveSuccessProbability: deterministic probability per status (AC1/AC12)
 *   - deriveMetricId: deterministic metric identifier from disproveCriteria (AC2/AC13)
 *   - buildRollbackEvents: rollback event contract fields (AC3/AC14)
 *   - buildDisproveEvents: disprove event contract with metric_id link (AC2/AC13)
 *   - validateScorecardFilter: MISSING_FIELD vs INVALID_VALUE distinction (AC9/AC15)
 *   - sanitizeHypothesis: allowlist enforcement (AC5/AC18)
 *   - buildHypothesisScorecard: filtering, summary, degraded state (AC4/AC10)
 *   - collectHypothesisScorecard: degraded when registry absent (AC10)
 *   - Negative paths: invalid inputs, filter errors, degraded state (AC7)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  HYPOTHESIS_STATUS,
  HYPOTHESIS_PHASE,
  HYPOTHESIS_RISK,
  SCORECARD_DEGRADED_REASON,
  SCORECARD_SAFE_FIELDS,
  derivePhase,
  deriveRisk,
  deriveSuccessProbability,
  deriveMetricId,
  buildRollbackEvents,
  buildDisproveEvents,
  validateScorecardFilter,
  sanitizeHypothesis,
  buildHypothesisScorecard,
  collectHypothesisScorecard,
} from "../../src/core/hypothesis_scorecard.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeExperiment(overrides = {}) {
  return {
    experimentId:      "exp-abc123",
    hypothesisId:      "hyp-001",
    interventionId:    "int-001",
    treatmentGroup:    "group-a",
    status:            "planned",
    statusReason:      null,
    disproveCriteria:  "error rate rises above 5% within 24 hours",
    rollbackPlan:      "revert config key to previous value",
    interventionScope: ["runtime.maxParallelWorkers"],
    createdAt:         "2024-01-01T00:00:00.000Z",
    startedAt:         null,
    completedAt:       null,
    rolledBackAt:      null,
    baselineWindow:    { startAt: "2024-01-01T00:00:00.000Z", endAt: null, durationHours: 24 },
    stopConditions:    [{ type: "max_duration_hours", value: 48 }],
    scopeTier:         "medium",
    impactScore:       0.65,
    ...overrides
  };
}

function makeRegistry(experiments = []) {
  return { schemaVersion: 1, experiments };
}

// ── Schema exports ────────────────────────────────────────────────────────────

describe("HYPOTHESIS_STATUS", () => {
  it("contains all four valid status values", () => {
    assert.ok(HYPOTHESIS_STATUS.has("planned"));
    assert.ok(HYPOTHESIS_STATUS.has("running"));
    assert.ok(HYPOTHESIS_STATUS.has("completed"));
    assert.ok(HYPOTHESIS_STATUS.has("rolled_back"));
  });
  it("is frozen", () => assert.ok(Object.isFrozen(HYPOTHESIS_STATUS)));
});

describe("HYPOTHESIS_PHASE", () => {
  it("contains all four valid phase values", () => {
    assert.ok(HYPOTHESIS_PHASE.has("baseline"));
    assert.ok(HYPOTHESIS_PHASE.has("treatment"));
    assert.ok(HYPOTHESIS_PHASE.has("evaluation"));
    assert.ok(HYPOTHESIS_PHASE.has("closed"));
  });
  it("is frozen", () => assert.ok(Object.isFrozen(HYPOTHESIS_PHASE)));
});

describe("HYPOTHESIS_RISK", () => {
  it("contains all five valid risk values", () => {
    assert.ok(HYPOTHESIS_RISK.has("critical"));
    assert.ok(HYPOTHESIS_RISK.has("high"));
    assert.ok(HYPOTHESIS_RISK.has("medium"));
    assert.ok(HYPOTHESIS_RISK.has("low"));
    assert.ok(HYPOTHESIS_RISK.has("unknown"));
  });
  it("is frozen", () => assert.ok(Object.isFrozen(HYPOTHESIS_RISK)));
});

describe("SCORECARD_DEGRADED_REASON", () => {
  it("contains REGISTRY_ABSENT and REGISTRY_INVALID", () => {
    assert.equal(typeof SCORECARD_DEGRADED_REASON.REGISTRY_ABSENT, "string");
    assert.equal(typeof SCORECARD_DEGRADED_REASON.REGISTRY_INVALID, "string");
  });
  it("is frozen", () => assert.ok(Object.isFrozen(SCORECARD_DEGRADED_REASON)));
});

describe("SCORECARD_SAFE_FIELDS", () => {
  it("includes required output fields", () => {
    assert.ok(SCORECARD_SAFE_FIELDS.has("experimentId"));
    assert.ok(SCORECARD_SAFE_FIELDS.has("hypothesisId"));
    assert.ok(SCORECARD_SAFE_FIELDS.has("status"));
    assert.ok(SCORECARD_SAFE_FIELDS.has("disproveCriteria"));
    assert.ok(SCORECARD_SAFE_FIELDS.has("rollbackPlan"));
    assert.ok(SCORECARD_SAFE_FIELDS.has("phase"));
    assert.ok(SCORECARD_SAFE_FIELDS.has("risk"));
    assert.ok(SCORECARD_SAFE_FIELDS.has("successProbability"));
  });
  it("is frozen", () => assert.ok(Object.isFrozen(SCORECARD_SAFE_FIELDS)));
});

// ── derivePhase ───────────────────────────────────────────────────────────────

describe("derivePhase", () => {
  it("maps planned → baseline", () => assert.equal(derivePhase("planned"), "baseline"));
  it("maps running → treatment", () => assert.equal(derivePhase("running"), "treatment"));
  it("maps completed → evaluation", () => assert.equal(derivePhase("completed"), "evaluation"));
  it("maps rolled_back → closed", () => assert.equal(derivePhase("rolled_back"), "closed"));
  it("maps unknown status → baseline (safe default)", () => assert.equal(derivePhase("bogus"), "baseline"));
  it("maps empty string → baseline", () => assert.equal(derivePhase(""), "baseline"));
});

// ── deriveRisk ────────────────────────────────────────────────────────────────

describe("deriveRisk", () => {
  it("maps critical scopeTier → critical", () => assert.equal(deriveRisk({ scopeTier: "critical" }), "critical"));
  it("maps high scopeTier → high",     () => assert.equal(deriveRisk({ scopeTier: "high" }), "high"));
  it("maps medium scopeTier → medium", () => assert.equal(deriveRisk({ scopeTier: "medium" }), "medium"));
  it("maps low scopeTier → low",       () => assert.equal(deriveRisk({ scopeTier: "low" }), "low"));
  it("maps missing scopeTier → unknown", () => assert.equal(deriveRisk({}), "unknown"));
  it("maps null experiment → unknown",   () => assert.equal(deriveRisk(null), "unknown"));
  // Negative path: invalid scopeTier value
  it("maps invalid scopeTier value → unknown", () => assert.equal(deriveRisk({ scopeTier: "super-critical" }), "unknown"));
});

// ── deriveSuccessProbability ──────────────────────────────────────────────────

describe("deriveSuccessProbability", () => {
  it("returns 1.0 for completed",    () => assert.equal(deriveSuccessProbability({ status: "completed" }), 1.0));
  it("returns 0.0 for rolled_back",  () => assert.equal(deriveSuccessProbability({ status: "rolled_back" }), 0.0));
  it("returns impactScore for running when impactScore is set", () => {
    assert.equal(deriveSuccessProbability({ status: "running", impactScore: 0.75 }), 0.75);
  });
  it("returns impactScore for planned when impactScore is set", () => {
    assert.equal(deriveSuccessProbability({ status: "planned", impactScore: 0.5 }), 0.5);
  });
  it("returns null for running without impactScore", () => {
    assert.equal(deriveSuccessProbability({ status: "running" }), null);
  });
  it("returns null for planned without impactScore", () => {
    assert.equal(deriveSuccessProbability({ status: "planned" }), null);
  });
  // Negative path: out-of-range impactScore is treated as null
  it("returns null when impactScore is out of [0,1] range", () => {
    assert.equal(deriveSuccessProbability({ status: "running", impactScore: 1.5 }), null);
    assert.equal(deriveSuccessProbability({ status: "running", impactScore: -0.1 }), null);
  });
});

// ── deriveMetricId ────────────────────────────────────────────────────────────

describe("deriveMetricId", () => {
  it("returns a metric- prefixed string", () => {
    const id = deriveMetricId("error rate rises above 5%");
    assert.ok(id.startsWith("metric-"));
  });
  it("is deterministic for identical inputs", () => {
    const a = deriveMetricId("error rate rises above 5%");
    const b = deriveMetricId("error rate rises above 5%");
    assert.equal(a, b);
  });
  it("produces different IDs for different inputs", () => {
    const a = deriveMetricId("error rate rises above 5%");
    const b = deriveMetricId("p99 latency exceeds 200ms");
    assert.notEqual(a, b);
  });
  // Negative path: null/empty input falls back gracefully
  it("returns metric-undefined for null input", () => assert.equal(deriveMetricId(null), "metric-undefined"));
  it("returns metric-undefined for empty string", () => assert.equal(deriveMetricId(""), "metric-undefined"));
});

// ── buildRollbackEvents ───────────────────────────────────────────────────────

describe("buildRollbackEvents", () => {
  it("returns an empty array when no experiments are rolled_back", () => {
    const result = buildRollbackEvents([makeExperiment({ status: "running" })]);
    assert.deepEqual(result, []);
  });

  it("emits a rollback event for rolled_back experiments", () => {
    const exp = makeExperiment({
      status: "rolled_back",
      rolledBackAt: "2024-03-01T12:00:00.000Z",
      statusReason: "disproveCriteria-met"
    });
    const events = buildRollbackEvents([exp]);
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.hypothesis_id, exp.hypothesisId);
    assert.equal(e.experiment_id, exp.experimentId);
    assert.equal(e.action, "rolled_back");
    assert.equal(e.timestamp, "2024-03-01T12:00:00.000Z");
    assert.equal(e.reason, "disproveCriteria-met");
  });

  it("includes all required contract fields (AC3/AC14)", () => {
    const exp = makeExperiment({ status: "rolled_back", rolledBackAt: "2024-01-01T00:00:00.000Z" });
    const [event] = buildRollbackEvents([exp]);
    assert.ok("hypothesis_id" in event);
    assert.ok("experiment_id" in event);
    assert.ok("action" in event);
    assert.ok("timestamp" in event);
    assert.ok("reason" in event);
  });

  // Negative path: non-array input returns empty array
  it("returns empty array for non-array input", () => {
    assert.deepEqual(buildRollbackEvents(null), []);
    assert.deepEqual(buildRollbackEvents("bad"), []);
  });
});

// ── buildDisproveEvents ───────────────────────────────────────────────────────

describe("buildDisproveEvents", () => {
  it("returns empty array when no experiments are rolled_back", () => {
    const result = buildDisproveEvents([makeExperiment({ status: "completed" })]);
    assert.deepEqual(result, []);
  });

  it("emits a disprove event with metric_id linked to disproveCriteria (AC2)", () => {
    const exp = makeExperiment({
      status: "rolled_back",
      rolledBackAt: "2024-03-01T12:00:00.000Z",
      disproveCriteria: "error rate rises above 5% within 24 hours"
    });
    const events = buildDisproveEvents([exp]);
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.hypothesis_id, exp.hypothesisId);
    assert.equal(e.experiment_id, exp.experimentId);
    assert.ok(typeof e.metric_id === "string" && e.metric_id.startsWith("metric-"));
    assert.equal(e.event_type, "disproved");
    assert.equal(e.timestamp, "2024-03-01T12:00:00.000Z");
    assert.equal(e.evidence, exp.disproveCriteria);
  });

  it("metric_id matches deriveMetricId output (join key deterministic)", () => {
    const exp = makeExperiment({ status: "rolled_back", disproveCriteria: "latency p99 > 200ms" });
    const [event] = buildDisproveEvents([exp]);
    assert.equal(event.metric_id, deriveMetricId(exp.disproveCriteria));
  });

  // Negative path: null input
  it("returns empty array for null input", () => {
    assert.deepEqual(buildDisproveEvents(null), []);
  });
});

// ── validateScorecardFilter ───────────────────────────────────────────────────

describe("validateScorecardFilter", () => {
  it("accepts an empty filter object", () => {
    const result = validateScorecardFilter({});
    assert.ok(result.ok);
    assert.equal(result.errors.length, 0);
  });

  it("accepts null values for phase and risk (means no filter)", () => {
    const result = validateScorecardFilter({ phase: null, risk: null });
    assert.ok(result.ok);
  });

  it("accepts valid phase value", () => {
    const result = validateScorecardFilter({ phase: "treatment" });
    assert.ok(result.ok);
  });

  it("accepts valid risk value", () => {
    const result = validateScorecardFilter({ risk: "high" });
    assert.ok(result.ok);
  });

  it("accepts both valid phase and risk", () => {
    const result = validateScorecardFilter({ phase: "evaluation", risk: "critical" });
    assert.ok(result.ok);
  });

  // Negative path: MISSING_FIELD — null/undefined root
  it("returns MISSING_FIELD when filters is null (AC9)", () => {
    const result = validateScorecardFilter(null);
    assert.ok(!result.ok);
    assert.ok(result.errors.some(e => e.code === "MISSING_FIELD"));
  });

  it("returns MISSING_FIELD when filters is undefined (AC9)", () => {
    const result = validateScorecardFilter(undefined);
    assert.ok(!result.ok);
    assert.ok(result.errors.some(e => e.code === "MISSING_FIELD"));
  });

  // Negative path: INVALID_VALUE — bad type for root
  it("returns INVALID_VALUE when filters is an array (AC9)", () => {
    const result = validateScorecardFilter([]);
    assert.ok(!result.ok);
    assert.ok(result.errors.some(e => e.code === "INVALID_VALUE"));
  });

  // Negative path: INVALID_VALUE — invalid phase enum member
  it("returns INVALID_VALUE for unrecognised phase value (AC9/AC15)", () => {
    const result = validateScorecardFilter({ phase: "not-a-phase" });
    assert.ok(!result.ok);
    assert.ok(result.errors.some(e => e.field === "phase" && e.code === "INVALID_VALUE"));
  });

  // Negative path: INVALID_VALUE — invalid risk enum member
  it("returns INVALID_VALUE for unrecognised risk value (AC9/AC15)", () => {
    const result = validateScorecardFilter({ risk: "super-critical" });
    assert.ok(!result.ok);
    assert.ok(result.errors.some(e => e.field === "risk" && e.code === "INVALID_VALUE"));
  });

  // Distinguishes missing from invalid: numeric phase is INVALID_VALUE not MISSING_FIELD
  it("distinguishes INVALID_VALUE (numeric phase) from MISSING_FIELD", () => {
    const result = validateScorecardFilter({ phase: 42 });
    assert.ok(!result.ok);
    const err = result.errors.find(e => e.field === "phase");
    assert.ok(err);
    assert.equal(err.code, "INVALID_VALUE");
    assert.notEqual(err.code, "MISSING_FIELD");
  });
});

// ── sanitizeHypothesis ────────────────────────────────────────────────────────

describe("sanitizeHypothesis", () => {
  it("returns only allowed fields (allowlist enforcement AC5/AC18)", () => {
    const internal = { ...makeExperiment(), internalAiPrompt: "secret", rawConfig: { token: "abc" } };
    const result = sanitizeHypothesis(internal);
    assert.ok(!("internalAiPrompt" in result));
    assert.ok(!("rawConfig" in result));
  });

  it("always includes derived fields: phase, risk, successProbability", () => {
    const result = sanitizeHypothesis(makeExperiment({ status: "running", scopeTier: "high", impactScore: 0.8 }));
    assert.equal(result.phase, "treatment");
    assert.equal(result.risk, "high");
    assert.equal(result.successProbability, 0.8);
  });

  it("retains core fields in output", () => {
    const exp = makeExperiment();
    const result = sanitizeHypothesis(exp);
    assert.equal(result.experimentId,   exp.experimentId);
    assert.equal(result.hypothesisId,   exp.hypothesisId);
    assert.equal(result.status,         exp.status);
    assert.equal(result.disproveCriteria, exp.disproveCriteria);
    assert.equal(result.rollbackPlan,   exp.rollbackPlan);
  });

  // Negative path: non-object input returns empty object
  it("returns empty object for null input", () => {
    assert.deepEqual(sanitizeHypothesis(null), {});
  });

  it("returns empty object for array input", () => {
    assert.deepEqual(sanitizeHypothesis([]), {});
  });
});

// ── buildHypothesisScorecard ──────────────────────────────────────────────────

describe("buildHypothesisScorecard", () => {
  it("returns ok:true for valid registry", () => {
    const result = buildHypothesisScorecard(makeRegistry([makeExperiment()]));
    assert.ok(result.ok);
    assert.equal(result.degraded, false);
    assert.equal(result.degradedReason, null);
  });

  it("returns all hypotheses when no filter is applied", () => {
    const registry = makeRegistry([
      makeExperiment({ status: "planned" }),
      makeExperiment({ experimentId: "exp-2", hypothesisId: "hyp-2", status: "running" })
    ]);
    const result = buildHypothesisScorecard(registry);
    assert.equal(result.hypotheses.length, 2);
  });

  it("filters by phase (AC4/AC15)", () => {
    const registry = makeRegistry([
      makeExperiment({ status: "planned" }),
      makeExperiment({ experimentId: "exp-2", hypothesisId: "hyp-2", status: "running" }),
      makeExperiment({ experimentId: "exp-3", hypothesisId: "hyp-3", status: "completed" })
    ]);
    const result = buildHypothesisScorecard(registry, { phase: "treatment" });
    assert.ok(result.ok);
    assert.equal(result.hypotheses.length, 1);
    assert.equal(result.hypotheses[0].phase, "treatment");
  });

  it("filters by risk (AC4/AC15)", () => {
    const registry = makeRegistry([
      makeExperiment({ scopeTier: "critical" }),
      makeExperiment({ experimentId: "exp-2", hypothesisId: "hyp-2", scopeTier: "low" })
    ]);
    const result = buildHypothesisScorecard(registry, { risk: "critical" });
    assert.ok(result.ok);
    assert.equal(result.hypotheses.length, 1);
    assert.equal(result.hypotheses[0].risk, "critical");
  });

  it("can combine phase and risk filters", () => {
    const registry = makeRegistry([
      makeExperiment({ status: "running", scopeTier: "high" }),
      makeExperiment({ experimentId: "exp-2", hypothesisId: "hyp-2", status: "running", scopeTier: "low" }),
      makeExperiment({ experimentId: "exp-3", hypothesisId: "hyp-3", status: "completed", scopeTier: "high" })
    ]);
    const result = buildHypothesisScorecard(registry, { phase: "treatment", risk: "high" });
    assert.ok(result.ok);
    assert.equal(result.hypotheses.length, 1);
    assert.equal(result.hypotheses[0].phase, "treatment");
    assert.equal(result.hypotheses[0].risk, "high");
  });

  it("includes summary statistics (total, byStatus, byPhase, byRisk)", () => {
    const registry = makeRegistry([
      makeExperiment({ status: "running" }),
      makeExperiment({ experimentId: "exp-2", hypothesisId: "hyp-2", status: "completed" }),
      makeExperiment({ experimentId: "exp-3", hypothesisId: "hyp-3", status: "rolled_back" })
    ]);
    const result = buildHypothesisScorecard(registry);
    assert.equal(result.summary.total, 3);
    assert.equal(typeof result.summary.byStatus.running,     "number");
    assert.equal(typeof result.summary.byPhase.treatment,    "number");
    assert.equal(typeof result.summary.byRisk,               "object");
  });

  it("includes rollback and disprove events", () => {
    const registry = makeRegistry([
      makeExperiment({ status: "rolled_back", rolledBackAt: "2024-01-10T00:00:00.000Z" })
    ]);
    const result = buildHypothesisScorecard(registry);
    assert.equal(result.rollbackEvents.length, 1);
    assert.equal(result.disproveEvents.length, 1);
  });

  it("sets generatedAt as an ISO timestamp", () => {
    const result = buildHypothesisScorecard(makeRegistry([]));
    assert.ok(typeof result.generatedAt === "string");
    assert.ok(Number.isFinite(Date.parse(result.generatedAt)));
  });

  // Negative path: invalid registry → degraded state (AC10)
  it("returns degraded:true and degradedReason for null registry (AC10)", () => {
    const result = buildHypothesisScorecard(null);
    assert.ok(!result.ok);
    assert.equal(result.degraded, true);
    assert.equal(result.degradedReason, SCORECARD_DEGRADED_REASON.REGISTRY_INVALID);
    assert.deepEqual(result.hypotheses, []);
  });

  // Negative path: invalid filter triggers ok:false with filterErrors
  it("returns ok:false with filterErrors for invalid phase filter (AC9)", () => {
    const result = buildHypothesisScorecard(makeRegistry([]), { phase: "bad-phase" });
    assert.ok(!result.ok);
    assert.ok(Array.isArray(result.filterErrors) && result.filterErrors.length > 0);
    assert.ok(result.filterErrors[0].code === "INVALID_VALUE");
  });

  // Negative path: no silent fallback — degraded state must set degradedReason (AC10)
  it("degradedReason is non-null whenever degraded is true (AC10)", () => {
    const result = buildHypothesisScorecard(null);
    assert.equal(result.degraded, true);
    // Either degradedReason is set OR filterErrors is set — never both null
    const hasMachineReadableReason = result.degradedReason !== null || Array.isArray(result.filterErrors);
    assert.ok(hasMachineReadableReason, "degraded result must have machine-readable reason");
  });

  // Filter returns empty array (not error) when no hypotheses match
  it("returns empty hypotheses array (not error) when no hypotheses match the filter", () => {
    const registry = makeRegistry([makeExperiment({ status: "planned" })]);
    const result = buildHypothesisScorecard(registry, { phase: "closed" });
    assert.ok(result.ok);
    assert.equal(result.hypotheses.length, 0);
  });
});

// ── collectHypothesisScorecard ────────────────────────────────────────────────

describe("collectHypothesisScorecard — degraded when registry absent", () => {
  it("returns degraded:true and REGISTRY_ABSENT when stateDir does not exist (AC10)", async () => {
    const result = await collectHypothesisScorecard("/nonexistent/path/that/should/not/exist");
    assert.equal(result.degraded, true);
    assert.equal(result.degradedReason, SCORECARD_DEGRADED_REASON.REGISTRY_ABSENT);
    assert.ok(!result.ok);
    assert.deepEqual(result.hypotheses, []);
    assert.deepEqual(result.rollbackEvents, []);
    assert.deepEqual(result.disproveEvents, []);
  });

  it("degraded state sets explicit machine-readable degradedReason — no silent fallback (AC10)", async () => {
    const result = await collectHypothesisScorecard("/nonexistent/path");
    assert.ok(typeof result.degradedReason === "string" && result.degradedReason.length > 0,
      "degradedReason must be a non-empty string when degraded");
  });
});
