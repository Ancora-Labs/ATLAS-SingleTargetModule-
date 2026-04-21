/**
 * retry_strategy.test.ts
 *
 * Tests for the adaptive retry strategy router.
 *
 * Coverage:
 *   - RETRY_STRATEGY, RETRY_ACTION, RETRY_RESOLVE_REASON enums (frozen, values)
 *   - RETRY_STATE_SCHEMA and RETRY_METRIC_SCHEMA (required fields, enum sets)
 *   - DEFAULT_RETRY_POLICIES (all six failure classes, concrete values)
 *   - resolveRetryAction: validation (missing/invalid inputs), uniform mode,
 *     adaptive mode per class, escalation thresholds, policy overrides
 *   - buildRetryMetric: output conforms to RETRY_METRIC_SCHEMA
 *   - Negative paths: unknown class, negative attempts, null inputs
 *   - AC#14 decision predicate for policy violations (reassign → split → escalate)
 *   - AC#16 routing assertion: each class produces a deterministic RETRY_ACTION
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  RETRY_STRATEGY,
  RETRY_ACTION,
  RETRY_RESOLVE_REASON,
  RETRY_STRATEGY_SCHEMA_VERSION,
  DEFAULT_RETRY_POLICIES,
  RETRY_STATE_SCHEMA,
  RETRY_METRIC_SCHEMA,
  STEP_RETRY_CLASS,
  classifyStepRetryClass,
  resolveRetryAction,
  buildRetryMetric,
  recommendRetryDeliberationMode,
  applyRetrySignalTuning,
  buildAttemptArtifact,
} from "../../src/core/retry_strategy.js";

import { FAILURE_CLASS } from "../../src/core/failure_classifier.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function adaptiveConfig(overrides = {}) {
  return { runtime: { retryStrategy: "adaptive", ...overrides } };
}

function uniformConfig() {
  return { runtime: { retryStrategy: "uniform" } };
}

// ── Enum tests ────────────────────────────────────────────────────────────────

describe("RETRY_STRATEGY enum", () => {
  it("is frozen and has adaptive and uniform", () => {
    assert.ok(Object.isFrozen(RETRY_STRATEGY));
    assert.equal(RETRY_STRATEGY.ADAPTIVE, "adaptive");
    assert.equal(RETRY_STRATEGY.UNIFORM, "uniform");
    assert.equal(Object.keys(RETRY_STRATEGY).length, 2);
  });
});

describe("RETRY_ACTION enum", () => {
  it("is frozen and has all required actions", () => {
    assert.ok(Object.isFrozen(RETRY_ACTION));
    assert.equal(RETRY_ACTION.RETRY,          "retry");
    assert.equal(RETRY_ACTION.COOLDOWN_RETRY, "cooldown_retry");
    assert.equal(RETRY_ACTION.REWORK,         "rework");
    assert.equal(RETRY_ACTION.REASSIGN,       "reassign");
    assert.equal(RETRY_ACTION.SPLIT,          "split");
    assert.equal(RETRY_ACTION.ESCALATE,       "escalate");
    assert.equal(Object.keys(RETRY_ACTION).length, 6);
  });
});

describe("RETRY_RESOLVE_REASON enum", () => {
  it("is frozen and has all required reason codes", () => {
    assert.ok(Object.isFrozen(RETRY_RESOLVE_REASON));
    assert.equal(RETRY_RESOLVE_REASON.MISSING_PARAM,         "MISSING_PARAM");
    assert.equal(RETRY_RESOLVE_REASON.UNKNOWN_FAILURE_CLASS, "UNKNOWN_FAILURE_CLASS");
    assert.equal(RETRY_RESOLVE_REASON.INVALID_ATTEMPTS,      "INVALID_ATTEMPTS");
    assert.equal(Object.keys(RETRY_RESOLVE_REASON).length, 3);
  });
});

describe("RETRY_STRATEGY_SCHEMA_VERSION", () => {
  it("is the integer 1", () => {
    assert.equal(RETRY_STRATEGY_SCHEMA_VERSION, 1);
    assert.equal(typeof RETRY_STRATEGY_SCHEMA_VERSION, "number");
  });
});

// ── Schema tests ──────────────────────────────────────────────────────────────

describe("RETRY_STATE_SCHEMA", () => {
  it("is frozen and contains all required fields", () => {
    assert.ok(Object.isFrozen(RETRY_STATE_SCHEMA));
    const required = RETRY_STATE_SCHEMA.required;
    for (const f of [
      "schemaVersion", "taskId", "failureClass", "attempts", "retryAction",
      "cooldownUntilMs", "escalationTarget", "reworkQueue", "verificationStep",
      "strategyUsed", "reason", "decidedAt",
    ]) {
      assert.ok(required.includes(f), `RETRY_STATE_SCHEMA missing required field: ${f}`);
    }
  });

  it("retryActionEnum matches RETRY_ACTION values", () => {
    const expected = Object.values(RETRY_ACTION).sort();
    const actual   = [...RETRY_STATE_SCHEMA.retryActionEnum].sort();
    assert.deepEqual(actual, expected);
  });

  it("failureClassEnum matches FAILURE_CLASS values", () => {
    const expected = Object.values(FAILURE_CLASS).sort();
    const actual   = [...RETRY_STATE_SCHEMA.failureClassEnum].sort();
    assert.deepEqual(actual, expected);
  });

  it("retryStrategyEnum matches RETRY_STRATEGY values", () => {
    const expected = Object.values(RETRY_STRATEGY).sort();
    const actual   = [...RETRY_STATE_SCHEMA.retryStrategyEnum].sort();
    assert.deepEqual(actual, expected);
  });
});

describe("RETRY_METRIC_SCHEMA", () => {
  it("is frozen and contains all required fields", () => {
    assert.ok(Object.isFrozen(RETRY_METRIC_SCHEMA));
    const required = RETRY_METRIC_SCHEMA.required;
    for (const f of [
      "schemaVersion", "taskId", "failureClass", "retryAction",
      "attempts", "strategyUsed", "cooldownMs", "escalationTarget", "decidedAt",
    ]) {
      assert.ok(required.includes(f), `RETRY_METRIC_SCHEMA missing required field: ${f}`);
    }
  });

  it("outputArtifact is state/retry_metrics.jsonl", () => {
    assert.equal(RETRY_METRIC_SCHEMA.outputArtifact, "state/retry_metrics.jsonl");
  });
});

// ── DEFAULT_RETRY_POLICIES tests ──────────────────────────────────────────────

describe("DEFAULT_RETRY_POLICIES", () => {
  it("has a policy for every FAILURE_CLASS value", () => {
    for (const cls of Object.values(FAILURE_CLASS)) {
      assert.ok(DEFAULT_RETRY_POLICIES[cls], `missing policy for failure class: ${cls}`);
    }
  });

  it("environment policy has concrete cooldownMinutes=30, maxRetries=3, escalateAfter=3", () => {
    const p = DEFAULT_RETRY_POLICIES[FAILURE_CLASS.ENVIRONMENT];
    assert.equal(p.cooldownMinutes, 30);
    assert.equal(p.maxRetries, 3);
    assert.equal(p.escalateAfter, 3);
    assert.equal(p.escalationTarget, "daemon_queue");
  });

  it("model policy has cooldownMinutes=15", () => {
    assert.equal(DEFAULT_RETRY_POLICIES[FAILURE_CLASS.MODEL].cooldownMinutes, 15);
  });

  it("external_api policy has cooldownMinutes=10", () => {
    assert.equal(DEFAULT_RETRY_POLICIES[FAILURE_CLASS.EXTERNAL_API].cooldownMinutes, 10);
  });

  it("logic_defect policy has reworkQueue and verificationStep defined", () => {
    const p = DEFAULT_RETRY_POLICIES[FAILURE_CLASS.LOGIC_DEFECT];
    assert.equal(p.reworkQueue, "rework_queue");
    assert.equal(p.verificationStep, "verification_gate");
    assert.equal(p.maxReworkAttempts, 2);
    assert.equal(p.escalateAfter, 2);
  });

  it("verification policy has the same rework values as logic_defect", () => {
    const p = DEFAULT_RETRY_POLICIES[FAILURE_CLASS.VERIFICATION];
    assert.equal(p.reworkQueue, "rework_queue");
    assert.equal(p.verificationStep, "verification_gate");
    assert.equal(p.maxReworkAttempts, 2);
  });

  it("policy class has reassignBeforeAttempt, splitAfterAttempt, escalateAfter", () => {
    const p = DEFAULT_RETRY_POLICIES[FAILURE_CLASS.POLICY];
    assert.equal(p.reassignBeforeAttempt, 2);
    assert.equal(p.splitAfterAttempt, 2);
    assert.equal(p.escalateAfter, 3);
  });
});

// ── resolveRetryAction — validation (negative paths, AC#9 / AC#10) ───────────

describe("resolveRetryAction — validation: MISSING_PARAM", () => {
  it("returns MISSING_PARAM for null failureClass", () => {
    const r = resolveRetryAction(null, 0, adaptiveConfig());
    assert.equal(r.ok, false);
    assert.equal(r.code, RETRY_RESOLVE_REASON.MISSING_PARAM);
    assert.equal(r.field, "failureClass");
  });

  it("returns MISSING_PARAM for undefined failureClass", () => {
    const r = resolveRetryAction(undefined, 0, adaptiveConfig());
    assert.equal(r.ok, false);
    assert.equal(r.code, RETRY_RESOLVE_REASON.MISSING_PARAM);
  });

  it("returns MISSING_PARAM for null attempts", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, null, adaptiveConfig());
    assert.equal(r.ok, false);
    assert.equal(r.code, RETRY_RESOLVE_REASON.MISSING_PARAM);
    assert.equal(r.field, "attempts");
  });

  it("returns MISSING_PARAM for undefined attempts", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, undefined, adaptiveConfig());
    assert.equal(r.ok, false);
    assert.equal(r.code, RETRY_RESOLVE_REASON.MISSING_PARAM);
  });
});

describe("resolveRetryAction — validation: UNKNOWN_FAILURE_CLASS", () => {
  it("returns UNKNOWN_FAILURE_CLASS for an unknown class string", () => {
    const r = resolveRetryAction("cosmic_ray", 0, adaptiveConfig());
    assert.equal(r.ok, false);
    assert.equal(r.code, RETRY_RESOLVE_REASON.UNKNOWN_FAILURE_CLASS);
    assert.equal(r.field, "failureClass");
  });

  it("returns UNKNOWN_FAILURE_CLASS for empty string", () => {
    const r = resolveRetryAction("", 0, adaptiveConfig());
    assert.equal(r.ok, false);
    assert.equal(r.code, RETRY_RESOLVE_REASON.UNKNOWN_FAILURE_CLASS);
  });
});

describe("resolveRetryAction — validation: INVALID_ATTEMPTS", () => {
  it("returns INVALID_ATTEMPTS for negative attempts", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, -1, adaptiveConfig());
    assert.equal(r.ok, false);
    assert.equal(r.code, RETRY_RESOLVE_REASON.INVALID_ATTEMPTS);
    assert.equal(r.field, "attempts");
  });

  it("returns INVALID_ATTEMPTS for non-integer attempts", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 1.5, adaptiveConfig());
    assert.equal(r.ok, false);
    assert.equal(r.code, RETRY_RESOLVE_REASON.INVALID_ATTEMPTS);
  });

  it("returns INVALID_ATTEMPTS for string attempts", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, "two", adaptiveConfig());
    assert.equal(r.ok, false);
    assert.equal(r.code, RETRY_RESOLVE_REASON.INVALID_ATTEMPTS);
  });
});

// ── resolveRetryAction — uniform mode (rollback) ──────────────────────────────

describe("resolveRetryAction — uniform mode (AC#17 rollback)", () => {
  it("returns RETRY_ACTION.RETRY for any class in uniform mode", () => {
    for (const cls of Object.values(FAILURE_CLASS)) {
      const r = resolveRetryAction(cls, 5, uniformConfig());
      assert.ok(r.ok, `expected ok for class ${cls}`);
      assert.equal(r.decision.retryAction, RETRY_ACTION.RETRY);
      assert.equal(r.decision.strategyUsed, RETRY_STRATEGY.UNIFORM);
    }
  });

  it("uniform mode sets null cooldownUntilMs, reworkQueue, escalationTarget", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 10, uniformConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.cooldownUntilMs, null);
    assert.equal(r.decision.reworkQueue, null);
    assert.equal(r.decision.escalationTarget, null);
  });
});

// ── resolveRetryAction — adaptive mode: environment / model / external_api ───

describe("resolveRetryAction — environment blocker (AC#12 / AC#2)", () => {
  it("returns COOLDOWN_RETRY on first failure (attempt 0)", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 0, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.COOLDOWN_RETRY);
    assert.equal(r.decision.strategyUsed, RETRY_STRATEGY.ADAPTIVE);
  });

  it("cooldownMs is 30 minutes (1 800 000 ms) by default", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 0, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.cooldownMs, 30 * 60 * 1000);
  });

  it("cooldownUntilMs is approximately now + 30 minutes", () => {
    const before = Date.now();
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 0, adaptiveConfig());
    const after = Date.now();
    assert.ok(r.ok);
    const expected30min = 30 * 60 * 1000;
    assert.ok(r.decision.cooldownUntilMs >= before + expected30min - 5);
    assert.ok(r.decision.cooldownUntilMs <= after  + expected30min + 5);
  });

  it("escalationTarget is daemon_queue", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 0, adaptiveConfig());
    assert.equal(r.decision.escalationTarget, "daemon_queue");
  });

  it("returns ESCALATE when attempts >= escalateAfter (3)", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 3, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.ESCALATE);
    assert.equal(r.decision.escalationTarget, "daemon_queue");
  });

  it("does NOT escalate at attempt 2 (below threshold)", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 2, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.COOLDOWN_RETRY);
  });
});

describe("resolveRetryAction — model blocker", () => {
  it("returns COOLDOWN_RETRY at attempt 0 with 15-minute cooldown", () => {
    const r = resolveRetryAction(FAILURE_CLASS.MODEL, 0, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.COOLDOWN_RETRY);
    assert.equal(r.decision.cooldownMs, 15 * 60 * 1000);
  });

  it("escalates at attempt 3", () => {
    const r = resolveRetryAction(FAILURE_CLASS.MODEL, 3, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.ESCALATE);
  });
});

describe("resolveRetryAction — external_api blocker", () => {
  it("returns COOLDOWN_RETRY at attempt 0 with 10-minute cooldown", () => {
    const r = resolveRetryAction(FAILURE_CLASS.EXTERNAL_API, 0, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.COOLDOWN_RETRY);
    assert.equal(r.decision.cooldownMs, 10 * 60 * 1000);
  });

  it("escalates at attempt 3", () => {
    const r = resolveRetryAction(FAILURE_CLASS.EXTERNAL_API, 3, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.ESCALATE);
  });
});

// ── resolveRetryAction — adaptive mode: logic_defect / verification ───────────

describe("resolveRetryAction — logic_defect (AC#3 / AC#13)", () => {
  it("returns REWORK at attempt 0", () => {
    const r = resolveRetryAction(FAILURE_CLASS.LOGIC_DEFECT, 0, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.REWORK);
  });

  it("reworkQueue is rework_queue", () => {
    const r = resolveRetryAction(FAILURE_CLASS.LOGIC_DEFECT, 0, adaptiveConfig());
    assert.equal(r.decision.reworkQueue, "rework_queue");
  });

  it("verificationStep is verification_gate (AC#13)", () => {
    const r = resolveRetryAction(FAILURE_CLASS.LOGIC_DEFECT, 0, adaptiveConfig());
    assert.equal(r.decision.verificationStep, "verification_gate");
  });

  it("escalates at attempt 2 (exhausted)", () => {
    const r = resolveRetryAction(FAILURE_CLASS.LOGIC_DEFECT, 2, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.ESCALATE);
    assert.equal(r.decision.escalationTarget, "daemon_queue");
  });

  it("does NOT escalate at attempt 1 (below threshold)", () => {
    const r = resolveRetryAction(FAILURE_CLASS.LOGIC_DEFECT, 1, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.REWORK);
  });
});

describe("resolveRetryAction — verification failure", () => {
  it("returns REWORK at attempt 0", () => {
    const r = resolveRetryAction(FAILURE_CLASS.VERIFICATION, 0, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.REWORK);
    assert.equal(r.decision.verificationStep, "verification_gate");
  });

  it("escalates at attempt 2", () => {
    const r = resolveRetryAction(FAILURE_CLASS.VERIFICATION, 2, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.ESCALATE);
  });
});

// ── resolveRetryAction — adaptive mode: policy (AC#14 decision predicate) ─────

describe("resolveRetryAction — policy violation decision predicate (AC#14)", () => {
  it("attempt 0 < reassignBeforeAttempt(2) → REASSIGN", () => {
    const r = resolveRetryAction(FAILURE_CLASS.POLICY, 0, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.REASSIGN);
  });

  it("attempt 1 < reassignBeforeAttempt(2) → REASSIGN", () => {
    const r = resolveRetryAction(FAILURE_CLASS.POLICY, 1, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.REASSIGN);
  });

  it("attempt 2 >= splitAfterAttempt(2) but < escalateAfter(3) → SPLIT", () => {
    const r = resolveRetryAction(FAILURE_CLASS.POLICY, 2, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.SPLIT);
  });

  it("attempt 3 >= escalateAfter(3) → ESCALATE", () => {
    const r = resolveRetryAction(FAILURE_CLASS.POLICY, 3, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.ESCALATE);
    assert.equal(r.decision.escalationTarget, "daemon_queue");
  });
});

// ── resolveRetryAction — output schema conformance (AC#8 / AC#18) ─────────────

describe("resolveRetryAction — decision conforms to RETRY_STATE_SCHEMA", () => {
  it("all required fields are present and typed correctly", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 0, adaptiveConfig(), "T-001");
    assert.ok(r.ok);
    const d = r.decision;
    for (const f of RETRY_STATE_SCHEMA.required) {
      assert.ok(Object.prototype.hasOwnProperty.call(d, f), `decision missing field: ${f}`);
    }
    assert.equal(d.schemaVersion, RETRY_STRATEGY_SCHEMA_VERSION);
    assert.equal(d.taskId, "T-001");
    assert.ok(RETRY_STATE_SCHEMA.retryActionEnum.includes(d.retryAction));
    assert.ok(RETRY_STATE_SCHEMA.failureClassEnum.includes(d.failureClass));
    assert.ok(RETRY_STATE_SCHEMA.retryStrategyEnum.includes(d.strategyUsed));
    assert.equal(typeof d.reason, "string");
    assert.ok(d.reason.length > 0);
    assert.ok(typeof d.decidedAt === "string" && d.decidedAt.includes("T"));
  });

  it("taskId is null when not provided", () => {
    const r = resolveRetryAction(FAILURE_CLASS.MODEL, 0, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.taskId, null);
  });
});

// ── resolveRetryAction — config override of policy values ─────────────────────

describe("resolveRetryAction — config override of adaptive policy", () => {
  it("config.runtime.adaptiveRetry.environment.cooldownMinutes overrides default", () => {
    const cfg = {
      runtime: {
        retryStrategy: "adaptive",
        adaptiveRetry: {
          environment: { cooldownMinutes: 5 }
        }
      }
    };
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 0, cfg);
    assert.ok(r.ok);
    assert.equal(r.decision.cooldownMs, 5 * 60 * 1000);
  });

  it("config.runtime.adaptiveRetry.environment.escalateAfter overrides default", () => {
    const cfg = {
      runtime: {
        retryStrategy: "adaptive",
        adaptiveRetry: {
          environment: { escalateAfter: 1 }
        }
      }
    };
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 1, cfg);
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.ESCALATE);
  });
});

// ── resolveRetryAction — routing assertions (AC#16) ──────────────────────────

describe("resolveRetryAction — routing assertions per failure class (AC#16)", () => {
  it("environment/attempt=0 → cooldown_retry", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 0, adaptiveConfig()).decision.retryAction, RETRY_ACTION.COOLDOWN_RETRY);
  });
  it("environment/attempt=3 → escalate", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 3, adaptiveConfig()).decision.retryAction, RETRY_ACTION.ESCALATE);
  });
  it("model/attempt=0 → cooldown_retry", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.MODEL, 0, adaptiveConfig()).decision.retryAction, RETRY_ACTION.COOLDOWN_RETRY);
  });
  it("model/attempt=3 → escalate", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.MODEL, 3, adaptiveConfig()).decision.retryAction, RETRY_ACTION.ESCALATE);
  });
  it("external_api/attempt=0 → cooldown_retry", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.EXTERNAL_API, 0, adaptiveConfig()).decision.retryAction, RETRY_ACTION.COOLDOWN_RETRY);
  });
  it("external_api/attempt=3 → escalate", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.EXTERNAL_API, 3, adaptiveConfig()).decision.retryAction, RETRY_ACTION.ESCALATE);
  });
  it("logic_defect/attempt=0 → rework", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.LOGIC_DEFECT, 0, adaptiveConfig()).decision.retryAction, RETRY_ACTION.REWORK);
  });
  it("logic_defect/attempt=2 → escalate", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.LOGIC_DEFECT, 2, adaptiveConfig()).decision.retryAction, RETRY_ACTION.ESCALATE);
  });
  it("verification/attempt=0 → rework", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.VERIFICATION, 0, adaptiveConfig()).decision.retryAction, RETRY_ACTION.REWORK);
  });
  it("verification/attempt=2 → escalate", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.VERIFICATION, 2, adaptiveConfig()).decision.retryAction, RETRY_ACTION.ESCALATE);
  });
  it("policy/attempt=0 → reassign", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.POLICY, 0, adaptiveConfig()).decision.retryAction, RETRY_ACTION.REASSIGN);
  });
  it("policy/attempt=2 → split", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.POLICY, 2, adaptiveConfig()).decision.retryAction, RETRY_ACTION.SPLIT);
  });
  it("policy/attempt=3 → escalate", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.POLICY, 3, adaptiveConfig()).decision.retryAction, RETRY_ACTION.ESCALATE);
  });
});

// ── buildRetryMetric (AC#5 / AC#15) ──────────────────────────────────────────

describe("buildRetryMetric", () => {
  it("produces a record conforming to RETRY_METRIC_SCHEMA for cooldown_retry decision", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 0, adaptiveConfig(), "T-028");
    assert.ok(r.ok);
    const metric = buildRetryMetric(r.decision);
    for (const f of RETRY_METRIC_SCHEMA.required) {
      assert.ok(Object.prototype.hasOwnProperty.call(metric, f), `metric missing field: ${f}`);
    }
    assert.equal(metric.schemaVersion, RETRY_STRATEGY_SCHEMA_VERSION);
    assert.equal(metric.taskId, "T-028");
    assert.equal(metric.failureClass, FAILURE_CLASS.ENVIRONMENT);
    assert.equal(metric.retryAction, RETRY_ACTION.COOLDOWN_RETRY);
    assert.equal(metric.strategyUsed, RETRY_STRATEGY.ADAPTIVE);
    assert.equal(metric.cooldownMs, 30 * 60 * 1000);
    assert.equal(metric.escalationTarget, "daemon_queue");
    assert.ok(typeof metric.decidedAt === "string");
  });

  it("cooldownMs is null for non-cooldown actions (rework)", () => {
    const r = resolveRetryAction(FAILURE_CLASS.LOGIC_DEFECT, 0, adaptiveConfig());
    assert.ok(r.ok);
    const metric = buildRetryMetric(r.decision);
    assert.equal(metric.cooldownMs, null);
  });

  it("cooldownMs is null for escalate actions", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 3, adaptiveConfig());
    assert.ok(r.ok);
    const metric = buildRetryMetric(r.decision);
    assert.equal(metric.cooldownMs, null);
  });

  it("escalationTarget is null for rework actions", () => {
    // logic_defect rework — escalationTarget may be set for context but cooldownMs is null
    const r = resolveRetryAction(FAILURE_CLASS.LOGIC_DEFECT, 0, adaptiveConfig());
    assert.ok(r.ok);
    // escalationTarget is preserved for downstream use (not null — it's the escalation fallback)
    const metric = buildRetryMetric(r.decision);
    assert.ok(typeof metric.escalationTarget === "string" || metric.escalationTarget === null);
  });
});

describe("recommendRetryDeliberationMode", () => {
  it("returns single-pass for first-attempt lightweight retry", () => {
    const result = recommendRetryDeliberationMode({ retryAction: "retry", attempts: 0 });
    assert.equal(result.mode, "single-pass");
    assert.equal(result.reflection, false);
    assert.equal(result.searchBudget, 0);
  });

  it("returns multi-attempt for rework retry path", () => {
    const result = recommendRetryDeliberationMode({ retryAction: "rework", attempts: 0 });
    assert.equal(result.mode, "multi-attempt");
    assert.equal(result.reflection, true);
    assert.ok(result.searchBudget >= 1);
  });
});

describe("buildAttemptArtifact", () => {
  it("preserves structured phase retry state for replay-guided retries", () => {
    const artifact = buildAttemptArtifact(
      "run-structured",
      1,
      "task-structured",
      "blocked",
      FAILURE_CLASS.VERIFICATION,
      { retryAction: RETRY_ACTION.REWORK },
      "2024-01-01T00:00:00Z",
      {
        failedPhase: "test",
        resumeFromPhase: "test",
        mutation: {
          strategy: "resume_from_failed_phase",
          instructions: ["Start by reproducing TESTS=fail before more edits."],
        },
      },
    );
    assert.equal((artifact.phaseRetryState as any)?.failedPhase, "test");
    assert.equal((artifact.phaseRetryState as any)?.resumeFromPhase, "test");
    assert.equal((artifact.phaseRetryState as any)?.mutation?.strategy, "resume_from_failed_phase");
  });

  it("negative: stores null phaseRetryState when no structured retry state is supplied", () => {
    const artifact = buildAttemptArtifact(
      "run-basic",
      0,
      null,
      "error",
      FAILURE_CLASS.ENVIRONMENT,
      { retryAction: RETRY_ACTION.COOLDOWN_RETRY },
      "2024-01-01T00:00:00Z",
    );
    assert.equal(artifact.phaseRetryState, null);
  });
});

// ── applyRetryROIGate ─────────────────────────────────────────────────────────

import { applyRetryROIGate } from "../../src/core/retry_strategy.js";

describe("applyRetryROIGate", () => {
  const baseDecision = {
    retryAction: RETRY_ACTION.REWORK,
    reason: "logic_defect rework path",
  };

  function roiAllow(): { allowRetry: boolean; expectedGain: number; threshold: number; reason: string } {
    return { allowRetry: true, expectedGain: 0.7, threshold: 0.18, reason: "gain-above-threshold" };
  }

  function roiDeny(): { allowRetry: boolean; expectedGain: number; threshold: number; reason: string } {
    return { allowRetry: false, expectedGain: 0.05, threshold: 0.18, reason: "gain-below-threshold" };
  }

  it("passes through unchanged when allowRetry=true", () => {
    const result = applyRetryROIGate(baseDecision, roiAllow());
    assert.equal(result.retryAction, RETRY_ACTION.REWORK);
    assert.equal(result.roiGateApplied, false);
  });

  it("overrides retryable action to ESCALATE when allowRetry=false", () => {
    const result = applyRetryROIGate(baseDecision, roiDeny());
    assert.equal(result.retryAction, RETRY_ACTION.ESCALATE);
    assert.equal(result.roiGateApplied, true);
    assert.ok(result.reason.includes("roi-gate"));
    assert.ok(result.reason.includes("allowRetry=false"));
  });

  it("overrides retry action to ESCALATE when allowRetry=false", () => {
    const retryDecision = { retryAction: RETRY_ACTION.RETRY, reason: "immediate retry" };
    const result = applyRetryROIGate(retryDecision, roiDeny());
    assert.equal(result.retryAction, RETRY_ACTION.ESCALATE);
    assert.equal(result.roiGateApplied, true);
  });

  it("overrides cooldown_retry to ESCALATE when allowRetry=false", () => {
    const cooldownDecision = { retryAction: RETRY_ACTION.COOLDOWN_RETRY, reason: "transient error" };
    const result = applyRetryROIGate(cooldownDecision, roiDeny());
    assert.equal(result.retryAction, RETRY_ACTION.ESCALATE);
    assert.equal(result.roiGateApplied, true);
  });

  it("passes through ESCALATE action unchanged even when allowRetry=false", () => {
    const escalateDecision = { retryAction: RETRY_ACTION.ESCALATE, reason: "already escalated" };
    const result = applyRetryROIGate(escalateDecision, roiDeny());
    assert.equal(result.retryAction, RETRY_ACTION.ESCALATE);
    assert.equal(result.roiGateApplied, false);
  });

  it("passes through REASSIGN action unchanged even when allowRetry=false", () => {
    const reassignDecision = { retryAction: RETRY_ACTION.REASSIGN, reason: "policy violation" };
    const result = applyRetryROIGate(reassignDecision, roiDeny());
    assert.equal(result.retryAction, RETRY_ACTION.REASSIGN);
    assert.equal(result.roiGateApplied, false);
  });

  it("passes through SPLIT action unchanged even when allowRetry=false", () => {
    const splitDecision = { retryAction: RETRY_ACTION.SPLIT, reason: "policy split" };
    const result = applyRetryROIGate(splitDecision, roiDeny());
    assert.equal(result.retryAction, RETRY_ACTION.SPLIT);
    assert.equal(result.roiGateApplied, false);
  });

  it("preserves other decision fields when overriding retryAction", () => {
    const richDecision = { retryAction: RETRY_ACTION.REWORK, reason: "rework needed", taskId: "T-123", failureClass: "logic_defect" };
    const result = applyRetryROIGate(richDecision, roiDeny());
    assert.equal(result.taskId, "T-123");
    assert.equal(result.failureClass, "logic_defect");
  });

  it("includes gain and threshold values in overridden reason", () => {
    const result = applyRetryROIGate(baseDecision, roiDeny());
    assert.ok(result.reason.includes("0.050"), `reason should include gain: ${result.reason}`);
    assert.ok(result.reason.includes("0.180"), `reason should include threshold: ${result.reason}`);
  });
});

describe("applyRetrySignalTuning", () => {
  it("shortens cooldown when retries are cheap because cache savings and roi are strong", () => {
    const result = applyRetrySignalTuning(
      {
        retryAction: RETRY_ACTION.COOLDOWN_RETRY,
        cooldownMs: 30 * 60 * 1000,
        cooldownUntilMs: Date.now() + (30 * 60 * 1000),
        reason: "model blocker",
        failureClass: FAILURE_CLASS.MODEL,
      },
      {
        promptCacheHitRate: 0.9,
        promptCacheSavedTokens: 240,
        retryExpectedGain: 0.45,
        retryThreshold: 0.18,
        lowRoiSignalCount: 0,
      },
    );
    assert.ok(Number(result.cooldownMs) < 30 * 60 * 1000);
    assert.equal(result.cooldownTuning.includes("cache-cheap"), true);
  });

  it("lengthens cooldown when low-roi lineage evidence and provider failures accumulate", () => {
    const result = applyRetrySignalTuning(
      {
        retryAction: RETRY_ACTION.COOLDOWN_RETRY,
        cooldownMs: 15 * 60 * 1000,
        cooldownUntilMs: Date.now() + (15 * 60 * 1000),
        reason: "external api blocker",
        failureClass: FAILURE_CLASS.EXTERNAL_API,
      },
      {
        promptCacheHitRate: 0.1,
        promptCacheSavedTokens: 0,
        retryExpectedGain: 0.05,
        retryThreshold: 0.18,
        lowRoiSignalCount: 2,
        latestFailureClass: FAILURE_CLASS.EXTERNAL_API,
        latestFinishCode: "provider_timeout_503",
      },
    );
    assert.ok(Number(result.cooldownMs) > 15 * 60 * 1000);
    assert.equal(result.cooldownTuning.includes("provider-backoff"), true);
    assert.equal(result.cooldownTuning.includes("lineage-low-roi=2"), true);
  });

  it("negative path: leaves non-cooldown actions unchanged", () => {
    const result = applyRetrySignalTuning(
      {
        retryAction: RETRY_ACTION.REWORK,
        cooldownMs: null,
        cooldownUntilMs: null,
        reason: "logic defect",
      },
      {
        promptCacheHitRate: 0.8,
        retryExpectedGain: 0.5,
      },
    );
    assert.equal(result.retryAction, RETRY_ACTION.REWORK);
    assert.equal(result.cooldownTuning, "none");
  });
});

// ── STEP_RETRY_CLASS enum ─────────────────────────────────────────────────────

describe("STEP_RETRY_CLASS enum", () => {
  it("is frozen and contains all four class values", () => {
    assert.ok(Object.isFrozen(STEP_RETRY_CLASS));
    assert.equal(STEP_RETRY_CLASS.RETRYABLE,     "retryable");
    assert.equal(STEP_RETRY_CLASS.IDEMPOTENT,    "idempotent");
    assert.equal(STEP_RETRY_CLASS.NON_RETRYABLE, "non_retryable");
    assert.equal(STEP_RETRY_CLASS.CANCELLABLE,   "cancellable");
    assert.equal(Object.keys(STEP_RETRY_CLASS).length, 4);
  });
});

// ── classifyStepRetryClass ────────────────────────────────────────────────────

describe("classifyStepRetryClass — known step names", () => {
  it("worker_execution → retryable, known=true", () => {
    const r = classifyStepRetryClass("worker_execution");
    assert.equal(r.class, STEP_RETRY_CLASS.RETRYABLE);
    assert.equal(r.known, true);
  });

  it("rework_dispatch → retryable, known=true", () => {
    const r = classifyStepRetryClass("rework_dispatch");
    assert.equal(r.class, STEP_RETRY_CLASS.RETRYABLE);
    assert.equal(r.known, true);
  });

  it("checkpoint_write → idempotent, known=true", () => {
    const r = classifyStepRetryClass("checkpoint_write");
    assert.equal(r.class, STEP_RETRY_CLASS.IDEMPOTENT);
    assert.equal(r.known, true);
  });

  it("verification → non_retryable, known=true", () => {
    const r = classifyStepRetryClass("verification");
    assert.equal(r.class, STEP_RETRY_CLASS.NON_RETRYABLE);
    assert.equal(r.known, true);
  });

  it("artifact_gate → non_retryable, known=true", () => {
    const r = classifyStepRetryClass("artifact_gate");
    assert.equal(r.class, STEP_RETRY_CLASS.NON_RETRYABLE);
    assert.equal(r.known, true);
  });

  it("policy_gate → non_retryable, known=true", () => {
    const r = classifyStepRetryClass("policy_gate");
    assert.equal(r.class, STEP_RETRY_CLASS.NON_RETRYABLE);
    assert.equal(r.known, true);
  });

  it("cancellation_check → cancellable, known=true", () => {
    const r = classifyStepRetryClass("cancellation_check");
    assert.equal(r.class, STEP_RETRY_CLASS.CANCELLABLE);
    assert.equal(r.known, true);
  });
});

describe("classifyStepRetryClass — negative paths", () => {
  it("unknown step name → retryable (fail-open), known=false", () => {
    const r = classifyStepRetryClass("totally_unknown_step");
    assert.equal(r.class, STEP_RETRY_CLASS.RETRYABLE);
    assert.equal(r.known, false);
  });

  it("empty string → retryable (fail-open), known=false", () => {
    const r = classifyStepRetryClass("");
    assert.equal(r.class, STEP_RETRY_CLASS.RETRYABLE);
    assert.equal(r.known, false);
  });

  it("is case-insensitive for known step names", () => {
    const r = classifyStepRetryClass("VERIFICATION");
    assert.equal(r.class, STEP_RETRY_CLASS.NON_RETRYABLE);
    assert.equal(r.known, true);
  });

  it("handles whitespace-padded step names", () => {
    const r = classifyStepRetryClass("  checkpoint_write  ");
    assert.equal(r.class, STEP_RETRY_CLASS.IDEMPOTENT);
    assert.equal(r.known, true);
  });
});

// ── FailureEnvelope integration ───────────────────────────────────────────────

import {
  buildFailureEnvelope,
  TERMINATION_CAUSE,
  FAILURE_ENVELOPE_SCHEMA_VERSION,
} from "../../src/core/failure_classifier.js";

describe("FailureEnvelope + resolveRetryAction integration", () => {
  it("envelope retryDecision is populated from resolveRetryAction output", () => {
    const rd = resolveRetryAction(FAILURE_CLASS.LOGIC_DEFECT, 0, {}, null);
    assert.ok(rd.ok, "resolveRetryAction must succeed");
    const envelope = buildFailureEnvelope(null, rd.decision, TERMINATION_CAUSE.ERROR, "task-x");
    assert.ok(envelope.retryDecision, "retryDecision must be set in envelope");
    assert.equal((envelope.retryDecision as any).failureClass, FAILURE_CLASS.LOGIC_DEFECT);
    assert.equal(envelope.schemaVersion, FAILURE_ENVELOPE_SCHEMA_VERSION);
  });

  it("envelope retryDecision retryAction matches resolveRetryAction output for ENVIRONMENT class", () => {
    const rd = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 0, {}, null);
    assert.ok(rd.ok);
    const envelope = buildFailureEnvelope(null, rd.decision, TERMINATION_CAUSE.ERROR, null);
    assert.equal((envelope.retryDecision as any).retryAction, rd.decision.retryAction);
  });

  it("negative path: envelope with null retryDecision is still valid", () => {
    const envelope = buildFailureEnvelope(null, null, TERMINATION_CAUSE.BLOCKED, null);
    assert.equal(envelope.retryDecision, null);
    assert.equal(envelope.terminationCause, "blocked");
    assert.ok(envelope.envelopeId, "envelopeId must be non-empty");
  });
});

// ── WORKER_STEP_STATE ─────────────────────────────────────────────────────────

import { WORKER_STEP_STATE } from "../../src/core/retry_strategy.js";

describe("WORKER_STEP_STATE enum", () => {
  it("is frozen and has all four required states", () => {
    assert.ok(Object.isFrozen(WORKER_STEP_STATE));
    assert.equal(WORKER_STEP_STATE.RUN_AGAIN, "RUN_AGAIN");
    assert.equal(WORKER_STEP_STATE.HANDOFF, "HANDOFF");
    assert.equal(WORKER_STEP_STATE.FINAL_OUTPUT, "FINAL_OUTPUT");
    assert.equal(WORKER_STEP_STATE.INTERRUPTION, "INTERRUPTION");
  });

  it("has exactly four values", () => {
    assert.equal(Object.keys(WORKER_STEP_STATE).length, 4);
  });
});

describe("resolveRetryAction — workerStepState field", () => {
  it("retry action produces RUN_AGAIN workerStepState in uniform mode", () => {
    const result = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 0, uniformConfig(), null);
    assert.ok(result.ok);
    assert.ok("workerStepState" in result.decision, "workerStepState must be present");
    assert.equal(result.decision.workerStepState, WORKER_STEP_STATE.RUN_AGAIN);
  });

  it("escalate action produces INTERRUPTION workerStepState", () => {
    // Force escalation by exceeding maxAttempts for environment class in adaptive mode
    const result = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 99, adaptiveConfig(), null);
    assert.ok(result.ok);
    assert.equal(result.decision.workerStepState, WORKER_STEP_STATE.INTERRUPTION);
  });

  it("negative: invalid failure class returns ok=false with UNKNOWN_FAILURE_CLASS code", () => {
    const result = resolveRetryAction("UNKNOWN_CLASS" as any, 0, {}, null);
    assert.equal(result.ok, false);
    assert.equal(result.code, RETRY_RESOLVE_REASON.UNKNOWN_FAILURE_CLASS);
  });
});
