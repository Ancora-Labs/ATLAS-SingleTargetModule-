/**
 * intervention_optimizer.test.ts
 *
 * Tests for the budget-aware intervention optimizer.
 *
 * Coverage:
 *   - validateIntervention: missing vs invalid input distinction
 *   - validateBudget: missing vs invalid input distinction
 *   - applyConfidencePenalty / computeConfidenceMultiplier: sparse-data formula
 *   - computeExpectedValue: EV formula determinism
 *   - rankInterventions: descending EV ordering
 *   - reconcileBudgets: all three constraint types (total, wave, role)
 *   - runInterventionOptimizer: end-to-end, happy path and all negative paths
 *   - buildInterventionsFromPlan: prometheus plan adapter
 *   - buildBudgetFromConfig: config adapter
 *   - persistOptimizerLog: schema and trim behavior (file I/O skipped in unit tests)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  INTERVENTION_TYPE,
  OPTIMIZER_STATUS,
  OPTIMIZER_REASON_CODE,
  INTERVENTION_REJECTION_CODE,
  INTERVENTION_ERROR_CODE,
  SPARSE_DATA_THRESHOLD,
  OPTIMIZER_LOG_SCHEMA_VERSION,
  OPTIMIZER_LOG_JSONL_SCHEMA,
  OPTIMIZER_LOG_FRESHNESS_MS,
  OPTIMIZER_LOG_RECORD_TYPE,
  BUDGET_UNIT,
  INTERVENTION_SCHEMA,
  validateIntervention,
  validateBudget,
  computeConfidenceMultiplier,
  applyConfidencePenalty,
  computeExpectedValue,
  rankInterventions,
  reconcileBudgets,
  runInterventionOptimizer,
  buildInterventionsFromPlan,
  buildPolicyImpactByInterventionId,
  scoreInterventionsAgainstRubric,
  buildInterventionImpactAttributionRecords,
  buildBudgetFromConfig,
  persistOptimizerLog,
  checkOverbundleHardAdmission,
  OVERBUNDLE_STEPS_THRESHOLD,
  INTERVENTION_ACCOUNTING_CATEGORY,
} from "../../src/core/intervention_optimizer.js";
import { assignWorkersToPlans } from "../../src/core/capability_pool.js";
import { buildDeterministicRequestBudget } from "../../src/core/prometheus.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeIntervention(overrides = {}) {
  return {
    id:                 "i-001",
    type:               INTERVENTION_TYPE.TASK,
    wave:               1,
    role:               "backend",
    title:              "Fix auth bug",
    successProbability: 0.8,
    impact:             0.9,
    riskCost:           0.2,
    sampleCount:        3,
    budgetCost:         1,
    ...overrides,
  };
}

function makeBudget(overrides = {}) {
  return {
    maxWorkerSpawns: 10,
    ...overrides,
  };
}

// ── Enum and constant exports ─────────────────────────────────────────────────

describe("exported enums and constants", () => {
  it("INTERVENTION_TYPE contains task, split, followup", () => {
    assert.equal(INTERVENTION_TYPE.TASK, "task");
    assert.equal(INTERVENTION_TYPE.SPLIT, "split");
    assert.equal(INTERVENTION_TYPE.FOLLOWUP, "followup");
  });

  it("OPTIMIZER_STATUS contains all four statuses", () => {
    assert.ok(OPTIMIZER_STATUS.OK);
    assert.ok(OPTIMIZER_STATUS.BUDGET_EXCEEDED);
    assert.ok(OPTIMIZER_STATUS.INVALID_INPUT);
    assert.ok(OPTIMIZER_STATUS.EMPTY_INPUT);
  });

  it("SPARSE_DATA_THRESHOLD is 3", () => {
    assert.equal(SPARSE_DATA_THRESHOLD, 3);
  });

  it("BUDGET_UNIT is workerSpawns", () => {
    assert.equal(BUDGET_UNIT, "workerSpawns");
  });

  it("OPTIMIZER_LOG_SCHEMA_VERSION is a positive integer", () => {
    assert.ok(Number.isInteger(OPTIMIZER_LOG_SCHEMA_VERSION));
    assert.ok(OPTIMIZER_LOG_SCHEMA_VERSION >= 1);
  });

  it("INTERVENTION_SCHEMA.required includes all required fields", () => {
    const required = INTERVENTION_SCHEMA.required;
    for (const field of ["id", "type", "wave", "role", "title",
      "successProbability", "impact", "riskCost", "sampleCount", "budgetCost"]) {
      assert.ok(required.includes(field), `INTERVENTION_SCHEMA.required must include '${field}'`);
    }
  });
});

// ── validateIntervention ──────────────────────────────────────────────────────

describe("validateIntervention", () => {
  it("accepts a fully valid intervention", () => {
    const result = validateIntervention(makeIntervention());
    assert.equal(result.ok, true);
    assert.equal(result.code, null);
  });

  it("rejects null with MISSING_INPUT (not INVALID_FIELD)", () => {
    const result = validateIntervention(null);
    assert.equal(result.ok, false);
    assert.equal(result.code, INTERVENTION_ERROR_CODE.MISSING_INPUT);
  });

  it("rejects undefined with MISSING_INPUT", () => {
    const result = validateIntervention(undefined);
    assert.equal(result.ok, false);
    assert.equal(result.code, INTERVENTION_ERROR_CODE.MISSING_INPUT);
  });

  it("rejects a non-object (string) with INVALID_TYPE", () => {
    const result = validateIntervention("task");
    assert.equal(result.ok, false);
    assert.equal(result.code, INTERVENTION_ERROR_CODE.INVALID_TYPE);
  });

  it("rejects an array with INVALID_TYPE", () => {
    const result = validateIntervention([]);
    assert.equal(result.ok, false);
    assert.equal(result.code, INTERVENTION_ERROR_CODE.INVALID_TYPE);
  });

  it("rejects when required field is missing — reports MISSING_FIELD with field name", () => {
    for (const field of INTERVENTION_SCHEMA.required) {
      const inv = makeIntervention();
      delete inv[field];
      const result = validateIntervention(inv);
      assert.equal(result.ok, false, `Expected failure for missing field: ${field}`);
      assert.equal(result.code, INTERVENTION_ERROR_CODE.MISSING_FIELD, `Expected MISSING_FIELD for: ${field}`);
      assert.equal(result.field, field, `Expected field name: ${field}`);
    }
  });

  it("rejects invalid type enum value with INVALID_FIELD", () => {
    const result = validateIntervention(makeIntervention({ type: "unknown" }));
    assert.equal(result.ok, false);
    assert.equal(result.code, INTERVENTION_ERROR_CODE.INVALID_FIELD);
    assert.equal(result.field, "type");
  });

  it("rejects non-integer wave with INVALID_FIELD", () => {
    const result = validateIntervention(makeIntervention({ wave: 1.5 }));
    assert.equal(result.ok, false);
    assert.equal(result.code, INTERVENTION_ERROR_CODE.INVALID_FIELD);
    assert.equal(result.field, "wave");
  });

  it("rejects wave < 1 with INVALID_FIELD", () => {
    const result = validateIntervention(makeIntervention({ wave: 0 }));
    assert.equal(result.ok, false);
    assert.equal(result.field, "wave");
  });

  it("rejects empty id string with INVALID_FIELD", () => {
    const result = validateIntervention(makeIntervention({ id: "  " }));
    assert.equal(result.ok, false);
    assert.equal(result.field, "id");
  });

  it("rejects successProbability > 1 with INVALID_FIELD", () => {
    const result = validateIntervention(makeIntervention({ successProbability: 1.1 }));
    assert.equal(result.ok, false);
    assert.equal(result.field, "successProbability");
  });

  it("rejects negative impact with INVALID_FIELD", () => {
    const result = validateIntervention(makeIntervention({ impact: -0.1 }));
    assert.equal(result.ok, false);
    assert.equal(result.field, "impact");
  });

  it("rejects non-finite riskCost (NaN) with INVALID_FIELD", () => {
    const result = validateIntervention(makeIntervention({ riskCost: NaN }));
    assert.equal(result.ok, false);
    assert.equal(result.field, "riskCost");
  });

  it("rejects negative sampleCount with INVALID_FIELD", () => {
    const result = validateIntervention(makeIntervention({ sampleCount: -1 }));
    assert.equal(result.ok, false);
    assert.equal(result.field, "sampleCount");
  });

  it("rejects non-integer sampleCount (float) with INVALID_FIELD", () => {
    const result = validateIntervention(makeIntervention({ sampleCount: 2.5 }));
    assert.equal(result.ok, false);
    assert.equal(result.field, "sampleCount");
  });

  it("rejects budgetCost < 1 with INVALID_FIELD", () => {
    const result = validateIntervention(makeIntervention({ budgetCost: 0 }));
    assert.equal(result.ok, false);
    assert.equal(result.field, "budgetCost");
  });

  it("accepts sampleCount = 0 (no historical data is valid)", () => {
    const result = validateIntervention(makeIntervention({ sampleCount: 0 }));
    assert.equal(result.ok, true);
  });

  it("accepts all three INTERVENTION_TYPE values", () => {
    for (const type of Object.values(INTERVENTION_TYPE)) {
      const result = validateIntervention(makeIntervention({ type }));
      assert.equal(result.ok, true, `Expected valid for type: ${type}`);
    }
  });
});

// ── validateBudget ────────────────────────────────────────────────────────────

describe("validateBudget", () => {
  it("accepts a minimal valid budget", () => {
    const result = validateBudget({ maxWorkerSpawns: 10 });
    assert.equal(result.ok, true);
  });

  it("accepts a fully specified budget", () => {
    const result = validateBudget({
      maxWorkerSpawns: 10,
      maxWorkersPerWave: 4,
      byRole: { backend: 3, frontend: 2 },
    });
    assert.equal(result.ok, true);
  });

  it("rejects null with MISSING_INPUT (not INVALID_FIELD)", () => {
    const result = validateBudget(null);
    assert.equal(result.ok, false);
    assert.equal(result.code, INTERVENTION_ERROR_CODE.MISSING_INPUT);
  });

  it("rejects undefined with MISSING_INPUT", () => {
    const result = validateBudget(undefined);
    assert.equal(result.ok, false);
    assert.equal(result.code, INTERVENTION_ERROR_CODE.MISSING_INPUT);
  });

  it("rejects missing maxWorkerSpawns with MISSING_FIELD", () => {
    const result = validateBudget({});
    assert.equal(result.ok, false);
    assert.equal(result.code, INTERVENTION_ERROR_CODE.MISSING_FIELD);
    assert.equal(result.field, "maxWorkerSpawns");
  });

  it("rejects maxWorkerSpawns = 0 with INVALID_FIELD", () => {
    const result = validateBudget({ maxWorkerSpawns: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.field, "maxWorkerSpawns");
  });

  it("rejects fractional maxWorkersPerWave with INVALID_FIELD", () => {
    const result = validateBudget({ maxWorkerSpawns: 10, maxWorkersPerWave: 2.5 });
    assert.equal(result.ok, false);
    assert.equal(result.field, "maxWorkersPerWave");
  });

  it("rejects invalid byRole entry with INVALID_FIELD pointing to the bad role key", () => {
    const result = validateBudget({ maxWorkerSpawns: 10, byRole: { backend: 0 } });
    assert.equal(result.ok, false);
    assert.ok(result.field.includes("byRole.backend"));
  });
});

// ── applyConfidencePenalty / computeConfidenceMultiplier ─────────────────────

describe("confidence penalty formula", () => {
  it("computeConfidenceMultiplier(0) = 0.0 (no data → maximum penalty)", () => {
    assert.equal(computeConfidenceMultiplier(0), 0.0);
  });

  it("computeConfidenceMultiplier(1) = 1/SPARSE_DATA_THRESHOLD", () => {
    const expected = 1 / SPARSE_DATA_THRESHOLD;
    assert.ok(Math.abs(computeConfidenceMultiplier(1) - expected) < 1e-10);
  });

  it("computeConfidenceMultiplier(2) = 2/SPARSE_DATA_THRESHOLD", () => {
    const expected = 2 / SPARSE_DATA_THRESHOLD;
    assert.ok(Math.abs(computeConfidenceMultiplier(2) - expected) < 1e-10);
  });

  it("computeConfidenceMultiplier(SPARSE_DATA_THRESHOLD) = 1.0 (full confidence)", () => {
    assert.equal(computeConfidenceMultiplier(SPARSE_DATA_THRESHOLD), 1.0);
  });

  it("computeConfidenceMultiplier(100) = 1.0 (capped at 1.0)", () => {
    assert.equal(computeConfidenceMultiplier(100), 1.0);
  });

  it("applyConfidencePenalty with sampleCount=0 returns 0 regardless of successProbability", () => {
    assert.equal(applyConfidencePenalty(0.9, 0), 0.0);
    assert.equal(applyConfidencePenalty(1.0, 0), 0.0);
    assert.equal(applyConfidencePenalty(0.0, 0), 0.0);
  });

  it("applyConfidencePenalty with full confidence returns successProbability unchanged", () => {
    assert.equal(applyConfidencePenalty(0.8, SPARSE_DATA_THRESHOLD), 0.8);
    assert.equal(applyConfidencePenalty(0.5, 100), 0.5);
  });

  it("applyConfidencePenalty with sampleCount=1 gives 1/3 of successProbability", () => {
    const result = applyConfidencePenalty(0.9, 1);
    const expected = 0.9 * (1 / SPARSE_DATA_THRESHOLD);
    assert.ok(Math.abs(result - expected) < 1e-10);
  });
});

// ── computeExpectedValue ──────────────────────────────────────────────────────

describe("computeExpectedValue", () => {
  it("computes EV correctly with full confidence (sampleCount >= threshold)", () => {
    // adjustedP = 0.8 * 1.0 = 0.8
    // EV = 0.8 * 0.9 - 0.2 * 0.2 = 0.72 - 0.04 = 0.68
    const { adjustedSuccessProbability, ev } = computeExpectedValue(
      makeIntervention({ successProbability: 0.8, impact: 0.9, riskCost: 0.2, sampleCount: 3 }),
    );
    assert.ok(Math.abs(adjustedSuccessProbability - 0.8) < 1e-10);
    assert.ok(Math.abs(ev - 0.68) < 1e-10, `Expected EV ≈ 0.68, got ${ev}`);
  });

  it("computes EV correctly with sampleCount=0 (max confidence penalty)", () => {
    // adjustedP = 0.8 * 0 = 0
    // EV = 0 * 0.9 - 1 * 0.2 = -0.2
    const { adjustedSuccessProbability, ev } = computeExpectedValue(
      makeIntervention({ successProbability: 0.8, impact: 0.9, riskCost: 0.2, sampleCount: 0 }),
    );
    assert.equal(adjustedSuccessProbability, 0);
    assert.ok(Math.abs(ev - (-0.2)) < 1e-10, `Expected EV ≈ -0.2, got ${ev}`);
  });

  it("computes positive EV for high-impact, low-risk, high-confidence intervention", () => {
    const { ev } = computeExpectedValue(
      makeIntervention({ successProbability: 0.9, impact: 1.0, riskCost: 0.1, sampleCount: 10 }),
    );
    assert.ok(ev > 0, `Expected positive EV, got ${ev}`);
  });

  it("computes negative EV for zero-confidence high-risk intervention", () => {
    const { ev } = computeExpectedValue(
      makeIntervention({ successProbability: 0.9, impact: 0.5, riskCost: 0.9, sampleCount: 0 }),
    );
    assert.ok(ev < 0, `Expected negative EV (no confidence, high risk), got ${ev}`);
  });
});

// ── rankInterventions ─────────────────────────────────────────────────────────

describe("rankInterventions", () => {
  it("returns a new array sorted by descending EV", () => {
    const low  = makeIntervention({ id: "low",  impact: 0.1, riskCost: 0.9, successProbability: 0.5, sampleCount: 3 });
    const high = makeIntervention({ id: "high", impact: 0.9, riskCost: 0.1, successProbability: 0.9, sampleCount: 3 });
    const mid  = makeIntervention({ id: "mid",  impact: 0.5, riskCost: 0.3, successProbability: 0.7, sampleCount: 3 });

    const ranked = rankInterventions([low, mid, high]);
    assert.equal(ranked[0].id, "high");
    assert.equal(ranked[2].id, "low");
  });

  it("does not mutate the input array", () => {
    const original = [
      makeIntervention({ id: "a", impact: 0.2 }),
      makeIntervention({ id: "b", impact: 0.9 }),
    ];
    const originalIds = original.map((i) => i.id);
    rankInterventions(original);
    assert.deepEqual(original.map((i) => i.id), originalIds);
  });

  it("attaches ev and adjustedSuccessProbability to each ranked item", () => {
    const ranked = rankInterventions([makeIntervention()]);
    assert.ok("ev" in ranked[0], "ranked item should have ev field");
    assert.ok("adjustedSuccessProbability" in ranked[0]);
  });

  it("confidence penalty affects ranking — low sampleCount item ranks lower", () => {
    const confident = makeIntervention({ id: "confident", successProbability: 0.7, impact: 0.8, riskCost: 0.2, sampleCount: 3 });
    const sparse    = makeIntervention({ id: "sparse",    successProbability: 0.9, impact: 0.9, riskCost: 0.1, sampleCount: 0 });
    // sparse has higher raw successProbability but sampleCount=0 → EV = -riskCost = -0.1
    // confident: EV = 0.7 * 0.8 - 0.3 * 0.2 = 0.56 - 0.06 = 0.50
    const ranked = rankInterventions([sparse, confident]);
    assert.equal(ranked[0].id, "confident", "high-confidence item should rank first");
  });
});

// ── reconcileBudgets ──────────────────────────────────────────────────────────

describe("reconcileBudgets", () => {
  it("accepts all interventions when they fit within total budget", () => {
    const ranked = rankInterventions([
      makeIntervention({ id: "a", budgetCost: 2 }),
      makeIntervention({ id: "b", budgetCost: 3 }),
    ]);
    const result = reconcileBudgets(ranked, { maxWorkerSpawns: 10 });
    assert.equal(result.selected.length, 2);
    assert.equal(result.rejected.length, 0);
    assert.equal(result.status, OPTIMIZER_STATUS.OK);
    assert.equal(result.totalBudgetUsed, 5);
  });

  it("blocks intervention exceeding total budget (AC 2 — budget violations block schedule creation)", () => {
    const ranked = rankInterventions([
      makeIntervention({ id: "big", budgetCost: 8 }),
      makeIntervention({ id: "extra", budgetCost: 5 }),
    ]);
    const result = reconcileBudgets(ranked, { maxWorkerSpawns: 10 });
    assert.equal(result.selected.length, 1);
    assert.equal(result.selected[0].id, "big");
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].reasonCode, INTERVENTION_REJECTION_CODE.BUDGET_TOTAL);
    assert.equal(result.status, OPTIMIZER_STATUS.BUDGET_EXCEEDED);
    assert.equal(result.reasonCode, OPTIMIZER_REASON_CODE.BUDGET_TOTAL_EXCEEDED);
  });

  it("blocks intervention exceeding per-wave budget", () => {
    const ranked = rankInterventions([
      makeIntervention({ id: "a", wave: 1, budgetCost: 3 }),
      makeIntervention({ id: "b", wave: 1, budgetCost: 3 }), // would push wave-1 to 6 > limit 5
    ]);
    const result = reconcileBudgets(ranked, { maxWorkerSpawns: 20, maxWorkersPerWave: 5 });
    assert.equal(result.selected.length, 1);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].reasonCode, INTERVENTION_REJECTION_CODE.BUDGET_WAVE);
    assert.equal(result.reasonCode, OPTIMIZER_REASON_CODE.BUDGET_WAVE_EXCEEDED);
  });

  it("blocks intervention exceeding per-role budget", () => {
    const ranked = rankInterventions([
      makeIntervention({ id: "a", role: "backend", budgetCost: 2 }),
      makeIntervention({ id: "b", role: "backend", budgetCost: 2 }), // role total would be 4 > limit 3
    ]);
    const result = reconcileBudgets(ranked, {
      maxWorkerSpawns: 20,
      byRole: { backend: 3 },
    });
    assert.equal(result.selected.length, 1);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].reasonCode, INTERVENTION_REJECTION_CODE.BUDGET_ROLE);
    assert.equal(result.reasonCode, OPTIMIZER_REASON_CODE.BUDGET_ROLE_EXCEEDED);
  });

  it("reconciles all three constraints simultaneously — wave violation detected before role", () => {
    // Wave 1 can fit 3 workers, role 'backend' can fit 3, total can fit 10
    // Second intervention: wave would be 4 > 3 (wave limit hit first)
    const ranked = rankInterventions([
      makeIntervention({ id: "first",  wave: 1, role: "backend", budgetCost: 3 }),
      makeIntervention({ id: "second", wave: 1, role: "backend", budgetCost: 1 }), // wave exceeded
    ]);
    const result = reconcileBudgets(ranked, {
      maxWorkerSpawns: 10,
      maxWorkersPerWave: 3,
      byRole: { backend: 10 },
    });
    assert.equal(result.selected.length, 1);
    assert.equal(result.rejected[0].reasonCode, INTERVENTION_REJECTION_CODE.BUDGET_WAVE);
  });

  it("different waves are budgeted independently", () => {
    // Each wave can fit 3, total = 10
    const ranked = rankInterventions([
      makeIntervention({ id: "w1", wave: 1, budgetCost: 3 }),
      makeIntervention({ id: "w2", wave: 2, budgetCost: 3 }),
    ]);
    const result = reconcileBudgets(ranked, { maxWorkerSpawns: 10, maxWorkersPerWave: 3 });
    assert.equal(result.selected.length, 2);
    assert.equal(result.rejected.length, 0);
    assert.equal(result.byWaveUsed["1"], 3);
    assert.equal(result.byWaveUsed["2"], 3);
  });

  it("returns correct byWaveUsed and byRoleUsed tallies", () => {
    const ranked = rankInterventions([
      makeIntervention({ id: "a", wave: 1, role: "backend",  budgetCost: 2 }),
      makeIntervention({ id: "b", wave: 2, role: "frontend", budgetCost: 3 }),
    ]);
    const result = reconcileBudgets(ranked, { maxWorkerSpawns: 20 });
    assert.equal(result.byWaveUsed["1"], 2);
    assert.equal(result.byWaveUsed["2"], 3);
    assert.equal(result.byRoleUsed["backend"], 2);
    assert.equal(result.byRoleUsed["frontend"], 3);
    assert.equal(result.totalBudgetUsed, 5);
  });

  it("NEGATIVE PATH: all interventions rejected produces BUDGET_EXCEEDED status", () => {
    const ranked = rankInterventions([
      makeIntervention({ id: "a", budgetCost: 100 }),
      makeIntervention({ id: "b", budgetCost: 100 }),
    ]);
    const result = reconcileBudgets(ranked, { maxWorkerSpawns: 5 });
    assert.equal(result.selected.length, 0);
    assert.equal(result.rejected.length, 2);
    assert.equal(result.status, OPTIMIZER_STATUS.BUDGET_EXCEEDED);
    assert.equal(result.totalBudgetUsed, 0);
  });
});

// ── runInterventionOptimizer — happy path ─────────────────────────────────────

describe("runInterventionOptimizer — happy path", () => {
  it("returns OK status with ranked selected interventions", () => {
    const interventions = [
      makeIntervention({ id: "low",  impact: 0.3, riskCost: 0.5, sampleCount: 3 }),
      makeIntervention({ id: "high", impact: 0.9, riskCost: 0.1, sampleCount: 3 }),
    ];
    const result = runInterventionOptimizer(interventions, makeBudget());
    assert.equal(result.status, OPTIMIZER_STATUS.OK);
    assert.equal(result.reasonCode, OPTIMIZER_REASON_CODE.VALID);
    assert.equal(result.selected.length, 2);
    assert.equal(result.selected[0].id, "high", "highest EV should be first in selected");
    assert.equal(result.rejected.length, 0);
  });

  it("result includes all required schema fields", () => {
    const result = runInterventionOptimizer([makeIntervention()], makeBudget());
    const requiredFields = [
      "schemaVersion", "generatedAt", "status", "reasonCode",
      "budgetUnit", "totalBudgetLimit", "totalBudgetUsed",
      "byWaveBudgetLimit", "byWaveUsed", "byRoleBudgetLimits",
      "byRoleUsed", "selected", "rejected", "duplicateFamilySuppressionsApplied",
    ];
    for (const field of requiredFields) {
      assert.ok(field in result, `Result must include field '${field}'`);
    }
    assert.equal(result.schemaVersion, OPTIMIZER_LOG_SCHEMA_VERSION);
    assert.equal(result.budgetUnit, BUDGET_UNIT);
  });

  it("result.generatedAt is a valid ISO 8601 timestamp", () => {
    const result = runInterventionOptimizer([makeIntervention()], makeBudget());
    assert.ok(!isNaN(Date.parse(result.generatedAt)), "generatedAt must be parseable as ISO 8601");
  });

  it("selected items include ev and adjustedSuccessProbability fields", () => {
    const result = runInterventionOptimizer([makeIntervention()], makeBudget());
    assert.ok("ev" in result.selected[0]);
    assert.ok("adjustedSuccessProbability" in result.selected[0]);
  });

  it("confidence penalty is applied — sampleCount < threshold reduces EV", () => {
    const sparsely_tested = makeIntervention({ sampleCount: 0, impact: 0.9, riskCost: 0.1 });
    const well_tested     = makeIntervention({ id: "well", sampleCount: 10, impact: 0.9, riskCost: 0.1 });
    const result = runInterventionOptimizer([sparsely_tested, well_tested], makeBudget());
    const sparse_ev = result.selected.find((s) => s.id === "i-001").ev;
    const well_ev   = result.selected.find((s) => s.id === "well").ev;
    assert.ok(well_ev > sparse_ev, `well-tested EV (${well_ev}) should exceed sparse EV (${sparse_ev})`);
  });

  it("applies policy impact penalties when decayed effectiveness is low", () => {
    const interventions = [
      makeIntervention({ id: "policy-hit", successProbability: 0.8, impact: 0.8, riskCost: 0.2 }),
      makeIntervention({ id: "policy-miss", successProbability: 0.8, impact: 0.8, riskCost: 0.2 }),
    ];
    const result = runInterventionOptimizer(interventions, makeBudget(), {
      policyImpactByInterventionId: {
        "policy-hit": { decayedEffectiveness: 0.25 },
      },
    });
    assert.equal(result.policyImpactPenaltiesApplied, 1);
    const hit = result.selected.find((item) => item.id === "policy-hit");
    const miss = result.selected.find((item) => item.id === "policy-miss");
    assert.ok(hit.adjustedSuccessProbability < miss.adjustedSuccessProbability);
  });

  it("applies benchmark telemetry to boost successProbability for matching interventions", () => {
    const interventions = [
      makeIntervention({ id: "bench-hit", successProbability: 0.5, impact: 0.8, riskCost: 0.2 }),
      makeIntervention({ id: "bench-miss", successProbability: 0.5, impact: 0.8, riskCost: 0.2 }),
    ];
    const result = runInterventionOptimizer(interventions, makeBudget(), {
      benchmarkTelemetry: [
        { interventionId: "bench-hit", observedSuccessRate: 0.9, sampleCount: 5 },
      ],
    });
    assert.equal(result.benchmarkBoostsApplied, 1, "one boost should be applied");
    assert.equal(result.benchmarkTelemetryCount, 1);
    const hit = result.selected.find((item: any) => item.id === "bench-hit");
    const miss = result.selected.find((item: any) => item.id === "bench-miss");
    // bench-hit should have higher adjusted SP because observed rate (0.9) > estimated (0.5)
    assert.ok(hit.adjustedSuccessProbability > miss.adjustedSuccessProbability,
      "benchmark-boosted intervention must rank higher");
  });

  it("benchmark telemetry is skipped for entries with sampleCount < 1", () => {
    const interventions = [
      makeIntervention({ id: "sparse-bench", successProbability: 0.5 }),
    ];
    const result = runInterventionOptimizer(interventions, makeBudget(), {
      benchmarkTelemetry: [
        { interventionId: "sparse-bench", observedSuccessRate: 0.95, sampleCount: 0 },
      ],
    });
    assert.equal(result.benchmarkBoostsApplied, 0, "sparse telemetry must not be applied");
  });

  it("benchmarkTelemetryCount is 0 when no telemetry provided", () => {
    const result = runInterventionOptimizer([makeIntervention({})], makeBudget());
    assert.equal(result.benchmarkTelemetryCount, 0);
    assert.equal(result.benchmarkBoostsApplied, 0);
  });

  it("suppresses duplicate continuation families and prefers partially implemented continuation work", () => {
    const result = runInterventionOptimizer([
      makeIntervention({
        id: "partial-keep",
        role: "infrastructure-worker",
        impact: 0.5,
        implementationStatus: "implemented_partially",
        continuationFamilyKey: "infra:prompt-cache",
      }),
      makeIntervention({
        id: "fresh-drop",
        role: "infrastructure-worker",
        impact: 0.9,
        implementationStatus: "not_implemented",
        continuationFamilyKey: "infra:prompt-cache",
      }),
    ], makeBudget());

    assert.equal(result.duplicateFamilySuppressionsApplied, 1);
    assert.equal(result.selected.length, 1);
    assert.equal(result.selected[0].id, "partial-keep");
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].id, "fresh-drop");
    assert.equal(result.rejected[0].reasonCode, INTERVENTION_REJECTION_CODE.DUPLICATE_FAMILY_CONTINUATION);
  });

  it("does not suppress interventions from different continuation families", () => {
    const result = runInterventionOptimizer([
      makeIntervention({
        id: "infra-a",
        role: "infrastructure-worker",
        continuationFamilyKey: "infra:prompt-cache",
        implementationStatus: "implemented_partially",
      }),
      makeIntervention({
        id: "infra-b",
        role: "infrastructure-worker",
        continuationFamilyKey: "infra:conflict-replay",
        implementationStatus: "implemented_partially",
      }),
    ], makeBudget());

    assert.equal(result.duplicateFamilySuppressionsApplied, 0);
    assert.equal(result.selected.length, 2);
    assert.equal(result.rejected.length, 0);
  });
});

describe("buildPolicyImpactByInterventionId", () => {
  it("maps matching plans to decayed policy effectiveness", () => {
    const plans = [
      { intervention_id: "inv-1", task: "Fix glob false fail in verification", title: "Fix glob false fail", scope: "tests" },
      { intervention_id: "inv-2", task: "Refactor ui shell", title: "Refactor", scope: "src/ui" },
    ];
    const policies = [
      { id: "glob-false-fail", sourceLesson: "glob false fail", _decayedEffectiveness: 0.2, _inactiveCycles: 4 },
    ];
    const map = buildPolicyImpactByInterventionId(plans as any, policies as any);
    assert.ok(map["inv-1"]);
    assert.equal(map["inv-1"].policyId, "glob-false-fail");
    assert.equal(map["inv-1"].decayedEffectiveness, 0.2);
    assert.equal(map["inv-1"].inactiveCycles, 4);
    assert.equal(map["inv-2"], undefined);
  });

  it("negative: returns empty map for non-array inputs", () => {
    assert.deepEqual(buildPolicyImpactByInterventionId(null as any, []), {});
    assert.deepEqual(buildPolicyImpactByInterventionId([], null as any), {});
  });
});

describe("scoreInterventionsAgainstRubric", () => {
  it("scores interventions with policy attribution and combined score", () => {
    const interventions = [
      makeIntervention({ id: "inv-a" }),
      makeIntervention({ id: "inv-b" }),
    ];
    const rows = scoreInterventionsAgainstRubric(
      interventions as any,
      {
        "inv-a": { architecture: 0.8, speed: 0.6, security: 0.9 },
        "inv-b": { architecture: 0.4, speed: 0.4, security: 0.4 },
      },
      {
        cycleId: "cycle-101",
        outcomeByInterventionId: { "inv-a": 0.8, "inv-b": 0.3 },
        policyByInterventionId: { "inv-a": "glob-false-fail", "inv-b": "lint-failure" },
      },
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].cycleId, "cycle-101");
    assert.ok(rows[0].combinedScore >= rows[1].combinedScore);
  });

  it("preserves explicit no-signal outcome metadata from outcome envelopes", () => {
    const rows = scoreInterventionsAgainstRubric(
      [makeIntervention({ id: "inv-no-signal" })] as any,
      { "inv-no-signal": { architecture: 0.7, security: 0.7 } },
      {
        outcomeByInterventionId: {
          "inv-no-signal": {
            outcomeScore: 0.35,
            noSignalOutcome: true,
            closureMode: "no_signal",
            decisionMode: "retry_review",
          },
        },
        policyByInterventionId: { "inv-no-signal": "policy-no-signal" },
      },
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcomeStatus, "no_signal");
    assert.equal(rows[0].noSignalOutcome, true);
    assert.equal(rows[0].decisionMode, "retry_review");
    assert.equal(rows[0].closureMode, "no_signal");
  });

  it("negative: skips interventions without policy attribution", () => {
    const rows = scoreInterventionsAgainstRubric(
      [makeIntervention({ id: "inv-z" })] as any,
      { "inv-z": { architecture: 0.9 } },
      { outcomeByInterventionId: { "inv-z": 0.9 }, policyByInterventionId: {} },
    );
    assert.equal(rows.length, 0);
  });
});

describe("buildInterventionImpactAttributionRecords", () => {
  it("records improved planning interventions with lineage and reversible evidence", () => {
    const interventions = [
      makeIntervention({ id: "plan-1", type: INTERVENTION_TYPE.TASK, lineageId: "lineage-plan-1" }),
    ];
    const rows = buildInterventionImpactAttributionRecords(
      interventions as any,
      { "plan-1": { architecture: 0.8, speed: 0.8, security: 0.8 } },
      {
        cycleId: "cycle-plan-1",
        outcomeByInterventionId: { "plan-1": { outcomeScore: 0.9 } },
        policyByInterventionId: { "plan-1": "policy-plan-1" },
      },
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].interventionCategory, INTERVENTION_ACCOUNTING_CATEGORY.PLANNING);
    assert.equal(rows[0].lineageId, "lineage-plan-1");
    assert.equal(rows[0].outcomeStatus, "improved");
    assert.equal(rows[0].shouldRetire, false);
    assert.equal(rows[0].reversible, true);
  });

  it("records retry interventions as should_retire after repeated low-yield evidence", () => {
    const interventions = [
      makeIntervention({ id: "retry-1", type: INTERVENTION_TYPE.FOLLOWUP, lineageId: "lineage-retry-1" }),
    ];
    const rows = buildInterventionImpactAttributionRecords(
      interventions as any,
      { "retry-1": { architecture: 0.2, speed: 0.2, security: 0.2 } },
      {
        cycleId: "cycle-retry-3",
        outcomeByInterventionId: {
          "retry-1": {
            outcomeScore: 0.1,
            outcomeStatus: "should_retire",
            decisionMode: "retry_review",
          },
        },
        policyByInterventionId: { "retry-1": "policy-retry-1" },
        history: [
          { interventionId: "retry-1", lineageId: "lineage-retry-1", outcomeScore: 0.1, outcomeStatus: "should_retire" },
          { interventionId: "retry-1", lineageId: "lineage-retry-1", outcomeScore: 0.2, outcomeStatus: "should_retire" },
        ],
        evidenceWindowCycles: 3,
      },
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].interventionCategory, INTERVENTION_ACCOUNTING_CATEGORY.RETRY);
    assert.equal(rows[0].outcomeStatus, "should_retire");
    assert.equal(rows[0].shouldRetire, true);
    assert.equal(rows[0].evidenceCount, 3);
    assert.ok(rows[0].retirementReason.includes("low_yield"));
  });

  it("keeps low-signal planning interventions reversible when the evidence window is not yet full", () => {
    const interventions = [
      makeIntervention({ id: "plan-hold", type: INTERVENTION_TYPE.TASK }),
    ];
    const rows = buildInterventionImpactAttributionRecords(
      interventions as any,
      { "plan-hold": { architecture: 0.5 } },
      {
        outcomeByInterventionId: {
          "plan-hold": {
            outcomeScore: 0.35,
            noSignalOutcome: true,
            closureMode: "no_signal",
          },
        },
        policyByInterventionId: { "plan-hold": "policy-plan-hold" },
        evidenceWindowCycles: 3,
      },
    );
    assert.equal(rows[0].outcomeStatus, "no_signal");
    assert.equal(rows[0].shouldRetire, false);
    assert.equal(rows[0].evidenceCount, 1);
    assert.equal(rows[0].reversible, true);
  });
});

// ── runInterventionOptimizer — negative paths ─────────────────────────────────

describe("runInterventionOptimizer — negative paths", () => {
  it("NEGATIVE PATH: null interventions → INVALID_INPUT with MISSING_INPUT code", () => {
    const result = runInterventionOptimizer(null, makeBudget());
    assert.equal(result.status, OPTIMIZER_STATUS.INVALID_INPUT);
    assert.equal(result.reasonCode, OPTIMIZER_REASON_CODE.MISSING_INPUT);
    assert.ok(result.errorMessage);
    assert.equal(result.selected.length, 0);
    assert.equal(result.rejected.length, 0);
  });

  it("NEGATIVE PATH: non-array interventions → INVALID_INPUT with MISSING_INPUT code", () => {
    const result = runInterventionOptimizer("bad-input", makeBudget());
    assert.equal(result.status, OPTIMIZER_STATUS.INVALID_INPUT);
    assert.equal(result.reasonCode, OPTIMIZER_REASON_CODE.MISSING_INPUT);
  });

  it("NEGATIVE PATH: null budget → INVALID_INPUT with INVALID_BUDGET code", () => {
    const result = runInterventionOptimizer([makeIntervention()], null);
    assert.equal(result.status, OPTIMIZER_STATUS.INVALID_INPUT);
    assert.equal(result.reasonCode, OPTIMIZER_REASON_CODE.INVALID_BUDGET);
    assert.ok(result.errorMessage);
  });

  it("NEGATIVE PATH: missing budget.maxWorkerSpawns → INVALID_INPUT with INVALID_BUDGET", () => {
    const result = runInterventionOptimizer([makeIntervention()], {});
    assert.equal(result.status, OPTIMIZER_STATUS.INVALID_INPUT);
    assert.equal(result.reasonCode, OPTIMIZER_REASON_CODE.INVALID_BUDGET);
  });

  it("NEGATIVE PATH: invalid intervention in array → INVALID_INPUT with INVALID_INTERVENTION", () => {
    const interventions = [
      makeIntervention({ id: "valid-a" }),
      makeIntervention({ type: "INVALID_ENUM_VALUE" }), // invalid type
    ];
    const result = runInterventionOptimizer(interventions, makeBudget());
    assert.equal(result.status, OPTIMIZER_STATUS.INVALID_INPUT);
    assert.equal(result.reasonCode, OPTIMIZER_REASON_CODE.INVALID_INTERVENTION);
    assert.ok(result.errorMessage.includes("interventions[1]"), "error message should include the index");
    assert.equal(result.selected.length, 0);
  });

  it("NEGATIVE PATH: empty interventions array → EMPTY_INPUT status (not an error)", () => {
    const result = runInterventionOptimizer([], makeBudget());
    assert.equal(result.status, OPTIMIZER_STATUS.EMPTY_INPUT);
    assert.equal(result.reasonCode, OPTIMIZER_REASON_CODE.EMPTY_INPUT);
    assert.equal(result.selected.length, 0);
    assert.equal(result.rejected.length, 0);
  });

  it("NEGATIVE PATH: budget_exceeded status when interventions exceed budget", () => {
    const interventions = [
      makeIntervention({ id: "a", budgetCost: 8 }),
      makeIntervention({ id: "b", budgetCost: 8 }),
    ];
    const result = runInterventionOptimizer(interventions, makeBudget({ maxWorkerSpawns: 10 }));
    assert.equal(result.status, OPTIMIZER_STATUS.BUDGET_EXCEEDED);
    assert.equal(result.selected.length, 1);
    assert.equal(result.rejected.length, 1);
  });

  it("NEGATIVE PATH: invalid_input result has no silent fallback — status is explicit", () => {
    const result = runInterventionOptimizer(null, null);
    // Both null → budget validation fails first
    assert.equal(result.status, OPTIMIZER_STATUS.INVALID_INPUT);
    assert.ok(result.reasonCode);
    assert.ok(result.errorMessage);
    // No selected items produced silently
    assert.equal(result.selected.length, 0);
  });

  it("NEGATIVE PATH: missing required field in intervention returns invalidField", () => {
    const inv = makeIntervention();
    delete inv.budgetCost;
    const result = runInterventionOptimizer([inv], makeBudget());
    assert.equal(result.status, OPTIMIZER_STATUS.INVALID_INPUT);
    assert.equal(result.reasonCode, OPTIMIZER_REASON_CODE.INVALID_INTERVENTION);
    assert.equal(result.invalidField, "budgetCost");
  });
});

// ── buildInterventionsFromPlan ────────────────────────────────────────────────

describe("buildInterventionsFromPlan", () => {
  it("converts prometheus plans to valid intervention objects", () => {
    const plans = [
      { role: "King David", kind: "backend", priority: 8, wave: "wave-1", task: "Fix auth", id: "p-1" },
      { role: "Esther",     kind: "frontend", priority: 4, wave: "wave-2", task: "Fix UI",  id: "p-2" },
    ];
    const interventions = buildInterventionsFromPlan(plans, {});
    assert.equal(interventions.length, 2);
    for (const inv of interventions) {
      const vr = validateIntervention(inv);
      assert.equal(vr.ok, true, `Converted intervention should be valid: ${vr.message}`);
    }
  });

  it("parses wave number from wave string", () => {
    const plans = [{ role: "Aaron", task: "api task", wave: "wave-3", priority: 5 }];
    const [inv] = buildInterventionsFromPlan(plans, {});
    assert.equal(inv.wave, 3);
  });

  it("defaults wave to 1 for unparseable wave string", () => {
    const plans = [{ role: "Aaron", task: "api task", wave: "invalid", priority: 5 }];
    const [inv] = buildInterventionsFromPlan(plans, {});
    assert.equal(inv.wave, 1);
  });

  it("derives impact from priority (priority 10 → impact 1.0)", () => {
    const plans = [{ role: "Aaron", task: "high prio", wave: "wave-1", priority: 10 }];
    const [inv] = buildInterventionsFromPlan(plans, {});
    assert.equal(inv.impact, 1.0);
  });

  it("returns empty array for null or empty plans input", () => {
    assert.deepEqual(buildInterventionsFromPlan(null, {}), []);
    assert.deepEqual(buildInterventionsFromPlan([], {}), []);
  });

  it("uses defaultSampleCount from config when provided", () => {
    const plans = [{ role: "Noah", task: "deploy", wave: "wave-1", priority: 5 }];
    const [inv] = buildInterventionsFromPlan(plans, {
      interventionOptimizer: { defaultSampleCount: 5 },
    });
    assert.equal(inv.sampleCount, 5);
  });

  it("defaults sampleCount to SPARSE_DATA_THRESHOLD when not in config", () => {
    const plans = [{ role: "Noah", task: "deploy", wave: "wave-1", priority: 5 }];
    const [inv] = buildInterventionsFromPlan(plans, {});
    assert.equal(inv.sampleCount, SPARSE_DATA_THRESHOLD);
  });
});

// ── buildBudgetFromConfig ─────────────────────────────────────────────────────

describe("buildBudgetFromConfig", () => {
  it("uses requestBudget.hardCapTotal as maxWorkerSpawns when present", () => {
    const budget = buildBudgetFromConfig({ hardCapTotal: 15 }, {});
    assert.equal(budget.maxWorkerSpawns, 15);
  });

  it("falls back to config runtimeBudget.maxWorkerSpawnsPerCycle", () => {
    const config = { runtime: { runtimeBudget: { maxWorkerSpawnsPerCycle: 8 } } };
    const budget = buildBudgetFromConfig({}, config);
    assert.equal(budget.maxWorkerSpawns, 8);
  });

  it("falls back to config runtimeBudget.maxTasksPerCycle when maxWorkerSpawnsPerCycle absent", () => {
    const config = { runtime: { runtimeBudget: { maxTasksPerCycle: 6 } } };
    const budget = buildBudgetFromConfig({}, config);
    assert.equal(budget.maxWorkerSpawns, 6);
  });

  it("defaults to 12 when all config sources are absent", () => {
    const budget = buildBudgetFromConfig({}, {});
    assert.equal(budget.maxWorkerSpawns, 12);
  });

  it("always returns a valid Budget object", () => {
    const budget = buildBudgetFromConfig(null, null);
    const vr = validateBudget(budget);
    assert.equal(vr.ok, true, `buildBudgetFromConfig should always produce a valid budget: ${vr.message}`);
  });

  it("includes byRole when requestBudget.byRole is populated", () => {
    const requestBudget = {
      hardCapTotal: 10,
      byRole: [
        { role: "backend", count: 4 },
        { role: "frontend", count: 3 },
      ],
    };
    const budget = buildBudgetFromConfig(requestBudget, {});
    assert.ok(budget.byRole);
    assert.equal(budget.byRole.backend, 4);
    assert.equal(budget.byRole.frontend, 3);
  });

  it("sanitizes byWave entries using estimatedRequests field alias", () => {
    // buildDeterministicRequestBudget in prometheus uses estimatedRequests,
    // not count or budget — this validates the alias is accepted.
    const requestBudget = {
      hardCapTotal: 10,
      byWave: [
        { wave: 1, estimatedRequests: 6 },
        { wave: 2, estimatedRequests: 4 },
      ],
    };
    const budget = buildBudgetFromConfig(requestBudget, {});
    // maxWorkersPerWave should reflect the max estimatedRequests across waves (6)
    assert.equal(budget.maxWorkersPerWave, 6);
  });

  it("sanitizes byRole entries using estimatedRequests field alias", () => {
    const requestBudget = {
      hardCapTotal: 10,
      byRole: [
        { role: "evolution-worker", estimatedRequests: 5 },
        { role: "observation-worker", estimatedRequests: 3 },
      ],
    };
    const budget = buildBudgetFromConfig(requestBudget, {});
    assert.ok(budget.byRole);
    assert.equal(budget.byRole["evolution-worker"], 5);
    assert.equal(budget.byRole["observation-worker"], 3);
  });

  it("negative path: estimatedRequests=0 does not populate byRole entry", () => {
    const requestBudget = {
      hardCapTotal: 10,
      byRole: [
        { role: "evolution-worker", estimatedRequests: 0 },
      ],
    };
    const budget = buildBudgetFromConfig(requestBudget, {});
    assert.ok(!budget.byRole || !budget.byRole["evolution-worker"],
      "zero estimatedRequests should not produce a byRole entry");
  });
});

describe("dispatch budget realignment regression", () => {
  it("admits all approved plans once the budget reflects final rerouted worker roles", () => {
    const approvedPlans = [
      {
        id: "plan-1",
        task_id: "plan-1",
        task: "Add tests for provider contracts",
        role: "evolution-worker",
        wave: 2,
        target_files: ["tests/api/provider_contracts.test.ts"],
        verification_commands: ["npm test -- tests/api/provider_contracts.test.ts"],
      },
      {
        id: "plan-2",
        task_id: "plan-2",
        task: "Add tests for weather presentation states",
        role: "evolution-worker",
        wave: 3,
        target_files: ["tests/components/weather_states.test.tsx"],
        verification_commands: ["npm test -- tests/components/weather_states.test.tsx"],
      },
      {
        id: "plan-3",
        task_id: "plan-3",
        task: "Build debounced geocoding search",
        role: "integration-worker",
        wave: 3,
      },
      {
        id: "plan-4",
        task_id: "plan-4",
        task: "Wire App.tsx into the weather experience",
        role: "integration-worker",
        wave: 4,
      },
      {
        id: "plan-5",
        task_id: "plan-5",
        task: "Create the Vitest and RTL quality gate",
        role: "quality-worker",
        wave: 5,
        target_files: ["tests/app/app_shell.test.tsx"],
        verification_commands: ["npm test -- tests/app/app_shell.test.tsx"],
      },
    ];

    const reroutedPlans = approvedPlans.map((plan) => ({ ...plan }));
    const pool = assignWorkersToPlans(reroutedPlans, {}, {}, {});
    for (const { plan, selection } of pool.assignments) {
      if (!selection.isFallback && selection.role !== plan.role) {
        plan.role = selection.role;
      }
    }

    const executionStrategy = {
      waves: [{ wave: 2 }, { wave: 3 }, { wave: 4 }, { wave: 5 }],
    };
    const staleBudget = buildBudgetFromConfig(
      buildDeterministicRequestBudget(approvedPlans, executionStrategy),
      {},
    );
    const freshBudget = buildBudgetFromConfig(
      buildDeterministicRequestBudget(reroutedPlans, executionStrategy),
      {},
    );
    const interventions = buildInterventionsFromPlan(reroutedPlans, {});

    const staleResult = runInterventionOptimizer(interventions, staleBudget, {});
    assert.equal(staleResult.status, OPTIMIZER_STATUS.BUDGET_EXCEEDED);
    assert.equal(staleResult.reasonCode, OPTIMIZER_REASON_CODE.BUDGET_ROLE_EXCEEDED);
    assert.equal(staleResult.selected.length, 3);
    assert.equal(staleResult.rejected.length, 2);

    const freshResult = runInterventionOptimizer(interventions, freshBudget, {});
    assert.equal(freshResult.status, OPTIMIZER_STATUS.OK);
    assert.equal(freshResult.reasonCode, OPTIMIZER_REASON_CODE.VALID);
    assert.equal(freshResult.selected.length, 5);
    assert.equal(freshResult.rejected.length, 0);
    assert.deepEqual(freshBudget.byRole, {
      "quality-worker": 3,
      "integration-worker": 2,
    });
  });
});

// ── Full integration: runInterventionOptimizer with buildInterventionsFromPlan ─

describe("full integration: plan → interventions → optimizer", () => {
  it("processes a realistic prometheus plan through the full optimizer pipeline", () => {
    const plans = [
      { id: "p1", role: "King David", kind: "backend",  priority: 9, wave: "wave-1", task: "Fix critical auth bug" },
      { id: "p2", role: "Samuel",     kind: "test",     priority: 7, wave: "wave-1", task: "Add auth tests" },
      { id: "p3", role: "Noah",       kind: "devops",   priority: 5, wave: "wave-2", task: "Update CI pipeline" },
      { id: "p4", role: "Esther",     kind: "frontend", priority: 3, wave: "wave-2", task: "Fix button layout" },
    ];

    const config = {
      runtime: { runtimeBudget: { maxTasksPerCycle: 12, maxWorkerSpawnsPerCycle: 12 } },
      planner: { defaultMaxWorkersPerWave: 10 },
    };
    const requestBudget = { hardCapTotal: 4, byWave: [], byRole: [] };

    const interventions = buildInterventionsFromPlan(plans, config);
    const budget = buildBudgetFromConfig(requestBudget, config);
    const result = runInterventionOptimizer(interventions, budget);

    assert.equal(result.status, OPTIMIZER_STATUS.OK);
    assert.equal(result.selected.length, 4);
    // Highest priority (p1) should have highest EV and rank first
    assert.equal(result.selected[0].id, "p1");
    // All selected items have ev field
    for (const s of result.selected) {
      assert.ok(typeof s.ev === "number");
    }
  });
});

describe("persistOptimizerLog — parse-safe JSONL + freshness metadata", () => {
  it("writes parseable JSONL entries with explicit schema and freshness metadata", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-optimizer-log-"));
    try {
      const result = runInterventionOptimizer([makeIntervention()], makeBudget());
      const persisted = await persistOptimizerLog(tmpDir, result);
      assert.equal(persisted.ok, true);

      const logPath = path.join(tmpDir, "intervention_optimizer_log.jsonl");
      const raw = await fs.readFile(logPath, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      assert.equal(lines.length, 1);

      const entry = JSON.parse(lines[0]);
      assert.equal(entry.jsonlSchema, OPTIMIZER_LOG_JSONL_SCHEMA);
      assert.equal(entry.recordType, OPTIMIZER_LOG_RECORD_TYPE);
      assert.equal(entry.schemaVersion, OPTIMIZER_LOG_SCHEMA_VERSION);
      assert.equal(entry.freshness.status, "fresh");
      assert.equal(entry.freshness.staleAfterMs, OPTIMIZER_LOG_FRESHNESS_MS);
      assert.ok(typeof entry.freshness.expiresAt === "string" && entry.freshness.expiresAt.length > 0);
      assert.equal(entry.payload.status, result.status);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("negative path: each JSONL line is independently parseable after multiple appends", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-optimizer-log-multi-"));
    try {
      await persistOptimizerLog(tmpDir, runInterventionOptimizer([makeIntervention({ id: "a" })], makeBudget()));
      await persistOptimizerLog(tmpDir, runInterventionOptimizer([makeIntervention({ id: "b" })], makeBudget()));
      const raw = await fs.readFile(path.join(tmpDir, "intervention_optimizer_log.jsonl"), "utf8");
      const lines = raw.split("\n").filter(Boolean);
      assert.equal(lines.length, 2);
      for (const line of lines) {
        assert.doesNotThrow(() => JSON.parse(line));
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Reroute EV penalty ─────────────────────────────────────────────────────────
import {
  applyRerouteCostPenalty,
  REROUTE_EV_PENALTY_COEFFICIENT,
  REROUTE_EV_MAX_PENALTY,
} from "../../src/core/intervention_optimizer.js";

describe("applyRerouteCostPenalty", () => {
  it("penalizes positive EV when role matches reroute reason", () => {
    const penalized = applyRerouteCostPenalty(1.0, "backend", [
      { role: "backend", reasonCode: "FILL_RATIO_BELOW_THRESHOLD", lane: "lane-1" },
    ]);
    assert.ok(penalized < 1.0, "EV must be reduced for matching role");
  });

  it("does not penalize when role does not match reroute reasons", () => {
    const penalized = applyRerouteCostPenalty(1.0, "frontend", [
      { role: "backend", reasonCode: "FILL_RATIO_BELOW_THRESHOLD", lane: "lane-1" },
    ]);
    assert.equal(penalized, 1.0);
  });

  it("does not worsen negative EV (no double-penalization)", () => {
    const penalized = applyRerouteCostPenalty(-0.5, "backend", [
      { role: "backend", reasonCode: "FILL_RATIO_BELOW_THRESHOLD", lane: "lane-1" },
    ]);
    assert.equal(penalized, -0.5);
  });

  it("caps penalty at REROUTE_EV_MAX_PENALTY regardless of reroute count", () => {
    const manyReroutes = Array.from({ length: 20 }, () => ({
      role: "backend", reasonCode: "FILL_RATIO_BELOW_THRESHOLD", lane: "lane-1",
    }));
    const penalized = applyRerouteCostPenalty(1.0, "backend", manyReroutes);
    assert.ok(penalized >= 1.0 - REROUTE_EV_MAX_PENALTY - 0.001,
      `penalty must not exceed REROUTE_EV_MAX_PENALTY=${REROUTE_EV_MAX_PENALTY}`);
  });

  it("applies REROUTE_EV_PENALTY_COEFFICIENT for a single reroute", () => {
    const penalized = applyRerouteCostPenalty(1.0, "backend", [
      { role: "backend", reasonCode: "FILL_RATIO_BELOW_THRESHOLD", lane: "lane-1" },
    ]);
    const expectedMin = 1.0 - REROUTE_EV_PENALTY_COEFFICIENT - 0.001;
    const expectedMax = 1.0 - REROUTE_EV_PENALTY_COEFFICIENT + 0.001;
    assert.ok(penalized >= expectedMin && penalized <= expectedMax,
      `expected ~${1.0 - REROUTE_EV_PENALTY_COEFFICIENT} got ${penalized}`);
  });
});

// ── Reroute EV penalty — differentiated by reason code ────────────────────────
import {
  REROUTE_PERFORMANCE_EV_PENALTY_COEFFICIENT,
  REROUTE_ESCALATION_THRESHOLD,
  getRerouteEscalationSignal,
} from "../../src/core/intervention_optimizer.js";

describe("applyRerouteCostPenalty — PERFORMANCE_DEGRADED differentiation", () => {
  it("applies REROUTE_PERFORMANCE_EV_PENALTY_COEFFICIENT for a PERFORMANCE_DEGRADED reroute", () => {
    const penalized = applyRerouteCostPenalty(1.0, "backend", [
      { role: "backend", reasonCode: "performance_degraded", lane: "lane-1" },
    ]);
    // Single PERFORMANCE_DEGRADED reroute: coefficient is 0.25 but capped at REROUTE_EV_MAX_PENALTY (0.20).
    const expectedPenalty = Math.min(REROUTE_EV_MAX_PENALTY, REROUTE_PERFORMANCE_EV_PENALTY_COEFFICIENT);
    const expected = 1.0 * (1 - expectedPenalty);
    assert.ok(Math.abs(penalized - expected) < 0.002,
      `expected ~${expected} for PERFORMANCE_DEGRADED (capped at ${REROUTE_EV_MAX_PENALTY}), got ${penalized}`);
  });

  it("PERFORMANCE_DEGRADED penalty is higher than BELOW_FILL_THRESHOLD penalty", () => {
    const reroutes = [{ role: "backend", lane: "lane-1" }];
    const penaltyBelowFill = 1.0 - applyRerouteCostPenalty(1.0, "backend", [
      { ...reroutes[0], reasonCode: "below_fill_threshold" },
    ]);
    const penaltyPerfDegraded = 1.0 - applyRerouteCostPenalty(1.0, "backend", [
      { ...reroutes[0], reasonCode: "performance_degraded" },
    ]);
    assert.ok(penaltyPerfDegraded > penaltyBelowFill,
      "PERFORMANCE_DEGRADED must apply a higher penalty than BELOW_FILL_THRESHOLD");
  });

  it("cap still applies: mixed reason codes cannot exceed REROUTE_EV_MAX_PENALTY", () => {
    const manyReroutes = Array.from({ length: 10 }, () => ({
      role: "backend", reasonCode: "performance_degraded", lane: "lane-1",
    }));
    const penalized = applyRerouteCostPenalty(1.0, "backend", manyReroutes);
    assert.ok(penalized >= 1.0 - REROUTE_EV_MAX_PENALTY - 0.001,
      `mixed penalty must still be capped at REROUTE_EV_MAX_PENALTY=${REROUTE_EV_MAX_PENALTY}`);
  });

  it("REROUTE_PERFORMANCE_EV_PENALTY_COEFFICIENT is exported as a positive number", () => {
    assert.ok(typeof REROUTE_PERFORMANCE_EV_PENALTY_COEFFICIENT === "number");
    assert.ok(REROUTE_PERFORMANCE_EV_PENALTY_COEFFICIENT > 0);
    assert.ok(REROUTE_PERFORMANCE_EV_PENALTY_COEFFICIENT > REROUTE_EV_PENALTY_COEFFICIENT,
      "performance penalty coefficient must exceed base penalty coefficient");
  });
});

describe("getRerouteEscalationSignal", () => {
  it("returns null when degraded count is below REROUTE_ESCALATION_THRESHOLD", () => {
    const reroutes = [{ role: "backend", reasonCode: "performance_degraded" }];
    const signal = getRerouteEscalationSignal("backend", reroutes);
    if (REROUTE_ESCALATION_THRESHOLD > 1) {
      assert.equal(signal, null);
    }
  });

  it("returns escalation descriptor when degraded count reaches REROUTE_ESCALATION_THRESHOLD", () => {
    const reroutes = Array.from({ length: REROUTE_ESCALATION_THRESHOLD }, () => ({
      role: "backend", reasonCode: "performance_degraded",
    }));
    const signal = getRerouteEscalationSignal("backend", reroutes);
    assert.ok(signal !== null, "signal must be non-null at escalation threshold");
    assert.equal(signal!.role, "backend");
    assert.equal(signal!.degradedCount, REROUTE_ESCALATION_THRESHOLD);
    assert.equal(signal!.escalate, true);
  });

  it("does not escalate for non-PERFORMANCE_DEGRADED reroutes", () => {
    const reroutes = Array.from({ length: REROUTE_ESCALATION_THRESHOLD + 2 }, () => ({
      role: "backend", reasonCode: "below_fill_threshold",
    }));
    const signal = getRerouteEscalationSignal("backend", reroutes);
    assert.equal(signal, null,
      "escalation must only trigger on PERFORMANCE_DEGRADED reason code");
  });

  it("negative path: returns null for empty reroute list", () => {
    assert.equal(getRerouteEscalationSignal("backend", []), null);
  });

  it("negative path: returns null for non-array reroute reasons (no throw)", () => {
    assert.equal(getRerouteEscalationSignal("backend", null as any), null);
  });

  it("REROUTE_ESCALATION_THRESHOLD is exported as a positive integer", () => {
    assert.ok(Number.isInteger(REROUTE_ESCALATION_THRESHOLD));
    assert.ok(REROUTE_ESCALATION_THRESHOLD >= 1);
  });
});

// ── End-to-end: reroute reason codes → reroute_history → optimizer counters ──

import {
  REROUTE_HISTORY_RECORD_SCHEMA,
} from "../../src/core/intervention_optimizer.js";

describe("REROUTE_HISTORY_RECORD_SCHEMA", () => {
  it("is exported and frozen with required fields array", () => {
    assert.ok(Object.isFrozen(REROUTE_HISTORY_RECORD_SCHEMA));
    assert.ok(Array.isArray(REROUTE_HISTORY_RECORD_SCHEMA.required));
    for (const field of ["recordedAt", "role", "lane", "reasonCode", "fillRatio", "laneScore"]) {
      assert.ok(
        REROUTE_HISTORY_RECORD_SCHEMA.required.includes(field),
        `reroute_history schema must require field '${field}'`
      );
    }
  });

  it("reasonCodeExamples includes fill_threshold and performance_degraded", () => {
    assert.ok(REROUTE_HISTORY_RECORD_SCHEMA.reasonCodeExamples.includes("fill_threshold"));
    assert.ok(REROUTE_HISTORY_RECORD_SCHEMA.reasonCodeExamples.includes("performance_degraded"));
  });
});

describe("runInterventionOptimizer — reroute reason code end-to-end", () => {
  it("rerouteCostPenaltiesApplied is 0 when no rerouteReasons provided", () => {
    const result = runInterventionOptimizer(
      [makeIntervention({ id: "r-base", role: "backend" })],
      makeBudget(),
    );
    assert.equal(result.rerouteCostPenaltiesApplied, 0,
      "no reroute reasons must produce zero penalties applied");
  });

  it("rerouteCostPenaltiesApplied increments when rerouted role matches intervention role", () => {
    const result = runInterventionOptimizer(
      [makeIntervention({ id: "r1", role: "backend" })],
      makeBudget(),
      {
        rerouteReasons: [
          { role: "backend", reasonCode: "fill_threshold", lane: "backend", fillRatio: 0.2, laneScore: 0.4 },
        ],
      },
    );
    assert.ok(result.rerouteCostPenaltiesApplied >= 1,
      "rerouteCostPenaltiesApplied must be > 0 when rerouted role matches");
  });

  it("rerouteCostPenaltiesApplied is 0 when rerouted role does not match any intervention role", () => {
    const result = runInterventionOptimizer(
      [makeIntervention({ id: "r-nomatch", role: "frontend" })],
      makeBudget(),
      {
        rerouteReasons: [
          { role: "backend", reasonCode: "fill_threshold", lane: "backend", fillRatio: 0.2, laneScore: 0.4 },
        ],
      },
    );
    assert.equal(result.rerouteCostPenaltiesApplied, 0,
      "non-matching role must not be penalised");
  });

  it("penalised intervention has _reroutePenaltyApplied=true in selected output", () => {
    const result = runInterventionOptimizer(
      [makeIntervention({ id: "r-flag", role: "backend", successProbability: 0.9, impact: 0.9, riskCost: 0.1 })],
      makeBudget(),
      {
        rerouteReasons: [
          { role: "backend", reasonCode: "fill_threshold", lane: "backend", fillRatio: 0.1, laneScore: 0.3 },
        ],
      },
    );
    const selected = result.selected.find((s: any) => s.id === "r-flag");
    assert.ok(selected !== undefined, "penalised intervention must still be selected when budget allows");
    assert.equal(selected._reroutePenaltyApplied, true,
      "_reroutePenaltyApplied must be true on penalised intervention");
  });

  it("penalised role has lower adjustedSuccessProbability than identical unpenalised intervention", () => {
    const penalised = runInterventionOptimizer(
      [makeIntervention({ id: "pen", role: "backend", successProbability: 0.8, sampleCount: 5 })],
      makeBudget(),
      {
        rerouteReasons: [
          { role: "backend", reasonCode: "fill_threshold", lane: "backend", fillRatio: 0.1, laneScore: 0.2 },
        ],
      },
    );
    const unpenalised = runInterventionOptimizer(
      [makeIntervention({ id: "unpen", role: "backend", successProbability: 0.8, sampleCount: 5 })],
      makeBudget(),
      { rerouteReasons: [] },
    );
    const penItem   = penalised.selected.find((s: any) => s.id === "pen");
    const unpenItem = unpenalised.selected.find((s: any) => s.id === "unpen");
    assert.ok(penItem !== undefined && unpenItem !== undefined, "both interventions must be selected");
    assert.ok(
      penItem.adjustedSuccessProbability < unpenItem.adjustedSuccessProbability,
      `penalised SP (${penItem.adjustedSuccessProbability}) must be < unpenalised SP (${unpenItem.adjustedSuccessProbability})`
    );
  });

  it("performance_degraded reroute causes heavier penalty than fill_threshold reroute", () => {
    const base = makeIntervention({ id: "base", role: "backend", successProbability: 0.8, sampleCount: 5 });

    const withFill = runInterventionOptimizer([{ ...base, id: "fill" }], makeBudget(), {
      rerouteReasons: [{ role: "backend", reasonCode: "fill_threshold", lane: "backend", fillRatio: 0.2, laneScore: 0.5 }],
    });
    const withPerf = runInterventionOptimizer([{ ...base, id: "perf" }], makeBudget(), {
      rerouteReasons: [{ role: "backend", reasonCode: "performance_degraded", lane: "backend", fillRatio: 0.1, laneScore: 0.2 }],
    });
    const fillItem = withFill.selected.find((s: any) => s.id === "fill");
    const perfItem = withPerf.selected.find((s: any) => s.id === "perf");
    assert.ok(fillItem && perfItem, "both must be selected");
    assert.ok(
      perfItem.adjustedSuccessProbability <= fillItem.adjustedSuccessProbability,
      "performance_degraded must produce >= penalty than fill_threshold"
    );
  });

  it("multiple reroutes for the same role accumulate penalties (capped at REROUTE_EV_MAX_PENALTY)", () => {
    const manyReroutes = Array.from({ length: 10 }, (_, i) => ({
      role: "backend", reasonCode: "fill_threshold", lane: "backend", fillRatio: 0.1, laneScore: 0.2,
    }));
    const result = runInterventionOptimizer(
      [makeIntervention({ id: "multi", role: "backend", successProbability: 0.8, sampleCount: 5 })],
      makeBudget(),
      { rerouteReasons: manyReroutes },
    );
    const item = result.selected.find((s: any) => s.id === "multi");
    assert.ok(item, "intervention must still be selected after capped penalty");
    // Penalty is capped at REROUTE_EV_MAX_PENALTY; EV never goes to zero from penalty alone
    assert.ok(item.adjustedSuccessProbability > 0,
      "adjustedSuccessProbability must remain > 0 after maximum penalty");
  });

  it("reroute history records conforming to REROUTE_HISTORY_RECORD_SCHEMA are fully accepted", () => {
    // Simulate reading records from reroute_history.jsonl — must have all schema fields
    const rerouteRecords = [
      {
        recordedAt: new Date().toISOString(),
        role: "backend",
        lane: "backend",
        reasonCode: "fill_threshold",
        fillRatio: 0.15,
        laneScore: 0.3,
      },
    ];
    // Verify each record has all required fields
    for (const record of rerouteRecords) {
      for (const field of REROUTE_HISTORY_RECORD_SCHEMA.required) {
        assert.ok(field in record, `reroute record missing required field '${field}'`);
      }
    }
    // Verify the optimizer accepts them without error
    const result = runInterventionOptimizer(
      [makeIntervention({ id: "schema-e2e", role: "backend" })],
      makeBudget(),
      { rerouteReasons: rerouteRecords },
    );
    assert.ok(result.status !== "invalid_input", "well-formed reroute records must not invalidate the optimizer");
    assert.ok(result.rerouteCostPenaltiesApplied >= 1);
  });

  it("scoreboard rows for penalised role have lower combined score than identical unpenalised role", () => {
    // The scoreInterventionsAgainstRubric function reflects lower EV as lower combined score
    // when an intervention's successProbability is reduced by reroute penalty.
    const baseIntervention = makeIntervention({ id: "sb-test", role: "backend",
      successProbability: 0.8, sampleCount: 5, impact: 0.8, riskCost: 0.2 });

    const penResult = runInterventionOptimizer([{ ...baseIntervention, id: "sb-pen" }], makeBudget(), {
      rerouteReasons: [
        { role: "backend", reasonCode: "performance_degraded", lane: "backend", fillRatio: 0.1, laneScore: 0.2 },
      ],
    });
    const unpenResult = runInterventionOptimizer([{ ...baseIntervention, id: "sb-unpen" }], makeBudget(), {
      rerouteReasons: [],
    });

    const penSP   = penResult.selected.find((s: any) => s.id === "sb-pen")?.adjustedSuccessProbability ?? 1;
    const unpenSP = unpenResult.selected.find((s: any) => s.id === "sb-unpen")?.adjustedSuccessProbability ?? 0;

    // Penalised intervention must have meaningfully lower effective score
    assert.ok(penSP < unpenSP,
      `penalised SP (${penSP}) must be < unpenalised SP (${unpenSP}) — penalty is not affecting scoreboard`);
    // Verify rerouteCostPenaltiesApplied is the machine-readable counter
    assert.equal(penResult.rerouteCostPenaltiesApplied, 1);
    assert.equal(unpenResult.rerouteCostPenaltiesApplied, 0);
  });
});

// ── specializationContext pass-through ────────────────────────────────────────

describe("runInterventionOptimizer — specializationContext telemetry alignment", () => {
  it("includes specializationContext in result when provided via options", () => {
    const ctx = {
      specializedShare: 0.4,
      minSpecializedShare: 0.35,
      adaptiveMinSpecializedShare: 0.37,
      specializationTargetsMet: true,
    };
    const result = runInterventionOptimizer(
      [makeIntervention()],
      makeBudget(),
      { specializationContext: ctx },
    );
    assert.ok(result.status !== "invalid_input");
    assert.deepEqual((result as any).specializationContext, ctx,
      "specializationContext must be passed through to optimizer result for log alignment");
  });

  it("omits specializationContext from result when not provided", () => {
    const result = runInterventionOptimizer([makeIntervention()], makeBudget());
    assert.ok(!Object.prototype.hasOwnProperty.call(result, "specializationContext"),
      "specializationContext must be absent when not supplied");
  });

  it("negative path: null specializationContext is omitted from result", () => {
    const result = runInterventionOptimizer(
      [makeIntervention()],
      makeBudget(),
      { specializationContext: null },
    );
    assert.ok(!Object.prototype.hasOwnProperty.call(result, "specializationContext"),
      "null specializationContext must not appear in result");
  });
});

// ── buildInterventionsFromPlan: role normalization ────────────────────────────

describe("buildInterventionsFromPlan — role normalization", () => {
  const config = {};

  it("normalizes 'Evolution Worker' to 'evolution-worker'", () => {
    const plans = [{ role: "Evolution Worker", task: "Fix bug", priority: 5, wave: "wave-1" }];
    const result = buildInterventionsFromPlan(plans, config);
    assert.equal(result[0].role, "evolution-worker");
  });

  it("normalizes 'quality-worker' to 'quality-worker' (no change)", () => {
    const plans = [{ role: "quality-worker", task: "Write tests", priority: 5, wave: "wave-1" }];
    const result = buildInterventionsFromPlan(plans, config);
    assert.equal(result[0].role, "quality-worker");
  });

  it("normalizes unregistered role (e.g. 'King David') to 'evolution-worker' fallback", () => {
    const plans = [{ role: "King David", task: "Implement feature", priority: 5, wave: "wave-1" }];
    const result = buildInterventionsFromPlan(plans, config);
    assert.equal(result[0].role, "evolution-worker",
      "unregistered role name must fall back to evolution-worker");
  });

  it("normalizes lane key 'governance' to 'governance-worker'", () => {
    const plans = [{ role: "governance", task: "Review policy", priority: 5, wave: "wave-1" }];
    const result = buildInterventionsFromPlan(plans, config);
    assert.equal(result[0].role, "governance-worker");
  });

  it("normalizes 'infrastructure-worker' correctly", () => {
    const plans = [{ role: "infrastructure-worker", task: "Setup CI", priority: 5, wave: "wave-1" }];
    const result = buildInterventionsFromPlan(plans, config);
    assert.equal(result[0].role, "infrastructure-worker");
  });

  it("handles missing role field — falls back to evolution-worker", () => {
    const plans = [{ task: "Some task", priority: 5, wave: "wave-1" }];
    const result = buildInterventionsFromPlan(plans, config);
    assert.equal(result[0].role, "evolution-worker",
      "missing role must default to evolution-worker, not 'unknown'");
  });

  it("returns correct budget cost and schema shape for normalized roles", () => {
    const plans = [{ role: "quality-worker", task: "Test coverage", priority: 8, wave: "wave-2" }];
    const result = buildInterventionsFromPlan(plans, config);
    assert.equal(result[0].budgetCost, 1);
    assert.equal(result[0].wave, 2);
    assert.ok(Number.isFinite(result[0].successProbability));
  });
});

// ── runInterventionOptimizer applied-counter accounting ───────────────────────

describe("runInterventionOptimizer — applied-counter field names", () => {
  function makeSimpleIntervention(id: string, role: string) {
    return {
      id,
      type: INTERVENTION_TYPE.TASK,
      wave: 1,
      role,
      title: `Task ${id}`,
      successProbability: 0.8,
      impact: 0.9,
      riskCost: 0.2,
      sampleCount: 3,
      budgetCost: 1,
    };
  }

  it("result includes rerouteCostPenaltiesApplied (not reroutteCostPenaltiesApplied typo)", () => {
    const interventions = [makeSimpleIntervention("t1", "evolution-worker")];
    const budget = { maxWorkerSpawns: 5 };
    const result = runInterventionOptimizer(interventions, budget, {
      rerouteReasons: [{ role: "evolution-worker", reasonCode: "fill_threshold" }],
    }) as any;
    assert.ok("rerouteCostPenaltiesApplied" in result,
      "rerouteCostPenaltiesApplied must be a top-level field in optimizer result");
    assert.ok(!("reroutteCostPenaltiesApplied" in result),
      "typo 'reroutteCostPenaltiesApplied' must NOT appear — use rerouteCostPenaltiesApplied");
  });

  it("rerouteCostPenaltiesApplied is 0 when no reroute reasons provided", () => {
    const interventions = [makeSimpleIntervention("t1", "evolution-worker")];
    const budget = { maxWorkerSpawns: 5 };
    const result = runInterventionOptimizer(interventions, budget) as any;
    assert.equal(result.rerouteCostPenaltiesApplied, 0);
  });

  it("rerouteCostPenaltiesApplied is 1 when one role matches reroute history", () => {
    const interventions = [makeSimpleIntervention("t1", "evolution-worker")];
    const budget = { maxWorkerSpawns: 5 };
    const result = runInterventionOptimizer(interventions, budget, {
      rerouteReasons: [{ role: "evolution-worker", reasonCode: "fill_threshold" }],
    }) as any;
    assert.equal(result.rerouteCostPenaltiesApplied, 1);
  });

  it("policyImpactPenaltiesApplied uses correct key (not policyOverridesApplied)", () => {
    const interventions = [makeSimpleIntervention("t1", "evolution-worker")];
    const budget = { maxWorkerSpawns: 5 };
    const result = runInterventionOptimizer(interventions, budget, {
      policyImpactByInterventionId: { "t1": { decayedEffectiveness: 0.5, policyId: "p1", inactiveCycles: 0 } },
    }) as any;
    assert.ok("policyImpactPenaltiesApplied" in result,
      "policyImpactPenaltiesApplied must be a top-level field");
    assert.ok(!("policyOverridesApplied" in result),
      "policyOverridesApplied must NOT appear — use policyImpactPenaltiesApplied");
  });

  it("benchmarkBoostsApplied uses correct key (not benchmarkAdjustmentsApplied)", () => {
    const interventions = [makeSimpleIntervention("t1", "evolution-worker")];
    const budget = { maxWorkerSpawns: 5 };
    const result = runInterventionOptimizer(interventions, budget, {
      benchmarkTelemetry: [{ interventionId: "t1", observedSuccessRate: 0.9, sampleCount: 5 }],
    }) as any;
    assert.ok("benchmarkBoostsApplied" in result,
      "benchmarkBoostsApplied must be a top-level field");
    assert.ok(!("benchmarkAdjustmentsApplied" in result),
      "benchmarkAdjustmentsApplied must NOT appear — use benchmarkBoostsApplied");
  });
});

// ── Task 4: scoreInterventionsAgainstRubric — uplift binding ──────────────────

describe("scoreInterventionsAgainstRubric — uplift binding", () => {
  it("computes combinedScore as weighted blend of rubricScore and outcomeScore", () => {
    const interventions = [{ id: "inv-1" }];
    const rubricByInterventionId = {
      "inv-1": { architecture: 0.8, testCoverage: 0.6 },
    };
    const rows = scoreInterventionsAgainstRubric(interventions, rubricByInterventionId, {
      outcomeByInterventionId: { "inv-1": 0.9 },
      policyByInterventionId:  { "inv-1": "policy-A" },
      cycleId: "test-cycle-1",
    });
    assert.equal(rows.length, 1, "one scored row expected");
    const row = rows[0];
    assert.equal(row.interventionId, "inv-1");
    assert.equal(row.policyId, "policy-A");
    assert.ok(typeof row.rubricScore === "number", "rubricScore must be a number");
    assert.ok(typeof row.outcomeScore === "number", "outcomeScore must be a number");
    assert.ok(typeof row.combinedScore === "number", "combinedScore must be a number");
    // Combined = rubricScore*0.6 + outcomeScore*0.4
    const expectedRubric = (0.8 + 0.6) / 2;
    const expectedCombined = Math.round((expectedRubric * 0.6 + 0.9 * 0.4) * 1000) / 1000;
    assert.equal(row.combinedScore, expectedCombined,
      "combinedScore must equal rubricScore*0.6 + outcomeScore*0.4");
  });

  it("negative path: skips interventions without a policyId", () => {
    const interventions = [{ id: "inv-orphan" }];
    const rubricByInterventionId = { "inv-orphan": { architecture: 0.9 } };
    const rows = scoreInterventionsAgainstRubric(interventions, rubricByInterventionId, {
      outcomeByInterventionId: { "inv-orphan": 1.0 },
      // no policyByInterventionId — no policy binding
    });
    assert.equal(rows.length, 0,
      "interventions without policy binding must be excluded from scored output");
  });

  it("clamps outcomeScore to [0,1] range", () => {
    const interventions = [{ id: "inv-2" }];
    const rows = scoreInterventionsAgainstRubric(interventions, { "inv-2": { quality: 0.8 } }, {
      outcomeByInterventionId: { "inv-2": 1.5 }, // out of range
      policyByInterventionId:  { "inv-2": "policy-B" },
    });
    assert.equal(rows[0].outcomeScore, 1.0, "outcomeScore must be clamped to 1.0 max");
  });
});

// ── applyOverbundleEVPenalty + overbundle admission integration ───────────────
import {
  applyOverbundleEVPenalty,
  OVERBUNDLE_STEPS_THRESHOLD,
  OVERBUNDLE_EV_PENALTY_COEFFICIENT,
} from "../../src/core/intervention_optimizer.js";

describe("applyOverbundleEVPenalty", () => {
  it("returns ev unchanged when stepCount is at or below threshold", () => {
    const ev = 100;
    assert.equal(applyOverbundleEVPenalty(ev, OVERBUNDLE_STEPS_THRESHOLD), ev,
      "EV must not be penalized at exactly the threshold");
    assert.equal(applyOverbundleEVPenalty(ev, OVERBUNDLE_STEPS_THRESHOLD - 1), ev,
      "EV must not be penalized below threshold");
  });

  it("applies EV penalty when stepCount exceeds threshold", () => {
    const ev = 100;
    const overCount = OVERBUNDLE_STEPS_THRESHOLD + 1;
    const penalized = applyOverbundleEVPenalty(ev, overCount);
    assert.ok(penalized < ev, "penalized EV must be less than original EV");
    // Implementation applies a flat multiplier: EV * (1 - OVERBUNDLE_EV_PENALTY_COEFFICIENT)
    const expected = Math.round(ev * (1 - OVERBUNDLE_EV_PENALTY_COEFFICIENT) * 1000) / 1000;
    assert.equal(penalized, expected,
      "penalty must apply flat coefficient: EV * (1 - OVERBUNDLE_EV_PENALTY_COEFFICIENT)");
  });

  it("does not return negative EV (clamps to 0)", () => {
    // Enormous step count — penalty would push below 0
    const ev = 100;
    const massiveCount = OVERBUNDLE_STEPS_THRESHOLD * 100;
    const penalized = applyOverbundleEVPenalty(ev, massiveCount);
    assert.ok(penalized >= 0, "penalized EV must never be negative");
  });

  it("negative path: returns 0 when input ev is 0", () => {
    assert.equal(applyOverbundleEVPenalty(0, OVERBUNDLE_STEPS_THRESHOLD + 5), 0);
  });

  it("returns ev unchanged when stepCount is non-finite", () => {
    const ev = 42;
    assert.equal(applyOverbundleEVPenalty(ev, Number.NaN), ev);
  });
});

describe("runInterventionOptimizer — overbundleStepCounts option", () => {
  it("applies overbundle penalty and increments overbundlePenaltiesApplied counter", () => {
    const intervention = makeIntervention({ id: "big-bundle" });
    const budget = makeBudget();
    const result = runInterventionOptimizer([intervention], budget, {
      overbundleStepCounts: {
        "big-bundle": OVERBUNDLE_STEPS_THRESHOLD + 3
      }
    }) as any;
    assert.ok(result.selected.length >= 0, "result must have selected array");
    assert.ok(typeof result.overbundlePenaltiesApplied === "number",
      "result must include overbundlePenaltiesApplied counter");
    assert.ok(result.overbundlePenaltiesApplied >= 1,
      "overbundlePenaltiesApplied must be >= 1 when an over-threshold bundle exists");
  });

  it("does not apply penalty when step count is at threshold", () => {
    const intervention = makeIntervention({ id: "ok-bundle" });
    const budget = makeBudget();
    const result = runInterventionOptimizer([intervention], budget, {
      overbundleStepCounts: {
        "ok-bundle": OVERBUNDLE_STEPS_THRESHOLD
      }
    }) as any;
    assert.equal(result.overbundlePenaltiesApplied, 0,
      "no penalty should be applied at exactly the threshold");
  });

  it("overbundlePenaltiesApplied is 0 when overbundleStepCounts is not provided", () => {
    const intervention = makeIntervention({ id: "normal" });
    const budget = makeBudget();
    const result = runInterventionOptimizer([intervention], budget, {}) as any;
    assert.equal(result.overbundlePenaltiesApplied, 0);
  });
});

// ── checkOverbundleHardAdmission ─────────────────────────────────────────────

describe("checkOverbundleHardAdmission", () => {
  it("returns blocked=false for empty plans array", () => {
    const r = checkOverbundleHardAdmission([]);
    assert.equal(r.blocked, false);
    assert.equal(r.reason, null);
    assert.deepEqual(r.rejectedIds, []);
  });

  it("returns blocked=false when all plans are within threshold", () => {
    const plans = [
      { id: "P-001", orderedSteps: Array.from({ length: OVERBUNDLE_STEPS_THRESHOLD }, (_, i) => `step-${i}`) },
      { id: "P-002", acceptance_criteria: ["a", "b", "c"] },
    ];
    const r = checkOverbundleHardAdmission(plans);
    assert.equal(r.blocked, false);
    assert.deepEqual(r.rejectedIds, []);
  });

  it("returns blocked=true and identifies rejectedIds for over-threshold plans", () => {
    const overSteps = Array.from({ length: OVERBUNDLE_STEPS_THRESHOLD + 1 }, (_, i) => `step-${i}`);
    const plans = [
      { id: "P-OVER", orderedSteps: overSteps },
      { id: "P-OK",   acceptance_criteria: ["a", "b"] },
    ];
    const r = checkOverbundleHardAdmission(plans);
    assert.equal(r.blocked, true);
    assert.ok(typeof r.reason === "string" && r.reason.length > 0, "reason must be non-empty string");
    assert.deepEqual(r.rejectedIds, ["P-OVER"]);
  });

  it("uses acceptance_criteria length when orderedSteps is absent", () => {
    const overCriteria = Array.from({ length: 12 }, (_, i) => `ac-${i}`);
    const plans = [{ id: "P-AC", acceptance_criteria: overCriteria }];
    const r = checkOverbundleHardAdmission(plans, 10);
    assert.equal(r.blocked, true);
    assert.deepEqual(r.rejectedIds, ["P-AC"]);
  });

  it("uses ordered_steps length when orderedSteps is absent", () => {
    const plans = [{ id: "P-OS", ordered_steps: ["s1", "s2", "s3", "s4"] }];
    const r = checkOverbundleHardAdmission(plans, 3);
    assert.equal(r.blocked, true);
    assert.deepEqual(r.rejectedIds, ["P-OS"]);
  });

  it("uses custom threshold override correctly", () => {
    const plans = [{ id: "P-BIG", orderedSteps: ["s1", "s2", "s3"] }];
    // threshold of 2 → 3 steps should block
    const blocked = checkOverbundleHardAdmission(plans, 2);
    assert.equal(blocked.blocked, true);
    // threshold of 3 → exactly 3 steps should NOT block
    const allowed = checkOverbundleHardAdmission(plans, 3);
    assert.equal(allowed.blocked, false);
  });

  it("generates stable plan index id when plan.id is absent", () => {
    const overSteps = Array.from({ length: 15 }, (_, i) => `s-${i}`);
    const plans = [{ orderedSteps: overSteps }]; // no id field
    const r = checkOverbundleHardAdmission(plans, 9);
    assert.equal(r.blocked, true);
    assert.ok(r.rejectedIds[0].startsWith("plan-idx-"), "must use plan-idx-N fallback id");
  });

  it("generates unique fallback ids for duplicate object references", () => {
    const over = { orderedSteps: Array.from({ length: 11 }, (_, i) => `s-${i}`) };
    const plans = [over, over];
    const r = checkOverbundleHardAdmission(plans, 9);
    assert.equal(r.blocked, true);
    assert.deepEqual(r.rejectedIds, ["plan-idx-0", "plan-idx-1"]);
  });

  it("orderedSteps takes precedence over acceptance_criteria when both fields are present", () => {
    // A plan with orderedSteps (2 items, within cap=3) and acceptance_criteria (5 items, over cap=3).
    // The step count must be derived from orderedSteps, not acceptance_criteria.
    const plan = {
      id: "P-DUAL",
      orderedSteps: ["s1", "s2"],
      acceptance_criteria: ["ac1", "ac2", "ac3", "ac4", "ac5"],
    };
    const r = checkOverbundleHardAdmission([plan], 3);
    assert.equal(r.blocked, false,
      "orderedSteps (2 ≤ 3) must take precedence over acceptance_criteria (5 > 3)");
    assert.deepEqual(r.rejectedIds, []);
  });

  it("plans with zero measurable steps default to 1 and are never blocked by the gate alone", () => {
    // A plan with no orderedSteps, ordered_steps, acceptance_criteria, or plans field
    // has an inferred step count of 1 — it must not be blocked at threshold ≥ 1.
    const plan = { id: "P-EMPTY", task: "empty" };
    const r = checkOverbundleHardAdmission([plan], OVERBUNDLE_STEPS_THRESHOLD);
    assert.equal(r.blocked, false,
      "plan with no step fields must default to 1 step and not be blocked");
  });

  it("NEGATIVE PATH: returns blocked=true when a named plan id exceeds threshold", () => {
    const plan = {
      id: "P-NAMED-OVER",
      orderedSteps: Array.from({ length: OVERBUNDLE_STEPS_THRESHOLD + 2 }, (_, i) => `step-${i}`),
    };
    const r = checkOverbundleHardAdmission([plan]);
    assert.equal(r.blocked, true);
    assert.deepEqual(r.rejectedIds, ["P-NAMED-OVER"],
      "rejected plan must be identified by its id field");
    assert.ok(
      typeof r.reason === "string" && r.reason.includes("P-NAMED-OVER"),
      "reason must reference the rejected plan id",
    );
  });
});
