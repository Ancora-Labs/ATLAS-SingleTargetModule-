/**
 * failure_classifier.test.ts
 *
 * Tests for the semantic failure taxonomy classifier.
 *
 * Coverage:
 *   - Schema exports: FAILURE_CLASS, FAILURE_CLASSIFIER_SCHEMA_VERSION,
 *     CLASSIFIER_TAXONOMY_VERSION, LOW_CONFIDENCE_THRESHOLD, CLASSIFIER_REASON_CODE,
 *     EVIDENCE_SCHEMA, CLASSIFICATION_RESULT_SCHEMA, VALID_WORKER_STATUSES,
 *     FAILURE_CLASS_SP_ADJUSTMENT, SP_ADJUSTMENT_FLOOR, LOW_CONFIDENCE_SP_PENALTY
 *   - validateClassifierInput: MISSING_INPUT, INVALID_TYPE, MISSING_FIELD, INVALID_FIELD
 *   - classifyFailure: all six failure classes, confidence values, flagged logic,
 *     evidence schema, negative paths
 *   - applyClassificationToSuccessProbability: all six classes, floor, flagged penalty
 *   - runInterventionOptimizer with failureClassifications option (AC #5)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  FAILURE_CLASS,
  FAILURE_CLASSIFIER_SCHEMA_VERSION,
  CLASSIFIER_TAXONOMY_VERSION,
  LOW_CONFIDENCE_THRESHOLD,
  CLASSIFIER_REASON_CODE,
  EVIDENCE_SCHEMA,
  CLASSIFICATION_RESULT_SCHEMA,
  VALID_WORKER_STATUSES,
  FAILURE_CLASS_SP_ADJUSTMENT,
  SP_ADJUSTMENT_FLOOR,
  LOW_CONFIDENCE_SP_PENALTY,
  validateClassifierInput,
  classifyFailure,
  applyClassificationToSuccessProbability,
} from "../../src/core/failure_classifier.js";

import {
  runInterventionOptimizer,
  INTERVENTION_TYPE,
  OPTIMIZER_STATUS,
} from "../../src/core/intervention_optimizer.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeClassification(overrides = {}) {
  return {
    schemaVersion:     FAILURE_CLASSIFIER_SCHEMA_VERSION,
    classifierVersion: CLASSIFIER_TAXONOMY_VERSION,
    taskId:            null,
    primaryClass:      FAILURE_CLASS.LOGIC_DEFECT,
    confidence:        0.55,
    flagged:           false,
    evidence: {
      error_message:         "some error",
      stack_trace:           "",
      log_lines:             [],
      blocking_reason_class: null,
      worker_status:         "error",
    },
    classifiedAt: new Date().toISOString(),
    ...overrides,
  };
}

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

// ── Schema export tests ───────────────────────────────────────────────────────

describe("FAILURE_CLASS enum", () => {
  it("is frozen and contains exactly six values", () => {
    assert.ok(Object.isFrozen(FAILURE_CLASS));
    const values = Object.values(FAILURE_CLASS);
    assert.equal(values.length, 6);
    assert.ok(values.includes("environment"));
    assert.ok(values.includes("policy"));
    assert.ok(values.includes("verification"));
    assert.ok(values.includes("model"));
    assert.ok(values.includes("external_api"));
    assert.ok(values.includes("logic_defect"));
  });
});

describe("LOW_CONFIDENCE_THRESHOLD", () => {
  it("is exactly 0.6", () => {
    assert.equal(LOW_CONFIDENCE_THRESHOLD, 0.6);
  });

  it("classifyFailure sets flagged=true when confidence < 0.6", () => {
    // Tier 3 fallback produces confidence 0.45 — below threshold
    const res = classifyFailure({ workerStatus: "error" });
    assert.ok(res.ok);
    assert.ok(res.classification.confidence < LOW_CONFIDENCE_THRESHOLD);
    assert.equal(res.classification.flagged, true);
  });

  it("classifyFailure sets flagged=false when confidence >= 0.6", () => {
    const res = classifyFailure({
      workerStatus: "blocked",
      blockingReasonClass: "POLICY_VIOLATION",
    });
    assert.ok(res.ok);
    assert.ok(res.classification.confidence >= LOW_CONFIDENCE_THRESHOLD);
    assert.equal(res.classification.flagged, false);
  });
});

describe("FAILURE_CLASSIFIER_SCHEMA_VERSION", () => {
  it("is the integer 1", () => {
    assert.equal(FAILURE_CLASSIFIER_SCHEMA_VERSION, 1);
    assert.equal(typeof FAILURE_CLASSIFIER_SCHEMA_VERSION, "number");
  });
});

describe("CLASSIFIER_TAXONOMY_VERSION", () => {
  it("is a non-empty string", () => {
    assert.equal(typeof CLASSIFIER_TAXONOMY_VERSION, "string");
    assert.ok(CLASSIFIER_TAXONOMY_VERSION.length > 0);
    assert.equal(CLASSIFIER_TAXONOMY_VERSION, "1.0.0");
  });
});

describe("CLASSIFIER_REASON_CODE enum", () => {
  it("is frozen and has all required codes", () => {
    assert.ok(Object.isFrozen(CLASSIFIER_REASON_CODE));
    assert.equal(CLASSIFIER_REASON_CODE.MISSING_INPUT, "MISSING_INPUT");
    assert.equal(CLASSIFIER_REASON_CODE.INVALID_TYPE,  "INVALID_TYPE");
    assert.equal(CLASSIFIER_REASON_CODE.MISSING_FIELD, "MISSING_FIELD");
    assert.equal(CLASSIFIER_REASON_CODE.INVALID_FIELD, "INVALID_FIELD");
  });
});

describe("EVIDENCE_SCHEMA", () => {
  it("is frozen and has exactly five required fields", () => {
    assert.ok(Object.isFrozen(EVIDENCE_SCHEMA));
    assert.ok(EVIDENCE_SCHEMA.required.includes("error_message"));
    assert.ok(EVIDENCE_SCHEMA.required.includes("stack_trace"));
    assert.ok(EVIDENCE_SCHEMA.required.includes("log_lines"));
    assert.ok(EVIDENCE_SCHEMA.required.includes("blocking_reason_class"));
    assert.ok(EVIDENCE_SCHEMA.required.includes("worker_status"));
    assert.equal(EVIDENCE_SCHEMA.required.length, 5);
  });
});

describe("CLASSIFICATION_RESULT_SCHEMA", () => {
  it("is frozen and enumerates all required fields", () => {
    assert.ok(Object.isFrozen(CLASSIFICATION_RESULT_SCHEMA));
    for (const f of ["schemaVersion", "classifierVersion", "taskId", "primaryClass",
                      "confidence", "flagged", "evidence", "classifiedAt"]) {
      assert.ok(CLASSIFICATION_RESULT_SCHEMA.required.includes(f), `missing field: ${f}`);
    }
  });

  it("primaryClassEnum matches FAILURE_CLASS values", () => {
    const expected = Object.values(FAILURE_CLASS).sort();
    const actual = [...CLASSIFICATION_RESULT_SCHEMA.primaryClassEnum].sort();
    assert.deepEqual(actual, expected);
  });

  it("confidenceRange is {min:0, max:1}", () => {
    assert.equal(CLASSIFICATION_RESULT_SCHEMA.confidenceRange.min, 0.0);
    assert.equal(CLASSIFICATION_RESULT_SCHEMA.confidenceRange.max, 1.0);
  });
});

describe("VALID_WORKER_STATUSES", () => {
  it("is frozen and contains error, blocked, partial, done", () => {
    assert.ok(Object.isFrozen(VALID_WORKER_STATUSES));
    assert.ok(VALID_WORKER_STATUSES.includes("error"));
    assert.ok(VALID_WORKER_STATUSES.includes("blocked"));
    assert.ok(VALID_WORKER_STATUSES.includes("partial"));
    assert.ok(VALID_WORKER_STATUSES.includes("done"));
  });
});

describe("FAILURE_CLASS_SP_ADJUSTMENT", () => {
  it("is frozen and has an entry for every FAILURE_CLASS value", () => {
    assert.ok(Object.isFrozen(FAILURE_CLASS_SP_ADJUSTMENT));
    for (const cls of Object.values(FAILURE_CLASS)) {
      assert.ok(FAILURE_CLASS_SP_ADJUSTMENT[cls], `missing adjustment for class: ${cls}`);
    }
  });

  it("each entry has type and value", () => {
    for (const [cls, rule] of Object.entries(FAILURE_CLASS_SP_ADJUSTMENT)) {
      assert.ok(["subtract", "multiply"].includes(rule.type), `class ${cls}: invalid type`);
      assert.equal(typeof rule.value, "number");
      assert.ok(rule.value > 0 && rule.value <= 1, `class ${cls}: value out of range`);
    }
  });
});

describe("SP_ADJUSTMENT_FLOOR and LOW_CONFIDENCE_SP_PENALTY", () => {
  it("SP_ADJUSTMENT_FLOOR is 0.05", () => {
    assert.equal(SP_ADJUSTMENT_FLOOR, 0.05);
  });

  it("LOW_CONFIDENCE_SP_PENALTY is 0.05", () => {
    assert.equal(LOW_CONFIDENCE_SP_PENALTY, 0.05);
  });
});

// ── validateClassifierInput ───────────────────────────────────────────────────

describe("validateClassifierInput — MISSING_INPUT", () => {
  it("returns MISSING_INPUT for null", () => {
    const r = validateClassifierInput(null);
    assert.equal(r.ok, false);
    assert.equal(r.code, CLASSIFIER_REASON_CODE.MISSING_INPUT);
  });

  it("returns MISSING_INPUT for undefined", () => {
    const r = validateClassifierInput(undefined);
    assert.equal(r.ok, false);
    assert.equal(r.code, CLASSIFIER_REASON_CODE.MISSING_INPUT);
  });
});

describe("validateClassifierInput — INVALID_TYPE", () => {
  it("returns INVALID_TYPE for a string", () => {
    const r = validateClassifierInput("error");
    assert.equal(r.ok, false);
    assert.equal(r.code, CLASSIFIER_REASON_CODE.INVALID_TYPE);
  });

  it("returns INVALID_TYPE for an array", () => {
    const r = validateClassifierInput(["error"]);
    assert.equal(r.ok, false);
    assert.equal(r.code, CLASSIFIER_REASON_CODE.INVALID_TYPE);
  });
});

describe("validateClassifierInput — MISSING_FIELD", () => {
  it("returns MISSING_FIELD when workerStatus is absent", () => {
    const r = validateClassifierInput({ errorMessage: "bad" });
    assert.equal(r.ok, false);
    assert.equal(r.code, CLASSIFIER_REASON_CODE.MISSING_FIELD);
    assert.equal(r.field, "workerStatus");
  });
});

describe("validateClassifierInput — INVALID_FIELD", () => {
  it("returns INVALID_FIELD when workerStatus is empty string", () => {
    const r = validateClassifierInput({ workerStatus: "" });
    assert.equal(r.ok, false);
    assert.equal(r.code, CLASSIFIER_REASON_CODE.INVALID_FIELD);
    assert.equal(r.field, "workerStatus");
  });

  it("returns INVALID_FIELD when workerStatus is not a string", () => {
    const r = validateClassifierInput({ workerStatus: 42 });
    assert.equal(r.ok, false);
    assert.equal(r.code, CLASSIFIER_REASON_CODE.INVALID_FIELD);
    assert.equal(r.field, "workerStatus");
  });
});

describe("validateClassifierInput — valid input", () => {
  it("returns ok=true for minimal valid input", () => {
    const r = validateClassifierInput({ workerStatus: "error" });
    assert.equal(r.ok, true);
    assert.equal(r.code, null);
  });

  it("returns ok=true for full input", () => {
    const r = validateClassifierInput({
      workerStatus: "blocked",
      blockingReasonClass: "POLICY_VIOLATION",
      errorMessage: "access denied",
      stackTrace: "Error at line 1",
      logLines: ["log1"],
      taskId: "T-001",
    });
    assert.equal(r.ok, true);
  });
});

// ── classifyFailure ───────────────────────────────────────────────────────────

describe("classifyFailure — negative paths (invalid input)", () => {
  it("returns ok=false for null input", () => {
    const r = classifyFailure(null);
    assert.equal(r.ok, false);
    assert.equal(r.code, CLASSIFIER_REASON_CODE.MISSING_INPUT);
  });

  it("returns ok=false for missing workerStatus", () => {
    const r = classifyFailure({ errorMessage: "failed" });
    assert.equal(r.ok, false);
    assert.equal(r.code, CLASSIFIER_REASON_CODE.MISSING_FIELD);
    assert.equal(r.field, "workerStatus");
  });

  it("returns ok=false for invalid workerStatus type", () => {
    const r = classifyFailure({ workerStatus: null });
    assert.equal(r.ok, false);
    assert.equal(r.code, CLASSIFIER_REASON_CODE.INVALID_FIELD);
  });
});

describe("classifyFailure — output schema", () => {
  it("returned classification has all required CLASSIFICATION_RESULT_SCHEMA fields", () => {
    const r = classifyFailure({ workerStatus: "error" });
    assert.ok(r.ok);
    for (const field of CLASSIFICATION_RESULT_SCHEMA.required) {
      assert.ok(field in r.classification, `missing field: ${field}`);
    }
  });

  it("evidence object has all required EVIDENCE_SCHEMA fields", () => {
    const r = classifyFailure({ workerStatus: "blocked", errorMessage: "fail" });
    assert.ok(r.ok);
    for (const field of EVIDENCE_SCHEMA.required) {
      assert.ok(field in r.classification.evidence, `missing evidence field: ${field}`);
    }
  });

  it("schemaVersion equals FAILURE_CLASSIFIER_SCHEMA_VERSION", () => {
    const r = classifyFailure({ workerStatus: "error" });
    assert.ok(r.ok);
    assert.equal(r.classification.schemaVersion, FAILURE_CLASSIFIER_SCHEMA_VERSION);
  });

  it("classifierVersion equals CLASSIFIER_TAXONOMY_VERSION", () => {
    const r = classifyFailure({ workerStatus: "error" });
    assert.ok(r.ok);
    assert.equal(r.classification.classifierVersion, CLASSIFIER_TAXONOMY_VERSION);
  });

  it("primaryClass is one of FAILURE_CLASS values", () => {
    const r = classifyFailure({ workerStatus: "error" });
    assert.ok(r.ok);
    assert.ok(Object.values(FAILURE_CLASS).includes(r.classification.primaryClass));
  });

  it("confidence is a number in [0.0, 1.0]", () => {
    const r = classifyFailure({ workerStatus: "error" });
    assert.ok(r.ok);
    assert.ok(r.classification.confidence >= 0.0 && r.classification.confidence <= 1.0);
  });

  it("classifiedAt is a parseable ISO timestamp", () => {
    const r = classifyFailure({ workerStatus: "error" });
    assert.ok(r.ok);
    assert.ok(!isNaN(Date.parse(r.classification.classifiedAt)));
  });

  it("log_lines is capped at 10 entries", () => {
    const logLines = Array.from({ length: 15 }, (_, i) => `line ${i}`);
    const r = classifyFailure({ workerStatus: "error", logLines });
    assert.ok(r.ok);
    assert.ok(r.classification.evidence.log_lines.length <= 10);
  });

  it("taskId is set when provided", () => {
    const r = classifyFailure({ workerStatus: "error", taskId: "T-025" });
    assert.ok(r.ok);
    assert.equal(r.classification.taskId, "T-025");
  });

  it("taskId is null when not provided", () => {
    const r = classifyFailure({ workerStatus: "error" });
    assert.ok(r.ok);
    assert.equal(r.classification.taskId, null);
  });
});

describe("classifyFailure — POLICY_VIOLATION blockingReasonClass", () => {
  it("classifies as policy with confidence 0.95", () => {
    const r = classifyFailure({
      workerStatus: "blocked",
      blockingReasonClass: "POLICY_VIOLATION",
    });
    assert.ok(r.ok);
    assert.equal(r.classification.primaryClass, FAILURE_CLASS.POLICY);
    assert.equal(r.classification.confidence, 0.95);
    assert.equal(r.classification.flagged, false);
  });
});

describe("classifyFailure — ACCESS_BLOCKED blockingReasonClass", () => {
  it("classifies as policy with confidence 0.90", () => {
    const r = classifyFailure({
      workerStatus: "blocked",
      blockingReasonClass: "ACCESS_BLOCKED",
    });
    assert.ok(r.ok);
    assert.equal(r.classification.primaryClass, FAILURE_CLASS.POLICY);
    assert.equal(r.classification.confidence, 0.90);
  });
});

describe("classifyFailure — VERIFICATION_GATE blockingReasonClass", () => {
  it("classifies as verification with confidence 0.90", () => {
    const r = classifyFailure({
      workerStatus: "blocked",
      blockingReasonClass: "VERIFICATION_GATE",
    });
    assert.ok(r.ok);
    assert.equal(r.classification.primaryClass, FAILURE_CLASS.VERIFICATION);
    assert.equal(r.classification.confidence, 0.90);
  });
});

describe("classifyFailure — MAX_REWORK_EXHAUSTED blockingReasonClass", () => {
  it("classifies as verification with confidence 0.85", () => {
    const r = classifyFailure({
      workerStatus: "blocked",
      blockingReasonClass: "MAX_REWORK_EXHAUSTED",
    });
    assert.ok(r.ok);
    assert.equal(r.classification.primaryClass, FAILURE_CLASS.VERIFICATION);
    assert.equal(r.classification.confidence, 0.85);
  });
});

describe("classifyFailure — WORKER_ERROR with timeout", () => {
  it("classifies as environment when error message contains timeout", () => {
    const r = classifyFailure({
      workerStatus: "error",
      blockingReasonClass: "WORKER_ERROR",
      errorMessage: "Process timed out after 45 minutes",
    });
    assert.ok(r.ok);
    assert.equal(r.classification.primaryClass, FAILURE_CLASS.ENVIRONMENT);
    assert.equal(r.classification.confidence, 0.80);
  });
});

describe("classifyFailure — WORKER_ERROR with rate limit", () => {
  it("classifies as model when error contains rate limit", () => {
    const r = classifyFailure({
      workerStatus: "error",
      blockingReasonClass: "WORKER_ERROR",
      errorMessage: "rate limit exceeded for this model",
    });
    assert.ok(r.ok);
    assert.equal(r.classification.primaryClass, FAILURE_CLASS.MODEL);
    assert.equal(r.classification.confidence, 0.85);
  });
});

describe("classifyFailure — WORKER_ERROR with HTTP 4xx", () => {
  it("classifies as external_api when error contains HTTP 404", () => {
    const r = classifyFailure({
      workerStatus: "error",
      blockingReasonClass: "WORKER_ERROR",
      errorMessage: "GitHub API returned HTTP 404 not found",
    });
    assert.ok(r.ok);
    assert.equal(r.classification.primaryClass, FAILURE_CLASS.EXTERNAL_API);
    assert.equal(r.classification.confidence, 0.75);
  });
});

describe("classifyFailure — WORKER_ERROR generic (logic defect fallback)", () => {
  it("classifies as logic_defect with confidence 0.55", () => {
    const r = classifyFailure({
      workerStatus: "error",
      blockingReasonClass: "WORKER_ERROR",
      errorMessage: "unexpected error in the code",
    });
    assert.ok(r.ok);
    assert.equal(r.classification.primaryClass, FAILURE_CLASS.LOGIC_DEFECT);
    assert.equal(r.classification.confidence, 0.55);
    // 0.55 < 0.6 → flagged
    assert.equal(r.classification.flagged, true);
  });
});

describe("classifyFailure — pattern matching (no blockingReasonClass)", () => {
  it("classifies as model when error mentions rate limit (no rc)", () => {
    const r = classifyFailure({
      workerStatus: "error",
      errorMessage: "Too many requests — rate limit hit",
    });
    assert.ok(r.ok);
    assert.equal(r.classification.primaryClass, FAILURE_CLASS.MODEL);
  });

  it("classifies as environment on timeout pattern (no rc)", () => {
    const r = classifyFailure({
      workerStatus: "error",
      errorMessage: "ETIMEDOUT connecting to host",
    });
    assert.ok(r.ok);
    assert.equal(r.classification.primaryClass, FAILURE_CLASS.ENVIRONMENT);
  });

  it("classifies as external_api on API error pattern (no rc)", () => {
    const r = classifyFailure({
      workerStatus: "error",
      errorMessage: "API error: HTTP 503 from upstream",
    });
    assert.ok(r.ok);
    assert.equal(r.classification.primaryClass, FAILURE_CLASS.EXTERNAL_API);
  });
});

describe("classifyFailure — workerStatus fallback (no rc, no pattern)", () => {
  it("classifies as logic_defect confidence 0.50 for blocked status", () => {
    const r = classifyFailure({ workerStatus: "blocked" });
    assert.ok(r.ok);
    assert.equal(r.classification.primaryClass, FAILURE_CLASS.LOGIC_DEFECT);
    assert.equal(r.classification.confidence, 0.50);
    assert.equal(r.classification.flagged, true);
  });

  it("classifies as logic_defect confidence 0.45 for error status", () => {
    const r = classifyFailure({ workerStatus: "error" });
    assert.ok(r.ok);
    assert.equal(r.classification.primaryClass, FAILURE_CLASS.LOGIC_DEFECT);
    assert.equal(r.classification.confidence, 0.45);
    assert.equal(r.classification.flagged, true);
  });
});

describe("classifyFailure — evidence fields sourced correctly", () => {
  it("evidence.blocking_reason_class matches input.blockingReasonClass", () => {
    const r = classifyFailure({
      workerStatus: "blocked",
      blockingReasonClass: "POLICY_VIOLATION",
    });
    assert.ok(r.ok);
    assert.equal(r.classification.evidence.blocking_reason_class, "POLICY_VIOLATION");
  });

  it("evidence.worker_status matches input.workerStatus", () => {
    const r = classifyFailure({ workerStatus: "partial" });
    assert.ok(r.ok);
    assert.equal(r.classification.evidence.worker_status, "partial");
  });

  it("evidence.error_message is empty string when not provided", () => {
    const r = classifyFailure({ workerStatus: "error" });
    assert.ok(r.ok);
    assert.equal(r.classification.evidence.error_message, "");
  });

  it("evidence.blocking_reason_class is null when not provided", () => {
    const r = classifyFailure({ workerStatus: "error" });
    assert.ok(r.ok);
    assert.equal(r.classification.evidence.blocking_reason_class, null);
  });
});

// ── applyClassificationToSuccessProbability ───────────────────────────────────

describe("applyClassificationToSuccessProbability — policy class", () => {
  it("applies multiply adjustment (policy: sp * 0.20)", () => {
    const classification = makeClassification({ primaryClass: FAILURE_CLASS.POLICY, flagged: false });
    const result = applyClassificationToSuccessProbability(0.8, classification);
    // 0.8 * 0.20 = 0.16 → above floor
    assert.ok(Math.abs(result - 0.16) < 1e-10);
  });
});

describe("applyClassificationToSuccessProbability — verification class", () => {
  it("applies subtract adjustment (verification: sp - 0.20)", () => {
    const classification = makeClassification({ primaryClass: FAILURE_CLASS.VERIFICATION, flagged: false });
    const result = applyClassificationToSuccessProbability(0.8, classification);
    // 0.8 - 0.20 = 0.60
    assert.ok(Math.abs(result - 0.60) < 1e-10);
  });
});

describe("applyClassificationToSuccessProbability — environment class", () => {
  it("applies subtract adjustment (environment: sp - 0.15)", () => {
    const classification = makeClassification({ primaryClass: FAILURE_CLASS.ENVIRONMENT, flagged: false });
    const result = applyClassificationToSuccessProbability(0.5, classification);
    // 0.5 - 0.15 = 0.35
    assert.ok(Math.abs(result - 0.35) < 1e-10);
  });
});

describe("applyClassificationToSuccessProbability — logic_defect class", () => {
  it("applies multiply adjustment (logic_defect: sp * 0.25)", () => {
    const classification = makeClassification({ primaryClass: FAILURE_CLASS.LOGIC_DEFECT, flagged: false });
    const result = applyClassificationToSuccessProbability(0.8, classification);
    // 0.8 * 0.25 = 0.20 → above floor
    assert.ok(Math.abs(result - 0.20) < 1e-10);
  });
});

describe("applyClassificationToSuccessProbability — floor", () => {
  it("never returns below SP_ADJUSTMENT_FLOOR (0.05)", () => {
    const classification = makeClassification({ primaryClass: FAILURE_CLASS.POLICY, flagged: false });
    // 0.01 * 0.20 = 0.002 → floored at 0.05
    const result = applyClassificationToSuccessProbability(0.01, classification);
    assert.equal(result, SP_ADJUSTMENT_FLOOR);
  });
});

describe("applyClassificationToSuccessProbability — low-confidence penalty", () => {
  it("applies additional -0.05 when flagged=true", () => {
    const classification = makeClassification({ primaryClass: FAILURE_CLASS.VERIFICATION, flagged: true });
    const baseline = applyClassificationToSuccessProbability(0.8, makeClassification({ primaryClass: FAILURE_CLASS.VERIFICATION, flagged: false }));
    const penalised = applyClassificationToSuccessProbability(0.8, classification);
    // penalised should be baseline - LOW_CONFIDENCE_SP_PENALTY
    assert.ok(Math.abs(penalised - (baseline - LOW_CONFIDENCE_SP_PENALTY)) < 1e-10);
  });

  it("still respects floor even with low-confidence penalty", () => {
    const classification = makeClassification({ primaryClass: FAILURE_CLASS.LOGIC_DEFECT, flagged: true });
    const result = applyClassificationToSuccessProbability(0.001, classification);
    assert.equal(result, SP_ADJUSTMENT_FLOOR);
  });
});

describe("applyClassificationToSuccessProbability — invalid inputs", () => {
  it("returns SP_ADJUSTMENT_FLOOR when successProbability is NaN", () => {
    const classification = makeClassification({ primaryClass: FAILURE_CLASS.VERIFICATION });
    const result = applyClassificationToSuccessProbability(NaN, classification);
    assert.equal(result, SP_ADJUSTMENT_FLOOR);
  });

  it("returns sp unchanged when classification has unknown primaryClass", () => {
    const classification = makeClassification({ primaryClass: "unknown_class" });
    const result = applyClassificationToSuccessProbability(0.7, classification);
    assert.equal(result, 0.7);
  });
});

// ── runInterventionOptimizer with failureClassifications (AC #5) ──────────────

describe("runInterventionOptimizer — failureClassifications option (AC #5)", () => {
  const budget = { maxWorkerSpawns: 5 };

  it("adjusts successProbability for matching role before ranking", () => {
    const interventions = [
      makeIntervention({ id: "i-policy", role: "policy-worker", successProbability: 0.8, impact: 0.9 }),
      makeIntervention({ id: "i-clean",  role: "clean-worker",  successProbability: 0.8, impact: 0.9 }),
    ];

    // Provide a policy classification for policy-worker → SP should be reduced
    const policyClassification = makeClassification({ primaryClass: FAILURE_CLASS.POLICY, flagged: false });
    const result = runInterventionOptimizer(interventions, budget, {
      failureClassifications: { "policy-worker": policyClassification }
    });

    assert.equal(result.status, OPTIMIZER_STATUS.OK);
    // failureClassificationsApplied should be 1 (only one role matched)
    assert.equal(result.failureClassificationsApplied, 1);

    // The clean-worker should now have a higher successProbability → ranked first
    assert.ok(result.selected.length === 2);
    assert.equal(result.selected[0].role, "clean-worker");
    assert.equal(result.selected[1].role, "policy-worker");
  });

  it("failureClassificationsApplied is 0 when no classifications match", () => {
    const interventions = [makeIntervention({ id: "i-001", role: "backend" })];
    const result = runInterventionOptimizer(interventions, budget, {
      failureClassifications: { "frontend": makeClassification({ primaryClass: FAILURE_CLASS.LOGIC_DEFECT }) }
    });
    assert.equal(result.failureClassificationsApplied, 0);
  });

  it("works normally without failureClassifications option", () => {
    const interventions = [makeIntervention({ id: "i-001" })];
    const result = runInterventionOptimizer(interventions, budget);
    assert.equal(result.status, OPTIMIZER_STATUS.OK);
    assert.equal(result.failureClassificationsApplied, 0);
  });

  it("works normally when failureClassifications option is empty object", () => {
    const interventions = [makeIntervention({ id: "i-001" })];
    const result = runInterventionOptimizer(interventions, budget, { failureClassifications: {} });
    assert.equal(result.status, OPTIMIZER_STATUS.OK);
    assert.equal(result.failureClassificationsApplied, 0);
  });

  it("works normally when failureClassifications option is null", () => {
    const interventions = [makeIntervention({ id: "i-001" })];
    const result = runInterventionOptimizer(interventions, budget, { failureClassifications: null });
    assert.equal(result.status, OPTIMIZER_STATUS.OK);
  });

  it("logic_defect classification significantly reduces EV and SP", () => {
    const interventions = [
      makeIntervention({ id: "i-defect", role: "defect-worker", successProbability: 0.8 }),
      makeIntervention({ id: "i-clean",  role: "clean-worker",  successProbability: 0.8 }),
    ];
    const defectClassification = makeClassification({ primaryClass: FAILURE_CLASS.LOGIC_DEFECT, flagged: true });
    const result = runInterventionOptimizer(interventions, { maxWorkerSpawns: 1 }, {
      failureClassifications: { "defect-worker": defectClassification }
    });
    // Only 1 spawn budget — clean-worker should win
    assert.equal(result.selected.length, 1);
    assert.equal(result.selected[0].role, "clean-worker");
    assert.equal(result.rejected[0].role, "defect-worker");
  });
});

// ── normalizeRoleKey ──────────────────────────────────────────────────────────

import { normalizeRoleKey } from "../../src/core/failure_classifier.js";

describe("normalizeRoleKey", () => {
  it("lowercases uppercase role names", () => {
    assert.equal(normalizeRoleKey("EVOLUTION_WORKER"), "evolution_worker");
  });

  it("replaces spaces with hyphens", () => {
    assert.equal(normalizeRoleKey("Evolution Worker"), "evolution-worker");
  });

  it("collapses multiple spaces to a single hyphen", () => {
    assert.equal(normalizeRoleKey("Evolution  Worker"), "evolution-worker");
  });

  it("trims leading and trailing whitespace", () => {
    assert.equal(normalizeRoleKey("  backend-worker  "), "backend-worker");
  });

  it("handles already-normalized keys unchanged", () => {
    assert.equal(normalizeRoleKey("evolution-worker"), "evolution-worker");
  });

  it("handles empty string without throwing", () => {
    assert.equal(normalizeRoleKey(""), "");
  });

  it("returns empty string for null/undefined coercion", () => {
    assert.equal(normalizeRoleKey(null as any), "");
    assert.equal(normalizeRoleKey(undefined as any), "");
  });

  it("normalizes mixed case and spaces correctly", () => {
    assert.equal(normalizeRoleKey("CI Fix Worker"), "ci-fix-worker");
  });
});

describe("loadRecentFailureClassifications — normalized role key lookup", () => {
  async function makeTempDir2(): Promise<string> {
    const dir = path.join(os.tmpdir(), `fc-norm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  it("normalizes keys: 'Evolution Worker' and 'evolution-worker' resolve to same entry", async () => {
    const dir = await makeTempDir2();
    const classification = makeClassification({ primaryClass: FAILURE_CLASS.LOGIC_DEFECT });
    // persist with space-format role
    await persistFailureClassification(dir, "Evolution Worker", classification);

    const loaded = await loadRecentFailureClassifications(dir);
    // normalized key should be "evolution-worker"
    assert.ok("evolution-worker" in loaded, "should be keyed by normalized role");
    assert.equal((loaded["evolution-worker"] as any).primaryClass, FAILURE_CLASS.LOGIC_DEFECT);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("later entry with different casing overrides earlier entry for same normalized key", async () => {
    const dir = await makeTempDir2();
    const first  = makeClassification({ primaryClass: FAILURE_CLASS.LOGIC_DEFECT });
    const second = makeClassification({ primaryClass: FAILURE_CLASS.POLICY });
    await persistFailureClassification(dir, "evolution worker", first);
    await persistFailureClassification(dir, "Evolution Worker", second);

    const loaded = await loadRecentFailureClassifications(dir);
    const key = "evolution-worker";
    assert.ok(key in loaded);
    assert.equal((loaded[key] as any).primaryClass, FAILURE_CLASS.POLICY);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("optimizer failureClassifications lookup matches normalized key", () => {
    // Simulates the optimizer scenario: classification stored under normalized key,
    // looked up with space-variant role (normalized by optimizer before lookup).
    const interventions = [
      makeIntervention({ id: "i-ew", role: "Evolution Worker", successProbability: 0.8, impact: 0.9 }),
      makeIntervention({ id: "i-clean", role: "clean-worker", successProbability: 0.8, impact: 0.9 }),
    ];
    const policyClassification = makeClassification({ primaryClass: FAILURE_CLASS.POLICY, flagged: false });
    const result = runInterventionOptimizer(interventions, { maxWorkerSpawns: 2 }, {
      failureClassifications: { "evolution-worker": policyClassification },
    });
    assert.equal(result.status, OPTIMIZER_STATUS.OK);
    // "evolution-worker" normalized key should match "Evolution Worker" role → SP reduced
    assert.equal(result.failureClassificationsApplied, 1);
    // clean-worker should rank higher (no SP penalty)
    assert.equal(result.selected[0].role, "clean-worker");
  });
});

import { loadRecentFailureClassifications, persistFailureClassification } from "../../src/core/failure_classifier.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

describe("persistFailureClassification + loadRecentFailureClassifications", () => {
  async function makeTempDir(): Promise<string> {
    const dir = path.join(os.tmpdir(), `fc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  it("returns empty object when JSONL file does not exist", async () => {
    const dir = await makeTempDir();
    const result = await loadRecentFailureClassifications(dir);
    assert.deepEqual(result, {});
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("persists a classification and loads it back", async () => {
    const dir = await makeTempDir();
    const classification = makeClassification({ primaryClass: FAILURE_CLASS.LOGIC_DEFECT });
    await persistFailureClassification(dir, "my-worker", classification);

    const loaded = await loadRecentFailureClassifications(dir);
    assert.ok(typeof loaded["my-worker"] === "object", "classification should be keyed by role");
    assert.equal((loaded["my-worker"] as any).primaryClass, FAILURE_CLASS.LOGIC_DEFECT);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("later entry for same role overrides earlier entry", async () => {
    const dir = await makeTempDir();
    const first  = makeClassification({ primaryClass: FAILURE_CLASS.LOGIC_DEFECT });
    const second = makeClassification({ primaryClass: FAILURE_CLASS.RESOURCE_EXHAUSTION });
    await persistFailureClassification(dir, "worker-a", first);
    await persistFailureClassification(dir, "worker-a", second);

    const loaded = await loadRecentFailureClassifications(dir);
    assert.equal((loaded["worker-a"] as any).primaryClass, FAILURE_CLASS.RESOURCE_EXHAUSTION);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("respects the limit parameter", async () => {
    const dir = await makeTempDir();
    // Write 5 records for different roles
    for (let i = 0; i < 5; i++) {
      await persistFailureClassification(dir, `role-${i}`, makeClassification());
    }
    // Load with limit=2 — only last 2 records (role-3, role-4)
    const loaded = await loadRecentFailureClassifications(dir, 2);
    const keys = Object.keys(loaded);
    assert.equal(keys.length, 2);
    assert.ok(keys.includes("role-3"));
    assert.ok(keys.includes("role-4"));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns empty object on corrupted JSONL lines (partial parse)", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "worker_failure_classifications.jsonl");
    await fs.writeFile(filePath, "not-valid-json\n", "utf8");

    const result = await loadRecentFailureClassifications(dir);
    assert.deepEqual(result, {});
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("ignores records missing role or classification fields", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "worker_failure_classifications.jsonl");
    await fs.writeFile(filePath,
      JSON.stringify({ role: "", classification: makeClassification() }) + "\n" +
      JSON.stringify({ role: "good-role", classification: null }) + "\n",
      "utf8"
    );
    const result = await loadRecentFailureClassifications(dir);
    assert.deepEqual(result, {});
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// ── FailureEnvelope ───────────────────────────────────────────────────────────

import {
  FAILURE_ENVELOPE_SCHEMA_VERSION,
  TERMINATION_CAUSE,
  FAILURE_ENVELOPE_SCHEMA,
  buildFailureEnvelope,
} from "../../src/core/failure_classifier.js";

describe("TERMINATION_CAUSE enum", () => {
  it("is frozen and contains all five causes", () => {
    assert.ok(Object.isFrozen(TERMINATION_CAUSE));
    assert.equal(TERMINATION_CAUSE.ERROR,                "error");
    assert.equal(TERMINATION_CAUSE.BLOCKED,              "blocked");
    assert.equal(TERMINATION_CAUSE.CANCELLED,            "cancelled");
    assert.equal(TERMINATION_CAUSE.TIMEOUT,              "timeout");
    assert.equal(TERMINATION_CAUSE.VERIFICATION_FAILED,  "verification_failed");
    assert.equal(Object.values(TERMINATION_CAUSE).length, 5);
  });
});

describe("FAILURE_ENVELOPE_SCHEMA_VERSION", () => {
  it("is the integer 1", () => {
    assert.equal(FAILURE_ENVELOPE_SCHEMA_VERSION, 1);
    assert.equal(typeof FAILURE_ENVELOPE_SCHEMA_VERSION, "number");
  });
});

describe("FAILURE_ENVELOPE_SCHEMA", () => {
  it("is frozen and lists all required fields", () => {
    assert.ok(Object.isFrozen(FAILURE_ENVELOPE_SCHEMA));
    for (const field of ["schemaVersion", "envelopeId", "taskId", "terminationCause", "classification", "retryDecision", "resolvedAt"]) {
      assert.ok(FAILURE_ENVELOPE_SCHEMA.required.includes(field as any), `missing field: ${field}`);
    }
  });

  it("terminationCauses lists all five causes", () => {
    assert.equal(FAILURE_ENVELOPE_SCHEMA.terminationCauses.length, 5);
    assert.ok(FAILURE_ENVELOPE_SCHEMA.terminationCauses.includes("verification_failed"));
  });
});

describe("buildFailureEnvelope — happy path", () => {
  it("returns envelope with all required fields for ERROR cause", () => {
    const classification = makeClassification();
    const envelope = buildFailureEnvelope(classification, null, TERMINATION_CAUSE.ERROR, "task-001");
    assert.equal(envelope.schemaVersion, FAILURE_ENVELOPE_SCHEMA_VERSION);
    assert.equal(typeof envelope.envelopeId, "string");
    assert.ok(envelope.envelopeId.startsWith("fe-"), "envelopeId must start with fe-");
    assert.equal(envelope.taskId, "task-001");
    assert.equal(envelope.terminationCause, "error");
    assert.deepEqual(envelope.classification, classification);
    assert.equal(envelope.retryDecision, null);
    assert.equal(typeof envelope.resolvedAt, "string");
  });

  it("returns envelope with VERIFICATION_FAILED cause and null classification", () => {
    const envelope = buildFailureEnvelope(null, null, TERMINATION_CAUSE.VERIFICATION_FAILED, "task-002");
    assert.equal(envelope.terminationCause, "verification_failed");
    assert.equal(envelope.classification, null);
    assert.equal(envelope.taskId, "task-002");
  });

  it("returns envelope with retryDecision when provided", () => {
    const retry = { retryAction: "retry", strategyUsed: "adaptive" };
    const envelope = buildFailureEnvelope(null, retry, TERMINATION_CAUSE.BLOCKED, null);
    assert.equal(envelope.terminationCause, "blocked");
    assert.deepEqual(envelope.retryDecision, retry);
    assert.equal(envelope.taskId, null);
  });

  it("defaults to ERROR cause when an invalid cause is provided", () => {
    const envelope = buildFailureEnvelope(null, null, "invalid_cause" as any, null);
    assert.equal(envelope.terminationCause, "error");
  });

  it("sets taskId to null when not provided", () => {
    const envelope = buildFailureEnvelope(null, null, TERMINATION_CAUSE.TIMEOUT);
    assert.equal(envelope.taskId, null);
    assert.equal(envelope.terminationCause, "timeout");
  });

  it("all five termination causes produce valid envelopes", () => {
    for (const cause of Object.values(TERMINATION_CAUSE)) {
      const envelope = buildFailureEnvelope(null, null, cause);
      assert.equal(envelope.terminationCause, cause, `cause ${cause} must be preserved`);
      assert.equal(envelope.schemaVersion, FAILURE_ENVELOPE_SCHEMA_VERSION);
    }
  });
});

describe("buildFailureEnvelope — negative paths", () => {
  it("returns a valid envelope even with null classification and retry", () => {
    const envelope = buildFailureEnvelope(null, null, TERMINATION_CAUSE.CANCELLED, "task-999");
    assert.equal(envelope.classification, null);
    assert.equal(envelope.retryDecision, null);
    assert.ok(envelope.envelopeId, "envelopeId must be non-empty");
    assert.ok(envelope.resolvedAt, "resolvedAt must be set");
  });

  it("never throws when called with minimal arguments", () => {
    assert.doesNotThrow(() => buildFailureEnvelope(null, null, TERMINATION_CAUSE.ERROR));
  });
});
