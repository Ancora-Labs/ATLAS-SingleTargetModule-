import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateRetune, applyRetune, evaluateSloRetune } from "../../src/core/strategy_retuner.js";
import { SLO_METRIC } from "../../src/core/slo_checker.js";

describe("strategy_retuner", () => {
  describe("evaluateRetune", () => {
    it("returns no actions for null delta", () => {
      const result = evaluateRetune({}, null);
      assert.equal(result.shouldRetune, false);
      assert.deepEqual(result.actions, []);
    });

    it("returns no actions when all trends are stable", () => {
      const delta = {
        trends: { parserConfidence: "stable", planCount: "stable", budgetUsed: "stable", workersDone: "stable" },
        overallScore: 50,
      };
      const result = evaluateRetune({}, delta);
      assert.equal(result.shouldRetune, false);
    });

    it("recommends tightening freshness when parser degrades", () => {
      const config = { runtime: { prometheusAnalysisFreshnessMinutes: 10 } };
      const delta = {
        trends: { parserConfidence: "degrading", planCount: "stable", budgetUsed: "stable", workersDone: "stable" },
        overallScore: 40,
      };
      const result = evaluateRetune(config, delta);
      assert.ok(result.shouldRetune);
      assert.ok(result.actions.some(a => a.parameter.includes("Freshness")));
    });

    it("recommends full re-eval for very low scores", () => {
      const delta = {
        trends: { parserConfidence: "degrading", planCount: "degrading", budgetUsed: "degrading", workersDone: "degrading" },
        overallScore: 10,
      };
      const result = evaluateRetune({}, delta);
      assert.ok(result.shouldRetune);
      assert.ok(result.actions.some(a => a.parameter === "strategy.fullReEval"));
    });

    it("detects budget efficiency concern", () => {
      const delta = {
        trends: { parserConfidence: "stable", planCount: "stable", budgetUsed: "improving", workersDone: "degrading" },
        overallScore: 35,
      };
      const result = evaluateRetune({}, delta);
      assert.ok(result.actions.some(a => a.parameter === "budget.awareness"));
    });

    it("recommends increasing maxTasks when planCount degrades", () => {
      const config = { planner: { maxTasks: 5 } };
      const delta = {
        trends: { parserConfidence: "stable", planCount: "degrading", budgetUsed: "stable", workersDone: "stable" },
        overallScore: 40,
      };
      const result = evaluateRetune(config, delta);
      assert.ok(result.actions.some(a => a.parameter === "planner.maxTasks"));
    });
  });

  describe("applyRetune", () => {
    it("returns unchanged config for empty actions", () => {
      const config = { runtime: { x: 1 } };
      const result = applyRetune(config, []);
      assert.deepEqual(result.config, config);
      assert.deepEqual(result.applied, []);
    });

    it("applies two-part parameter path", () => {
      const config = { runtime: { prometheusAnalysisFreshnessMinutes: 10 } };
      const actions = [
        { parameter: "runtime.prometheusAnalysisFreshnessMinutes", newValue: 8 },
      ];
      const result = applyRetune(config, actions);
      assert.equal(result.config.runtime.prometheusAnalysisFreshnessMinutes, 8);
      assert.deepEqual(result.applied, ["runtime.prometheusAnalysisFreshnessMinutes"]);
    });

    it("does not mutate original config", () => {
      const config = { runtime: { x: 1 } };
      const actions = [{ parameter: "runtime.x", newValue: 2 }];
      applyRetune(config, actions);
      assert.equal(config.runtime.x, 1);
    });
  });
});

// ── evaluateSloRetune ─────────────────────────────────────────────────────────

// Helper: build a minimal SLO history entry that breaches one metric
function makeSloRecord(metric, cycleId, actual = 200000, threshold = 120000) {
  return {
    cycleId,
    startedAt: cycleId,
    sloBreaches: [{ metric, actual, threshold, severity: "high" }],
  };
}

function makeCleanRecord(cycleId) {
  return { cycleId, startedAt: cycleId, sloBreaches: [] };
}

describe("evaluateSloRetune", () => {
  it("returns no recommendations for null/empty history", () => {
    const r1 = evaluateSloRetune({}, null as any);
    assert.equal(r1.hasSustainedBreaches, false);
    assert.deepEqual(r1.recommendations, []);

    const r2 = evaluateSloRetune({}, []);
    assert.equal(r2.hasSustainedBreaches, false);
  });

  it("returns no recommendations when breaches are fewer than minConsecutiveBreaches", () => {
    const history = [
      makeSloRecord(SLO_METRIC.DECISION_LATENCY, "c2"),
      makeSloRecord(SLO_METRIC.DECISION_LATENCY, "c1"),
    ];
    const result = evaluateSloRetune({}, history, { minConsecutiveBreaches: 3 });
    assert.equal(result.hasSustainedBreaches, false);
    assert.equal(result.recommendations.length, 0);
  });

  it("returns a recommendation with provenance when decision latency has sustained breaches", () => {
    const history = [
      makeSloRecord(SLO_METRIC.DECISION_LATENCY, "c3"),
      makeSloRecord(SLO_METRIC.DECISION_LATENCY, "c2"),
      makeSloRecord(SLO_METRIC.DECISION_LATENCY, "c1"),
    ];
    const config = { runtime: { prometheusAnalysisFreshnessMinutes: 10 } };
    const result = evaluateSloRetune(config, history, { minConsecutiveBreaches: 3 });

    assert.equal(result.hasSustainedBreaches, true);
    const rec = result.recommendations.find(r => r.metric === SLO_METRIC.DECISION_LATENCY);
    assert.ok(rec, "recommendation for decisionLatencyMs must be present");
    assert.equal(rec.parameter, "runtime.prometheusAnalysisFreshnessMinutes");
    assert.equal(rec.currentValue, 10);
    assert.equal(rec.newValue, 8);    // 10 - 2 step
    assert.equal(rec.sustainedBreachCount, 3);
    assert.deepEqual(rec.affectedCycleIds, ["c3", "c2", "c1"]);
    assert.ok(rec.trigger.startsWith("sustainedSLOBreach:"));
    assert.ok(typeof rec.reason === "string" && rec.reason.length > 0);
  });

  it("returns a recommendation for dispatch latency sustained breaches", () => {
    const history = [
      makeSloRecord(SLO_METRIC.DISPATCH_LATENCY, "c3", 60000, 30000),
      makeSloRecord(SLO_METRIC.DISPATCH_LATENCY, "c2", 60000, 30000),
      makeSloRecord(SLO_METRIC.DISPATCH_LATENCY, "c1", 60000, 30000),
    ];
    const config = { planner: { maxTasks: 15 } };
    const result = evaluateSloRetune(config, history, { minConsecutiveBreaches: 3 });

    assert.equal(result.hasSustainedBreaches, true);
    const rec = result.recommendations.find(r => r.metric === SLO_METRIC.DISPATCH_LATENCY);
    assert.ok(rec);
    assert.equal(rec.parameter, "planner.maxTasks");
    assert.equal(rec.newValue, 12);  // 15 - 3 step
  });

  it("returns a recommendation for verification completion sustained breaches", () => {
    const history = [
      makeSloRecord(SLO_METRIC.VERIFICATION_COMPLETION, "c3", 7200000, 3600000),
      makeSloRecord(SLO_METRIC.VERIFICATION_COMPLETION, "c2", 7200000, 3600000),
      makeSloRecord(SLO_METRIC.VERIFICATION_COMPLETION, "c1", 7200000, 3600000),
    ];
    const config = { runtime: { maxTacticalCycles: 6 } };
    const result = evaluateSloRetune(config, history, { minConsecutiveBreaches: 3 });

    const rec = result.recommendations.find(r => r.metric === SLO_METRIC.VERIFICATION_COMPLETION);
    assert.ok(rec);
    assert.equal(rec.parameter, "runtime.maxTacticalCycles");
    assert.equal(rec.newValue, 5);   // 6 - 1 step
  });

  it("newValue is bounded at minValue floor", () => {
    const history = [
      makeSloRecord(SLO_METRIC.DECISION_LATENCY, "c3"),
      makeSloRecord(SLO_METRIC.DECISION_LATENCY, "c2"),
      makeSloRecord(SLO_METRIC.DECISION_LATENCY, "c1"),
    ];
    // prometheusAnalysisFreshnessMinutes already at floor (5)
    const config = { runtime: { prometheusAnalysisFreshnessMinutes: 5 } };
    const result = evaluateSloRetune(config, history, { minConsecutiveBreaches: 3 });
    // 5 - 2 = 3 but floor is 5, so clamped — and since clamped === current, no recommendation
    const rec = result.recommendations.find(r => r.metric === SLO_METRIC.DECISION_LATENCY);
    assert.ok(!rec, "no recommendation when already at the floor bound");
  });

  it("boundApplied is true when newValue is clamped to floor", () => {
    const history = [
      makeSloRecord(SLO_METRIC.DECISION_LATENCY, "c3"),
      makeSloRecord(SLO_METRIC.DECISION_LATENCY, "c2"),
      makeSloRecord(SLO_METRIC.DECISION_LATENCY, "c1"),
    ];
    // Floor is 5; setting current to 6 so step produces 4 which gets clamped to 5
    const config = { runtime: { prometheusAnalysisFreshnessMinutes: 6 } };
    const result = evaluateSloRetune(config, history, { minConsecutiveBreaches: 3 });
    const rec = result.recommendations.find(r => r.metric === SLO_METRIC.DECISION_LATENCY);
    assert.ok(rec);
    assert.equal(rec.newValue, 5);
    assert.equal(rec.boundApplied, true);
  });

  it("uses default current value when config field is absent", () => {
    const history = [
      makeSloRecord(SLO_METRIC.DECISION_LATENCY, "c3"),
      makeSloRecord(SLO_METRIC.DECISION_LATENCY, "c2"),
      makeSloRecord(SLO_METRIC.DECISION_LATENCY, "c1"),
    ];
    // No runtime config provided — falls back to default (10)
    const result = evaluateSloRetune({}, history, { minConsecutiveBreaches: 3 });
    const rec = result.recommendations.find(r => r.metric === SLO_METRIC.DECISION_LATENCY);
    assert.ok(rec);
    assert.equal(rec.currentValue, 10);
    assert.equal(rec.newValue, 8);
  });

  it("streak break stops recommendation (negative path)", () => {
    const history = [
      makeSloRecord(SLO_METRIC.DECISION_LATENCY, "c4"),
      makeSloRecord(SLO_METRIC.DECISION_LATENCY, "c3"),
      makeCleanRecord("c2"),                          // streak broken
      makeSloRecord(SLO_METRIC.DECISION_LATENCY, "c1"),
    ];
    const result = evaluateSloRetune({}, history, { minConsecutiveBreaches: 3 });
    assert.equal(result.recommendations.length, 0);
    assert.equal(result.hasSustainedBreaches, false);
  });

  it("recommendations carry trigger code 'sustainedSLOBreach:<metric>'", () => {
    const history = [
      makeSloRecord(SLO_METRIC.DISPATCH_LATENCY, "c3"),
      makeSloRecord(SLO_METRIC.DISPATCH_LATENCY, "c2"),
      makeSloRecord(SLO_METRIC.DISPATCH_LATENCY, "c1"),
    ];
    const result = evaluateSloRetune({}, history, { minConsecutiveBreaches: 3 });
    const rec = result.recommendations[0];
    assert.ok(rec);
    assert.equal(rec.trigger, `sustainedSLOBreach:${SLO_METRIC.DISPATCH_LATENCY}`);
  });
});
