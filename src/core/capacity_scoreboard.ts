/**
 * capacity_scoreboard.js — Persists capacity KPIs across cycles.
 *
 * Tracks key metrics over time so Prometheus and Janus can observe trends
 * rather than point-in-time snapshots.
 *
 * Stored in: state/capacity_scoreboard.json
 */

import path from "node:path";
import { readJson, writeJson } from "./fs_utils.js";

/** Maximum entries to keep in the scoreboard. */
const MAX_ENTRIES = 100;

/**
 * @typedef {object} CapacityEntry
 * @property {string} recordedAt — ISO timestamp
 * @property {number} parserConfidence — 0-1 aggregate (core − contextual penalties)
 * @property {number} [parserCoreConfidence] — 0-1 structural parser signals only, independent from contextual penalties
 * @property {number} [parserContextPenalty] — magnitude of contextual penalties subtracted from parserCoreConfidence
 * @property {number} planCount — plans in last Prometheus run
 * @property {string} projectHealth — healthy|warning|critical
 * @property {string} optimizerStatus — ok|budget_exceeded|etc
 * @property {number} budgetUsed
 * @property {number} budgetLimit
 * @property {number} workersDone — workers completed in last cycle
 * @property {number} [completionYield] — funnel completionRate (0-1); proportion of dispatched plans that completed successfully.
 *   Used as the yield signal for coupled alert detection (YIELD_COLLAPSE_WITH_VERIFICATION_BREACH).
 * @property {number} [verificationLatencyMs] — verificationCompletionMs from the SLO record for this cycle;
 *   tracked here so the scoreboard can surface the coupled alert precondition as a persistent trend.
 * @property {number} [specializedShareTarget] — adaptive specialization share target (0–1) derived from config + lane performance.
 * @property {boolean} [specializedShareTargetMet] — whether the adaptive specialization target was met this cycle.
 * @property {number} [configuredMinSpecializedShare] — configured (pre-adaptation) minimum specialized share from workerPool policy (0–1).
 * @property {number} [specialistRerouteCount] — count of workers rerouted from specialist lane to evolution-worker this cycle.
 * @property {number} [infeasibleTopologyBypassCount] — count of admission gate bypasses this cycle that were caused by
 *   INFEASIBLE_TOPOLOGY (no specialist-eligible plans in the task mix). This is a structural signal — it is NOT evidence
 *   of specialist under-utilization and must NOT be added to trueUnderutilizationCount.
 * @property {number} [trueUnderutilizationCount] — count of admission gate blocks or bypassed_fallback events this cycle
 *   where specialist-eligible plans existed but the specialized_share fell below the adaptive threshold.
 *   Contrasts with infeasibleTopologyBypassCount: here the structure was feasible but specialists weren't deployed enough.
 * @property {object} [laneTelemetry] — per-lane capacity distribution snapshot from cycle analytics.
 * @property {object} [optimizerUsage] — optimizer resource usage for the cycle.
 */

/**
 * Append a new entry to the capacity scoreboard.
 *
 * @param {object} config — BOX config with paths.stateDir
 * @param {CapacityEntry} entry
 */
export async function appendCapacityEntry(config, entry) {
  const stateDir = config?.paths?.stateDir || "state";
  const filePath = path.join(stateDir, "capacity_scoreboard.json");
  const data = await readJson(filePath, []);
  const entries = Array.isArray(data) ? data : [];
  entries.push({
    ...entry,
    recordedAt: entry.recordedAt || new Date().toISOString()
  });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  await writeJson(filePath, entries);
}

/**
 * Read the latest N entries from the scoreboard.
 *
 * @param {object} config
 * @param {number} [n=10]
 * @returns {Promise<CapacityEntry[]>}
 */
export async function getRecentCapacity(config, n = 10) {
  const stateDir = config?.paths?.stateDir || "state";
  const filePath = path.join(stateDir, "capacity_scoreboard.json");
  const data = await readJson(filePath, []);
  const entries = Array.isArray(data) ? data : [];
  return entries.slice(-n);
}

/**
 * Compute trend direction from recent entries.
 *
 * @param {CapacityEntry[]} entries
 * @param {string} field — field name to trend
 * @returns {"improving"|"stable"|"degrading"|"insufficient_data"}
 */
export function computeTrend(entries, field) {
  if (!Array.isArray(entries) || entries.length < 3) return "insufficient_data";

  const values = entries.map(e => Number(e[field])).filter(v => Number.isFinite(v));
  if (values.length < 3) return "insufficient_data";

  const recent = values.slice(-3);
  const earlier = values.slice(-6, -3);
  if (earlier.length === 0) return "insufficient_data";

  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const earlierAvg = earlier.reduce((a, b) => a + b, 0) / earlier.length;

  const delta = recentAvg - earlierAvg;
  const threshold = 0.05;

  if (delta > threshold) return "improving";
  if (delta < -threshold) return "degrading";
  return "stable";
}

/**
 * Capacity Index Decomposition — 10-Dimension Balanced Score (Packet 17).
 *
 * Each dimension is scored 0-1. The composite index is the mean of all dimensions.
 * This gives Prometheus and Janus a multi-dimensional view of system capacity.
 *
 * @typedef {object} CapacityIndex
 * @property {number} architecture — system modularity, data flow quality
 * @property {number} speed — cycle throughput, latency
 * @property {number} taskQuality — correctness, depth, completeness
 * @property {number} promptQuality — instruction clarity, model utilization
 * @property {number} parserQuality — output parsing, confidence
 * @property {number} workerSpecialization — role diversity, capability matching
 * @property {number} modelTaskFit — routing accuracy, token efficiency
 * @property {number} learningLoop — postmortem-to-policy closure rate
 * @property {number} costEfficiency — premium requests per useful outcome
 * @property {number} security — vulnerability prevention, governance compliance
 */

/**
 * Compute the 10-dimension capacity index from cycle data.
 *
 * @param {object} cycleData
 * @param {number} [cycleData.parserConfidence] — 0-1 aggregate (core − contextual penalties); used for promptQuality
 * @param {number} [cycleData.parserCoreConfidence] — 0-1 structural signals only; used for parserQuality (independent from context)
 * @param {number} [cycleData.planContractPassRate] — 0-1
 * @param {number} [cycleData.testPassRate] — 0-1
 * @param {number} [cycleData.workerDoneRate] — 0-1
 * @param {number} [cycleData.diversityIndex] — 0-1
 * @param {number} [cycleData.recurrenceClosureRate] — 0-1
 * @param {number} [cycleData.premiumEfficiency] — 0-1
 * @param {number} [cycleData.securityScore] — 0-1
 * @param {number} [cycleData.cycleDurationMinutes] — actual duration
 * @param {number} [cycleData.targetDurationMinutes] — target duration
 * @param {number} [cycleData.outcomeScore] — composite long-horizon routing outcome score (0-1)
 * @param {number} [cycleData.attemptRate] — ratio of routed tasks that produced a substantive attempt (0-1)
 * @param {number} [cycleData.abstainRate] — ratio of routed tasks that abstained or timed out before an attempt (0-1)
 * @param {number} [cycleData.precisionOnAttempted] — successes / attempted tasks (0-1)
 * @param {number} [cycleData.hardChainSuccessRate] — end-to-end success rate for hard typed-handoff chains (0-1)
 * @param {number} [cycleData.hardChainSampleCount] — number of hard chains contributing to hardChainSuccessRate
 * @param {number} [cycleData.laneReliability] — weighted lane reliability score derived from cycle analytics (0-1)
 * @param {number} [cycleData.avgTierROI] — average realized ROI for the current tier (0 = no data);
 *   when positive, this replaces premiumEfficiency as the modelTaskFit signal for higher fidelity
 * @returns {{ dimensions: CapacityIndex, composite: number, deltas: Record<string, number>|null }}
 */
export function computeCapacityIndex(cycleData: any = {}, previousIndex = null) {
  const routingOutcomeScore = computeRoutingOutcomeScore(cycleData);
  const d = {
    architecture: clamp(cycleData.planContractPassRate ?? 0.5),
    speed: clamp(cycleData.targetDurationMinutes
      ? Math.min(1, cycleData.targetDurationMinutes / Math.max(1, cycleData.cycleDurationMinutes || cycleData.targetDurationMinutes))
      : 0.5),
    taskQuality: clamp(cycleData.testPassRate ?? 0.5),
    promptQuality: clamp(cycleData.parserConfidence ?? 0.5),
    // parserQuality uses parserCoreConfidence (structural signals only) so parser
    // trend tracking is independent from contextual penalties like bottleneckCoverage
    // or architectureDrift.  Falls back to parserConfidence for backward compatibility.
    parserQuality: clamp(cycleData.parserCoreConfidence ?? cycleData.parserConfidence ?? 0.5),
    workerSpecialization: clamp(cycleData.diversityIndex ?? 0),
    // avgTierROI (from computeRecentROIForTier) provides a higher-fidelity routing
    // accuracy signal than premiumEfficiency when tier-level ROI history is available.
    // Values > 1.0 are clamped so the dimension stays within [0, 1].
    modelTaskFit: clamp(
      (cycleData.avgTierROI != null && cycleData.avgTierROI > 0)
        ? Math.min(1, cycleData.avgTierROI)
        : (routingOutcomeScore ?? cycleData.premiumEfficiency ?? 0.5)
    ),
    learningLoop: clamp(cycleData.recurrenceClosureRate ?? 0),
    costEfficiency: clamp(routingOutcomeScore ?? cycleData.premiumEfficiency ?? 0.5),
    security: clamp(cycleData.securityScore ?? 0.7),
  };

  const values = Object.values(d);
  const composite = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;

  // Compute deltas from previous index
  let deltas = null;
  if (previousIndex && previousIndex.dimensions) {
    deltas = {};
    for (const [key, val] of Object.entries(d)) {
      const prev = previousIndex.dimensions[key] ?? val;
      deltas[key] = Math.round((val - prev) * 1000) / 1000;
    }
  }

  return { dimensions: d, composite, deltas };
}

function clamp(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}

function computeRoutingOutcomeScore(cycleData: any = {}): number | null {
  const explicit = Number(cycleData?.outcomeScore);
  if (Number.isFinite(explicit)) return clamp(explicit);
  const metrics = [
    Number(cycleData?.precisionOnAttempted),
    Number(cycleData?.attemptRate),
    Number.isFinite(Number(cycleData?.abstainRate)) ? 1 - Number(cycleData?.abstainRate) : null,
    Number(cycleData?.laneReliability),
  ].filter((value) => Number.isFinite(value));
  const hardChainSampleCount = Number(cycleData?.hardChainSampleCount ?? 0);
  const hardChainSuccessRate = Number(cycleData?.hardChainSuccessRate);
  if (hardChainSampleCount > 0 && Number.isFinite(hardChainSuccessRate)) {
    metrics.push(hardChainSuccessRate);
  }
  if (metrics.length === 0) return null;
  return clamp(metrics.reduce((sum, value) => sum + value, 0) / metrics.length);
}

// ── ROI-weighted capacity index ───────────────────────────────────────────────

/**
 * Compute the capacity index with the `modelTaskFit` dimension weighted by
 * realized tier ROI.
 *
 * When realized ROI data is available it replaces the heuristic `premiumEfficiency`
 * estimate for the `modelTaskFit` dimension, then applies a boost/penalty factor:
 *   - tierROI >= 0.8 → roiWeight = 1.1 (productive tier; slight boost)
 *   - 0 < tierROI < 0.3 → roiWeight = 0.85 (underperforming; penalty)
 *   - otherwise → roiWeight = 1.0 (neutral / no history)
 *
 * All other dimensions are computed identically to computeCapacityIndex.
 *
 * @param cycleData     — same shape as computeCapacityIndex's cycleData
 * @param tierROI       — recent average realized ROI for the current tier (0 = no data)
 * @param previousIndex — optional previous index for delta computation
 * @returns {{ dimensions, composite, deltas, roiWeight }}
 */
export function computeROIWeightedCapacityIndex(
  cycleData: any = {},
  tierROI = 0,
  previousIndex = null,
): { dimensions: any; composite: number; deltas: Record<string, number> | null; roiWeight: number } {
  // Determine ROI weight factor
  let roiWeight = 1.0;
  if (tierROI > 0 && tierROI >= 0.8)  roiWeight = 1.1;
  else if (tierROI > 0 && tierROI < 0.3) roiWeight = 0.85;

  // Derive base model-task-fit from realized ROI when available
  const routingOutcomeScore = computeRoutingOutcomeScore(cycleData);
  const baseModelTaskFit = (tierROI > 0)
    ? Math.min(1, tierROI)
    : (routingOutcomeScore ?? cycleData.premiumEfficiency ?? 0.5);

  const adjustedCycleData = {
    ...cycleData,
    // avgTierROI triggers the high-fidelity path inside computeCapacityIndex
    avgTierROI: tierROI > 0 ? Math.min(1, tierROI * roiWeight) : undefined,
  };

  const base = computeCapacityIndex(adjustedCycleData, previousIndex);

  // Re-derive dimensions with ROI weighting applied to modelTaskFit
  const roiAdjustedModelTaskFit = clamp(baseModelTaskFit * roiWeight);
  const dimensions = { ...base.dimensions, modelTaskFit: roiAdjustedModelTaskFit };

  const values = Object.values(dimensions) as number[];
  const composite = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;

  let deltas: Record<string, number> | null = null;
  if (previousIndex && (previousIndex as any).dimensions) {
    deltas = {};
    for (const [key, val] of Object.entries(dimensions)) {
      const prev = ((previousIndex as any).dimensions[key] as number) ?? (val as number);
      deltas[key] = Math.round(((val as number) - prev) * 1000) / 1000;
    }
  }

  return { dimensions, composite, deltas, roiWeight };
}

