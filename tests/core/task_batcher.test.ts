import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  estimateBatchTokens,
  packPlansIntoBatches,
  buildBatchInstruction,
  buildCombinedPlan
} from "../../src/core/task_batcher.js";

describe("task_batcher", () => {
  describe("estimateTokens", () => {
    it("returns 0 for empty plan", () => {
      assert.equal(estimateTokens({}), 1); // ceil("\n\n".length / 4) = 1
    });

    it("estimates based on task + context + verification length", () => {
      const plan = {
        task: "a".repeat(400),
        context: "b".repeat(400),
        verification: "c".repeat(400)
      };
      // (400+400+400 + 2 newlines) / 4 ≈ 300+
      const tokens = estimateTokens(plan);
      assert.ok(tokens >= 300, `expected >= 300, got ${tokens}`);
      assert.ok(tokens <= 310, `expected <= 310, got ${tokens}`);
    });
  });

  describe("estimateBatchTokens", () => {
    it("sums tokens across plans", () => {
      const plans = [
        { task: "a".repeat(100) },
        { task: "b".repeat(100) }
      ];
      const total = estimateBatchTokens(plans);
      assert.ok(total > estimateTokens(plans[0]));
    });
  });

  describe("packPlansIntoBatches", () => {
    it("returns empty array for no plans", () => {
      assert.deepEqual(packPlansIntoBatches([], 100000), []);
    });

    it("packs all small plans into a single batch", () => {
      const plans = Array.from({ length: 10 }, (_, i) => ({
        task: `Task ${i}`,
        context: "some context",
        verification: "check it"
      }));
      const batches = packPlansIntoBatches(plans, 100000);
      assert.equal(batches.length, 1);
      assert.equal(batches[0].length, 10);
    });

    it("splits into multiple batches when token limit is exceeded", () => {
      const plans = Array.from({ length: 5 }, (_, i) => ({
        task: "x".repeat(40000), // ~10000 tokens each
        context: "",
        verification: ""
      }));
      // With 100k limit minus 4k overhead = 96k available
      // Each plan is ~10k tokens => 5 plans = 50k => fits in 1 batch
      const batches = packPlansIntoBatches(plans, 100000);
      assert.equal(batches.length, 1);

      // Now with a small limit: 20k total - 4k overhead = 16k available
      // Each plan ~10k => max 1 per batch
      const smallBatches = packPlansIntoBatches(plans, 20000);
      assert.ok(smallBatches.length >= 3, `expected >= 3 batches, got ${smallBatches.length}`);
    });

    it("handles single plan", () => {
      const plans = [{ task: "do it", context: "", verification: "" }];
      const batches = packPlansIntoBatches(plans, 100000);
      assert.equal(batches.length, 1);
      assert.equal(batches[0].length, 1);
    });

    it("falls back to one-per-batch when budget is below overhead", () => {
      const plans = [
        { task: "A" },
        { task: "B" }
      ];
      const batches = packPlansIntoBatches(plans, 100); // impossibly small
      assert.equal(batches.length, 2);
    });
  });

  describe("buildBatchInstruction", () => {
    it("passes through directly for a single plan", () => {
      const plan = { task: "Do X", context: "ctx", verification: "verify X", taskKind: "test" };
      const instr = buildBatchInstruction([plan]);
      assert.equal(instr.task, "Do X");
      assert.equal(instr.context, "ctx");
      assert.equal(instr.verification, "verify X");
      assert.equal(instr.taskKind, "test");
    });

    it("combines multiple plans into numbered task list", () => {
      const plans = [
        { task: "Task A", context: "ctx A", verification: "verify A" },
        { task: "Task B", context: "", verification: "verify B" },
        { task: "Task C", context: "ctx C", verification: "" }
      ];
      const instr = buildBatchInstruction(plans);
      assert.ok(instr.task.includes("TASK 1 of 3"));
      assert.ok(instr.task.includes("Task A"));
      assert.ok(instr.task.includes("TASK 2 of 3"));
      assert.ok(instr.task.includes("Task B"));
      assert.ok(instr.task.includes("TASK 3 of 3"));
      assert.ok(instr.task.includes("Task C"));
      assert.ok(instr.task.includes("BATCH COMPLETION RULES"));
      assert.equal(instr.taskKind, "implementation");
    });
  });

  describe("buildCombinedPlan", () => {
    it("returns the plan directly for single-element array", () => {
      const plan = { task: "A", role: "worker", context: "c", verification: "v" };
      const combined = buildCombinedPlan([plan]);
      assert.equal(combined, plan);
    });

    it("combines multiple plans into a single plan", () => {
      const plans = [
        { task: "A", role: "wA", context: "c1", verification: "v1" },
        { task: "B", role: "wB", context: "c2", verification: "v2" }
      ];
      const combined = buildCombinedPlan(plans);
      assert.ok(combined.task.includes("[Task 1] A"));
      assert.ok(combined.task.includes("[Task 2] B"));
      assert.ok(combined.verification.includes("v1"));
      assert.ok(combined.verification.includes("v2"));
      assert.equal(combined.role, "wA"); // uses first plan's role
      assert.equal(combined._batchSize, 2);
    });
  });
});
