/**
 * Canary Metrics — Named metric set for canary/control cohort comparison.
 *
 * ## Defined metrics (AC2 / AC11)
 *
 *   taskSuccessRate   — completed tasks / total tasks in the cycle.
 *                       Source: collectCycleOutcomes().completedCount / .totalPlans
 *
 *   errorRate         — failed + errored dispatches / total dispatches.
 *                       Source: workerOutcomes[].failures / workerOutcomes[].totalDispatches
 *
 *   workerTimeoutRate — timed-out dispatches / total dispatches.
 *                       Source: workerOutcomes[].timeouts / workerOutcomes[].totalDispatches
 *
 * ## Promotion thresholds defaults (AC3 / AC12)
 *   minTaskSuccessRate : 0.8   — 80% of tasks must complete successfully
 *   maxErrorRate       : 0.1   — error rate must be below 10%
 *   Config keys: canary.promotion.minTaskSuccessRate, canary.promotion.maxErrorRate
 *
 * ## Rollback (failure signal) thresholds defaults (AC4 / AC13)
 *   triggerErrorRate           : 0.25  — error rate above 25% triggers rollback
 *   triggerTaskSuccessRateLow  : 0.5   — task success rate below 50% triggers rollback
 *   Config keys: canary.rollback.triggerErrorRate, canary.rollback.triggerTaskSuccessRateLow
 */

// ── Named metric set (AC2 / AC11) ─────────────────────────────────────────────

/** Enum of metric names used by the canary comparison engine. */
export const CANARY_METRIC_NAMES = Object.freeze({
  TASK_SUCCESS_RATE:   "taskSuccessRate",
  ERROR_RATE:          "errorRate",
  WORKER_TIMEOUT_RATE: "workerTimeoutRate"
});

// ── Threshold defaults ─────────────────────────────────────────────────────────

/**
 * Default promotion thresholds (AC3 / AC12).
 * All canary metric averages must satisfy these before global promotion is allowed.
 * Config keys: canary.promotion.minTaskSuccessRate, canary.promotion.maxErrorRate
 */
export const DEFAULT_PROMOTION_THRESHOLDS = Object.freeze({
  minTaskSuccessRate: 0.8,
  maxErrorRate:       0.1
});

/**
 * Default rollback (failure signal) thresholds (AC4 / AC13).
 * If any single snapshot's averaged metrics exceed these, rollback is triggered immediately.
 * Config keys: canary.rollback.triggerErrorRate, canary.rollback.triggerTaskSuccessRateLow
 */
export const DEFAULT_ROLLBACK_THRESHOLDS = Object.freeze({
  triggerErrorRate:          0.25,
  triggerTaskSuccessRateLow: 0.5
});

// ── Metric collection ─────────────────────────────────────────────────────────

/**
 * Collect canary metrics from a collectCycleOutcomes() result object.
 *
 * Returns a metric snapshot with all named metrics populated. When source data
 * is empty or missing, the metrics default to 0 to prevent silent NaN propagation.
 *
 * @param {object} outcomes - result from collectCycleOutcomes()
 * @returns {{ taskSuccessRate: number, errorRate: number, workerTimeoutRate: number, sampleSize: number }}
 */
export function collectCanaryMetrics(outcomes) {
  const totalPlans    = (outcomes?.totalPlans    >= 0) ? outcomes.totalPlans    : 0;
  const completedCount = (outcomes?.completedCount >= 0) ? outcomes.completedCount : 0;

  let totalDispatches = 0;
  let totalErrors     = 0;
  let totalTimeouts   = 0;

  if (Array.isArray(outcomes?.workerOutcomes)) {
    for (const w of outcomes.workerOutcomes) {
      totalDispatches += (typeof w.totalDispatches === "number") ? w.totalDispatches : 0;
      totalErrors     += (typeof w.failures        === "number") ? w.failures        : 0;
      totalTimeouts   += (typeof w.timeouts        === "number") ? w.timeouts        : 0;
    }
  }

  const taskSuccessRate   = totalPlans    > 0 ? completedCount    / totalPlans    : 0;
  const errorRate         = totalDispatches > 0 ? totalErrors      / totalDispatches : 0;
  const workerTimeoutRate = totalDispatches > 0 ? totalTimeouts    / totalDispatches : 0;

  return {
    taskSuccessRate,
    errorRate,
    workerTimeoutRate,
    sampleSize: totalDispatches || totalPlans
  };
}

// ── Threshold evaluation ──────────────────────────────────────────────────────

/**
 * Evaluate whether aggregated canary metrics satisfy all promotion thresholds.
 *
 * @param {object} canaryMetrics - aggregated metrics (from aggregateMetricSnapshots)
 * @param {object} [thresholds]  - override defaults from canary.promotion config
 * @returns {{ promote: boolean, reason: string }}
 */
export function evaluatePromotion(canaryMetrics, thresholds: any = {}) {
  const minSuccessRate = typeof thresholds.minTaskSuccessRate === "number"
    ? thresholds.minTaskSuccessRate
    : DEFAULT_PROMOTION_THRESHOLDS.minTaskSuccessRate;
  const maxErrorRate   = typeof thresholds.maxErrorRate === "number"
    ? thresholds.maxErrorRate
    : DEFAULT_PROMOTION_THRESHOLDS.maxErrorRate;

  if (canaryMetrics.taskSuccessRate < minSuccessRate) {
    return {
      promote: false,
      reason:  `TASK_SUCCESS_RATE_BELOW_THRESHOLD:${canaryMetrics.taskSuccessRate.toFixed(3)}<${minSuccessRate}`
    };
  }
  if (canaryMetrics.errorRate > maxErrorRate) {
    return {
      promote: false,
      reason:  `ERROR_RATE_ABOVE_THRESHOLD:${canaryMetrics.errorRate.toFixed(3)}>${maxErrorRate}`
    };
  }
  return { promote: true, reason: "ALL_THRESHOLDS_MET" };
}

/**
 * Evaluate whether the latest canary metrics trigger an immediate rollback signal.
 *
 * Rollback is evaluated against each individual snapshot (not the aggregate) to
 * provide fast failure detection before minCyclesToObserve is reached.
 *
 * @param {object} canaryMetrics - metrics from a single cycle snapshot
 * @param {object} [thresholds]  - override defaults from canary.rollback config
 * @returns {{ rollback: boolean, reason: string|null }}
 */
export function evaluateRollback(canaryMetrics, thresholds: any = {}) {
  const triggerError   = typeof thresholds.triggerErrorRate === "number"
    ? thresholds.triggerErrorRate
    : DEFAULT_ROLLBACK_THRESHOLDS.triggerErrorRate;
  const triggerSuccess = typeof thresholds.triggerTaskSuccessRateLow === "number"
    ? thresholds.triggerTaskSuccessRateLow
    : DEFAULT_ROLLBACK_THRESHOLDS.triggerTaskSuccessRateLow;

  if (canaryMetrics.errorRate > triggerError) {
    return {
      rollback: true,
      reason:   `ROLLBACK_ERROR_RATE_EXCEEDED:${canaryMetrics.errorRate.toFixed(3)}>${triggerError}`
    };
  }
  if (canaryMetrics.taskSuccessRate < triggerSuccess) {
    return {
      rollback: true,
      reason:   `ROLLBACK_SUCCESS_RATE_TOO_LOW:${canaryMetrics.taskSuccessRate.toFixed(3)}<${triggerSuccess}`
    };
  }
  return { rollback: false, reason: null };
}

// ── Aggregation ───────────────────────────────────────────────────────────────

/**
 * Compute averaged (aggregate) metrics from an array of per-cycle snapshots.
 * Each snapshot must be an object containing the named metric fields.
 *
 * Returns zero-value metrics when the snapshots array is empty or missing to
 * prevent NaN propagation in downstream evaluation logic.
 *
 * @param {Array<{taskSuccessRate: number, errorRate: number, workerTimeoutRate: number}>} snapshots
 * @returns {{ taskSuccessRate: number, errorRate: number, workerTimeoutRate: number, totalObservations: number }}
 */
export function aggregateMetricSnapshots(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    return { taskSuccessRate: 0, errorRate: 0, workerTimeoutRate: 0, totalObservations: 0 };
  }

  let sumSuccess = 0;
  let sumError   = 0;
  let sumTimeout = 0;

  for (const s of snapshots) {
    sumSuccess += typeof s.taskSuccessRate   === "number" ? s.taskSuccessRate   : 0;
    sumError   += typeof s.errorRate         === "number" ? s.errorRate         : 0;
    sumTimeout += typeof s.workerTimeoutRate === "number" ? s.workerTimeoutRate : 0;
  }

  const n = snapshots.length;
  return {
    taskSuccessRate:   sumSuccess / n,
    errorRate:         sumError   / n,
    workerTimeoutRate: sumTimeout / n,
    totalObservations: n
  };
}
