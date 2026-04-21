import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CANARY_METRIC_NAMES,
  DEFAULT_PROMOTION_THRESHOLDS,
  DEFAULT_ROLLBACK_THRESHOLDS,
  collectCanaryMetrics,
  evaluatePromotion,
  evaluateRollback,
  aggregateMetricSnapshots
} from "../../src/core/canary_metrics.js";

describe("CANARY_METRIC_NAMES", () => {
  it("exports the three expected named metric keys", () => {
    assert.equal(CANARY_METRIC_NAMES.TASK_SUCCESS_RATE, "taskSuccessRate");
    assert.equal(CANARY_METRIC_NAMES.ERROR_RATE, "errorRate");
    assert.equal(CANARY_METRIC_NAMES.WORKER_TIMEOUT_RATE, "workerTimeoutRate");
  });

  it("is frozen and cannot be mutated", () => {
    assert.throws(() => {
      (CANARY_METRIC_NAMES as any).NEW_KEY = "should_fail";
    });
  });
});

describe("DEFAULT_PROMOTION_THRESHOLDS", () => {
  it("has minTaskSuccessRate of 0.8", () => {
    assert.equal(DEFAULT_PROMOTION_THRESHOLDS.minTaskSuccessRate, 0.8);
  });

  it("has maxErrorRate of 0.1", () => {
    assert.equal(DEFAULT_PROMOTION_THRESHOLDS.maxErrorRate, 0.1);
  });
});

describe("DEFAULT_ROLLBACK_THRESHOLDS", () => {
  it("has triggerErrorRate of 0.25", () => {
    assert.equal(DEFAULT_ROLLBACK_THRESHOLDS.triggerErrorRate, 0.25);
  });

  it("has triggerTaskSuccessRateLow of 0.5", () => {
    assert.equal(DEFAULT_ROLLBACK_THRESHOLDS.triggerTaskSuccessRateLow, 0.5);
  });
});

describe("collectCanaryMetrics", () => {
  it("computes taskSuccessRate from completedCount / totalPlans", () => {
    const metrics = collectCanaryMetrics({ totalPlans: 10, completedCount: 8, workerOutcomes: [] });
    assert.equal(metrics.taskSuccessRate, 0.8);
  });

  it("computes errorRate from failures / totalDispatches", () => {
    const metrics = collectCanaryMetrics({
      totalPlans: 5,
      completedCount: 5,
      workerOutcomes: [{ totalDispatches: 20, failures: 4, timeouts: 0 }]
    });
    assert.equal(metrics.errorRate, 0.2);
  });

  it("computes workerTimeoutRate from timeouts / totalDispatches", () => {
    const metrics = collectCanaryMetrics({
      totalPlans: 5,
      completedCount: 5,
      workerOutcomes: [{ totalDispatches: 10, failures: 0, timeouts: 2 }]
    });
    assert.equal(metrics.workerTimeoutRate, 0.2);
  });

  it("aggregates across multiple workerOutcomes entries", () => {
    const metrics = collectCanaryMetrics({
      totalPlans: 10,
      completedCount: 7,
      workerOutcomes: [
        { totalDispatches: 10, failures: 1, timeouts: 1 },
        { totalDispatches: 10, failures: 2, timeouts: 0 }
      ]
    });
    assert.equal(metrics.errorRate, 3 / 20);
    assert.equal(metrics.workerTimeoutRate, 1 / 20);
    assert.equal(metrics.sampleSize, 20);
  });

  it("defaults to 0 when totalPlans is 0 (no NaN propagation)", () => {
    const metrics = collectCanaryMetrics({ totalPlans: 0, completedCount: 0, workerOutcomes: [] });
    assert.equal(metrics.taskSuccessRate, 0);
    assert.equal(metrics.errorRate, 0);
    assert.equal(metrics.workerTimeoutRate, 0);
  });

  it("negative path: returns zero metrics for null/undefined input", () => {
    const metrics = collectCanaryMetrics(null);
    assert.equal(metrics.taskSuccessRate, 0);
    assert.equal(metrics.errorRate, 0);
    assert.equal(metrics.workerTimeoutRate, 0);
    assert.equal(metrics.sampleSize, 0);
  });

  it("negative path: skips non-numeric worker fields without crashing", () => {
    const metrics = collectCanaryMetrics({
      totalPlans: 4,
      completedCount: 4,
      workerOutcomes: [{ totalDispatches: "bad", failures: null, timeouts: undefined }]
    });
    assert.equal(metrics.errorRate, 0);
    assert.equal(metrics.workerTimeoutRate, 0);
  });

  it("uses sampleSize = totalPlans when no worker dispatches occurred", () => {
    const metrics = collectCanaryMetrics({ totalPlans: 5, completedCount: 3, workerOutcomes: [] });
    assert.equal(metrics.sampleSize, 5);
  });
});

describe("evaluatePromotion", () => {
  it("returns promote=true when all thresholds are met", () => {
    const result = evaluatePromotion({ taskSuccessRate: 0.9, errorRate: 0.05 });
    assert.equal(result.promote, true);
    assert.equal(result.reason, "ALL_THRESHOLDS_MET");
  });

  it("returns promote=false when taskSuccessRate is below threshold", () => {
    const result = evaluatePromotion({ taskSuccessRate: 0.7, errorRate: 0.05 });
    assert.equal(result.promote, false);
    assert.match(result.reason, /TASK_SUCCESS_RATE_BELOW_THRESHOLD/);
  });

  it("returns promote=false when errorRate is above threshold", () => {
    const result = evaluatePromotion({ taskSuccessRate: 0.9, errorRate: 0.15 });
    assert.equal(result.promote, false);
    assert.match(result.reason, /ERROR_RATE_ABOVE_THRESHOLD/);
  });

  it("respects custom thresholds when provided", () => {
    const result = evaluatePromotion(
      { taskSuccessRate: 0.6, errorRate: 0.05 },
      { minTaskSuccessRate: 0.5, maxErrorRate: 0.2 }
    );
    assert.equal(result.promote, true);
  });

  it("negative path: promote=false at exactly the success rate boundary", () => {
    // taskSuccessRate must be >= minTaskSuccessRate; at exactly 0.8 it should pass
    const pass = evaluatePromotion({ taskSuccessRate: 0.8, errorRate: 0.05 });
    assert.equal(pass.promote, true);
    // below threshold
    const fail = evaluatePromotion({ taskSuccessRate: 0.79, errorRate: 0.05 });
    assert.equal(fail.promote, false);
  });
});

describe("evaluateRollback", () => {
  it("returns rollback=false when metrics are healthy", () => {
    const result = evaluateRollback({ taskSuccessRate: 0.9, errorRate: 0.05 });
    assert.equal(result.rollback, false);
    assert.equal(result.reason, null);
  });

  it("returns rollback=true when errorRate exceeds trigger threshold", () => {
    const result = evaluateRollback({ taskSuccessRate: 0.8, errorRate: 0.3 });
    assert.equal(result.rollback, true);
    assert.match(result.reason, /ROLLBACK_ERROR_RATE_EXCEEDED/);
  });

  it("returns rollback=true when taskSuccessRate falls below trigger threshold", () => {
    const result = evaluateRollback({ taskSuccessRate: 0.4, errorRate: 0.1 });
    assert.equal(result.rollback, true);
    assert.match(result.reason, /ROLLBACK_SUCCESS_RATE_TOO_LOW/);
  });

  it("respects custom rollback thresholds", () => {
    const result = evaluateRollback(
      { taskSuccessRate: 0.6, errorRate: 0.2 },
      { triggerErrorRate: 0.15, triggerTaskSuccessRateLow: 0.7 }
    );
    // errorRate 0.2 > 0.15 → rollback
    assert.equal(result.rollback, true);
    assert.match(result.reason, /ROLLBACK_ERROR_RATE_EXCEEDED/);
  });

  it("negative path: no rollback when metrics are exactly at trigger thresholds", () => {
    // errorRate must exceed (not equal) the threshold
    const result = evaluateRollback({ taskSuccessRate: 0.5, errorRate: 0.25 });
    // errorRate 0.25 is NOT > 0.25, taskSuccessRate 0.5 is NOT < 0.5
    assert.equal(result.rollback, false);
  });
});

describe("aggregateMetricSnapshots", () => {
  it("averages metric values across multiple snapshots", () => {
    const snapshots = [
      { taskSuccessRate: 1.0, errorRate: 0.0, workerTimeoutRate: 0.0 },
      { taskSuccessRate: 0.0, errorRate: 1.0, workerTimeoutRate: 0.0 }
    ];
    const result = aggregateMetricSnapshots(snapshots);
    assert.equal(result.taskSuccessRate, 0.5);
    assert.equal(result.errorRate, 0.5);
    assert.equal(result.workerTimeoutRate, 0.0);
    assert.equal(result.totalObservations, 2);
  });

  it("returns zero metrics for an empty array (no NaN propagation)", () => {
    const result = aggregateMetricSnapshots([]);
    assert.equal(result.taskSuccessRate, 0);
    assert.equal(result.errorRate, 0);
    assert.equal(result.workerTimeoutRate, 0);
    assert.equal(result.totalObservations, 0);
  });

  it("negative path: returns zero metrics for null input", () => {
    const result = aggregateMetricSnapshots(null);
    assert.equal(result.taskSuccessRate, 0);
    assert.equal(result.totalObservations, 0);
  });

  it("negative path: treats non-numeric snapshot fields as 0", () => {
    const snapshots = [
      { taskSuccessRate: "bad", errorRate: null, workerTimeoutRate: undefined }
    ];
    const result = aggregateMetricSnapshots(snapshots as any);
    assert.equal(result.taskSuccessRate, 0);
    assert.equal(result.errorRate, 0);
    assert.equal(result.workerTimeoutRate, 0);
  });

  it("handles a single snapshot correctly", () => {
    const snapshots = [{ taskSuccessRate: 0.9, errorRate: 0.02, workerTimeoutRate: 0.01 }];
    const result = aggregateMetricSnapshots(snapshots);
    assert.equal(result.taskSuccessRate, 0.9);
    assert.equal(result.totalObservations, 1);
  });
});
