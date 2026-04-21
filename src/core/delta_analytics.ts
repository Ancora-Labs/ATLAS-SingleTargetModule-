/**
 * delta_analytics.js — Monthly capability delta analytics (Wave 6).
 *
 * Computes how the system's capabilities changed over a time window
 * by comparing capacity scoreboard entries.
 *
 * Tracks: throughput trends, parser quality, plan counts, worker diversification,
 * learning closure rate, and model efficiency.
 *
 * Integration: called by orchestrator at cycle end to persist compounding analytics.
 */

import { getRecentCapacity, computeTrend } from "./capacity_scoreboard.js";

/**
 * @typedef {object} DeltaReport
 * @property {string} period — human-readable period description
 * @property {string} generatedAt — ISO timestamp
 * @property {object} trends — per-field trend assessments
 * @property {object} summary — high-level summary
 * @property {number} overallScore — composite capability score 0-100
 */

/**
 * Compute capability delta from recent scoreboard entries.
 *
 * @param {object} config — BOX config
 * @param {{ windowSize?: number }} opts
 * @returns {Promise<DeltaReport>}
 */
export async function computeCapabilityDelta(config, opts: any = {}) {
  const windowSize = opts.windowSize || 20;
  const entries = await getRecentCapacity(config, windowSize);

  const trends = {
    parserConfidence: computeTrend(entries, "parserConfidence"),
    planCount:        computeTrend(entries, "planCount"),
    budgetUsed:       computeTrend(entries, "budgetUsed"),
    workersDone:      computeTrend(entries, "workersDone"),
  };

  // Compute overall score based on trends
  const trendScores = { improving: 1, stable: 0.5, degrading: 0, insufficient_data: 0.3 };
  const trendValues = Object.values(trends).map(t => trendScores[t] ?? 0.3);
  const overallScore = trendValues.length > 0
    ? Math.round((trendValues.reduce((a, b) => a + b, 0) / trendValues.length) * 100)
    : 0;

  // Summary
  const improving = Object.entries(trends).filter(([, v]) => v === "improving").map(([k]) => k);
  const degrading = Object.entries(trends).filter(([, v]) => v === "degrading").map(([k]) => k);

  return {
    period: `Last ${entries.length} cycles`,
    generatedAt: new Date().toISOString(),
    trends,
    summary: {
      improving,
      degrading,
      entryCount: entries.length,
      hasEnoughData: entries.length >= 6,
    },
    overallScore,
  };
}

/**
 * Compute learning closure rate from postmortem data.
 * Measures: how many postmortem lessons resulted in enforced policy changes.
 *
 * @param {object[]} postmortems
 * @param {string[]} enforcedPolicyIds — IDs of policies currently enforced
 * @returns {{ closureRate: number, totalLessons: number, compiledCount: number }}
 */
export function computeLearningClosureRate(postmortems, enforcedPolicyIds = []) {
  if (!Array.isArray(postmortems)) return { closureRate: 0, totalLessons: 0, compiledCount: 0 };

  const totalLessons = postmortems.filter(p => String(p?.lessonLearned || "").trim().length > 10).length;
  const compiledCount = enforcedPolicyIds.length;

  return {
    closureRate: totalLessons > 0 ? Math.round((compiledCount / totalLessons) * 100) / 100 : 0,
    totalLessons,
    compiledCount,
  };
}
