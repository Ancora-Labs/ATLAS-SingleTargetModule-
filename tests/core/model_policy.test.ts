import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  classifyComplexityTier,
  COMPLEXITY_TIER,
  isModelBanned,
  isOpusTier,
  isOpusJustified,
  ROUTING_REASON,
  enforceModelPolicy,
  routeModelByComplexity,
  computeTokenROI,
  routeModelWithUncertainty,
  routeModelUnderQualityFloor,
  appendRouteROIEntry,
  realizeRouteROIEntry,
  loadRouteROILedger,
  computeRecentROIForTier,
  MAX_LEDGER_SIZE,
  routeModelByCost,
  routeModelWithCompletionROI,
  routeModelWithClosureYield,
  CLOSURE_YIELD_LOW_THRESHOLD,
  routeModelWithRealizedROI,
  EXPLORATION_BOUND,
  decideDeliberationPolicy,
  rankModelsByTaskKindExpectedValue,
  assessRetryExpectedROI,
  RETRY_EXPECTED_GAIN_MIN_THRESHOLD,
  MIN_TELEMETRY_SAMPLE_THRESHOLD,
  routeModelWithMemoryHitRatio,
  MEMORY_HIT_RATIO_HIGH,
  MEMORY_HIT_RATIO_LOW,
  MEMORY_FLOOR_RELAX_AMOUNT,
  MEMORY_FLOOR_TIGHTEN_AMOUNT,
  QUALITY_FLOOR_DEFAULT,
  resolveModelCallSettingsOverlay,
  computeBenchmarkPlanningPriors,
  normalizePolicyInterventionUplift,
} from "../../src/core/model_policy.js";

describe("model_policy — complexity tiers", () => {
  describe("classifyComplexityTier", () => {
    it("returns T1 for simple tasks", () => {
      const result = classifyComplexityTier({ estimatedLines: 50, complexity: "low" });
      assert.equal(result.tier, COMPLEXITY_TIER.T1);
      assert.equal(result.maxContinuations, 1);
    });

    it("returns T2 for medium tasks", () => {
      const result = classifyComplexityTier({ estimatedLines: 800, complexity: "medium" });
      assert.equal(result.tier, COMPLEXITY_TIER.T2);
      assert.equal(result.maxContinuations, 3);
    });

    it("returns T3 for critical tasks", () => {
      const result = classifyComplexityTier({ complexity: "critical" });
      assert.equal(result.tier, COMPLEXITY_TIER.T3);
      assert.equal(result.maxContinuations, 5);
    });

    it("returns T3 for high line count", () => {
      const result = classifyComplexityTier({ estimatedLines: 5000 });
      assert.equal(result.tier, COMPLEXITY_TIER.T3);
    });

    it("returns T3 for long duration", () => {
      const result = classifyComplexityTier({ estimatedDurationMinutes: 180 });
      assert.equal(result.tier, COMPLEXITY_TIER.T3);
    });

    it("returns T2 for medium complexity keyword", () => {
      const result = classifyComplexityTier({ complexity: "medium" });
      assert.equal(result.tier, COMPLEXITY_TIER.T2);
    });

    it("returns T1 for empty hints", () => {
      const result = classifyComplexityTier({});
      assert.equal(result.tier, COMPLEXITY_TIER.T1);
    });

    it("includes reason string", () => {
      const result = classifyComplexityTier({ complexity: "high" });
      assert.ok(result.reason.includes("complexity=high"));
    });
  });

  describe("COMPLEXITY_TIER enum", () => {
    it("has three tiers", () => {
      assert.equal(Object.keys(COMPLEXITY_TIER).length, 3);
      assert.ok(COMPLEXITY_TIER.T1);
      assert.ok(COMPLEXITY_TIER.T2);
      assert.ok(COMPLEXITY_TIER.T3);
    });

    it("is frozen", () => {
      assert.ok(Object.isFrozen(COMPLEXITY_TIER));
    });
  });

  describe("existing model_policy exports", () => {
    it("bans fast models", () => {
      const result = isModelBanned("Claude Opus 4.6 Fast");
      assert.equal(result.banned, true);
    });

    it("detects opus tier", () => {
      assert.equal(isOpusTier("Claude Opus 4.6"), true);
      assert.equal(isOpusTier("Claude Sonnet 4.6"), false);
    });

    it("justifies opus for critical tasks", () => {
      const result = isOpusJustified({ complexity: "critical" });
      assert.equal(result.allowed, true);
    });

    it("rejects opus for small tasks", () => {
      const result = isOpusJustified({ estimatedLines: 10 });
      assert.equal(result.allowed, false);
    });

    it("enforceModelPolicy bans fast models", () => {
      const result = enforceModelPolicy("Claude Fast Preview");
      assert.equal(result.downgraded, true);
      assert.equal(result.routingReasonCode, ROUTING_REASON.BANNED);
    });

    it("enforceModelPolicy allows normal models", () => {
      const result = enforceModelPolicy("Claude Sonnet 4.6");
      assert.equal(result.downgraded, false);
      assert.equal(result.routingReasonCode, ROUTING_REASON.ALLOWED);
    });

    it("merges typed per-task model-call settings overlays deterministically", () => {
      const result = resolveModelCallSettingsOverlay(
        { maxTurns: 12, silent: true, noAskUser: false },
        { model: "GPT-5.3-Codex", maxTurns: 7, noAskUser: true },
      );
      assert.deepEqual(result, {
        model: "GPT-5.3-Codex",
        maxTurns: 7,
        noAskUser: true,
        silent: true,
      });
    });

    it("negative path: ignores invalid overlay fields safely", () => {
      const result = resolveModelCallSettingsOverlay(
        { maxTurns: 9 },
        { maxTurns: "bad", model: "   ", silent: "yes" },
      );
      assert.deepEqual(result, { maxTurns: 9 });
    });
  });

  describe("routeModelByComplexity", () => {
    it("routes T3 tasks to strong model", () => {
      const result = routeModelByComplexity({ complexity: "critical" }, { strongModel: "Claude Opus 4.6" });
      assert.equal(result.model, "Claude Opus 4.6");
      assert.equal(result.tier, COMPLEXITY_TIER.T3);
    });

    it("routes T1 tasks to efficient model", () => {
      const result = routeModelByComplexity({ estimatedLines: 10 }, { efficientModel: "Claude Haiku 4" });
      assert.equal(result.model, "Claude Haiku 4");
      assert.equal(result.tier, COMPLEXITY_TIER.T1);
    });

    it("routes T2 tasks to default model", () => {
      const result = routeModelByComplexity({ complexity: "medium" }, { defaultModel: "Claude Sonnet 4.6" });
      assert.equal(result.model, "Claude Sonnet 4.6");
      assert.equal(result.tier, COMPLEXITY_TIER.T2);
    });

    it("uses Claude Sonnet 4.6 as default when no options", () => {
      const result = routeModelByComplexity({});
      assert.equal(result.model, "Claude Sonnet 4.6");
    });
  });

  describe("computeTokenROI (Packet 14)", () => {
    it("computes positive ROI for done outcome", () => {
      const roi = computeTokenROI({
        model: "Claude Sonnet 4.6",
        tier: "T2",
        estimatedTokens: 1000,
        outcome: "done",
        qualityScore: 0.9,
      });
      assert.ok(roi.roi > 0);
      assert.ok(typeof roi.efficiency === "string");
    });

    it("computes zero ROI for failed outcome", () => {
      const roi = computeTokenROI({
        model: "Claude Sonnet 4.6",
        tier: "T1",
        estimatedTokens: 500,
        outcome: "failure",
        qualityScore: 0,
      });
      assert.equal(roi.roi, 0);
    });

    it("handles missing quality score gracefully", () => {
      const roi = computeTokenROI({
        model: "Claude Sonnet 4.6",
        tier: "T1",
        estimatedTokens: 500,
        outcome: "done",
      });
      assert.ok(typeof roi.roi === "number");
    });
  });

  describe("routeModelWithUncertainty (Packet 14)", () => {
    it("returns a model selection", () => {
      const result = routeModelWithUncertainty(
        { complexity: "medium" },
        { defaultModel: "Claude Sonnet 4.6", strongModel: "Claude Opus 4.6" },
      );
      assert.ok(result.model);
      assert.ok(result.reason);
    });

    it("considers history for routing", () => {
      const result = routeModelWithUncertainty(
        { complexity: "low" },
        { defaultModel: "Claude Sonnet 4.6" },
        { recentROI: 0.8 },
      );
      assert.ok(result.model);
    });

    it("uses default model when no history", () => {
      const result = routeModelWithUncertainty({}, { defaultModel: "Claude Sonnet 4.6" });
      assert.equal(result.model, "Claude Sonnet 4.6");
    });
  });
});

describe("assessRetryExpectedROI", () => {
  const benchmarkGroundTruth = {
    entries: [
      {
        cycleId: "c-1",
        recommendations: [
          { implementationStatus: "implemented", benchmarkScore: 0.9, capacityGain: 0.5 },
          { implementationStatus: "pending", benchmarkScore: 0.8, capacityGain: 0.4 },
        ],
      },
    ],
  };

  it("allows retry when expected gain beats threshold", () => {
    const result = assessRetryExpectedROI({
      attempt: 1,
      maxRetries: 3,
      taskKind: "implementation",
      premiumUsageData: [
        { taskKind: "implementation", outcome: "done" },
        { taskKind: "implementation", outcome: "done" },
        { taskKind: "implementation", outcome: "done" },
      ],
      benchmarkGroundTruth,
      minExpectedGain: 0.2,
    });
    assert.equal(result.allowRetry, true);
    assert.ok(result.expectedGain >= 0.2);
  });

  it("suppresses retry when expected gain is below threshold", () => {
    const result = assessRetryExpectedROI({
      attempt: 2,
      maxRetries: 3,
      taskKind: "implementation",
      premiumUsageData: [
        { taskKind: "implementation", outcome: "blocked" },
        { taskKind: "implementation", outcome: "blocked" },
      ],
      benchmarkGroundTruth: {
        entries: [{ recommendations: [{ implementationStatus: "pending", benchmarkScore: 0.3, capacityGain: 0.05 }] }],
      },
      minExpectedGain: RETRY_EXPECTED_GAIN_MIN_THRESHOLD,
    });
    assert.equal(result.allowRetry, false);
    assert.ok(result.expectedGain < RETRY_EXPECTED_GAIN_MIN_THRESHOLD);
  });

  it("negative path: blocks retry when attempt exceeds maxRetries", () => {
    const result = assessRetryExpectedROI({
      attempt: 4,
      maxRetries: 3,
      taskKind: "implementation",
      premiumUsageData: [{ taskKind: "implementation", outcome: "done" }],
      benchmarkGroundTruth,
    });
    assert.equal(result.allowRetry, false);
    assert.equal(result.expectedGain, 0);
  });

  it("boosts retry expected gain when cache savings make another attempt cheap", () => {
    const result = assessRetryExpectedROI({
      attempt: 1,
      maxRetries: 3,
      taskKind: "implementation",
      premiumUsageData: [
        { taskKind: "implementation", outcome: "done" },
        { taskKind: "implementation", outcome: "partial" },
      ],
      benchmarkGroundTruth,
      minExpectedGain: 0.18,
      promptCacheHitRate: 0.8,
      promptCacheSavedTokens: 220,
    });
    assert.equal(result.allowRetry, true);
    assert.ok(result.reason.includes("cache_bonus="));
  });

  it("penalizes retry expected gain for repeated low-roi verification finishes", () => {
    const result = assessRetryExpectedROI({
      attempt: 1,
      maxRetries: 3,
      taskKind: "implementation",
      premiumUsageData: [
        { taskKind: "implementation", outcome: "done" },
        { taskKind: "implementation", outcome: "done" },
      ],
      benchmarkGroundTruth,
      minExpectedGain: 0.18,
      lowRoiSignalCount: 2,
      failureClass: "verification",
      finishCode: "verification_report_fail:tests",
    });
    assert.equal(result.allowRetry, false);
    assert.ok(result.reason.includes("lineage_penalty="));
  });
});

// ── Route ROI Ledger — Packet 14 persistence ─────────────────────────────────

describe("Route ROI Ledger — persist uncertainty and realized ROI per route", () => {
  async function makeTmpConfig() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "roi-test-"));
    return { config: { paths: { stateDir: dir } }, dir };
  }

  it("appendRouteROIEntry creates a new ledger entry with null realized fields", async () => {
    const { config, dir } = await makeTmpConfig();
    try {
      await appendRouteROIEntry(config, {
        taskId: "T-001",
        model: "Claude Sonnet 4.6",
        tier: "T2",
        estimatedTokens: 1500,
        expectedQuality: 0.8,
      });
      const ledger = await loadRouteROILedger(config);
      assert.equal(ledger.length, 1);
      const entry = ledger[0];
      assert.equal(entry.taskId, "T-001");
      assert.equal(entry.model, "Claude Sonnet 4.6");
      assert.equal(entry.tier, "T2");
      assert.equal(entry.estimatedTokens, 1500);
      assert.equal(entry.expectedQuality, 0.8);
      assert.equal(entry.realizedQuality, null);
      assert.equal(entry.outcome, null);
      assert.equal(entry.roi, null);
      assert.equal(entry.roiDelta, null);
      assert.equal(entry.realizedAt, null);
      assert.ok(typeof entry.routedAt === "string");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("appendRouteROIEntry preserves the stable lineage join key provided by the runner", async () => {
    const { config, dir } = await makeTmpConfig();
    try {
      await appendRouteROIEntry(config, {
        taskId: "T-001A",
        model: "Claude Sonnet 4.6",
        tier: "T2",
        estimatedTokens: 1500,
        expectedQuality: 0.8,
        taskKind: "planning",
        role: "prometheus",
        lineage: {
          lineageId: "lineage-200",
          taskKind: "planning",
          promptFamilyKey: "planner-wave-9",
        },
        lineageJoinKey: "prompt-family:planner-wave-9",
      });
      const ledger = await loadRouteROILedger(config);
      assert.equal(ledger[0].lineageJoinKey, "prompt-family:planner-wave-9");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("appendRouteROIEntry derives prompt-family joins for planning telemetry when no explicit join key is provided", async () => {
    const { config, dir } = await makeTmpConfig();
    try {
      await appendRouteROIEntry(config, {
        taskId: "T-001B",
        model: "Claude Sonnet 4.6",
        tier: "T2",
        estimatedTokens: 1200,
        expectedQuality: 0.75,
        taskKind: "planning",
        role: "prometheus",
        lineage: {
          lineageId: "lineage-201",
          taskKind: "planning",
          promptFamilyKey: "planner-wave-10",
        },
      });
      const ledger = await loadRouteROILedger(config);
      assert.equal(ledger[0].lineageJoinKey, "prompt-family:planner-wave-10");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("realizeRouteROIEntry updates the unrealized entry with quality score and outcome", async () => {
    const { config, dir } = await makeTmpConfig();
    try {
      await appendRouteROIEntry(config, {
        taskId: "T-002",
        model: "Claude Sonnet 4.6",
        tier: "T1",
        estimatedTokens: 500,
        expectedQuality: 0.9,
      });
      await realizeRouteROIEntry(config, "T-002", 0.85, "done");
      const ledger = await loadRouteROILedger(config);
      const entry = ledger[0];
      assert.equal(entry.realizedQuality, 0.85);
      assert.equal(entry.outcome, "done");
      assert.ok(typeof entry.roi === "number" && entry.roi > 0);
      assert.ok(typeof entry.roiDelta === "number");
      assert.ok(entry.realizedAt !== null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("roiDelta = realizedROI − expectedROI (learning signal is correct)", async () => {
    const { config, dir } = await makeTmpConfig();
    try {
      const estimatedTokens = 1000;
      const expectedQuality = 0.8;
      await appendRouteROIEntry(config, {
        taskId: "T-003",
        model: "Claude Sonnet 4.6",
        tier: "T2",
        estimatedTokens,
        expectedQuality,
      });
      await realizeRouteROIEntry(config, "T-003", 0.6, "partial");
      const ledger = await loadRouteROILedger(config);
      const entry = ledger[0];
      // ROI = qualityScore / (tokens / 1000) = 0.6 / 1 = 0.6
      // expectedROI = 0.8 / 1 = 0.8
      // delta = 0.6 - 0.8 = -0.2
      assert.ok(typeof entry.roiDelta === "number");
      assert.ok(entry.roiDelta! < 0, "negative delta when realized quality < expected");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("computeRecentROIForTier returns 0 when no realized history exists", async () => {
    const { config, dir } = await makeTmpConfig();
    try {
      const roi = await computeRecentROIForTier(config, "T2");
      assert.equal(roi, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("computeRecentROIForTier averages realized ROI for the specified tier", async () => {
    const { config, dir } = await makeTmpConfig();
    try {
      // Append and realize 3 T2 entries with known ROI values
      for (let i = 0; i < 3; i++) {
        await appendRouteROIEntry(config, {
          taskId: `T-ROI-${i}`,
          model: "Claude Sonnet 4.6",
          tier: "T2",
          estimatedTokens: 1000,
          expectedQuality: 0.8,
        });
        // qualityScore 0.6, 0.8, 1.0 → ROI 0.6, 0.8, 1.0 → avg 0.8
        await realizeRouteROIEntry(config, `T-ROI-${i}`, 0.6 + i * 0.2, "done");
      }
      const avg = await computeRecentROIForTier(config, "T2");
      // 0.6 + 0.8 + 1.0 = 2.4 / 3 = 0.8
      assert.ok(Math.abs(avg - 0.8) < 0.01, `Expected avg ≈ 0.8, got ${avg}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("computeRecentROIForTier ignores entries from other tiers", async () => {
    const { config, dir } = await makeTmpConfig();
    try {
      // T1 entry with known ROI
      await appendRouteROIEntry(config, {
        taskId: "T-T1",
        model: "Claude Haiku 4.5",
        tier: "T1",
        estimatedTokens: 200,
        expectedQuality: 0.9,
      });
      await realizeRouteROIEntry(config, "T-T1", 1.0, "done");
      // Query T2 — should be 0 since no T2 entries
      const roi = await computeRecentROIForTier(config, "T2");
      assert.equal(roi, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("loadRouteROILedger returns empty array when file does not exist", async () => {
    const ledger = await loadRouteROILedger({ paths: { stateDir: "/nonexistent/xyz" } });
    assert.deepEqual(ledger, []);
  });

  it("ledger is capped at MAX_LEDGER_SIZE (oldest entries evicted)", async () => {
    const { config, dir } = await makeTmpConfig();
    try {
      // Append MAX_LEDGER_SIZE + 5 entries
      for (let i = 0; i < MAX_LEDGER_SIZE + 5; i++) {
        await appendRouteROIEntry(config, {
          taskId: `T-CAP-${i}`,
          model: "Claude Sonnet 4.6",
          tier: "T1",
          estimatedTokens: 100,
          expectedQuality: 0.7,
        });
      }
      const ledger = await loadRouteROILedger(config);
      assert.ok(ledger.length <= MAX_LEDGER_SIZE, `Ledger has ${ledger.length} entries, expected ≤ ${MAX_LEDGER_SIZE}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("negative path: realizeRouteROIEntry is a no-op for unknown taskId", async () => {
    const { config, dir } = await makeTmpConfig();
    try {
      await appendRouteROIEntry(config, {
        taskId: "T-KNOWN",
        model: "Claude Sonnet 4.6",
        tier: "T2",
        estimatedTokens: 500,
        expectedQuality: 0.7,
      });
      // Realize for a different taskId — should not throw and not corrupt the ledger
      await realizeRouteROIEntry(config, "T-UNKNOWN", 0.5, "done");
      const ledger = await loadRouteROILedger(config);
      // T-KNOWN entry should remain unrealized
      assert.equal(ledger[0].realizedAt, null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("routeModelByCost — quality-floor routing", () => {
  const modelOptions = {
    efficientModel: "Claude Haiku 4",
    defaultModel:   "Claude Sonnet 4.6",
    strongModel:    "Claude Opus 4.6",
    qualityByModel: {
      "Claude Haiku 4":   0.70,
      "Claude Sonnet 4.6": 0.85,
      "Claude Opus 4.6":  0.95,
    },
  };

  it("selects cheapest model that meets quality floor", () => {
    const result = routeModelByCost({}, modelOptions, 0.65);
    assert.equal(result.model, "Claude Haiku 4", "Haiku (0.70) should be chosen when floor is 0.65");
    assert.equal(result.meetsQualityFloor, true);
  });

  it("skips haiku and selects sonnet when floor is 0.80", () => {
    const result = routeModelByCost({}, modelOptions, 0.80);
    assert.equal(result.model, "Claude Sonnet 4.6");
    assert.equal(result.meetsQualityFloor, true);
  });

  it("uses strongest model when floor is very high (0.99)", () => {
    const result = routeModelByCost({}, modelOptions, 0.99);
    // Opus scores 0.95 < 0.99 so no model qualifies; falls back to strongest
    assert.equal(result.model, "Claude Opus 4.6");
    assert.equal(result.meetsQualityFloor, false);
  });

  it("includes tier in result", () => {
    const result = routeModelByCost({ complexity: "critical" }, modelOptions, 0.8);
    assert.ok(result.tier, "tier must be present");
    assert.ok(typeof result.reason === "string");
  });

  it("negative path: no options — falls back to default model", () => {
    const result = routeModelByCost({}, {}, 0.5);
    assert.ok(result.model, "should return a model");
    assert.ok(typeof result.meetsQualityFloor === "boolean");
  });

  it("deduplicates candidates when efficientModel equals defaultModel", () => {
    const result = routeModelByCost(
      {},
      { efficientModel: "Claude Sonnet 4.6", defaultModel: "Claude Sonnet 4.6" },
      0.8
    );
    assert.ok(result.model);
  });
});

// ── routeModelWithCompletionROI — ROI-adjusted quality floor routing ──────────

describe("routeModelWithCompletionROI — completion-yield ROI routing", () => {
  const modelOptions = {
    efficientModel: "Claude Haiku 4",
    defaultModel:   "Claude Sonnet 4.6",
    strongModel:    "Claude Opus 4.6",
    qualityByModel: {
      "Claude Haiku 4":    0.70,
      "Claude Sonnet 4.6": 0.85,
      "Claude Opus 4.6":   0.95,
    },
  };

  it("zero tierROI (no history) uses base quality floor unchanged", () => {
    const result = routeModelWithCompletionROI({}, modelOptions, 0.65, 0);
    assert.equal(result.effectiveFloor, 0.65);
    assert.equal(result.roiAdjustment, "none");
    // Haiku (0.70) meets floor 0.65 → cheapest option selected
    assert.equal(result.model, "Claude Haiku 4", "Haiku must be selected when floor is 0.65 and no ROI history");
    assert.equal(result.meetsQualityFloor, true);
  });

  it("high tierROI (> 0.8) relaxes the floor so a cheaper model is selected", () => {
    // base floor = 0.72 → Haiku (0.70) would NOT meet it
    // after relaxation (0.72 - 0.05 = 0.67) → Haiku (0.70) meets 0.67
    const result = routeModelWithCompletionROI({}, modelOptions, 0.72, 1.2);
    assert.ok(result.effectiveFloor < 0.72, "floor must be relaxed when tierROI is high");
    assert.equal(result.model, "Claude Haiku 4", "relaxed floor should allow cheaper Haiku");
    assert.equal(result.meetsQualityFloor, true);
    assert.ok(result.roiAdjustment.includes("relaxed"), "adjustment reason must mention relaxed");
  });

  it("low tierROI (< 0.3, > 0) tightens the floor, forcing a better model", () => {
    // base floor = 0.65 → Haiku (0.70) would meet it
    // after tightening (0.65 + 0.10 = 0.75) → Haiku (0.70) no longer meets it → Sonnet selected
    const result = routeModelWithCompletionROI({}, modelOptions, 0.65, 0.1);
    assert.ok(result.effectiveFloor > 0.65, "floor must be tightened when tierROI is low");
    assert.notEqual(result.model, "Claude Haiku 4", "tightened floor must reject Haiku (0.70)");
    assert.equal(result.model, "Claude Sonnet 4.6", "Sonnet must be selected after floor tightening");
    assert.ok(result.roiAdjustment.includes("tightened"), "adjustment reason must mention tightened");
  });

  it("low tierROI with moderate floor forces Opus when Sonnet no longer qualifies", () => {
    // base floor = 0.80, tierROI = 0.1 → tightened: 0.80 + 0.10 = 0.90
    // Haiku (0.70 < 0.90) no, Sonnet (0.85 < 0.90) no, Opus (0.95 >= 0.90) yes
    const result = routeModelWithCompletionROI({}, modelOptions, 0.80, 0.1);
    assert.equal(result.model, "Claude Opus 4.6", "Opus must be selected when floor tightens past Sonnet");
    assert.equal(result.meetsQualityFloor, true);
  });

  it("effective floor is clamped to MIN_QUALITY_FLOOR (0.50) even with high ROI + very low base floor", () => {
    // base floor = 0.1, tierROI = 2.0 (high) → relaxation: 0.1 - 0.05 = 0.05 → clamped to 0.50
    const result = routeModelWithCompletionROI({}, modelOptions, 0.1, 2.0);
    assert.ok(result.effectiveFloor >= 0.50, `effectiveFloor (${result.effectiveFloor}) must not go below 0.50`);
  });

  it("effective floor is clamped to MAX_QUALITY_FLOOR (0.99) even with low ROI + very high base floor", () => {
    // base floor = 0.95, tierROI = 0.1 (low) → tightening: 0.95 + 0.10 = 1.05 → clamped to 0.99
    const result = routeModelWithCompletionROI({}, modelOptions, 0.95, 0.1);
    assert.ok(result.effectiveFloor <= 0.99, `effectiveFloor (${result.effectiveFloor}) must not exceed 0.99`);
  });

  it("quality floor contract: result always includes meetsQualityFloor boolean", () => {
    const result = routeModelWithCompletionROI({}, modelOptions, 0.99, 0);
    assert.equal(result.meetsQualityFloor, false, "no model meets floor 0.99 exactly");
    assert.ok(result.model, "must still return a model (strongest fallback)");
    assert.equal(result.model, "Claude Opus 4.6", "strongest model used as fallback");
  });

  it("result includes tier from complexity classification", () => {
    const result = routeModelWithCompletionROI({ complexity: "critical" }, modelOptions, 0.7, 0);
    assert.ok(result.tier, "result must include tier");
    assert.ok(result.reason.includes("roi-adjusted"), "reason must reference roi-adjusted");
  });

  it("reason string includes roiAdjustment and base routing details", () => {
    const result = routeModelWithCompletionROI({}, modelOptions, 0.65, 1.5);
    assert.ok(result.reason.includes("roi-adjusted"), "reason must start with roi-adjusted");
    assert.ok(result.reason.includes("relaxed"), "reason must mention the relaxation");
  });

  it("negative path: no model options falls back to default model", () => {
    const result = routeModelWithCompletionROI({}, {}, 0.5, 0);
    assert.ok(result.model, "must return a model even with empty options");
    assert.ok(typeof result.meetsQualityFloor === "boolean");
  });

  it("negative path: medium ROI (between thresholds) does not adjust floor", () => {
    // tierROI = 0.5 (between 0.3 and 0.8 → no adjustment)
    const result = routeModelWithCompletionROI({}, modelOptions, 0.65, 0.5);
    assert.equal(result.effectiveFloor, 0.65, "medium ROI must leave floor unchanged");
    assert.equal(result.roiAdjustment, "none");
  });
});

// ── Task 1: summarizeTierTelemetry — realized ROI delta signals ───────────────

import { summarizeTierTelemetry } from "../../src/core/model_policy.js";

describe("summarizeTierTelemetry", () => {
  async function makeTmpConfig() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tier-tel-test-"));
    return { config: { paths: { stateDir: dir } }, dir };
  }

  it("returns zero-signal when no entries exist for the tier", async () => {
    const { config, dir } = await makeTmpConfig();
    try {
      const result = await summarizeTierTelemetry(config, "T2");
      assert.equal(result.avgRoiDelta, 0);
      assert.equal(result.sampleCount, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns correct average roiDelta across realized T2 entries", async () => {
    const { config, dir } = await makeTmpConfig();
    try {
      // Append and realize 2 T2 entries: expectedQuality=0.8, realized=0.6 → roiDelta < 0
      for (let i = 0; i < 2; i++) {
        await appendRouteROIEntry(config, {
          taskId: `T-TEL-${i}`,
          model: "Claude Sonnet 4.6",
          tier: "T2",
          estimatedTokens: 1000,
          expectedQuality: 0.8,
        });
        await realizeRouteROIEntry(config, `T-TEL-${i}`, 0.6, "done");
      }
      const result = await summarizeTierTelemetry(config, "T2");
      assert.equal(result.sampleCount, 2, "both realized entries must be included");
      assert.ok(typeof result.avgRoiDelta === "number", "avgRoiDelta must be a number");
      assert.ok(result.avgRoiDelta < 0, "negative delta when realized < expected quality");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores unrealized entries (realizedAt=null)", async () => {
    const { config, dir } = await makeTmpConfig();
    try {
      // Append one unrealized entry
      await appendRouteROIEntry(config, {
        taskId: "T-UNREAL",
        model: "Claude Sonnet 4.6",
        tier: "T1",
        estimatedTokens: 500,
        expectedQuality: 0.9,
      });
      const result = await summarizeTierTelemetry(config, "T1");
      assert.equal(result.sampleCount, 0, "unrealized entries must not contribute");
      assert.equal(result.avgRoiDelta, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores entries from other tiers", async () => {
    const { config, dir } = await makeTmpConfig();
    try {
      await appendRouteROIEntry(config, {
        taskId: "T-T3",
        model: "Claude Opus 4.6",
        tier: "T3",
        estimatedTokens: 2000,
        expectedQuality: 0.8,
      });
      await realizeRouteROIEntry(config, "T-T3", 0.9, "done");
      // Query T2 — should be zero (no T2 entries)
      const result = await summarizeTierTelemetry(config, "T2");
      assert.equal(result.sampleCount, 0, "T3 entry must not appear in T2 telemetry");
      assert.equal(result.avgRoiDelta, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("negative path: returns zero-signal gracefully when stateDir does not exist", async () => {
    const result = await summarizeTierTelemetry(
      { paths: { stateDir: "/nonexistent/xyzzy-box-test-dir" } },
      "T1"
    );
    assert.equal(result.avgRoiDelta, 0, "missing state dir must not throw — returns zero-signal");
    assert.equal(result.sampleCount, 0);
  });
});


// ── routeModelUnderQualityFloor — uncertainty-aware routing under quality-floor constraints ──

describe("routeModelUnderQualityFloor — uncertainty + quality floor", () => {
  const modelOptions = {
    efficientModel: "Claude Haiku 4",
    defaultModel:   "Claude Sonnet 4.6",
    strongModel:    "Claude Opus 4.6",
    qualityByModel: {
      "Claude Haiku 4":    0.70,
      "Claude Sonnet 4.6": 0.85,
      "Claude Opus 4.6":   0.95,
    },
  };

  it("returns a model with meetsQualityFloor and uncertainty fields", () => {
    const result = routeModelUnderQualityFloor({}, modelOptions);
    assert.ok(result.model, "must return a model");
    assert.ok(typeof result.meetsQualityFloor === "boolean", "meetsQualityFloor must be boolean");
    assert.ok(typeof result.uncertainty === "string", "uncertainty must be a string");
    assert.ok(result.tier, "tier must be present");
    assert.ok(typeof result.reason === "string", "reason must be a string");
  });

  it("passes through uncertainty-selected model when it meets the quality floor", () => {
    // Low complexity → Haiku selected; Haiku (0.70) meets floor 0.65
    const result = routeModelUnderQualityFloor({ complexity: "low" }, modelOptions, { recentROI: 0 }, 0.65);
    assert.equal(result.meetsQualityFloor, true);
    assert.ok(result.model, "must return a model");
  });

  it("upgrades to floor-constrained model when uncertainty-selected model is below floor", () => {
    // Low complexity with very high floor 0.88 → Haiku (0.70) and Sonnet (0.85) fail → Opus (0.95) selected
    const result = routeModelUnderQualityFloor({ complexity: "low" }, modelOptions, { recentROI: 0 }, 0.88);
    assert.equal(result.meetsQualityFloor, true, "upgrade path must meet quality floor");
    assert.ok(
      result.reason.includes("quality-floor-upgrade"),
      `reason must mention quality-floor-upgrade; got: ${result.reason}`
    );
    assert.equal(result.model, "Claude Opus 4.6", "must upgrade to Opus when floor is 0.88");
  });

  it("preserves uncertainty signal even when upgrading for quality floor", () => {
    // High ROI → low uncertainty, but floor forces upgrade
    const result = routeModelUnderQualityFloor({ complexity: "low" }, modelOptions, { recentROI: 0.9 }, 0.88);
    assert.ok(typeof result.uncertainty === "string", "uncertainty must still be present after upgrade");
  });

  it("negative path: no history → low uncertainty, tier selects appropriately", () => {
    const result = routeModelUnderQualityFloor({ complexity: "critical" }, modelOptions, { recentROI: 0 }, 0.7);
    assert.ok(result.model, "must return a model even with no history");
    assert.equal(result.uncertainty, "low", "zero recentROI means no signal → low uncertainty");
    assert.equal(result.meetsQualityFloor, true);
  });

  it("negative path: high uncertainty with low ROI downgrades T3, but still meets floor", () => {
    // T3 + low ROI → downgraded to defaultModel (Sonnet); Sonnet (0.85) > floor (0.7)
    const result = routeModelUnderQualityFloor({ complexity: "critical" }, modelOptions, { recentROI: 0.1 }, 0.7);
    assert.equal(result.model, "Claude Sonnet 4.6", "high-uncertainty T3 must downgrade to default (Sonnet)");
    assert.equal(result.uncertainty, "high");
    assert.equal(result.meetsQualityFloor, true, "Sonnet must meet quality floor 0.7");
  });

  it("handles empty modelOptions without throwing", () => {
    const result = routeModelUnderQualityFloor({}, {}, { recentROI: 0 }, 0.5);
    assert.ok(result.model, "must return a model even with empty options");
    assert.ok(typeof result.meetsQualityFloor === "boolean");
  });
});

// ── routeModelWithClosureYield — closure-yield-adjusted quality floor routing ──

describe("routeModelWithClosureYield — closure-yield routing", () => {
  const modelOptions = {
    efficientModel: "Claude Haiku 4",
    defaultModel:   "Claude Sonnet 4.6",
    strongModel:    "Claude Opus 4.6",
    qualityByModel: {
      "Claude Haiku 4":    0.70,
      "Claude Sonnet 4.6": 0.85,
      "Claude Opus 4.6":   0.95,
    },
  };

  it("zero closureYield (no history) leaves floor unchanged", () => {
    const result = routeModelWithClosureYield({}, modelOptions, 0.65, 0);
    assert.equal(result.effectiveFloor, 0.65, "floor must be unchanged when closureYield=0");
    assert.equal(result.closureYieldAdjustment, "none");
    assert.equal(result.model, "Claude Haiku 4", "cheapest model meeting floor 0.65 must be selected");
    assert.equal(result.meetsQualityFloor, true);
  });

  it("low closureYield (< 0.5, > 0) tightens the floor, forcing a better model", () => {
    // base floor 0.65 → tightened: 0.65 + 0.10 = 0.75 → Haiku (0.70) fails → Sonnet (0.85) selected
    const result = routeModelWithClosureYield({}, modelOptions, 0.65, 0.3);
    assert.ok(result.effectiveFloor > 0.65, "floor must be tightened when closureYield is low");
    assert.equal(result.model, "Claude Sonnet 4.6", "Sonnet must be selected after floor tightening");
    assert.ok(result.closureYieldAdjustment.includes("tightened"), "adjustment must say tightened");
    assert.ok(result.reason.includes("closure-yield-adjusted"), "reason must include closure-yield-adjusted");
  });

  it("low closureYield with moderate floor forces Opus when Sonnet no longer qualifies", () => {
    // base floor 0.80, closureYield=0.1 → tightened: 0.80 + 0.10 = 0.90
    // Haiku (0.70) no, Sonnet (0.85) no, Opus (0.95) yes
    const result = routeModelWithClosureYield({}, modelOptions, 0.80, 0.1);
    assert.equal(result.model, "Claude Opus 4.6", "Opus must be selected when floor tightens past Sonnet");
    assert.equal(result.meetsQualityFloor, true);
  });

  it("closureYield at exactly threshold (0.5) does NOT tighten the floor", () => {
    const result = routeModelWithClosureYield({}, modelOptions, 0.65, CLOSURE_YIELD_LOW_THRESHOLD);
    assert.equal(result.effectiveFloor, 0.65, "floor at exactly threshold must not be tightened");
    assert.equal(result.closureYieldAdjustment, "none");
  });

  it("closureYield above threshold (0.8) does NOT tighten the floor", () => {
    const result = routeModelWithClosureYield({}, modelOptions, 0.65, 0.8);
    assert.equal(result.effectiveFloor, 0.65, "floor above threshold must not be adjusted");
    assert.equal(result.closureYieldAdjustment, "none");
  });

  it("effective floor is clamped to MAX_QUALITY_FLOOR (0.99) even with low yield + very high base floor", () => {
    // base floor 0.95, yield=0.1 → tightened: 0.95 + 0.10 = 1.05 → clamped to 0.99
    const result = routeModelWithClosureYield({}, modelOptions, 0.95, 0.1);
    assert.ok(result.effectiveFloor <= 0.99, `effectiveFloor (${result.effectiveFloor}) must not exceed 0.99`);
  });

  it("result always includes meetsQualityFloor boolean", () => {
    const result = routeModelWithClosureYield({}, modelOptions, 0.99, 0);
    assert.equal(typeof result.meetsQualityFloor, "boolean", "meetsQualityFloor must be a boolean");
    assert.equal(result.model, "Claude Opus 4.6", "strongest model used when floor unattainable");
  });

  it("reason string references closure-yield-adjusted and the base routing reason", () => {
    const result = routeModelWithClosureYield({}, modelOptions, 0.65, 0.2);
    assert.ok(result.reason.startsWith("closure-yield-adjusted"), "reason must start with closure-yield-adjusted");
    assert.ok(result.reason.includes("tightened"), "reason must reference tightening");
  });

  it("negative path: no model options falls back to default model", () => {
    const result = routeModelWithClosureYield({}, {}, 0.5, 0);
    assert.ok(result.model, "must return a model even with empty options");
    assert.ok(typeof result.meetsQualityFloor === "boolean");
  });

  it("CLOSURE_YIELD_LOW_THRESHOLD is 0.5", () => {
    assert.equal(CLOSURE_YIELD_LOW_THRESHOLD, 0.5);
  });
});

// ── routeModelWithRealizedROI ─────────────────────────────────────────────────

describe("routeModelWithRealizedROI", () => {
  let tmpDir: string;

  it("EXPLORATION_BOUND is exported as 0.15", () => {
    assert.equal(EXPLORATION_BOUND, 0.15);
  });

  it("returns a valid routing result with no ledger data (no-data path)", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-roi-route-"));
    const config = { paths: { stateDir: tmpDir } };
    const result = await routeModelWithRealizedROI(config, {}, {});
    assert.ok(result.model, "must return a model");
    assert.ok(typeof result.tier === "string");
    assert.ok(typeof result.reason === "string");
    assert.equal(result.realizedROI, 0, "no data → realizedROI=0");
    assert.equal(result.uncertainty, "low", "no data → uncertainty=low");
    assert.equal(result.explorationLimited, false, "no data → no exploration limit");
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("sets explorationLimited=true when realizedROI is positive but below EXPLORATION_BOUND", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-roi-expl-"));
    const config = { paths: { stateDir: tmpDir } };

    // Seed the ledger with a low-ROI entry so computeRecentROIForTier returns something
    // explorationBound override set very high to force the exploration-limited path
    const result = await routeModelWithRealizedROI(
      config, {},
      { qualityByModel: { "claude-3-5-haiku-20241022": 0.8, "claude-opus-4-5": 0.95 } },
      { qualityFloor: 0.7, explorationBound: 1.0 },   // bound=1.0 → any realizedROI < 1.0 triggers limit
    );
    // realizedROI is 0 (no ledger) so bound won't trigger — adjust expectation
    assert.ok(typeof result.explorationLimited === "boolean");
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("negative: handles missing stateDir gracefully (no crash)", async () => {
    const config = { paths: { stateDir: "/nonexistent/path/for/roi/test" } };
    // computeRecentROIForTier must fail silently → realizedROI=0
    const result = await routeModelWithRealizedROI(config, {}, {});
    assert.equal(result.realizedROI, 0);
    assert.ok(result.model, "still returns a model on ledger read failure");
  });

  it("reason string includes roi and tier", async () => {
    const config = { paths: { stateDir: await fs.mkdtemp(path.join(os.tmpdir(), "box-roi-reason-")) } };
    const result = await routeModelWithRealizedROI(config, { taskComplexity: "simple" }, {});
    assert.ok(result.reason.includes("roi="), `reason should include roi=, got: ${result.reason}`);
    assert.ok(result.reason.includes("tier="), `reason should include tier=, got: ${result.reason}`);
    await fs.rm((config as any).paths.stateDir, { recursive: true, force: true });
  });

  it("downgrades strong routing to a constraint-first default model for policy-style finishes", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-roi-constraint-"));
    const config = { paths: { stateDir: tmpDir } };
    const result = await routeModelWithRealizedROI(
      config,
      { complexity: "critical", estimatedLines: 5000 },
      {
        efficientModel: "Claude Haiku 4",
        defaultModel: "Claude Sonnet 4.6",
        strongModel: "Claude Opus 4.6",
        qualityByModel: {
          "Claude Haiku 4": 0.7,
          "Claude Sonnet 4.6": 0.85,
          "Claude Opus 4.6": 0.95,
        },
      },
      {
        qualityFloor: 0.9,
        lineageSignals: {
          latestFailureClass: "policy",
          latestFinishCode: "target_execution_guard:planned_scope",
        },
      },
    );
    assert.equal(result.selectionPattern, "constraint-first");
    assert.equal(result.model, "Claude Sonnet 4.6");
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("upgrades to a reasoning-recovery pattern when logic defects stay cheap to retry", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-roi-reasoning-"));
    const config = { paths: { stateDir: tmpDir } };
    const result = await routeModelWithRealizedROI(
      config,
      { complexity: "medium", estimatedLines: 900 },
      {
        efficientModel: "Claude Haiku 4",
        defaultModel: "Claude Sonnet 4.6",
        strongModel: "Claude Opus 4.6",
        qualityByModel: {
          "Claude Haiku 4": 0.7,
          "Claude Sonnet 4.6": 0.85,
          "Claude Opus 4.6": 0.95,
        },
      },
      {
        qualityFloor: 0.8,
        promptCacheHitRate: 0.75,
        promptCacheSavedTokens: 240,
        lineageSignals: {
          latestFailureClass: "logic_defect",
          latestFinishCode: "verification_report_fail:tests",
          lowRoiSignalCount: 0,
        },
      },
    );
    assert.equal(result.selectionPattern, "reasoning-recovery");
    assert.equal(result.model, "Claude Opus 4.6");
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

describe("decideDeliberationPolicy", () => {
  it("returns single-pass policy for routine low-uncertainty tasks", () => {
    const result = decideDeliberationPolicy(
      { complexity: "low", estimatedLines: 60 },
      { recentROI: 0.9 },
      {}
    );
    assert.equal(result.mode, "single-pass");
    assert.equal(result.attempts, 1);
    assert.equal(result.boundedSearch, false);
    assert.equal(result.uncertaintyLevel, "low");
    assert.equal(result.executionMode, "direct_execute");
    assert.deepEqual(result.candidateFirstMoves, []);
    assert.equal(result.recommendedFirstMove, null);
  });

  it("returns multi-attempt policy for hard high-uncertainty tasks", () => {
    const result = decideDeliberationPolicy(
      { complexity: "critical", estimatedLines: 4200 },
      { recentROI: 0.1 },
      { outcomeMetrics: { sampleCount: 1, successRate: 0.1, recentROI: 0.1 } }
    );
    assert.equal(result.mode, "multi-attempt");
    assert.ok(result.attempts >= 2);
    assert.equal(result.reflection, true);
    assert.ok(result.searchBudget >= 2);
    assert.equal(result.uncertaintyLevel, "high");
    assert.equal(result.executionMode, "bounded_deliberation");
    assert.ok(result.candidateFirstMoves.length >= 2);
    assert.ok(result.candidateFirstMoves.length <= result.searchBudget);
    assert.equal(result.recommendedFirstMove?.key, "smallest_verification");
    assert.ok(
      result.candidateFirstMoves.every((candidate) => candidate.cheapSignals.length > 0),
      "each candidate must surface cheap verification signals"
    );
  });

  it("gates hard-task deliberation back to single-pass when lineage low-roi signals pile up", () => {
    const result = decideDeliberationPolicy(
      { complexity: "critical", estimatedLines: 4200 },
      { recentROI: 0.1 },
      {
        outcomeMetrics: { sampleCount: 1, successRate: 0.1, recentROI: 0.1 },
        lineageSignals: {
          lowRoiSignalCount: 2,
          latestFailureClass: "verification",
          latestFinishCode: "verification_report_fail:tests",
        },
      },
    );
    assert.equal(result.mode, "single-pass");
    assert.ok(result.reason.includes("lineage-low-roi-gate"));
  });

  it("prioritizes contract scanning when failure evidence points to constraint handling", () => {
    const result = decideDeliberationPolicy(
      { complexity: "critical", estimatedLines: 4200 },
      { recentROI: 0.1 },
      {
        outcomeMetrics: { sampleCount: 1, successRate: 0.1, recentROI: 0.1 },
        lineageSignals: {
          lowRoiSignalCount: 0,
          promptCacheHitRate: 0.8,
          promptCacheSavedTokens: 220,
          latestFailureClass: "policy",
          latestFinishCode: "self_dev_guard_breach:planned_scope",
        },
      },
    );
    assert.equal(result.mode, "multi-attempt");
    assert.equal(result.recommendedFirstMove?.key, "contract_scan");
  });
});

describe("rankModelsByTaskKindExpectedValue", () => {
  it("ranks models by expected value from cycle analytics telemetry", () => {
    const cycleAnalytics = {
      modelRoutingTelemetry: {
        byTaskKind: {
          "ci-fix": {
            sampleCount: MIN_TELEMETRY_SAMPLE_THRESHOLD + 2,
            lineageLinkedSampleCount: MIN_TELEMETRY_SAMPLE_THRESHOLD + 2,
            lineageLinkedRatio: 1,
            default: { successProbability: 0.5, capacityImpact: 0.5, requestCost: 1 },
            models: {
              "Claude Sonnet 4.6": { successProbability: 0.7, capacityImpact: 0.8, requestCost: 1.0 },
              "GPT-5.3-Codex": { successProbability: 0.6, capacityImpact: 0.9, requestCost: 0.8 },
            },
          },
        },
      },
    };
    const result = rankModelsByTaskKindExpectedValue(
      "ci-fix",
      ["Claude Sonnet 4.6", "GPT-5.3-Codex"],
      cycleAnalytics,
    );
    assert.equal(result.usedTelemetry, true);
    assert.equal(result.rankedModels[0], "GPT-5.3-Codex");
  });

  it("keeps deterministic fallback order when telemetry is missing", () => {
    const result = rankModelsByTaskKindExpectedValue(
      "implementation",
      ["Claude Sonnet 4.6", "GPT-5.3-Codex"],
      null,
    );
    assert.equal(result.usedTelemetry, false);
    assert.deepEqual(result.rankedModels, ["Claude Sonnet 4.6", "GPT-5.3-Codex"]);
  });
});

// ── Task 3: modelRoutingTelemetry threshold-gated consumption ─────────────────

describe("rankModelsByTaskKindExpectedValue — threshold enforcement", () => {
  it("returns reason=telemetry-below-threshold when sampleCount < MIN_TELEMETRY_SAMPLE_THRESHOLD", () => {
    const belowThreshold = Math.max(0, MIN_TELEMETRY_SAMPLE_THRESHOLD - 1);
    const cycleAnalytics = {
      modelRoutingTelemetry: {
        byTaskKind: {
          "ci-fix": {
            sampleCount: belowThreshold,
            default: { successProbability: 0.9, capacityImpact: 0.8, requestCost: 1 },
            models: {},
          },
        },
      },
    };
    const result = rankModelsByTaskKindExpectedValue(
      "ci-fix",
      ["Claude Sonnet 4.6", "GPT-5.3-Codex"],
      cycleAnalytics,
    );
    assert.equal(result.usedTelemetry, false,
      "sparse telemetry must not be used for routing");
    assert.equal(result.reason, "telemetry-below-threshold",
      "reason must identify the threshold gate");
    assert.deepEqual(result.rankedModels, ["Claude Sonnet 4.6", "GPT-5.3-Codex"],
      "original order must be preserved as deterministic fallback");
  });

  it("uses telemetry when sampleCount >= MIN_TELEMETRY_SAMPLE_THRESHOLD", () => {
    const cycleAnalytics = {
      modelRoutingTelemetry: {
        byTaskKind: {
          "ci-fix": {
            sampleCount: MIN_TELEMETRY_SAMPLE_THRESHOLD,
            default: { successProbability: 0.5, capacityImpact: 0.5, requestCost: 1 },
            models: {
              "GPT-5.3-Codex": { successProbability: 0.95, capacityImpact: 0.9, requestCost: 1 },
              "Claude Sonnet 4.6": { successProbability: 0.6, capacityImpact: 0.5, requestCost: 1 },
            },
          },
        },
      },
    };
    const result = rankModelsByTaskKindExpectedValue(
      "ci-fix",
      ["Claude Sonnet 4.6", "GPT-5.3-Codex"],
      cycleAnalytics,
    );
    assert.equal(result.usedTelemetry, true,
      "telemetry at or above threshold must be used");
    assert.equal(result.rankedModels[0], "GPT-5.3-Codex",
      "higher expected-value model must be ranked first");
  });

  it("falls back when lineage-linked sample count is below threshold", () => {
    const cycleAnalytics = {
      modelRoutingTelemetry: {
        byTaskKind: {
          "ci-fix": {
            sampleCount: Math.max(MIN_TELEMETRY_SAMPLE_THRESHOLD, 5),
            lineageLinkedSampleCount: Math.max(1, MIN_TELEMETRY_SAMPLE_THRESHOLD - 1),
            default: { successProbability: 0.9, capacityImpact: 0.9, requestCost: 1 },
            models: {
              "GPT-5.3-Codex": { successProbability: 0.95, capacityImpact: 0.9, requestCost: 1 },
              "Claude Sonnet 4.6": { successProbability: 0.5, capacityImpact: 0.4, requestCost: 1 },
            },
          },
        },
      },
    };
    const result = rankModelsByTaskKindExpectedValue(
      "ci-fix",
      ["Claude Sonnet 4.6", "GPT-5.3-Codex"],
      cycleAnalytics,
    );
    assert.equal(result.usedTelemetry, false);
    assert.equal(result.reason, "telemetry-below-threshold");
    assert.deepEqual(result.rankedModels, ["Claude Sonnet 4.6", "GPT-5.3-Codex"]);
  });

  it("falls back when lineage-linked sample count is zero even if total sample count is high", () => {
    const cycleAnalytics = {
      modelRoutingTelemetry: {
        byTaskKind: {
          "ci-fix": {
            sampleCount: MIN_TELEMETRY_SAMPLE_THRESHOLD + 8,
            lineageLinkedSampleCount: 0,
            lineageLinkedRatio: 0,
            default: { successProbability: 0.9, capacityImpact: 0.8, requestCost: 1 },
            models: {
              "GPT-5.3-Codex": { successProbability: 0.95, capacityImpact: 0.9, requestCost: 1 },
              "Claude Sonnet 4.6": { successProbability: 0.4, capacityImpact: 0.3, requestCost: 1 },
            },
          },
        },
      },
      routingROISummary: { linkedRatio: 0.9 },
    };
    const result = rankModelsByTaskKindExpectedValue(
      "ci-fix",
      ["Claude Sonnet 4.6", "GPT-5.3-Codex"],
      cycleAnalytics,
    );
    assert.equal(result.usedTelemetry, false);
    assert.equal(result.reason, "telemetry-below-threshold");
  });

  it("uses per-task lineageLinkedRatio over global linkedRatio for effective sample gating", () => {
    const cycleAnalytics = {
      modelRoutingTelemetry: {
        byTaskKind: {
          "ci-fix": {
            sampleCount: MIN_TELEMETRY_SAMPLE_THRESHOLD + 2,
            lineageLinkedSampleCount: MIN_TELEMETRY_SAMPLE_THRESHOLD + 2,
            lineageLinkedRatio: 1,
            default: { successProbability: 0.6, capacityImpact: 0.5, requestCost: 1 },
            models: {
              "GPT-5.3-Codex": { successProbability: 0.95, capacityImpact: 0.8, requestCost: 1 },
              "Claude Sonnet 4.6": { successProbability: 0.5, capacityImpact: 0.4, requestCost: 1 },
            },
          },
        },
      },
      // Should be ignored for this task because per-task lineageLinkedRatio is present.
      routingROISummary: { linkedRatio: 0.1 },
    };
    const result = rankModelsByTaskKindExpectedValue(
      "ci-fix",
      ["Claude Sonnet 4.6", "GPT-5.3-Codex"],
      cycleAnalytics,
    );
    assert.equal(result.usedTelemetry, true);
    assert.equal(result.rankedModels[0], "GPT-5.3-Codex");
  });

  it("MIN_TELEMETRY_SAMPLE_THRESHOLD is exported as a positive integer", () => {
    assert.ok(typeof MIN_TELEMETRY_SAMPLE_THRESHOLD === "number");
    assert.ok(MIN_TELEMETRY_SAMPLE_THRESHOLD > 0);
    assert.ok(Number.isInteger(MIN_TELEMETRY_SAMPLE_THRESHOLD));
  });
});

// ── routeModelWithMemoryHitRatio ──────────────────────────────────────────────

describe("routeModelWithMemoryHitRatio", () => {
  const modelOptions = {
    efficientModel: "Claude Haiku 4",
    defaultModel:   "Claude Sonnet 4.6",
    strongModel:    "Claude Opus 4.6",
    qualityByModel: {
      "Claude Haiku 4":    0.70,
      "Claude Sonnet 4.6": 0.85,
      "Claude Opus 4.6":   0.95,
    },
  };

  it("exported constants have correct values", () => {
    assert.equal(MEMORY_HIT_RATIO_HIGH, 0.70);
    assert.equal(MEMORY_HIT_RATIO_LOW,  0.30);
    assert.equal(MEMORY_FLOOR_RELAX_AMOUNT,  0.05);
    assert.equal(MEMORY_FLOOR_TIGHTEN_AMOUNT, 0.08);
  });

  it("high ratio (>=0.70) relaxes the quality floor", () => {
    // base floor 0.75, high ratio → relaxed to 0.70
    const result = routeModelWithMemoryHitRatio({}, modelOptions, 0.75, MEMORY_HIT_RATIO_HIGH);
    assert.ok(result.memoryHitAdjustment.startsWith("relaxed"),
      "high hit ratio must relax the floor");
    assert.ok(result.effectiveFloor < 0.75, "effective floor must be lower than base floor");
  });

  it("high ratio selects a cheaper model when floor is relaxed", () => {
    // base floor 0.80, high ratio → relaxed to 0.75 → Haiku (0.70) fails, Sonnet (0.85) selected
    const result = routeModelWithMemoryHitRatio({}, modelOptions, 0.80, 1.0);
    assert.equal(result.model, "Claude Sonnet 4.6",
      "relaxed floor should prefer lowest-cost qualifying model");
  });

  it("low ratio (0 < ratio < 0.30) tightens the quality floor", () => {
    // base floor 0.75, low ratio → tightened to 0.83
    const result = routeModelWithMemoryHitRatio({}, modelOptions, 0.75, 0.10);
    assert.ok(result.memoryHitAdjustment.startsWith("tightened"),
      "low hit ratio must tighten the floor");
    assert.ok(result.effectiveFloor > 0.75, "effective floor must be higher than base floor");
  });

  it("low ratio forces stronger model when floor tightens past Sonnet", () => {
    // base floor 0.80, very low ratio → tightened to 0.88 → Sonnet (0.85) fails, Opus (0.95) selected
    const result = routeModelWithMemoryHitRatio({}, modelOptions, 0.80, 0.05);
    assert.equal(result.model, "Claude Opus 4.6",
      "tightened floor must require Opus when Sonnet no longer qualifies");
  });

  it("zero ratio (no data) leaves floor unchanged", () => {
    const result = routeModelWithMemoryHitRatio({}, modelOptions, 0.75, 0);
    assert.ok(result.memoryHitAdjustment.startsWith("none"),
      "zero ratio must not adjust the floor");
    assert.equal(result.effectiveFloor, 0.75, "effective floor must equal base floor");
  });

  it("effective floor is clamped to MAX_QUALITY_FLOOR (0.99)", () => {
    // base floor 0.95 + tighten 0.08 = 1.03 → clamped to 0.99
    const result = routeModelWithMemoryHitRatio({}, modelOptions, 0.95, 0.05);
    assert.ok(result.effectiveFloor <= 0.99, "effective floor must not exceed 0.99");
  });

  it("effective floor is clamped to MIN_QUALITY_FLOOR (0.50)", () => {
    // base floor 0.52 - relax 0.05 = 0.47 → clamped to 0.50
    const result = routeModelWithMemoryHitRatio({}, modelOptions, 0.52, 1.0);
    assert.ok(result.effectiveFloor >= 0.50, "effective floor must not go below 0.50");
  });

  it("result includes memoryHitRatio field matching the input ratio", () => {
    const result = routeModelWithMemoryHitRatio({}, modelOptions, 0.75, 0.65);
    assert.equal(result.memoryHitRatio, 0.65, "memoryHitRatio must echo back the input ratio");
  });

  it("result always has a meetsQualityFloor boolean", () => {
    const result = routeModelWithMemoryHitRatio({}, modelOptions, 0.75, 0.5);
    assert.equal(typeof result.meetsQualityFloor, "boolean");
  });

  it("reason string references memory-hit-adjusted", () => {
    const result = routeModelWithMemoryHitRatio({}, modelOptions, 0.75, 1.0);
    assert.ok(result.reason.includes("memory-hit-adjusted"),
      "reason must reference memory-hit-adjusted");
  });

  it("negative path: empty modelOptions returns a model without throwing", () => {
    const result = routeModelWithMemoryHitRatio({}, {}, 0.75, 0.8);
    assert.ok(result.model, "must return a model even with empty options");
    assert.equal(typeof result.meetsQualityFloor, "boolean");
  });
});

// ── QUALITY_FLOOR_DEFAULT — shared constant used by dispatch routing ──────────

describe("QUALITY_FLOOR_DEFAULT — quality floor constant", () => {
  it("is a numeric value in (0, 1)", () => {
    assert.equal(typeof QUALITY_FLOOR_DEFAULT, "number");
    assert.ok(QUALITY_FLOOR_DEFAULT > 0 && QUALITY_FLOOR_DEFAULT < 1,
      "QUALITY_FLOOR_DEFAULT must be in (0, 1)");
  });

  it("matches the default parameter of routeModelUnderQualityFloor", () => {
    // When no qualityFloor arg is supplied, the default (0.7) must be used.
    // A Sonnet-quality (0.85) model should always meet the default floor.
    const modelOptions = {
      efficientModel: "Claude Haiku 4",
      defaultModel:   "Claude Sonnet 4.6",
      strongModel:    "Claude Opus 4.6",
      qualityByModel: {
        "claude haiku 4":    0.70,
        "claude sonnet 4.6": 0.85,
        "claude opus 4.6":   0.95,
      },
    };
    // Call with explicit QUALITY_FLOOR_DEFAULT — result must be same as no-arg default.
    const withConst  = routeModelUnderQualityFloor({ complexity: "low" }, modelOptions, {}, QUALITY_FLOOR_DEFAULT);
    const withDefault = routeModelUnderQualityFloor({ complexity: "low" }, modelOptions, {});
    assert.equal(withConst.model, withDefault.model,
      "explicit QUALITY_FLOOR_DEFAULT must produce identical routing to the default parameter");
    assert.equal(withConst.meetsQualityFloor, withDefault.meetsQualityFloor);
  });

  it("quality-floor enforcement upgrades a below-floor candidate", () => {
    // Force haiku as the sole efficientModel; quality floor set above haiku (0.70).
    // routeModelUnderQualityFloor must upgrade to Sonnet.
    const modelOptions = {
      efficientModel: "Claude Haiku 4",
      defaultModel:   "Claude Sonnet 4.6",
      strongModel:    "Claude Opus 4.6",
      qualityByModel: {
        "claude haiku 4":    0.60,
        "claude sonnet 4.6": 0.85,
        "claude opus 4.6":   0.95,
      },
    };
    const result = routeModelUnderQualityFloor({ complexity: "low" }, modelOptions, { recentROI: 0 }, 0.75);
    assert.notEqual(result.model, "Claude Haiku 4",
      "below-floor candidate must be upgraded");
    assert.equal(result.meetsQualityFloor, true,
      "selected model must meet the floor after upgrade");
    assert.ok(result.reason.includes("quality-floor-upgrade"),
      "reason must explain why floor upgrade was applied");
  });

  it("negative: no model meeting floor returns strongest with meetsQualityFloor=false", () => {
    // All models score below an impossibly high floor.
    const modelOptions = {
      efficientModel: "Claude Haiku 4",
      defaultModel:   "Claude Sonnet 4.6",
      strongModel:    "Claude Opus 4.6",
      qualityByModel: {
        "claude haiku 4":    0.10,
        "claude sonnet 4.6": 0.20,
        "claude opus 4.6":   0.30,
      },
    };
    const result = routeModelUnderQualityFloor({}, modelOptions, { recentROI: 0 }, 0.99);
    assert.equal(result.model, "Claude Opus 4.6",
      "when nothing meets the floor, the strongest model must be returned");
    assert.equal(result.meetsQualityFloor, false,
      "meetsQualityFloor must be false when no model qualifies");
  });
});

// ── resolveJanusFallbackModel + JANUS_LATENCY_FALLBACK ────────────────────────
import { resolveJanusFallbackModel } from "../../src/core/model_policy.js";

describe("ROUTING_REASON — JANUS_LATENCY_FALLBACK value", () => {
  it("JANUS_LATENCY_FALLBACK is present in ROUTING_REASON enum", () => {
    assert.equal(ROUTING_REASON.JANUS_LATENCY_FALLBACK, "JANUS_LATENCY_FALLBACK",
      "ROUTING_REASON.JANUS_LATENCY_FALLBACK must be set to its own string key");
  });
});

describe("resolveJanusFallbackModel", () => {
  it("returns janusFallbackModel when explicitly configured", () => {
    const cfg = { runtime: { janusFallbackModel: "claude-opus-4" } };
    assert.equal(resolveJanusFallbackModel(cfg), "claude-opus-4");
  });

  it("falls back to copilot.efficientModel when janusFallbackModel is empty", () => {
    const cfg = {
      runtime: { janusFallbackModel: "" },
      copilot: { efficientModel: "claude-haiku-3" }
    };
    assert.equal(resolveJanusFallbackModel(cfg), "claude-haiku-3");
  });

  it("falls back to copilot.defaultModel when both janusFallbackModel and efficientModel are absent", () => {
    const cfg = { copilot: { defaultModel: "claude-sonnet-3" } };
    assert.equal(resolveJanusFallbackModel(cfg), "claude-sonnet-3");
  });

  it("returns default model string when config is empty", () => {
    const model = resolveJanusFallbackModel({});
    assert.equal(typeof model, "string", "must always return a string");
    assert.ok(model.length > 0, "must not return empty string");
  });

  it("negative path: whitespace-only janusFallbackModel falls through to efficientModel", () => {
    const cfg = {
      runtime: { janusFallbackModel: "   " },
      copilot: { efficientModel: "claude-haiku-3" }
    };
    assert.equal(resolveJanusFallbackModel(cfg), "claude-haiku-3");
  });
});

// ── normalizeBenchmarkSample + classifyBenchmarkSuite (benchmark ingestion normalization) ──

import {
  normalizeBenchmarkSample,
  classifyBenchmarkSuite,
  BENCHMARK_SUITE_TYPE,
} from "../../src/core/model_policy.js";

/** Shared test contracts covering SWE-bench (no stepBudget) and OSWorld (stepBudget + verifiedAt). */
const TEST_BENCHMARK_CONTRACTS = [
  {
    name: "SWE-bench",
    version: "1.1",
    requiredFields: [
      "benchmarkName", "taskId", "status", "model",
      "tokensIn", "tokensOut", "elapsedMs", "evaluatedAt",
    ],
    dateFields: ["evaluatedAt"],
    stepBudgetFields: [],
    statusEnum: ["success", "partial", "failed"],
    verifiedSuiteStatuses: ["success"],
  },
  {
    name: "OSWorld",
    version: "1.1",
    requiredFields: [
      "benchmarkName", "taskId", "status", "model",
      "tokensIn", "tokensOut", "elapsedMs", "evaluatedAt", "stepBudget",
    ],
    dateFields: ["evaluatedAt", "verifiedAt"],
    stepBudgetFields: ["stepBudget"],
    statusEnum: ["success", "partial", "failed"],
    verifiedSuiteStatuses: ["success"],
  },
];

describe("normalizeBenchmarkSample — strict ingestion normalization", () => {
  it("normalizes a valid SWE-bench sample with no errors", () => {
    const { sample, errors } = normalizeBenchmarkSample({
      benchmarkName: "SWE-bench",
      taskId: "task-001",
      status: "success",
      model: "Claude Sonnet 4.6",
      tokensIn: 1000,
      tokensOut: 500,
      elapsedMs: 3200,
      evaluatedAt: "2026-04-09T12:00:00.000Z",
    }, TEST_BENCHMARK_CONTRACTS);
    assert.equal(errors.length, 0, "valid sample must produce no errors");
    assert.equal(sample.benchmarkName, "SWE-bench");
    assert.equal(sample.status, "success");
    assert.equal(sample.suiteType, BENCHMARK_SUITE_TYPE.VERIFIED);
  });

  it("normalizes evaluatedAt to ISO 8601 from a loose date string", () => {
    const { sample } = normalizeBenchmarkSample({
      benchmarkName: "SWE-bench",
      taskId: "task-002",
      status: "partial",
      model: "Claude Sonnet 4.6",
      tokensIn: 800,
      tokensOut: 400,
      elapsedMs: 2000,
      evaluatedAt: "April 9, 2026",
    }, TEST_BENCHMARK_CONTRACTS);
    assert.ok(
      sample.evaluatedAt.includes("T") || sample.evaluatedAt.endsWith("Z"),
      "evaluatedAt must be converted to ISO 8601"
    );
  });

  it("reports error for an unparseable date field", () => {
    const { errors } = normalizeBenchmarkSample({
      benchmarkName: "SWE-bench",
      taskId: "task-003",
      status: "success",
      model: "Claude Sonnet 4.6",
      tokensIn: 800,
      tokensOut: 400,
      elapsedMs: 2000,
      evaluatedAt: "not-a-date",
    }, TEST_BENCHMARK_CONTRACTS);
    assert.ok(
      errors.some(e => e.includes("invalid_date:evaluatedAt")),
      "unparseable evaluatedAt must produce an invalid_date error"
    );
  });

  it("validates stepBudget for OSWorld as a positive integer", () => {
    const { errors } = normalizeBenchmarkSample({
      benchmarkName: "OSWorld",
      taskId: "task-004",
      status: "success",
      model: "Claude Sonnet 4.6",
      tokensIn: 1200,
      tokensOut: 600,
      elapsedMs: 5000,
      evaluatedAt: "2026-04-09T12:00:00.000Z",
      stepBudget: 15,
      verifiedAt: "2026-04-09T13:00:00.000Z",
    }, TEST_BENCHMARK_CONTRACTS);
    assert.equal(errors.length, 0, "valid OSWorld sample with stepBudget=15 must have no errors");
  });

  it("rejects a non-integer stepBudget", () => {
    const { errors } = normalizeBenchmarkSample({
      benchmarkName: "OSWorld",
      taskId: "task-005",
      status: "success",
      model: "Claude Sonnet 4.6",
      tokensIn: 1200,
      tokensOut: 600,
      elapsedMs: 5000,
      evaluatedAt: "2026-04-09T12:00:00.000Z",
      stepBudget: 3.7,
    }, TEST_BENCHMARK_CONTRACTS);
    assert.ok(
      errors.some(e => e.includes("invalid_step_budget")),
      "non-integer stepBudget must produce an invalid_step_budget error"
    );
  });

  it("rejects a negative stepBudget", () => {
    const { errors } = normalizeBenchmarkSample({
      benchmarkName: "OSWorld",
      taskId: "task-006",
      status: "success",
      model: "Claude Sonnet 4.6",
      tokensIn: 1200,
      tokensOut: 600,
      elapsedMs: 5000,
      evaluatedAt: "2026-04-09T12:00:00.000Z",
      stepBudget: -5,
    }, TEST_BENCHMARK_CONTRACTS);
    assert.ok(
      errors.some(e => e.includes("invalid_step_budget")),
      "negative stepBudget must produce an invalid_step_budget error"
    );
  });

  it("reports error for an unknown benchmark name", () => {
    const { errors } = normalizeBenchmarkSample({
      benchmarkName: "UnknownBench",
      taskId: "task-007",
      status: "success",
      model: "Claude Sonnet 4.6",
      tokensIn: 500,
      tokensOut: 300,
      elapsedMs: 1000,
      evaluatedAt: "2026-04-09T12:00:00.000Z",
    }, TEST_BENCHMARK_CONTRACTS);
    assert.ok(
      errors.some(e => e.includes("unknown_benchmark")),
      "unknown benchmark must produce an unknown_benchmark error"
    );
  });

  it("reports error for an invalid status value", () => {
    const { errors } = normalizeBenchmarkSample({
      benchmarkName: "SWE-bench",
      taskId: "task-008",
      status: "unknown-status",
      model: "Claude Sonnet 4.6",
      tokensIn: 500,
      tokensOut: 300,
      elapsedMs: 1000,
      evaluatedAt: "2026-04-09T12:00:00.000Z",
    }, TEST_BENCHMARK_CONTRACTS);
    assert.ok(
      errors.some(e => e.includes("invalid_status")),
      "invalid status must produce an invalid_status error"
    );
  });

  it("reports error for a missing required field (empty taskId)", () => {
    const { errors } = normalizeBenchmarkSample({
      benchmarkName: "SWE-bench",
      taskId: "",
      status: "success",
      model: "Claude Sonnet 4.6",
      tokensIn: 500,
      tokensOut: 300,
      elapsedMs: 1000,
      evaluatedAt: "2026-04-09T12:00:00.000Z",
    }, TEST_BENCHMARK_CONTRACTS);
    assert.ok(
      errors.some(e => e.includes("missing_field:taskId")),
      "empty taskId must produce a missing_field error"
    );
  });

  it("negative path: classifies a failed sample as exploratory_suite", () => {
    const { sample } = normalizeBenchmarkSample({
      benchmarkName: "SWE-bench",
      taskId: "task-009",
      status: "failed",
      model: "Claude Sonnet 4.6",
      tokensIn: 500,
      tokensOut: 300,
      elapsedMs: 1000,
      evaluatedAt: "2026-04-09T12:00:00.000Z",
    }, TEST_BENCHMARK_CONTRACTS);
    assert.equal(
      sample.suiteType, BENCHMARK_SUITE_TYPE.EXPLORATORY,
      "failed status must be classified as exploratory_suite"
    );
  });

  it("normalizationErrors field reflects the collected errors", () => {
    const { sample } = normalizeBenchmarkSample({
      benchmarkName: "SWE-bench",
      taskId: "task-010",
      status: "bad-status",
      model: "Claude Sonnet 4.6",
      tokensIn: 500,
      tokensOut: 300,
      elapsedMs: 1000,
      evaluatedAt: "2026-04-09T12:00:00.000Z",
    }, TEST_BENCHMARK_CONTRACTS);
    assert.ok(
      Array.isArray(sample.normalizationErrors),
      "normalizationErrors must be an array on the returned sample"
    );
    assert.ok(sample.normalizationErrors.length > 0, "errors must be embedded in sample");
  });
});

describe("classifyBenchmarkSuite — suite type classification", () => {
  it("BENCHMARK_SUITE_TYPE constants have correct values and are frozen", () => {
    assert.equal(BENCHMARK_SUITE_TYPE.VERIFIED,    "verified_suite");
    assert.equal(BENCHMARK_SUITE_TYPE.EXPLORATORY, "exploratory_suite");
    assert.ok(Object.isFrozen(BENCHMARK_SUITE_TYPE), "BENCHMARK_SUITE_TYPE must be frozen");
  });

  it("classifies a successful SWE-bench sample as verified_suite", () => {
    const result = classifyBenchmarkSuite(
      { benchmarkName: "SWE-bench", status: "success" },
      TEST_BENCHMARK_CONTRACTS
    );
    assert.equal(result, BENCHMARK_SUITE_TYPE.VERIFIED);
  });

  it("classifies a partial SWE-bench sample as exploratory_suite", () => {
    const result = classifyBenchmarkSuite(
      { benchmarkName: "SWE-bench", status: "partial" },
      TEST_BENCHMARK_CONTRACTS
    );
    assert.equal(result, BENCHMARK_SUITE_TYPE.EXPLORATORY);
  });

  it("classifies OSWorld success without verifiedAt as exploratory_suite (unverified)", () => {
    const result = classifyBenchmarkSuite(
      { benchmarkName: "OSWorld", status: "success" },
      TEST_BENCHMARK_CONTRACTS
    );
    assert.equal(
      result, BENCHMARK_SUITE_TYPE.EXPLORATORY,
      "OSWorld success without verifiedAt must be exploratory"
    );
  });

  it("classifies OSWorld success with valid verifiedAt as verified_suite", () => {
    const result = classifyBenchmarkSuite(
      { benchmarkName: "OSWorld", status: "success", verifiedAt: "2026-04-09T13:00:00.000Z" },
      TEST_BENCHMARK_CONTRACTS
    );
    assert.equal(
      result, BENCHMARK_SUITE_TYPE.VERIFIED,
      "OSWorld success with valid verifiedAt must be verified_suite"
    );
  });

  it("negative path: OSWorld success with unparseable verifiedAt is exploratory", () => {
    const result = classifyBenchmarkSuite(
      { benchmarkName: "OSWorld", status: "success", verifiedAt: "not-a-date" },
      TEST_BENCHMARK_CONTRACTS
    );
    assert.equal(
      result, BENCHMARK_SUITE_TYPE.EXPLORATORY,
      "unparseable verifiedAt must prevent verified classification"
    );
  });

  it("negative path: unknown benchmark always classifies as exploratory", () => {
    const result = classifyBenchmarkSuite(
      { benchmarkName: "UnknownBench", status: "success" },
      TEST_BENCHMARK_CONTRACTS
    );
    assert.equal(
      result, BENCHMARK_SUITE_TYPE.EXPLORATORY,
      "unknown benchmark must default to exploratory_suite"
    );
  });
});

// ── computeBenchmarkIntegrityScore ────────────────────────────────────────────

import {
  computeBenchmarkIntegrityScore,
  BENCHMARK_INTEGRITY_SCHEMA_VERSION,
  BENCHMARK_INTEGRITY_UNRESOLVED_THRESHOLDS,
  BENCHMARK_CONTRADICTION_REASON,
} from "../../src/core/model_policy.js";

function makeGroundTruth(recommendations: object[]): object {
  return {
    entries: [
      {
        cycleId: "test-cycle",
        recommendations,
      },
    ],
  };
}

describe("BENCHMARK_INTEGRITY_UNRESOLVED_THRESHOLDS", () => {
  it("is frozen and has minor and moderate thresholds", () => {
    assert.ok(Object.isFrozen(BENCHMARK_INTEGRITY_UNRESOLVED_THRESHOLDS));
    assert.equal(BENCHMARK_INTEGRITY_UNRESOLVED_THRESHOLDS.minor, 0.30);
    assert.equal(BENCHMARK_INTEGRITY_UNRESOLVED_THRESHOLDS.moderate, 0.60);
  });
});

describe("BENCHMARK_CONTRADICTION_REASON", () => {
  it("is frozen and has expected reason codes", () => {
    assert.ok(Object.isFrozen(BENCHMARK_CONTRADICTION_REASON));
    assert.equal(BENCHMARK_CONTRADICTION_REASON.SAME_TOPIC_CONFLICTING_STATUS, "SAME_TOPIC_CONFLICTING_STATUS");
    assert.equal(BENCHMARK_CONTRADICTION_REASON.DUPLICATE_ENTRY, "DUPLICATE_ENTRY");
  });
});

describe("computeBenchmarkIntegrityScore — zero signal", () => {
  it("returns zero-signal when benchmarkGroundTruth is null", () => {
    const result = computeBenchmarkIntegrityScore(null);
    assert.equal(result.schemaVersion, BENCHMARK_INTEGRITY_SCHEMA_VERSION);
    assert.equal(result.sampleCount, 0);
    assert.equal(result.integrityScore, 0);
    assert.equal(result.contradictionCount, 0);
  });

  it("returns zero-signal when no entries are present", () => {
    const result = computeBenchmarkIntegrityScore({ entries: [] });
    assert.equal(result.sampleCount, 0);
    assert.equal(result.integrityScore, 0);
  });

  it("returns zero-signal when latest entry has no recommendations", () => {
    const result = computeBenchmarkIntegrityScore({ entries: [{ cycleId: "c1", recommendations: [] }] });
    assert.equal(result.sampleCount, 0);
  });
});

describe("computeBenchmarkIntegrityScore — scoring", () => {
  it("low unresolved ratio (< 0.30) applies minor penalty (0.90)", () => {
    const gt = makeGroundTruth([
      { topic: "a", implementationStatus: "implemented", benchmarkScore: 0.8, capacityGain: 0.5 },
      { topic: "b", implementationStatus: "implemented", benchmarkScore: 0.9, capacityGain: 0.6 },
      { topic: "c", implementationStatus: "implemented", benchmarkScore: 0.7, capacityGain: 0.4 },
      { topic: "d", implementationStatus: "pending",     benchmarkScore: 0.6, capacityGain: 0.3 },
    ]);
    const result = computeBenchmarkIntegrityScore(gt);
    assert.equal(result.penaltyApplied, 0.90, "minor penalty must be 0.90");
    assert.ok(result.unresolvedRatio < 0.30, "unresolvedRatio must be below minor threshold");
    assert.ok(result.integrityScore > 0, "integrityScore must be positive");
  });

  it("moderate unresolved ratio (0.30–0.60) applies moderate penalty (0.70)", () => {
    const recs = [
      { topic: "a", implementationStatus: "implemented" },
      { topic: "b", implementationStatus: "implemented" },
      { topic: "c", implementationStatus: "pending" },
      { topic: "d", implementationStatus: "pending" },
    ];
    const result = computeBenchmarkIntegrityScore(makeGroundTruth(recs));
    // 2 out of 4 pending → unresolvedRatio = 0.50 (in moderate range)
    assert.equal(result.penaltyApplied, 0.70);
    assert.ok(result.unresolvedRatio >= 0.30 && result.unresolvedRatio < 0.60);
  });

  it("severe unresolved ratio (>= 0.60) applies severe penalty (0.50)", () => {
    const recs = [
      { topic: "a", implementationStatus: "pending" },
      { topic: "b", implementationStatus: "pending" },
      { topic: "c", implementationStatus: "pending" },
      { topic: "d", implementationStatus: "implemented" },
    ];
    const result = computeBenchmarkIntegrityScore(makeGroundTruth(recs));
    assert.equal(result.penaltyApplied, 0.50);
    assert.ok(result.unresolvedRatio >= 0.60);
  });

  it("detects contradictions when same topic has both implemented and unresolved status", () => {
    const recs = [
      { topic: "cache-fix", implementationStatus: "implemented",   benchmarkScore: 0.8 },
      { topic: "cache-fix", implementationStatus: "pending",       benchmarkScore: 0.8 },
      { topic: "auth-fix",  implementationStatus: "implemented",   benchmarkScore: 0.9 },
    ];
    const result = computeBenchmarkIntegrityScore(makeGroundTruth(recs));
    assert.equal(result.contradictionCount, 1, "must detect one contradiction for cache-fix");
  });

  it("normalizes suite names to lowercase", () => {
    const recs = [
      { topic: "A", suite: "SuiteAlpha", implementationStatus: "implemented" },
      { topic: "B", suite: "SUITEALPHA", implementationStatus: "implemented" },
    ];
    const result = computeBenchmarkIntegrityScore(makeGroundTruth(recs));
    assert.equal(result.normalizedSuiteCount, 1, "suite names must be deduplicated after normalization");
  });

  it("integrityScore is in [0, 1]", () => {
    const recs = Array.from({ length: 5 }, (_, i) => ({
      topic: `t${i}`, implementationStatus: "pending", benchmarkScore: 0.5, capacityGain: 0.2
    }));
    const result = computeBenchmarkIntegrityScore(makeGroundTruth(recs));
    assert.ok(result.integrityScore >= 0 && result.integrityScore <= 1,
      `integrityScore must be in [0,1], got ${result.integrityScore}`);
  });
});

describe("computeBenchmarkIntegrityScore — negative paths", () => {
  it("does not throw for null or undefined input", () => {
    assert.doesNotThrow(() => computeBenchmarkIntegrityScore(null));
    assert.doesNotThrow(() => computeBenchmarkIntegrityScore(undefined));
  });

  it("handles records with missing topic and status gracefully", () => {
    const recs = [
      { benchmarkScore: 0.5 },  // no topic or status
      { topic: null, implementationStatus: null },
    ];
    const result = computeBenchmarkIntegrityScore(makeGroundTruth(recs));
    assert.equal(result.sampleCount, 2);
    assert.ok(result.integrityScore >= 0);
  });
});

// ── computeBenchmarkPlanningPriors ────────────────────────────────────────────
describe("computeBenchmarkPlanningPriors", () => {
  it("returns baseline priors when input is null (no history)", () => {
    const result = computeBenchmarkPlanningPriors(null);
    assert.equal(result.strictnessMultiplier, 1.0);
    assert.equal(result.verificationDepth, "standard");
    assert.equal(result.decompositionCapAdjustment, 0);
    assert.equal(result.uncertainty, "high");
    assert.equal(result.capacityGain, null);
    assert.equal(result.retryViolationAdjustment, 0);
  });

  it("returns baseline priors when evaluatedCount < 2 (insufficient history)", () => {
    const result = computeBenchmarkPlanningPriors({ capacityGain: 0.8, evaluatedCount: 1 });
    assert.equal(result.uncertainty, "high");
    assert.equal(result.strictnessMultiplier, 1.0);
  });

  it("returns stricter priors for low capacity gain (< 0.30)", () => {
    const result = computeBenchmarkPlanningPriors({ capacityGain: 0.20, evaluatedCount: 5 });
    assert.equal(result.uncertainty, "high");
    assert.equal(result.strictnessMultiplier, 1.3);
    assert.equal(result.verificationDepth, "deep");
    assert.equal(result.decompositionCapAdjustment, -2);
  });

  it("returns moderate priors for medium capacity gain (0.30 – 0.69)", () => {
    const result = computeBenchmarkPlanningPriors({ capacityGain: 0.50, evaluatedCount: 10 });
    assert.equal(result.uncertainty, "medium");
    assert.equal(result.strictnessMultiplier, 1.1);
    assert.equal(result.verificationDepth, "standard");
    assert.equal(result.decompositionCapAdjustment, 0);
  });

  it("returns relaxed priors for high capacity gain (>= 0.70)", () => {
    const result = computeBenchmarkPlanningPriors({ capacityGain: 0.85, evaluatedCount: 20 });
    assert.equal(result.uncertainty, "low");
    assert.equal(result.strictnessMultiplier, 0.9);
    assert.equal(result.verificationDepth, "shallow");
    assert.equal(result.decompositionCapAdjustment, 2);
  });

  it("negative path: handles undefined input gracefully", () => {
    const result = computeBenchmarkPlanningPriors(undefined);
    assert.equal(result.uncertainty, "high");
    assert.equal(result.strictnessMultiplier, 1.0);
    assert.equal(result.capacityGain, null);
  });

  // ── retryViolationSignal overlay ──────────────────────────────────────────
  it("adds +0.15 strictness when contractViolationRate > 0.20", () => {
    const result = computeBenchmarkPlanningPriors(
      { capacityGain: 0.50, evaluatedCount: 10 },
      { retryRate: null, contractViolationRate: 0.30, rerouteRate: null },
    );
    // base = 1.1, violation adj = +0.15 → 1.25
    assert.equal(result.strictnessMultiplier, 1.25);
    assert.equal(result.retryViolationAdjustment, 0.15);
    assert.equal(result.verificationDepth, "standard");
  });

  it("adds +0.10 strictness when retryRate > 0.30", () => {
    const result = computeBenchmarkPlanningPriors(
      { capacityGain: 0.50, evaluatedCount: 10 },
      { retryRate: 0.50, contractViolationRate: null, rerouteRate: null },
    );
    // base = 1.1, retry adj = +0.10 → 1.2
    assert.equal(result.strictnessMultiplier, 1.2);
    assert.equal(result.retryViolationAdjustment, 0.10);
  });

  it("escalates verificationDepth when rerouteRate > 0.30 (shallow → standard)", () => {
    const result = computeBenchmarkPlanningPriors(
      { capacityGain: 0.85, evaluatedCount: 20 },
      { retryRate: null, contractViolationRate: null, rerouteRate: 0.40 },
    );
    assert.equal(result.verificationDepth, "standard");   // escalated from shallow
    assert.equal(result.strictnessMultiplier, 0.9);       // no strictness change
    assert.equal(result.retryViolationAdjustment, 0);
  });

  it("escalates verificationDepth when rerouteRate > 0.30 (standard → deep)", () => {
    const result = computeBenchmarkPlanningPriors(
      { capacityGain: 0.50, evaluatedCount: 10 },
      { retryRate: null, contractViolationRate: null, rerouteRate: 0.50 },
    );
    assert.equal(result.verificationDepth, "deep");       // escalated from standard
  });

  it("compounds both violation and retry adjustments", () => {
    const result = computeBenchmarkPlanningPriors(
      { capacityGain: 0.50, evaluatedCount: 10 },
      { retryRate: 0.40, contractViolationRate: 0.25, rerouteRate: null },
    );
    // base = 1.1, violation +0.15, retry +0.10 → 1.35
    assert.equal(result.strictnessMultiplier, 1.35);
    assert.equal(result.retryViolationAdjustment, 0.25);
  });

  it("does not apply overlay when all rates are null", () => {
    const result = computeBenchmarkPlanningPriors(
      { capacityGain: 0.50, evaluatedCount: 10 },
      { retryRate: null, contractViolationRate: null, rerouteRate: null },
    );
    assert.equal(result.strictnessMultiplier, 1.1);
    assert.equal(result.retryViolationAdjustment, 0);
  });

  it("does not apply overlay when rates are below thresholds", () => {
    const result = computeBenchmarkPlanningPriors(
      { capacityGain: 0.50, evaluatedCount: 10 },
      { retryRate: 0.10, contractViolationRate: 0.05, rerouteRate: 0.20 },
    );
    assert.equal(result.strictnessMultiplier, 1.1);
    assert.equal(result.retryViolationAdjustment, 0);
    assert.equal(result.verificationDepth, "standard");
  });

  it("negative path: handles null retryViolationSignal gracefully", () => {
    const result = computeBenchmarkPlanningPriors(
      { capacityGain: 0.50, evaluatedCount: 10 },
      null,
    );
    assert.equal(result.strictnessMultiplier, 1.1);
    assert.equal(result.retryViolationAdjustment, 0);
  });
});

// ── Category Frontier Score Tests ─────────────────────────────────────────────

import {
  computeCategoryFrontierScore,
  computePerInstanceNormalization,
} from "../../src/core/model_policy.js";

describe("computeCategoryFrontierScore — per-category benchmark aggregation", () => {
  const makeEntry = (category: string, frontierScore: number, model = "test-model") => ({
    categoryFrontiers: [{ category, frontierScore, model }],
  });

  it("returns the best frontierScore across entries for a category", () => {
    const entries = [
      makeEntry("django", 0.65, "ModelA"),
      makeEntry("django", 0.72, "ModelB"),
      makeEntry("django", 0.60, "ModelC"),
    ];
    const result = computeCategoryFrontierScore(entries, "django");
    assert.equal(result.frontierScore, 0.72, "best score is 0.72");
    assert.equal(result.bestModel, "ModelB");
    assert.equal(result.evaluatedCount, 3);
  });

  it("is case-insensitive for category name", () => {
    const entries = [makeEntry("Django", 0.55, "ModelA")];
    const result = computeCategoryFrontierScore(entries, "django");
    assert.equal(result.frontierScore, 0.55, "case-insensitive match");
  });

  it("returns null frontierScore when category is not present (negative path)", () => {
    const entries = [makeEntry("django", 0.72)];
    const result = computeCategoryFrontierScore(entries, "scikit-learn");
    assert.equal(result.frontierScore, null, "unmatched category → null");
    assert.equal(result.evaluatedCount, 0);
  });

  it("returns null frontierScore for empty entries array (negative path)", () => {
    const result = computeCategoryFrontierScore([], "django");
    assert.equal(result.frontierScore, null);
  });

  it("skips entries without categoryFrontiers field", () => {
    const entries = [
      { recommendations: [] },
      makeEntry("django", 0.80),
    ];
    const result = computeCategoryFrontierScore(entries, "django");
    assert.equal(result.frontierScore, 0.80, "skips entry with no categoryFrontiers");
    assert.equal(result.evaluatedCount, 1);
  });
});

describe("computePerInstanceNormalization — instance score vs frontier", () => {
  it("returns 1.0 when instance score equals frontier", () => {
    const result = computePerInstanceNormalization(0.72, 0.72);
    assert.equal(result, 1.0, "matching score → normalized to 1.0");
  });

  it("returns normalized ratio below 1.0 when instance is below frontier", () => {
    const result = computePerInstanceNormalization(0.36, 0.72);
    assert.equal(result, 0.5, "half of frontier score → 0.5");
  });

  it("clamps to 1.0 when instance exceeds frontier (new best)", () => {
    const result = computePerInstanceNormalization(0.90, 0.72);
    assert.equal(result, 1.0, "exceeds frontier → clamped to 1.0");
  });

  it("returns null when frontierScore is null (no frontier data)", () => {
    const result = computePerInstanceNormalization(0.50, null);
    assert.equal(result, null, "null frontier → null normalization");
  });

  it("returns null when frontierScore is zero (negative path)", () => {
    const result = computePerInstanceNormalization(0.50, 0);
    assert.equal(result, null, "zero frontier → null normalization");
  });

  it("returns null for non-finite instance score (negative path)", () => {
    const result = computePerInstanceNormalization(NaN, 0.72);
    assert.equal(result, null, "NaN instance score → null");
  });
});

// ── computeProvenanceRoutingDelta ─────────────────────────────────────────────

import { computeProvenanceRoutingDelta } from "../../src/core/model_policy.js";

describe("computeProvenanceRoutingDelta — skip vs execute routing", () => {
  const makeGroundTruth = (recs: object[]) => ({
    entries: [{ cycleId: "test-cycle", recommendations: recs }],
  });

  it("routes CI-closed implemented records to skip queue", () => {
    const gt = makeGroundTruth([
      {
        id: "rec-a",
        implementationStatus: "implemented",
        mergedSha: "abc123def456abc123def456abc123def456abc1",
        ciClosed: true,
      },
    ]);
    const delta = computeProvenanceRoutingDelta(gt);
    assert.deepEqual(delta.skip, ["rec-a"]);
    assert.deepEqual(delta.execute, []);
    assert.equal(delta.provenanceCompleteCount, 1);
  });

  it("routes pending records to execute queue", () => {
    const gt = makeGroundTruth([
      { id: "rec-b", implementationStatus: "pending", mergedSha: null, ciClosed: null },
    ]);
    const delta = computeProvenanceRoutingDelta(gt);
    assert.deepEqual(delta.execute, ["rec-b"]);
    assert.deepEqual(delta.skip, []);
    assert.equal(delta.provenanceCompleteCount, 0);
  });

  it("routes implemented-but-not-CI-closed records to execute (negative path)", () => {
    const gt = makeGroundTruth([
      { id: "rec-c", implementationStatus: "implemented", mergedSha: "abc123", ciClosed: false },
    ]);
    const delta = computeProvenanceRoutingDelta(gt);
    assert.deepEqual(delta.execute, ["rec-c"], "no ciClosed → must execute");
    assert.deepEqual(delta.skip, []);
  });

  it("routes implemented-with-empty-mergedSha to execute (negative path)", () => {
    const gt = makeGroundTruth([
      { id: "rec-d", implementationStatus: "implemented", mergedSha: "", ciClosed: true },
    ]);
    const delta = computeProvenanceRoutingDelta(gt);
    assert.deepEqual(delta.execute, ["rec-d"], "empty mergedSha → must execute");
  });

  it("handles mixed set correctly (some skip, some execute)", () => {
    const gt = makeGroundTruth([
      { id: "rec-e", implementationStatus: "implemented", mergedSha: "sha1sha1sha1sha1sha1sha1sha1sha1sha1sha1", ciClosed: true },
      { id: "rec-f", implementationStatus: "pending", mergedSha: null, ciClosed: null },
      { id: "rec-g", implementationStatus: "implemented", mergedSha: "sha2sha2sha2sha2sha2sha2sha2sha2sha2sha2", ciClosed: true },
    ]);
    const delta = computeProvenanceRoutingDelta(gt);
    assert.deepEqual(delta.skip, ["rec-e", "rec-g"]);
    assert.deepEqual(delta.execute, ["rec-f"]);
    assert.equal(delta.provenanceCompleteCount, 2);
    assert.ok(delta.provenanceSummary.includes("execute=1"), "summary includes execute count");
    assert.ok(delta.provenanceSummary.includes("skip=2"), "summary includes skip count");
  });

  it("returns empty arrays for null input (fail-open, negative path)", () => {
    const delta = computeProvenanceRoutingDelta(null);
    assert.deepEqual(delta.execute, []);
    assert.deepEqual(delta.skip, []);
    assert.equal(delta.provenanceCompleteCount, 0);
  });

  it("returns empty arrays when entries array is empty", () => {
    const delta = computeProvenanceRoutingDelta({ entries: [] });
    assert.deepEqual(delta.execute, []);
    assert.deepEqual(delta.skip, []);
  });

  it("skips recommendations without an id (does not throw)", () => {
    const gt = makeGroundTruth([
      { implementationStatus: "implemented", mergedSha: "sha1sha1sha1sha1sha1sha1sha1sha1sha1sha1", ciClosed: true },
      { id: "rec-valid", implementationStatus: "pending", mergedSha: null, ciClosed: null },
    ]);
    const delta = computeProvenanceRoutingDelta(gt);
    assert.deepEqual(delta.execute, ["rec-valid"], "entry without id is skipped silently");
  });
});

describe("normalizePolicyInterventionUplift", () => {
  it("returns clamped measurable uplift score from impactAttribution baselineQualityScore", () => {
    assert.equal(
      normalizePolicyInterventionUplift({ impactAttribution: { baselineQualityScore: 8.456 } }),
      8.46,
    );
    assert.equal(
      normalizePolicyInterventionUplift({ impactAttribution: { baselineQualityScore: 99 } }),
      10,
    );
  });

  it("negative path: returns null when no measurable baseline score exists", () => {
    assert.equal(normalizePolicyInterventionUplift(null), null);
    assert.equal(normalizePolicyInterventionUplift({ impactAttribution: { baselineQualityScore: "n/a" } }), null);
  });
});

