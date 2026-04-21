import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeCapacityIndex, appendCapacityEntry, getRecentCapacity, computeTrend, computeROIWeightedCapacityIndex } from "../../src/core/capacity_scoreboard.js";

describe("capacity_scoreboard", () => {
  describe("existing exports", () => {
    it("appendCapacityEntry is a function", () => {
      assert.equal(typeof appendCapacityEntry, "function");
    });

    it("getRecentCapacity is a function", () => {
      assert.equal(typeof getRecentCapacity, "function");
    });

    it("computeTrend is a function", () => {
      assert.equal(typeof computeTrend, "function");
    });
  });

  describe("computeCapacityIndex (Packet 17)", () => {
    it("returns 10 dimensions", () => {
      const result = computeCapacityIndex({});
      assert.equal(Object.keys(result.dimensions).length, 10);
    });

    it("returns composite as mean of dimensions", () => {
      const result = computeCapacityIndex({
        parserConfidence: 1,
        planContractPassRate: 1,
        testPassRate: 1,
        workerDoneRate: 1,
        diversityIndex: 1,
        recurrenceClosureRate: 1,
        premiumEfficiency: 1,
        securityScore: 1,
        cycleDurationMinutes: 10,
        targetDurationMinutes: 10,
      });
      assert.ok(result.composite >= 0.9);
      assert.ok(result.composite <= 1.0);
    });

    it("all dimensions are between 0 and 1", () => {
      const result = computeCapacityIndex({
        parserConfidence: 2, // out of range — should clamp
        testPassRate: -1,    // out of range — should clamp
      });
      for (const [key, val] of Object.entries(result.dimensions)) {
        assert.ok(val >= 0, `${key} should be >= 0`);
        assert.ok(val <= 1, `${key} should be <= 1`);
      }
    });

    it("computes deltas from previous index", () => {
      const prev = computeCapacityIndex({ parserConfidence: 0.5 });
      const curr = computeCapacityIndex({ parserConfidence: 0.8 }, prev);
      assert.ok(curr.deltas !== null);
      assert.ok(curr.deltas.parserQuality > 0);
    });

    it("deltas are null when no previous index", () => {
      const result = computeCapacityIndex({});
      assert.equal(result.deltas, null);
    });

    it("composite is a number between 0 and 1", () => {
      const result = computeCapacityIndex({});
      assert.ok(typeof result.composite === "number");
      assert.ok(result.composite >= 0);
      assert.ok(result.composite <= 1);
    });

    it("speed dimension uses duration ratio", () => {
      const fast = computeCapacityIndex({ cycleDurationMinutes: 5, targetDurationMinutes: 10 });
      const slow = computeCapacityIndex({ cycleDurationMinutes: 20, targetDurationMinutes: 10 });
      assert.ok(fast.dimensions.speed >= slow.dimensions.speed);
    });

    it("avgTierROI overrides premiumEfficiency for modelTaskFit when positive", () => {
      const result = computeCapacityIndex({ avgTierROI: 0.9, premiumEfficiency: 0.3 });
      assert.ok(
        Math.abs(result.dimensions.modelTaskFit - 0.9) < 0.01,
        `modelTaskFit should use avgTierROI (0.9), got ${result.dimensions.modelTaskFit}`
      );
    });

    it("avgTierROI=0 falls back to premiumEfficiency for modelTaskFit (no history)", () => {
      const result = computeCapacityIndex({ avgTierROI: 0, premiumEfficiency: 0.7 });
      assert.ok(
        Math.abs(result.dimensions.modelTaskFit - 0.7) < 0.01,
        `modelTaskFit should fall back to premiumEfficiency (0.7) when avgTierROI=0, got ${result.dimensions.modelTaskFit}`
      );
    });

    it("avgTierROI above 1.0 is clamped to 1.0 in modelTaskFit", () => {
      const result = computeCapacityIndex({ avgTierROI: 2.5 });
      assert.equal(result.dimensions.modelTaskFit, 1.0, "modelTaskFit must be clamped at 1.0 for high ROI");
    });

    it("avgTierROI absent falls back to premiumEfficiency (backward-compatible)", () => {
      const result = computeCapacityIndex({ premiumEfficiency: 0.6 });
      assert.ok(
        Math.abs(result.dimensions.modelTaskFit - 0.6) < 0.01,
        `without avgTierROI, modelTaskFit must use premiumEfficiency (0.6), got ${result.dimensions.modelTaskFit}`
      );
    });

    it("outcomeScore overrides premiumEfficiency for routing-sensitive dimensions when avgTierROI is absent", () => {
      const result = computeCapacityIndex({ outcomeScore: 0.82, premiumEfficiency: 0.3 });
      assert.ok(Math.abs(result.dimensions.modelTaskFit - 0.82) < 0.01);
      assert.ok(Math.abs(result.dimensions.costEfficiency - 0.82) < 0.01);
    });

    it("derives routing outcome score from attempt, precision, lane reliability, and hard-chain signals", () => {
      const result = computeCapacityIndex({
        premiumEfficiency: 0.2,
        attemptRate: 0.8,
        precisionOnAttempted: 0.75,
        laneReliability: 0.7,
        hardChainSuccessRate: 0.6,
        hardChainSampleCount: 2,
      });
      assert.ok(Math.abs(result.dimensions.modelTaskFit - 0.713) < 0.01);
      assert.ok(Math.abs(result.dimensions.costEfficiency - 0.713) < 0.01);
    });

    it("penalizes routing outcome score when abstainRate is high", () => {
      const strongAttempts = computeCapacityIndex({
        premiumEfficiency: 0.2,
        attemptRate: 0.8,
        abstainRate: 0,
        precisionOnAttempted: 0.75,
        laneReliability: 0.7,
      });
      const abstaining = computeCapacityIndex({
        premiumEfficiency: 0.2,
        attemptRate: 0.8,
        abstainRate: 0.4,
        precisionOnAttempted: 0.75,
        laneReliability: 0.7,
      });
      assert.ok(abstaining.dimensions.modelTaskFit < strongAttempts.dimensions.modelTaskFit);
      assert.ok(abstaining.dimensions.costEfficiency < strongAttempts.dimensions.costEfficiency);
    });
  });

  describe("completionYield and verificationLatencyMs in CapacityEntry", () => {
    it("appendCapacityEntry persists completionYield when provided", async () => {
      const tmpDir = await (await import("node:fs/promises")).mkdtemp(
        (await import("node:path")).join((await import("node:os")).tmpdir(), "box-cap-yield-")
      );
      try {
        const config = { paths: { stateDir: tmpDir } };
        await appendCapacityEntry(config, {
          parserConfidence: 0.8,
          planCount: 5,
          projectHealth: "healthy",
          optimizerStatus: "ok",
          budgetUsed: 100,
          budgetLimit: 500,
          workersDone: 4,
          completionYield: 0.6,
          verificationLatencyMs: 1_200_000,
        });
        const entries = await getRecentCapacity(config, 1);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].completionYield, 0.6);
        assert.equal(entries[0].verificationLatencyMs, 1_200_000);
      } finally {
        await (await import("node:fs/promises")).rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("computeTrend tracks completionYield degradation independently", () => {
      const entries = [
        { completionYield: 0.9 },
        { completionYield: 0.85 },
        { completionYield: 0.82 },
        { completionYield: 0.7 },
        { completionYield: 0.55 },
        { completionYield: 0.3 },
      ];
      const trend = computeTrend(entries, "completionYield");
      assert.equal(trend, "degrading", "should detect yield degradation trend");
    });

    it("computeTrend on verificationLatencyMs detects worsening latency", () => {
      const entries = [
        { verificationLatencyMs: 500_000 },
        { verificationLatencyMs: 800_000 },
        { verificationLatencyMs: 900_000 },
        { verificationLatencyMs: 1_500_000 },
        { verificationLatencyMs: 2_000_000 },
        { verificationLatencyMs: 3_000_000 },
      ];
      // Higher verificationLatencyMs = worsening — computeTrend uses raw delta,
      // so "improving" here means values are increasing (latency is growing = degrading)
      const trend = computeTrend(entries, "verificationLatencyMs");
      assert.equal(trend, "improving", "computeTrend reflects the numeric direction; caller interprets per-field semantics");
    });

    it("appendCapacityEntry tolerates missing completionYield (backward-compatible)", async () => {
      const tmpDir = await (await import("node:fs/promises")).mkdtemp(
        (await import("node:path")).join((await import("node:os")).tmpdir(), "box-cap-compat-")
      );
      try {
        const config = { paths: { stateDir: tmpDir } };
        await appendCapacityEntry(config, {
          parserConfidence: 0.7,
          planCount: 3,
          projectHealth: "warning",
          optimizerStatus: "ok",
          budgetUsed: 200,
          budgetLimit: 500,
          workersDone: 2,
          // completionYield and verificationLatencyMs intentionally omitted
        });
        const entries = await getRecentCapacity(config, 1);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].completionYield, undefined, "absent field must be undefined, not zero-filled");
      } finally {
        await (await import("node:fs/promises")).rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("parser trend tracking — independent from contextual penalties", () => {
    it("parserQuality uses parserCoreConfidence when provided", () => {
      // Core confidence is high (good structural parsing), but aggregate is lower due to context penalties
      const result = computeCapacityIndex({
        parserCoreConfidence: 0.95,
        parserConfidence: 0.6,  // aggregate after context penalties
      });
      assert.ok(
        result.dimensions.parserQuality >= 0.9,
        `parserQuality should reflect core confidence (0.95), got ${result.dimensions.parserQuality}`
      );
    });

    it("parserQuality falls back to parserConfidence when parserCoreConfidence is absent", () => {
      const result = computeCapacityIndex({ parserConfidence: 0.7 });
      assert.ok(
        Math.abs(result.dimensions.parserQuality - 0.7) < 0.01,
        `parserQuality should fall back to parserConfidence (0.7), got ${result.dimensions.parserQuality}`
      );
    });

    it("promptQuality uses aggregate parserConfidence regardless of parserCoreConfidence", () => {
      const result = computeCapacityIndex({
        parserCoreConfidence: 0.95,
        parserConfidence: 0.6,
      });
      assert.ok(
        Math.abs(result.dimensions.promptQuality - 0.6) < 0.01,
        `promptQuality should use aggregate parserConfidence (0.6), got ${result.dimensions.promptQuality}`
      );
    });

    it("parserQuality and promptQuality diverge when context penalties are present", () => {
      const result = computeCapacityIndex({
        parserCoreConfidence: 0.9,
        parserConfidence: 0.5,  // heavily penalized by contextual signals
      });
      assert.ok(
        result.dimensions.parserQuality > result.dimensions.promptQuality,
        "parserQuality (core) should exceed promptQuality (penalized aggregate) when context penalties are applied"
      );
    });

    it("parserQuality equals promptQuality when no parserCoreConfidence and no penalties", () => {
      // When only parserConfidence is provided (legacy path), both dimensions use the same value
      const result = computeCapacityIndex({ parserConfidence: 0.75 });
      assert.ok(
        Math.abs(result.dimensions.parserQuality - result.dimensions.promptQuality) < 0.01,
        "without parserCoreConfidence, parserQuality and promptQuality should be equal"
      );
    });

    it("computeTrend on parserCoreConfidence tracks parser quality independently", () => {
      // Build a series where core confidence improves but aggregate stays penalized
      const entries = [
        { parserCoreConfidence: 0.6, parserConfidence: 0.3 },
        { parserCoreConfidence: 0.65, parserConfidence: 0.3 },
        { parserCoreConfidence: 0.68, parserConfidence: 0.3 },
        { parserCoreConfidence: 0.72, parserConfidence: 0.3 },
        { parserCoreConfidence: 0.78, parserConfidence: 0.3 },
        { parserCoreConfidence: 0.85, parserConfidence: 0.3 },
      ];
      const coreTrend = computeTrend(entries, "parserCoreConfidence");
      const aggregateTrend = computeTrend(entries, "parserConfidence");
      assert.equal(coreTrend, "improving", "parser core trend should be improving");
      assert.equal(aggregateTrend, "stable", "aggregate trend should be stable (contextual penalties unchanged)");
    });
  });
});

// ── Task 4: computeROIWeightedCapacityIndex ────────────────────────────────────

describe("computeROIWeightedCapacityIndex", () => {
  it("returns composite, dimensions, and roiWeight fields", () => {
    const result = computeROIWeightedCapacityIndex({ parserConfidence: 0.8 }, 0.7);
    assert.ok(typeof result.composite === "number", "composite must be a number");
    assert.ok(typeof result.roiWeight === "number", "roiWeight must be a number");
    assert.ok(result.dimensions && typeof result.dimensions === "object", "dimensions must be present");
  });

  it("applies high-ROI boost when tierROI >= 0.8", () => {
    const highROI = computeROIWeightedCapacityIndex({}, 0.9);
    const baseROI = computeROIWeightedCapacityIndex({}, 0.5);
    assert.ok(highROI.roiWeight > baseROI.roiWeight,
      "high tierROI must yield a higher roiWeight than mid-range tierROI");
  });

  it("applies low-ROI penalty when tierROI < 0.3", () => {
    const lowROI  = computeROIWeightedCapacityIndex({}, 0.1);
    const zeroROI = computeROIWeightedCapacityIndex({}, 0);
    assert.ok(lowROI.roiWeight < 1.0,
      "low tierROI (>0 but <0.3) must apply roiWeight penalty below 1.0");
    assert.equal(zeroROI.roiWeight, 1.0,
      "zero tierROI (no data) must leave roiWeight at neutral 1.0");
  });

  it("modelTaskFit dimension is non-negative and bounded by 1", () => {
    const result = computeROIWeightedCapacityIndex({ premiumEfficiency: 0.8 }, 0.6);
    assert.ok(result.dimensions.modelTaskFit >= 0, "modelTaskFit must be >= 0");
    assert.ok(result.dimensions.modelTaskFit <= 1, "modelTaskFit must be <= 1");
  });

  it("returns deltas when previousIndex is provided", () => {
    const base = computeROIWeightedCapacityIndex({}, 0.5);
    const next = computeROIWeightedCapacityIndex({ parserConfidence: 1 }, 0.8, base);
    assert.ok(next.deltas !== null, "deltas must be present when previousIndex is provided");
    assert.ok(typeof next.deltas === "object", "deltas must be an object");
  });

  it("negative path: deltas is null when no previousIndex provided", () => {
    const result = computeROIWeightedCapacityIndex({}, 0.5, null);
    assert.equal(result.deltas, null, "deltas must be null when no previous index");
  });
});
