import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  inferTaskClass,
  computeCalibrationByTaskClass,
  TASK_CLASS,
} from "../../src/core/athena_reviewer.js";

describe("inferTaskClass", () => {
  it("infers implementation from task text", () => {
    assert.equal(inferTaskClass({ plan: { task: "Implement new login flow" } }), TASK_CLASS.IMPLEMENTATION);
  });

  it("infers test from task text", () => {
    assert.equal(inferTaskClass({ plan: { task: "Write unit tests for validator" } }), TASK_CLASS.TEST);
  });

  it("infers bugfix from task text", () => {
    assert.equal(inferTaskClass({ plan: { task: "Fix race condition in scheduler" } }), TASK_CLASS.BUGFIX);
  });

  it("infers refactor from task text", () => {
    assert.equal(inferTaskClass({ plan: { task: "Refactor database layer" } }), TASK_CLASS.REFACTOR);
  });

  it("infers governance from role", () => {
    assert.equal(inferTaskClass({ plan: { task: "Review policies", role: "governance" } }), TASK_CLASS.GOVERNANCE);
  });

  it("infers infrastructure from task text", () => {
    assert.equal(inferTaskClass({ plan: { task: "Update Docker CI pipeline" } }), TASK_CLASS.INFRASTRUCTURE);
  });

  it("infers documentation from task text", () => {
    assert.equal(inferTaskClass({ plan: { task: "Update README documentation" } }), TASK_CLASS.DOCUMENTATION);
  });

  it("returns unknown for ambiguous tasks", () => {
    assert.equal(inferTaskClass({ plan: { task: "handle stuff" } }), TASK_CLASS.UNKNOWN);
  });

  it("handles null input", () => {
    assert.equal(inferTaskClass(null), TASK_CLASS.UNKNOWN);
    assert.equal(inferTaskClass({}), TASK_CLASS.UNKNOWN);
  });
});

describe("computeCalibrationByTaskClass", () => {
  const goodFixture = {
    fixtureId: "good-impl",
    expectedVerdict: "approved",
    plan: {
      task: "Implement src/core/parser.js improvements with measurable output",
      role: "implementation",
      verification: "npm test && npm run lint",
      files: ["src/core/parser.js"],
      context: "Success criteria: parser must handle all edge cases correctly, return proper error codes",
      priority: 1,
      wave: 1,
    },
  };

  const badFixture = {
    fixtureId: "bad-test",
    expectedVerdict: "rejected",
    plan: {
      task: "test stuff",
      role: "test",
      verification: "",
      files: [],
    },
  };

  it("segments results by task class", () => {
    const result = computeCalibrationByTaskClass([goodFixture, badFixture]);
    assert.ok(result.overall);
    assert.ok(result.byClass);
    assert.ok(result.byClass[TASK_CLASS.IMPLEMENTATION] || result.byClass[TASK_CLASS.TEST]);
  });

  it("computes FP and FN rates per class", () => {
    const result = computeCalibrationByTaskClass([goodFixture, badFixture]);
    for (const cls of Object.values(result.byClass)) {
      assert.ok(typeof cls.falsePositiveRate === "number");
      assert.ok(typeof cls.falseNegativeRate === "number");
      assert.ok(cls.falsePositiveRate >= 0 && cls.falsePositiveRate <= 1);
      assert.ok(cls.falseNegativeRate >= 0 && cls.falseNegativeRate <= 1);
    }
  });

  it("handles empty fixtures", () => {
    const result = computeCalibrationByTaskClass([]);
    assert.deepEqual(result.byClass, {});
    assert.equal(result.overall.total, 0);
  });
});
