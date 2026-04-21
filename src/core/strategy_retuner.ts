/**
 * strategy_retuner.js — Strategy auto-retune engine (Wave 6).
 *
 * Monitors capability deltas and automatically adjusts system parameters
 * when trends indicate suboptimal performance.
 *
 * Parameters that can be retuned:
 * - Prometheus freshness window
 * - Plan quality threshold
 * - Worker max parallel count
 * - SLO thresholds
 *
 * Integration: called by orchestrator at cycle end, after delta_analytics.
 */

import { detectSustainedBreachSignatures, SLO_METRIC } from "./slo_checker.js";

/**
 * @typedef {object} RetuneAction
 * @property {string} parameter — config path being adjusted
 * @property {*} currentValue — current value
 * @property {*} newValue — recommended new value
 * @property {string} reason — why the retune is recommended
 * @property {string} trigger — which trend triggered this
 */

/**
 * Evaluate whether strategy parameters need retuning based on trends.
 *
 * @param {object} config — current BOX config
 * @param {object} deltaReport — from computeCapabilityDelta
 * @returns {{ actions: RetuneAction[], shouldRetune: boolean }}
 */
export function evaluateRetune(config, deltaReport) {
  if (!deltaReport || typeof deltaReport !== "object") {
    return { actions: [], shouldRetune: false };
  }

  const trends = deltaReport.trends || {};
  const actions = [];

  // 1. If parser confidence is degrading, tighten freshness window
  if (trends.parserConfidence === "degrading") {
    const current = config?.runtime?.prometheusAnalysisFreshnessMinutes || 10;
    if (current > 5) {
      actions.push({
        parameter: "runtime.prometheusAnalysisFreshnessMinutes",
        currentValue: current,
        newValue: Math.max(5, current - 2),
        reason: "Parser confidence degrading — reduce freshness window to force re-analysis",
        trigger: "parserConfidence:degrading"
      });
    }
  }

  // 2. If plan count is degrading, relax Prometheus analysis constraints
  if (trends.planCount === "degrading") {
    const currentMaxTasks = config?.planner?.maxTasks || 0;
    if (currentMaxTasks > 0 && currentMaxTasks < 20) {
      actions.push({
        parameter: "planner.maxTasks",
        currentValue: currentMaxTasks,
        newValue: Math.min(20, currentMaxTasks + 5),
        reason: "Plan count degrading — increase max tasks allowance",
        trigger: "planCount:degrading"
      });
    }
  }

  // 3. If budget usage is increasing but workers done is stable/degrading → efficiency drop
  if (trends.budgetUsed === "improving" && (trends.workersDone === "degrading" || trends.workersDone === "stable")) {
    // "improving" budget means it's going UP which is bad for cost
    // Actually, for budgetUsed, increasing = wasted budget. Recommend tighter budget.
    actions.push({
      parameter: "budget.awareness",
      currentValue: "current",
      newValue: "tighten",
      reason: "Budget usage increasing while worker output stable/degrading — efficiency concern",
      trigger: "budgetUsed:improving+workersDone:not-improving"
    });
  }

  // 4. If overall score is very low, recommend full re-evaluation
  if (typeof deltaReport.overallScore === "number" && deltaReport.overallScore < 25) {
    actions.push({
      parameter: "strategy.fullReEval",
      currentValue: false,
      newValue: true,
      reason: `Overall capability score very low (${deltaReport.overallScore}/100) — full strategy re-evaluation recommended`,
      trigger: "overallScore:critical"
    });
  }

  return {
    actions,
    shouldRetune: actions.length > 0
  };
}

/**
 * Apply retune actions to a config object (in-memory only).
 * Returns a modified copy — does NOT write to disk.
 *
 * @param {object} config
 * @param {RetuneAction[]} actions
 * @returns {{ config: object, applied: string[] }}
 */
export function applyRetune(config, actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    return { config, applied: [] };
  }

  const updated = JSON.parse(JSON.stringify(config));
  const applied = [];

  for (const action of actions) {
    const parts = action.parameter.split(".");
    if (parts.length === 2) {
      if (!updated[parts[0]]) updated[parts[0]] = {};
      updated[parts[0]][parts[1]] = action.newValue;
      applied.push(action.parameter);
    }
  }

  return { config: updated, applied };
}

// ── SLO-driven retune ─────────────────────────────────────────────────────────

/**
 * Maps each SLO metric to the config parameter most directly responsible for
 * reducing that latency, with bounds that prevent runaway adjustments.
 *
 * step:     signed delta applied once per retune trigger (negative = decrease)
 * minValue: absolute floor — newValue is clamped to max(minValue, computed)
 * maxValue: absolute ceiling — newValue is clamped to min(maxValue, computed)
 */
const SLO_RETUNE_PARAMETER_MAP = Object.freeze({
  [SLO_METRIC.DECISION_LATENCY]: Object.freeze({
    parameter: "runtime.prometheusAnalysisFreshnessMinutes",
    defaultCurrent: 10,
    step: -2,        // reduce by 2 minutes per sustained breach event
    minValue: 5,     // never go below 5 minutes
    maxValue: Infinity,
    reason: "Sustained decision latency breaches — reduce Prometheus freshness window to force faster re-analysis",
  }),
  [SLO_METRIC.DISPATCH_LATENCY]: Object.freeze({
    parameter: "planner.maxTasks",
    defaultCurrent: 15,
    step: -3,        // reduce batch by 3 tasks per sustained breach event
    minValue: 3,     // always allow at least 3 tasks
    maxValue: Infinity,
    reason: "Sustained dispatch latency breaches — reduce max tasks per cycle to lower batch dispatch overhead",
  }),
  [SLO_METRIC.VERIFICATION_COMPLETION]: Object.freeze({
    parameter: "runtime.maxTacticalCycles",
    defaultCurrent: 6,
    step: -1,        // reduce by 1 tactical cycle per sustained breach event
    minValue: 2,     // always allow at least 2 tactical cycles
    maxValue: Infinity,
    reason: "Sustained verification completion breaches — reduce max tactical cycles to limit per-cycle workload",
  }),
});

/**
 * Resolve the current value of a two-part parameter path (e.g. "runtime.foo")
 * from config. Returns defaultValue when the field is absent or non-numeric.
 */
function resolveCurrentValue(config, parameter, defaultValue) {
  const parts = parameter.split(".");
  if (parts.length !== 2) return defaultValue;
  const val = config?.[parts[0]]?.[parts[1]];
  return typeof val === "number" && Number.isFinite(val) ? val : defaultValue;
}

/**
 * @typedef {object} SloRetuneRecommendation
 * @property {string}   parameter            - Config path to adjust (two-part dot notation)
 * @property {*}        currentValue         - Current config value
 * @property {*}        newValue             - Recommended value (bounded)
 * @property {string}   reason               - Human-readable rationale
 * @property {string}   trigger              - Machine-readable trigger code
 * @property {string}   metric               - SLO metric that drove this recommendation
 * @property {number}   sustainedBreachCount - Number of consecutive cycles that breached
 * @property {string[]} affectedCycleIds     - Provenance: cycleId of each contributing cycle
 * @property {boolean}  boundApplied         - true when newValue was clamped to a bound
 */

/**
 * Evaluate retune recommendations driven by sustained SLO breach signatures.
 *
 * Each recommendation is:
 *   - bounded: newValue is clamped within [minValue, maxValue] per metric
 *   - provenance-tagged: affectedCycleIds lists the cycles that triggered it
 *
 * @param {object}   config     - Current BOX config
 * @param {object[]} sloHistory - SLO cycle records, most-recent-first
 *                               (readSloMetrics().history)
 * @param {object}   opts
 * @param {number}   [opts.minConsecutiveBreaches=3] - Consecutive breach threshold
 * @returns {{ recommendations: SloRetuneRecommendation[], hasSustainedBreaches: boolean }}
 */
export function evaluateSloRetune(config, sloHistory, opts: { minConsecutiveBreaches?: number } = {}) {
  const signatures = detectSustainedBreachSignatures(sloHistory, opts);
  if (signatures.length === 0) {
    return { recommendations: [], hasSustainedBreaches: false };
  }

  const recommendations: any[] = [];

  for (const sig of signatures) {
    const mapping = SLO_RETUNE_PARAMETER_MAP[sig.metric];
    if (!mapping) continue;

    const current = resolveCurrentValue(config, mapping.parameter, mapping.defaultCurrent);
    const raw = current + mapping.step;
    const clamped = Math.max(mapping.minValue, Math.min(mapping.maxValue, raw));
    const boundApplied = clamped !== raw;

    // Skip if the bound prevents any change (already at floor/ceiling)
    if (clamped === current) continue;

    recommendations.push({
      parameter: mapping.parameter,
      currentValue: current,
      newValue: clamped,
      reason: mapping.reason,
      trigger: `sustainedSLOBreach:${sig.metric}`,
      metric: sig.metric,
      sustainedBreachCount: sig.consecutiveBreaches,
      affectedCycleIds: sig.affectedCycleIds,
      boundApplied,
    });
  }

  return {
    recommendations,
    hasSustainedBreaches: signatures.length > 0,
  };
}
