import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeLearningClosureRate } from "../../src/core/delta_analytics.js";

describe("delta_analytics", () => {
  describe("computeLearningClosureRate", () => {
    it("returns zero for null input", () => {
      const result = computeLearningClosureRate(null);
      assert.equal(result.closureRate, 0);
      assert.equal(result.totalLessons, 0);
      assert.equal(result.compiledCount, 0);
    });

    it("returns zero when no lessons exist", () => {
      const result = computeLearningClosureRate([]);
      assert.equal(result.closureRate, 0);
    });

    it("computes closure rate correctly", () => {
      const pms = [
        { lessonLearned: "First lesson learned from this cycle" },
        { lessonLearned: "Second lesson learned from this cycle" },
        { lessonLearned: "Third lesson learned from this cycle" },
        { lessonLearned: "Fourth lesson learned from this cycle" },
      ];
      const result = computeLearningClosureRate(pms, ["glob-false-fail", "lint-failure"]);
      assert.equal(result.totalLessons, 4);
      assert.equal(result.compiledCount, 2);
      assert.equal(result.closureRate, 0.5);
    });

    it("ignores short lessons", () => {
      const pms = [
        { lessonLearned: "ok" },
        { lessonLearned: "A real lesson learned about testing infrastructure" },
      ];
      const result = computeLearningClosureRate(pms, []);
      assert.equal(result.totalLessons, 1);
    });
  });
});
