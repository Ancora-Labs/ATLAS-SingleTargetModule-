/**
 * evolution_metrics.js — Collects Prometheus proof-of-improvement metrics
 * and persists them to state/evolution_metrics.json.
 *
 * Called at cycle end by the orchestrator.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { readJson, writeJson } from "./fs_utils.js";
import { getCalibrationSummary } from "./janus_calibration.js";
import {
  buildInterventionLineageTelemetry,
  normalizeExternalBenchmarkSamples,
  summarizeBenchmarkSchemaCoverage,
} from "./cycle_analytics.js";
import { EXTERNAL_BENCHMARK_CONTRACTS } from "./experiment_registry.js";
import {
  loadCapabilityExecutionSummary,
  loadInterventionRetirementEvidence,
  readPromptCacheTelemetry,
} from "./state_tracker.js";
import { loadRouteROILedger } from "./model_policy.js";

const WINDOW_24H = 24 * 60 * 60_000;

/**
 * Count lines matching a pattern in progress.txt within a time window.
 * Uses simple substring matching on the raw text.
 */
async function countProgressEntries(stateDir, pattern, windowMs = WINDOW_24H) {
  try {
    const raw = await fs.readFile(path.join(stateDir, "progress.txt"), "utf8");
    const cutoff = Date.now() - windowMs;
    let count = 0;
    for (const line of raw.split("\n")) {
      if (!line.includes(pattern)) continue;
      // Try to extract timestamp from ISO prefix (lines often start with [2026-03-22T...])
      const tsMatch = line.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/);
      if (tsMatch) {
        const ts = new Date(tsMatch[1]).getTime();
        if (ts < cutoff) continue;
      }
      count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Compute deterministic postmortem bypass rate from athena_postmortems.json.
 */
async function computeDeterministicRate(stateDir) {
  const postmortems = await readJson(path.join(stateDir, "athena_postmortems.json"), []);
  if (!Array.isArray(postmortems) || postmortems.length === 0) {
    return { deterministicCount: 0, totalCount: 0, rate: null };
  }
  // Look at last 20 postmortems
  const recent = postmortems.slice(-20);
  const deterministicCount = recent.filter(p => p.model === "deterministic").length;
  return {
    deterministicCount,
    totalCount: recent.length,
    rate: recent.length > 0 ? +(deterministicCount / recent.length).toFixed(3) : null
  };
}

/**
 * Compute cycle wall-clock time p50 from recent pipeline progress records.
 * Reads the current pipeline_progress.json and any historical cycle data.
 */
async function computeCycleTimeP50(stateDir) {
  const sloHistory = await readJson(path.join(stateDir, "slo_metrics_history.json"), []);
  if (!Array.isArray(sloHistory) || sloHistory.length === 0) return null;
  const durations = sloHistory
    .filter(r => r.totalCycleDurationMs > 0)
    .map(r => r.totalCycleDurationMs)
    .sort((a, b) => a - b);
  if (durations.length === 0) return null;
  const mid = Math.floor(durations.length / 2);
  return durations.length % 2 === 0
    ? (durations[mid - 1] + durations[mid]) / 2
    : durations[mid];
}

/**
 * Collect all proof metrics and persist to state/evolution_metrics.json.
 */
export async function collectEvolutionMetrics(config) {
  const stateDir = config.paths?.stateDir || "state";

  const [
    deterministicPostmortem,
    janusCallsLast24h,
    trustBoundaryViolations24h,
    selfImprovementCalls24h,
    premiumRequests24h,
    cycleTimeP50,
    janusDirective,
    janusCalibration,
    benchmarkGroundTruth,
    promptCacheTelemetry,
    routeRoiLedger,
    capabilityExecutionSummary,
    lineageState,
    athenaPostmortems,
    retirementEvidence,
  ] = await Promise.all([
    computeDeterministicRate(stateDir),
    countProgressEntries(stateDir, "[JANUS] awakening"),
    countProgressEntries(stateDir, "[TRUST_BOUNDARY]"),
    countProgressEntries(stateDir, "[SELF_IMPROVEMENT]"),
    readJson(path.join(stateDir, "premium_usage_log.json"), []).then(log => {
      if (!Array.isArray(log)) return 0;
      const cutoff = Date.now() - WINDOW_24H;
      return log.filter(e => new Date(e.timestamp || e.ts || 0).getTime() > cutoff).length;
    }),
    computeCycleTimeP50(stateDir),
    readJson(path.join(stateDir, "janus_directive.json"), null),
    getCalibrationSummary(stateDir),
    readJson(path.join(stateDir, "benchmark_ground_truth.json"), null),
    readPromptCacheTelemetry({ paths: { stateDir } }),
    loadRouteROILedger({ paths: { stateDir } }),
    loadCapabilityExecutionSummary({ paths: { stateDir } }),
    readJson(path.join(stateDir, "lineage_graph.json"), { entries: [] }),
    readJson(path.join(stateDir, "athena_postmortems.json"), []),
    loadInterventionRetirementEvidence({ paths: { stateDir } }),
  ]);

  const janusContextCorrect = !!(janusDirective?.prometheusAnalysis?.projectHealth);
  const normalizedExternalSamples = normalizeExternalBenchmarkSamples(
    Array.isArray(benchmarkGroundTruth?.externalSamples) ? benchmarkGroundTruth.externalSamples : []
  );
  const externalBenchmarkCoverage = summarizeBenchmarkSchemaCoverage(
    EXTERNAL_BENCHMARK_CONTRACTS.map((contract) => ({
      name: String(contract.name),
      requiredFields: Array.from(contract.requiredFields),
    })),
    normalizedExternalSamples
  );
  const interventionLineageTelemetry = buildInterventionLineageTelemetry({
    premiumUsageLog: await readJson(path.join(stateDir, "premium_usage_log.json"), []),
    promptCacheTelemetry: Array.isArray(promptCacheTelemetry) ? promptCacheTelemetry : [],
    routeRoiLedger: Array.isArray(routeRoiLedger) ? routeRoiLedger : [],
    capabilityExecutionSummary,
    lineageLog: Array.isArray(lineageState?.entries) ? lineageState.entries : [],
    postmortemOutcomes: [
      ...(Array.isArray(athenaPostmortems) ? athenaPostmortems : []),
      ...(Array.isArray(retirementEvidence) ? retirementEvidence : []),
    ],
  });

  const metrics = {
    collectedAt: new Date().toISOString(),
    deterministicPostmortem,
    janusAiCallsPerDay: janusCallsLast24h,
    cycleWallClockP50Ms: cycleTimeP50,
    trustBoundaryViolations24h,
    selfImprovementCallsPerDay: selfImprovementCalls24h,
    janusContextCorrect,
    premiumRequestsPerDay: premiumRequests24h,
    janusCalibration,
    interventionLineageTelemetry,
    externalBenchmarkCoverage: {
      ...externalBenchmarkCoverage,
      normalizedSamples: normalizedExternalSamples.length,
    },
  };

  await writeJson(path.join(stateDir, "evolution_metrics.json"), metrics);
  return metrics;
}

