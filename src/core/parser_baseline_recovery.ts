/**
 * parser_baseline_recovery.ts — Baseline recovery mode for parser confidence.
 *
 * When parserConfidence falls below PARSER_CONFIDENCE_RECOVERY_THRESHOLD (0.9),
 * the system enters "baseline recovery mode". This does NOT block dispatch (the
 * hard-stop gate at config.runtime.parserConfidenceThreshold handles that), but
 * it:
 *   1. Computes per-component confidence gaps (plansShape, healthField, requestBudget).
 *   2. Persists structural/schema component metrics to state/parser_baseline_metrics.json.
 *   3. Returns a recovery state object for use in cycle telemetry.
 *
 * The persisted file uses a rolling history (default: 100 entries) so trend
 * analysis can surface which components are chronically underperforming.
 *
 * Context: dispatch gating (orchestrator.ts) and cycle telemetry (cycle_analytics.ts).
 */

import path from "node:path";
import { readJson, writeJson } from "./fs_utils.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Target confidence for baseline recovery status. Below this = recovery active. */
export const PARSER_CONFIDENCE_RECOVERY_THRESHOLD = 0.9;

/** Maximum history entries retained in parser_baseline_metrics.json. */
const MAX_BASELINE_HISTORY = 100;

/** State file name. */
const BASELINE_METRICS_FILE = "parser_baseline_metrics.json";

/** Schema version for parser_baseline_metrics.json. */
export const BASELINE_METRICS_SCHEMA_VERSION = 1;

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Per-component confidence scores extracted from a prometheusAnalysis object.
 * Each value is a 0–1 score; a score of 1.0 means no degradation in that component.
 *
 * dependencyGraph reflects dependency-graph resolution quality:
 *   1.0 = graph resolved OK with no conflicts
 *   0.8 = graph resolved OK but with conflict pairs (conflict-rate adjusted)
 *   0.6 = graph resolution degraded (non-OK status, no cycles)
 *   0.3 = cycle detected in dependency graph (hard degradation)
 */
export interface ParserComponentMetrics {
  plansShape:      number;
  healthField:     number;
  requestBudget:   number;
  dependencyGraph: number;
  [key: string]: number;
}

/**
 * Gap between perfect (1.0) and actual score for each component.
 * A gap of 0 means the component is fully healthy.
 */
export interface ParserComponentGap {
  plansShape:      number;
  healthField:     number;
  requestBudget:   number;
  dependencyGraph: number;
  [key: string]: number;
}

/** A penalty entry explaining why a component score was reduced. */
export interface ParserPenalty {
  reason:    string;
  component: string;
  delta:     number;
}

/**
 * Baseline recovery state for a single cycle.
 * Returned by computeBaselineRecoveryState() and persisted per-cycle.
 */
export interface BaselineRecoveryRecord {
  cycleId:            string | null;
  recordedAt:         string;
  parserConfidence:   number;
  recoveryActive:     boolean;
  recoveryThreshold:  number;
  componentMetrics:   ParserComponentMetrics;
  componentGap:       ParserComponentGap;
  penalties:          ParserPenalty[];
}

// ── Core computation ──────────────────────────────────────────────────────────

/**
 * Compute the baseline recovery state from a Prometheus analysis object.
 *
 * Pure function — no I/O. Safe to call with null/undefined input.
 *
 * @param prometheusAnalysis - output of runPrometheusAnalysis(), or null
 * @param cycleId            - optional cycle identifier (e.g. pipeline_progress.startedAt)
 * @returns BaselineRecoveryRecord
 */
export function computeBaselineRecoveryState(
  prometheusAnalysis: Record<string, any> | null | undefined,
  cycleId: string | null = null
): BaselineRecoveryRecord {
  const parserConfidence: number =
    typeof prometheusAnalysis?.parserConfidence === "number"
      ? prometheusAnalysis.parserConfidence
      : 1.0;

  const rawComponents = prometheusAnalysis?.parserConfidenceComponents;
  const componentMetrics: ParserComponentMetrics = {
    plansShape:      typeof rawComponents?.plansShape      === "number" ? rawComponents.plansShape      : 1.0,
    healthField:     typeof rawComponents?.healthField     === "number" ? rawComponents.healthField     : 1.0,
    requestBudget:   typeof rawComponents?.requestBudget   === "number" ? rawComponents.requestBudget   : 1.0,
    dependencyGraph: typeof rawComponents?.dependencyGraph === "number" ? rawComponents.dependencyGraph : 1.0,
  };

  const componentGap: ParserComponentGap = {
    plansShape:      Math.round((1.0 - componentMetrics.plansShape)      * 1000) / 1000,
    healthField:     Math.round((1.0 - componentMetrics.healthField)     * 1000) / 1000,
    requestBudget:   Math.round((1.0 - componentMetrics.requestBudget)   * 1000) / 1000,
    dependencyGraph: Math.round((1.0 - componentMetrics.dependencyGraph) * 1000) / 1000,
  };

  const rawPenalties = prometheusAnalysis?.parserConfidencePenalties;
  const penalties: ParserPenalty[] = Array.isArray(rawPenalties)
    ? rawPenalties.filter(
        p => p && typeof p.reason === "string" && typeof p.component === "string" && typeof p.delta === "number"
      )
    : [];

  const recoveryActive = parserConfidence < PARSER_CONFIDENCE_RECOVERY_THRESHOLD;

  return {
    cycleId,
    recordedAt:        new Date().toISOString(),
    parserConfidence:  Math.round(parserConfidence * 1000) / 1000,
    recoveryActive,
    recoveryThreshold: PARSER_CONFIDENCE_RECOVERY_THRESHOLD,
    componentMetrics,
    componentGap,
    penalties,
  };
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * Persist a baseline recovery record to state/parser_baseline_metrics.json.
 *
 * Maintains a rolling history capped at MAX_BASELINE_HISTORY (100) entries.
 * Newest record is prepended; oldest entries are evicted when cap is exceeded.
 *
 * Never throws — file I/O errors propagate to the caller (orchestrator wraps in try/catch).
 *
 * @param config - BOX config object (config.paths.stateDir used for file location)
 * @param record - output of computeBaselineRecoveryState()
 */
export async function persistBaselineMetrics(
  config: Record<string, any>,
  record: BaselineRecoveryRecord
): Promise<void> {
  const stateDir = config?.paths?.stateDir || "state";
  const filePath = path.join(stateDir, BASELINE_METRICS_FILE);

  const existing = await readJson(filePath, {
    schemaVersion: BASELINE_METRICS_SCHEMA_VERSION,
    lastRecord: null,
    history: [],
    updatedAt: null,
  });

  const history: BaselineRecoveryRecord[] = Array.isArray(existing.history) ? existing.history : [];
  history.unshift(record);
  if (history.length > MAX_BASELINE_HISTORY) {
    history.length = MAX_BASELINE_HISTORY;
  }

  await writeJson(filePath, {
    schemaVersion: BASELINE_METRICS_SCHEMA_VERSION,
    lastRecord: record,
    history,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Read the current parser_baseline_metrics.json snapshot.
 * Returns null if the file does not exist yet.
 *
 * @param config - BOX config object
 */
export async function readBaselineMetrics(
  config: Record<string, any>
): Promise<Record<string, any> | null> {
  const stateDir = config?.paths?.stateDir || "state";
  const filePath = path.join(stateDir, BASELINE_METRICS_FILE);
  return readJson(filePath, null);
}

// ── Quarantine recommendation ─────────────────────────────────────────────────

/**
 * Confidence threshold below which a parser component is considered critically
 * under-confident.  Mirrors the quarantine threshold used by prometheus.ts and
 * plan_contract_validator.ts so all three modules share the same gate value.
 */
export const QUARANTINE_CONFIDENCE_THRESHOLD = 0.5 as const;

/** Result of a quarantine recommendation computation. */
export interface QuarantineRecommendation {
  shouldQuarantine:        boolean;
  reason:                  string;
  lowConfidenceComponents: string[];
}

/**
 * Derive a quarantine recommendation from a baseline recovery record.
 *
 * When one or more parser components score below `threshold`, the recommendation
 * is to quarantine plans produced in that cycle from worker dispatch until the
 * parser confidence recovers.
 *
 * @param record  — output of computeBaselineRecoveryState(), or null/undefined
 * @param opts    — { threshold } override (default: QUARANTINE_CONFIDENCE_THRESHOLD)
 * @returns QuarantineRecommendation
 */
export function computeQuarantineRecommendation(
  record: BaselineRecoveryRecord | null | undefined,
  opts: { threshold?: number } = {},
): QuarantineRecommendation {
  const threshold = typeof opts.threshold === "number"
    ? opts.threshold
    : QUARANTINE_CONFIDENCE_THRESHOLD;

  if (!record) {
    return {
      shouldQuarantine:        false,
      reason:                  "no recovery record available",
      lowConfidenceComponents: [],
    };
  }

  const lowConfidenceComponents = Object.entries(record.componentMetrics || {})
    .filter(([, score]) => typeof score === "number" && (score as number) < threshold)
    .map(([name]) => name);

  if (lowConfidenceComponents.length > 0) {
    return {
      shouldQuarantine: true,
      reason:           `${lowConfidenceComponents.length} component(s) below confidence threshold ${threshold}: ${lowConfidenceComponents.join(", ")}`,
      lowConfidenceComponents,
    };
  }

  return {
    shouldQuarantine:        false,
    reason:                  "all components meet confidence threshold",
    lowConfidenceComponents: [],
  };
}
